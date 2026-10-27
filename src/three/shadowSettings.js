// Shadow settings: the ONE place that defines what a shadow setup is.
//
// Everything about shadows lives in a single `shadows` object (store + project files):
//
//   enabled   master switch
//   quality   'blob' | 'low' | 'medium' | 'high' | 'ultra'
//             blob = a cheap soft circle under the character (no real shadow mapping);
//             the others set the shadow-map resolution and how many samples smooth the edge
//   size      size of the light in degrees (the "angle" of a sun light):
//             0 = razor-sharp, ~0.5 = the real sun, 3 = soft daylight, 15+ = big softbox
//   contact   true  = contact-hardening, like a real light: tack-sharp where an object
//                     touches the surface, softening the further the shadow falls
//             false = the same blur along the whole edge (stylised, anime-ish)
//   darkness  0 = invisible .. 1 = solid black
//   tint      colour the shadows take on (white = neutral). Hue only; darkness is separate
//
// The look is "realistic" by default. Styles are just named bundles of size / contact /
// darkness, so the active style is *derived* from the values (nudge a slider and the style
// reads "Custom"): there is no second piece of state to persist or get out of sync.
//
// Pure functions only (no GPU, no store) so everything here is unit-tested.

export const SHADOW_QUALITY = [
  { id: 'blob', label: 'Simple (blob)', mapSize: 0, taps: 0, lightSize: 0, maxBlur: 0, hint: 'A soft circle under the character. No real shadow mapping: the lightest option, but props and the environment cast nothing.' },
  { id: 'low', label: 'Low', mapSize: 1024, taps: 8, lightSize: 512, maxBlur: 20, hint: '1024 map, 8 samples. Lightest real shadows; edges look slightly coarse.' },
  { id: 'medium', label: 'Medium', mapSize: 2048, taps: 16, lightSize: 1024, maxBlur: 32, hint: '2048 map, 16 samples. Good for most scenes on modest GPUs.' },
  { id: 'high', label: 'High', mapSize: 4096, taps: 28, lightSize: 1024, maxBlur: 48, hint: '4096 map, 28 samples. Clean, smooth edges (default).' },
  { id: 'ultra', label: 'Ultra', mapSize: 8192, taps: 40, lightSize: 2048, maxBlur: 64, hint: '8192 map, 40 samples. Best quality; needs a strong GPU (about 256 MB of video memory).' },
]

export const DEFAULT_SHADOW_QUALITY = 'high'

// Size range for the slider, in degrees of the light's angular diameter.
export const MIN_SHADOW_SIZE = 0
export const MAX_SHADOW_SIZE = 30

export const DEFAULT_SHADOWS = Object.freeze({
  enabled: true,
  quality: DEFAULT_SHADOW_QUALITY,
  size: 3,
  contact: true,
  darkness: 0.55,
  tint: '#ffffff',
})

// Named bundles of size / contact / darkness. The first one is the default.
export const SHADOW_STYLES = [
  { id: 'realistic', label: 'Realistic', hint: 'Daylight: sharp where things touch the ground, softening with distance. The default.', size: 3, contact: true, darkness: 0.55 },
  { id: 'soft', label: 'Soft', hint: 'Overcast sky or a big softbox: wide, gentle shadows that still tighten at contact.', size: 12, contact: true, darkness: 0.5 },
  { id: 'hard', label: 'Hard sun', hint: 'Strong direct sun: crisp edges with only a hint of softness.', size: 0.6, contact: true, darkness: 0.7 },
  { id: 'dramatic', label: 'Dramatic', hint: 'Deep, dark shadows with a tight edge for moody shots.', size: 1.5, contact: true, darkness: 0.88 },
  { id: 'cel', label: 'Cel / anime', hint: 'A flat, crisp-edged shadow with an even edge, like hand-drawn shading.', size: 0, contact: false, darkness: 0.5 },
  { id: 'dreamy', label: 'Dreamy', hint: 'Very diffused, even, faint shadows for an airy, painterly look.', size: 22, contact: false, darkness: 0.32 },
]

