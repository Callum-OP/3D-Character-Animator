import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { recordOverrideEdit } from '../three/materialHistory.js'
import { refreshSoftCloth } from '../three/scene.js'
import { setFacePickHandler } from '../three/meshedit.js'
import { growRegion, toRanges, fromRanges } from '../three/regions.js'
import { getOriginalMaterials } from '../three/surfaceMaterials.js'
import { makeSoftZone, setSoftOverlay, getSoftEntry, resetSoftCloth, SOFT_PRESETS, SOFT_MODES } from '../three/softcloth.js'
import EditableValue from './EditableValue.jsx'

const EMPTY = []

function Slider({ label, hint, value, min, max, step = 0.01, onChange, format }) {
  return (
    <label className="slider-row">
      <span className="slider-label" title={hint}>
        {label}
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <EditableValue value={value} min={min} max={max} onChange={onChange} format={format} label={label} />
    </label>
  )
}

const pct = (v) => `${Math.round(v * 100)}%`

// The faces within `fraction` of the part's size of the clicked face (a round brush, for picking a hood,
// a cuff or a zip area on a part that has no clean edge to grow along).
function growByRadius(mesh, seedTri, fraction) {
  const entry = getSoftEntry(mesh)
  const geometry = entry ? entry.orig : mesh.geometry
  const pos = geometry.getAttribute('position')
  const index = geometry.index
  const nTris = Math.floor((index ? index.count : pos.count) / 3)
  if (seedTri < 0 || seedTri >= nTris) return []
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const diag = geometry.boundingBox.min.distanceTo(geometry.boundingBox.max)
  const r2 = (fraction * diag) ** 2
  const centre = (t, out) => {
    out.set(0, 0, 0)
    for (let k = 0; k < 3; k++) {
      const v = index ? index.getX(3 * t + k) : 3 * t + k
      out.x += pos.getX(v)
      out.y += pos.getY(v)
      out.z += pos.getZ(v)
    }
    return out.multiplyScalar(1 / 3)
  }
  const c0 = centre(seedTri, new THREE.Vector3())
  const c = new THREE.Vector3()
  const out = []
  for (let t = 0; t < nTris; t++) if (centre(t, c).distanceToSquared(c0) <= r2) out.push(t)
  return out
}

