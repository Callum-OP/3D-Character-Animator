import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import { applyModelMaterials } from '../three/scene.js'
import { recordOverrideEdit } from '../three/materialHistory.js'
import {
  ensureDecimatorReady,
  isDecimatorReady,
  getOriginalGeometry,
  triangleCount,
  vertexCount,
} from '../three/decimate.js'

// Reduce detail for the selected part(s): keeps a share of the triangles, so a high-resolution
// model becomes low-poly / game ready and the exported file shrinks. Non-destructive — the
// slider back at 100% brings every triangle back (see three/decimate.js).

const PRESETS = [75, 50, 25, 10, 5]
const fmt = (n) => Math.round(n).toLocaleString('en-GB')

export default function DecimateEditor({ selectedMeshUuids, primaryUuid, resolveMesh }) {
  const meshOverrides = useStore((s) => s.meshOverrides)
  const setMeshesDecimate = useStore((s) => s.setMeshesDecimate)
  const [ready, setReady] = useState(isDecimatorReady())
  const [draft, setDraft] = useState(null) // percent while the slider is being dragged
  const timer = useRef(null)

  useEffect(() => {
    let live = true
    ensureDecimatorReady().then(() => live && setReady(isDecimatorReady()))
    return () => {
      live = false
      clearTimeout(timer.current)
    }
  }, [])

  const primary = resolveMesh(primaryUuid)
  if (!primary || !primary.geometry) return null

  const setting = meshOverrides[primaryUuid] && meshOverrides[primaryUuid].decimate
  const kept = setting ? Math.round(setting.ratio * 100) : 100
  const protect = !setting || setting.protect !== false
  const shown = draft == null ? kept : draft

  function commit(patch) {
    clearTimeout(timer.current)
    setDraft(null)
    recordOverrideEdit(selectedMeshUuids, () => setMeshesDecimate(selectedMeshUuids, patch))
    applyModelMaterials()
  }
  function drag(percent) {
    setDraft(percent)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => commit({ ratio: percent / 100 }), 350) // keyboard / long pauses
  }

  let beforeTris = 0
  let afterTris = 0
  let beforeVerts = 0
  let afterVerts = 0
  for (const uuid of selectedMeshUuids) {
    const mesh = resolveMesh(uuid)
    if (!mesh || !mesh.geometry) continue
    const original = getOriginalGeometry(mesh)
    beforeTris += triangleCount(original)
    afterTris += triangleCount(mesh.geometry)
    beforeVerts += vertexCount(original)
    afterVerts += vertexCount(mesh.geometry)
  }
  const reduced = afterTris < beforeTris
  const parts = selectedMeshUuids.length

  return (
    <details className="joint-controls" style={{ marginTop: 10 }}>
      <summary style={{ cursor: 'pointer' }}>
        <span className="joint-name">Reduce detail</span>{' '}
        <span className="joint-parent">{reduced ? `${kept}% of the triangles kept` : 'fewer triangles, smaller files'}</span>
      </summary>
      <div style={{ marginTop: 8 }}>
        <label className="slider-row" title="Share of the triangles to keep. 100% leaves the part as it was loaded.">
          <span className="slider-label">Detail kept</span>
          <input
            type="range"
            aria-label="Detail kept"
            min={1}
            max={100}
            step={1}
            value={shown}
            disabled={!ready}
            onChange={(e) => drag(Number(e.target.value))}
            onPointerUp={(e) => {
              if (draft != null) commit({ ratio: Number(e.currentTarget.value) / 100 })
            }}
          />
          <span style={{ minWidth: 38, textAlign: 'right' }}>{shown}%</span>
          <button
            type="button"
            className="btn secondary"
            style={{ padding: '0 6px', visibility: kept < 100 ? 'visible' : 'hidden' }}
            title="Back to full detail"
            onClick={() => commit({ ratio: 1 })}
          >
            ↺
          </button>
        </label>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '6px 0' }}>
          {PRESETS.map((p) => (
            <button key={p} type="button" className={`btn ${kept === p ? '' : 'secondary'}`} disabled={!ready} onClick={() => commit({ ratio: p / 100 })}>
              {p}%
            </button>
          ))}
        </div>

        <label className="morph-label" title="Keeps the outline of open pieces (cloth, hair cards, leaves) and the seams between materials in place, so nothing shrinks or tears.">
          <input type="checkbox" checked={protect} disabled={!ready} onChange={(e) => commit({ protect: e.target.checked, ratio: setting ? setting.ratio : 1 })} />
          Protect open edges and material seams
        </label>

        <div className="joint-parent" style={{ marginTop: 6 }}>
          {ready
            ? `${parts > 1 ? `${parts} parts · ` : ''}${fmt(beforeTris)}${reduced ? ` → ${fmt(afterTris)}` : ''} triangles · ${fmt(beforeVerts)}${reduced ? ` → ${fmt(afterVerts)}` : ''} vertices`
            : 'Getting ready…'}
        </div>
        <div className="joint-parent" style={{ marginTop: 4, opacity: 0.8 }}>
          The saved / exported model uses the reduced version. Paint regions don't apply to a reduced part.
        </div>
      </div>
    </details>
  )
}