export const DEFAULT_SHADOW_STYLE = 'realistic'

// Which shadow style each Look preset (STYLE_PRESETS in MaterialPanel.jsx) uses.
export const PRESET_SHADOW_STYLE = {
  'Flat Colour': 'cel',
  'Crisp Cel': 'cel',
  'Soft Anime': 'soft',
  'Hard Anime': 'cel',
  'Painterly': 'dreamy',
  'Realistic': 'realistic',
  'Studio': 'soft',
  'Cinematic': 'dramatic',
  'Ink Outline': 'cel',
  'Manga Panel': 'cel',
  'Pastel Glow': 'dreamy',
  'Noir Stage': 'dramatic',
}

export function getShadowStyle(id) {
  return SHADOW_STYLES.find((s) => s.id === id) || null
}

// The { size, contact, darkness } values for a style id ({} if unknown).
export function shadowStyleValues(id) {
  const s = getShadowStyle(id)
  return s ? { size: s.size, contact: s.contact, darkness: s.darkness } : {}
}

// Which style (if any) the current values correspond to. Quality, tint and the master
// switch are not part of a style, so they never affect this.
export function detectShadowStyle(shadows) {
  const sh = normalizeShadows(shadows)
  const hit = SHADOW_STYLES.find(
    (s) =>
      Math.abs(s.size - sh.size) < 0.05 &&
      Math.abs(s.darkness - sh.darkness) < 0.005 &&
      s.contact === sh.contact,
  )
  return hit ? hit.id : null
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const HEX = /^#[0-9a-f]{6}$/i

// Anything -> a complete, valid shadows object. Unknown / missing / out-of-range fields
// fall back to the defaults, so a half-written project or an old saved setting can never
// leave the renderer with NaNs.
export function normalizeShadows(input) {
  const src = input && typeof input === 'object' ? input : {}
  const d = DEFAULT_SHADOWS
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : d.enabled,
    quality: SHADOW_QUALITY.some((q) => q.id === src.quality) ? src.quality : d.quality,
    size: clamp(num(src.size, d.size), MIN_SHADOW_SIZE, MAX_SHADOW_SIZE),
    contact: typeof src.contact === 'boolean' ? src.contact : d.contact,
    darkness: clamp(num(src.darkness, d.darkness), 0, 1),
    tint: typeof src.tint === 'string' && HEX.test(src.tint) ? src.tint.toLowerCase() : d.tint,
  }
}

// ---------------------------------------------------------------------------
// Night mode: a dark wash over the whole scene, as if a huge object blocked the light.
//   enabled   on/off
//   strength  0 = no change .. 1 = black
//   tint      colour of the night (hue only, like shadow tint)
// Objects can opt out individually (see nightImmune in the object list).
// ---------------------------------------------------------------------------
// affectLights: whether the night also dims lights the person placed (point / spot lights). Off by
// default: a lamp should still shine in total darkness. (The main scene light is always part of the
// day/night wash.)
export const DEFAULT_NIGHT = Object.freeze({ enabled: false, strength: 0.6, tint: '#5b78d1', affectLights: false })

export function normalizeNight(input) {
  const src = input && typeof input === 'object' ? input : {}
  const d = DEFAULT_NIGHT
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : d.enabled,
    strength: clamp(typeof src.strength === 'number' && Number.isFinite(src.strength) ? src.strength : d.strength, 0, 1),
    tint: typeof src.tint === 'string' && HEX.test(src.tint) ? src.tint.toLowerCase() : d.tint,
    affectLights: typeof src.affectLights === 'boolean' ? src.affectLights : d.affectLights,
  }
}

