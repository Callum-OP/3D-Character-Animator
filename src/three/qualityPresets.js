// Quality presets: one choice that sets how much memory and GPU time the app may use.
//
//   High       the best the app can do: textures as loaded, the project's own shadow quality, the sharpest viewport.
//   Standard   (default) about half the memory of High: 2048 px textures, medium shadows, a slightly lower viewport
//              resolution.
//   Low        for modest laptops: 1024 px textures, small shadow maps, native-resolution viewport, no edge smoothing,
//              30 fps playback, very dense meshes thinned on import.
//   Very low   for weak hardware: 512 px textures, a soft blob instead of real shadows, a reduced-resolution
//              viewport, 30 fps playback, dense meshes thinned harder, distant props hidden.
//
// A preset only sets ceilings. It never changes a project: the project's own shadow quality etc. are kept and
// are simply capped; textures and meshes are reduced as models come in (see textureImport.js), so a project
// re-opened under High is full quality again. Pure data and functions, so it is unit-tested.

export const QUALITY_PRESETS = [
  {
    id: 'high',
    label: 'High',
    hint: 'Best quality with no limitations. Uses the most memory.',
    textureMax: 0, // 0 = as loaded
    shadowCap: null, // null = whatever the project asks for
    pixelRatioCap: 1.5,
    msaa: true,
    frameCap: 0, // 0 = the display's own rate
    meshBudget: 0, // 0 = no limit (triangles per mesh when a model is imported)
    hideDistant: false,
  },
  {
    id: 'standard',
    label: 'Standard',
    hint: 'Looks nearly as good as High and uses much less memory and is therefore the default.',
    textureMax: 2048,
    shadowCap: 'medium',
    pixelRatioCap: 1.25,
    msaa: true,
    frameCap: 60,
    meshBudget: 0,
    hideDistant: false,
  },
  {
    id: 'low',
    label: 'Low',
    hint: 'Lower quality for weaker computers, still looking good but lowering memory usage significantly.',
    textureMax: 1024,
    shadowCap: 'low',
    pixelRatioCap: 1,
    msaa: false,
    frameCap: 30,
    meshBudget: 100000,
    hideDistant: false,
  },
  {
    id: 'verylow',
    label: 'Potato',
    hint: 'Lowest quality, for very weak computers or very limited memory, disables shadows.',
    textureMax: 512,
    shadowCap: 'blob',
    pixelRatioCap: 0.75,
    msaa: false,
    frameCap: 30,
    meshBudget: 40000,
    hideDistant: true,
  },
]

export const DEFAULT_QUALITY_PRESET = 'standard'

export function getQualityPreset(id) {
  return QUALITY_PRESETS.find((p) => p.id === id) || QUALITY_PRESETS.find((p) => p.id === DEFAULT_QUALITY_PRESET)
}

// The longest texture side allowed when a model is imported: the preset's, or the stricter of it and the
// user's own extra limit (Advanced). 0 = as loaded.
export function effectiveTextureMax(presetId, userMax = 0) {
  const caps = [getQualityPreset(presetId).textureMax, Number(userMax) || 0].filter((n) => n > 0)
  return caps.length ? Math.min(...caps) : 0
}

// Whether MSAA edge smoothing is on: the preset allows it AND the user has not turned it off (Advanced).
export function effectiveEdgeSmoothing(presetId, userOn = true) {
  return getQualityPreset(presetId).msaa && userOn !== false
}

// Milliseconds between frames for a frame-rate cap (0 = uncapped).
export function frameIntervalFor(presetId) {
  const cap = getQualityPreset(presetId).frameCap
  return cap > 0 ? 1000 / cap : 0
}

// The viewport's render scale for a screen: the device ratio, limited by the preset.
export function viewportPixelRatio(presetId, devicePixelRatio = 1) {
  return Math.min(devicePixelRatio || 1, getQualityPreset(presetId).pixelRatioCap)
}

const RANK = ['blob', 'low', 'medium', 'high', 'ultra']
export const shadowRank = (id) => Math.max(0, RANK.indexOf(id))
