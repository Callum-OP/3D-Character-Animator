import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { getCurrentModel } from '../three/scene.js'
import { setFacePickHandler } from '../three/meshedit.js'
import { addDangleChainUndoable, collectDescendantBoneNames } from '../three/dangle.js'
import {
  isRigCapable,
  planForMeshes,
  applyPartRig,
  removePartRig,
  updatePartRig,
  getPartRigDependents,
  getPartRigEntries,
  trisFromClick,
  resizeSelection,
  setPartRigHighlight,
  setPartRigPreview,
  clearPartRigFeedback,
  fromRanges,
} from '../three/partRig.js'

// Add bones to a piece of a skinned mesh — a strand of hair, a hood, a cape, a scarf — without leaving
// the app. Pick the faces, choose how many bones, press the button: the chain is built, the vertices are
// skinned to it (blended back into the body's own skinning at the top so nothing tears), and optionally
// swing physics is switched on. See three/partRig.js and three/partRigMath.js.

const PRESETS = [
  { id: 'hair', label: 'Hair strand', name: 'Hair', hint: 'A strand, lock or ponytail: one chain following the piece.', o: { segments: 4, columns: 1, direction: 'shape', stick: 0.1 } },
  { id: 'cape', label: 'Cape / cloak', name: 'Cape', hint: 'Hangs from the shoulders: several chains side by side.', o: { segments: 5, columns: 4, direction: 'down', stick: 0.12 } },
  { id: 'hood', label: 'Hood', name: 'Hood', hint: 'Stays on the neck, the back of the hood can move.', o: { segments: 3, columns: 3, direction: 'shape', stick: 0.3 } },
  { id: 'scarf', label: 'Scarf / tail', name: 'Scarf', hint: 'A long thin piece: one chain.', o: { segments: 5, columns: 1, direction: 'shape', stick: 0.1 } },
]

const MODES = [
  { id: 'piece', label: 'Whole piece', hint: 'Click once: selects the whole connected piece (a hair card, a cape, a sleeve…).' },
  { id: 'brush', label: 'Brush', hint: 'Click to paint a patch on the surface — for a hood or cape that is joined to the rest of the mesh. Click again to add more.' },
  { id: 'color', label: 'Same colour', hint: 'Selects the connected faces that keep the colour you clicked (hair against skin).' },
  { id: 'face', label: 'Single face', hint: 'One face at a time, for fine tuning.' },
]

