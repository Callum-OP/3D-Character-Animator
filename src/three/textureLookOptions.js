// Look > Material: the controls, presets and the numbers they resolve to. No imports on purpose
// — the store uses this too — the shader and material code lives in textureLook.js.

// The Look > Material tab: changes what the SURFACES are made of — their textures, colours and
// finish — separately from the Lighting tab, which changes how they are lit. The two stack:
// Noir lighting plus Noir textures, Anime lighting plus a flat-colour floor, and so on.
//
// How it works. Every control reduces to a few numbers (resolveTextureLook), handed to a small
// shader hook installed on a PRIVATE copy of each material (the model's own materials are never
// touched, so "Original" always puts everything back exactly). The hook:
//   • reads the texture at a blurrier mip level  (smoothing / simplifying),
//   • snaps the texture lookup to a coarse grid   (pixelating),
//   • swaps the texture for its own average colour (flat colour — the average of what the mesh
//     actually shows of it, worked out on the CPU, so a texture atlas gives each part its own
//     colour rather than one muddy mix),
//   • then grades the colour: black & white, noir contrast, sepia, pastel, vivid / muted, and
//     snaps it to a few colour bands.
// Flattening bump maps and the matte / glossy / metallic finish are plain material properties.

export const TEXTURE_LOOK_DEFAULT = {
  preset: 'original',
  detail: 'full', // full | smooth | simplified | flat | regions
  colour: 'original', // original | bw | noir | sepia | pastel | vivid | muted | clay | manga
  bands: 0, // 0 = off, else the number of colour steps per channel
  pixels: 0, // 0 = off, else texture cells per unit (chunky = low)
  finish: 'original', // original | matte | satin | glossy | metallic  (every lit mode; not Flat colour lighting)
  bumps: 'keep', // keep | flatten
  strength: 1, // 0..1 blend between the model's own look and the treated one
  separation: 0.5, // 'Flat — keep shapes': how small a colour change still counts as a separate shape
  // Basic adjustments, on top of whatever colour option is chosen (0 = leave as it is)
  contrast: 0, // -1..1  (-1 halves the contrast, +1 doubles it)
  brightness: 0, // -1..1
  saturation: 0, // -1..1  (-1 = no colour, +1 = twice as colourful)
  tint: '#ffffff', // a colour to paint the whole look in (keeps the light and dark of the texture)
  tintAmount: 0, // 0..1
  scope: 'all', // all | characters | objects
}

export const DETAIL_OPTIONS = [
  { value: 'full', label: 'Full detail', hint: 'The textures exactly as the model came', bias: 0 },
  { value: 'smooth', label: 'Smoothed', hint: 'Fine grain, noise and scratches blurred away', bias: 2.5 },
  { value: 'simplified', label: 'Simplified', hint: 'Only the big shapes and colours remain — a detailed wood floor becomes soft brown patches', bias: 5 },
  { value: 'flat', label: 'Flat colour', hint: 'Every textured surface becomes one plain colour, its own average — a wood floor becomes a plain brown floor' },
  { value: 'regions', label: 'Flat — keep shapes', hint: 'Flat colours, but clearly different colours inside a texture stay separate — windows on a wall, figures in a painting. Subtle variation (wood grain, dirt) still flattens away. Adjust with Shape sensitivity.', bias: 1.5 },
]
export const COLOUR_OPTIONS = [
  { value: 'original', label: 'Original colours' },
  { value: 'bw', label: 'Black & white', hint: 'Textures stay, colour goes' },
  { value: 'noir', label: 'Noir', hint: 'Black & white with deep, punchy contrast' },
  { value: 'sepia', label: 'Sepia', hint: 'Old-photograph brown tones' },
  { value: 'pastel', label: 'Pastel', hint: 'Soft, washed, milky colours' },
  { value: 'vivid', label: 'Vivid', hint: 'Richer, more saturated colours' },
  { value: 'muted', label: 'Muted', hint: 'Dusty, desaturated colours' },
  { value: 'clay', label: 'Clay grey', hint: 'Every surface becomes one plain grey, like an untextured clay model — only the lighting shows the shapes' },
  { value: 'manga', label: 'Manga', hint: 'Everything bright snow white; only very dark colours get pencil-grey hatching' },
]
export const BAND_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 2, label: '2 tones' },
  { value: 3, label: '3 tones' },
  { value: 4, label: '4 tones' },
  { value: 5, label: '5 tones' },
  { value: 6, label: '6 tones' },
  { value: 8, label: '8 tones' },
  { value: 10, label: '10 tones' },
  { value: 12, label: '12 tones' },
]
export const PIXEL_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 16, label: 'Chunky' },
  { value: 32, label: 'Medium' },
  { value: 64, label: 'Fine' },
]
export const FINISH_OPTIONS = [
  { value: 'original', label: 'Original' },
  { value: 'matte', label: 'Matte', hint: 'No shine at all — clay, chalk, paper' },
  { value: 'satin', label: 'Satin', hint: 'A soft, even sheen' },
  { value: 'glossy', label: 'Glossy', hint: 'Shiny plastic or varnish, with a bright highlight' },
  { value: 'metallic', label: 'Metallic', hint: 'Brushed metal, with a banded sky reflection' },
]
export const BUMP_OPTIONS = [
  { value: 'keep', label: 'Keep' },
  { value: 'flatten', label: 'Flatten', hint: 'Remove the fake surface relief from normal / bump maps' },
]
export const SCOPE_OPTIONS = [
  { value: 'all', label: 'Everything' },
  { value: 'characters', label: 'Characters only' },
  { value: 'objects', label: 'Objects & scenery only' },
]

