import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Material modes + per-mesh shading overrides
//
// Blender node shaders can't be exported, but glTF carries the Principled BSDF
// data (baseColorFactor/Texture, emissive, alpha, …) which GLTFLoader turns into
// MeshStandardMaterial. This module offers three non-destructive "modes" that
// reuse that data:
//
//   unlit    — MeshBasicMaterial: raw base colour, zero lighting (the default).
//   toon     — MeshToonMaterial: same colour/map, lit through a procedural
//              stepped gradient ramp for anime-style shadow banding.
//   standard — the original MeshStandardMaterial(s) as loaded (PBR lighting).
//
// On top of the mode, two controls tame harsh shading (e.g. a hard shadow line
// across a face):
//   • soften (0..1)  — global: raises the toon shadow floor so shadows are
//                      lighter/flatter everywhere.
//   • per-mesh shading override — 'full' | 'soft' | 'flat':
//        soft  → gentler shadow ramp in toon mode.
//        flat  → this mesh ignores lighting entirely (unlit) in ANY mode. This
//                is how you kill shading on a specific part like the face.
//
// Originals are recorded once at load, so switching never destroys them.
// Generated materials are cached per mesh and disposed on unload. Textures are
// SHARED with the originals (never cloned), so only the material "shells" are
// disposed here — textures are freed once, with the originals, on unload.
// ---------------------------------------------------------------------------

// Extra shadow-lift applied to meshes flagged 'soft' (0 = full contrast, 1 =
// flat). Faces flagged soft never go darker than this.
const SOFT_FLOOR = 0.55

// Gradient ramp textures, cached by (step count, shadow floor) and shared across
// meshes/models. Each is only `steps x 1` px, so we keep them for the app's
// lifetime rather than rebuilding on every slider tick. The floor is quantised
// so dragging the soften slider reuses a bounded set of ramps.
const gradientCache = new Map()

// Soft (non-banded) ramps for the 'soft' anime mode — same idea but LinearFilter
// + a high sample count, so the diffuse term blends smoothly instead of
// stepping. This is what gives that gentle "soft-shaded anime" look (a wide,
// airbrushed shadow edge) instead of hard cel bands. Cached separately by floor.
const softGradientCache = new Map()

// Build a stepped grayscale ramp used as MeshToonMaterial.gradientMap. The toon
// shader samples this at (N·L * 0.5 + 0.5) and reads the red channel, so a small
// N-wide NearestFilter texture quantises the diffuse term into N hard bands.
// `floor` (0..1) lifts the darkest band toward white to soften/flatten shadows.
export function getGradientMap(steps, floor) {
  const fq = Math.round(floor * 20) / 20 // quantise to 0.05 to bound the cache
  const key = steps + ':' + fq
  if (gradientCache.has(key)) return gradientCache.get(key)

  const data = new Uint8Array(steps)
  const base = Math.round(fq * 255) // darkest band brightness
  for (let i = 0; i < steps; i++) {
    // Lerp from `base` (dark) to 255 (lit) across the ramp.
    const t = steps === 1 ? 1 : i / (steps - 1)
    data[i] = Math.round(base + (255 - base) * t)
  }

  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat)
  tex.minFilter = THREE.NearestFilter // hard steps, no blending between bands
  tex.magFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  // Leave colorSpace at its linear default: this is a math ramp, not sRGB colour.
  tex.needsUpdate = true

  gradientCache.set(key, tex)
  return tex
}

// Build a SMOOTH ramp (Linear-filtered, many samples) for 'soft' anime mode.
// `floor` still lifts the dark end, but there are no hard bands — the transition
// from lit to shadow is a gentle gradient, like typical soft-cel VTuber/anime
// shading rather than sharp manga cel bands.
function getSoftGradientMap(floor) {
  const fq = Math.round(floor * 20) / 20
  if (softGradientCache.has(fq)) return softGradientCache.get(fq)

  const steps = 64
  const data = new Uint8Array(steps)
  const base = Math.round(fq * 255)
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    // Ease the curve slightly (smoothstep) so the mid-tones linger a touch
    // longer, which reads as softer than a straight lerp.
    const e = t * t * (3 - 2 * t)
    data[i] = Math.round(base + (255 - base) * e)
  }

  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat)
  tex.minFilter = THREE.LinearFilter // smooth blend between samples
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true

  softGradientCache.set(fq, tex)
  return tex
}

