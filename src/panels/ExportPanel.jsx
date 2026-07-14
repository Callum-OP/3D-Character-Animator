import { useState } from 'react'
import { useStore } from '../store.js'
import {
  exportPNG,
  enterFullscreen,
  canRecordVideo,
  startRecording,
  stopRecordingAndDownload,
} from '../three/scene.js'
import { selectEdit, selectClip, play, stop, exportAnimationBVH } from '../three/animation.js'

// Side-panel section: get your work out of the app — transparent PNG, a video of
// the animation, or the in-app animation as a .bvh, plus a fullscreen view for
// screen-recording.
const SCALES = [1, 2, 4]

export default function ExportPanel() {
  const modelInfo = useStore((s) => s.modelInfo)
  const exportScale = useStore((s) => s.exportScale)
  const recording = useStore((s) => s.recording)
  const setExportScale = useStore((s) => s.setExportScale)
  const st = useStore.getState
  const [msg, setMsg] = useState(null)

  const name = modelInfo?.name || 'render'
  const canRecord = canRecordVideo()

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

  function onRecord() {
    if (recording) return
    const s = st()
    // Arm the current source and play it once from the start while recording.
    stop()
    let durSec
    if (s.playbackSource === 'edit') {
      durSec = selectEdit(s.animData, s.animDuration, {
        loop: false,
        speed: s.speed,
      })
    } else if (s.activeClipName) {
      durSec = selectClip(s.activeClipName, { loop: false, speed: s.speed })
    } else {
      setMsg('Nothing to record — pick a clip or make an animation first.')
      return
    }
    if (!startRecording(30)) {
      setMsg('Video recording isn’t supported in this browser — use Fullscreen and screen-record instead.')
      return
    }
    st().setRecording(true)
    st().setPlayback('playing')
    st().setCurrentTime(0)
    play()
    setMsg('Recording…')
    const ms = (durSec / (s.speed || 1)) * 1000 + 400
    window.setTimeout(() => {
      stop()
      st().setPlayback('stopped')
      st().setCurrentTime(0)
      stopRecordingAndDownload(name)
      st().setRecording(false)
      setMsg('Video saved (.webm).')
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

      <button
        className="btn secondary"
        style={{ marginTop: 6 }}
        onClick={onRecord}
        disabled={recording || !canRecord}
        title={canRecord ? 'Play the animation once and save it as a video' : 'Not supported in this browser'}
      >
        {recording ? 'Recording…' : 'Record video'}
      </button>

      <button className="btn secondary" style={{ marginTop: 6 }} onClick={onExportBVH}>
        Export animation (.bvh)
      </button>

      <button className="btn secondary" style={{ marginTop: 6 }} onClick={() => enterFullscreen()}>
        Fullscreen (Esc to exit)
      </button>

      {msg && <div className="pose-msg">{msg}</div>}

      <p className="panel-hint" style={{ marginTop: 10 }}>
        Tip: video/fullscreen capture the current camera angle. For solid-colour
        video, turn on a background in Scene (transparent video isn’t widely
        supported).
      </p>
    </div>
  )
}