// Pose panel > Mesh > Cloth: soft cloth and swing zones for the selected part.
// A zone makes the whole part, or an area of it, follow the animation on a spring (Soft cloth) or hang
// and swing as one piece (Swing). See three/softcloth.js.
export default function SoftClothEditor({ mesh, clothOn = false }) {
  const meshUuid = mesh.uuid
  const zones = useStore((s) => s.meshOverrides[meshUuid]?.softZones) || EMPTY
  const regions = useStore((s) => s.meshOverrides[meshUuid]?.regions) || EMPTY
  const setMeshSoftZones = useStore((s) => s.setMeshSoftZones)

  const [addMode, setAddMode] = useState('soft')
  const [areaKind, setAreaKind] = useState('all')
  const [regionId, setRegionId] = useState('')
  const [preset, setPreset] = useState('jacket')
  const [picking, setPicking] = useState(false)
  const [growMode, setGrowMode] = useState('radius')
  const [tolerance, setTolerance] = useState(0.25)
  const [radius, setRadius] = useState(0.1)
  const [keepAdding, setKeepAdding] = useState(false)
  const [picks, setPicks] = useState([])
  const [pending, setPending] = useState([])
  const [showId, setShowId] = useState(null)
  const [message, setMessage] = useState('')
  const meshRef = useRef(mesh)
  meshRef.current = mesh
  const keepRef = useRef(keepAdding)
  keepRef.current = keepAdding

  // A different part: drop any half-made selection.
  useEffect(() => {
    setPicks([])
    setPending([])
    setPicking(false)
    setShowId(null)
    setMessage('')
    setAreaKind('all')
  }, [meshUuid])

  // The presets of the mode being added
  useEffect(() => {
    setPreset(SOFT_PRESETS[addMode][0].id)
  }, [addMode])

  // Pick mode: clicks in the viewport choose a face of THIS part (also parts bent by a skeleton).
  useEffect(() => {
    if (!picking) return undefined
    setFacePickHandler(
      (hit) => {
        const target = meshRef.current
        if (!hit) {
          setMessage('Click on the part to pick a spot.')
          return
        }
        if (hit.uuid !== target.uuid) {
          setMessage('That is a different part: click the part you have selected.')
          return
        }
        setMessage('')
        setPicks((prev) => (keepRef.current ? [...prev, hit.faceIndex] : [hit.faceIndex]))
      },
      { allowSkinned: true },
    )
    return () => setFacePickHandler(null)
  }, [picking])

  // Grow the picked spots into the area whenever a pick, the mode or a setting changes.
  useEffect(() => {
    const target = meshRef.current
    if (!picks.length || !target) {
      setPending([])
      return
    }
    const all = new Set()
    const source = getOriginalMaterials(target)
    for (const tri of picks) {
      const grown =
        growMode === 'radius' ? growByRadius(target, tri, radius) : growRegion(target, tri, { mode: growMode, tolerance, source })
      for (const t of grown) all.add(t)
    }
    setPending(Array.from(all))
  }, [picks, growMode, tolerance, radius])

  // The highlight: magenta for the area being made, cyan for the zone being shown.
  const shown = zones.find((z) => z.id === showId)
  const shownRanges = shown && shown.area.kind === 'tris' ? shown.area.tris : null
  useEffect(() => {
    const target = meshRef.current
    if (pending.length) setSoftOverlay(target, pending, 0xff2bd6)
    else if (shownRanges) setSoftOverlay(target, fromRanges(shownRanges), 0x2bd6ff)
    else setSoftOverlay(target, null)
    return () => setSoftOverlay(target, null)
  }, [pending, shownRanges, meshUuid])

  // `discrete`: add / remove / on-off / a preset are steps of their own; slider drags merge into one
  const commit = (next, discrete = false) => {
    recordOverrideEdit([meshUuid], () => setMeshSoftZones(meshUuid, next), null, { discrete })
    refreshSoftCloth()
  }
  const update = (id, patch, discrete = false) => commit(zones.map((z) => (z.id === id ? { ...z, ...patch } : z)), discrete)
  const remove = (id) => {
    if (showId === id) setShowId(null)
    commit(zones.filter((z) => z.id !== id), true)
  }

  const region = regions.find((r) => r.id === regionId) || null
  const canAdd = !clothOn && (areaKind === 'all' || (areaKind === 'picked' && pending.length > 0) || (areaKind === 'region' && region))

  const add = () => {
    let area = { kind: 'all' }
    let name = null
    if (areaKind === 'picked') {
      area = { kind: 'tris', tris: toRanges(pending), vertexCount: pending.length * 3 }
    } else if (areaKind === 'region' && region) {
      area = { kind: 'tris', tris: region.tris.map((r) => [...r]), vertexCount: 0 }
      name = region.name
    }
    const zone = makeSoftZone(addMode, area, preset)
    const same = zones.filter((z) => z.mode === addMode).length
    zone.name = name ? `${name}` : `${SOFT_MODES[addMode]}${same ? ` ${same + 1}` : ''}`
    commit([...zones, zone], true)
    setShowId(zone.id)
    setPicks([])
    setPending([])
    setPicking(false)
  }

  const applyPreset = (zone, id) => {
    const p = SOFT_PRESETS[zone.mode].find((x) => x.id === id)
    if (!p) return
    const values = { ...p.values }
    // a preset never turns locking on for an area picked by hand, or off for the whole part
    if (zone.mode === 'swing' || zone.area.kind === 'tris') delete values.lockTop
    update(zone.id, { ...values, preset: id }, true)
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div className="radio-hint" style={{ marginBottom: 8 }}>
        Makes this part (or just a piece of it) move a little differently from the body so it does not look stuck on. Much
        cheaper than the full cloth simulation. <b>Soft cloth</b> is for fabric (a jacket, sleeves, a hood); <b>Swing</b> is for a
        piece that hangs and swings (a zip pull, a fastener). It plays while an animation plays; stopped or scrubbed frames
        show the plain pose.
      </div>

      {clothOn && (
        <div className="radio-hint" style={{ marginBottom: 8, color: 'var(--warn, #e0a030)' }}>
          The full cloth simulation is on for this part. Turn it off to use soft cloth or swing.
        </div>
      )}

      {zones.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {zones.map((z) => {
            const mode = z.mode
            return (
              <details key={z.id} className="dangle-chain" style={{ marginBottom: 8 }}>
                <summary className="dangle-chain-summary" style={{ opacity: z.enabled === false ? 0.55 : 1 }}>
                  {z.name} · {SOFT_MODES[mode]}
                  {z.area.kind === 'tris' ? ' · area' : ' · whole part'}
                </summary>
                <div className="row" style={{ justifyContent: 'space-between', marginTop: 8, gap: 6 }}>
                  <label className="row">
                    <input type="checkbox" checked={z.enabled !== false} onChange={(e) => update(z.id, { enabled: e.target.checked }, true)} />
                    <span>On</span>
                  </label>
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    {z.area.kind === 'tris' && (
                      <label className="row" title="Show which faces this effect moves">
                        <input type="checkbox" checked={showId === z.id} onChange={(e) => setShowId(e.target.checked ? z.id : null)} />
                        <span>Show area</span>
                      </label>
                    )}
                    <button className="btn secondary" onClick={() => resetSoftCloth()} title="Stop the motion and start again from the pose">
                      Reset
                    </button>
                    <button className="btn secondary" onClick={() => remove(z.id)} title="Remove this effect" aria-label="Remove this effect">
                      ×
                    </button>
                  </span>
                </div>

                <label className="field">
                  <span>Name</span>
                  <input type="text" value={z.name} onChange={(e) => update(z.id, { name: e.target.value })} />
                </label>
                <label className="field" title={SOFT_PRESETS[mode].find((p) => p.id === z.preset)?.hint || ''}>
                  <span>Preset</span>
                  <select value={z.preset || ''} onChange={(e) => applyPreset(z, e.target.value)}>
                    {!SOFT_PRESETS[mode].some((p) => p.id === z.preset) && <option value="">Custom</option>}
                    {SOFT_PRESETS[mode].map((p) => (
                      <option key={p.id} value={p.id} title={p.hint}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>

                <Slider
                  label="Amount"
                  hint="How much of the motion you see. 0 = none."
                  value={z.amount ?? 1}
                  min={0}
                  max={1}
                  format={pct}
                  onChange={(v) => update(z.id, { amount: v })}
                />
                <Slider
                  label="Springiness"
                  hint="How hard it is pulled back to where the body puts it. Low = floppy and slow, high = tight and quick."
                  value={z.stiffness ?? 0.4}
                  min={0}
                  max={1}
                  format={pct}
                  onChange={(v) => update(z.id, { stiffness: v })}
                />
                <Slider
                  label="Damping"
                  hint="How quickly the bounce dies down. Low = keeps wobbling, high = settles at once."
                  value={z.damping ?? 0.5}
                  min={0}
                  max={1}
                  format={pct}
                  onChange={(v) => update(z.id, { damping: v })}
                />
                <Slider
                  label="Gravity"
                  hint="How much it droops and swings under its own weight."
                  value={z.gravity ?? 0.3}
                  min={0}
                  max={1}
                  format={pct}
                  onChange={(v) => update(z.id, { gravity: v })}
                />
                {mode === 'soft' ? (
                  <>
                    <Slider
                      label="Range"
                      hint="The furthest it may drift from the pose, as a share of the size of the area."
                      value={z.range ?? 0.08}
                      min={0}
                      max={0.4}
                      format={pct}
                      onChange={(v) => update(z.id, { range: v })}
                    />
                    <Slider
                      label="Smoothing"
                      hint="How much neighbouring points move together. High = one smooth piece of cloth, low = each point on its own."
                      value={z.smoothing ?? 0.6}
                      min={0}
                      max={1}
                      format={pct}
                      onChange={(v) => update(z.id, { smoothing: v })}
                    />
                    <Slider
                      label="Edge hold"
                      hint="How far in from the edge of the area (or from the held top) it stays fixed to the body before it starts to move. Bigger = the movement frees up more gradually."
                      value={z.blend ?? 0.4}
                      min={0.02}
                      max={1}
                      format={pct}
                      onChange={(v) => update(z.id, { blend: v })}
                    />
                    <Slider
                      label="Hold the top"
                      hint="Keeps the top part of the area fixed to the body (a collar, a waistband), so the cloth hangs from it."
                      value={z.lockTop ?? 0}
                      min={0}
                      max={0.8}
                      format={pct}
                      onChange={(v) => update(z.id, { lockTop: v })}
                    />
                  </>
                ) : (
                  <>
                    <Slider
                      label="Swing limit"
                      hint="The furthest it can swing, in degrees."
                      value={z.swingLimit ?? 70}
                      min={5}
                      max={180}
                      step={1}
                      format={(v) => `${Math.round(v)}°`}
                      onChange={(v) => update(z.id, { swingLimit: v })}
                    />
                    <Slider
                      label="Edge hold"
                      hint="If the piece is joined to the rest of the part, how far in from the join it stays fixed. 0 = it swings completely free."
                      value={z.blend ?? 0.15}
                      min={0.02}
                      max={1}
                      format={pct}
                      onChange={(v) => update(z.id, { blend: v })}
                    />
                  </>
                )}
              </details>
            )
          })}
        </div>
      )}

      <div className="dangle-add" style={{ borderTop: zones.length ? '1px solid var(--border, #333)' : 'none', paddingTop: zones.length ? 8 : 0 }}>
        <div className="joint-name" style={{ marginBottom: 6 }}>
          Add an effect
        </div>
        <label className="field">
          <span>Kind</span>
          <select value={addMode} onChange={(e) => setAddMode(e.target.value)} disabled={clothOn}>
            <option value="soft">Soft cloth (fabric that follows loosely)</option>
            <option value="swing">Swing (a piece that hangs and swings)</option>
          </select>
        </label>
        <label className="field">
          <span>Preset</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value)} disabled={clothOn}>
            {SOFT_PRESETS[addMode].map((p) => (
              <option key={p.id} value={p.id} title={p.hint}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Where</span>
          <select
            value={areaKind}
            onChange={(e) => {
              setAreaKind(e.target.value)
              setPicking(e.target.value === 'picked')
              if (e.target.value !== 'picked') {
                setPicks([])
                setPending([])
              }
            }}
            disabled={clothOn}
          >
            <option value="all">The whole part</option>
            <option value="picked">An area I pick on the part…</option>
            {regions.length > 0 && <option value="region">A painted region…</option>}
          </select>
        </label>

        {areaKind === 'region' && (
          <label className="field">
            <span>Region</span>
            <select value={regionId} onChange={(e) => setRegionId(e.target.value)}>
              <option value="">Choose…</option>
              {regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {areaKind === 'picked' && (
          <div style={{ marginTop: 4 }}>
            <div className="radio-hint">
              {picks.length
                ? `${pending.length} face${pending.length === 1 ? '' : 's'} selected (shown in pink). Change how it grows, or click elsewhere to start again.`
                : 'Click the part in the viewport where the effect should be (a hood, a cuff, the zip pull).'}
            </div>
            <label className="field">
              <span>Grow by</span>
              <select value={growMode} onChange={(e) => setGrowMode(e.target.value)}>
                <option value="radius">Distance around the click</option>
                <option value="piece">The whole connected piece</option>
                <option value="color">Connected faces of a similar colour</option>
                <option value="face">Just that face</option>
              </select>
            </label>
            {growMode === 'radius' && (
              <Slider
                label="Size"
                hint="How far around the click it reaches, as a share of the size of the part."
                value={radius}
                min={0.01}
                max={0.6}
                format={pct}
                onChange={setRadius}
              />
            )}
            {growMode === 'color' && (
              <Slider
                label="Colour match"
                hint="How different a colour may be and still be included."
                value={tolerance}
                min={0}
                max={1}
                format={pct}
                onChange={setTolerance}
              />
            )}
            <label className="row" title="Each click adds to the area instead of replacing it">
              <input type="checkbox" checked={keepAdding} onChange={(e) => setKeepAdding(e.target.checked)} />
              <span>Each click adds to the area</span>
            </label>
          </div>
        )}
        {message && <div className="radio-hint">{message}</div>}

        <div className="row" style={{ marginTop: 8, gap: 6 }}>
          <button className="btn secondary" disabled={!canAdd} onClick={add}>
            Add effect
          </button>
          {areaKind === 'picked' && pending.length > 0 && (
            <button
              className="btn secondary"
              onClick={() => {
                setPicks([])
                setPending([])
              }}
            >
              Clear selection
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
