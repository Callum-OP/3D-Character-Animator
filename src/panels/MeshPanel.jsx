import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store.js'
import {
  getMeshDelta,
  setMeshDelta,
  getMeshKeyValue,
  resetMesh,
  resetAllMeshes,
  undo,
  redo,
  getLinkedMorphTargets,
  getMeshIndex,
} from '../three/meshedit.js'
import { getCurrentModel, requestRender } from '../three/scene.js'
import EditableValue from './EditableValue.jsx'

// Side-panel section for Mesh mode: pick a part of the character (eyes, hair,
// clothing…) and move, rotate or resize it. Click a part in the viewport or in
// the list below; values are offsets from where the part started, so 0 / 0° /
// 1× always means "untouched".
const MODES = [
  { value: 'translate', label: 'Move', title: 'Drag arrows to move the part (W)' },
  { value: 'rotate', label: 'Rotate', title: 'Drag rings to turn the part (E)' },
  { value: 'scale', label: 'Resize', title: 'Drag handles to resize the part (R)' },
]

const AXES = ['X', 'Y', 'Z']

export default function MeshPanel() {
  const modelInfo = useStore((s) => s.modelInfo)
  const selectedMeshUuid = useStore((s) => s.selectedMeshUuid)
  const setSelectedMeshUuid = useStore((s) => s.setSelectedMeshUuid)
  const meshGizmoMode = useStore((s) => s.meshGizmoMode)
  const setMeshGizmoMode = useStore((s) => s.setMeshGizmoMode)
  const meshOverrides = useStore((s) => s.meshOverrides)
  const setMeshVisible = useStore((s) => s.setMeshVisible)
  const linkedShapeKeys = useStore((s) => s.linkedShapeKeys)
  const setLinkedShapeKeys = useStore((s) => s.setLinkedShapeKeys)
  const animData = useStore((s) => s.animData)
  const animFps = useStore((s) => s.animFps)
  const insertTime = useStore((s) => s.insertTime)
  const st = useStore.getState
  useStore((s) => s.meshVersion) // re-render on every mesh edit (gizmo drag, undo…)
  const [, setMorphVersion] = useState(0)
  const [morphEntries, setMorphEntries] = useState([])
  const [morphValues, setMorphValues] = useState({})

  const currentModel = getCurrentModel()
  const meshes = modelInfo?.meshes || []
  const selectedMeta = meshes.find((mesh) => mesh.uuid === selectedMeshUuid) || null
  const selectedMesh = selectedMeta
    ? currentModel?.meshes?.find((mesh) => mesh.uuid === selectedMeta.uuid) || null
    : null
  const selectedIndex = selectedMeta ? meshes.indexOf(selectedMeta) : -1
  const delta = selectedMesh ? getMeshDelta(selectedMesh.uuid) : null
  const keyCount = selectedIndex >= 0 ? (animData.meshes?.[selectedIndex] || []).length : 0
  const snap = (t) => Math.round(t * animFps) / animFps

  function forceRerender() {
    setMorphVersion((v) => v + 1)
  }

  function onKeyPart() {
    if (selectedIndex < 0 || !selectedMesh) return
    const key = getMeshKeyValue(selectedMesh.uuid)
    if (!key) return
    const t = snap(insertTime)
    st().addMeshKeyframe(selectedIndex, t, key)
  }

  useEffect(() => {
    if (!selectedMesh || !selectedMesh.morphTargetInfluences) {
      setMorphEntries([])
      setMorphValues({})
      return
    }

    const dictionary = selectedMesh.morphTargetDictionary || {}
    const namesByIndex = new Map(
      Object.entries(dictionary).map(([name, idx]) => [Number(idx), name]),
    )
    const positionMorphs = selectedMesh.geometry?.morphAttributes?.position || []
    const entries = Array.from(selectedMesh.morphTargetInfluences, (_, idx) => ({
      idx,
      name:
        namesByIndex.get(idx) ||
        positionMorphs[idx]?.name ||
        `Shape key ${idx + 1}`,
    }))
    setMorphEntries(entries)

    const values = {}
    for (let i = 0; i < selectedMesh.morphTargetInfluences.length; i += 1) {
      values[i] = selectedMesh.morphTargetInfluences[i]
    }
    setMorphValues(values)
  }, [
    selectedMesh?.uuid,
    selectedMesh?.morphTargetInfluences?.length,
    selectedMesh?.morphTargetDictionary,
    selectedMesh?.geometry?.morphAttributes?.position?.length,
  ])

  if (!modelInfo) {
    return (
      <div className="panel">
        <h2>Parts</h2>
        <div className="empty">Load a character to edit its parts.</div>
      </div>
    )
  }

  return (
    <div className="panel">
      <h2>Parts</h2>
      <p className="panel-hint">
        Click a part of the character (eyes, hair, clothing…) then drag the gizmo
        to move, rotate or resize just that piece.
      </p>

      <div className="seg" title="What the gizmo does when you drag it">
        {MODES.map((mo) => (
          <button
            key={mo.value}
            className={'seg-btn' + (meshGizmoMode === mo.value ? ' active' : '')}
            title={mo.title}
            onClick={() => setMeshGizmoMode(mo.value)}
          >
            {mo.label}
          </button>
        ))}
      </div>

      <div className="kf-actions" style={{ marginTop: 8 }}>
        <button className="btn secondary" onClick={undo} title="Undo the last part edit (Ctrl+Z)">
          Undo
        </button>
        <button className="btn secondary" onClick={redo} title="Redo it (Ctrl+Shift+Z)">
          Redo
        </button>
        <button
          className="btn secondary"
          onClick={resetAllMeshes}
          title="Put every part back where it started"
        >
          Reset all
        </button>
      </div>

      {selectedMesh && delta && (
        <div className="joint-controls">
          <div className="joint-header">
            <span className="joint-name" title={selectedMesh.name}>
              {selectedMesh.name}
            </span>
          </div>

          <XformRow
            label="Move"
            values={delta.offset}
            format={(v) => v.toFixed(2)}
            onChange={(offset) => setMeshDelta(selectedMesh.uuid, { offset })}
          />
          <XformRow
            label="Rotate"
            values={delta.rotation}
            format={(v) => Math.round(v) + '°'}
            onChange={(rotation) => setMeshDelta(selectedMesh.uuid, { rotation })}
          />
          <XformRow
            label="Resize"
            values={delta.scale}
            format={(v) => v.toFixed(2) + '×'}
            onChange={(scale) => setMeshDelta(selectedMesh.uuid, { scale })}
          />

          {selectedMesh && morphEntries.length > 0 && (
            <div className="joint-controls" style={{ marginTop: 8 }}>
              <div className="joint-header">
                <span className="joint-name">Shape keys</span>
                <span className="joint-parent">{selectedMesh.name}</span>
              </div>
              <label
                className="morph-label"
                style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}
                title="When on, moving a shape key also moves same-named shape keys on other nearby parts of this character (e.g. separate teeth/eyes/eyebrows meshes). Turn off to edit only this mesh, or once you have several characters loaded and don't want them to affect each other."
              >
                <input
                  type="checkbox"
                  checked={linkedShapeKeys}
                  onChange={(e) => setLinkedShapeKeys(e.target.checked)}
                />
                Link matching shape keys on nearby parts
              </label>
              {morphEntries.map(({ idx, name }) => {
                const value = morphValues[idx] ?? 0
                return (
                  <div key={`${selectedMesh.uuid}-${idx}`} className="morph-row">
                    <label className="morph-label">{name}</label>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={value}
                      onChange={(e) => {
                        const nextValue = Math.min(1, Math.max(0, parseFloat(e.target.value)))
                        if (!Number.isFinite(nextValue)) return
                        selectedMesh.morphTargetInfluences[idx] = nextValue
                        setMorphValues((prev) => ({ ...prev, [idx]: nextValue }))
                        if (linkedShapeKeys) {
                          for (const link of getLinkedMorphTargets(selectedMesh, name)) {
                            link.mesh.morphTargetInfluences[link.idx] = nextValue
                          }
                        }
                        requestRender()
                      }}
                    />
                    <span className="morph-value">{value.toFixed(2)}</span>
                    <button
                      className="btn secondary"
                      onClick={() => {
                        const currentValue = morphValues[idx] ?? 0
                        const t = snap(insertTime)
                        st().addMorphKeyframe(getMeshIndex(selectedMesh), name, t, currentValue)
                        if (linkedShapeKeys) {
                          for (const link of getLinkedMorphTargets(selectedMesh, name)) {
                            st().addMorphKeyframe(getMeshIndex(link.mesh), name, t, currentValue)
                          }
                        }
                      }}
                      title={`Save “${name}” at the current insert time`}
                    >
                      Key
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          <div className="kf-actions" style={{ marginTop: 6 }}>
            <button
              className="btn secondary"
              onClick={() => resetMesh(selectedMesh.uuid)}
              title="Put only this part back where it started"
            >
              Reset this part
            </button>
            <button
              className="btn secondary"
              onClick={onKeyPart}
              title="Save this part's position/rotation/size at the Animate panel's insert time — key it at two times and it animates between them"
            >
              Key part{keyCount ? ` (${keyCount})` : ''}
            </button>
          </div>
        </div>
      )}

      <div className="obj-list" style={{ marginTop: 10 }}>
        {meshes.map((mesh) => {
          const hidden = meshOverrides[mesh.uuid]?.visible === false
          return (
            <div
              key={mesh.uuid}
              className={'obj-row' + (mesh.uuid === selectedMeshUuid ? ' selected' : '')}
              title={mesh.name}
              onClick={() =>
                setSelectedMeshUuid(mesh.uuid === selectedMeshUuid ? null : mesh.uuid)
              }
            >
              <span className="obj-name" style={hidden ? { opacity: 0.45 } : undefined}>
                {mesh.name}
              </span>
              <button
                className="obj-eye"
                title={hidden ? 'Show this part' : 'Hide this part'}
                onClick={(e) => {
                  e.stopPropagation()
                  setMeshVisible(mesh.uuid, hidden)
                }}
              >
                {hidden ? '🙈' : '👁'}
              </button>
            </div>
          )
        })}
      </div>

      <div className="pose-hint">
        Click a part or a name to select, then drag the gizmo. W/E/R switch
        Move/Rotate/Resize · Esc deselects · Ctrl+Z undoes. Parts attached to the
        skeleton keep following it — an offset eye still turns with the head.
      </div>
    </div>
  )
}

// One transform row: a label and three click-to-type axis values.
function XformRow({ label, values, format, onChange }) {
  return (
    <div className="xform-row">
      <span className="xform-label">{label}</span>
      {AXES.map((axis, i) => (
        <EditableValue
          key={axis}
          className="xform-value"
          label={`${label} ${axis}`}
          value={values[i]}
          format={format}
          onChange={(v) => {
            const next = values.slice()
            next[i] = v
            onChange(next)
          }}
        />
      ))}
    </div>
  )
}