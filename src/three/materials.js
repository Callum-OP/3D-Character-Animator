import * as THREE from 'three'
import { addShadowUniforms, shadowFilterKey, setNightImmune, setShadowImmune } from './shadowDarkening.js'
import { stripAppMaterialData } from './materialUserData.js'
import {
  recordMaterialSlots, buildPhysical, applySurface, applyOpacity, applyColorReplace,
  hasSurface, hasReplace, hasAnySlot, isStyledCopy, markStyledCopy, hasSlotOpacity,
  applyToonSurface, toonOpacityLook,
} from './surfaceMaterials.js'

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

// userData is JSON-copied whenever a material is cloned (and survives export/import
// as glTF extras), which turns Colors into numbers and Vector3s into plain objects.
// These put a real Color/Vector3 back so a stale value can never crash a live update.
function ensureColor(u, key, fallback = 0xffffff) {
  const v = u[key]
  if (v && v.isColor) return v
  u[key] = new THREE.Color(typeof v === 'number' || typeof v === 'string' ? v : fallback)
  return u[key]
}

function ensureVector3(u, key, fallback) {
  const v = u[key]
  if (v && v.isVector3) return v
  u[key] = v && typeof v === 'object' ? new THREE.Vector3(v.x || 0, v.y || 0, v.z || 0) : fallback.clone()
  return u[key]
}

// True when `material` really carries our rim-light shader hook (not just the flag).
function hasRimHook(material) {
  return typeof material.customProgramCacheKey === 'function' &&
    String(material.customProgramCacheKey()).includes('charanim-rim')
}

