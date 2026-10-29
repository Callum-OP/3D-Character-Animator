import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import { applyModelMaterials } from '../three/scene.js'
import { setFacePickHandler } from '../three/meshedit.js'
import { getOriginalMaterials } from '../three/surfaceMaterials.js'
import { recordOverrideEdit } from '../three/materialHistory.js'
import LightFromPart from './LightFromPart.jsx'
import { useRowMenu, RowMenuButton, RowName } from './rowMenu.jsx'
import {
  MAX_REGIONS,
  isRegionCapable,
  growRegion,
  triangleColor,
  toRanges,
  fromRanges,
  regionVertexCount,
  setRegionOverlay,
} from '../three/regions.js'

// Pick a part of the selected mesh — a headlight, a window, a stripe of trim — and give just
// that part its own colour, glow and shininess. Click a face and the selection grows across
// connected faces while the texture colour stays close to it, so it stops where the colour
// ends. See three/regions.js.

const GROW_MODES = [
  { id: 'color', label: 'Same colour area', hint: 'Grow across connected faces until the colour changes' },
  { id: 'face', label: 'One face', hint: 'Just the face you click' },
  { id: 'piece', label: 'Whole piece', hint: 'Everything connected to the face, whatever its colour' },
  { id: 'everywhere', label: 'Same colour everywhere', hint: 'Every face of that colour in the part, connected or not' },
]

const LOOK_PRESETS = [
  { label: 'Headlight', look: { mode: 'solid', color: '#fffbe8', glow: 2.5, glowColor: '#fff3c4', roughness: 0.1 } },
  { label: 'Tail light', look: { mode: 'solid', color: '#ff1a1a', glow: 2, glowColor: '#ff2020', roughness: 0.2 } },
  { label: 'Indicator', look: { mode: 'solid', color: '#ffa31a', glow: 1.8, glowColor: '#ffa31a', roughness: 0.2 } },
  { label: 'Window', look: { mode: 'solid', color: '#18222c', glow: 0, roughness: 0.04, metalness: 0.2 } },
  { label: 'Chrome', look: { mode: 'solid', color: '#e9e9e9', glow: 0, roughness: 0.06, metalness: 1 } },
  { label: 'Neon', look: { mode: 'solid', color: '#35e8ff', glow: 3, glowColor: '#35e8ff', roughness: 0.4 } },
]

const COLOUR_MODES = [
  ['none', 'Keep texture'],
  ['tint', 'Tint'],
  ['solid', 'Solid colour'],
]

const NO_REGIONS = []
const GLOW_ON_LIGHT = 1.6
const toHex = (rgb) => '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')
const CLEAR_LOOK = { mode: null, color: null, glow: null, glowColor: null, roughness: null, metalness: null }

function mergeRegionLook(look, patch) {
  const next = { ...look, ...patch }
  for (const k of Object.keys(next)) if (next[k] == null) delete next[k]
  return next
}

