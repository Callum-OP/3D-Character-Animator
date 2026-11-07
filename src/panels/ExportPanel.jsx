import { useState } from 'react'
import { useStore } from '../store.js'
import Accordion from './Accordion.jsx'
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

// Side-panel section: get your work out of the app. Four collapsible groups, most-used first —
//   Export video   preview + record the animation (open by default), then its settings
//   Export image   a transparent PNG, copy to clipboard, or every frame as a zip
//   Export mocap   the in-app animation as a .bvh
//   Export 3D model  GLB / glTF (rigged) or OBJ / STL / PLY (static mesh), with their settings
// Each group has ONE orange main action; everything else is a grey secondary button.
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

// 3D model formats. `rigged` ones keep the skeleton, skin weights, materials and textures;
// the static ones are geometry only (see exportStatic.js).
const MODEL_FORMATS = [
  { value: 'glb', ext: 'glb', rigged: true, label: 'GLB (.glb)', hint: 'Recommended. One file with the skeleton, skin weights, materials and textures. Opens in Blender, Unity, Godot and most 3D tools.' },
  { value: 'gltf', ext: 'gltf', rigged: true, label: 'glTF (.gltf)', hint: 'The same content as GLB, written as readable JSON with the textures embedded.' },
  { value: 'obj', ext: 'obj', rigged: false, label: 'OBJ (.obj)', hint: 'Posed shape and UVs only — no skeleton, animation or materials. Opens almost anywhere.' },
  { value: 'stl', ext: 'stl', rigged: false, label: 'STL (.stl)', hint: 'Posed shape only, no colours or UVs. Made for 3D printing and CAD.' },
  { value: 'ply', ext: 'ply', rigged: false, label: 'PLY (.ply)', hint: 'Posed shape with UVs and vertex colours, no skeleton or materials.' },
]

// A label + control line, so every setting lines up the same way.
function Row({ label, title, children }) {
  return (
    <div className="export-row" title={title}>
      <span className="export-row-label">{label}</span>
      {children}
    </div>
  )
}