export default function PartRigSection({ meshUuid, meshUuids, resolveMesh }) {
  const modelInfo = useStore((s) => s.modelInfo)
  const [mode, setMode] = useState('piece')
  const [erase, setErase] = useState(false)
  const [brushPct, setBrushPct] = useState(6)
  const [tolerance, setTolerance] = useState(0.25)
  const [trisByMesh, setTrisByMesh] = useState({})
  const [picking, setPicking] = useState(false)
  const [message, setMessage] = useState('')
  const [presetId, setPresetId] = useState('hair')
  const [label, setLabel] = useState('Hair')
  const [opts, setOpts] = useState({ ...PRESETS[0].o, flip: false, perPiece: true, parentBoneName: null, allowAddedBoneAttachment: false, influence: 1, includeNearbySurfaces: false, nearbySurfaceDistance: 0.02 })
  const [addPhysics, setAddPhysics] = useState(true)
  const [summary, setSummary] = useState(null)
  const [version, setVersion] = useState(0)
  const [editingId, setEditingId] = useState(null)

  const model = getCurrentModel()
  const entries = getPartRigEntries(model)
  const editingEntry = entries.find((entry) => entry.id === editingId) || null
  const inputSelectionKey = (meshUuids?.length ? meshUuids : [meshUuid]).join('|')
  const requestedUuids = editingEntry
    ? (editingEntry.result.meshes || [editingEntry.result]).map((item) => item.mesh.uuid)
    : (meshUuids?.length ? meshUuids : [meshUuid])
  const selectionKey = requestedUuids.join('|')
  const meshes = requestedUuids.map((uuid) => resolveMesh(uuid)).filter(Boolean)
  const mesh = meshes.find((item) => item.uuid === meshUuid) || meshes[0]
  const capable = meshes.length > 0 && meshes.every(isRigCapable)
  const tris = meshes.flatMap((item) => trisByMesh[item.uuid] || [])
  const selections = meshes.map((item) => ({ mesh: item, tris: trisByMesh[item.uuid] || [] }))
  const ref = useRef({})
  ref.current = { meshes, mode, erase, brushPct, tolerance, model }

  // another part: drop the half-made selection
  useEffect(() => {
    setTrisByMesh({})
    setPicking(false)
    setMessage('')
    setEditingId(null)
  }, [inputSelectionKey])

  useEffect(() => {
    setOpts((current) => ({ ...current, perPiece: requestedUuids.length === 1 }))
  }, [inputSelectionKey])

  // click in the viewport -> faces
  useEffect(() => {
    if (!picking) return undefined
    setFacePickHandler((hit) => {
      const r = ref.current
      if (!hit) return setMessage('Click on the part you want to rig.')
      const hitMesh = r.meshes.find((item) => item.uuid === hit.uuid)
      if (!hitMesh) return setMessage('Select the parts you want to rig first, then click one of them.')
      const box = new THREE.Box3().setFromObject(r.model.root)
      const height = Math.max(box.max.y - box.min.y, 0.01)
      const picked = trisFromClick(hitMesh, hit, { mode: r.mode, tolerance: r.tolerance, radius: (height * r.brushPct) / 100 })
      setMessage('')
      setTrisByMesh((current) => {
        const cur = current[hit.uuid] || []
        if (r.erase) {
          const drop = new Set(picked)
          return { ...current, [hit.uuid]: cur.filter((t) => !drop.has(t)) }
        }
        return { ...current, [hit.uuid]: Array.from(new Set([...cur, ...picked])) }
      })
    }, { allowSkinned: true })
    return () => setFacePickHandler(null)
  }, [picking])

  // pink highlight of the picked faces
  useEffect(() => {
    for (const item of meshes) setPartRigHighlight(item, trisByMesh[item.uuid] || [])
    return () => meshes.forEach((item) => setPartRigHighlight(item, null))
  }, [trisByMesh, selectionKey, editingId])

  // cyan preview of the bones that would be made (follows every change of settings)
  useEffect(() => {
    if (!mesh || !capable || !tris.length) {
      setPartRigPreview(null, null)
      setSummary(null)
      return undefined
    }
    const timer = setTimeout(() => {
      const generatedBoneNames = entries.flatMap((entry) => entry.boneNames)
      const plan = planForMeshes(meshes, selections, opts, generatedBoneNames)
      setPartRigPreview(mesh, plan)
      setSummary(plan.ok ? { bones: plan.bones.length, pieces: plan.pieces.length, parent: mesh.skeleton.bones[plan.pieces[0].parentBone].name } : { error: plan.reason })
    }, 120)
    return () => clearTimeout(timer)
  }, [trisByMesh, opts, selectionKey, version, editingId, entries])

  useEffect(() => () => {
    clearPartRigFeedback()
    setFacePickHandler(null)
  }, [])

  if (!mesh) return null
  if (!capable) {
    return (
      <div className="radio-hint" style={{ marginTop: 10 }}>
        This part is not skinned to the skeleton, so bones cannot be added to it. Pick a skinned part (hair, a cape or a jacket usually are).
      </div>
    )
  }

  const patch = (p) => setOpts((o) => ({ ...o, ...p }))
  const generatedBoneNames = new Set(entries.flatMap((entry) => entry.boneNames))
  const boneChoices = (modelInfo?.bones || []).filter((b) =>
    b.deform && (opts.allowAddedBoneAttachment || !generatedBoneNames.has(b.name)),
  )
  const visibleEntries = entries.filter((entry) => {
    const targetMeshes = (entry.result.meshes || [entry.result]).map((item) => item.mesh)
    return targetMeshes.some((item) => meshes.includes(item))
  })

  function choosePreset(id) {
    const p = PRESETS.find((x) => x.id === id)
    setPresetId(id)
    setLabel(p.name)
    patch(p.o)
  }

  function onAdd() {
    const res = applyPartRig(model, meshes, selections, opts, { label })
    if (!res.ok) return setMessage(res.reason)
    const { entry } = res
    if (addPhysics) {
      entry.rootBoneNames.forEach((root, i) => {
        addDangleChainUndoable(entry.rootBoneNames.length > 1 ? `${entry.label} ${i + 1}` : entry.label, collectDescendantBoneNames(model, root, 64))
      })
    }
    setTrisByMesh({})
    setPicking(false)
    setVersion((v) => v + 1)
    setMessage(`Added ${entry.boneNames.length} bones${addPhysics ? ' with swing physics' : ''}. They show up in Pose mode’s bone list. Ctrl+Z undoes it.`)
  }

  function onEdit(entry) {
    const dependents = getPartRigDependents(model, entry.id)
    if (dependents.length) return setMessage(`Remove dependent rigs first: ${dependents.map((item) => item.label).join(', ')}.`)
    const targetMeshes = (entry.result.meshes || [entry.result]).map((item) => item.mesh)
    const savedRanges = entry.trisByMesh || [entry.tris]
    setEditingId(entry.id)
    setLabel(entry.label)
    const usesAddedParent = (entry.parentNames || []).some((name) => generatedBoneNames.has(name))
    setOpts({ ...PRESETS[0].o, influence: 1, includeNearbySurfaces: false, nearbySurfaceDistance: 0.02, ...entry.options, allowAddedBoneAttachment: entry.options.allowAddedBoneAttachment || usesAddedParent })
    setTrisByMesh(Object.fromEntries(targetMeshes.map((item, i) => [item.uuid, fromRanges(savedRanges[i] || [])])))
    setPicking(false)
    setMessage(`Editing ${entry.label}. Change the settings, then update the bones.`)
  }

  function onUpdate() {
    const result = updatePartRig(model, editingId, { label, options: opts })
    if (!result.ok) return setMessage(result.reason)
    setEditingId(null)
    setTrisByMesh({})
    setVersion((v) => v + 1)
    setMessage(`Updated ${result.entry.boneNames.length} bones. Ctrl+Z undoes it.`)
  }

  function onDelete(entry) {
    const dependents = getPartRigDependents(model, entry.id)
    if (dependents.length) return setMessage(`Cannot delete ${entry.label}: ${dependents.map((item) => item.label).join(', ')} ${dependents.length === 1 ? 'is' : 'are'} attached to its bones. Delete those rigs first.`)
    if (!removePartRig(model, entry.id)) return setMessage('That bone rig is no longer available.')
    if (editingId === entry.id) setEditingId(null)
    setVersion((v) => v + 1)
    setMessage(`Removed ${entry.label}'s bones. Ctrl+Z restores them.`)
  }

  function onPhysics(entry) {
    entry.rootBoneNames.forEach((root, i) => {
      addDangleChainUndoable(entry.rootBoneNames.length > 1 ? `${entry.label} ${i + 1}` : entry.label, collectDescendantBoneNames(model, root, 64))
    })
    setMessage('Swing physics added. Tune it in Pose mode under Dangle Physics.')
  }

  const modeHint = MODES.find((m) => m.id === mode)?.hint

  return (
    <div style={{ marginTop: 6 }}>
      <div className="radio-hint">
        Pick faces on one or more parts. With multiple parts selected, one shared chain extends across them by default.
      </div>

      <div className="kf-actions" style={{ marginTop: 6, flexWrap: 'wrap' }}>
        {PRESETS.map((p) => (
          <button key={p.id} className={`btn ${presetId === p.id ? '' : 'secondary'}`} title={p.hint} onClick={() => choosePreset(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="radio-hint">{PRESETS.find((p) => p.id === presetId)?.hint}</div>

      <div className="kf-actions" style={{ marginTop: 8 }}>
        <button className={`btn ${picking ? '' : 'secondary'}`} onClick={() => { setPicking((v) => !v); setMessage('') }}>
          {picking ? 'Picking: click the part…' : '1. Pick faces'}
        </button>
        <button className="btn secondary" disabled={!trisByMesh[mesh.uuid]?.length} onClick={() => setTrisByMesh((current) => ({ ...current, [mesh.uuid]: resizeSelection(mesh, current[mesh.uuid] || [], 1) }))} title="Add one ring of faces around the primary part's selection">Grow</button>
        <button className="btn secondary" disabled={!trisByMesh[mesh.uuid]?.length} onClick={() => setTrisByMesh((current) => ({ ...current, [mesh.uuid]: resizeSelection(mesh, current[mesh.uuid] || [], -1) }))} title="Take one ring of faces off the primary part's selection">Shrink</button>
        <button className="btn secondary" disabled={!tris.length} onClick={() => setTrisByMesh({})}>Clear</button>
      </div>

      {picking && (
        <>
          <label className="slider-row" title={modeHint}>
            <span className="slider-label">Select</span>
            <select className="select" value={mode} onChange={(e) => setMode(e.target.value)} aria-label="How a click picks faces">
              {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <span />
          </label>
          <div className="radio-hint">{modeHint}</div>
          {mode === 'brush' && (
            <label className="slider-row" title="Brush size as a share of the character's height">
              <span className="slider-label">Brush</span>
              <input type="range" min="1" max="40" value={brushPct} onChange={(e) => setBrushPct(Number(e.target.value))} />
              <span className="slider-value">{brushPct}%</span>
            </label>
          )}
          {mode === 'color' && (
            <label className="slider-row" title="How far a colour may drift from the one you clicked">
              <span className="slider-label">Tolerance</span>
              <input type="range" min="0" max="1" step="0.01" value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
              <span className="slider-value">{Math.round(tolerance * 100)}%</span>
            </label>
          )}
          <label className="morph-label" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={erase} onChange={(e) => setErase(e.target.checked)} />
            Remove from selection instead
          </label>
        </>
      )}
      {message && <div className="radio-hint" style={{ marginTop: 4 }}>{message}</div>}

      {tris.length > 0 && (
        <>
          <div className="radio-hint" style={{ marginTop: 6 }}>
            {tris.length} face{tris.length === 1 ? '' : 's'} selected across {selections.filter((selection) => selection.tris.length).length} part{selections.filter((selection) => selection.tris.length).length === 1 ? '' : 's'} (pink).
            {summary && !summary.error && ` ${summary.bones} bone${summary.bones === 1 ? '' : 's'} on ${summary.pieces} chain group${summary.pieces === 1 ? '' : 's'}, hanging from “${summary.parent}” (blue).`}
            {summary && summary.error && ` ${summary.error}`}
          </div>

          <label className="slider-row" title="Used to name the new bones">
            <span className="slider-label">Name</span>
            <input className="select" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Name for the new bones" />
            <span />
          </label>
          <label className="slider-row" title="Bones in each chain: more bones bend smoother">
            <span className="slider-label">Bones</span>
            <input type="range" min="1" max="12" value={opts.segments} onChange={(e) => patch({ segments: Number(e.target.value) })} />
            <span className="slider-value">{opts.segments}</span>
          </label>
          <label className="slider-row" title="Chains side by side: a cape needs several, a strand needs one">
            <span className="slider-label">Chains</span>
            <input type="range" min="1" max="8" value={opts.columns} onChange={(e) => patch({ columns: Number(e.target.value) })} />
            <span className="slider-value">{opts.columns}</span>
          </label>
          <label className="slider-row" title="How much of the top keeps the body's own movement, so it stays attached">
            <span className="slider-label">Top stays</span>
            <input type="range" min="0" max="60" value={Math.round(opts.stick * 100)} onChange={(e) => patch({ stick: Number(e.target.value) / 100 })} />
            <span className="slider-value">{Math.round(opts.stick * 100)}%</span>
          </label>
          <label className="slider-row" title="How much the new bones affect the selected surface; lower values blend more of the original skinning back in">
            <span className="slider-label">Bone influence</span>
            <input type="range" min="0" max="100" value={Math.round(opts.influence * 100)} onChange={(e) => patch({ influence: Number(e.target.value) / 100 })} />
            <span className="slider-value">{Math.round(opts.influence * 100)}%</span>
          </label>
          <label className="morph-label" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }} title="Also rig disconnected mesh layers close to the picked surface, such as the inside of a jacket.">
            <input type="checkbox" checked={opts.includeNearbySurfaces} onChange={(e) => patch({ includeNearbySurfaces: e.target.checked })} />
            Include nearby surfaces
          </label>
          {opts.includeNearbySurfaces && (
            <label className="slider-row" title="Maximum distance to the picked surface, as a share of the selected mesh bounds">
              <span className="slider-label">Surface range</span>
              <input type="range" min="0.5" max="10" step="0.5" value={Math.round(opts.nearbySurfaceDistance * 1000) / 10} onChange={(e) => patch({ nearbySurfaceDistance: Number(e.target.value) / 100 })} />
              <span className="slider-value">{Math.round(opts.nearbySurfaceDistance * 1000) / 10}%</span>
            </label>
          )}
          <label className="slider-row" title="Which way the chain runs">
            <span className="slider-label">Direction</span>
            <select className="select" value={opts.direction} onChange={(e) => patch({ direction: e.target.value })} aria-label="Chain direction">
              <option value="shape">Follow the shape</option>
              <option value="down">Hangs down</option>
            </select>
            <span />
          </label>
          <label className="slider-row" title="The bone the chain hangs from">
            <span className="slider-label">Hangs from</span>
            <select className="select" value={opts.parentBoneName || ''} onChange={(e) => patch({ parentBoneName: e.target.value || null })} aria-label="Bone to attach to">
              <option value="">Automatic</option>
              {boneChoices.map((b) => <option key={b.name} value={b.name}>{b.label}</option>)}
            </select>
            <span />
          </label>
          <label className="morph-label" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }} title="By default, new rigs attach to the character's original skeleton. Enable this to intentionally attach one added rig to another.">
            <input
              type="checkbox"
              checked={!!opts.allowAddedBoneAttachment}
              onChange={(e) => patch({
                allowAddedBoneAttachment: e.target.checked,
                ...(!e.target.checked && generatedBoneNames.has(opts.parentBoneName) ? { parentBoneName: null } : {}),
              })}
            />
            Allow attachment to added bones
          </label>
          <label className="morph-label" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }} title="If the chain starts at the wrong end, swap it">
            <input type="checkbox" checked={opts.flip} disabled={opts.direction === 'down'} onChange={(e) => patch({ flip: e.target.checked })} />
            Start from the other end
          </label>
          <label className="morph-label" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }} title="Several separate pieces (hair cards) each get their own chain instead of sharing one chain across the selection">
            <input type="checkbox" checked={opts.perPiece} onChange={(e) => patch({ perPiece: e.target.checked })} />
            Each separate piece gets its own chain
          </label>
          <label className="morph-label" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={addPhysics} onChange={(e) => setAddPhysics(e.target.checked)} />
            Turn on swing physics for the new bones
          </label>
          <div className="kf-actions" style={{ marginTop: 6 }}>
            <button className="btn" onClick={editingId ? onUpdate : onAdd} disabled={!summary || !!summary.error}>
              {editingId ? 'Update bones' : '2. Add bones'}
            </button>
            {editingId && <button className="btn secondary" onClick={() => { setEditingId(null); setTrisByMesh({}) }}>Cancel</button>}
          </div>
        </>
      )}

      {visibleEntries.length > 0 && (
        <div className="obj-list" style={{ marginTop: 10 }}>
          {visibleEntries.map((e) => (
            <div key={e.id} className="obj-row">
              <div className="obj-row-main">
                <span className="obj-name">{e.label}</span>
                <span className="joint-parent"> {e.boneNames.length} bones · {(e.meshIndices || [e.meshIndex]).length} part{(e.meshIndices || [e.meshIndex]).length === 1 ? '' : 's'}</span>
              </div>
              <button className="btn secondary" onClick={() => onPhysics(e)} title="Add swing physics for this chain">Physics</button>
              <button className="btn secondary" onClick={() => onEdit(e)} title="Change this rig's name, bone count, and settings">Edit</button>
              <button className="btn secondary" onClick={() => onDelete(e)} title="Delete these bones">Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
