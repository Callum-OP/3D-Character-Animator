import { useState } from 'react'
import { useStore } from '../store.js'
import {
  exportPNG,
  exportSceneModel,
  enterFullscreen,
} from '../three/scene.js'
import { exportAnimationBVH } from '../three/animation.js'
import { runExportShot, resolveShotView, canRecordVideo, hideGizmosForShot } from '../three/exportShot.js'

// Side-panel section: get your work out of the app — transparent PNG, a video of
// the animation, or the in-app animation as a .bvh, plus a fullscreen view for
// screen-recording.
const SCALES = [1, 2, 4]

export default function ExportPanel() {
  const modelInfo = useStore((s) => s.modelInfo)
  const exportScale = useStore((s) => s.exportScale)
  const recording = useStore((s) => s.recording)
  const previewing = useStore((s) => s.previewing)
  const setExportScale = useStore((s) => s.setExportScale)
  // Subscribed so the "Films …" caption stays current as cameras/cuts change.
  const sceneCameras = useStore((s) => s.sceneCameras)
  const viewCameraId = useStore((s) => s.viewCameraId)
  const animData = useStore((s) => s.animData)
  const playbackSource = useStore((s) => s.playbackSource)
  const stopAtFirstClipEnd = useStore((s) => s.stopAtFirstClipEnd)
  const setStopAtFirstClipEnd = useStore((s) => s.setStopAtFirstClipEnd)
  const st = useStore.getState
  const [msg, setMsg] = useState(null)
  const [exportingModel, setExportingModel] = useState(false)
  // 'baked' = pose becomes the file's bind pose (best for Blender); 'current' = skinned pose
  // using the model's original bind data; 'rest' = un-posed. See exportPose.js.
  const [exportPoseMode, setExportPoseMode] = useState('baked')

  const name = modelInfo?.name || 'render'
  const canRecord = canRecordVideo()
  const shotView = resolveShotView({ sceneCameras, viewCameraId, animData, playbackSource })
  const busy = recording || previewing

  function onPNG() {
    const restoreGizmos = hideGizmosForShot()
    exportPNG(exportScale, name)
    restoreGizmos()
    setMsg(`Saved a ${exportScale}× PNG.`)
  }

  function onExportBVH() {
    const s = st()
    const text = exportAnimationBVH(
      s.animData,
      s.animFps,
      s.animDuration,
      s.activeClipName,
      s.playbackSource,
    )
    if (!text) {
      setMsg('Nothing to export — make an in-app animation first.')
      return
    }
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.bvh`
    a.click()
    URL.revokeObjectURL(url)
    setMsg('Animation exported as .bvh.')
  }

  async function onExportScene(format) {
    if (exportingModel) return
    setExportingModel(true)
    setMsg(format === 'glb' ? 'Exporting scene as .glb…' : 'Exporting scene as .gltf…')
    const result = await exportSceneModel(format, name, exportPoseMode)
    setExportingModel(false)
    setMsg(result.message)
  }

  // Play every loaded character's own selected clip/animation once from the
  // start — recording it to a file, or just previewing exactly what a
  // recording would show. Shared with the title bar's Export As > Video item
  // via exportShot.js, so neither can drift out of sync with the other.
  function runShot(record) {
    if (busy) return
    runExportShot({ record, name, onStatus: setMsg })
  }

  return (
    <div className="panel">
      <h2>Export</h2>
      <p className="panel-hint">
        Save a transparent image, a video, or the animation — ready for your art.
      </p>

      <div className="field">
        <label className="field-label">Image size</label>
        <div className="seg">
          {SCALES.map((s) => (
            <button
              key={s}
              className={'seg-btn' + (exportScale === s ? ' active' : '')}
              onClick={() => setExportScale(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      <button className="btn" style={{ marginTop: 8 }} onClick={onPNG}>
        Save image (PNG)
      </button>

      <div className="kf-actions" style={{ marginTop: 6 }}>
        <button
          className="btn secondary"
          onClick={() => runShot(false)}
          disabled={busy}
          title="Play the animation once exactly as the video will look — nothing is saved"
        >
          {previewing ? 'Previewing…' : '▶ Preview video'}
        </button>
        <button
          className="btn secondary"
          onClick={() => runShot(true)}
          disabled={busy || !canRecord}
          title={
            canRecord
              ? 'Play the animation once and save it as a video'
              : 'Not supported in this browser'
          }
        >
          {recording ? 'Recording…' : 'Record video'}
        </button>
      </div>
      <label className="toggle-row" style={{ marginTop: 6 }}>
        <input
          type="checkbox"
          checked={stopAtFirstClipEnd}
          onChange={(event) => setStopAtFirstClipEnd(event.target.checked)}
        />
        Stop at the shortest character clip
      </label>
      <div className="radio-hint" style={{ marginTop: 4 }}>
        Films {shotView.label}
        {shotView.kind === 'free' && sceneCameras.length > 1
          ? ' — look through a camera (📷 in Cameras) to film through it'
          : ''}
        .
      </div>

      <button className="btn secondary" style={{ marginTop: 6 }} onClick={onExportBVH}>
        Export animation (.bvh)
      </button>

      <div className="field" style={{ marginTop: 10 }}>
        <label className="field-label">Export scene as one file</label>
        <div className="kf-actions">
          <button
            className="btn secondary"
            onClick={() => onExportScene('glb')}
            disabled={exportingModel}
          >
            {exportingModel ? 'Exporting…' : 'Save as .glb'}
          </button>
          <button
            className="btn secondary"
            onClick={() => onExportScene('gltf')}
            disabled={exportingModel}
          >
            {exportingModel ? 'Exporting…' : 'Save as .gltf'}
          </button>
        </div>
        <label className="radio-hint" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          Pose
          <select value={exportPoseMode} onChange={(e) => setExportPoseMode(e.target.value)}>
            <option value="baked">Current pose, baked (best for Blender)</option>
            <option value="current">Current pose, skinned (original bind data)</option>
            <option value="rest">Rest pose</option>
          </select>
        </label>
        <div className="radio-hint" style={{ marginTop: 4 }}>
          Combines every visible character and object into one file at their
          current positions. Three.js can't write .fbx directly — open the
          .glb in Blender and re-export as .fbx if you need that format.
        </div>
      </div>

      <button className="btn secondary" style={{ marginTop: 6 }} onClick={() => enterFullscreen()}>
        Fullscreen (Esc to exit)
      </button>

      {msg && <div className="pose-msg">{msg}</div>}

      <p className="panel-hint" style={{ marginTop: 10 }}>
        Tip: use <b>Preview video</b> to check the shot before recording. For
        solid-colour video, turn on a background in Scene (transparent video
        isn’t widely supported).
      </p>
    </div>
  )
}