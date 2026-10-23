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
  detail: 'full', // full | smooth | simplified | flat
  colour: 'original', // original | bw | noir | sepia | pastel | vivid | muted
  bands: 0, // 0 = off, else the number of colour steps per channel
  pixels: 0, // 0 = off, else texture cells per unit (chunky = low)
  finish: 'original', // original | matte | satin | glossy | metallic  (Studio / Realistic only)
  bumps: 'keep', // keep | flatten
  strength: 1, // 0..1 blend between the model's own look and the treated one
  scope: 'all', // all | characters | objects
}

export const DETAIL_OPTIONS = [
  { value: 'full', label: 'Full detail', hint: 'The textures exactly as the model came', bias: 0 },
  { value: 'smooth', label: 'Smoothed', hint: 'Fine grain, noise and scratches blurred away', bias: 2.5 },
  { value: 'simplified', label: 'Simplified', hint: 'Only the big shapes and colours remain — a detailed wood floor becomes soft brown patches', bias: 5 },
  { value: 'flat', label: 'Flat colour', hint: 'Every textured surface becomes one plain colour, its own average — a wood floor becomes a plain brown floor' },
]
export const COLOUR_OPTIONS = [
  { value: 'original', label: 'Original colours' },
  { value: 'bw', label: 'Black & white', hint: 'Textures stay, colour goes' },
  { value: 'noir', label: 'Noir', hint: 'Black & white with deep, punchy contrast' },
  { value: 'sepia', label: 'Sepia', hint: 'Old-photograph brown tones' },
  { value: 'pastel', label: 'Pastel', hint: 'Soft, washed, milky colours' },
  { value: 'vivid', label: 'Vivid', hint: 'Richer, more saturated colours' },
  { value: 'muted', label: 'Muted', hint: 'Dusty, desaturated colours' },
]
export const BAND_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 3, label: '3 tones' },
  { value: 4, label: '4 tones' },
  { value: 6, label: '6 tones' },
  { value: 8, label: '8 tones' },
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
  { value: 'glossy', label: 'Glossy', hint: 'Shiny plastic or varnish' },
  { value: 'metallic', label: 'Metallic', hint: 'Brushed metal (looks best with Environment lighting on)' },
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

// One-click starting points. Every field they set is an ordinary control afterwards.
export const TEXTURE_LOOK_PRESETS = [
  { id: 'original', label: 'Original', hint: "The model's own textures and colours, untouched.", config: {} },
  { id: 'simplified', label: 'Simplified', hint: 'Textures reduced to their big shapes and colours.', config: { detail: 'simplified' } },
  { id: 'flat', label: 'Flat colours', hint: 'Every textured surface becomes one plain colour — a wood floor becomes a brown floor.', config: { detail: 'flat', bumps: 'flatten' } },
  { id: 'clay', label: 'Clay', hint: 'Plain colours, no shine, no surface relief — a clay-model render.', config: { detail: 'flat', colour: 'muted', finish: 'matte', bumps: 'flatten' } },
  { id: 'noir', label: 'Noir', hint: 'The textures stay, but the colour is only black, white and grey, with deep contrast.', config: { colour: 'noir' } },
  { id: 'noirink', label: 'Noir Ink', hint: 'Black & white pushed to a few hard tones, like a graphic-novel panel.', config: { detail: 'smooth', colour: 'noir', bands: 3 } },
  { id: 'anime', label: 'Anime', hint: 'Smoother textures in a few clean, slightly richer colours — painted rather than photographed.', config: { detail: 'smooth', colour: 'vivid', bands: 6, bumps: 'flatten', finish: 'matte' } },
  { id: 'cel', label: 'Cel Paint', hint: 'Bold flat paint areas with only a few tones, like hand-painted animation backgrounds.', config: { detail: 'simplified', colour: 'vivid', bands: 4, bumps: 'flatten', finish: 'matte' } },
  { id: 'pastel', label: 'Pastel', hint: 'Smooth, soft, milky colours.', config: { detail: 'smooth', colour: 'pastel', bumps: 'flatten', finish: 'matte' } },
  { id: 'sepia', label: 'Sepia', hint: 'Old-photograph brown tones, textures kept.', config: { colour: 'sepia' } },
  { id: 'retro', label: 'Retro', hint: 'Chunky low-resolution textures in a limited palette — an old 3D game.', config: { pixels: 32, bands: 8, bumps: 'flatten' } },
  { id: 'vivid', label: 'Vivid', hint: 'The same textures with richer colour.', config: { colour: 'vivid' } },
]

// The controls that make up a look (so a preset is "everything default, plus these").
const CONTROL_KEYS = ['detail', 'colour', 'bands', 'pixels', 'finish', 'bumps']

export function presetLook(id, current = TEXTURE_LOOK_DEFAULT) {
  const preset = TEXTURE_LOOK_PRESETS.find((p) => p.id === id) || TEXTURE_LOOK_PRESETS[0]
  const base = { ...TEXTURE_LOOK_DEFAULT, strength: current.strength ?? 1, scope: current.scope || 'all' }
  return { ...base, ...preset.config, preset: preset.id }
}

// Anything that is not "leave the textures alone"?
export function isTextureLookActive(look) {
  if (!look) return false
  if ((look.strength ?? 1) <= 0) return false
  return CONTROL_KEYS.some((k) => look[k] !== TEXTURE_LOOK_DEFAULT[k])
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
    bands: look.bands || 0,
    pixels: look.pixels || 0,
    grey: colour === 'bw' || colour === 'noir' ? 1 : 0,
    contrast: colour === 'noir' ? 1.7 : 1,
    sepia: colour === 'sepia' ? 1 : 0,
    pastel: colour === 'pastel' ? 1 : 0,
    saturation: colour === 'vivid' ? 1.6 : colour === 'muted' ? 0.5 : 1,
    finish: FINISH_VALUES[look.finish] || null,
    flatten: look.bumps === 'flatten',
  }
}