const FINISH_VALUES = {
  matte: { roughness: 1, metalness: 0 },
  satin: { roughness: 0.55, metalness: 0 },
  glossy: { roughness: 0.15, metalness: 0 },
  metallic: { roughness: 0.32, metalness: 0.9 },
}
// The same finishes for the toon-style lighting modes, which have no real shine of their own:
// they are drawn as stylised highlights by the toon surface shader (see surfaceMaterials.js).
const FINISH_TOON_VALUES = {
  matte: { roughness: 1, metalness: 0, specularIntensity: 0 },
  satin: { roughness: 0.55, metalness: 0, specularIntensity: 0.6 },
  glossy: { roughness: 0.15, metalness: 0, specularIntensity: 1, clearcoat: 0.5 },
  metallic: { roughness: 0.32, metalness: 0.9, specularIntensity: 1, envMapIntensity: 1 },
}

// One-click starting points. Every field they set is an ordinary control afterwards.
// The ORDER is the layout, four to a row:
//   Original | Flat colour | Cel Paint | Anime
//   Toon Smoothed | Pixel | Flat Pixel | Retro
//   Clay | Manga | Noir Ink | Noir
export const TEXTURE_LOOK_PRESETS = [
  { id: 'original', label: 'Original', hint: "The model's own textures and colours, untouched.", config: {} },
  { id: 'flat', label: 'Flat colour', hint: 'Every textured surface becomes one plain colour — a wood floor becomes a plain brown floor.', config: { detail: 'flat', bumps: 'flatten' } },
  { id: 'cel', label: 'Cel Paint', hint: 'Simplified textures in clean, rich colours with 12 fine tones, at full strength.', config: { detail: 'simplified', colour: 'vivid', bands: 12, pixels: 0, bumps: 'flatten', finish: 'matte' } },
  { id: 'anime', label: 'Anime', hint: 'Flat, vivid colours that keep every clearly different shape (sensitivity 0%), no tone steps, matte (70%).', config: { detail: 'regions', separation: 0, colour: 'vivid', bands: 0, pixels: 0, bumps: 'flatten', finish: 'matte', strength: 0.7 } },
  { id: 'toonsmooth', label: 'Toon Smoothed', hint: 'Simplified textures in clean, rich colours with 8 soft tones — painted rather than photographed (70%).', config: { detail: 'simplified', colour: 'vivid', bands: 8, pixels: 0, bumps: 'flatten', finish: 'matte', strength: 0.7 } },
  { id: 'pixel', label: 'Pixel', hint: 'Chunky, blocky low-resolution textures.', config: { pixels: 16 } },
  { id: 'flatpixel', label: 'Flat Pixel', hint: 'Chunky pixels in flat colours that keep their shapes.', config: { detail: 'regions', pixels: 16 } },
  { id: 'retro', label: 'Retro', hint: 'Medium-resolution textures in a limited palette — an old 3D game.', config: { pixels: 32, bands: 8, bumps: 'flatten' } },
  { id: 'clay', label: 'Clay', hint: 'Everything one plain grey, no shine, no surface relief — an untextured clay-model render.', config: { colour: 'clay', finish: 'matte', bumps: 'flatten' } },
  { id: 'manga', label: 'Manga', hint: 'Bright snow-white paper; only the very darkest areas get pencil-grey hatching.', config: { detail: 'smooth', colour: 'manga', finish: 'matte', bumps: 'flatten' } },
  { id: 'noirink', label: 'Noir Ink', hint: 'Black & white pushed to a few hard tones, like a graphic-novel panel.', config: { detail: 'smooth', colour: 'noir', bands: 6 } },
  { id: 'noir', label: 'Noir', hint: 'The textures stay, but the colour is only black, white and grey, with deep contrast.', config: { colour: 'noir' } },
]

// The controls that make up a look (so a preset is "everything default, plus these").
const CONTROL_KEYS = ['detail', 'colour', 'bands', 'pixels', 'finish', 'bumps', 'contrast', 'brightness', 'saturation', 'tintAmount']

