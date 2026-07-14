import { useStore } from '../store.js'
import {
  getMeshDelta,
  setMeshDelta,
  getMeshKeyValue,
  resetMesh,
  resetAllMeshes,
  undo,
  redo,
} from '../three/meshedit.js'
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
  const animData = useStore((s) => s.animData)
  const animFps = useStore((s) => s.animFps)
  const insertTime = useStore((s) => s.insertTime)
  const st = useStore.getState
  useStore((s) => s.meshVersion) // re-render on every mesh edit (gizmo drag, undo…)

  const meshes = modelInfo?.meshes || []
  const selected = meshes.find((mesh) => mesh.uuid === selectedMeshUuid) || null
  const selectedIndex = selected ? meshes.indexOf(selected) : -1
  const delta = selected ? getMeshDelta(selected.uuid) : null
  const keyCount = selectedIndex >= 0 ? (animData.meshes?.[selectedIndex] || []).length : 0

  function onKeyPart() {
    if (selectedIndex < 0) return
    const key = getMeshKeyValue(selected.uuid)
    if (!key) return
    const t = Math.round(insertTime * animFps) / animFps // snap to the fps grid
    st().addMeshKeyframe(selectedIndex, t, key)
  }

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

      {selected && delta && (
        <div className="joint-controls">
          <div className="joint-header">
            <span className="joint-name" title={selected.name}>
              {selected.name}
            </span>
          </div>

          <XformRow
            label="Move"
            values={delta.offset}
            format={(v) => v.toFixed(2)}
            onChange={(offset) => setMeshDelta(selected.uuid, { offset })}
          />
          <XformRow
            label="Rotate"
            values={delta.rotation}
            format={(v) => Math.round(v) + '°'}
            onChange={(rotation) => setMeshDelta(selected.uuid, { rotation })}
          />
          <XformRow
            label="Resize"
            values={delta.scale}
            format={(v) => v.toFixed(2) + '×'}
            onChange={(scale) => setMeshDelta(selected.uuid, { scale })}
          />

          <div className="kf-actions" style={{ marginTop: 6 }}>
            <button
              className="btn secondary"
              onClick={() => resetMesh(selected.uuid)}
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
