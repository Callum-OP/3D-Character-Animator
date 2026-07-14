import { useState } from 'react'
import { useStore } from '../store.js'
import {
  exportPNG,
  enterFullscreen,
  canRecordVideo,
  startRecording,
  stopRecordingAndDownload,
  setViewCameraById,
} from '../three/scene.js'
import { selectEdit, selectClip, play, stop, exportAnimationBVH } from '../three/animation.js'

// Side-panel section: get your work out of the app — transparent PNG, a video of
// the animation, or the in-app animation as a .bvh, plus a fullscreen view for
// screen-recording.
const SCALES = [1, 2, 4]

// What a video (or preview) will be filmed through. Priority: camera cuts drive
// the view themselves; then whatever camera is being looked through; then a
// keyframed camera; then the only placed camera; else the current free view.
// Recording something other than the camera the user carefully placed is the
// #1 surprise — so cameras win whenever the choice is unambiguous.
function resolveShotView(s) {
  if (s.playbackSource === 'edit' && (s.animData.cuts || []).length) {
    return { kind: 'cuts', label: 'your camera cuts' }
  }
  if (s.viewCameraId != null) {
    const cam = s.sceneCameras.find((c) => c.id === s.viewCameraId)
    return { kind: 'view', id: s.viewCameraId, label: `through ${cam?.name || 'the camera'}` }
  }
  if (s.playbackSource === 'edit') {
    const keyedName = Object.keys(s.animData.cameras || {}).find(
      (n) => (s.animData.cameras[n] || []).length && s.sceneCameras.some((c) => c.name === n),
    )
    if (keyedName) {
      const cam = s.sceneCameras.find((c) => c.name === keyedName)
      return { kind: 'auto', id: cam.id, label: `through ${cam.name} (it has keyframes)` }
    }
  }
  if (s.sceneCameras.length === 1) {
    return { kind: 'auto', id: s.sceneCameras[0].id, label: `through ${s.sceneCameras[0].name}` }
  }
  return { kind: 'free', label: 'the current view' }
}

export default function ExportPanel() {
  const modelInfo = useStore((s) => s.modelInfo)
  const exportScale = useStore((s) => s.exportScale)
  const recording = useStore((s) => s.recording)
  const setExportScale = useStore((s) => s.setExportScale)
  // Subscribed so the "Films …" caption stays current as cameras/cuts change.
  const sceneCameras = useStore((s) => s.sceneCameras)
  const viewCameraId = useStore((s) => s.viewCameraId)
  const animData = useStore((s) => s.animData)
  const playbackSource = useStore((s) => s.playbackSource)
  const st = useStore.getState
  const [msg, setMsg] = useState(null)
  const [previewing, setPreviewing] = useState(false)

  const name = modelInfo?.name || 'render'
  const canRecord = canRecordVideo()
  const shotView = resolveShotView({ sceneCameras, viewCameraId, animData, playbackSource })
  const busy = recording || previewing

  function onPNG() {
    exportPNG(exportScale, name)
    setMsg(`Saved a ${exportScale}× PNG.`)
  }

  function onExportBVH() {
    const s = st()
    const text = exportAnimationBVH(s.animData, s.animFps, s.animDuration)
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

  // Switch the viewport into the shot's camera (returns a restore function).
  // Applied both through the store (so the banner/UI reflect it) and directly
  // (so the very first recorded frame is already the camera view).
  function armShotView(view) {
    const prev = st().viewCameraId
    if (view.id != null && view.id !== prev) {
      st().setViewCameraId(view.id)
      setViewCameraById(view.id)
      return () => {
        st().setViewCameraId(prev)
        setViewCameraById(prev)
      }
    }
    return () => {}
  }

  // Play the animation once from the start — recording it to a file, or just
  // previewing exactly what a recording would show. One code path so the
  // preview can never lie about the video.
  function runShot(record) {
    if (busy) return
    stop() // clear any armed playback first (also restores cut-driven views)
    const s = st()
    const view = resolveShotView(s)
    const restoreView = armShotView(view)
    let durSec
    if (s.playbackSource === 'edit') {
      durSec = selectEdit(s.animData, s.animDuration, { loop: false, speed: s.speed })
    } else if (s.activeClipName) {
      durSec = selectClip(s.activeClipName, { loop: false, speed: s.speed })
    } else {
      restoreView()
      setMsg(`Nothing to ${record ? 'record' : 'preview'} — pick a clip or make an animation first.`)
      return
    }
    if (record && !startRecording(30)) {
      restoreView()
      setMsg('Video recording isn’t supported in this browser — use Fullscreen and screen-record instead.')
      return
    }
    if (record) st().setRecording(true)
    else setPreviewing(true)
    st().setPlayback('playing')
    st().setCurrentTime(0)
    play()
    setMsg(`${record ? 'Recording' : 'Previewing'} ${view.label}…`)
    const ms = (durSec / (s.speed || 1)) * 1000 + (record ? 400 : 100)
    window.setTimeout(() => {
      stop()
      st().setPlayback('stopped')
      st().setCurrentTime(0)
      if (record) {
        stopRecordingAndDownload(name)
        st().setRecording(false)
        setMsg('Video saved (.webm).')
      } else {
        setPreviewing(false)
        setMsg(null)
      }
      restoreView()
    }, ms)
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
