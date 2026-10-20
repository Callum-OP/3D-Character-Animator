import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import { applyModelMaterials } from '../three/scene.js'
import { setFacePickHandler } from '../three/meshedit.js'
import { getOriginalMaterials } from '../three/surfaceMaterials.js'
import { recordOverrideEdit } from '../three/materialHistory.js'
import LightFromPart from './LightFromPart.jsx'
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
  const [glowToo, setGlowToo] = useState(true)
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

  // The highlight: magenta for the selection being made, cyan for the chosen region.
  useEffect(() => {
    const target = meshRef.current
    if (!target) return undefined
    if (pending && pending.length) setRegionOverlay(target, pending, 0xff2bd6)
    else if (selected && highlight) setRegionOverlay(target, fromRanges(selected.tris), 0x2bd6ff)
    else setRegionOverlay(target, null)
    return () => setRegionOverlay(target, null)
  }, [pending, selected, highlight, meshUuid, regions])

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

  function patchLook(patch) {
    if (!selected) return
    commit(regions.map((r) => (r.id === selected.id ? { ...r, look: mergeRegionLook(r.look || {}, patch) } : r)))
  }

  function removeRegion() {
    if (!selected) return
    if (!window.confirm(`Are you sure you want to delete "${selected.name}"? (Ctrl+Z will bring it back.)`)) return
    commit(regions.filter((r) => r.id !== selected.id))
    setSelectedId(null)
  }

  const look = (selected && selected.look) || {}

  return (
    <div style={{ marginTop: 8 }}>
      <div className="radio-hint" style={{ marginBottom: 6 }}>
        Pick a headlight, window or stripe on the model and change just that part&apos;s colour, glow and shine — it
        stops where the colour ends.
      </div>

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
      {regions.length >= MAX_REGIONS && <div className="radio-hint">Up to {MAX_REGIONS} regions per part.</div>}
      {message && <div className="radio-hint" style={{ marginTop: 4 }}>{message}</div>}

      {seed && pending && (
        <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(255,43,214,0.10)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
            {GROW_MODES.map((g) => (
              <button key={g.id} className={`btn ${mode === g.id ? '' : 'secondary'}`} title={g.hint} onClick={() => setMode(g.id)}>
                {g.label}
              </button>
            ))}
          </div>
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
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 10 }}>
            {regions.map((r) => (
              <button
                key={r.id}
                className={`btn ${selectedId === r.id ? '' : 'secondary'}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                onClick={() => { setSelectedId(r.id === selectedId ? null : r.id); setSeed(null); setPending(null) }}
              >
                <span style={{ width: 11, height: 11, borderRadius: 3, background: (r.look && r.look.color) || '#888', border: '1px solid #888' }} />
                {r.name}
              </button>
            ))}
          </div>
        </>
      )}

      {selected && (
        <div style={{ marginTop: 8, position: 'relative' }}>
          <button
            className="obj-del"
            style={{ position: 'absolute', top: 0, right: 0 }}
            title="Delete this region"
            aria-label="Delete this region"
            onClick={removeRegion}
          >
            ×
          </button>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, paddingRight: 26 }}>
            <input
              className="text-input"
              aria-label="Region name"
              value={selected.name}
              onChange={(e) => commit(regions.map((r) => (r.id === selected.id ? { ...r, name: e.target.value } : r)))}
              style={{ flex: 1 }}
            />
            <label className="color-control-solid" title="Show this region on the model">
              <input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} /> Highlight
            </label>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
            {LOOK_PRESETS.map((p) => (
              <button key={p.label} className="btn secondary" onClick={() => patchLook({ ...CLEAR_LOOK, ...p.look })}>
                {p.label}
              </button>
            ))}
            <button className="btn secondary" onClick={() => patchLook(CLEAR_LOOK)} title="Back to how the model looks">Original</button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {[['none', 'Keep texture'], ['tint', 'Tint'], ['solid', 'Solid colour']].map(([id, label]) => (
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
          {[['roughness', 'Roughness'], ['metalness', 'Metalness']].map(([key, label]) => (
            <label key={key} className="slider-row" title={`${label} (Studio / Realistic styles)`}>
              <span className="slider-label">{label}</span>
              <input type="range" min={0} max={1} step={0.01} value={look[key] != null ? look[key] : 0.5} onChange={(e) => patchLook({ [key]: Number(e.target.value) })} />
              <span style={{ minWidth: 34, textAlign: 'right', opacity: look[key] != null ? 1 : 0.55 }}>{(look[key] != null ? look[key] : 0.5).toFixed(2)}</span>
              <button className="btn secondary" style={{ padding: '0 6px', visibility: look[key] != null ? 'visible' : 'hidden' }} onClick={() => patchLook({ [key]: null })} title="Back to the model's own value">↺</button>
            </label>
          ))}
          <div className="radio-hint">Roughness and metalness show in Studio / Realistic styles; colour and glow show in every style.</div>

          <LightFromPart
            uuids={[meshUuid]}
            regionId={selected.id}
            label="Turn this region into a light"
            onCreated={() => {
              // A lit tail light should also LOOK lit: give the surface a glow in the same colour.
              if (glowToo && !(look.glow > 0)) patchLook({ glow: GLOW_ON_LIGHT, glowColor: look.glowColor || look.color || null })
            }}
          >
            <label className="color-control-solid" style={{ display: 'block', marginTop: 4 }} title="Also make the surface itself glow, so it looks lit as well as casting light">
              <input type="checkbox" checked={glowToo} onChange={(e) => setGlowToo(e.target.checked)} /> Also make the surface glow
            </label>
          </LightFromPart>
        </div>
      )}
    </div>
  )
}