// ---------------------------------------------------------------------------
// Rim light — a cheap fresnel-style edge highlight injected into the toon/soft
// shaders via onBeforeCompile. Helps stylised materials read against busy
// backgrounds and gives anime-style shading its characteristic glowing edge,
// without needing an extra scene light. The shader chunk is always present on
// toon/soft materials (cache key never changes); everything below is a live
// uniform so sliders update it without a shader recompile.
//
// Soft and Hard are two independent layers (not a single mode switch) — both
// can be on together, each with its own strength and width, then summed. A
// "Directional" mask can additionally restrict either layer to just the side
// of the silhouette that horizontally faces the key light (e.g. light coming
// from the right only lights the character's right edge), which reads as much
// less busy than the full-hemisphere default, especially on rounder meshes.
// ---------------------------------------------------------------------------

function installRimLight(material) {
  const u = material.userData
  u.rimColor = u.rimColor || new THREE.Color(0xffffff)
  u.rimLightDir = u.rimLightDir || new THREE.Vector3(0.3, 0.6, 0.7)
  u.rimSoftIntensity = u.rimSoftIntensity || 0
  u.rimSoftWidth = u.rimSoftWidth != null ? u.rimSoftWidth : 0.5
  u.rimHardIntensity = u.rimHardIntensity || 0
  u.rimHardWidth = u.rimHardWidth != null ? u.rimHardWidth : 0.35
  u.rimSideOnly = u.rimSideOnly || 0
  // Stable cache key: the injected code never changes, only the uniforms do,
  // so every toon/soft material can safely share one compiled program variant.
  material.customProgramCacheKey = () => 'charanim-rim-v4'
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rimColor = { value: u.rimColor }
    shader.uniforms.rimLightDir = { value: u.rimLightDir }
    shader.uniforms.rimSoftIntensity = { value: u.rimSoftIntensity }
    shader.uniforms.rimSoftWidth = { value: u.rimSoftWidth }
    shader.uniforms.rimHardIntensity = { value: u.rimHardIntensity }
    shader.uniforms.rimHardWidth = { value: u.rimHardWidth }
    shader.uniforms.rimSideOnly = { value: u.rimSideOnly }

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vRimView;\nvarying vec3 vRimLightDir;\nuniform vec3 rimLightDir;',
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vRimView = normalize( -mvPosition.xyz );
        // Light direction into view space, so it lines up with vNormal (also
        // view-space) regardless of the model's own rotation.
        vRimLightDir = normalize( ( viewMatrix * vec4( rimLightDir, 0.0 ) ).xyz );`,
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vRimView;
        varying vec3 vRimLightDir;
        uniform vec3 rimColor;
        uniform float rimSoftIntensity;
        uniform float rimSoftWidth;
        uniform float rimHardIntensity;
        uniform float rimHardWidth;
        uniform float rimSideOnly;`,
      )
      .replace(
        '#include <dithering_fragment>',
        `
        #ifdef USE_NORMALMAP
          vec3 rimNormal = normal;
        #else
          vec3 rimNormal = normalize( vNormal );
        #endif
        // View-dependent edge term (classic fresnel rim), 0 at fully facing the
        // camera, 1 right at the silhouette.
        float rimEdgeRaw = 1.0 - max( dot( vRimView, rimNormal ), 0.0 );
        // Gated so it only shows on the side of the model actually facing the
        // key light — a shoulder catches the glow, the far/shadowed side
        // doesn't, just like a real backlit rim highlight.
        float ndotl = dot( rimNormal, vRimLightDir );
        // Optional extra mask: only the horizontal side of the silhouette
        // that faces the light's left/right direction — e.g. a light coming
        // from the right only rims the character's right edge, not top/bottom
        // or the near-camera side too. Off by default (full hemisphere).
        float rimSide = 1.0;
        if ( rimSideOnly > 0.5 ) {
          float lightSideX = vRimLightDir.x >= 0.0 ? 1.0 : -1.0;
          rimSide = smoothstep( -0.15, 0.15, rimNormal.x * lightSideX );
        }
        // Soft layer: a smooth glow. Width widens the falloff exponent.
        float softExp = mix( 6.0, 1.0, clamp( rimSoftWidth, 0.0, 1.0 ) );
        float edgeSoft = pow( clamp( rimEdgeRaw, 0.0, 1.0 ), softExp );
        float litSoft = smoothstep( -0.2, 0.25, ndotl );
        float softTerm = edgeSoft * litSoft * rimSide * rimSoftIntensity;
        // Hard layer: a crisp thresholded line. Width widens the band inward
        // from the silhouette.
        float hardLo = mix( 0.85, 0.25, clamp( rimHardWidth, 0.0, 1.0 ) );
        float edgeHard = smoothstep( hardLo, hardLo + 0.08, rimEdgeRaw );
        float litHard = smoothstep( -0.05, 0.05, ndotl );
        float hardTerm = edgeHard * litHard * rimSide * rimHardIntensity;
        gl_FragColor.rgb += rimColor * ( softTerm + hardTerm );
        #include <dithering_fragment>`,
      )

    // Keep a handle so later calls can update uniforms live, no recompile.
    material.userData.rimUniforms = shader.uniforms
  }
  material.needsUpdate = true
}

