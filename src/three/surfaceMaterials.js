import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Per-material "look" editing.
//
// A mesh can carry several materials (a character's jacket, buttons and lining on one
// mesh, say). The per-mesh override map (store.meshOverrides[uuid]) gets an optional
//
//     slots: { [materialIndex]: SlotLook }
//
// that changes ONE material of that mesh, leaving the others — and the whole-mesh
// colour — alone. A SlotLook may hold:
//
//   color / solid        recolour this material (tint the texture, or replace it)
//   replace              { from, to, range, softness } — swap one colour *inside* the
//                        texture for another (all the red → blue), keeping its shading
//   roughness, metalness, clearcoat, clearcoatRoughness, sheen, sheenRoughness,
//   sheenColor, transmission, ior, thickness, iridescence, specularIntensity,
//   emissive, emissiveIntensity, envMapIntensity, normalStrength, opacity
//                        how light reacts to it (glossy, metallic, cloth, glass, glow…)
//
// Everything is non-destructive: the loaded materials are never mutated. Slots that
// need PBR properties get their own MeshPhysicalMaterial copy (see buildPhysical);
// the surface properties only show in Studio / Realistic modes (the toon and unlit
// modes ignore lighting by design), but colour and colour-replace work in every mode.
// ---------------------------------------------------------------------------

export const SURFACE_KEYS = [
  'roughness', 'metalness', 'clearcoat', 'clearcoatRoughness',
  'sheen', 'sheenRoughness', 'sheenColor',
  'transmission', 'ior', 'thickness', 'iridescence', 'specularIntensity',
  'emissive', 'emissiveIntensity', 'envMapIntensity', 'normalStrength', 'opacity',
]

