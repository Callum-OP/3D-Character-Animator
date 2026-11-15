// Reads image/video frames in the renderer and warps them into the 512px person crop the model wants.
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

export async function openImage(file) {
  const url = URL.createObjectURL(file)
  const image = new Image()
  image.decoding = 'async'
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = () => reject(new Error('This image could not be opened. Try a PNG, JPEG, or WebP file.'))
      image.src = url
    })
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('This image has no usable dimensions.')
  } catch (err) {
    image.removeAttribute('src')
    URL.revokeObjectURL(url)
    throw err
  }
  return {
    image,
    url,
    width: image.naturalWidth,
    height: image.naturalHeight,
    duration: 1 / 30,
    close() { image.removeAttribute('src'); URL.revokeObjectURL(url) },
  }
}

const pendingSeeks = new WeakMap()

export function seekTo(video, t) {
  const seek = () => new Promise((resolve, reject) => {
    const target = Math.max(0, Math.min(t, (video.duration || t) - 0.001))
    const atTarget = () => !video.seeking && Math.abs(video.currentTime - target) < 1e-4 && video.readyState >= 2
    if (atTarget()) return resolve()
    const cleanup = () => {
      video.removeEventListener('seeked', done)
      video.removeEventListener('loadeddata', done)
      video.removeEventListener('canplay', done)
      video.removeEventListener('error', fail)
      video.removeEventListener('emptied', fail)
    }
    const done = () => { if (atTarget()) { cleanup(); resolve() } }
    const fail = () => { cleanup(); reject(new Error('Seeking the video failed.')) }
    video.addEventListener('seeked', done)
    video.addEventListener('loadeddata', done)
    video.addEventListener('canplay', done)
    video.addEventListener('error', fail)
    video.addEventListener('emptied', fail)
    try {
      if (Math.abs(video.currentTime - target) >= 1e-4) video.currentTime = target
    } catch (err) {
      cleanup()
      reject(err)
    }
  })
  const previous = pendingSeeks.get(video)
  const result = previous ? previous.then(seek, seek) : seek()
  pendingSeeks.set(video, result)
  result.then(
    () => { if (pendingSeeks.get(video) === result) pendingSeeks.delete(video) },
    () => { if (pendingSeeks.get(video) === result) pendingSeeks.delete(video) },
  )
  return result
}

// Draw the current frame through crop.affine into a CROP_SIZE x CROP_SIZE RGBA buffer (bilinear, zero border).
export function makeCropper() {
  const canvas = document.createElement('canvas')
  canvas.width = CROP_SIZE
  canvas.height = CROP_SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return (media, crop) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, CROP_SIZE, CROP_SIZE)
    const [a, , c, , e, f] = crop.affine
    ctx.setTransform(a, 0, 0, e, c, f) // x' = a*x + c, y' = e*y + f
    ctx.drawImage(media, 0, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    return new Uint8Array(ctx.getImageData(0, 0, CROP_SIZE, CROP_SIZE).data.buffer.slice(0))
  }
}