export function presetLook(id, current = TEXTURE_LOOK_DEFAULT) {
  const preset = TEXTURE_LOOK_PRESETS.find((p) => p.id === id) || TEXTURE_LOOK_PRESETS[0]
  // A preset is a whole look, so it sets everything — strength (full unless it says otherwise), shape
  // sensitivity and the colour adjustments back to their defaults too. Only where it applies
  // (Everything / Characters / Objects) is the person's own choice, which a preset leaves alone.
  const base = { ...TEXTURE_LOOK_DEFAULT, scope: current.scope || 'all' }
  return { ...base, ...preset.config, preset: preset.id }
}

// Anything that is not "leave the textures alone"?
export function isTextureLookActive(look) {
  if (!look) return false
  if ((look.strength ?? 1) <= 0) return false
  return CONTROL_KEYS.some((k) => look[k] !== TEXTURE_LOOK_DEFAULT[k])
}

const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, typeof v === 'number' && Number.isFinite(v) ? v : 0))
const HEX = /^#[0-9a-fA-F]{6}$/
// '#rrggbb' -> [r, g, b] in 0..1 (as written, i.e. display space); white if it isn't a colour.
function hexToRgb(hex) {
  const h = typeof hex === 'string' && HEX.test(hex) ? hex : '#ffffff'
  return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]
}

// A look from somewhere untrusted or older (saved settings, a project file): every field present,
// of the right kind, in range. Anything missing takes its default, so adding a control never
// breaks what was saved before it existed.
export function normalizeMaterialLook(input) {
  const src = input && typeof input === 'object' ? input : {}
  const d = TEXTURE_LOOK_DEFAULT
  const pick = (key, options) => (options.some((o) => o.value === src[key]) ? src[key] : d[key])
  return {
    preset: typeof src.preset === 'string' ? src.preset : d.preset,
    detail: pick('detail', DETAIL_OPTIONS),
    colour: pick('colour', COLOUR_OPTIONS),
    bands: pick('bands', BAND_OPTIONS),
    pixels: pick('pixels', PIXEL_OPTIONS),
    finish: pick('finish', FINISH_OPTIONS),
    bumps: pick('bumps', BUMP_OPTIONS),
    scope: pick('scope', SCOPE_OPTIONS),
    strength: src.strength === undefined ? d.strength : clampN(src.strength, 0, 1),
    separation: src.separation === undefined ? d.separation : clampN(src.separation, 0, 1),
    contrast: clampN(src.contrast, -1, 1),
    brightness: clampN(src.brightness, -1, 1),
    saturation: clampN(src.saturation, -1, 1),
    tint: typeof src.tint === 'string' && HEX.test(src.tint) ? src.tint.toLowerCase() : d.tint,
    tintAmount: clampN(src.tintAmount, 0, 1),
  }
}

// What the look means for one kind of thing ('character' | 'object'): null when it should be
// left alone, else the plain numbers the materials are given.
export function resolveTextureLook(look, kind) {
  if (!isTextureLookActive(look)) return null
  if (look.scope === 'characters' && kind !== 'character') return null
  if (look.scope === 'objects' && kind !== 'object') return null
  const s = Math.max(0, Math.min(1, look.strength ?? 1))
  const detail = DETAIL_OPTIONS.find((d) => d.value === look.detail) || DETAIL_OPTIONS[0]
  const colour = look.colour
  return {
    strength: s,
    bias: (detail.bias || 0) * s,
    flat: detail.value === 'flat' ? s : 0,
    regions: detail.value === 'regions' ? s : 0, // flat colours that keep clearly different colours apart
    // How far apart two colours must be (display-space RGB distance) to stay separate: from
    // "only very obvious changes" (0.40) down to "even fairly subtle ones" (0.12).
    threshold: 0.4 - 0.28 * Math.max(0, Math.min(1, look.separation ?? 0.5)),
    bands: look.bands || 0,
    pixels: look.pixels || 0,
    grey: colour === 'bw' || colour === 'noir' ? 1 : 0,
    contrast: (colour === 'noir' ? 1.7 : 1) * Math.pow(2, clampN(look.contrast, -1, 1)),
    brightness: clampN(look.brightness, -1, 1),
    tintAmount: clampN(look.tintAmount, 0, 1),
    tint: hexToRgb(look.tint),
    sepia: colour === 'sepia' ? 1 : 0,
    pastel: colour === 'pastel' ? 1 : 0,
    saturation: (colour === 'vivid' ? 1.6 : colour === 'muted' ? 0.5 : 1) * Math.max(0, 1 + clampN(look.saturation, -1, 1)),
    clay: colour === 'clay' ? 1 : 0,
    manga: colour === 'manga' ? 1 : 0,
    finish: FINISH_VALUES[look.finish] || null,
    finishToon: FINISH_TOON_VALUES[look.finish] || null,
    flatten: look.bumps === 'flatten',
  }
}

