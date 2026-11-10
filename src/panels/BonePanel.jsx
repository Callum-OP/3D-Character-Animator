import { FxCollapse, FxEditor, FxIntro, FxSection, FxItem, FxItemActions, FxField, FxCheck, FxHelp, FxButtons, FxEmpty } from './FxCards.jsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store.js'
import {
  resetPose,
  resetBone,
  applyPose,
  getPose,
  getBoneEulerDelta,
  setBoneEulerDelta,
  beginBoneAdjust,
  endBoneAdjust,
  getBoneParentName,
  applyLimitsToPose,
} from '../three/posing.js'
import { downloadPose, readPoseFile } from '../three/poses.js'
import {
  setDangleEnabledUndoable as setDangleEnabled,
  addDangleChainUndoable as addDangleChain,
  removeDangleChainUndoable as removeDangleChain,
  groupDangleChainsByRig,
  updateDangleChainUndoable as updateDangleChain,
  updateDangleChainsUndoable as updateDangleChains,
  setAllDangleCollisionsUndoable as setAllDangleCollisions,
} from '../three/dangle.js'
import { collectActiveDangleDescendants, getCurrentModel, getPhysicsBoneNames, resetActiveDangle, setCameraToBones } from '../three/scene.js'
import { getPartRigEntries } from '../three/partRig.js'
import { clearAllDangleChainsAndBones } from '../three/copyEffects.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import EditableValue from './EditableValue.jsx'
import IkPinsSection from './IkPinsSection.jsx'
import FlattenerSection from './FlattenerSection.jsx'

const AXES = ['x', 'y', 'z']

// The settings for one dangle chain, or for a whole group of chains at once. With several chains a value that
// differs between them shows their average with a "~"; moving a slider or ticking a box sets it on every chain.
const pct = (v) => `${Math.round(v * 100)}%`
const DANGLE_SLIDERS = [
  { key: 'stiffness', label: 'Stiffness', def: 0.15, min: 0, max: 1, step: 0.01, hint: 'How strongly it springs back to the animated pose. Low = loose and floppy, high = barely moves.' },
  { key: 'gravity', label: 'Gravity', def: 1, min: 0, max: 3, step: 0.05, hint: 'How strongly gravity pulls it down' },
  { key: 'damping', label: 'Damping', def: 0.8, min: 0, max: 1, step: 0.01, hint: 'How long it keeps swinging before settling. Low = stops fast, high = keeps swaying.' },
]
const DANGLE_FEEL_SLIDERS = [
  { key: 'bounce', label: 'Bounce (up and down)', def: 1, min: 0, max: 2.5, step: 0.05, format: pct, hint: 'How freely it bobs up and down as the body moves. Less = held firmly, 100% = normal, more = loose and bouncy, like a hood on a run.' },
  { key: 'reaction', label: 'Body reaction', def: 0, min: 0, max: 1, step: 0.01, format: pct, hint: 'How much it is left behind when the whole body moves. 0 = it travels with the body (only turning swings it), 100% = it trails behind and gets thrown about.' },
  { key: 'swingLimit', label: 'Swing limit', def: 180, min: 5, max: 180, step: 1, format: (v) => `${Math.round(v)}°`, hint: 'The furthest each bone can swing away from the pose, in degrees. 180° = no limit.' },
  { key: 'holdTop', label: 'Rigid top', def: 0, min: 0, max: 0.8, step: 0.01, format: pct, hint: 'How much of the chain, from the top where it joins the body, stays locked to the pose. Only below this does it swing.' },
]