function Settings({ children }) {
  return (
    <div className="export-settings">
      <div className="export-settings-title">Settings</div>
      {children}
    </div>
  )
}

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
  // Status line, shown inside the section whose button produced it.
  const [note, setNote] = useState(null)
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
  const [modelFormat, setModelFormat] = useState('glb')
  // OBJ / STL / PLY have no skeleton, so their pose choice is just current or rest.
  const [staticPose, setStaticPose] = useState('current')

  const name = modelInfo?.name || 'render'
  const canRecord = canRecordVideo()
  const shotView = resolveShotView({ sceneCameras, viewCameraId, animData, playbackSource })
  const busy = recording || previewing || copying
  const formatInfo = MODEL_FORMATS.find((f) => f.value === modelFormat) || MODEL_FORMATS[0]
  const notify = (section, text) => setNote({ section, text })

  function onPNG() {
    const restoreGizmos = hideGizmosForShot()
    const size = exportPNG(exportScale, name)
    restoreGizmos()
    if (!size) {
      notify('image', 'Could not save the image right now.')
      return
    }
    notify('image', `Saved a ${size.width}×${size.height} PNG${size.clamped ? ' (reduced to what your GPU supports)' : ''}.`)
  }

  function clipboardWriter() {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      notify('image', 'Clipboard image copying is not supported in this browser.')
      return null
    }
    return navigator.clipboard.write.bind(navigator.clipboard)
  }

  async function onCopyImage() {
    if (busy) return
    const write = clipboardWriter()
    if (!write) return
    setCopying(true)
    notify('image', 'Copying image…')
    let restoreGizmos = () => {}
    try {
      restoreGizmos = hideGizmosForShot()
      const blob = await capturePNG(exportScale)
      await write([new ClipboardItem({ 'image/png': blob })])
      notify('image', `Copied a ${imageSize.width}×${imageSize.height} PNG to the clipboard.`)
    } catch (error) {
      notify('image', `Could not copy the image: ${error?.message || String(error)}`)
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
      notify('image', 'Nothing to save — make or select an animation first.')
      return
    }
    const frameCount = Math.ceil(duration * videoFps) + 1
    const digits = Math.max(5, String(frameCount).length)
    const prefix = name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'frame'
    const zip = createZip()
    const progressInterval = Math.max(1, Math.floor(frameCount / 100))
    setCopying(true)
    notify('image', `Preparing ${frameCount} animation frames at ${videoFps} fps…`)
    let restoreGizmos = () => {}
    try {
      restoreGizmos = hideGizmosForShot()
      const result = await captureAnimationPNGs(videoFps, exportScale, async (blob, frame, total) => {
        await zip.add(`${prefix}_${String(frame + 1).padStart(digits, '0')}.png`, blob)
        if ((frame + 1) % progressInterval === 0 || frame + 1 === total) {
          notify('image', `Saving animation frames… ${frame + 1} of ${total}`)
        }
      })
      const url = URL.createObjectURL(zip.finish())
      const a = document.createElement('a')
      a.href = url
      a.download = `${prefix}_frames.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
      notify('image', `Saved ${result.count} images at ${videoFps} fps as ${prefix}_frames.zip, numbered in order.`)
    } catch (error) {
      notify('image', `Could not save animation frames: ${error?.message || String(error)}`)
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
      notify('mocap', 'Nothing to export — make an in-app animation first.')
      return
    }
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.bvh`
    a.click()
    URL.revokeObjectURL(url)
    notify('mocap', 'Animation exported as .bvh.')
  }

  async function onExportModel() {
    if (exportingModel) return
    setExportingModel(true)
    notify('model', `Exporting scene as .${formatInfo.ext}…`)
    const result = await exportSceneModel(modelFormat, name, formatInfo.rigged ? exportPoseMode : staticPose, {
      bakeLook: formatInfo.rigged && exportBakeLook,
      combineMeshes: exportCombine,
    })
    setExportingModel(false)
    notify('model', result.message)
  }

  // Play every loaded character's own selected clip/animation once from the
  // start — recording it to a file, or just previewing exactly what a
  // recording would show. Shared with the title bar's Export As > Video item
  // via exportShot.js, so neither can drift out of sync with the other.
  function runShot(record) {
    if (busy) return
    runExportShot({ record, name, onStatus: (text) => notify('video', text) })
  }

  const status = (section) => (note?.section === section ? <div className="pose-msg">{note.text}</div> : null)

  const shapeRow = (
    <Row label="Shape" title="Aspect ratio of saved images and videos. Wider or taller than the viewport shows more or less of the scene to the sides.">
      <select value={aspect} onChange={(e) => st().setExportAspect(e.target.value)} disabled={busy}>
        {ASPECT_OPTIONS.map(([value, label]) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
    </Row>
  )

  return (
    <div className="panel">
      <h2>Export</h2>
      <p className="panel-hint">Save a video, an image, a mocap file or a 3D model of your scene.</p>

      <Accordion id="export-video" remember icon="🎬" title="Export video" subtitle="Preview and record the animation" defaultOpen>
        <div className="export-actions">
          <button
            className="btn secondary"
            onClick={() => runShot(false)}
            disabled={busy}
            title="Play the animation once exactly as the video will look — nothing is saved"
          >
            {previewing ? 'Previewing…' : '▶ Preview video'}
          </button>
          <button
            className="btn"
            onClick={() => runShot(true)}
            disabled={busy || !canRecord}
            title={canRecord ? 'Play the animation once and save it as a video' : 'Not supported in this browser'}
          >
            {recording ? 'Recording…' : 'Record video'}
          </button>
        </div>
        <div className="radio-hint" style={{ marginTop: 6 }}>
          Films {shotView.label}
          {shotView.kind === 'free' && sceneCameras.length > 1
            ? ' — look through a camera (📷 in Cameras) to film through it'
            : ''}
          .
        </div>
        {status('video')}

        <Settings>
          {shapeRow}
          <Row label="Resolution">
            <select value={videoResolution} onChange={(e) => st().setExportVideoResolution(e.target.value)} disabled={busy}>
              {VIDEO_RESOLUTIONS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Row>
          <Row label="Frame rate">
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
          </Row>
          <Row label="Quality" title="Sets the video bitrate. Higher = sharper, bigger files.">
            <select value={videoQuality} onChange={(e) => st().setExportVideoQuality(e.target.value)} disabled={busy}>
              {QUALITIES.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Row>
          <Row label="Format">
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
          </Row>
          <label className="toggle-row" style={{ marginTop: 8 }}>
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
          <div className="radio-hint" style={{ marginTop: 8 }}>
            Records {videoSize.width} × {videoSize.height} @ {videoFps} fps, about {bitrateMbps} Mbps
            {videoFormatInfo ? `, .${videoFormatInfo.ext}` : ''}
            {videoFormatInfo?.fellBack ? ' (MP4 isn’t supported in this browser — will use WebM)' : ''}
            {videoSize.clamped ? ' (size reduced to your GPU’s limit)' : ''}.
            {' '}It’s captured live, so a heavy scene at high resolution or a high frame rate can drop frames — Preview first.
          </div>
          <div className="radio-hint" style={{ marginTop: 4 }}>
            For solid-colour video, turn on a background in Scene (transparent video isn’t widely supported).
          </div>
          <button className="btn secondary" style={{ marginTop: 8 }} onClick={() => enterFullscreen()}>
            Fullscreen (Esc to exit)
          </button>
        </Settings>
      </Accordion>

      <Accordion id="export-image" remember icon="🖼️" title="Export image" subtitle="Transparent PNG, clipboard or every frame">
        <div className="export-actions">
          <button className="btn" onClick={onPNG} disabled={busy}>
            Save image (PNG)
          </button>
        </div>
        <div className="export-actions">
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
        <div className="radio-hint" style={{ marginTop: 6 }}>
          “Save all” writes every frame of the animation, numbered in order, at the {videoFps} fps set under Export video.
        </div>
        {status('image')}

        <Settings>
          {shapeRow}
          <Row label="Image size">
            <select value={imageResolution} onChange={(e) => st().setExportImageResolution(e.target.value)} disabled={busy}>
              {IMAGE_RESOLUTIONS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Row>
          {imageResolution === 'viewport' && (
            <Row label="Scale">
              <div className="seg">
                {SCALES.map((sc) => (
                  <button
                    key={sc}
                    className={'seg-btn' + (exportScale === sc ? ' active' : '')}
                    onClick={() => setExportScale(sc)}
                    disabled={busy}
                  >
                    {sc}×
                  </button>
                ))}
              </div>
            </Row>
          )}
          <div className="radio-hint" style={{ marginTop: 6 }}>
            Saves {imageSize.width} × {imageSize.height} px
            {imageSize.clamped ? ` (reduced from ${imageSize.requested.width} × ${imageSize.requested.height} — your GPU's limit)` : ''}.
          </div>
        </Settings>
      </Accordion>

      <Accordion id="export-mocap" remember icon="🦴" title="Export mocap" subtitle="The animation as a .bvh file">
        <div className="export-actions">
          <button className="btn" onClick={onExportBVH}>
            Export mocap file (bvh)
          </button>
        </div>
        <div className="radio-hint" style={{ marginTop: 6 }}>
          Saves the in-app animation’s skeleton motion as a .bvh, for Blender and other animation tools.
        </div>
        {status('mocap')}
      </Accordion>

      <Accordion id="export-model" remember icon="🧊" title="Export 3D model" subtitle="GLB, glTF, OBJ, STL or PLY">
        <div className="export-actions">
          <button className="btn" onClick={onExportModel} disabled={exportingModel || busy}>
            {exportingModel ? 'Exporting…' : `Save as .${formatInfo.ext}`}
          </button>
        </div>
        <div className="radio-hint" style={{ marginTop: 6 }}>
          Combines every visible character and object into one file at their current positions.
        </div>
        {status('model')}

        <Settings>
          <Row label="Format">
            <select aria-label="3D model format" value={modelFormat} onChange={(e) => setModelFormat(e.target.value)} disabled={exportingModel}>
              <optgroup label="Rigged, with materials">
                {MODEL_FORMATS.filter((f) => f.rigged).map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </optgroup>
              <optgroup label="Static mesh (geometry only)">
                {MODEL_FORMATS.filter((f) => !f.rigged).map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </optgroup>
            </select>
          </Row>
          <div className="radio-hint" style={{ marginTop: 4 }}>{formatInfo.hint}</div>

          <Row label="Pose">
            {formatInfo.rigged ? (
              <select aria-label="Pose" value={exportPoseMode} onChange={(e) => setExportPoseMode(e.target.value)}>
                <option value="baked">Current, baked</option>
                <option value="current">Current, skinned</option>
                <option value="rest">Rest pose</option>
              </select>
            ) : (
              <select aria-label="Pose" value={staticPose} onChange={(e) => setStaticPose(e.target.value)}>
                <option value="current">Current pose</option>
                <option value="rest">Rest pose</option>
              </select>
            )}
          </Row>

          {formatInfo.rigged && (
            <>
              <div className="radio-hint" style={{ marginTop: 4 }}>
                Baked makes the pose the file’s rest pose (best for Blender); skinned keeps the model’s original bind data.
              </div>
              <label className="toggle-row" style={{ marginTop: 8 }} title="Writes the Look > Material settings into the file's textures and colours, so the model keeps its look in Blender, Unity and other programs.">
                <input type="checkbox" checked={exportBakeLook} onChange={(e) => setExportBakeLook(e.target.checked)} />
                Include Material look in export
              </label>
              <div className="radio-hint" style={{ marginTop: 2 }}>
                Bakes what a file can hold: colour grade (clay, noir, sepia, vivid …), flat colour, smoothed / pixel
                textures, bump flattening and finish. Manga ink and pencil hatching depend on the lighting, so they stay
                in the app.
              </div>
            </>
          )}
          <label
            className="toggle-row"
            style={{ marginTop: 8 }}
            title={
              formatInfo.rigged
                ? "Merges each object's parts into one mesh in the exported file, and each object's pieces into one mesh. Every part keeps its own material; parts with shape keys (a face) become a mesh of their own. Only the exported file changes; the scene is untouched."
                : 'Merges every visible mesh into a single mesh in the exported file. Only the exported file changes; the scene is untouched.'
            }
          >
            <input type="checkbox" checked={exportCombine} onChange={(e) => setExportCombine(e.target.checked)} />
            Combine meshes into one
          </label>
          <div className="radio-hint" style={{ marginTop: 2 }}>
            {formatInfo.rigged
              ? 'One mesh per character and per object in the file, each part keeping its own material. Parts with shape keys (a face) form a mesh of their own.'
              : 'One single mesh for everything in the file.'}
          </div>
        </Settings>
      </Accordion>
    </div>
  )
}
