import { FxEditor, FxIntro, FxSection, FxItem, FxItemActions, FxField, FxCheck, FxHelp, FxButtons, FxFooter, FxPicking } from './FxCards.jsx'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { getCurrentModel } from '../three/scene.js'
import { setFacePickHandler } from '../three/meshedit.js'
import CopyFromMesh from './CopyFromMesh.jsx'
import { editPartRigDraft, getPartRigDraft, resetPartRigDraft, subscribePartRigDraft } from '../three/partRigDraft.js'
import { addDangleChainUndoable, collectDescendantBoneNames, getDangleChainsForRig, regroupRigChainsUndoable, removeDangleChainUndoable } from '../three/dangle.js'
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
  fromRanges, uniqueRigLabel } from '../three/partRig.js'

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
  { id: 'piece', label: 'Whole piece', hint: 'Click once: selects the whole connected piece (a hair card, a cape, a sleeve…). Click it again to deselect it.' },
  { id: 'brush', label: 'Brush', hint: 'Click to paint a patch on the surface — for a hood or cape that is joined to the rest of the mesh. Click again to add more; click a selected patch to remove it.' },
  { id: 'color', label: 'Same colour', hint: 'Selects the connected faces that keep the colour you clicked (hair against skin). Click a selected area again to remove it.' },
  { id: 'face', label: 'Single face', hint: 'One face at a time, for fine tuning. Click a selected face again to remove it.' },
]

