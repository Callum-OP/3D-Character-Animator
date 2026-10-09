import { useMemo, useRef, useState } from 'react'
import EditableValue from './EditableValue.jsx'
import { getCurrentModel, requestRender } from '../three/scene.js'
import { useStore } from '../store.js'

// A compact way to set a character's shape keys from the Animate panel, instead of
// a wall of sliders: pick one shape key from a drop-down, and it appears as a
// full slider (plus a fine-tune slider under it). "Key position" then saves
// whatever the character's shape keys are at that moment.
//
// Shape keys are listed once by NAME, however many meshes carry them (a face is
// usually split into head / teeth / eyes … that share names), and a change is
// applied to every mesh that has that name.

const FILTER_FROM = 12 // show the filter box once there are this many shape keys
const FINE_RANGE = 0.1 // the fine slider nudges the value by up to ±this much

// Every shape key on the character, by unique name: { name, targets: [{ mesh, idx }] }.
export function collectShapeKeys(meshes) {
  const byName = new Map()
  for (const mesh of meshes || []) {
    const dict = mesh.morphTargetDictionary
    if (!dict || !mesh.morphTargetInfluences) continue
    for (const [name, idx] of Object.entries(dict)) {
      if (!byName.has(name)) byName.set(name, { name, targets: [] })
      byName.get(name).targets.push({ mesh, idx })
    }
  }
  return [...byName.values()]
}

export const readShapeKey = (key) => key.targets[0].mesh.morphTargetInfluences[key.targets[0].idx] ?? 0

export function writeShapeKey(key, value) {
  const v = Math.min(1, Math.max(0, value))
  for (const { mesh, idx } of key.targets) mesh.morphTargetInfluences[idx] = v
  return v
}

const clamp01 = (v) => Math.min(1, Math.max(0, v))

export default function ShapeKeyPicker() {
  useStore((s) => s.currentTime) // re-read values when the playhead moves (clips can drive shape keys)
  const characterId = useStore((s) => s.activeCharacterId)
  const [equipped, setEquipped] = useState(null) // shape key name
  const [filter, setFilter] = useState('')
  const [, bump] = useState(0)
  const [fine, setFine] = useState(0)
  const fineBase = useRef(null)

  const keys = collectShapeKeys(getCurrentModel()?.meshes)
  const sorted = useMemo(
    () => keys.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    // keys are rebuilt each render from live meshes; only the names matter for ordering
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys.map((k) => k.name).join('\n'), characterId],
  )
  if (!sorted.length) return null // nothing to pick on this character — keep the panel clean

  const current = sorted.find((k) => k.name === equipped) || null
  const value = current ? readShapeKey(current) : 0
  const needle = filter.trim().toLowerCase()
  const matches = needle ? sorted.filter((k) => k.name.toLowerCase().includes(needle)) : sorted
  // Always keep the equipped key selectable so the drop-down never goes blank.
  const options = current && !matches.includes(current) ? [current, ...matches] : matches
  const inUse = sorted.filter((k) => readShapeKey(k) > 0.001).length

  function set(next) {
    if (!current) return
    writeShapeKey(current, next)
    bump((n) => n + 1)
    requestRender()
  }

  function equip(name) {
    setEquipped(name || null)
    setFine(0)
    fineBase.current = null
  }

  function endFine() {
    fineBase.current = null
    setFine(0) // spring back to the middle, ready for the next nudge
  }

  return (
    <div className="shape-key-picker">
      <div className="shape-key-row">
        <select
          className="select"
          value={current ? current.name : ''}
          onChange={(e) => equip(e.target.value)}
          aria-label="Shape key"
          title={inUse ? `${inUse} shape key${inUse > 1 ? 's' : ''} currently set` : undefined}
        >
          <option value="">Shape key…</option>
          {options.map((k) => {
            const v = readShapeKey(k)
            return (
              <option key={k.name} value={k.name}>
                {k.name}
                {v > 0.001 ? `  ·  ${v.toFixed(2)}` : ''}
              </option>
            )
          })}
        </select>
        {sorted.length >= FILTER_FROM && (
          <input
            className="shape-key-filter"
            type="search"
            placeholder="Filter"
            value={filter}
            aria-label="Filter shape keys"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches.length) {
                e.preventDefault()
                equip(matches[0].name)
              }
            }}
          />
        )}
      </div>

      {current && (
        <div className="shape-key-sliders">
          <div className="morph-row">
            <label className="morph-label" title={current.name}>{current.name}</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={value}
              aria-label={`${current.name} shape key`}
              onChange={(e) => set(parseFloat(e.target.value))}
            />
            <EditableValue
              value={value}
              min={0}
              max={1}
              onChange={set}
              format={(v) => v.toFixed(2)}
              className="morph-value"
              label={`${current.name} value`}
            />
            <button className="btn secondary" onClick={() => set(0)} title="Set this shape key back to 0" disabled={value === 0}>
              0
            </button>
          </div>
          <div className="morph-row">
            <label className="morph-label">Fine</label>
            <input
              type="range"
              min={-FINE_RANGE}
              max={FINE_RANGE}
              step={0.001}
              value={fine}
              aria-label={`Fine-tune ${current.name}`}
              title="Nudge the value up or down a little; lets go back to the middle when released"
              onChange={(e) => {
                if (fineBase.current === null) fineBase.current = value
                const delta = parseFloat(e.target.value)
                setFine(delta)
                set(clamp01(fineBase.current + delta))
              }}
              onPointerUp={endFine}
              onKeyUp={endFine}
              onBlur={endFine}
            />
            <span className="morph-value">{fine === 0 ? '' : `${fine > 0 ? '+' : ''}${fine.toFixed(3)}`}</span>
          </div>
        </div>
      )}
    </div>
  )
}
