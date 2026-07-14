import { useStore } from '../store.js'
import {
  addCamera,
  removeCamera,
  setCameraFov,
  snapCameraToView,
  getCameraKeyValue,
} from '../three/cameras.js'
import EditableValue from './EditableValue.jsx'

// Side-panel section: place cameras in the scene, frame shots through them, and
// keyframe their movement. A new camera copies the current viewport view, so
// "orbit until it looks right, then Add camera" captures the shot. Camera moves
// are keyframed on the same timeline as the character (Animate → Make your own).
const MODES = [
  { value: 'translate', label: 'Move' },
  { value: 'rotate', label: 'Rotate' },
]

export default function CamerasPanel() {
  const sceneCameras = useStore((s) => s.sceneCameras)
  const selectedCameraId = useStore((s) => s.selectedCameraId)
  const setSelectedCameraId = useStore((s) => s.setSelectedCameraId)
  const cameraGizmoMode = useStore((s) => s.cameraGizmoMode)
  const setCameraGizmoMode = useStore((s) => s.setCameraGizmoMode)
  const viewCameraId = useStore((s) => s.viewCameraId)
  const setViewCameraId = useStore((s) => s.setViewCameraId)
  const animData = useStore((s) => s.animData)
  const animFps = useStore((s) => s.animFps)
  const insertTime = useStore((s) => s.insertTime)
  const st = useStore.getState

  const selected = sceneCameras.find((cam) => cam.id === selectedCameraId) || null
  const keyCount = selected ? (animData.cameras?.[selected.name] || []).length : 0
  const cuts = animData.cuts || []
  const cutCount = selected ? cuts.filter((k) => k.camera === selected.name).length : 0

  function onAdd() {
    const meta = addCamera()
    st().addSceneCamera(meta)
  }

  function onRemove(id) {
    removeCamera(id)
    st().removeSceneCamera(id)
  }

  function onFov(fov) {
    if (!selected) return
    setCameraFov(selected.id, fov)
    st().setCameraFov(selected.id, fov)
  }

  function onKeyCamera() {
    if (!selected) return
    const key = getCameraKeyValue(selected.id)
    if (!key) return
    const t = Math.round(insertTime * animFps) / animFps // snap to the fps grid
    st().addCameraKeyframe(selected.name, t, { pos: key.pos, quat: key.quat })
  }

  // Insert a camera cut: during playback the view switches to this camera from
  // the insert time until the next cut.
  function onCutHere() {
    if (!selected) return
    const t = Math.round(insertTime * animFps) / animFps
    st().addCameraCut(t, selected.name)
  }

  return (
    <div className="panel">
      <h2>Cameras</h2>
      <p className="panel-hint">
        Frame the view how you like it, then add a camera to capture that shot.
        Keyframe it at different times to move the camera during the animation.
      </p>

      <button className="btn" onClick={onAdd} title="Place a camera at the current view">
        + Add camera (from this view)
      </button>

      {sceneCameras.length > 0 && (
        <>
          <div className="seg" style={{ marginTop: 8 }} title="What the gizmo does when you drag it">
            {MODES.map((mo) => (
              <button
                key={mo.value}
                className={'seg-btn' + (cameraGizmoMode === mo.value ? ' active' : '')}
                onClick={() => setCameraGizmoMode(mo.value)}
              >
                {mo.label}
              </button>
            ))}
          </div>

          <div className="obj-list" style={{ marginTop: 8 }}>
            {sceneCameras.map((cam) => (
              <div
                key={cam.id}
                className={'obj-row' + (cam.id === selectedCameraId ? ' selected' : '')}
                title={cam.name}
                onClick={() => setSelectedCameraId(cam.id === selectedCameraId ? null : cam.id)}
              >
                <span className="obj-name">
                  {cam.name}
                  {(animData.cameras?.[cam.name] || []).length > 0 && (
                    <span className="kf-tag" style={{ marginLeft: 6 }}>
                      {(animData.cameras?.[cam.name] || []).length} keys
                    </span>
                  )}
                </span>
                <button
                  className="obj-eye"
                  title={
                    cam.id === viewCameraId
                      ? 'Back to the free view (Esc)'
                      : 'Look through this camera (0)'
                  }
                  onClick={(e) => {
                    e.stopPropagation()
                    setViewCameraId(cam.id === viewCameraId ? null : cam.id)
                  }}
                >
                  {cam.id === viewCameraId ? '🎥' : '📷'}
                </button>
                <button
                  className="obj-del"
                  title="Remove this camera"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(cam.id)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {selected && (
            <div className="joint-controls">
              <button
                className={selected.id === viewCameraId ? 'btn secondary' : 'btn'}
                style={{ width: '100%' }}
                onClick={() =>
                  setViewCameraId(selected.id === viewCameraId ? null : selected.id)
                }
                title="See exactly what this camera sees — exports and videos film whatever the view shows (0 toggles, Esc exits)"
              >
                {selected.id === viewCameraId
                  ? 'Exit camera view (Esc)'
                  : `👁 Look through ${selected.name}`}
              </button>

              <label className="slider-row">
                <span className="slider-label">Zoom (FOV)</span>
                <input
                  type="range"
                  min={10}
                  max={120}
                  step={1}
                  value={selected.fov}
                  onChange={(e) => onFov(Number(e.target.value))}
                />
                <EditableValue
                  value={selected.fov}
                  min={10}
                  max={120}
                  onChange={onFov}
                  format={(v) => Math.round(v) + '°'}
                  label="Field of view (degrees)"
                />
              </label>

              <div className="kf-actions" style={{ marginTop: 6 }}>
                <button
                  className="btn secondary"
                  onClick={() => snapCameraToView(selected.id)}
                  title="Move this camera to match the current free view"
                >
                  Snap to view
                </button>
                <button
                  className="btn secondary"
                  onClick={onKeyCamera}
                  title="Save this camera's position at the Animate panel's insert time — key it at two times and it glides between them"
                >
                  Key camera{keyCount ? ` (${keyCount})` : ''}
                </button>
                <button
                  className="btn secondary"
                  onClick={onCutHere}
                  title="Switch the view to this camera from the insert time on (until the next cut) — like cutting between shots"
                >
                  Cut here{cutCount ? ` (${cutCount})` : ''}
                </button>
              </div>
            </div>
          )}

          <div className="pose-hint">
            📷 looks through a camera (0 toggles, Esc exits) — exports and
            recordings use whatever the view shows. <b>Key camera</b> at two
            times makes one camera glide between them; <b>Cut here</b> hard-
            switches to a camera at a time, so several cameras can share one
            animation like film shots.
          </div>
        </>
      )}
    </div>
  )
}