function installRimLight(material) {
  const u = material.userData
  // The flag alone isn't proof: a cloned material (character paste, prop copy) or a
  // model imported from a file exported by the app keeps the flag in its userData
  // without the onBeforeCompile hook it stands for. Treat that as "not installed".
  if (u.rimLightInstalled && hasRimHook(material)) return
  if (u.rimLightInstalled) stripAppMaterialData(material)
  u.rimLightInstalled = true
  ensureColor(u, 'rimColor')
  ensureVector3(u, 'rimLightDir', new THREE.Vector3(0.3, 0.6, 0.7))
  u.rimSoftIntensity = u.rimSoftIntensity || 0
  u.rimSoftWidth = u.rimSoftWidth != null ? u.rimSoftWidth : 0.5
  u.rimHardIntensity = u.rimHardIntensity || 0
  u.rimHardWidth = u.rimHardWidth != null ? u.rimHardWidth : 0.35
  u.rimSideOnly = u.rimSideOnly || 0
  u.ambientOcclusionStrength = u.ambientOcclusionStrength || 0
  ensureColor(u, 'backlightColor')
  u.backlightFalloff = u.backlightFalloff != null ? u.backlightFalloff : 0.5
  u.colorGrading = u.colorGrading || 0
  u.shadowStrength = u.shadowStrength != null ? u.shadowStrength : 0.15
  // Stable cache key: the injected code never changes, only the uniforms do,
  // so every toon/soft material can safely share one compiled program variant.
  material.customProgramCacheKey = () => 'charanim-rim-v5' + shadowFilterKey()
  material.onBeforeCompile = (shader) => {
    addShadowUniforms(shader.uniforms, material) // shared shadow uniforms: see shadowDarkening.js
    shader.uniforms.rimColor = { value: u.rimColor }
    shader.uniforms.rimLightDir = { value: u.rimLightDir }
    shader.uniforms.rimSoftIntensity = { value: u.rimSoftIntensity }
    shader.uniforms.rimSoftWidth = { value: u.rimSoftWidth }
    shader.uniforms.rimHardIntensity = { value: u.rimHardIntensity }
    shader.uniforms.rimHardWidth = { value: u.rimHardWidth }
    shader.uniforms.rimSideOnly = { value: u.rimSideOnly }
    shader.uniforms.styleAmbientOcclusion = { value: u.ambientOcclusionStrength }
    shader.uniforms.styleBacklightColor = { value: u.backlightColor }
    shader.uniforms.styleBacklightFalloff = { value: u.backlightFalloff }
    shader.uniforms.styleColorGrading = { value: u.colorGrading }
    shader.uniforms.styleShadowStrength = { value: u.shadowStrength }

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
        uniform float rimSideOnly;
        uniform float styleAmbientOcclusion;
        uniform vec3 styleBacklightColor;
        uniform float styleBacklightFalloff;
        uniform float styleColorGrading;
        uniform float styleShadowStrength;
        `,
      )
      .replace(
        '#include <dithering_fragment>',
        `
        #ifdef USE_NORMALMAP
          vec3 rimNormal = normal;
        #else
          vec3 rimNormal = normalize( vNormal );
        #endif
        // Rim lighting is opt-in. Avoid the expensive fresnel, light-direction,
        // pow and smoothstep work on every fragment when both rim layers are off.
        if ( rimSoftIntensity > 0.001 || rimHardIntensity > 0.001 ) {
          // View-dependent edge term (classic fresnel rim), 0 at fully facing
          // the camera, 1 right at the silhouette.
          float rimEdgeRaw = 1.0 - max( dot( vRimView, rimNormal ), 0.0 );
          // Gated so it only shows on the side of the model actually facing the
          // key light — a shoulder catches the glow, the far/shadowed side
          // doesn't, just like a real backlit rim highlight.
          float ndotl = dot( rimNormal, vRimLightDir );
          // Optional extra mask: only the horizontal side of the silhouette
          // that faces the light's left/right direction.
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
          // Hard layer: a crisp thresholded line.
          float hardLo = mix( 0.85, 0.25, clamp( rimHardWidth, 0.0, 1.0 ) );
          float edgeHard = smoothstep( hardLo, hardLo + 0.08, rimEdgeRaw );
          float litHard = smoothstep( -0.05, 0.05, ndotl );
          float hardTerm = edgeHard * litHard * rimSide * rimHardIntensity;
          // A rim light is a light: it must be blocked by shadows like the key light is.
          // (The shadow darkening already ran on outgoingLight; this is added afterwards, so
          // without this a bright rim line sat untouched on a darkened surface, which read
          // as a wet, glossy edge, worst with sharp or high-contrast shadows.)
          float rimShadow = mix( 1.0, dsShadowMin, uShadowDarkness );
          gl_FragColor.rgb += rimColor * ( softTerm + hardTerm ) * rimShadow;
        }
        float faceTerm = smoothstep(0.15, 0.85, dot(vRimView, rimNormal));
        gl_FragColor.rgb *= 1.0 - styleAmbientOcclusion * (1.0 - faceTerm) * 0.18;
        float backEdge = pow(clamp(1.0 - faceTerm, 0.0, 1.0), mix(1.0, 5.0, styleBacklightFalloff));
        gl_FragColor.rgb += styleBacklightColor * backEdge * styleBacklightFalloff * 0.35 * mix( 1.0, mix( 1.0, dsShadowMin, uShadowDarkness ), 0.5 );
        if (styleColorGrading > 0.5 && styleColorGrading < 1.5) gl_FragColor.rgb *= vec3(1.03, 0.985, 0.95);
        if (styleColorGrading >= 1.5 && styleColorGrading < 2.5) gl_FragColor.rgb *= vec3(0.96, 0.985, 1.04);
        if (styleColorGrading >= 2.5 && styleColorGrading < 3.5) gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114))), 0.85);
        if (styleColorGrading >= 3.5) {
          float gradeLuma = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
          float shadowGrade = 1.0 - smoothstep(0.18, 0.62, gradeLuma);
          vec3 teal = vec3(0.72, 0.90, 0.92);
          vec3 orange = vec3(1.08, 0.78, 0.62);
          vec3 cinematicTint = mix(orange, teal, shadowGrade * 0.72);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * cinematicTint, 0.18);
        }
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
    ensureColor(u, 'rimColor').set(rim.color)
    u.rimSoftIntensity = softAmount
    u.rimSoftWidth = soft.width != null ? soft.width : 0.5
    u.rimHardIntensity = hardAmount
    u.rimHardWidth = hard.width != null ? hard.width : 0.35
    u.rimSideOnly = rim.sideOnly ? 1 : 0
    if (rim.direction) ensureVector3(u, 'rimLightDir', rim.direction).copy(rim.direction)
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

