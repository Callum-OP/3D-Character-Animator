// Pure helpers for export size / video encoding choices (no renderer needed,
// so they can be unit-tested directly).

// Resolution presets are named by the SHORT side, like video "1080p": 1080p is
// 1920×1080 at 16:9, 1080×1920 at 9:16 and 1080×1080 at 1:1.
export const RESOLUTIONS = {
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
  '4k': 2160,
  '8k': 4320,
}

export const ASPECTS = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1': [1, 1],
  '4:3': [4, 3],
  '21:9': [21, 9],
}

export const VIDEO_FPS = [24, 30, 60]
export const VIDEO_QUALITIES = ['standard', 'high', 'max']

// Largest side we will ask an encoder to handle. Browsers' hardware encoders
// generally top out at 4K–8K; images are only limited by the GPU.
export const MAX_VIDEO_SIDE = 7680

function even(n) {
  return Math.max(2, Math.floor(n / 2) * 2)
}

// Work out the output pixel size.
//   resolution: a RESOLUTIONS key, or 'viewport' (use the viewport's own size)
//   aspect:     an ASPECTS key, or 'viewport' (use the viewport's own shape)
//   maxSide:    the largest side the GPU/encoder can take; anything bigger is
//               scaled down (keeping the shape) and reported via `clamped`.
// Video needs even dimensions; `evenSizes` rounds down to even.
export function computeOutputSize({
  resolution,
  aspect = 'viewport',
  viewportW,
  viewportH,
  maxSide = 8192,
  evenSizes = true,
}) {
  const vw = Math.max(1, viewportW || 1)
  const vh = Math.max(1, viewportH || 1)
  const ratio = aspect === 'viewport' || !ASPECTS[aspect] ? vw / vh : ASPECTS[aspect][0] / ASPECTS[aspect][1]
  let width
  let height
  const short = RESOLUTIONS[resolution]
  if (!short) {
    width = vw
    height = vh
    if (aspect !== 'viewport' && ASPECTS[aspect]) {
      // "Match viewport" size with a forced shape: keep the viewport's area-ish short side.
      const s = Math.min(vw, vh)
      if (ratio >= 1) { height = s; width = s * ratio } else { width = s; height = s / ratio }
    }
  } else if (ratio >= 1) {
    height = short
    width = short * ratio
  } else {
    width = short
    height = short / ratio
  }
  width = Math.round(width)
  height = Math.round(height)
  const requested = { width, height }
  let clamped = false
  const longest = Math.max(width, height)
  if (longest > maxSide) {
    const k = maxSide / longest
    width = Math.floor(width * k)
    height = Math.floor(height * k)
    clamped = true
  }
  if (evenSizes) {
    width = even(width)
    height = even(height)
  }
  return { width, height, clamped, requested }
}

// Bits per pixel per frame for each quality tier. 'high' at 1080p30 ≈ 10 Mbps.
const BITS_PER_PIXEL = { standard: 0.08, high: 0.16, max: 0.3 }

export function videoBitrate({ width, height, fps, quality = 'high' }) {
  const bpp = BITS_PER_PIXEL[quality] ?? BITS_PER_PIXEL.high
  const bits = width * height * fps * bpp
  return Math.round(Math.min(120_000_000, Math.max(1_000_000, bits)))
}

const MP4_TYPES = [
  'video/mp4;codecs=avc1.640033', // H.264 High, level 5.1 (covers 4K)
  'video/mp4;codecs=avc1.4d0033',
  'video/mp4;codecs=avc1',
  'video/mp4',
]
const WEBM_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

// Choose a recorder mime type for the requested container, falling back to
// webm when mp4 isn't available. `isSupported` is MediaRecorder.isTypeSupported.
export function pickVideoFormat(requested, isSupported) {
  const ok = (t) => {
    try { return !!isSupported(t) } catch { return false }
  }
  if (requested === 'mp4') {
    const mp4 = MP4_TYPES.find(ok)
    if (mp4) return { mimeType: mp4, ext: 'mp4', blobType: 'video/mp4', fellBack: false }
  }
  const webm = WEBM_TYPES.find(ok)
  return {
    mimeType: webm || '',
    ext: 'webm',
    blobType: 'video/webm',
    fellBack: requested === 'mp4',
  }
}