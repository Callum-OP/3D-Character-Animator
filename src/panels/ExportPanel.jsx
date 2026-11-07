import { useState } from 'react'
import { useStore } from '../store.js'
import {
  exportPNG,
  capturePNG,
  captureAnimationPNGs,
  getAllTimelineDuration,
  previewOutputSize,
  exportSceneModel,
  enterFullscreen,
} from '../three/scene.js'
import { exportAnimationBVH } from '../three/animation.js'
import { pickVideoFormat, videoBitrate, VIDEO_FPS, MIN_VIDEO_FPS, MAX_VIDEO_FPS, normalizeVideoFps } from '../three/exportSize.js'
import { webCodecsAvailable } from '../three/videoCapture.js'
import { createZip } from '../three/zipStore.js'
import { runExportShot, resolveShotView, canRecordVideo, hideGizmosForShot } from '../three/exportShot.js'

// Side-panel section: get your work out of the app — transparent PNG, a video of
// the animation, or the in-app animation as a .bvh, plus a fullscreen view for
// screen-recording.
const SCALES = [1, 2, 4]
const IMAGE_RESOLUTIONS = [
  ['viewport', 'Match viewport (× scale)'],
  ['720p', '720p'],
  ['1080p', '1080p (Full HD)'],
  ['1440p', '1440p (2K)'],
  ['4k', '4K (UHD)'],
  ['8k', '8K'],
]
const VIDEO_RESOLUTIONS = [
  ['viewport', 'Match viewport'],
  ['720p', '720p'],
  ['1080p', '1080p (Full HD)'],
  ['1440p', '1440p (2K)'],
  ['4k', '4K (UHD)'],
]
const ASPECT_OPTIONS = [
  ['viewport', 'Match viewport'],
  ['16:9', '16:9 (landscape)'],
  ['9:16', '9:16 (portrait / shorts)'],
  ['1:1', '1:1 (square)'],
  ['4:3', '4:3'],
  ['21:9', '21:9 (cinematic)'],
]
const QUALITIES = [
  ['standard', 'Standard'],
  ['high', 'High'],
  ['max', 'Maximum'],
]