export default function RegionEditor({ meshUuid, resolveMesh }) {
  const regions = useStore((s) => (s.meshOverrides[meshUuid] && s.meshOverrides[meshUuid].regions) || NO_REGIONS)
  const setMeshRegions = useStore((s) => s.setMeshRegions)
  const [picking, setPicking] = useState(false)
  const [seed, setSeed] = useState(null) // { tri, color }
  const [mode, setMode] = useState('color')
  const [tolerance, setTolerance] = useState(0.25)
  const [pending, setPending] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [highlight, setHighlight] = useState(true)
  const [message, setMessage] = useState('')
  const [renamingId, setRenamingId] = useState(null)
  const [lightOpen, setLightOpen] = useState(false)
  const rowMenu = useRowMenu()
  const meshRef = useRef(null)

  const mesh = resolveMesh(meshUuid)
  meshRef.current = mesh
  const capable = isRegionCapable(mesh)
  const selected = regions.find((r) => r.id === selectedId) || null

  // A different part: drop any half-made selection.
  useEffect(() => {
    setSeed(null)
    setPending(null)
    setPicking(false)
    setSelectedId(null)
    setMessage('')
  }, [meshUuid])

  // Pick mode: clicks in the viewport choose a face of THIS part.
  useEffect(() => {
    if (!picking) return undefined
    setFacePickHandler((hit) => {
      const target = meshRef.current
      if (!hit) {
        setMessage('Click on the part to pick a face.')
        return
      }
      if (hit.uuid !== target.uuid) {
        setMessage('That is a different part: click the part you have selected.')
        return
      }
      const source = getOriginalMaterials(target)
      setSeed({ tri: hit.faceIndex, color: toHex(triangleColor(target, hit.faceIndex, [0, 0, 0], source)) })
      setSelectedId(null)
      setMessage('')
    })
    return () => setFacePickHandler(null)
  }, [picking])

  // Grow the selection whenever the seed, the mode or the tolerance changes.
  useEffect(() => {
    if (!seed || !meshRef.current) {
      setPending(null)
      return
    }
    setPending(growRegion(meshRef.current, seed.tri, { mode, tolerance, source: getOriginalMaterials(meshRef.current) }))
  }, [seed, mode, tolerance])

  // The highlight: magenta for the selection being made, cyan for the chosen region. It follows the region's
  // FACES, not its look: dragging a colour / glow slider replaces the region object on every tick, and
  // rebuilding the overlay (every face of the region copied into a new buffer) for that was wasted work.
  const selectedTris = selected ? selected.tris : null
  useEffect(() => {
    const target = meshRef.current
    if (!target) return undefined
    if (pending && pending.length) setRegionOverlay(target, pending, 0xff2bd6)
    else if (selectedTris && highlight) setRegionOverlay(target, fromRanges(selectedTris), 0x2bd6ff)
    else setRegionOverlay(target, null)
    return () => setRegionOverlay(target, null)
  }, [pending, selectedTris, highlight, meshUuid])

  if (!capable) {
    return (
      <div className="radio-hint" style={{ marginTop: 10 }}>
        Regions are not available for this part (parts bent by a skeleton or shape keys can&apos;t be split by face).
      </div>
    )
  }

  const commit = (next) => {
    recordOverrideEdit([meshUuid], () => setMeshRegions(meshUuid, next))
    applyModelMaterials()
  }

  function addRegion() {
    if (!pending || !pending.length) return
    const id = 'r' + Date.now().toString(36) + regions.length
    const next = [
      ...regions,
      {
        id,
        name: `Region ${regions.length + 1}`,
        tris: toRanges(pending),
        vertexCount: regionVertexCount(meshRef.current.geometry),
        look: { mode: 'solid', color: seed ? seed.color : '#ffffff' },
      },
    ]
    commit(next)
    setSelectedId(id)
    setSeed(null)
    setPending(null)
    setPicking(false)
    setMessage(`Region added (${pending.length} faces). Choose its look below.`)
  }

  function patchLookOf(id, patch) {
    commit(regions.map((r) => (r.id === id ? { ...r, look: mergeRegionLook(r.look || {}, patch) } : r)))
  }
  const patchLook = (patch) => selected && patchLookOf(selected.id, patch)

  function removeRegion(region) {
    if (!window.confirm(`Are you sure you want to delete "${region.name}"? (Ctrl+Z will bring it back.)`)) return
    commit(regions.filter((r) => r.id !== region.id))
    if (selectedId === region.id) setSelectedId(null)
  }

  function renameRegion(id, name) {
    const clean = name.trim()
    if (clean) commit(regions.map((r) => (r.id === id ? { ...r, name: clean } : r)))
    setRenamingId(null)
  }

  function selectRegion(id) {
    setSelectedId(id)
    setSeed(null)
    setPending(null)
  }

  // The menu for a region row; right-click (or ⋯) also selects that region.
  function buildMenu(r) {
    if (selectedId !== r.id) selectRegion(r.id)
    const lk = r.look || {}
    const current = lk.mode || 'none'
    const items = [
      { header: r.name },
      { id: 'rename', label: 'Rename', shortcut: 'Dbl-click' },
      { id: 'highlight', label: 'Highlight on model', checked: highlight, hint: 'Show this region on the model so you can see where it is' },
      { separator: true },
      {
        label: 'Look',
        hint: 'A ready-made look: headlight, tail light, window, chrome…',
        children: [
          ...LOOK_PRESETS.map((pr) => ({ id: 'look:' + pr.label, label: pr.label })),
          { separator: true },
          { id: 'look:', label: 'Original', hint: 'Back to how the model looks' },
        ],
      },
      {
        label: 'Colour',
        value: COLOUR_MODES.find(([id]) => id === current)[1],
        children: COLOUR_MODES.map(([id, label]) => ({ id: 'mode:' + id, label, checked: current === id })),
      },
      { id: 'light', label: 'Turn into a light…', hint: 'Put a real light where this region is' },
      { separator: true },
      { id: 'delete', label: 'Delete', danger: true },
    ]
    function run(id) {
      if (id === 'rename') return setRenamingId(r.id)
      if (id === 'highlight') return setHighlight(!highlight)
      if (id === 'light') return setLightOpen(true)
      if (id === 'delete') return removeRegion(r)
      if (id.startsWith('look:')) {
        const name = id.slice(5)
        const preset = LOOK_PRESETS.find((pr) => pr.label === name)
        return patchLookOf(r.id, preset ? { ...CLEAR_LOOK, ...preset.look } : CLEAR_LOOK)
      }
      if (id.startsWith('mode:')) {
        const m = id.slice(5)
        return patchLookOf(r.id, m === 'none' ? { mode: null, color: null } : { mode: m, color: lk.color || '#ffffff' })
      }
    }
    return { items, run }
  }

  const look = (selected && selected.look) || {}

  return (
    <div style={{ marginTop: 8 }}>
      <div className="kf-actions">
        <button
          className={`btn ${picking ? '' : 'secondary'}`}
          onClick={() => setPicking((p) => !p)}
          disabled={regions.length >= MAX_REGIONS && !picking}
          title="Then click a face of the selected part in the viewport"
        >
          {picking ? 'Click the model… (stop)' : '🎯 Pick on model'}
        </button>
      </div>
      {regions.length === 0 && !picking && !seed && (
        <div className="radio-hint" style={{ marginTop: 6 }}>
          Pick a headlight, window or stripe on the model to change just that part&apos;s colour, glow and shine.
        </div>
      )}
      {regions.length >= MAX_REGIONS && <div className="radio-hint">Up to {MAX_REGIONS} regions per part.</div>}
      {message && <div className="radio-hint" style={{ marginTop: 4 }}>{message}</div>}

      {seed && pending && (
        <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(255,43,214,0.10)' }}>
          <label className="slider-row" title={GROW_MODES.find((g) => g.id === mode)?.hint}>
            <span className="slider-label">Select</span>
            <select className="select" aria-label="How far to grow the selection" value={mode} onChange={(e) => setMode(e.target.value)}>
              {GROW_MODES.map((g) => (
                <option key={g.id} value={g.id} title={g.hint}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
          <div className="radio-hint">{GROW_MODES.find((g) => g.id === mode)?.hint}</div>
          {(mode === 'color' || mode === 'everywhere') && (
            <label className="slider-row" title="How far a colour may drift from the one you clicked and still be included">
              <span className="slider-label">Colour tolerance</span>
              <input type="range" min={0} max={1} step={0.01} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
              <span style={{ minWidth: 34, textAlign: 'right' }}>{tolerance.toFixed(2)}</span>
            </label>
          )}
          <div className="radio-hint">{pending.length} face{pending.length === 1 ? '' : 's'} selected (shown in pink)</div>
          <div className="kf-actions" style={{ marginTop: 4 }}>
            <button className="btn" onClick={addRegion} disabled={!pending.length}>Make this a region</button>
            <button className="btn secondary" onClick={() => { setSeed(null); setPending(null) }}>Clear</button>
          </div>
        </div>
      )}

      {regions.length > 0 && (
        <>
          <div className="obj-list" style={{ marginTop: 10 }}>
            {regions.map((r) => (
              <div
                key={r.id}
                className={'obj-row' + (selectedId === r.id ? ' selected' : '')}
                title={r.name}
                onClick={(e) => {
                  if (e.detail > 1) return // second click of a double-click (rename)
                  if (r.id === selectedId) {
                    setSelectedId(null)
                    setSeed(null)
                    setPending(null)
                  } else selectRegion(r.id)
                }}
                onContextMenu={(e) => {
                  const { items, run } = buildMenu(r)
                  rowMenu.openAt(e, items, run)
                }}
              >
                <div className="obj-row-main">
                  <span
                    aria-hidden="true"
                    style={{ flex: '0 0 auto', width: 11, height: 11, borderRadius: 3, background: (r.look && r.look.color) || '#888', border: '1px solid #888' }}
                  />
                  <RowName
                    editing={renamingId === r.id}
                    value={r.name}
                    onCommit={(name) => renameRegion(r.id, name)}
                    onCancel={() => setRenamingId(null)}
                    onDoubleClick={() => setRenamingId(r.id)}
                  >
                    {r.name}
                  </RowName>
                  <RowMenuButton
                    label="Region options"
                    onOpen={(e) => {
                      const { items, run } = buildMenu(r)
                      rowMenu.openFromButton(e, items, run)
                    }}
                  />
                  <button
                    className="obj-del"
                    title="Delete this region"
                    aria-label={`Delete ${r.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      removeRegion(r)
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="obj-row-hint">Click a region to edit it. Right-click (or ⋯) for rename, looks, highlight and more.</p>
          {rowMenu.element}
        </>
      )}

      {selected && (
        <div style={{ marginTop: 8 }}>
          <label className="slider-row" title="A ready-made look for this region">
            <span className="slider-label">Look</span>
            <select
              className="select"
              aria-label="Region look"
              value=""
              onChange={(e) => {
                const v = e.target.value
                if (!v) return
                const preset = LOOK_PRESETS.find((pr) => pr.label === v)
                patchLook(preset ? { ...CLEAR_LOOK, ...preset.look } : CLEAR_LOOK)
              }}
            >
              <option value="">Choose a preset…</option>
              {LOOK_PRESETS.map((pr) => (
                <option key={pr.label} value={pr.label}>
                  {pr.label}
                </option>
              ))}
              <option value="__original">Original (as the model was)</option>
            </select>
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {COLOUR_MODES.map(([id, label]) => (
              <button
                key={id}
                className={`btn ${(look.mode || 'none') === id ? '' : 'secondary'}`}
                onClick={() => patchLook(id === 'none' ? { mode: null, color: null } : { mode: id, color: look.color || '#ffffff' })}
              >
                {label}
              </button>
            ))}
            {look.mode && (
              <input type="color" className="color-control-swatch" aria-label="Region colour" value={look.color || '#ffffff'} onChange={(e) => patchLook({ color: e.target.value })} />
            )}
          </div>

          <label className="slider-row" title="Makes the region give off its own light, so it stays bright in the dark">
            <span className="slider-label">Glow</span>
            <input type="range" min={0} max={6} step={0.05} value={look.glow || 0} onChange={(e) => patchLook({ glow: Number(e.target.value) || null })} />
            <span style={{ minWidth: 34, textAlign: 'right' }}>{(look.glow || 0).toFixed(2)}</span>
            <input
              type="color"
              className="color-control-swatch"
              aria-label="Glow colour"
              value={look.glowColor || look.color || '#ffffff'}
              onChange={(e) => patchLook({ glowColor: e.target.value, glow: look.glow || 1.5 })}
            />
          </label>

          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: 'pointer' }}>Shine (roughness, metalness)</summary>
            {[['roughness', 'Roughness'], ['metalness', 'Metalness']].map(([key, label]) => (
              <label key={key} className="slider-row" title={`${label} (Studio / Realistic styles)`}>
                <span className="slider-label">{label}</span>
                <input type="range" min={0} max={1} step={0.01} value={look[key] != null ? look[key] : 0.5} onChange={(e) => patchLook({ [key]: Number(e.target.value) })} />
                <span style={{ minWidth: 34, textAlign: 'right', opacity: look[key] != null ? 1 : 0.55 }}>{(look[key] != null ? look[key] : 0.5).toFixed(2)}</span>
                <button className="btn secondary" style={{ padding: '0 6px', visibility: look[key] != null ? 'visible' : 'hidden' }} onClick={() => patchLook({ [key]: null })} title="Back to the model's own value">↺</button>
              </label>
            ))}
            <div className="radio-hint">Roughness and metalness show in Studio / Realistic styles; colour and glow show in every style.</div>
          </details>

          <details style={{ marginTop: 6 }} open={lightOpen} onToggle={(e) => setLightOpen(e.currentTarget.open)}>
            <summary style={{ cursor: 'pointer' }}>Turn into a light</summary>
            <LightFromPart
              key={selected.id}
              uuids={[meshUuid]}
              regionId={selected.id}
              label="Turn this region into a light"
              onCreated={(result, { glow }) => {
                // A lit tail light should also LOOK lit: give the surface a glow in the light's colour.
                if (glow && !(look.glow > 0)) patchLook({ glow: GLOW_ON_LIGHT, glowColor: look.glowColor || (result.items[0] && result.items[0].colour) || look.color || null })
              }}
            />
          </details>
        </div>
      )}
    </div>
  )
}