function updateStyleControls(material, style = {}) {
  const arr = Array.isArray(material) ? material : [material]
  for (const m of arr) {
    if (!m?.userData) continue
    const u = m.userData
    u.ambientOcclusionStrength = style.ambientOcclusionStrength || 0
    ensureColor(u, 'backlightColor').set(style.backlightColor || '#ffffff')
    u.backlightFalloff = style.backlightFalloff != null ? style.backlightFalloff : 0.5
    u.colorGrading = gradeValue(style.colorGrading)
    u.shadowStrength = style.shadowStrength != null ? style.shadowStrength : 0.15
    const ru = u.rimUniforms
    if (ru) {
      ru.styleAmbientOcclusion.value = u.ambientOcclusionStrength
      ru.styleBacklightColor.value = u.backlightColor
      ru.styleBacklightFalloff.value = u.backlightFalloff
      ru.styleColorGrading.value = u.colorGrading
      ru.styleShadowStrength.value = u.shadowStrength
    }
    const su = u.styleUniforms
    if (su) su.styleColorGrading.value = u.colorGrading
  }
}

function installStyleGrade(material) {
  const u = material.userData
  u.colorGrading = u.colorGrading || 0
  material.customProgramCacheKey = () => 'charanim-grade-v1' + shadowFilterKey()
  material.onBeforeCompile = (shader) => {
    addShadowUniforms(shader.uniforms, material)
    shader.uniforms.styleColorGrading = { value: u.colorGrading }
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      '#include <common>\nuniform float styleColorGrading;',
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `
      if (styleColorGrading > 0.5 && styleColorGrading < 1.5) gl_FragColor.rgb *= vec3(1.03, 0.985, 0.95);
      if (styleColorGrading >= 1.5 && styleColorGrading < 2.5) gl_FragColor.rgb *= vec3(0.96, 0.985, 1.04);
      if (styleColorGrading >= 2.5 && styleColorGrading < 3.5) gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114))), 0.85);
      if (styleColorGrading >= 3.5) {
        float gradeLuma = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
        float shadowGrade = 1.0 - smoothstep(0.18, 0.62, gradeLuma);
        vec3 cinematicTint = mix(vec3(1.08, 0.78, 0.62), vec3(0.72, 0.90, 0.92), shadowGrade * 0.72);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * cinematicTint, 0.18);
      }
      #include <dithering_fragment>`,
    )
    u.styleUniforms = shader.uniforms
  }
  material.needsUpdate = true
}

function gradeValue(colorGrading) {
  if (typeof colorGrading === 'number') return colorGrading
  if (colorGrading === 'warm') return 1
  if (colorGrading === 'cool') return 2
  if (colorGrading === 'bleach') return 3
  if (colorGrading === 'cinematic') return 4
  return 0
}

// Record the as-loaded materials so mode switches stay non-destructive, and set
// up empty caches for the generated variants. Call once, right after load.
export function recordOriginalMaterials(model) {
  const originals = new Map()
  for (const mesh of model.meshes) {
    normalizeTransparency(mesh.material)
    originals.set(mesh, mesh.material)
    recordMaterialSlots(mesh, mesh.material) // names + swatches for the per-material editor
  }
  // What each original material's alpha settings were as loaded (after the
  // fix-up above), so transparency can be switched off and back on without ever
  // losing them. `hasAlpha` marks materials that use alpha at all: flagged
  // transparent, alpha-tested, an alpha map, or partial opacity.
  const alpha = new Map()
  for (const original of originals.values()) {
    for (const m of Array.isArray(original) ? original : [original]) {
      if (!m || alpha.has(m)) continue
      alpha.set(m, {
        transparent: !!m.transparent,
        alphaTest: m.alphaTest || 0,
        depthWrite: m.depthWrite !== false,
        hasAlpha: !!m.transparent || (m.alphaTest || 0) > 0 || !!m.alphaMap || (m.opacity != null && m.opacity < 1),
      })
    }
  }
  model.materials = {
    originals, // mesh -> Material | Material[]  (never mutated)
    unlit: new Map(), // mesh -> generated MeshBasicMaterial(s)
    toon: new Map(), // mesh -> generated MeshToonMaterial(s)
    alpha, // material -> as-loaded alpha settings (see above)
  }
}