export default function ExportPanel() {
  const modelInfo = useStore((s) => s.modelInfo)
  const exportScale = useStore((s) => s.exportScale)
  const recording = useStore((s) => s.recording)
  const previewing = useStore((s) => s.previewing)
  const setExportScale = useStore((s) => s.setExportScale)
  const imageResolution = useStore((s) => s.exportImageResolution)
  const videoResolution = useStore((s) => s.exportVideoResolution)
  const aspect = useStore((s) => s.exportAspect)
  const videoFps = useStore((s) => s.exportVideoFps)
  const showTargetFrameRateInPreview = useStore((s) => s.showTargetFrameRateInPreview)
  const videoQuality = useStore((s) => s.exportVideoQuality)
  const videoFormat = useStore((s) => s.exportVideoFormat)
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
  const [copying, setCopying] = useState(false)
  const [videoFpsDraft, setVideoFpsDraft] = useState(String(videoFps))
  // 'baked' = pose becomes the file's bind pose (best for Blender); 'current' = skinned pose
  // using the model's original bind data; 'rest' = un-posed. See exportPose.js.
  const [exportPoseMode, setExportPoseMode] = useState('baked')
  // Write the Look > Material settings (clay, flat colour, noir, pixel …) into the model's own textures and colours.
  const [exportBakeLook, setExportBakeLook] = useState(false)
  // Merge each character's / object's meshes into one in the exported file (the scene itself is untouched).
  const [exportCombine, setExportCombine] = useState(false)

  const name = modelInfo?.name || 'render'
  const canRecord = canRecordVideo()
  const shotView = resolveShotView({ sceneCameras, viewCameraId, animData, playbackSource })
  const busy = recording || previewing || copying

  function onPNG() {
    const restoreGizmos = hideGizmosForShot()
    const size = exportPNG(exportScale, name)
    restoreGizmos()
    if (!size) {
      setMsg('Could not save the image right now.')
      return
    }
    setMsg(`Saved a ${size.width}×${size.height} PNG${size.clamped ? ' (reduced to what your GPU supports)' : ''}.`)
  }

  function clipboardWriter() {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      setMsg('Clipboard image copying is not supported in this browser.')
      return null
    }
    return navigator.clipboard.write.bind(navigator.clipboard)
  }

  async function onCopyImage() {
    if (busy) return
    const write = clipboardWriter()
    if (!write) return
    setCopying(true)
    setMsg('Copying image…')
    let restoreGizmos = () => {}
    try {
      restoreGizmos = hideGizmosForShot()
      const blob = await capturePNG(exportScale)
      await write([new ClipboardItem({ 'image/png': blob })])
      setMsg(`Copied a ${imageSize.width}×${imageSize.height} PNG to the clipboard.`)
    } catch (error) {
      setMsg(`Could not copy the image: ${error?.message || String(error)}`)
    } finally {
      restoreGizmos()
      setCopying(false)
    }
  }

  // Every animation frame as a numbered PNG in one zip, in order — for programs
  // (Clip Studio Paint, etc.) that take an image sequence but can't paste several images.
  async function onSaveAllImages() {
    if (busy) return
    const duration = getAllTimelineDuration({ stopAtFirstClipEnd })
    if (!(duration > 0)) {
      setMsg('Nothing to save — make or select an animation first.')
      return
    }
    const frameCount = Math.ceil(duration * videoFps) + 1
    const digits = Math.max(5, String(frameCount).length)
    const prefix = name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'frame'
    const zip = createZip()
    const progressInterval = Math.max(1, Math.floor(frameCount / 100))
    setCopying(true)
    setMsg(`Preparing ${frameCount} animation frames at ${videoFps} fps…`)
    let restoreGizmos = () => {}
    try {
      restoreGizmos = hideGizmosForShot()
      const result = await captureAnimationPNGs(videoFps, exportScale, async (blob, frame, total) => {
        await zip.add(`${prefix}_${String(frame + 1).padStart(digits, '0')}.png`, blob)
        if ((frame + 1) % progressInterval === 0 || frame + 1 === total) {
          setMsg(`Saving animation frames… ${frame + 1} of ${total}`)
        }
      })
      const url = URL.createObjectURL(zip.finish())
      const a = document.createElement('a')
      a.href = url
      a.download = `${prefix}_frames.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
      setMsg(`Saved ${result.count} images at ${videoFps} fps as ${prefix}_frames.zip, numbered in order.`)
    } catch (error) {
      setMsg(`Could not save animation frames: ${error?.message || String(error)}`)
    } finally {
      restoreGizmos()
      setCopying(false)
    }
  }

  // Live captions for the chosen sizes. Recomputed each render, so they follow
  // the viewport size when "Match viewport" is selected.
  const imageSize = previewOutputSize('image')
  const videoSize = previewOutputSize('video')
  // MP4 and WebM are both encoded with WebCodecs (seekable files with a real
  // duration); MediaRecorder (WebM only) is the fallback for browsers without it.
  const videoFormatInfo = webCodecsAvailable()
    ? { ext: videoFormat === 'mp4' ? 'mp4' : 'webm', fellBack: false }
    : canRecord
      ? { ...pickVideoFormat('webm', (t) => MediaRecorder.isTypeSupported(t)), fellBack: videoFormat === 'mp4' }
      : null
  const bitrateMbps = (
    videoBitrate({ width: videoSize.width, height: videoSize.height, fps: videoFps, quality: videoQuality }) / 1e6
  ).toFixed(0)

  function commitVideoFps() {
    if (videoFpsDraft.trim() === '') {
      setVideoFpsDraft(String(videoFps))
      return
    }
    const value = Number(videoFpsDraft)
    if (!Number.isFinite(value)) {
      setVideoFpsDraft(String(videoFps))
      return
    }
    const fps = Math.min(MAX_VIDEO_FPS, Math.max(MIN_VIDEO_FPS, value))
    st().setExportVideoFps(fps)
    setVideoFpsDraft(String(fps))
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
    const result = await exportSceneModel(format, name, exportPoseMode, { bakeLook: exportBakeLook, combineMeshes: exportCombine })
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
        <label className="field-label">Shape (images + video)</label>
        <select
          value={aspect}
          onChange={(e) => st().setExportAspect(e.target.value)}
          disabled={busy}
          title="Aspect ratio of saved images and videos. Wider or taller than the viewport shows more or less of the scene to the sides."
        >
          {ASPECT_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field-label">Image size</label>
        <select
          value={imageResolution}
          onChange={(e) => st().setExportImageResolution(e.target.value)}
          disabled={busy}
        >
          {IMAGE_RESOLUTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        {imageResolution === 'viewport' && (
          <div className="seg" style={{ marginTop: 6 }}>
            {SCALES.map((s) => (
              <button
                key={s}
                className={'seg-btn' + (exportScale === s ? ' active' : '')}
                onClick={() => setExportScale(s)}
                disabled={busy}
              >
                {s}×
              </button>
            ))}
          </div>
        )}
        <div className="radio-hint" style={{ marginTop: 4 }}>
          Saves {imageSize.width} × {imageSize.height} px
          {imageSize.clamped ? ` (reduced from ${imageSize.requested.width} × ${imageSize.requested.height} — your GPU's limit)` : ''}.
        </div>
      </div>

      <div className="kf-actions" style={{ marginTop: 8 }}>
        <button className="btn" onClick={onPNG} disabled={busy}>
          Save image (PNG)
        </button>
        <button className="btn secondary" onClick={onCopyImage} disabled={busy}>
          Copy image
        </button>
        <button
          className="btn secondary"
          onClick={onSaveAllImages}
          disabled={busy}
          title={`Save every animation frame as a numbered PNG in one zip, at ${videoFps} fps`}
        >
          Save all as images (zip)
        </button>
      </div>

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
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={showTargetFrameRateInPreview}
          onChange={(event) => st().setShowTargetFrameRateInPreview(event.target.checked)}
        />
        Show target frame rate in preview
      </label>
      <div className="field" style={{ marginTop: 10 }}>
        <label className="field-label">Video quality</label>
        <label className="radio-hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Resolution
          <select
            value={videoResolution}
            onChange={(e) => st().setExportVideoResolution(e.target.value)}
            disabled={busy}
          >
            {VIDEO_RESOLUTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <div className="radio-hint" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          Frame rate
          <div className="seg">
            {VIDEO_FPS.map((f) => (
              <button
                key={f}
                className={'seg-btn' + (videoFps === f ? ' active' : '')}
                onClick={() => {
                  st().setExportVideoFps(f)
                  setVideoFpsDraft(String(f))
                }}
                disabled={busy}
              >
                {f}
              </button>
            ))}
          </div>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              aria-label="Custom FPS"
              type="number"
              min={MIN_VIDEO_FPS}
              max={MAX_VIDEO_FPS}
              step="any"
              value={videoFpsDraft}
              onChange={(event) => {
                const value = event.target.value
                setVideoFpsDraft(value)
                const fps = Number(value)
                if (value !== '' && Number.isFinite(fps) && fps >= MIN_VIDEO_FPS && fps <= MAX_VIDEO_FPS) {
                  st().setExportVideoFps(normalizeVideoFps(value))
                }
              }}
              onBlur={commitVideoFps}
              disabled={busy}
              title={`Choose a frame rate from ${MIN_VIDEO_FPS} to ${MAX_VIDEO_FPS} fps`}
              style={{ width: 72 }}
            />
          </label>
        </div>
        <label className="radio-hint" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          Quality
          <select
            value={videoQuality}
            onChange={(e) => st().setExportVideoQuality(e.target.value)}
            disabled={busy}
            title="Sets the video bitrate. Higher = sharper, bigger files."
          >
            {QUALITIES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <div className="radio-hint" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          Format
          <div className="seg">
            {[['mp4', 'MP4'], ['webm', 'WebM']].map(([value, label]) => (
              <button
                key={value}
                className={'seg-btn' + (videoFormat === value ? ' active' : '')}
                onClick={() => st().setExportVideoFormat(value)}
                disabled={busy}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="radio-hint" style={{ marginTop: 4 }}>
          Records {videoSize.width} × {videoSize.height} @ {videoFps} fps, about {bitrateMbps} Mbps
          {videoFormatInfo ? `, .${videoFormatInfo.ext}` : ''}
          {videoFormatInfo?.fellBack ? ' (MP4 isn’t supported in this browser — will use WebM)' : ''}
          {videoSize.clamped ? ' (size reduced to your GPU’s limit)' : ''}.
          {' '}It’s captured live, so a heavy scene at high resolution or a high frame rate can drop frames — Preview first.
        </div>
      </div>

      <div className="radio-hint" style={{ marginTop: 4 }}>
        Films {shotView.label}
        {shotView.kind === 'free' && sceneCameras.length > 1
          ? ' — look through a camera (📷 in Cameras) to film through it'
          : ''}
        .
      </div>

      <button className="btn secondary" style={{ marginTop: 6 }} onClick={onExportBVH}>
        Export mocap file (bvh)
      </button>

      <div className="field" style={{ marginTop: 10 }}>
        <label className="field-label">Export scene as one file</label>
        <div className="kf-actions">
          <button
            className="btn secondary"
            onClick={() => onExportScene('glb')}
            disabled={exportingModel || busy}
          >
            {exportingModel ? 'Exporting…' : 'Save as .glb'}
          </button>
          <button
            className="btn secondary"
            onClick={() => onExportScene('gltf')}
            disabled={exportingModel || busy}
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
        <label className="toggle-row" style={{ marginTop: 6 }} title="Writes the Look > Material settings into the file's textures and colours, so the model keeps its look in Blender, Unity and other programs.">
          <input type="checkbox" checked={exportBakeLook} onChange={(e) => setExportBakeLook(e.target.checked)} />
          Include Material look in export
        </label>
        <div className="radio-hint" style={{ marginTop: 2 }}>
          Bakes what a file can hold: colour grade (clay, noir, sepia, vivid …), flat colour, smoothed / pixel
          textures, bump flattening and finish. Manga ink and pencil hatching depend on the lighting, so they stay
          in the app.
        </div>
        <label className="toggle-row" style={{ marginTop: 6 }} title="Merges each object's parts into one mesh in the exported file, and each object's pieces into one mesh. Every part keeps its own material; parts with shape keys (a face) become a mesh of their own. Only the exported file changes; the scene is untouched.">
          <input type="checkbox" checked={exportCombine} onChange={(e) => setExportCombine(e.target.checked)} />
          Combine meshes into one
        </label>
        <div className="radio-hint" style={{ marginTop: 2 }}>
          One mesh per character and per object in the file, each part keeping its own material. Parts with shape keys (a face) form a mesh of their own.
        </div>
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