function DangleSettings({ chains, onPatch, name }) {
  const many = chains.length > 1
  const avg = (key, def) => chains.reduce((n, c) => n + (c[key] ?? def), 0) / chains.length
  const mixedOf = (key, def) => {
    const first = chains[0][key] ?? def
    return chains.some((c) => Math.abs((c[key] ?? def) - first) > 1e-6)
  }
  const allTrue = (key) => chains.every((c) => c[key] === true)
  const types = new Set(chains.map((c) => (c.type === 'cloth' ? 'cloth' : 'dangle')))
  const slider = ({ key, label, def, min, max, step, hint, format }) => {
    const mixed = many && mixedOf(key, def)
    const value = avg(key, def)
    const fmt = format || ((v) => v.toFixed(2))
    return (
      <label className="slider-row" key={key}>
        <span className="slider-label" title={hint}>{label}</span>
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onPatch({ [key]: Number(e.target.value) })} />
        <EditableValue
          value={value}
          min={min}
          max={max}
          onChange={(v) => onPatch({ [key]: v })}
          format={(v) => (mixed ? `~${fmt(v)}` : fmt(v))}
          label={label}
        />
      </label>
    )
  }
  const check = (key, text, title) => (
    <FxCheck checked={allTrue(key)} onChange={(v) => onPatch({ [key]: v })} title={many ? `${title} (applies to every chain in the group)` : title}>
      {text}
    </FxCheck>
  )
  return (
    <>
      <FxField label="Physics type">
        <select
          aria-label={`${name} physics type`}
          value={types.size > 1 ? 'mixed' : [...types][0]}
          onChange={(e) => {
            const type = e.target.value
            if (type === 'mixed') return
            onPatch({
              type,
              stiffness: type === 'cloth' ? 0.4 : 0.15,
              gravity: type === 'cloth' ? 0.35 : 1,
              damping: type === 'cloth' ? 0.55 : 0.8,
            })
          }}
        >
          {types.size > 1 && <option value="mixed" disabled>Mixed</option>}
          <option value="dangle">Dangle</option>
          <option value="cloth">Rigged cloth</option>
        </select>
      </FxField>

      {check('collideWithBones', 'Collide with other bones', "Keep this chain's bone tips away from nearby skeleton bones.")}
      {check('collideWithMesh', 'Collide with other meshes', 'Use visible model meshes as a lightweight barrier for this chain.')}
      {check('collideWithSelf', 'Collide with self', 'Use the lightweight collision proxy for mesh faces mainly weighted to dangle bones.')}

      {DANGLE_SLIDERS.map(slider)}
      <details className="fx-more">
        <summary>More feel settings</summary>
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>{DANGLE_FEEL_SLIDERS.map(slider)}</div>
      </details>
    </>
  )
}

// X/Y/Z rotation sliders for the selected joint, in degrees relative to the
// rest pose (0° = straight) — for people more at home with numbers and sliders
// than a 3D ring gizmo. Kept in sync with gizmo drags via poseVersion; while a
// slider is being dragged we own the euler state so quaternion→euler round
// trips can't make the other two sliders jump.
function JointRotation({ boneName, disabled }) {
  const poseVersion = useStore((s) => s.poseVersion)
  const [euler, setEuler] = useState(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    if (draggingRef.current) return
    setEuler(getBoneEulerDelta(boneName))
  }, [boneName, poseVersion])

  if (!euler) return null

  function apply(axis, v) {
    const next = { ...euler, [axis]: v }
    // A one-shot change (typed value, keyboard nudge) is its own undo entry;
    // pointer drags are bracketed by begin/end so the whole drag is one entry.
    const oneShot = !draggingRef.current
    if (oneShot) beginBoneAdjust(boneName)
    setBoneEulerDelta(boneName, next)
    if (oneShot) endBoneAdjust()
    setEuler(next)
  }

  function onDragStart() {
    if (disabled) return
    draggingRef.current = true
    beginBoneAdjust(boneName)
  }

  function onDragEnd() {
    if (!draggingRef.current) return
    draggingRef.current = false
    endBoneAdjust()
    setEuler(getBoneEulerDelta(boneName))
  }

  return (
    <>
      {AXES.map((axis) => (
        <label className="slider-row" key={axis}>
          <span className={`slider-label axis-label axis-${axis}`}>
            {axis.toUpperCase()} bend
          </span>
          <input
            type="range"
            min={-180}
            max={180}
            step={1}
            disabled={disabled}
            value={Math.round(euler[axis])}
            onPointerDown={onDragStart}
            onPointerUp={onDragEnd}
            onLostPointerCapture={onDragEnd}
            onChange={(e) => apply(axis, Number(e.target.value))}
          />
          <EditableValue
            value={euler[axis]}
            min={-180}
            max={180}
            disabled={disabled}
            onChange={(v) => apply(axis, v)}
            format={(v) => `${Math.round(v)}°`}
            label={`${axis.toUpperCase()} rotation (degrees from rest)`}
          />
        </label>
      ))}
    </>
  )
}