// Push new rim settings onto an already-built toon/soft material (works before
// or after its first compile — pre-compile it just seeds the values the
// onBeforeCompile hook above will read).
//
// `rim` shape: { color, direction, sideOnly,
//                soft: { enabled, intensity, width },
//                hard: { enabled, intensity, width } }
function updateRimLight(material, rim) {
  const arr = Array.isArray(material) ? material : [material]
  const soft = rim.soft || {}
  const hard = rim.hard || {}
  const softAmount = soft.enabled ? soft.intensity : 0
  const hardAmount = hard.enabled ? hard.intensity : 0
  for (const m of arr) {
    if (!m || !m.userData) continue
    const u = m.userData
    if (!u.rimColor) u.rimColor = new THREE.Color()
    u.rimColor.set(rim.color)
    u.rimSoftIntensity = softAmount
    u.rimSoftWidth = soft.width != null ? soft.width : 0.5
    u.rimHardIntensity = hardAmount
    u.rimHardWidth = hard.width != null ? hard.width : 0.35
    u.rimSideOnly = rim.sideOnly ? 1 : 0
    if (rim.direction) {
      if (!u.rimLightDir) u.rimLightDir = new THREE.Vector3()
      u.rimLightDir.copy(rim.direction)
    }
    const ru = u.rimUniforms
    if (ru) {
      ru.rimColor.value = u.rimColor
      ru.rimSoftIntensity.value = u.rimSoftIntensity
      ru.rimSoftWidth.value = u.rimSoftWidth
      ru.rimHardIntensity.value = u.rimHardIntensity
      ru.rimHardWidth.value = u.rimHardWidth
      ru.rimSideOnly.value = u.rimSideOnly
      if (rim.direction) ru.rimLightDir.value = u.rimLightDir
    }
  }
}

// Record the as-loaded materials so mode switches stay non-destructive, and set
// up empty caches for the generated variants. Call once, right after load.
export function recordOriginalMaterials(model) {
  const originals = new Map()
  for (const mesh of model.meshes) {
    normalizeTransparency(mesh.material)
    originals.set(mesh, mesh.material)
  }
  model.materials = {
    originals, // mesh -> Material | Material[]  (never mutated)
    unlit: new Map(), // mesh -> generated MeshBasicMaterial(s)
    toon: new Map(), // mesh -> generated MeshToonMaterial(s)
  }
}

// A material can end up with opacity < 1 (or an alpha-carrying texture) while
// its `transparent` flag is still false — three.js silently renders that as
// fully opaque, since blending only kicks in once `transparent` is true. This
// happens whenever an exporter writes partial alpha without also flagging the
// material for alpha blending (e.g. a Blender material built from a
// Transparent/Mix Shader whose Blend Mode was left on "Opaque"). Force the
// flag on in that case so what looks translucent in Blender looks
// translucent here too.
export function normalizeTransparency(material) {
  const mats = Array.isArray(material) ? material : [material]
  for (const m of mats) {
    if (!m) continue
    const hasAlpha = (m.opacity != null && m.opacity < 1) || !!m.alphaMap
    if (hasAlpha && !m.transparent) {
      m.transparent = true
      m.needsUpdate = true
    }
  }
}

/**
 * Apply the active material mode + shading controls to every mesh.
 * Non-destructive: originals are kept, generated materials are cached and reused;
 * only the toon gradient (a shared tiny texture) is reassigned per apply.
 *
 * @param {object} model  parsed model with .meshes + .materials
 * @param {object} opts
 * @param {'unlit'|'toon'|'soft'|'standard'} opts.mode
 * @param {number} [opts.toonSteps]  shadow band count (Cartoon mode only)
 * @param {number} [opts.soften]     global shadow lift, 0..1
 * @param {object} [opts.overrides]  { [mesh.uuid]: { outline?, shading? } }
 * @param {object} [opts.rimLight]   { color, direction, sideOnly,
 *                                     soft: { enabled, intensity, width },
 *                                     hard: { enabled, intensity, width } }
 *                                    edge highlight for Cartoon/Soft Anime modes.
 *                                    Soft and Hard are independent layers (both
 *                                    can be on at once); direction is a
 *                                    world-space THREE.Vector3 pointing toward
 *                                    the key light; sideOnly restricts the rim
 *                                    to just the horizontal side of the
 *                                    silhouette facing the light.
 */
