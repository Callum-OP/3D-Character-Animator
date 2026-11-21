import { useStore } from '../store.js'
import { exportPNG, captureAnimationPNGs, getAllTimelineDuration, exportSceneModel } from './scene.js'
import { exportAnimationBVH } from './animation.js'
import { hideGizmosForShot } from './exportShot.js'
import { createZip } from './zipStore.js'

// The export actions behind both the Export panel and the title bar's File > Export As menu, so a
// file saved from either place is produced by the same code and can't drift apart.
// Each one returns { ok, message } — the message is what to show the person.

// Rigged formats carry the skeleton and materials; static ones are geometry only (see exportStatic.js).
export const MODEL_FORMATS = [
  { value: 'glb', ext: 'glb', rigged: true, label: 'GLB (.glb)', hint: 'Recommended. One file with the skeleton, skin weights, materials and textures. Opens in Blender, Unity, Godot and most 3D tools.' },
  { value: 'gltf', ext: 'gltf', rigged: true, label: 'glTF (.gltf)', hint: 'The same content as GLB, written as readable JSON with the textures embedded.' },
  { value: 'obj', ext: 'obj', rigged: false, label: 'OBJ (.obj)', hint: 'Posed shape and UVs only — no skeleton, animation or materials. Opens almost anywhere.' },
  { value: 'stl', ext: 'stl', rigged: false, label: 'STL (.stl)', hint: 'Posed shape only, no colours or UVs. Made for 3D printing and CAD.' },
  { value: 'ply', ext: 'ply', rigged: false, label: 'PLY (.ply)', hint: 'Posed shape with UVs and vertex colours, no skeleton or materials.' },
]

function download(blobOrUrl, filename, revokeAfterMs = 0) {
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  if (typeof blobOrUrl !== 'string') {
    if (revokeAfterMs) setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs)
    else URL.revokeObjectURL(url)
  }
}

// The current view as a PNG, at the Export panel's scale, with gizmos and helpers hidden.
export function saveImagePNG(name = 'render') {
  const restoreGizmos = hideGizmosForShot()
  let size = null
  try {
    size = exportPNG(useStore.getState().exportScale, name)
  } finally {
    restoreGizmos()
  }
  if (!size) return { ok: false, message: 'Could not save the image right now.' }
  return {
    ok: true,
    message: `Saved a ${size.width}×${size.height} PNG${size.clamped ? ' (reduced to what your GPU supports)' : ''}.`,
  }
}

// Every animation frame as a numbered PNG in one zip, in order — for programs that take an image
// sequence but can't paste several images. onProgress(frame, total) is optional.
export async function saveFramesZip(name = 'render', onProgress) {
  const s = useStore.getState()
  const fps = s.exportVideoFps
  const duration = getAllTimelineDuration({ stopAtFirstClipEnd: s.stopAtFirstClipEnd })
  if (!(duration > 0)) return { ok: false, message: 'Nothing to save — make or select an animation first.' }
  const frameCount = Math.ceil(duration * fps) + 1
  const digits = Math.max(5, String(frameCount).length)
  const prefix = name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'frame'
  const zip = createZip()
  const progressInterval = Math.max(1, Math.floor(frameCount / 100))
  onProgress?.(0, frameCount)
  const restoreGizmos = hideGizmosForShot()
  try {
    const result = await captureAnimationPNGs(fps, s.exportScale, async (blob, frame, total) => {
      await zip.add(`${prefix}_${String(frame + 1).padStart(digits, '0')}.png`, blob)
      if ((frame + 1) % progressInterval === 0 || frame + 1 === total) onProgress?.(frame + 1, total)
    })
    download(zip.finish(), `${prefix}_frames.zip`, 60000)
    return { ok: true, message: `Saved ${result.count} images at ${fps} fps as ${prefix}_frames.zip, numbered in order.` }
  } catch (error) {
    return { ok: false, message: `Could not save animation frames: ${error?.message || String(error)}` }
  } finally {
    restoreGizmos()
  }
}

// The current animation as a .bvh file.
export function saveBVH(name = 'render') {
  const s = useStore.getState()
  const text = exportAnimationBVH(s.animData, s.animFps, s.animDuration, s.activeClipName, s.playbackSource)
  if (!text) return { ok: false, message: 'Nothing to export — make an in-app animation first.' }
  download(new Blob([text], { type: 'text/plain' }), `${name}.bvh`)
  return { ok: true, message: 'Animation exported as .bvh.' }
}

// The whole scene as a 3D file. Pose / look / combine follow the Export panel's defaults unless given.
export async function saveSceneModel(format, name = 'scene', { poseMode, bakeLook = false, combineMeshes = false } = {}) {
  const info = MODEL_FORMATS.find((f) => f.value === format) || MODEL_FORMATS[0]
  const pose = poseMode || (info.rigged ? 'baked' : 'current')
  return exportSceneModel(info.value, name, pose, { bakeLook: info.rigged && bakeLook, combineMeshes })
}