// Slider definitions (UI + clamping live in one place).
export const SURFACE_CONTROLS = [
  { key: 'roughness', label: 'Roughness', min: 0, max: 1, step: 0.01, hint: 'Low = shiny and mirror-like, high = matte' },
  { key: 'metalness', label: 'Metalness', min: 0, max: 1, step: 0.01, hint: 'How much it behaves like bare metal' },
  { key: 'specularIntensity', label: 'Highlights', min: 0, max: 1, step: 0.01, hint: 'Strength of the shiny reflections on non-metals' },
  { key: 'clearcoat', label: 'Clear coat', min: 0, max: 1, step: 0.01, hint: 'A glossy lacquer layer on top (car paint, varnish)' },
  { key: 'clearcoatRoughness', label: 'Coat roughness', min: 0, max: 1, step: 0.01 },
  { key: 'sheen', label: 'Cloth sheen', min: 0, max: 1, step: 0.01, hint: 'Soft fuzzy glow at grazing angles (fabric, velvet)' },
  { key: 'sheenRoughness', label: 'Sheen softness', min: 0, max: 1, step: 0.01 },
  { key: 'transmission', label: 'Glass', min: 0, max: 1, step: 0.01, hint: 'See-through like glass (bends light behind it)' },
  { key: 'ior', label: 'Refraction (IOR)', min: 1, max: 2.333, step: 0.01, hint: 'Water 1.33, glass 1.5, diamond 2.4' },
  { key: 'thickness', label: 'Glass thickness', min: 0, max: 3, step: 0.05 },
  { key: 'iridescence', label: 'Iridescence', min: 0, max: 1, step: 0.01, hint: 'Shifting rainbow film (pearl, soap bubble, oil)' },
  { key: 'emissiveIntensity', label: 'Glow strength', min: 0, max: 5, step: 0.05, hint: 'Makes it emit light of the glow colour' },
  { key: 'envMapIntensity', label: 'Reflections', min: 0, max: 3, step: 0.05, hint: 'How strongly the surroundings reflect in it' },
  { key: 'normalStrength', label: 'Bump strength', min: 0, max: 3, step: 0.05, hint: 'Strength of the model\'s normal map (if it has one)' },
  { key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
]

const ALL_NULL = Object.fromEntries(SURFACE_KEYS.map((k) => [k, null]))

// Presets set EVERY surface key (unset ones go back to the model's own value), so
// switching from one to another never leaves leftovers behind. A preset may also carry
// a colour (metals) — the panel lets you choose whether that is applied.
const P = (label, values, extra = {}) => ({ label, values, ...extra })
export const SURFACE_PRESETS = {
  original: P('Original', {}, { title: 'The surface the model came with' }),
  matte: P('Matte', { roughness: 1, metalness: 0, specularIntensity: 0.25 }),
  plastic: P('Plastic', { roughness: 0.35, metalness: 0, specularIntensity: 1 }),
  glossy: P('Glossy', { roughness: 0.1, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.05, specularIntensity: 1 }),
  rubber: P('Rubber', { roughness: 0.95, metalness: 0, specularIntensity: 0.2 }),
  stone: P('Stone', { roughness: 0.9, metalness: 0, specularIntensity: 0.4, normalStrength: 1.4 }),
  leather: P('Leather', { roughness: 0.55, metalness: 0, clearcoat: 0.15, clearcoatRoughness: 0.5, specularIntensity: 0.6, normalStrength: 1.2 }),
  cotton: P('Cloth', { roughness: 1, metalness: 0, sheen: 0.6, sheenRoughness: 0.8, sheenColor: '#ffffff', specularIntensity: 0.15 }),
  velvet: P('Velvet', { roughness: 1, metalness: 0, sheen: 1, sheenRoughness: 0.4, sheenColor: '#ffffff', specularIntensity: 0 }),
  satin: P('Satin / silk', { roughness: 0.4, metalness: 0, sheen: 1, sheenRoughness: 0.25, sheenColor: '#ffffff', specularIntensity: 0.8 }),
  metal: P('Brushed metal', { roughness: 0.38, metalness: 1 }),
  chrome: P('Chrome', { roughness: 0.04, metalness: 1 }, { color: '#ffffff' }),
  gold: P('Gold', { roughness: 0.22, metalness: 1 }, { color: '#ffc94a' }),
  copper: P('Copper', { roughness: 0.28, metalness: 1 }, { color: '#e08a5c' }),
  carpaint: P('Car paint', { roughness: 0.35, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.03 }),
  pearl: P('Pearl', { roughness: 0.25, metalness: 0, iridescence: 1, clearcoat: 0.5, clearcoatRoughness: 0.1 }),
  glass: P('Glass', { roughness: 0.02, metalness: 0, transmission: 1, ior: 1.5, thickness: 0.5, specularIntensity: 1 }),
  ice: P('Ice / frosted', { roughness: 0.35, metalness: 0, transmission: 1, ior: 1.31, thickness: 0.8 }),
  glow: P('Glow', (ctx) => ({ roughness: 0.5, metalness: 0, emissive: ctx.color || '#ffffff', emissiveIntensity: 1.6 }), { title: 'Self-lit in its own colour' }),
}

// The patch to store for a preset: all keys, null where the preset says nothing.
export function presetPatch(id, ctx = {}, { withColor = true } = {}) {
  const preset = SURFACE_PRESETS[id]
  if (!preset) return null
  const values = typeof preset.values === 'function' ? preset.values(ctx) : preset.values
  const patch = { ...ALL_NULL, ...values, preset: id === 'original' ? null : id }
  if (withColor && preset.color) {
    patch.color = preset.color
    patch.solid = true
  }
  return patch
}

// True when a slot look needs lighting-model changes (so a MeshPhysicalMaterial copy).
export function hasSurface(look) {
  if (!look) return false
  return SURFACE_KEYS.some((k) => look[k] != null && k !== 'opacity')
}
export function hasReplace(look) {
  return !!(look && look.replace && look.replace.from && look.replace.to)
}
// Anything at all set on a slot.
export function hasLook(look) {
  return !!look && (look.color != null || hasReplace(look) || SURFACE_KEYS.some((k) => look[k] != null))
}
export function hasAnySlot(ov) {
  const slots = ov && ov.slots
  if (!slots) return false
  return Object.values(slots).some(hasLook)
}

// Merge a patch into a slot look; null / undefined removes a key. Returns null when the
// slot ends up empty. Pure, so the store and the tests share it.
export function mergeLook(look, patch) {
  const next = { ...(look || {}), ...patch }
  for (const k of Object.keys(next)) if (next[k] == null) delete next[k]
  if (next.color == null) delete next.solid
  if (next.replace && (!next.replace.from || !next.replace.to)) delete next.replace
  return Object.keys(next).length ? next : null
}

// ---------------------------------------------------------------------------
// Slot info for the UI (name, swatch, the model's own values for each control)
// ---------------------------------------------------------------------------
const slotInfo = new WeakMap() // mesh -> [{ name, color, base }]
const originalMats = new WeakMap() // mesh -> the model's own materials, as loaded (never mutated)
// The materials the mesh was loaded with — what to read texture colours from, whatever style
// (toon, unlit, restyled copies) the viewport is currently showing.
export function getOriginalMaterials(mesh) {
  return (mesh && originalMats.get(mesh)) || null
}

const hex = (c) => '#' + c.getHexString()
export function recordMaterialSlots(mesh, materials) {
  const list = Array.isArray(materials) ? materials : [materials]
  originalMats.set(mesh, Array.isArray(materials) ? materials.slice() : materials)
  slotInfo.set(
    mesh,
    list.map((m, i) => {
      const base = {
        roughness: m?.roughness ?? 0.8,
        metalness: m?.metalness ?? 0,
        specularIntensity: m?.specularIntensity ?? 1,
        clearcoat: m?.clearcoat ?? 0,
        clearcoatRoughness: m?.clearcoatRoughness ?? 0,
        sheen: m?.sheen ?? 0,
        sheenRoughness: m?.sheenRoughness ?? 1,
        transmission: m?.transmission ?? 0,
        ior: m?.ior ?? 1.5,
        thickness: m?.thickness ?? 0,
        iridescence: m?.iridescence ?? 0,
        emissiveIntensity: m?.emissiveIntensity ?? 1,
        envMapIntensity: m?.envMapIntensity ?? 1,
        normalStrength: m?.normalScale ? m.normalScale.x : 1,
        opacity: m?.opacity ?? 1,
      }
      return {
        name: (m && m.name) || `Material ${i + 1}`,
        color: m && m.color ? hex(m.color) : '#ffffff',
        emissive: m && m.emissive ? hex(m.emissive) : '#000000',
        textured: !!(m && m.map),
        base,
      }
    }),
  )
}
export function getMaterialSlots(mesh) {
  return (mesh && slotInfo.get(mesh)) || []
}

// ---------------------------------------------------------------------------
// The physical copy a styled slot renders with
// ---------------------------------------------------------------------------
// Which materials are OUR generated copies (safe to edit and dispose; never an original).
// A WeakSet, not userData: userData is cloned and written into exported files.
const styledCopies = new WeakSet()
const slotOpacityOn = new WeakSet()
export function markStyledCopy(mat) {
  styledCopies.add(mat)
  return mat
}

const COPY_PROPS = [
  'name', 'color', 'map', 'alphaMap', 'alphaTest', 'transparent', 'opacity', 'side', 'depthWrite', 'depthTest',
  'blending', 'vertexColors', 'flatShading', 'normalMap', 'normalMapType', 'bumpMap', 'bumpScale', 'aoMap',
  'aoMapIntensity', 'lightMap', 'lightMapIntensity', 'emissive', 'emissiveMap', 'emissiveIntensity', 'roughness',
  'roughnessMap', 'metalness', 'metalnessMap', 'envMap', 'envMapIntensity', 'displacementMap', 'displacementScale',
  'displacementBias', 'clearcoat', 'clearcoatMap', 'clearcoatRoughness', 'clearcoatRoughnessMap', 'sheen',
  'sheenColor', 'sheenRoughness', 'transmission', 'transmissionMap', 'thickness', 'thicknessMap', 'attenuationColor',
  'attenuationDistance', 'ior', 'iridescence', 'iridescenceIOR', 'specularIntensity', 'specularColor',
]

// Works from any source material — glTF gives MeshStandardMaterial, FBX gives Phong or
// Lambert — by copying whichever properties both sides have.
export function buildPhysical(src) {
  const m = new THREE.MeshPhysicalMaterial()
  for (const k of COPY_PROPS) {
    const v = src[k]
    if (v === undefined || v === null) continue
    if (m[k] && m[k].isColor && v.isColor) m[k].copy(v)
    else m[k] = v
  }
  if (src.normalScale && m.normalScale) m.normalScale.copy(src.normalScale)
  if (!src.isMeshStandardMaterial) {
    m.roughness = 0.8 // Phong / Lambert have no roughness
    m.metalness = 0
  }
  m.userData = {}
  m.needsUpdate = true
  return markStyledCopy(m)
}

function setMap(mat, key, value) {
  const next = value || null
  if ((mat[key] || null) !== next) {
    mat[key] = next
    mat.needsUpdate = true
  }
}

// Write a slot look onto a physical copy. Always sets every property (from the look or
// from the source), so removing a setting puts the model's own value back.
export function applySurface(mat, src, look) {
  const o = look || {}
  const pick = (k, base) => (o[k] != null ? o[k] : base)

  mat.roughness = pick('roughness', src.roughness ?? 0.8)
  mat.metalness = pick('metalness', src.metalness ?? 0)
  // An explicit slider value wins over the model's roughness / metalness textures.
  setMap(mat, 'roughnessMap', o.roughness != null ? null : src.roughnessMap)
  setMap(mat, 'metalnessMap', o.metalness != null ? null : src.metalnessMap)

  mat.clearcoat = pick('clearcoat', src.clearcoat ?? 0)
  mat.clearcoatRoughness = pick('clearcoatRoughness', src.clearcoatRoughness ?? 0)
  mat.sheen = pick('sheen', src.sheen ?? 0)
  mat.sheenRoughness = pick('sheenRoughness', src.sheenRoughness ?? 1)
  if (o.sheenColor) mat.sheenColor.set(o.sheenColor)
  else if (src.sheenColor) mat.sheenColor.copy(src.sheenColor)
  else mat.sheenColor.set('#000000')
  mat.transmission = pick('transmission', src.transmission ?? 0)
  mat.ior = THREE.MathUtils.clamp(pick('ior', src.ior ?? 1.5), 1, 2.333)
  mat.thickness = pick('thickness', src.thickness ?? 0)
  mat.iridescence = pick('iridescence', src.iridescence ?? 0)
  mat.specularIntensity = pick('specularIntensity', src.specularIntensity ?? 1)
  mat.envMapIntensity = pick('envMapIntensity', src.envMapIntensity ?? 1)

  if (o.emissive) mat.emissive.set(o.emissive)
  else if (src.emissive) mat.emissive.copy(src.emissive)
  else mat.emissive.set('#000000')
  mat.emissiveIntensity = pick('emissiveIntensity', src.emissiveIntensity ?? 1)

  const ns = pick('normalStrength', src.normalScale ? src.normalScale.x : 1)
  mat.normalScale.set(ns, ns)
}

// Opacity applies in every mode (it is not a lighting property). Returns true when it was
// just cleared, so the caller can re-run the transparency switch that owns `transparent`.
export function applyOpacity(mat, src, look) {
  if (look && look.opacity != null) {
    if (!mat.transparent) mat.needsUpdate = true
    mat.transparent = true
    mat.opacity = look.opacity
    slotOpacityOn.add(mat)
    return false
  }
  if (slotOpacityOn.has(mat)) {
    mat.opacity = src && src.opacity != null ? src.opacity : 1
    slotOpacityOn.delete(mat)
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Colour replace — swap one colour inside the texture for another
//
// Injected after the shader's colour chunk, so it sees (texture × tint) and runs before
// lighting: the replaced colour is lit, shaded and reflected like any other. It is
// chained onto whatever onBeforeCompile the material already has (the shadow system,
// the rim-light / style-grade hooks), so install it AFTER those. Hue shift for
// coloured sources; for grey / white / black sources it matches on brightness instead
// (so white shirt → red works).
// ---------------------------------------------------------------------------
const RECOLOR_KEY = 'charanim-recolor-v1'

const RECOLOR_GLSL = `
uniform vec3 rcFrom;
uniform vec3 rcTo;
uniform vec3 rcParams; // x: distance threshold, y: edge softness, z: on/off

vec3 rcToHsv( vec3 c ) {
  vec4 K = vec4( 0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0 );
  vec4 p = mix( vec4( c.bg, K.wz ), vec4( c.gb, K.xy ), step( c.b, c.g ) );
  vec4 q = mix( vec4( p.xyw, c.r ), vec4( c.r, p.yzx ), step( p.x, c.r ) );
  float d = q.x - min( q.w, q.y );
  float e = 1.0e-10;
  return vec3( abs( q.z + ( q.w - q.y ) / ( 6.0 * d + e ) ), d / ( q.x + e ), q.x );
}
vec3 rcFromHsv( vec3 c ) {
  vec4 K = vec4( 1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0 );
  vec3 p = abs( fract( c.xxx + K.xyz ) * 6.0 - K.www );
  return c.z * mix( K.xxx, clamp( p - K.xxx, 0.0, 1.0 ), c.y );
}
vec3 rcApply( vec3 col ) {
  if ( rcParams.z < 0.5 ) return col;
  vec3 a = rcToHsv( pow( max( col, vec3( 0.0 ) ), vec3( 0.4545 ) ) );
  vec3 f = rcToHsv( pow( rcFrom, vec3( 0.4545 ) ) );
  vec3 t = rcToHsv( pow( rcTo, vec3( 0.4545 ) ) );
  float dh = abs( a.x - f.x );
  dh = min( dh, 1.0 - dh );
  float chromaSrc = smoothstep( 0.08, 0.2, f.y );
  float dChroma = dh * 2.0 + abs( a.y - f.y ) * 0.6 + abs( a.z - f.z ) * 0.35;
  float dGrey = abs( a.z - f.z ) + max( a.y - f.y, 0.0 ) * 1.5;
  float d = mix( dGrey, dChroma, chromaSrc );
  // a nearly grey texel has no real hue: never let it match a coloured source
  d += ( 1.0 - smoothstep( 0.04, 0.15, a.y ) ) * chromaSrc;
  float mask = 1.0 - smoothstep( rcParams.x, rcParams.x + max( rcParams.y, 0.001 ), d );
  float h = mix( t.x, fract( a.x - f.x + t.x ), chromaSrc );
  float s = mix( clamp( a.y + t.y, 0.0, 1.0 ), clamp( a.y * t.y / max( f.y, 0.02 ), 0.0, 1.0 ), chromaSrc );
  float v = clamp( a.z * t.z / max( f.z, 0.05 ), 0.0, 1.0 );
  vec3 outc = pow( rcFromHsv( vec3( h, s, v ) ), vec3( 2.2 ) );
  return mix( col, outc, mask );
}
`

function hasRecolorHook(mat) {
  return typeof mat.customProgramCacheKey === 'function' && String(mat.customProgramCacheKey()).includes(RECOLOR_KEY)
}

function ensureRecolorUniforms(mat) {
  const u = mat.userData
  if (hasRecolorHook(mat) && u.recolorUniforms && u.recolorUniforms.rcFrom && u.recolorUniforms.rcFrom.value.isColor) {
    return u.recolorUniforms
  }
  // A clone keeps userData but not the hook (and serialised userData is not live uniforms),
  // so (re)build both together.
  const uniforms = {
    rcFrom: { value: new THREE.Color() },
    rcTo: { value: new THREE.Color() },
    rcParams: { value: new THREE.Vector3(0.2, 0.1, 0) },
  }
  u.recolorUniforms = uniforms
  const prevCompile = mat.onBeforeCompile
  const prevKey = mat.customProgramCacheKey
  mat.customProgramCacheKey = () => String(prevKey.call(mat)) + '|' + RECOLOR_KEY
  mat.onBeforeCompile = (shader, renderer) => {
    prevCompile.call(mat, shader, renderer)
    Object.assign(shader.uniforms, uniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + RECOLOR_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = rcApply( diffuseColor.rgb );')
  }
  mat.needsUpdate = true
  return uniforms
}

// Turn colour replace on / off / update it. Cheap when nothing changed.
export function applyColorReplace(mat, look) {
  const u = mat.userData
  if (!hasReplace(look)) {
    if (u.recolorUniforms && hasRecolorHook(mat)) u.recolorUniforms.rcParams.value.z = 0
    return
  }
  const uni = ensureRecolorUniforms(mat)
  uni.rcFrom.value.set(look.replace.from)
  uni.rcTo.value.set(look.replace.to)
  const range = look.replace.range != null ? look.replace.range : 0.4
  const soft = look.replace.softness != null ? look.replace.softness : 0.4
  uni.rcParams.value.set(0.04 + range * 0.5, 0.02 + soft * 0.35, 1)
}

// Is this a material generated for a styled slot (safe to dispose; never an original)?
export function isStyledCopy(mat) {
  return !!mat && styledCopies.has(mat)
}
export function hasSlotOpacity(mat) {
  return slotOpacityOn.has(mat)
}

// ---------------------------------------------------------------------------
// Toon / anime / soft styles — simulating the same surface settings
//
// The toon materials ignore real PBR, so the surface look is *faked* the way a cel
// artist would paint it, using the main light direction and view vector the rim-light
// hook already provides:
//   • roughness / highlights / metalness → a stepped (or, in Soft mode, airbrushed)
//     specular blob; metals also lose their diffuse and gain a banded sky reflection
//   • clear coat   → a second, small, hard white highlight
//   • cloth sheen  → a soft coloured fresnel edge
//   • iridescence  → a view-angle rainbow shift
//   • glass        → transparency (see toonOpacityLook) plus the highlights
//   • glow         → the toon material's emissive
// Chained onto the material's existing hooks (shadow, rim light), so install AFTER them.
// ---------------------------------------------------------------------------
const TOONSURF_KEY = 'charanim-toonsurf-v1'

const TOONSURF_GLSL = `
uniform vec4 tsA; // roughness, metalness, specular intensity, reflection intensity
uniform vec4 tsB; // clearcoat, sheen, iridescence, edge softness (0 hard .. 1 airbrushed)
uniform vec4 tsC; // sheen colour rgb, on/off
`
const TOONSURF_FRAG = `
if ( tsC.w > 0.5 ) {
  vec3 tsN = normalize( normal );
  vec3 tsV = normalize( vRimView );
  vec3 tsL = normalize( vRimLightDir );
  vec3 tsUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  vec3 tsBase = diffuseColor.rgb;
  float tsRough = tsA.x;
  float tsMetal = tsA.y;
  float tsNdv = clamp( dot( tsN, tsV ), 0.0, 1.0 );
  float tsFres = pow( 1.0 - tsNdv, 3.0 );
  float tsSoft = tsB.w;
  float tsLit = smoothstep( 0.0, 0.25, dot( tsN, tsL ) );

  // metals have no diffuse of their own
  outgoingLight *= mix( 1.0, 0.4, tsMetal );

  // banded reflection of an imaginary sky (metal, and a little for glossy things)
  vec3 tsR = reflect( -tsV, tsN );
  float tsSky = dot( tsR, tsUp ) * 0.5 + 0.5;
  float tsBand = smoothstep( 0.5 - 0.45 * tsSoft, 0.5 + 0.05 + 0.4 * tsSoft, tsSky );
  vec3 tsEnv = mix( vec3( 0.14, 0.16, 0.22 ), vec3( 1.0 ), tsBand );
  float tsReflAmt = ( tsMetal * ( 1.0 - tsRough * 0.6 ) + tsB.x * 0.15 ) * tsA.w;
  outgoingLight += tsBase * tsEnv * tsReflAmt;

  // main highlight
  vec3 tsH = normalize( tsL + tsV );
  float tsNh = max( dot( tsN, tsH ), 0.0 );
  float tsSp = pow( tsNh, mix( 420.0, 10.0, tsRough ) );
  tsSp = smoothstep( 0.5 - 0.45 * tsSoft, 0.55 + 0.4 * tsSoft, tsSp );
  float tsSpecAmt = clamp( tsA.z, 0.0, 1.0 ) * pow( 1.0 - tsRough, 1.5 ) * ( 1.0 + tsMetal * 0.5 );
  outgoingLight += tsSp * tsLit * tsSpecAmt * mix( vec3( 1.0 ), tsBase, tsMetal );

  // clear coat: small hard white glint
  float tsCc = smoothstep( 0.55 - 0.4 * tsSoft, 0.6 + 0.35 * tsSoft, pow( tsNh, 700.0 ) );
  outgoingLight += vec3( 1.0 ) * tsCc * tsLit * tsB.x * 0.9;

  // cloth sheen: soft coloured edge glow
  outgoingLight += tsC.rgb * tsB.y * tsFres * 0.7;

  // iridescence: rainbow shift with view angle
  vec3 tsRb = 0.5 + 0.5 * cos( 6.2832 * ( tsNdv * 1.5 + vec3( 0.0, 0.33, 0.67 ) ) );
  outgoingLight = mix( outgoingLight, outgoingLight * tsRb * 1.6, tsB.z * 0.6 * ( 0.3 + tsFres ) );
}
`

function hasToonSurfHook(mat) {
  return typeof mat.customProgramCacheKey === 'function' && String(mat.customProgramCacheKey()).includes(TOONSURF_KEY)
}

function ensureToonSurface(mat) {
  const u = mat.userData
  if (hasToonSurfHook(mat) && u.toonSurfUniforms && u.toonSurfUniforms.tsA && u.toonSurfUniforms.tsA.value.isVector4) {
    return u.toonSurfUniforms
  }
  const uniforms = {
    tsA: { value: new THREE.Vector4(0.8, 0, 1, 1) },
    tsB: { value: new THREE.Vector4(0, 0, 0, 0) },
    tsC: { value: new THREE.Vector4(1, 1, 1, 0) },
  }
  u.toonSurfUniforms = uniforms
  const prevCompile = mat.onBeforeCompile
  const prevKey = mat.customProgramCacheKey
  mat.customProgramCacheKey = () => String(prevKey.call(mat)) + '|' + TOONSURF_KEY
  mat.onBeforeCompile = (shader, renderer) => {
    prevCompile.call(mat, shader, renderer)
    Object.assign(shader.uniforms, uniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + TOONSURF_GLSL)
      .replace('#include <opaque_fragment>', TOONSURF_FRAG + '\n#include <opaque_fragment>')
  }
  mat.needsUpdate = true
  return uniforms
}

// The slot look as the toon renderer should see it: glass becomes transparency.
export function toonOpacityLook(look) {
  if (look && look.transmission > 0 && look.opacity == null) return { ...look, opacity: 1 - 0.65 * look.transmission }
  return look
}

// Apply (or switch off) the faked surface on a toon / soft material. `soft` = Soft
// anime mode, which airbrushes the highlight edges instead of cutting them hard.
export function applyToonSurface(mat, src, look, { soft = false } = {}) {
  const u = mat.userData
  if (!hasSurface(look)) {
    if (u.toonSurfUniforms && hasToonSurfHook(mat)) u.toonSurfUniforms.tsC.value.w = 0
    if (mat.emissive && src.emissive) {
      mat.emissive.copy(src.emissive)
      mat.emissiveIntensity = src.emissiveIntensity != null ? src.emissiveIntensity : 1
    }
    return
  }
  const uni = ensureToonSurface(mat)
  const o = look
  const base = (k, d) => (src[k] != null ? src[k] : d)
  uni.tsA.value.set(
    o.roughness != null ? o.roughness : base('roughness', 0.8),
    o.metalness != null ? o.metalness : base('metalness', 0),
    o.specularIntensity != null ? o.specularIntensity : 1,
    o.envMapIntensity != null ? o.envMapIntensity : 1,
  )
  uni.tsB.value.set(
    o.clearcoat != null ? o.clearcoat : 0,
    o.sheen != null ? o.sheen : 0,
    o.iridescence != null ? o.iridescence : 0,
    soft ? 1 : 0,
  )
  const sc = new THREE.Color(o.sheenColor || '#ffffff')
  uni.tsC.value.set(sc.r, sc.g, sc.b, 1)

  if (mat.emissive) {
    if (o.emissive) mat.emissive.set(o.emissive)
    else if (src.emissive) mat.emissive.copy(src.emissive)
    if (o.emissiveIntensity != null) mat.emissiveIntensity = o.emissiveIntensity
    else mat.emissiveIntensity = src.emissiveIntensity != null ? src.emissiveIntensity : 1
  }
  if (mat.normalMap && mat.normalScale) {
    const ns = o.normalStrength != null ? o.normalStrength : src.normalScale ? src.normalScale.x : 1
    mat.normalScale.set(ns, ns)
  }
}

// ---------------------------------------------------------------------------
// Regions — per-face looks (see regions.js)
//
// Each vertex carries a `regionId` (0 = none, 1..8). The fragment shader looks that up in
// small uniform tables: a colour (tint or solid fill), a glow, and optional roughness /
// metalness. Chained onto the material's other hooks like colour replace is, so install it
// AFTER the shadow / rim / style hooks. Roughness and metalness only exist in the PBR (Studio)
// shaders; colour and glow work in every style, including unlit.
// ---------------------------------------------------------------------------
const REGION_KEY = 'charanim-regions-v1'
export const REGION_SLOTS = 8

function hasRegionHook(mat) {
  return typeof mat.customProgramCacheKey === 'function' && String(mat.customProgramCacheKey()).includes(REGION_KEY)
}

function ensureRegionUniforms(mat) {
  const u = mat.userData
  if (hasRegionHook(mat) && u.regionUniforms && Array.isArray(u.regionUniforms.rgColor.value)) return u.regionUniforms
  const make = (fill) => ({ value: Array.from({ length: REGION_SLOTS }, () => new THREE.Vector4(...fill)) })
  const uniforms = { rgColor: make([1, 1, 1, 0]), rgGlow: make([0, 0, 0, 0]), rgSurf: make([-1, -1, 0, 0]) }
  u.regionUniforms = uniforms
  const prevCompile = mat.onBeforeCompile
  const prevKey = mat.customProgramCacheKey
  mat.customProgramCacheKey = () => String(prevKey.call(mat)) + '|' + REGION_KEY
  mat.onBeforeCompile = (shader, renderer) => {
    prevCompile.call(mat, shader, renderer)
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float regionId;\nvarying float vRegion;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vRegion = regionId;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vRegion;\nuniform vec4 rgColor[ ' + REGION_SLOTS + ' ];\nuniform vec4 rgGlow[ ' + REGION_SLOTS + ' ];\nuniform vec4 rgSurf[ ' + REGION_SLOTS + ' ];',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  int rgI = int( vRegion + 0.5 ) - 1;
  if ( rgI >= 0 ) {
    vec4 rgC = rgColor[ rgI ];
    if ( rgC.w > 1.5 ) diffuseColor.rgb = rgC.rgb;
    else if ( rgC.w > 0.5 ) diffuseColor.rgb *= rgC.rgb;
  }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  if ( rgI >= 0 && rgSurf[ rgI ].x >= 0.0 ) roughnessFactor = rgSurf[ rgI ].x;',
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n  if ( rgI >= 0 && rgSurf[ rgI ].y >= 0.0 ) metalnessFactor = rgSurf[ rgI ].y;',
      )
      .replace(
        '#include <opaque_fragment>',
        '  if ( rgI >= 0 ) outgoingLight += rgGlow[ rgI ].rgb * rgGlow[ rgI ].w;\n#include <opaque_fragment>',
      )
  }
  mat.needsUpdate = true
  return uniforms
}

const _rgColor = new THREE.Color()

// Feed a mesh's regions to one of its materials (a generated copy / shell, never a shared
// original). Passing none switches the effect off without recompiling.
export function applyRegionLooks(mat, regions) {
  const u = mat.userData
  const active = regions && regions.some((r) => r.look && (r.look.color || r.look.glow > 0 || r.look.roughness != null || r.look.metalness != null))
  if (!active) {
    if (u.regionUniforms && hasRegionHook(mat)) {
      for (let i = 0; i < REGION_SLOTS; i++) {
        u.regionUniforms.rgColor.value[i].set(1, 1, 1, 0)
        u.regionUniforms.rgGlow.value[i].set(0, 0, 0, 0)
        u.regionUniforms.rgSurf.value[i].set(-1, -1, 0, 0)
      }
    }
    return
  }
  const uni = ensureRegionUniforms(mat)
  for (let i = 0; i < REGION_SLOTS; i++) {
    const look = (regions[i] && regions[i].look) || {}
    if (look.color && (look.mode === 'solid' || look.mode === 'tint')) {
      _rgColor.set(look.color)
      uni.rgColor.value[i].set(_rgColor.r, _rgColor.g, _rgColor.b, look.mode === 'solid' ? 2 : 1)
    } else uni.rgColor.value[i].set(1, 1, 1, 0)
    if (look.glow > 0) {
      _rgColor.set(look.glowColor || look.color || '#ffffff')
      uni.rgGlow.value[i].set(_rgColor.r, _rgColor.g, _rgColor.b, look.glow)
    } else uni.rgGlow.value[i].set(0, 0, 0, 0)
    uni.rgSurf.value[i].set(look.roughness != null ? look.roughness : -1, look.metalness != null ? look.metalness : -1, 0, 0)
  }
}

export function hasRegions(ov) {
  return !!(ov && ov.regions && ov.regions.length)
}
