import { bvhInfo, bvhSingleFrame } from './bvhText.js'
import { thumbFromParsedBVH } from './poseThumb.js'

// ---------------------------------------------------------------------------
// The presets that ship with the app: every .bvh dropped into src/poseLibrary/
//
//   src/poseLibrary/body/       full-body poses        (frame 0 of the file is the pose)
//   src/poseLibrary/hand/       hand poses             (frame 0; one or both hands, with finger bones)
//   src/poseLibrary/animation/  animations             (the whole file)
//
// Sub-folders become categories (body/sitting/cross-legged.bvh -> category "sitting"), and the file name becomes
// the preset's name. Vite finds the files at build time, so there is no list to keep up to date.
// ---------------------------------------------------------------------------

const FILES = import.meta.glob('../poseLibrary/**/*.bvh', { query: '?url', import: 'default', eager: true })

export const KINDS = ['body', 'hand', 'animation']

function prettify(file) {
  return file
    .replace(/\.bvh$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

function buildPresets() {
  const out = []
  for (const [path, url] of Object.entries(FILES)) {
    const rel = path.slice(path.indexOf('poseLibrary/') + 'poseLibrary/'.length)
    const parts = rel.split('/')
    const kind = parts[0]
    if (!KINDS.includes(kind) || parts.length < 2) continue
    const file = parts[parts.length - 1]
    out.push({
      id: `preset:${rel}`,
      source: 'preset',
      kind,
      category: parts.slice(1, -1).map(prettify).join(' / '),
      name: prettify(file),
      url,
    })
  }
  return out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
}

let cached = null
export function listPresets(kind) {
  if (!cached) cached = buildPresets()
  return kind ? cached.filter((p) => p.kind === kind) : cached
}

// ---- Loading ----------------------------------------------------------------

const textCache = new Map()
let textCacheChars = 0
const TEXT_CACHE_LIMIT = 4_000_000

// The preset's BVH text. Small files are kept for the session; big animations are re-read from the browser cache.
export async function loadPresetText(preset) {
  if (textCache.has(preset.id)) return textCache.get(preset.id)
  const res = await fetch(preset.url)
  if (!res.ok) throw new Error(`Could not load the preset "${preset.name}" (${res.status}).`)
  const text = await res.text()
  if (text.length < 200_000 && textCacheChars + text.length < TEXT_CACHE_LIMIT) {
    textCache.set(preset.id, text)
    textCacheChars += text.length
  }
  return text
}

// The one-frame BVH to use for a body / hand preset (frame 0).
export async function loadPresetPoseText(preset) {
  return bvhSingleFrame(await loadPresetText(preset), 0)
}

// ---- Thumbnails -------------------------------------------------------------

const thumbs = new Map() // id -> Promise<{ segs, duration? }>

async function parseText(text, name) {
  const { BVHLoader } = await import('three/examples/jsm/loaders/BVHLoader.js')
  const result = new BVHLoader().parse(text)
  return { skeleton: result.skeleton, clip: result.clip, name }
}

// A stick-figure thumbnail (and, for animations, the duration) for a preset. Cached; failures give an empty thumbnail.
export function presetThumb(preset) {
  if (!thumbs.has(preset.id)) {
    thumbs.set(
      preset.id,
      (async () => {
        try {
          const text = await loadPresetText(preset)
          const info = bvhInfo(text)
          const mid = preset.kind === 'animation' && info ? Math.floor(info.frames / 2) : 0
          const parsed = await parseText(bvhSingleFrame(text, mid), preset.name)
          const thumb = thumbFromParsedBVH(parsed, preset.kind)
          return { ...thumb, duration: preset.kind === 'animation' && info ? info.duration : undefined }
        } catch {
          return { segs: [] }
        }
      })(),
    )
  }
  return thumbs.get(preset.id)
}

export function resetPresetCachesForTest() {
  cached = null
  textCache.clear()
  textCacheChars = 0
  thumbs.clear()
}