// Old (pre-overhaul) flat settings -> the new object. Used when opening a project that was
// saved by the previous shadow system. The old 0..1 "softness" slider is mapped onto the new
// light size: the old realistic mode used tan(angle) = 0.004 + 0.26 * softness^2.
export function shadowsFromLegacy(old, base = DEFAULT_SHADOWS) {
  if (!old || typeof old !== 'object') return normalizeShadows(base)
  const hasAny = ['showShadow', 'shadowMapping', 'shadowSoftness', 'shadowStrength', 'shadowType', 'shadowTint', 'shadowQuality']
    .some((k) => old[k] !== undefined)
  if (!hasAny) return normalizeShadows(base)
  const out = { ...normalizeShadows(base) }
  if (typeof old.showShadow === 'boolean') out.enabled = old.showShadow
  if (old.shadowMapping === false) out.quality = 'blob'
  else if (SHADOW_QUALITY.some((q) => q.id === old.shadowQuality)) out.quality = old.shadowQuality
  if (typeof old.shadowStrength === 'number') out.darkness = old.shadowStrength
  if (typeof old.shadowTint === 'string') out.tint = old.shadowTint
  if (old.shadowType === 'uniform') out.contact = false
  if (typeof old.shadowSoftness === 'number' && Number.isFinite(old.shadowSoftness)) {
    const s = clamp(old.shadowSoftness, 0, 1)
    const tan = 0.004 + s * s * 0.26
    out.size = Math.round(((2 * Math.atan(tan) * 180) / Math.PI) * 10) / 10
  }
  return normalizeShadows(out)
}

// A saved project's `settings` -> the shadows object to apply, or null to leave the current
// setup alone. New projects carry `shadows`; projects saved by the previous shadow system carry
// loose showShadow / shadowSoftness / ... fields (converted, on top of `current`). The old
// faint 0.15 / 0.15 defaults were never a deliberate choice, so those two values are ignored.
export function shadowsFromProject(settings, current = DEFAULT_SHADOWS) {
  const st = settings && typeof settings === 'object' ? settings : {}
  if (st.shadows && typeof st.shadows === 'object') return normalizeShadows({ ...normalizeShadows(current), ...st.shadows })
  const legacy = { ...st }
  if (st.shadowDefaultsVersion == null) {
    if (legacy.shadowStrength === 0.15) delete legacy.shadowStrength
    if (legacy.shadowSoftness === 0.15) delete legacy.shadowSoftness
  }
  const keys = ['showShadow', 'shadowMapping', 'shadowSoftness', 'shadowStrength', 'shadowType', 'shadowTint', 'shadowQuality']
  if (!keys.some((k) => legacy[k] !== undefined)) return null
  return shadowsFromLegacy(legacy, current)
}

// Resolve a quality id to concrete numbers, clamped to what the GPU supports.
// Performance mode always drops to the lightest real-shadow setting.
export function resolveShadowQuality(id, { maxTextureSize = 8192, performance = false } = {}) {
  const wanted = SHADOW_QUALITY.find((q) => q.id === id) || SHADOW_QUALITY.find((q) => q.id === DEFAULT_SHADOW_QUALITY)
  const base = performance && wanted.id !== 'blob' ? SHADOW_QUALITY.find((q) => q.id === 'low') : wanted
  if (base.id === 'blob') return { id: 'blob', blob: true, mapSize: 0, taps: 0, lightSize: 0, maxBlur: 0 }
  const mapSize = Math.max(256, Math.min(base.mapSize, maxTextureSize || base.mapSize))
  return { id: base.id, blob: false, mapSize, taps: base.taps, lightSize: Math.min(base.lightSize, mapSize), maxBlur: base.maxBlur }
}

export const MIN_BLUR_TEXELS = 1 // edge anti-aliasing floor: even "exact" shadows are smoothed over ~1 texel

// tan of the light's angular RADIUS, from its angular size (diameter) in degrees.
export function lightTanFromSize(sizeDeg) {
  const s = clamp(Number.isFinite(sizeDeg) ? sizeDeg : DEFAULT_SHADOWS.size, MIN_SHADOW_SIZE, MAX_SHADOW_SIZE)
  return Math.tan(((s / 2) * Math.PI) / 180)
}

