import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Material modes (Phase 2) + per-mesh shading overrides
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

// Build a stepped grayscale ramp used as MeshToonMaterial.gradientMap. The toon
// shader samples this at (N·L * 0.5 + 0.5) and reads the red channel, so a small
// N-wide NearestFilter texture quantises the diffuse term into N hard bands.
// `floor` (0..1) lifts the darkest band toward white to soften/flatten shadows.
function getGradientMap(steps, floor) {
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

// Record the as-loaded materials so mode switches stay non-destructive, and set
// up empty caches for the generated variants. Call once, right after load.
export function recordOriginalMaterials(model) {
  const originals = new Map()
  for (const mesh of model.meshes) {
    originals.set(mesh, mesh.material)
  }
  model.materials = {
    originals, // mesh -> Material | Material[]  (never mutated)
    unlit: new Map(), // mesh -> generated MeshBasicMaterial(s)
    toon: new Map(), // mesh -> generated MeshToonMaterial(s)
  }
}

/**
 * Apply the active material mode + shading controls to every mesh.
 * Non-destructive: originals are kept, generated materials are cached and reused;
 * only the toon gradient (a shared tiny texture) is reassigned per apply.
 *
 * @param {object} model  parsed model with .meshes + .materials
 * @param {object} opts
 * @param {'unlit'|'toon'|'standard'} opts.mode
 * @param {number} [opts.toonSteps]  shadow band count
 * @param {number} [opts.soften]     global shadow lift, 0..1
 * @param {object} [opts.overrides]  { [mesh.uuid]: { outline?, shading? } }
 */
export function applyMaterials(model, opts) {
  if (!model || !model.materials) return
  const { mode, toonSteps = 3, soften = 0, overrides = {} } = opts
  const store = model.materials

  for (const mesh of model.meshes) {
    const shading = (overrides[mesh.uuid] && overrides[mesh.uuid].shading) || 'full'
    const original = store.originals.get(mesh)

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
    // Toon: reuse the cached toon material and (re)assign its gradient ramp.
    // 'soft' meshes get a floored (gentler) ramp on top of the global soften.
    const floor = shading === 'soft' ? Math.max(soften, SOFT_FLOOR) : soften
    const toonMat = getOrBuild(store.toon, mesh, original, buildToon)
    assignGradient(toonMat, toonSteps, floor)
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
function assignGradient(material, steps, floor) {
  const arr = Array.isArray(material) ? material : [material]
  const grad = getGradientMap(steps, floor)
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
