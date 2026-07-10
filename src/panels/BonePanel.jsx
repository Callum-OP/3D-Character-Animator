import { useRef, useState } from 'react'
import { useStore } from '../store.js'
import { resetPose, applyPose, getPose, undo } from '../three/posing.js'
import { downloadPose, readPoseFile } from '../three/poses.js'

// Side-panel section: pick a bone to pose, and save/load/reset the pose.
// Selection is the store's job (viewport picks and this tree both write
// selectedBoneName); the gizmo attach happens in the Viewport effect.
export default function BonePanel() {
  const modelInfo = useStore((s) => s.modelInfo)
  const selectedBoneName = useStore((s) => s.selectedBoneName)
  const boneFilter = useStore((s) => s.boneFilter)
  const deformOnly = useStore((s) => s.deformOnly)
  const transformSpace = useStore((s) => s.transformSpace)
  const showBones = useStore((s) => s.showBones)

  const setSelectedBoneName = useStore((s) => s.setSelectedBoneName)
  const setBoneFilter = useStore((s) => s.setBoneFilter)
  const setDeformOnly = useStore((s) => s.setDeformOnly)
  const setTransformSpace = useStore((s) => s.setTransformSpace)
  const setShowBones = useStore((s) => s.setShowBones)

  const fileInputRef = useRef(null)
  const [poseMsg, setPoseMsg] = useState(null)

  const bones = modelInfo?.bones || []
  const hasDeform = bones.some((b) => b.deform)

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
  const visibleBones = bones.filter((b) => {
    if (deformOnly && !b.deform) return false
    if (filter && !b.name.toLowerCase().includes(filter)) return false
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

      <div className="pose-actions">
        <button className="btn secondary" onClick={() => resetPose()}>
          Reset
        </button>
        <button className="btn secondary" onClick={() => undo()}>
          Undo
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
        <label className="toggle-row" style={{ padding: 0 }}>
          <input
            type="checkbox"
            checked={showBones}
            onChange={(e) => setShowBones(e.target.checked)}
          />
          Show bones
        </label>
        {hasDeform && (
          <label className="toggle-row" style={{ padding: 0 }}>
            <input
              type="checkbox"
              checked={deformOnly}
              onChange={(e) => setDeformOnly(e.target.checked)}
            />
            Deform only
          </label>
        )}
      </div>

      <div className="seg" style={{ marginTop: 8 }}>
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

      <input
        className="bone-filter"
        type="text"
        placeholder="Filter bones…"
        value={boneFilter}
        onChange={(e) => setBoneFilter(e.target.value)}
      />

      <div className="bone-tree">
        {visibleBones.length === 0 && <div className="empty">No matching bones.</div>}
        {visibleBones.map((b) => (
          <div
            key={b.name}
            className={'bone-row' + (b.name === selectedBoneName ? ' selected' : '')}
            style={{ paddingLeft: 6 + b.depth * 12 }}
            title={b.name}
            onClick={() =>
              setSelectedBoneName(b.name === selectedBoneName ? null : b.name)
            }
          >
            {b.name}
          </div>
        ))}
      </div>

      <div className="pose-hint">
        Click a bone dot or a name to select, drag the ring gizmo to rotate.
        Esc deselects · Ctrl+Z undoes.
      </div>
    </div>
  )
}
