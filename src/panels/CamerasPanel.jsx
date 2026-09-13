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
  const setMode = useStore((s) => s.setMode)
  const cameraGizmoMode = useStore((s) => s.cameraGizmoMode)
  const setCameraGizmoMode = useStore((s) => s.setCameraGizmoMode)
  const viewCameraId = useStore((s) => s.viewCameraId)
  const setViewCameraId = useStore((s) => s.setViewCameraId)
  const animData = useStore((s) => s.animData)
  const animFps = useStore((s) => s.animFps)
  const insertTime = useStore((s) => s.insertTime)
  const followCameraCuts = useStore((s) => s.followCameraCuts)
  const setFollowCameraCuts = useStore((s) => s.setFollowCameraCuts)
  const dofEnabled = useStore((s) => s.dofEnabled)
  const setDofEnabled = useStore((s) => s.setDofEnabled)
  const dofFocusDistance = useStore((s) => s.dofFocusDistance)
  const setDofFocusDistance = useStore((s) => s.setDofFocusDistance)
  const dofAperture = useStore((s) => s.dofAperture)
  const setDofAperture = useStore((s) => s.setDofAperture)
  const dofMaxBlur = useStore((s) => s.dofMaxBlur)
  const setDofMaxBlur = useStore((s) => s.setDofMaxBlur)
  const blurEnabled = useStore((s) => s.blurEnabled)
  const setBlurEnabled = useStore((s) => s.setBlurEnabled)
  const blurAmount = useStore((s) => s.blurAmount)
  const setBlurAmount = useStore((s) => s.setBlurAmount)
  const st = useStore.getState

  const selected = sceneCameras.find((cam) => cam.id === selectedCameraId) || null
  const keyCount = selected ? (animData.cameras?.[selected.name] || []).length : 0
  const cuts = animData.cuts || []
  const cutCount = selected ? cuts.filter((k) => k.camera === selected.name).length : 0

  function onAdd() {
    const meta = addCamera()
    st().addSceneCamera(meta)
    setMode('object')
  }

  function onSelect(id) {
    setSelectedCameraId(id === selectedCameraId ? null : id)
    if (id !== selectedCameraId) setMode('object')
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
  // the insert time until the next cut, gliding into place rather than jumping.
  function onCutHere() {
    if (!selected) return
    const t = Math.round(insertTime * animFps) / animFps
    st().addCameraCut(t, selected.name)
  }

  return (
    <div className="panel">
      <h2>Cameras</h2>
      <p className="panel-hint">
        Add cameras, adjust their view, and animate their position.
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
                onClick={() => onSelect(cam.id)}
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
                  title="Save this camera's position at the Animate panel's insert time — key it at two times and IT glides between them while it's the active view"
                >
                  Key camera{keyCount ? ` (${keyCount})` : ''}
                </button>
                <button
                  className="btn secondary"
                  onClick={onCutHere}
                  title="Switch the view to this camera from the insert time on (until the next cut) — the view glides across, like cutting between shots"
                >
                  Cut here{cutCount ? ` (${cutCount})` : ''}
                </button>
              </div>
            </div>
          )}

          <label
            className="slider-row"
            style={{ marginTop: 8 }}
            title="Camera cuts/keys are always used for Preview and Record in Export. This only controls the ordinary Play button in Animate, which ignores them by default so posing/editing isn't interrupted by the view jumping around."
          >
            <input
              type="checkbox"
              checked={followCameraCuts}
              onChange={(e) => setFollowCameraCuts(e.target.checked)}
            />
            <span className="slider-label">Follow camera cuts/keys on Play</span>
          </label>

          <div className="pose-hint">
            📷 Select a camera to move or rotate it. Use <b>Key camera</b> for
            camera motion and <b>Cut here</b> to switch shots. Exports use the
            active view; Play follows camera keys and cuts when enabled above.
          </div>
        </>
      )}

      <h3 style={{ marginTop: 16 }}>Camera effects</h3>
      <p className="panel-hint">
        Screen-space effects applied to the whole view, regardless of which
        camera is active.
      </p>

      <label className="slider-row" title="Blur things nearer or further than the focus distance, like a shallow camera lens">
        <input
          type="checkbox"
          checked={dofEnabled}
          onChange={(e) => setDofEnabled(e.target.checked)}
        />
        <span className="slider-label">Depth of field</span>
      </label>
      {dofEnabled && (
        <div className="joint-controls">
          <label className="slider-row">
            <span className="slider-label">Focus distance</span>
            <input
              type="range"
              min={0.2}
              max={30}
              step={0.1}
              value={dofFocusDistance}
              onChange={(e) => setDofFocusDistance(Number(e.target.value))}
            />
            <EditableValue
              value={dofFocusDistance}
              min={0.1}
              max={100}
              step={0.1}
              onChange={setDofFocusDistance}
              format={(v) => v.toFixed(1) + 'm'}
              label="Everything from the camera up to this distance stays sharp; only things farther away blur"
            />
          </label>
          <label className="slider-row">
            <span className="slider-label">Aperture</span>
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.01}
              value={dofAperture}
              onChange={(e) => setDofAperture(Number(e.target.value))}
            />
            <EditableValue
              value={dofAperture}
              min={0.01}
              max={2}
              step={0.01}
              onChange={setDofAperture}
              format={(v) => v.toFixed(2)}
              label="How quickly out-of-focus areas blur — lower is a shallower, more dramatic focus"
            />
          </label>
          <label className="slider-row">
            <span className="slider-label">Max blur</span>
            <input
              type="range"
              min={1}
              max={30}
              step={1}
              value={dofMaxBlur}
              onChange={(e) => setDofMaxBlur(Number(e.target.value))}
            />
            <EditableValue
              value={dofMaxBlur}
              min={0}
              max={60}
              onChange={setDofMaxBlur}
              format={(v) => Math.round(v) + 'px'}
              label="Blur strength at maximum defocus"
            />
          </label>
        </div>
      )}

      <label className="slider-row" style={{ marginTop: 8 }} title="A flat blur over the whole view, regardless of distance">
        <input
          type="checkbox"
          checked={blurEnabled}
          onChange={(e) => setBlurEnabled(e.target.checked)}
        />
        <span className="slider-label">Blur</span>
      </label>
      {blurEnabled && (
        <div className="joint-controls">
          <label className="slider-row">
            <span className="slider-label">Amount</span>
            <input
              type="range"
              min={1}
              max={30}
              step={1}
              value={blurAmount}
              onChange={(e) => setBlurAmount(Number(e.target.value))}
            />
            <EditableValue
              value={blurAmount}
              min={0}
              max={60}
              onChange={setBlurAmount}
              format={(v) => Math.round(v) + 'px'}
              label="Blur radius in pixels"
            />
          </label>
        </div>
      )}
    </div>
  )
}