// Meshes that came in with transparency/alpha on at least one of their
// materials — the ones whose "Transparency" switch actually does something.
export function getTransparentMeshes(model) {
  const store = model && model.materials
  if (!store || !store.alpha) return []
  return (model.meshes || []).filter((mesh) => {
    const original = store.originals.get(mesh)
    return (Array.isArray(original) ? original : [original]).some((m) => m && store.alpha.get(m)?.hasAlpha)
  })
}

// Switch a mesh's alpha behaviour on (as loaded) or off (fully opaque). Off is
// what stops textures with an alpha channel — skin, face — letting the mouth,
// teeth and tongue behind them show through. Works on the original material and
// on generated unlit/toon copies alike (`target` and `original` line up).
function applyAlphaState(target, original, store, on) {
  const targets = Array.isArray(target) ? target : [target]
  const originals = Array.isArray(original) ? original : [original]
  targets.forEach((m, i) => {
    const info = m && store.alpha ? store.alpha.get(originals[i]) : null
    if (!info || !info.hasAlpha) return
    const transparent = on ? info.transparent : false
    const alphaTest = on ? info.alphaTest : 0
    const depthWrite = on ? info.depthWrite : true
    // transparent / alphaTest are compile-time shader switches.
    if (m.transparent !== transparent || m.alphaTest !== alphaTest) m.needsUpdate = true
    m.transparent = transparent
    m.alphaTest = alphaTest
    m.depthWrite = depthWrite
  })
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

// ---------------------------------------------------------------------------
// Per-material flags that follow a setting rather than a style:
//   night immunity  a mesh with userData.nightImmune ignores Night mode (its materials get
//                   the flag, which switches their night uniform off, see shadowDarkening.js)
// ---------------------------------------------------------------------------
// A mesh casts its shadow from the surface facing the light (both faces are written to the
// shadow map), so one part of an object properly shades another part sitting just behind it
// (an arm over the torso). This used to be a setting; it is now always on.

export function syncMeshMaterialFlags(meshes) {
  if (!meshes) return
  for (const mesh of meshes) {
    if (!mesh) continue
    const immune = !!(mesh.userData && mesh.userData.nightImmune)
    const shadowImmune = !!(mesh.userData && mesh.userData.shadowImmune)
    const arr = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of arr) {
      if (!m) continue
      m.shadowSide = THREE.DoubleSide
      if (immune) m.userData.nightImmune = true
      else delete m.userData.nightImmune
      setNightImmune(m, immune) // a live uniform: no recompile either way
      if (shadowImmune) m.userData.shadowImmune = true
      else delete m.userData.shadowImmune
      setShadowImmune(m, shadowImmune)
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
 * @param {'unlit'|'toon'|'soft'|'standard'|'realistic'} opts.mode
 * @param {number} [opts.toonSteps]  shadow band count (Cartoon mode only)
 * @param {number} [opts.soften]     global shadow lift, 0..1
 * @param {object} [opts.overrides]  { [mesh.uuid]: { outline?, shading?, color?, solid? } }
 *                                    `color` ('#rrggbb') recolours that mesh: it
 *                                    tints (multiplies) the loaded texture, or
 *                                    with `solid` replaces the texture with the
 *                                    flat colour (alpha cut-outs are kept).
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
  const {
    mode, toonSteps = 3, soften = 0, overrides = {}, rimLight,
    ambientOcclusionStrength, backlightColor, backlightFalloff, colorGrading, shadowStrength,
    transparencyDefault = true, // alpha stays as loaded unless a mesh is switched off (overrides[uuid].alpha === false)
  } = opts
  const store = model.materials

  for (const mesh of model.meshes) {
    const ov = overrides[mesh.uuid]
    const shading = (ov && ov.shading) || 'full'
    const original = store.originals.get(mesh)

    // Per-mesh visibility (hide clothing layers, etc.).
    mesh.visible = !(ov && ov.visible === false)

    // Transparency: this mesh's own switch, else the default.
    const alphaOn = ov && typeof ov.alpha === 'boolean' ? ov.alpha : transparencyDefault !== false
    applyAlphaState(original, original, store, alphaOn)

    // 'flat' (or Unlit mode) → raw colour, no lighting.
    if (mode === 'unlit' || shading === 'flat') {
      const unlitMat = getOrBuild(store.unlit, mesh, original, (src) => {
        const made = buildUnlit(src)
        installStyleGrade(made)
        return made
      })
      updateStyleControls(unlitMat, { colorGrading })
      applyAlphaState(unlitMat, original, store, alphaOn)
      if (applyColorOverride(unlitMat, original, ov)) applyAlphaState(unlitMat, original, store, alphaOn)
      mesh.material = unlitMat
      continue
    }
    // Standard mode keeps the untouched PBR originals — except a recoloured or
    // restyled mesh, whose changed materials get their own per-mesh copies: originals
    // can be shared between meshes (and are never mutated), so editing one in place
    // would change every mesh that happens to share its material. Materials of that
    // mesh nobody touched keep rendering with the originals.
    if (mode === 'standard' || mode === 'realistic') {
      const styled = !!(ov && ov.color) || hasAnySlot(ov)
      const target = styled ? buildStyled(store, mesh, original, ov) : original
      if (styled) applyAlphaState(target, original, store, alphaOn)
      const arr = Array.isArray(target) ? target : [target]
      for (const m of arr) {
        if (!m) continue
        installRimLight(m)
        updateStyleControls(m, {
          ambientOcclusionStrength,
          backlightColor,
          backlightFalloff,
          colorGrading: gradeValue(colorGrading),
          shadowStrength,
        })
      }
      // After the rim hook: colour-replace chains onto whatever shader hooks exist.
      if (styled && applyColorOverride(target, original, ov, { surface: true })) {
        applyAlphaState(target, original, store, alphaOn)
      }
      mesh.material = target
      continue
    }
    // Cartoon (hard cel bands) and Soft Anime (smooth painterly ramp) both
    // reuse the same generated MeshToonMaterial — only the gradient texture
    // assigned to it differs. 'soft' shading meshes get a floored (gentler)
    // ramp stacked on top of the global soften amount.
    const floor = shading === 'soft' ? Math.max(soften, SOFT_FLOOR) : soften
    const toonMat = getOrBuild(store.toon, mesh, original, buildToon)
    applyAlphaState(toonMat, original, store, alphaOn)
    const arr = Array.isArray(toonMat) ? toonMat : [toonMat]
    if (mode === 'soft') {
      assignGradient(toonMat, null, floor, true)
    } else {
      assignGradient(toonMat, toonSteps, floor, false)
    }
    if (rimLight) {
      for (const m of arr) updateRimLight(m, rimLight)
    }
    updateStyleControls(toonMat, {
      ambientOcclusionStrength,
      backlightColor,
      backlightFalloff,
      colorGrading: gradeValue(colorGrading),
      shadowStrength,
    })
    if (applyColorOverride(toonMat, original, ov, { toon: { soft: mode === 'soft' } })) applyAlphaState(toonMat, original, store, alphaOn)
    mesh.material = toonMat
  }
  syncMeshMaterialFlags(model.meshes)
}

// Update only the live rim uniforms when a followed scene light moves. The
// material mode and outline state have not changed, so rebuilding the style
// pipeline here would only add CPU work during a drag or playback tick.
export function updateRimLightMaterials(model, rimLight) {
  if (!model || !model.meshes || !rimLight) return
  for (const mesh of model.meshes) {
    const material = mesh.material
    const arr = Array.isArray(material) ? material : [material]
    for (const mat of arr) {
      if (mat?.userData?.rimColor) updateRimLight(mat, rimLight)
    }
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
  if (model.materials.tinted) {
    disposeCache(model.materials.tinted)
    model.materials.tinted.clear()
  }
  if (model.materials.styled) {
    // Per-slot copies only — a slot nobody styled holds the ORIGINAL, which is freed with the model.
    for (const made of model.materials.styled.values()) {
      for (const entry of made) if (isStyledCopy(entry.mat)) entry.mat.dispose()
    }
    model.materials.styled.clear()
  }
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

// Per-mesh copy of an original material, used only in Standard mode for meshes
// the user has recoloured. Textures are shared by reference (Material.clone
// copies the references, not the images). userData is reset because
// Material.copy JSON-clones it — which would carry over the "rim light already
// installed" flag without the onBeforeCompile hook that flag stands for.
function buildTinted(src) {
  const m = src.clone()
  m.userData = {}
  return markStyledCopy(m)
}

// The materials a restyled mesh renders with, one per slot, cached per mesh. A slot is
//   'physical' when it needs lighting-model changes (glossy, metal, cloth, glass…),
//   'clone'    when only colour / opacity / colour-replace change, and
//   'orig'     when untouched (the shared original, never mutated).
// Rebuilt only when a slot's kind changes (e.g. the first time metalness is set).
function buildStyled(store, mesh, original, ov) {
  if (!store.styled) store.styled = new Map()
  const isArr = Array.isArray(original)
  const srcs = isArr ? original : [original]
  const prev = store.styled.get(mesh) || []
  const out = srcs.map((src, i) => {
    const look = ov && ov.slots ? ov.slots[i] : null
    const kind = hasSurface(look)
      ? 'physical'
      : (ov && ov.color) || (look && (look.color != null || look.opacity != null)) || hasReplace(look)
        ? 'clone'
        : 'orig'
    const have = prev[i]
    if (have && have.kind === kind && have.src === src) return have
    if (have && isStyledCopy(have.mat)) have.mat.dispose()
    if (!src) return { kind: 'orig', src, mat: src }
    const mat = kind === 'orig' ? src : kind === 'physical' ? buildPhysical(src) : buildTinted(src)
    return { kind, src, mat }
  })
  store.styled.set(mesh, out)
  const mats = out.map((o) => o.mat)
  return isArr ? mats : mats[0]
}

// Recolour (whole mesh, then per-slot on top), restyle and colour-replace each
// material. Returns true when a slot opacity was just cleared, so the caller can re-run
// the transparency switch that owns `transparent`.
function applyColorOverride(target, original, ov, { surface = false, toon = null } = {}) {
  const targets = Array.isArray(target) ? target : [target]
  const originals = Array.isArray(original) ? original : [original]
  let opacityCleared = false
  targets.forEach((t, i) => {
    const src = originals[i]
    if (!t || !src) return
    const look = ov && ov.slots ? ov.slots[i] : null
    if (t.color && src.color) {
      const slotColor = look && look.color
      const color = slotColor || (ov && ov.color)
      const solid = slotColor ? !!look.solid : !!(ov && ov.solid)
      if (color) t.color.set(color)
      else t.color.copy(src.color)
      const wantMap = color && solid ? null : src.map || null
      if ((t.map || null) !== wantMap) {
        t.map = wantMap
        t.needsUpdate = true // a map appearing/disappearing changes the shader
      }
    }
    if (surface && t.isMeshPhysicalMaterial && isStyledCopy(t)) applySurface(t, src, look)
    // Toon / anime / soft: the same settings, simulated (see surfaceMaterials.js).
    if (toon) applyToonSurface(t, src, look, toon)
    // Never on a shared original: only copies and generated shells get the hook.
    if (hasReplace(look) || (t.userData && t.userData.recolorUniforms)) applyColorReplace(t, look)
    const opLook = toon ? toonOpacityLook(look) : look
    if ((opLook && opLook.opacity != null) || hasSlotOpacity(t)) {
      if (applyOpacity(t, src, opLook)) opacityCleared = true
    }
  })
  return opacityCleared
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