export default function PartRigSection({ meshUuid, meshUuids, resolveMesh }) {
  const modelInfo = useStore((s) => s.modelInfo)
  const [mode, setMode] = useState('piece')
  const [brushPct, setBrushPct] = useState(6)
  const [tolerance, setTolerance] = useState(0.25)
  // The picked faces live in partRigDraft.js so every change to them is an undo / redo step.
  const trisByMesh = useSyncExternalStore(subscribePartRigDraft, getPartRigDraft)
  const [copyPhysics, setCopyPhysics] = useState(null) // physics settings carried over by Duplicate
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
  const editingEntry = entries.find((entry) => entry.id === editingId && entry.result) || null
  const inputSelectionKey = (meshUuids?.length ? meshUuids : [meshUuid]).join('|')
  const requestedUuids = editingEntry
    ? (editingEntry.result.meshes || [editingEntry.result]).map((item) => item?.mesh?.uuid).filter(Boolean)
    : (meshUuids?.length ? meshUuids : [meshUuid])
  const selectionKey = requestedUuids.join('|')
  const meshes = requestedUuids.map((uuid) => resolveMesh(uuid)).filter(Boolean)
  const mesh = meshes.find((item) => item.uuid === meshUuid) || meshes[0]
  const capable = meshes.length > 0 && meshes.every(isRigCapable)
  const tris = meshes.flatMap((item) => trisByMesh[item.uuid] || [])
  const selections = meshes.map((item) => ({ mesh: item, tris: trisByMesh[item.uuid] || [] }))
  const ref = useRef({})
  ref.current = { meshes, mode, brushPct, tolerance, model }

  // another part: drop the half-made selection
  useEffect(() => {
    resetPartRigDraft()
    setCopyPhysics(null)
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
      // Clicking an area that is already selected takes it out again; clicking anywhere else adds to the selection.
      const removing = (getPartRigDraft()[hit.uuid] || []).includes(hit.faceIndex)
      setMessage(removing ? 'Removed that area. Click it again to add it back.' : '')
      editPartRigDraft((current) => {
        const cur = current[hit.uuid] || []
        if (removing) {
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
    if (!entry.result) return false
    const targetMeshes = (entry.result.meshes || [entry.result]).map((item) => item?.mesh).filter(Boolean)
    return targetMeshes.some((item) => meshes.includes(item))
  })

  function choosePreset(id) {
    const p = PRESETS.find((x) => x.id === id)
    setPresetId(id)
    setCopyPhysics(null)
    setLabel(p.name)
    patch(p.o)
  }

  function onAdd() {
    const res = applyPartRig(model, meshes, selections, opts, { label: uniqueRigLabel(model, label) })
    if (!res.ok) return setMessage(res.reason)
    const { entry } = res
    if (addPhysics) {
      entry.rootBoneNames.forEach((root, i) => {
        addDangleChainUndoable(
          entry.rootBoneNames.length > 1 ? `${entry.label} ${i + 1}` : entry.label,
          collectDescendantBoneNames(model, root, 64),
          'dangle',
          { id: entry.id, name: entry.label },
          copyPhysics,
        )
      })
    }
    resetPartRigDraft()
    setCopyPhysics(null)
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
    resetPartRigDraft(Object.fromEntries(targetMeshes.map((item, i) => [item.uuid, fromRanges(savedRanges[i] || [])])))
    setCopyPhysics(null)
    setPicking(false)
    setMessage(`Editing ${entry.label}. Change the settings, then update the bones.`)
  }

  // Start a NEW rig with this one's name, bone settings and physics, ready to pick its own faces — e.g. the same
  // hair setup on another part of the same mesh. Nothing is built until Add bones, so the original keeps its bones.
  function onDuplicate(entry) {
    const usesAddedParent = (entry.parentNames || []).some((name) => generatedBoneNames.has(name))
    const source = getDangleChainsForRig(useStore.getState().dangleChains, entry, entries)[0]
    let physics = null
    if (source) {
      // eslint-disable-next-line no-unused-vars
      const { id, name, boneNames, groupId, groupName, ...settings } = source
      physics = settings
    }
    setEditingId(null)
    setLabel(uniqueRigLabel(model, entry.label))
    setOpts({ ...PRESETS[0].o, influence: 1, includeNearbySurfaces: false, nearbySurfaceDistance: 0.02, ...entry.options, allowAddedBoneAttachment: entry.options.allowAddedBoneAttachment || usesAddedParent })
    setAddPhysics(!!source)
    setCopyPhysics(physics)
    resetPartRigDraft()
    setPicking(true)
    setMessage(`Copied ${entry.label}'s settings. Click the new area on the mesh, then press Add bones.`)
  }

  function onUpdate() {
    const before = { id: editingEntry.id, label: editingEntry.label, boneNames: editingEntry.boneNames, rootBoneNames: editingEntry.rootBoneNames }
    const chainsToGroup = getDangleChainsForRig(useStore.getState().dangleChains, editingEntry, entries)
      .map((chain) => chain.id)
    const result = updatePartRig(model, editingId, { label: uniqueRigLabel(model, label, editingId), options: opts })
    if (!result.ok) return setMessage(result.reason)
    // Only this rig's own chains move into the renamed group, and they follow the rebuilt bones.
    regroupRigChainsUndoable(
      chainsToGroup,
      { id: result.entry.id, name: result.entry.label },
      before,
      result.entry,
      (root) => collectDescendantBoneNames(model, root, 64),
    )
    setEditingId(null)
    resetPartRigDraft()
    setVersion((v) => v + 1)
    setMessage(`Updated ${result.entry.boneNames.length} bones. Ctrl+Z undoes it.`)
  }

  function onDelete(entry) {
    const dependents = getPartRigDependents(model, entry.id)
    if (dependents.length) return setMessage(`Cannot delete ${entry.label}: ${dependents.map((item) => item.label).join(', ')} ${dependents.length === 1 ? 'is' : 'are'} attached to its bones. Delete those rigs first.`)
    if (!entry.result) return setMessage('That bone rig is no longer available.')
    const rigChains = getDangleChainsForRig(useStore.getState().dangleChains, entry, entries)
    rigChains.forEach((chain) => removeDangleChainUndoable(chain.id))
    if (!removePartRig(model, entry.id)) return setMessage('That bone rig is no longer available.')
    if (editingId === entry.id) setEditingId(null)
    setVersion((v) => v + 1)
    setMessage(`Removed ${entry.label}'s bones. Ctrl+Z restores them.`)
  }

  const modeHint = MODES.find((m) => m.id === mode)?.hint

  const partCount = selections.filter((selection) => selection.tris.length).length
  const sliderRow = (label, title, min, max, value, onChange, shown, step) => (
    <label className="slider-row" title={title}>
      <span className="slider-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-value">{shown}</span>
    </label>
  )

  return (
    <FxEditor>
      <FxIntro eyebrow="RIGGING" title="Add bones to hair, hoods and capes" note="The bones show up in Pose mode · Ctrl+Z undoes">
        Pick faces on one or more parts. With multiple parts selected, one shared chain extends across them by default.
      </FxIntro>

      {visibleEntries.length > 0 && (
        <FxSection step="ADDED" title="Bones added to these parts" count={visibleEntries.length} countLabel={`${visibleEntries.length} rigs`} label="Added bone rigs">
          {visibleEntries.map((e) => {
            const partTotal = (e.meshIndices || [e.meshIndex]).length
            return (
              <FxItem key={e.id} title={e.label} pills={[`${e.boneNames.length} bones`, `${partTotal} part${partTotal === 1 ? '' : 's'}`]}>
                <FxItemActions>
                  <button className="btn secondary" onClick={() => onDuplicate(e)} title="Start a new rig with this one's settings, then pick a different area for it">Duplicate</button>
                  <button className="btn secondary" onClick={() => onEdit(e)} title="Change this rig's name, bone count, and settings">Edit</button>
                  <button className="btn secondary" onClick={() => onDelete(e)} title="Delete these bones">Delete</button>
                </FxItemActions>
              </FxItem>
            )
          })}
        </FxSection>
      )}

      {!editingId && <CopyFromMesh kind="bones" targetMesh={mesh} />}

      <FxSection step={editingId ? 'EDIT' : 'STEP 1'} title={editingId ? 'Adjust the selected rig' : 'Pick the faces'} label="Pick faces">
        {!editingId && (
          <>
            <FxButtons columns={2}>
              {PRESETS.map((p) => (
                <button key={p.id} className={`btn ${presetId === p.id ? '' : 'secondary'}`} title={p.hint} onClick={() => choosePreset(p.id)}>
                  {p.label}
                </button>
              ))}
            </FxButtons>
            <FxHelp>{PRESETS.find((p) => p.id === presetId)?.hint}</FxHelp>
          </>
        )}

        <FxButtons wide>
          <button className={`btn fx-btn-main ${picking ? '' : 'secondary'}`} onClick={() => { setPicking((v) => !v); setMessage('') }}>
            {picking ? 'Picking: click the part…' : 'Pick faces'}
          </button>
          <button className="btn secondary" disabled={!tris.length} onClick={() => editPartRigDraft(() => ({}))} title="Forget every picked face (Ctrl+Z brings them back)">Clear</button>
        </FxButtons>
        <FxButtons wide>
          <button className="btn secondary" disabled={!trisByMesh[mesh.uuid]?.length} onClick={() => editPartRigDraft((current) => ({ ...current, [mesh.uuid]: resizeSelection(mesh, current[mesh.uuid] || [], 1) }))} title="Add one ring of faces around the primary part's selection">Grow</button>
          <button className="btn secondary" disabled={!trisByMesh[mesh.uuid]?.length} onClick={() => editPartRigDraft((current) => ({ ...current, [mesh.uuid]: resizeSelection(mesh, current[mesh.uuid] || [], -1) }))} title="Take one ring of faces off the primary part's selection">Shrink</button>
        </FxButtons>

        {picking && (
          <FxPicking>
            <FxHelp>{modeHint}</FxHelp>
            <FxField label="Select" title={modeHint}>
              <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="How a click picks faces">
                {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </FxField>
            {mode === 'brush' && sliderRow('Brush', "Brush size as a share of the character's height", 1, 40, brushPct, setBrushPct, `${brushPct}%`, 1)}
            {mode === 'color' && sliderRow('Tolerance', 'How far a colour may drift from the one you clicked', 0, 1, tolerance, setTolerance, `${Math.round(tolerance * 100)}%`, 0.01)}
          </FxPicking>
        )}
        {message && <FxHelp>{message}</FxHelp>}

        <FxHelp>
          {tris.length
            ? `${tris.length} face${tris.length === 1 ? '' : 's'} selected across ${partCount} part${partCount === 1 ? '' : 's'} (pink).` +
              (summary && !summary.error ? ` ${summary.bones} bone${summary.bones === 1 ? '' : 's'} on ${summary.pieces} chain group${summary.pieces === 1 ? '' : 's'}, hanging from “${summary.parent}” (blue).` : '') +
              (summary && summary.error ? ` ${summary.error}` : '')
            : 'Nothing picked yet. Press Pick faces, then click the part in the viewport.'}
        </FxHelp>
      </FxSection>

      {tris.length > 0 && (
        <FxSection step={editingId ? 'EDIT' : 'STEP 2'} title="Shape the chain" label="Chain settings">
          <FxField label="Name" title="Used to name the new bones">
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Name for the new bones" />
          </FxField>
          {sliderRow('Bones', 'Bones in each chain: more bones bend smoother', 1, 12, opts.segments, (v) => patch({ segments: v }), opts.segments, 1)}
          {sliderRow('Chains', 'Chains side by side: a cape needs several, a strand needs one', 1, 8, opts.columns, (v) => patch({ columns: v }), opts.columns, 1)}
          {sliderRow('Top stays', 'How much of the top keeps the body\'s own movement, so it stays attached', 0, 60, Math.round(opts.stick * 100), (v) => patch({ stick: v / 100 }), `${Math.round(opts.stick * 100)}%`, 1)}
          {sliderRow('Bone influence', 'How much the new bones affect the selected surface; lower values blend more of the original skinning back in', 0, 100, Math.round(opts.influence * 100), (v) => patch({ influence: v / 100 }), `${Math.round(opts.influence * 100)}%`, 1)}
          <FxCheck checked={opts.includeNearbySurfaces} onChange={(v) => patch({ includeNearbySurfaces: v })} title="Also rig disconnected mesh layers close to the picked surface, such as the inside of a jacket.">
            Include nearby surfaces
          </FxCheck>
          {opts.includeNearbySurfaces &&
            sliderRow('Surface range', 'Maximum distance to the picked surface, as a share of the selected mesh bounds', 0.5, 10, Math.round(opts.nearbySurfaceDistance * 1000) / 10, (v) => patch({ nearbySurfaceDistance: v / 100 }), `${Math.round(opts.nearbySurfaceDistance * 1000) / 10}%`, 0.5)}
          <FxField label="Direction" title="Which way the chain runs">
            <select value={opts.direction} onChange={(e) => patch({ direction: e.target.value })} aria-label="Chain direction">
              <option value="shape">Follow the shape</option>
              <option value="down">Hangs down</option>
            </select>
          </FxField>
          <FxField label="Hangs from" title="The bone the chain hangs from">
            <select value={opts.parentBoneName || ''} onChange={(e) => patch({ parentBoneName: e.target.value || null })} aria-label="Bone to attach to">
              <option value="">Automatic</option>
              {boneChoices.map((b) => <option key={b.name} value={b.name}>{b.label}</option>)}
            </select>
          </FxField>
          <FxCheck
            checked={!!opts.allowAddedBoneAttachment}
            onChange={(v) => patch({
              allowAddedBoneAttachment: v,
              ...(!v && generatedBoneNames.has(opts.parentBoneName) ? { parentBoneName: null } : {}),
            })}
            title="By default, new rigs attach to the character's original skeleton. Enable this to intentionally attach one added rig to another."
          >
            Allow attachment to added bones
          </FxCheck>
          <FxCheck checked={opts.flip} disabled={opts.direction === 'down'} onChange={(v) => patch({ flip: v })} title="If the chain starts at the wrong end, swap it">
            Start from the other end
          </FxCheck>
          <FxCheck checked={opts.perPiece} onChange={(v) => patch({ perPiece: v })} title="Several separate pieces (hair cards) each get their own chain instead of sharing one chain across the selection">
            Each separate piece gets its own chain
          </FxCheck>
          <FxCheck checked={addPhysics} onChange={setAddPhysics}>Turn on swing physics for the new bones</FxCheck>
          <FxFooter>
            <button className="btn fx-btn-main" onClick={editingId ? onUpdate : onAdd} disabled={!summary || !!summary.error}>
              {editingId ? 'Update bones' : 'Add bones'}
            </button>
            {editingId && <button className="btn secondary" onClick={() => { setEditingId(null); resetPartRigDraft() }}>Cancel</button>}
          </FxFooter>
        </FxSection>
      )}
    </FxEditor>
  )
}
