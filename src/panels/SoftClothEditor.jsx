import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { recordOverrideEdit } from '../three/materialHistory.js'
import { refreshSoftCloth } from '../three/scene.js'
import { setFacePickHandler } from '../three/meshedit.js'
import { growRegion, toRanges, fromRanges, fillConnected } from '../three/regions.js'
import { getOriginalMaterials } from '../three/surfaceMaterials.js'
import { makeSoftZone, newZoneId, setSoftOverlay, getSoftEntry, resetSoftCloth, SOFT_PRESETS, SOFT_MODES } from '../three/softcloth.js'
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

// Pose panel > Mesh > Cloth: soft cloth and swing zones for selected parts.
// A zone makes a whole part, or a picked area, follow the animation on a spring (Soft cloth) or hang
// and swing as one piece (Swing). See three/softcloth.js.
export default function SoftClothEditor({ mesh, meshes, clothOn = false }) {
  const targets = (meshes?.length ? meshes : [mesh]).filter(Boolean)
  const targetUuids = targets.map((target) => target.uuid)
  const targetKey = targetUuids.join('|')
  const meshUuid = mesh.uuid
  const meshOverrides = useStore((s) => s.meshOverrides)
  const zonesByUuid = Object.fromEntries(
    targets.map((target) => [target.uuid, meshOverrides[target.uuid]?.softZones || EMPTY]),
  )
  const regions = meshOverrides[meshUuid]?.regions || EMPTY
  const setMeshSoftZones = useStore((s) => s.setMeshSoftZones)

  const [addMode, setAddMode] = useState('soft')
  const [areaKind, setAreaKind] = useState('all')
  const [regionId, setRegionId] = useState('')
  const [preset, setPreset] = useState('jacket')
  const [coupling, setCoupling] = useState('independent')
  const [picking, setPicking] = useState(false)
  const [growMode, setGrowMode] = useState('radius')
  const [tool, setTool] = useState('brush') // 'brush' picks faces (grown by growMode), 'fill' fills inside an outline
  const [tolerance, setTolerance] = useState(0.25)
  const [radius, setRadius] = useState(0.1)
  const [keepAdding, setKeepAdding] = useState(false)
  const [picksByUuid, setPicksByUuid] = useState({})
  const [pendingByUuid, setPendingByUuid] = useState({})
  const [fillsByUuid, setFillsByUuid] = useState({}) // faces added by the fill tool, kept as they were filled
  const [showId, setShowId] = useState(null)
  const [message, setMessage] = useState('')
  const meshesRef = useRef(targets)
  meshesRef.current = targets
  const keepRef = useRef(keepAdding)
  keepRef.current = keepAdding
  const pendingRef = useRef(pendingByUuid)
  pendingRef.current = pendingByUuid
  const fillsRef = useRef(fillsByUuid)
  fillsRef.current = fillsByUuid
  const growSettingsRef = useRef({ growMode, tolerance, radius, tool })
  growSettingsRef.current = { growMode, tolerance, radius, tool }

  // Fill tool: click inside an outline (picked faces) and every face connected to the click, up to the
  // outline, is selected. Faces that are not connected to the click are never reached. Clicking inside
  // a filled area again takes that fill away.
  const fillAt = (target, face) => {
    const geometry = getSoftEntry(target)?.orig || target.geometry
    const uuid = target.uuid
    const fills = fillsRef.current[uuid] || []
    const barrier = new Set(pendingRef.current[uuid] || [])
    if (fills.includes(face)) {
      const connected = new Set(fillConnected(geometry, face, null, new Set(fills)))
      const keep = fills.filter((t) => !connected.has(t))
      setFillsByUuid((prev) => ({ ...prev, [uuid]: keep }))
      setMessage('Took that fill away.')
      return
    }
    if (barrier.has(face)) {
      setMessage('That face is part of the outline. Click inside it to fill.')
      return
    }
    const flood = fillConnected(geometry, face, barrier)
    if (!flood.length) return
    // an outline with a gap lets the fill run out across the whole connected piece: say so
    let separated = flood.length // the faces the outline could have kept the fill out of
    if (barrier.size) {
      const island = new Set(fillConnected(geometry, face, null))
      let outline = 0
      for (const t of barrier) if (island.has(t)) outline++
      separated = island.size - outline
    }
    setFillsByUuid((prev) => ({ ...prev, [uuid]: [...(prev[uuid] || []), ...flood] }))
    setMessage(
      barrier.size && flood.length >= separated * 0.9
        ? `Filled ${flood.length} faces, but that is almost the whole connected piece: the outline probably has a gap. Click inside the fill again to take it away, close the gap, and fill again.`
        : `Filled ${flood.length} face${flood.length === 1 ? '' : 's'}.`,
    )
  }

  // A different selection: drop any half-made area.
  useEffect(() => {
    setPicksByUuid({})
    setFillsByUuid({})
    setPendingByUuid({})
    setPicking(false)
    setShowId(null)
    setMessage('')
    setAreaKind('all')
    setCoupling('independent')
  }, [targetKey])

  // The presets of the mode being added
  useEffect(() => {
    setPreset(SOFT_PRESETS[addMode][0].id)
  }, [addMode])

  // Pick mode: clicks in the viewport choose faces of any selected part.
  useEffect(() => {
    if (!picking) return undefined
    setFacePickHandler(
      (hit) => {
        if (!hit) {
          setMessage('Click on the part to pick a spot.')
          return
        }
        const target = meshesRef.current.find((candidate) => candidate.uuid === hit.uuid)
        if (!target) {
          setMessage('That is a different part: click one of the selected parts.')
          return
        }
        setMessage('')
        const settings = growSettingsRef.current
        if (settings.tool === 'fill') {
          fillAt(target, hit.faceIndex)
          return
        }
        // a brush click that replaces the area replaces the filled faces too
        if (!keepRef.current) setFillsByUuid((prev) => (prev[hit.uuid]?.length ? { ...prev, [hit.uuid]: [] } : prev))
        setPicksByUuid((prev) => {
          const current = prev[hit.uuid] || []
          const selected = pendingRef.current[hit.uuid] || []
          if (!keepRef.current) {
            return { ...prev, [hit.uuid]: selected.includes(hit.faceIndex) ? [] : [hit.faceIndex] }
          }
          const matching = current.filter((tri) => {
            const area =
              settings.growMode === 'radius'
                ? growByRadius(target, tri, settings.radius)
                : growRegion(target, tri, {
                    mode: settings.growMode,
                    tolerance: settings.tolerance,
                    source: getOriginalMaterials(target),
                  })
            return area.includes(hit.faceIndex)
          })
          if (selected.includes(hit.faceIndex) && matching.length) {
            return { ...prev, [hit.uuid]: current.filter((tri) => !matching.includes(tri)) }
          }
          return { ...prev, [hit.uuid]: [...current, hit.faceIndex] }
        })
      },
      { allowSkinned: true },
    )
    return () => setFacePickHandler(null)
  }, [picking, targetKey])

  // Grow the picked spots into areas whenever a pick, mode or setting changes.
  useEffect(() => {
    const next = {}
    for (const target of targets) {
      const picks = picksByUuid[target.uuid] || []
      const fills = fillsByUuid[target.uuid] || []
      if (!picks.length && !fills.length) continue
      const all = new Set(fills)
      const source = getOriginalMaterials(target)
      for (const tri of picks) {
        const grown =
          growMode === 'radius' ? growByRadius(target, tri, radius) : growRegion(target, tri, { mode: growMode, tolerance, source })
        for (const t of grown) all.add(t)
      }
      if (all.size) next[target.uuid] = Array.from(all)
    }
    setPendingByUuid(next)
  }, [picksByUuid, fillsByUuid, growMode, tolerance, radius, targetKey])

  const zoneEntries = targets.flatMap((target) =>
    (zonesByUuid[target.uuid] || []).map((zone) => ({ target, zone, key: `${target.uuid}:${zone.id}` })),
  )
  useEffect(() => {
    for (const target of targets) {
      const pending = pendingByUuid[target.uuid] || []
      const shown = (zonesByUuid[target.uuid] || []).find((zone) => `${target.uuid}:${zone.id}` === showId)
      const shownRanges = shown?.area.kind === 'tris' ? shown.area.tris : null
      if (pending.length) setSoftOverlay(target, pending, 0xff2bd6)
      else if (shownRanges) setSoftOverlay(target, fromRanges(shownRanges), 0x2bd6ff)
      else setSoftOverlay(target, null)
    }
    return () => targets.forEach((target) => setSoftOverlay(target, null))
  }, [pendingByUuid, meshOverrides, showId, targetKey])

  // `discrete`: add / remove / on-off / a preset are steps of their own; slider drags merge into one
  const commit = (uuid, next, discrete = false) => {
    recordOverrideEdit([uuid], () => setMeshSoftZones(uuid, next), null, { discrete })
    refreshSoftCloth()
  }
  const commitMany = (updates) => {
    const uuids = Object.keys(updates)
    if (!uuids.length) return
    recordOverrideEdit(
      uuids,
      () => uuids.forEach((uuid) => setMeshSoftZones(uuid, updates[uuid])),
      null,
      { discrete: true },
    )
    refreshSoftCloth()
  }
  const update = (uuid, id, patch, discrete = false) =>
    commit(uuid, (zonesByUuid[uuid] || []).map((z) => (z.id === id ? { ...z, ...patch } : z)), discrete)
  const remove = (uuid, id, key) => {
    if (showId === key) setShowId(null)
    commit(uuid, (zonesByUuid[uuid] || []).filter((z) => z.id !== id), true)
  }

  const region = regions.find((r) => r.id === regionId) || null
  const pendingCount = Object.values(pendingByUuid).reduce((total, faces) => total + faces.length, 0)
  const canAdd =
    !clothOn &&
    (areaKind === 'all' ||
      (areaKind === 'picked' && pendingCount > 0) ||
      (areaKind === 'region' && targets.length === 1 && region))

  const add = () => {
    const updates = {}
    const added = []
    const couplingGroup = coupling === 'independent' ? null : newZoneId()
    for (const target of targets) {
      let area = { kind: 'all' }
      let name = null
      if (areaKind === 'picked') {
        const pending = pendingByUuid[target.uuid] || []
        if (!pending.length) continue
        area = { kind: 'tris', tris: toRanges(pending), vertexCount: pending.length * 3 }
      } else if (areaKind === 'region' && region) {
        area = { kind: 'tris', tris: region.tris.map((r) => [...r]), vertexCount: 0 }
        name = region.name
      }
      const zones = zonesByUuid[target.uuid] || []
      const zone = makeSoftZone(addMode, area, preset)
      if (couplingGroup) {
        zone.couplingGroup = couplingGroup
        zone.couplingMode = coupling
      }
      const same = zones.filter((z) => z.mode === addMode).length
      zone.name = name ? `${name}` : `${SOFT_MODES[addMode]}${same ? ` ${same + 1}` : ''}`
      updates[target.uuid] = [...zones, zone]
      added.push({ target, zone })
    }
    commitMany(updates)
    if (added.length) setShowId(`${added[0].target.uuid}:${added[0].zone.id}`)
    setPicksByUuid({})
    setFillsByUuid({})
    setPendingByUuid({})
    setPicking(false)
  }

  const applyPreset = (uuid, zone, id) => {
    const p = SOFT_PRESETS[zone.mode].find((x) => x.id === id)
    if (!p) return
    const values = { ...p.values }
    // a preset never turns locking on for an area picked by hand, or off for the whole part
    if (zone.mode === 'swing' || zone.area.kind === 'tris') delete values.lockTop
    update(uuid, zone.id, { ...values, preset: id }, true)
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div className="radio-hint" style={{ marginBottom: 8 }}>
        Makes each selected part (or just a piece of it) move a little differently from the body so it does not look stuck on. Much
        cheaper than the full cloth simulation. <b>Soft cloth</b> is for fabric (a jacket, sleeves, a hood); <b>Swing</b> is for a
        piece that hangs and swings (a zip pull, a fastener). It plays while an animation plays; stopped or scrubbed frames
        show the plain pose. Picked soft-cloth areas can blend into unselected vertices on the same mesh to soften their boundary.
      </div>

      {clothOn && (
        <div className="radio-hint" style={{ marginBottom: 8, color: 'var(--warn, #e0a030)' }}>
          The full cloth simulation is on for at least one selected part. Turn it off to use soft cloth or swing.
        </div>
      )}

      {zoneEntries.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {zoneEntries.map(({ target, zone: z, key }) => {
            const mode = z.mode
            return (
              <details key={key} className="dangle-chain" style={{ marginBottom: 8 }}>
                <summary className="dangle-chain-summary" style={{ opacity: z.enabled === false ? 0.55 : 1 }}>
                  {targets.length > 1 ? `${target.name || 'Part'} · ` : ''}{z.name} · {SOFT_MODES[mode]}
                  {z.area.kind === 'tris' ? ' · area' : ' · whole part'}
                    {z.couplingMode === 'seams' ? ' · seam-connected' : z.couplingMode === 'rigid' ? ' · shared sway' : ''}
                </summary>
                <div className="row" style={{ justifyContent: 'space-between', marginTop: 8, gap: 6 }}>
                  <label className="row">
                    <input type="checkbox" checked={z.enabled !== false} onChange={(e) => update(target.uuid, z.id, { enabled: e.target.checked }, true)} />
                    <span>On</span>
                  </label>
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    {z.area.kind === 'tris' && (
                      <label className="row" title="Show which faces this effect moves">
                        <input type="checkbox" checked={showId === key} onChange={(e) => setShowId(e.target.checked ? key : null)} />
                        <span>Show area</span>
                      </label>
                    )}
                    <button className="btn secondary" onClick={() => resetSoftCloth()} title="Stop the motion and start again from the pose">
                      Reset
                    </button>
                    <button className="btn secondary" onClick={() => remove(target.uuid, z.id, key)} title="Remove this effect" aria-label="Remove this effect">
                      ×
                    </button>
                  </span>
                </div>

                <label className="field">
                  <span>Name</span>
                  <input type="text" value={z.name} onChange={(e) => update(target.uuid, z.id, { name: e.target.value })} />
                </label>
                <label className="field" title={SOFT_PRESETS[mode].find((p) => p.id === z.preset)?.hint || ''}>
                  <span>Preset</span>
                  <select value={z.preset || ''} onChange={(e) => applyPreset(target.uuid, z, e.target.value)}>
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
                  onChange={(v) => update(target.uuid, z.id, { amount: v })}
                />
                <Slider
                  label="Springiness"
                  hint="How hard it is pulled back to where the body puts it. Low = floppy and slow, high = tight and quick."
                  value={z.stiffness ?? 0.4}
                  min={0}
                  max={1}
                  format={pct}
                  onChange={(v) => update(target.uuid, z.id, { stiffness: v })}
                />
                <Slider
                  label="Damping"
                  hint="How quickly the bounce dies down. Low = keeps wobbling, high = settles at once."
                  value={z.damping ?? 0.5}
                  min={0}
                  max={1}
                  format={pct}
                  onChange={(v) => update(target.uuid, z.id, { damping: v })}
                />
                <Slider
                  label="Gravity"
                  hint="How much it droops and swings under its own weight."
                  value={z.gravity ?? 0.3}
                  min={0}
                  max={1}
                  format={pct}
                  onChange={(v) => update(target.uuid, z.id, { gravity: v })}
                />
                {z.area.kind === 'tris' && (
                  <>
                    <label className="row" style={{ margin: '8px 0' }} title="Let the simulation ease into the rest of this mesh instead of ending abruptly at the picked faces.">
                      <input
                        type="checkbox"
                        aria-label="Blend into unselected area"
                        checked={z.blendOutside !== false}
                        onChange={(e) => update(target.uuid, z.id, { blendOutside: e.target.checked }, true)}
                      />
                      <span>Blend into unselected area</span>
                    </label>
                    {z.blendOutside !== false && (
                      <>
                        <label className="field">
                          <span>Blend where</span>
                          <select
                            aria-label="Blend where"
                            value={z.outsideMode === 'all' ? 'all' : 'connected'}
                            onChange={(e) => update(target.uuid, z.id, { outsideMode: e.target.value }, true)}
                          >
                            <option value="connected">Near the connected edge</option>
                            <option value="all">All unselected mesh areas</option>
                          </select>
                        </label>
                        {z.outsideMode !== 'all' && (
                          <Slider
                            label="Blend distance"
                            hint="How far the effect fades into the unselected mesh from the picked edge."
                            value={z.outsideRange ?? 0.35}
                            min={0.05}
                            max={1}
                            format={pct}
                            onChange={(v) => update(target.uuid, z.id, { outsideRange: v })}
                          />
                        )}
                        <Slider
                          label="Outside influence"
                          hint="Maximum cloth influence outside the picked area. Lower values keep the rest of the mesh closer to its animated pose."
                          value={z.outsideStrength ?? 0.18}
                          min={0}
                          max={0.5}
                          format={pct}
                          onChange={(v) => update(target.uuid, z.id, { outsideStrength: v })}
                        />
                      </>
                    )}
                  </>
                )}
                {mode === 'soft' ? (
                  <>
                    <Slider
                      label="Bounce (up and down)"
                      hint="How freely the cloth bobs up and down as the body moves. Less = held firmly, 100% = normal, more = loose and bouncy, like a hood on a run."
                      value={z.bounce ?? 1}
                      min={0}
                      max={2.5}
                      format={pct}
                      onChange={(v) => update(target.uuid, z.id, { bounce: v })}
                    />
                    <Slider
                      label="Range"
                      hint="The furthest it may drift from the pose, as a share of the size of the area."
                      value={z.range ?? 0.08}
                      min={0}
                      max={0.4}
                      format={pct}
                      onChange={(v) => update(target.uuid, z.id, { range: v })}
                    />
                    <Slider
                      label="Smoothing"
                      hint="How much neighbouring points move together. High = one smooth piece of cloth, low = each point on its own."
                      value={z.smoothing ?? 0.6}
                      min={0}
                      max={1}
                      format={pct}
                      onChange={(v) => update(target.uuid, z.id, { smoothing: v })}
                    />
                    <Slider
                      label="Edge hold"
                      hint="How far in from the edge of the area (or from the held top) it stays fixed to the body before it starts to move. Bigger = the movement frees up more gradually."
                      value={z.blend ?? 0.4}
                      min={0.02}
                      max={1}
                      format={pct}
                      onChange={(v) => update(target.uuid, z.id, { blend: v })}
                    />
                    <Slider
                      label="Hold the top"
                      hint="Keeps the top part of the area fixed to the body (a collar, a waistband), so the cloth hangs from it."
                      value={z.lockTop ?? 0}
                      min={0}
                      max={0.8}
                      format={pct}
                      onChange={(v) => update(target.uuid, z.id, { lockTop: v })}
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
                      onChange={(v) => update(target.uuid, z.id, { swingLimit: v })}
                    />
                    <Slider
                      label="Body reaction"
                      hint="How strongly it is thrown about when the body speeds up, stops or turns. 0 = only gravity and the pose move it, 100% = realistic, more = exaggerated."
                      value={z.reaction ?? 1}
                      min={0}
                      max={2}
                      format={pct}
                      onChange={(v) => update(target.uuid, z.id, { reaction: v })}
                    />
                    <label className="row" title="Tick for a string, strap or cord that is fixed at its top end: the top stays held to the garment and it bends out from there. Leave off for a small separate piece (a zip pull, a charm) that swings as one rigid piece. It is on automatically when the piece is joined to, or touches, another part with an effect.">
                      <input type="checkbox" checked={z.hangs === true} onChange={(e) => update(target.uuid, z.id, { hangs: e.target.checked }, true)} />
                      <span>Hangs from its top end</span>
                    </label>
                    <Slider
                      label="Rigid top"
                      hint="How much of the piece, from where it joins the mesh, is locked solid to it (it moves exactly with the cloth it hangs from). Only below this does it swing."
                      value={z.holdTop ?? 0}
                      min={0}
                      max={0.7}
                      format={pct}
                      onChange={(v) => update(target.uuid, z.id, { holdTop: v })}
                    />
                    <Slider
                      label="Edge hold"
                      hint="If the piece is joined to the rest of the part, how far from the join it bends before the rest swings stiff. 0 = it swings from the join like a hinge."
                      value={z.blend ?? 0.15}
                      min={0.02}
                      max={1}
                      format={pct}
                      onChange={(v) => update(target.uuid, z.id, { blend: v })}
                    />
                  </>
                )}
              </details>
            )
          })}
        </div>
      )}

      <div className="dangle-add" style={{ borderTop: zoneEntries.length ? '1px solid var(--border, #333)' : 'none', paddingTop: zoneEntries.length ? 8 : 0 }}>
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
                setPicksByUuid({})
                setFillsByUuid({})
                setPendingByUuid({})
              }
            }}
            disabled={clothOn}
          >
            <option value="all">{targets.length > 1 ? 'Every selected part' : 'The whole part'}</option>
            <option value="picked">An area I pick on the part…</option>
            {targets.length === 1 && regions.length > 0 && <option value="region">A painted region…</option>}
          </select>
        </label>
        {targets.length > 1 && (
          <label className="field" title="Choose whether effects added across these meshes move separately or together.">
            <span>Connection for new effects</span>
            <select value={coupling} onChange={(e) => setCoupling(e.target.value)} disabled={clothOn}>
              <option value="independent">Independently</option>
              <option value="seams">Connect at nearby seams</option>
              <option value="rigid">As one rigid piece</option>
            </select>
          </label>
        )}

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
              {pendingCount
                ? `${pendingCount} face${pendingCount === 1 ? '' : 's'} selected across ${Object.keys(pendingByUuid).length} part${Object.keys(pendingByUuid).length === 1 ? '' : 's'} (shown in pink). Click a selected area again to remove it.`
                : 'Click one or more selected parts in the viewport where the effect should be (a hood, a cuff, the zip pull).'}
            </div>
            <label className="field">
              <span>Tool</span>
              <select value={tool} onChange={(e) => setTool(e.target.value)}>
                <option value="brush">Pick faces</option>
                <option value="fill">Fill inside an outline</option>
              </select>
            </label>
            {tool === 'brush' && (
            <label className="field">
              <span>Grow by</span>
              <select value={growMode} onChange={(e) => setGrowMode(e.target.value)}>
                <option value="radius">Distance around the click</option>
                <option value="piece">The whole connected piece</option>
                <option value="color">Connected faces of a similar colour</option>
                <option value="face">Just that face</option>
              </select>
            </label>
            )}
            {tool === 'fill' && (
              <div className="radio-hint">
                Outline the area first with &quot;Pick faces&quot; (with &quot;Each click adds to the area&quot; on, click a ring or a line of
                faces around it, using a small size or &quot;Just that face&quot;), switch to Fill, then click inside it: every connected face up to the outline is selected. Separate pieces are never
                reached, so filling a hood does not pick up the jacket. Click inside a fill again to take it away.
              </div>
            )}
            {tool === 'brush' && growMode === 'radius' && (
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
            {tool === 'brush' && growMode === 'color' && (
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
            {tool === 'brush' && (
            <label className="row" title="Each click adds to the area instead of replacing it">
              <input type="checkbox" checked={keepAdding} onChange={(e) => setKeepAdding(e.target.checked)} />
              <span>Each click adds to the area</span>
            </label>
            )}
          </div>
        )}
        {message && <div className="radio-hint">{message}</div>}

        <div className="row" style={{ marginTop: 8, gap: 6 }}>
          <button className="btn secondary" disabled={!canAdd} onClick={add}>
            Add effect
          </button>
          {areaKind === 'picked' && pendingCount > 0 && (
            <button
              className="btn secondary"
              onClick={() => {
                setPicksByUuid({})
                setFillsByUuid({})
                setPendingByUuid({})
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