// A big, soft light needs a wide blur, and the blur is limited to `maxBlurCap` texels. On a
// huge shadow map that would silently cut a soft shadow short (it would stop getting softer
// past some distance). So when the light is large, use a smaller map instead: the blur then
// spans the same world width in fewer texels, the shadow keeps its full softness, it is much
// cheaper, and contact shadows still resolve to a centimetre or so. Returns the map size
// (a multiple of 256) to use for this quality + light size + shadow-camera width.
export function chooseShadowMapSize({ qualityMapSize, contact, size, half, modelRadius, maxBlurCap = 48 }) {
  if (!qualityMapSize) return 0
  const lightTan = lightTanFromSize(size)
  const scale = Math.max(modelRadius || 1, 0.5)
  const widest = lightTan * scale * (contact ? 1.5 : 0.6) // widest penumbra radius we want, world units
  const floorSize = Math.min(512, qualityMapSize)
  if (widest < 1e-6) return qualityMapSize
  const fits = (2 * Math.max(half, 1e-3) * Math.max(maxBlurCap, 2)) / widest
  const stepped = Math.floor(fits / 256) * 256
  return Math.max(floorSize, Math.min(qualityMapSize, stepped))
}

// Numbers for the key light's shadow filter.
//   contact      contact-hardening (true) or even blur (false)
//   size         light size in degrees (see above)
//   mapSize      shadow-map resolution in texels
//   taps         filter samples (from the quality)
//   maxBlurCap   largest blur radius the quality allows, in texels
//   half         half-width of the shadow camera (world units)
//   depthRange   far - near of the shadow camera (world units)
//   modelRadius  ~largest dimension of the scene subject (world units)
//   advanced     false when the custom shader filter is unavailable (plain blur fallback)
// Returns { radius, a: [taps, texelWorld, depthRange, minBlur], b: [maxBlur] }:
// `radius` goes to light.shadow.radius (negative = contact-hardening, the magnitude being
// tan of the light's angular radius), `a`/`b` fill the shared shadowFilterA / shadowFilterB
// uniforms read by the patched shader (see shadowDarkening.js).
export function computeShadowFilter({ contact, size, mapSize, taps, maxBlurCap = 48, half, depthRange, modelRadius, advanced = true }) {
  const lightTan = lightTanFromSize(size)
  const texelWorld = Math.max(1e-6, (2 * Math.max(half, 1e-3)) / Math.max(mapSize, 1))
  const scale = Math.max(modelRadius || 1, 0.5)
  const cap = Math.max(MIN_BLUR_TEXELS + 1, maxBlurCap)
  let radius
  let maxBlur
  if (!advanced) {
    // three's own filter (used only if the custom one could not be installed, e.g. a three.js
    // release whose shadow shader no longer matches): a plain positive blur, in texels.
    const blur = Math.min(cap, (lightTan * scale * 0.6) / texelWorld)
    radius = Math.max(1, blur)
    maxBlur = radius
  } else if (!contact) {
    // Even blur of a fixed WORLD width (so the look doesn't change with map resolution):
    // the penumbra a light this size makes ~0.6 model-heights away from its occluder.
    const blurWorld = lightTan * scale * 0.6
    radius = Math.min(cap, blurWorld / texelWorld)
    if (radius < 0.05) radius = 0
    maxBlur = Math.max(MIN_BLUR_TEXELS, radius)
  } else {
    // Tiny lights are just hard shadows with anti-aliasing: skip the blocker search.
    radius = lightTan < 1e-4 ? 0 : -lightTan
    // Widest penumbra worth searching for: an occluder up to ~1.5 model-sizes away.
    maxBlur = Math.min(cap, Math.max(2, (lightTan * scale * 1.5) / texelWorld))
  }
  return {
    radius,
    a: [Math.max(1, Math.min(48, taps || 16)), texelWorld, Math.max(depthRange || 1, 1e-3), MIN_BLUR_TEXELS],
    b: [maxBlur],
  }
}