// Side-panel section: pick a bone to pose, and save/load/reset the pose.
// Selection is the store's job (viewport picks and this tree both write
// selectedBoneName); the gizmo attach happens in the Viewport effect.
export default function BonePanel() {
  const modelInfo = useStore((s) => s.modelInfo)
  const selectedBoneName = useStore((s) => s.selectedBoneName)
  const boneFilter = useStore((s) => s.boneFilter)
  const deformOnly = useStore((s) => s.deformOnly)
  const hideDangleBones = useStore((s) => s.hideDangleBones)
  const setHideDangleBones = useStore((s) => s.setHideDangleBones)
  const transformSpace = useStore((s) => s.transformSpace)
  const showBones = useStore((s) => s.showBones)
  const boneViewMode = useStore((s) => s.boneViewMode)
  const showAllPartHighlights = useStore((s) => s.showAllPartHighlights)
  const rotationSnap = useStore((s) => s.rotationSnap)
  const limbLimits = useStore((s) => s.limbLimits)
  const playback = useStore((s) => s.playback)

  const poseClipboard = useStore((s) => s.poseClipboard)
  const setSelectedBoneName = useStore((s) => s.setSelectedBoneName)
  const selectedBoneNames = useStore((s) => s.selectedBoneNames)
  const toggleBoneSelection = useStore((s) => s.toggleBoneSelection)
  const setBoneFilter = useStore((s) => s.setBoneFilter)
  const setDeformOnly = useStore((s) => s.setDeformOnly)
  const setTransformSpace = useStore((s) => s.setTransformSpace)
  const setShowBones = useStore((s) => s.setShowBones)
  const setBoneViewMode = useStore((s) => s.setBoneViewMode)
  const setShowAllPartHighlights = useStore((s) => s.setShowAllPartHighlights)
  const setRotationSnap = useStore((s) => s.setRotationSnap)
  const setLimbLimits = useStore((s) => s.setLimbLimits)
  const setPoseClipboard = useStore((s) => s.setPoseClipboard)

  const dangleEnabled = useStore((s) => s.dangleEnabled)
  const dangleChains = useStore((s) => s.dangleChains)
  const dangleChainSections = useMemo(
    () => groupDangleChainsByRig(dangleChains, getPartRigEntries(getCurrentModel())),
    [dangleChains, modelInfo],
  )
  const allDangleCollisionsEnabled = dangleChains.length > 0 && dangleChains.every((chain) =>
    chain.collideWithBones === true && chain.collideWithMesh === true && chain.collideWithSelf === true,
  )

  const fileInputRef = useRef(null)
  const [poseMsg, setPoseMsg] = useState(null)

  // Copy the current pose (e.g. from a scrubbed mocap frame) and paste it
  // elsewhere — onto another frame of your own animation, say.
  function onCopy() {
    setPoseClipboard(getPose())
    setPoseMsg('Pose copied.')
  }

  function onPaste() {
    if (!poseClipboard) return
    const { applied, missing } = applyPose(poseClipboard)
    setPoseMsg(`Pasted ${applied} bone(s)` + (missing.length ? `, ${missing.length} skipped.` : '.'))
  }

  // Turn whatever's currently selected (one or several bones) into a dangle
  // chain — the selected bone(s) plus everything hanging off them (a hair
  // strand's root sweeps up the whole strand, say). If several separate
  // bones are selected they all go into the one chain, so e.g. both bunches
  // of a pair of pigtails can swing under a single set of settings.
  function onAddDangleChain(type = 'dangle') {
    const roots = selectedBoneNames.length ? selectedBoneNames : selectedBoneName ? [selectedBoneName] : []
    if (!roots.length) return
    const boneNames = [...new Set(roots.flatMap((r) => collectActiveDangleDescendants(r)))]
    const name = roots.length === 1 ? roots[0] : `${roots.length} bones incl. ${roots[0]}`
    addDangleChain(name, boneNames, type)
  }

  // Preview of what "Add selected as dangle chain" would sweep in — one line
  // per currently-selected root bone: just its name if it's a leaf, or
  // "root > child1, child2, ..." if picking it also pulls in descendants.
  const dangleSelectionPreview = useMemo(() => {
    const roots = selectedBoneNames.length ? selectedBoneNames : selectedBoneName ? [selectedBoneName] : []
    return roots.map((r) => {
      const children = collectActiveDangleDescendants(r).filter((n) => n !== r)
      return children.length ? `${r} > ${children.join(', ')}` : r
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBoneNames, selectedBoneName, modelInfo])

  const bones = modelInfo?.bones || []
  // Offer the helper-bone toggle only when the rig actually has both kinds.
  const hasHelpers = bones.some((b) => b.deform) && bones.some((b) => !b.deform)

  // The selected joint's panel entry (+ its parent, for chain navigation).
  const selectedBone = selectedBoneName ? bones.find((b) => b.name === selectedBoneName) : null
  const parentName = selectedBone ? getBoneParentName(selectedBoneName) : null
  const parentBone = parentName ? bones.find((b) => b.name === parentName) : null
  // Posing steps aside whenever an animation source is armed (same rule the
  // gizmo follows), so the sliders can't fight the mixer.
  const posingLocked = playback !== 'stopped'

  if (!modelInfo) {
    return (
      <div className="panel">
        <h2>Pose</h2>
        <div className="empty">Load a model to pose its bones.</div>
      </div>
    )
  }

  if (bones.length === 0) {
    return (
      <div className="panel">
        <h2>Pose</h2>
        <div className="empty">This model has no bones/skeleton.</div>
      </div>
    )
  }

  const filter = boneFilter.trim().toLowerCase()
  const dangleBoneNames = hideDangleBones ? getPhysicsBoneNames(dangleChains) : new Set()
  const hidingDangle = hideDangleBones && boneViewMode === 'bones' && dangleBoneNames.size > 0
  const visibleBones = bones.filter((b) => {
    if (deformOnly && !b.deform) return false
    if (hidingDangle && dangleBoneNames.has(b.name)) return false
    if (
      filter &&
      !b.name.toLowerCase().includes(filter) &&
      !(b.label && b.label.toLowerCase().includes(filter))
    )
      return false
    return true
  })

  function onSave() {
    downloadPose(getPose(), modelInfo.name)
    setPoseMsg('Pose saved.')
  }

  function onPickFile(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = '' // allow re-loading the same file
    if (!file) return
    readPoseFile(file)
      .then((json) => {
        const { applied, missing } = applyPose(json)
        setPoseMsg(
          `Applied ${applied} bone(s)` +
            (missing.length ? `, skipped ${missing.length} not in this rig.` : '.'),
        )
      })
      .catch((err) => setPoseMsg(err.message || String(err)))
  }

  return (
    <div className="panel">
      <h2>Pose</h2>
      <p className="panel-hint">
        {boneViewMode === 'parts'
          ? 'Click a highlighted body part to select it, then use Rotate or Move to pose it.'
          : 'Click a dot on the character, then drag the coloured ring to bend that joint.'}
      </p>

      <FxCollapse title="Pose controls" hint={boneViewMode === 'parts' ? 'body parts' : 'joint controls'} defaultOpen>
      <div className="seg" style={{ marginTop: 4, marginBottom: 14 }} title="Bones: pick and bend individual joints. Body Parts: click a whole limb and move it — the joints needed adjust automatically.">
        <button
          className={'seg-btn' + (boneViewMode === 'bones' ? ' active' : '')}
          onClick={() => setBoneViewMode('bones')}
        >
          Bones
        </button>
        <button
          className={'seg-btn' + (boneViewMode === 'parts' ? ' active' : '')}
          onClick={() => setBoneViewMode('parts')}
        >
          Body Parts
        </button>
      </div>


      <div className="pose-actions">
        <button className="btn secondary" onClick={() => resetPose()} title="Straighten every joint back to the rest pose">
          Reset
        </button>
        <button className="btn secondary" onClick={() => performUndo(useStore.getState())} title="Undo the latest edit (Ctrl+Z)">
          Undo
        </button>
        <button className="btn secondary" onClick={() => performRedo(useStore.getState())} title="Redo the latest undone edit (Ctrl+Shift+Z)">
          Redo
        </button>
        <button className="btn secondary" onClick={onCopy} title="Copy the current pose">
          Copy
        </button>
        <button
          className="btn secondary"
          onClick={onPaste}
          disabled={!poseClipboard}
          title="Apply the copied pose"
        >
          Paste
        </button>
        <button className="btn secondary" onClick={onSave}>
          Save
        </button>
        <button className="btn secondary" onClick={() => fileInputRef.current?.click()}>
          Load
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={onPickFile}
        />
      </div>

      {poseMsg && <div className="pose-msg">{poseMsg}</div>}

      <div className="pose-toggles">
        <label className="toggle-row" style={{ padding: 0 }} title={boneViewMode === 'parts' ? 'Show the highlighted body-part regions on the character' : 'Show the joint dots on the character'}>
          <input
            type="checkbox"
            checked={showBones}
            onChange={(e) => setShowBones(e.target.checked)}
          />
          {boneViewMode === 'parts' ? 'Show body parts' : 'Show joints'}
        </label>
        {boneViewMode === 'parts' && (
          <label
            className="toggle-row"
            style={{ padding: 0 }}
            title="Faintly tint every body part all the time, instead of only on hover or when selected"
          >
            <input
              type="checkbox"
              checked={showAllPartHighlights}
              onChange={(e) => setShowAllPartHighlights(e.target.checked)}
            />
            Highlight all parts
          </label>
        )}
        <label
          className="toggle-row"
          style={{ padding: 0 }}
          title="Rotate in 15° steps for tidy, repeatable angles — hold Shift while dragging for the opposite behaviour"
        >
          <input
            type="checkbox"
            checked={rotationSnap}
            onChange={(e) => setRotationSnap(e.target.checked)}
          />
          Snap 15°
        </label>
        <label
          className="toggle-row"
          style={{ padding: 0 }}
          title="Keep joints inside natural human ranges while you pose — elbows and knees only bend the right way. Applies to new posing and the ragdoll; loaded poses and animations are left untouched."
        >
          <input
            type="checkbox"
            checked={limbLimits}
            onChange={(e) => setLimbLimits(e.target.checked)}
          />
          Limb limits
        </label>
        {boneViewMode === 'bones' && (dangleChains.length > 0 || getPartRigEntries(getCurrentModel()).length > 0) && (
          <label
            className="toggle-row"
            style={{ padding: 0 }}
            title="Hide the bones of dangle chains, rigged cloth and Add bones groups (hair, clothes, accessories) from the dots and the bone list"
          >
            <input
              type="checkbox"
              checked={hideDangleBones}
              onChange={(e) => setHideDangleBones(e.target.checked)}
            />
            Hide dangle & cloth bones
          </label>
        )}
        {hasHelpers && (
          <label
            className="toggle-row"
            style={{ padding: 0 }}
            title="Hide the rig's extra bones (bone tips, twist/volume correctives, sockets) and show only the ones you'd pose by hand"
          >
            <input
              type="checkbox"
              checked={deformOnly}
              onChange={(e) => setDeformOnly(e.target.checked)}
            />
            Hide helper bones
          </label>
        )}
      </div>

      {limbLimits && (
        <button
          className="btn secondary"
          style={{ width: '100%', marginTop: 6 }}
          onClick={() => {
            const n = applyLimitsToPose()
            setPoseMsg(
              n
                ? `Nudged ${n} joint(s) back into their natural range.`
                : 'The pose is already within the limits.',
            )
          }}
          title="Pull the current pose (e.g. a loaded pose or a mocap frame) back inside the natural joint ranges — undoable"
        >
          Apply limits to current pose
        </button>
      )}

      <div className="seg" style={{ marginTop: 8 }} title="Rotate the joint around its own axes (Local) or the world's (World)">
        <button
          className={'seg-btn' + (transformSpace === 'local' ? ' active' : '')}
          onClick={() => setTransformSpace('local')}
        >
          Local
        </button>
        <button
          className={'seg-btn' + (transformSpace === 'world' ? ' active' : '')}
          onClick={() => setTransformSpace('world')}
        >
          World
        </button>
      </div>

      {selectedBone && (
        <div className={'joint-controls' + (posingLocked ? ' disabled' : '')}>
          <div className="joint-header">
            <span className="joint-name" title={selectedBone.name}>
              {selectedBone.label || selectedBone.name}
            </span>
            {parentBone && (
              <button
                className="joint-parent"
                title={`Select the parent joint (${parentBone.name})`}
                onClick={() => setSelectedBoneName(parentBone.name)}
              >
                ↑ {parentBone.label || parentBone.name}
              </button>
            )}
          </div>
          {posingLocked ? (
            <div className="joint-locked">Press Stop to pose while an animation is loaded.</div>
          ) : (
            <>
              <JointRotation boneName={selectedBoneName} disabled={posingLocked} />
              <button
                className="btn secondary"
                style={{ width: '100%', marginTop: 4 }}
                onClick={() => resetBone(selectedBoneName)}
                title="Straighten only this joint back to its rest rotation"
              >
                Straighten this joint
              </button>
            </>
          )}
        </div>
      )}

      </FxCollapse>

      <FxCollapse title="Bones" hint={`${visibleBones.length} joints`} defaultOpen>
      <input
        className="bone-filter"
        type="text"
        placeholder="Search joints…"
        value={boneFilter}
        onChange={(e) => setBoneFilter(e.target.value)}
      />

      {visibleBones.length < bones.length && (
        <div className="bone-count">
          Showing {visibleBones.length} of {bones.length} joints
        </div>
      )}

      <div className="bone-tree">
        {visibleBones.length === 0 && <div className="empty">No matching bones.</div>}
        {visibleBones.map((b) => {
          const multiSelected = selectedBoneNames.length > 1
          return (
            <div
              key={b.name}
              className={
                'bone-row' +
                (selectedBoneNames.includes(b.name) ? ' selected' : '') +
                (multiSelected && b.name === selectedBoneName ? ' bone-row-primary' : '')
              }
              style={{ paddingLeft: 6 + b.depth * 12 }}
              title={multiSelected ? b.name : b.name + ' (Shift/Ctrl-click to select more)'}
              onClick={(e) => {
                const additive = e.shiftKey || e.ctrlKey || e.metaKey
                if (!additive && selectedBoneNames.length <= 1) {
                  // Plain click, nothing already multi-selected: keep the old
                  // "click again to deselect" toggle behaviour.
                  setSelectedBoneName(b.name === selectedBoneName ? null : b.name)
                } else {
                  toggleBoneSelection(b.name, additive)
                }
              }}
            >
              {b.label || b.name}
            </div>
          )
        })}
      </div>

      {selectedBoneNames.length > 0 && (
        <div className="kf-actions" style={{ marginTop: 6 }}>
          <button
            className="btn secondary"
            onClick={() => setCameraToBones(selectedBoneNames)}
            title="Frame the selected joint in the viewport and orbit around it (F)"
          >
            {selectedBoneNames.length > 1 ? 'Set camera to joints' : 'Set camera to joint'}
          </button>
        </div>
      )}

      {selectedBoneNames.length > 1 && (
        <div className="bone-count" title="Rotate turns every selected joint by the same amount; Move drags them all by the same offset">
          {selectedBoneNames.length} joints selected — drag the gizmo to rotate or move them together
        </div>
      )}
      </FxCollapse>

      <FxCollapse title="Bone physics" hint={dangleChains.length ? `${dangleChains.length} chain${dangleChains.length === 1 ? '' : 's'}` : 'swing and drape'}>
      <FxEditor style={{ marginTop: 0 }} aria-label="Bone physics">
        <FxIntro eyebrow="BONE PHYSICS" title="Make bones swing and drape" note="Runs during playback · paused or scrubbed frames show the clean pose">
          Select a bone above, then add a chain. Dangle suits hair, ties and accessories; rigged cloth suits bone-weighted
          capes, sleeves and loose clothing. Each chain can optionally collide with the model or other bones.
        </FxIntro>

        <div className="fx-effects fx-toggle">
          <FxCheck checked={dangleEnabled} onChange={setDangleEnabled} title="Switch every bone physics chain on or off">
            Enable bone physics
          </FxCheck>
        </div>

        {dangleChains.length > 0 && (
          <FxSection
            step="STEP 1"
            title="Chains on this character"
            count={dangleChains.length}
            countLabel={`${dangleChains.length} chains`}
            label="Bone physics chains"
            actions={
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
                <button
                  className="btn secondary"
                  aria-pressed={allDangleCollisionsEnabled}
                  onClick={() => setAllDangleCollisions(!allDangleCollisionsEnabled)}
                  title="Toggle all three collision settings on every chain"
                >
                  {allDangleCollisionsEnabled ? 'Disable all collisions' : 'Enable all collisions'}
                </button>
                <button
                  className="btn secondary"
                  onClick={() => clearAllDangleChainsAndBones()}
                  title="Remove every dangle and rigged-cloth chain, along with the Add bones rigs they swing. Ctrl+Z restores them."
                >
                  Clear all dangle chains
                </button>
              </div>
            }
          >
            {dangleChainSections.map((section) => {
              const items = section.chains.map((chain) => (
              <FxItem
                key={chain.id}
                title={chain.name}
                tone={chain.type === 'cloth' ? 'swing' : undefined}
                pills={[chain.type === 'cloth' ? 'Rigged cloth' : 'Dangle', `${chain.boneNames.length} bone${chain.boneNames.length === 1 ? '' : 's'}`]}
              >
                <FxItemActions>
                  <button className="btn secondary" onClick={() => resetActiveDangle(chain.id)} title="Snap this chain back onto the current pose">
                    Reset
                  </button>
                  <button className="btn secondary" onClick={() => removeDangleChain(chain.id)} title="Remove this chain" aria-label="Remove this chain">
                    ×
                  </button>
                </FxItemActions>

                <details className="fx-more">
                  <summary>{chain.boneNames.length} bone{chain.boneNames.length === 1 ? '' : 's'} — view list</summary>
                  <ul className="fx-list">
                    {chain.boneNames.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </details>

                <DangleSettings chains={[chain]} name={chain.name} onPatch={(patch) => updateDangleChain(chain.id, patch)} />
              </FxItem>
              ))
              if (!section.groupId) return items
              return (
                <details className="fx-more" key={section.id}>
                  <summary>{section.name} · {section.chains.length} chain{section.chains.length === 1 ? '' : 's'}</summary>
                  <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                    <FxItem title={`All of ${section.name}`} pills={[`${section.chains.length} chain${section.chains.length === 1 ? '' : 's'}`, 'group settings']}>
                      <FxHelp>Changes here apply to every chain in this group. A “~” means the chains currently differ.</FxHelp>
                      <FxItemActions>
                        <button className="btn secondary" onClick={() => section.chains.forEach((c) => resetActiveDangle(c.id))} title="Snap every chain in this group back onto the current pose">
                          Reset all
                        </button>
                      </FxItemActions>
                      <DangleSettings
                        chains={section.chains}
                        name={section.name}
                        onPatch={(patch) => updateDangleChains(section.chains.map((c) => c.id), patch)}
                      />
                    </FxItem>
                    {items}
                  </div>
                </details>
              )
            })}
          </FxSection>
        )}

        <FxSection step={dangleChains.length > 0 ? 'STEP 2' : 'STEP 1'} title="Add a chain" label="Add a bone physics chain">
          <FxHelp>
            {selectedBoneNames.length || selectedBoneName
              ? `${selectedBoneNames.length || 1} bone${(selectedBoneNames.length || 1) === 1 ? '' : 's'} selected. Their child bones join the chain.`
              : 'Select one or more bones in the list above (or click their dots), then add them as a chain.'}
          </FxHelp>
          <FxButtons>
            <button
              className="btn secondary"
              onClick={() => onAddDangleChain('dangle')}
              disabled={!selectedBoneNames.length && !selectedBoneName}
              title="Add the selected bone(s) and their children as a swinging dangle chain"
            >
              Add selected as dangle
            </button>
            <button
              className="btn secondary"
              onClick={() => onAddDangleChain('cloth')}
              disabled={!selectedBoneNames.length && !selectedBoneName}
              title="Add the selected bone(s) and their children as a softer rigged-cloth chain"
            >
              Add selected as rigged cloth
            </button>
          </FxButtons>

          {dangleSelectionPreview.length > 0 && (
            <details className="fx-more">
              <summary>
                Preview: {dangleSelectionPreview.length} selected bone{dangleSelectionPreview.length === 1 ? '' : 's'}
              </summary>
              <ul className="fx-list">
                {dangleSelectionPreview.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </details>
          )}

          {dangleChains.length === 0 && <FxEmpty>No bone physics chains yet — select a bone above and add one.</FxEmpty>}
        </FxSection>
      </FxEditor>
      </FxCollapse>

      <IkPinsSection />

      <FlattenerSection />

      <div className="pose-hint">
        {boneViewMode === 'parts'
          ? 'Click a highlighted body part to select it, then use the Rotate/Move toggle and drag the gizmo. Esc deselects · Ctrl+Z undoes · Ctrl+Shift+Z redoes. Switch to "Bones" for fine per-joint control.'
          : 'Click a bone dot or a name to select, then drag the ring gizmo or the X/Y/Z sliders to bend it. Shift/Ctrl-click another bone (dot or name) to rotate or move several joints together. Esc deselects · Ctrl+Z undoes · Ctrl+Shift+Z redoes · hold Shift while dragging the gizmo to snap.'}
      </div>
    </div>
  )
}