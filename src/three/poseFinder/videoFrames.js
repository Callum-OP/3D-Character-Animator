// Reads frames from a video file in the renderer and warps them into the 512px person crop the model wants.
import { CROP_SIZE } from './cropMath.js'

export async function openVideo(file) {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true
  video.src = url
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve
      video.onerror = () => reject(new Error('This video could not be opened. Try an MP4 (H.264) or WebM file.'))
    })
    if (!video.videoWidth || !video.videoHeight) throw new Error('This video has no picture track.')
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('This video has no usable duration.')
  } catch (err) {
    video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url)
    throw err
  }
  return {
    video,
    url,
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration,
    close() { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url) },
  }
}

export function seekTo(video, t) {
  return new Promise((resolve, reject) => {
    const target = Math.max(0, Math.min(t, (video.duration || t) - 0.001))
    if (Math.abs(video.currentTime - target) < 1e-4 && video.readyState >= 2) return resolve()
    const done = () => { video.removeEventListener('seeked', done); video.removeEventListener('error', fail); resolve() }
    const fail = () => { video.removeEventListener('seeked', done); video.removeEventListener('error', fail); reject(new Error('Seeking the video failed.')) }
    video.addEventListener('seeked', done)
    video.addEventListener('error', fail)
    video.currentTime = target
  })
}

// Draw the current frame through crop.affine into a CROP_SIZE x CROP_SIZE RGBA buffer (bilinear, zero border).
export function makeCropper() {
  const canvas = document.createElement('canvas')
  canvas.width = CROP_SIZE
  canvas.height = CROP_SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return (video, crop) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, CROP_SIZE, CROP_SIZE)
    const [a, , c, , e, f] = crop.affine
    ctx.setTransform(a, 0, 0, e, c, f) // x' = a*x + c, y' = e*y + f
    ctx.drawImage(video, 0, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    return new Uint8Array(ctx.getImageData(0, 0, CROP_SIZE, CROP_SIZE).data.buffer.slice(0))
  }
}