export function applyMaterials(model, opts) {
  if (!model || !model.materials) return
  const { mode, toonSteps = 3, soften = 0, overrides = {}, rimLight } = opts
  const store = model.materials

  for (const mesh of model.meshes) {
    const ov = overrides[mesh.uuid]
    const shading = (ov && ov.shading) || 'full'
    const original = store.originals.get(mesh)

    // Per-mesh visibility (hide clothing layers, etc.).
    mesh.visible = !(ov && ov.visible === false)

    // 'flat' (or Unlit mode) → raw colour, no lighting.
    if (mode === 'unlit' || shading === 'flat') {
      mesh.material = getOrBuild(store.unlit, mesh, original, buildUnlit)
      continue
    }
    // Standard mode keeps the untouched PBR originals.
    if (mode === 'standard') {
      mesh.material = original
      continue
    }
    // Cartoon (hard cel bands) and Soft Anime (smooth painterly ramp) both
    // reuse the same generated MeshToonMaterial — only the gradient texture
    // assigned to it differs. 'soft' shading meshes get a floored (gentler)
    // ramp stacked on top of the global soften amount.
    const floor = shading === 'soft' ? Math.max(soften, SOFT_FLOOR) : soften
    const toonMat = getOrBuild(store.toon, mesh, original, buildToon)
    const arr = Array.isArray(toonMat) ? toonMat : [toonMat]
    if (mode === 'soft') {
      assignGradient(toonMat, null, floor, true)
    } else {
      assignGradient(toonMat, toonSteps, floor, false)
    }
    if (rimLight) {
      for (const m of arr) updateRimLight(m, rimLight)
    }
    mesh.material = toonMat
  }
}

// Put the original materials back on every mesh. Called before unload so the
// deep-dispose walk frees the real materials (and their textures), not a
// generated shell that only borrows those textures.
export function restoreOriginalMaterials(model) {
  if (!model || !model.materials) return
  for (const mesh of model.meshes) {
    const original = model.materials.originals.get(mesh)
    if (original) mesh.material = original
  }
}

// Dispose the generated material shells (unlit + toon). Does NOT touch textures:
// those are shared with the originals and freed when the originals are disposed.
export function disposeGeneratedMaterials(model) {
  if (!model || !model.materials) return
  disposeCache(model.materials.unlit)
  disposeCache(model.materials.toon)
  model.materials.unlit.clear()
  model.materials.toon.clear()
}

// --- internals ---------------------------------------------------------------

// Fetch a cached generated material for a mesh, building it (per sub-material for
// multi-material meshes) on first request.
function getOrBuild(cache, mesh, original, build) {
  if (cache.has(mesh)) return cache.get(mesh)
  const made = Array.isArray(original) ? original.map(build) : build(original)
  cache.set(mesh, made)
  return made
}

// Assign a shared gradient ramp to a (possibly multi-) toon material.
// `smooth` picks the linear-filtered soft-anime ramp instead of the hard-
// stepped cel ramp; `steps` is ignored when `smooth` is true.
function assignGradient(material, steps, floor, smooth) {
  const arr = Array.isArray(material) ? material : [material]
  const grad = smooth ? getSoftGradientMap(floor) : getGradientMap(steps, floor)
  for (const m of arr) {
    if (m.gradientMap !== grad) {
      m.gradientMap = grad
      m.needsUpdate = true
    }
  }
}

function buildUnlit(src) {
  const m = new THREE.MeshBasicMaterial()
  copyCommon(src, m)
  return m
}

function buildToon(src) {
  const m = new THREE.MeshToonMaterial()
  copyCommon(src, m)
  // The gradient ramp is assigned separately (per apply) via assignGradient.
  // Carry emissive/normal detail through so toon shading keeps glows and surface
  // relief that the PBR original had.
  if (src.emissive) m.emissive.copy(src.emissive)
  if (src.emissiveMap) m.emissiveMap = src.emissiveMap
  if (src.emissiveIntensity != null) m.emissiveIntensity = src.emissiveIntensity
  if (src.normalMap) m.normalMap = src.normalMap
  installRimLight(m) // adds the optional fresnel edge highlight, off by default
  m.needsUpdate = true
  return m
}

// Copy the colour/alpha properties common to Basic and Toon materials. Textures
// (map/alphaMap) are shared by reference, never cloned. Note: skinning is applied
// automatically by SkinnedMesh in modern three — no material flag needed.
function copyCommon(src, dst) {
  if (src.color && dst.color) dst.color.copy(src.color)
  if (src.map) dst.map = src.map
  if (src.alphaMap) dst.alphaMap = src.alphaMap
  dst.transparent = src.transparent
  dst.opacity = src.opacity
  dst.alphaTest = src.alphaTest
  dst.side = src.side
  dst.vertexColors = src.vertexColors // respect Blender vertex colours
  dst.depthWrite = src.depthWrite
  dst.name = src.name
  dst.needsUpdate = true
}

function disposeCache(cache) {
  for (const made of cache.values()) {
    const arr = Array.isArray(made) ? made : [made]
    for (const mat of arr) mat.dispose() // shell only; textures shared with originals
  }
}