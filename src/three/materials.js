import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Material modes (Phase 2)
//
// Blender node shaders can't be exported, but glTF carries the Principled BSDF
// data (baseColorFactor/Texture, emissive, alpha, …) which GLTFLoader turns into
// MeshStandardMaterial. This module offers three non-destructive "modes" that
// reuse that data:
//
//   unlit    — MeshBasicMaterial: raw base colour, zero lighting. Pixel-identical
//              to the flat colours picked in Blender. This is the default.
//   toon     — MeshToonMaterial: same colour/map, lit through a procedural
//              stepped gradient ramp for anime-style shadow banding.
//   standard — the original MeshStandardMaterial(s) as loaded (PBR lighting).
//
// The originals are recorded once at load, so switching modes never destroys
// them. Generated materials are cached per mesh and disposed on unload. Textures
// are SHARED between originals and generated materials (never cloned), so only
// the material "shells" are disposed here — the textures are freed once, when
// the model's real materials are disposed on unload.
// ---------------------------------------------------------------------------

// Gradient ramp textures, cached by step count and shared across meshes/models.
// Each is only `steps x 1` pixels, so we keep them for the app's lifetime rather
// than rebuilding them every mode switch.
const gradientCache = new Map()

// Build a stepped grayscale ramp used as MeshToonMaterial.gradientMap. The toon
// shader samples this at (N·L * 0.5 + 0.5) and reads the red channel, so a small
// N-wide NearestFilter texture quantises the diffuse term into N hard bands.
function getGradientMap(steps) {
  if (gradientCache.has(steps)) return gradientCache.get(steps)

  const data = new Uint8Array(steps)
  for (let i = 0; i < steps; i++) {
    // Evenly space the bands from dark (0) to full (255) across the ramp.
    data[i] = steps === 1 ? 255 : Math.round((i / (steps - 1)) * 255)
  }

  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat)
  tex.minFilter = THREE.NearestFilter // hard steps, no blending between bands
  tex.magFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  // Leave colorSpace at its linear default: this is a math ramp, not sRGB colour.
  tex.needsUpdate = true

  gradientCache.set(steps, tex)
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
    toonSteps: null, // step count the current toon cache was built for
    mode: 'standard', // the materials on the meshes right now (as loaded)
  }
}

/**
 * Apply a material mode to every mesh in the model. Non-destructive: originals
 * are kept, generated materials are cached and reused.
 *
 * @param {object} model  parsed model (from loadModel) with .meshes + .materials
 * @param {'unlit'|'toon'|'standard'} mode
 * @param {{ toonSteps?: number }} [opts]
 */
export function applyMaterialMode(model, mode, opts = {}) {
  if (!model || !model.materials) return
  const store = model.materials
  const steps = opts.toonSteps ?? 3

  // If the toon step count changed, drop the stale toon cache so it rebuilds
  // against the new gradient ramp.
  if (mode === 'toon' && store.toonSteps !== steps) {
    disposeCache(store.toon)
    store.toon = new Map()
    store.toonSteps = steps
  }

  for (const mesh of model.meshes) {
    const original = store.originals.get(mesh)
    if (mode === 'standard') {
      mesh.material = original
    } else if (mode === 'unlit') {
      mesh.material = getOrBuild(store.unlit, mesh, original, buildUnlit)
    } else if (mode === 'toon') {
      mesh.material = getOrBuild(store.toon, mesh, original, (m) => buildToon(m, steps))
    }
  }
  store.mode = mode
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
  model.materials.toonSteps = null
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

function buildUnlit(src) {
  const m = new THREE.MeshBasicMaterial()
  copyCommon(src, m)
  return m
}

function buildToon(src, steps) {
  const m = new THREE.MeshToonMaterial()
  copyCommon(src, m)
  m.gradientMap = getGradientMap(steps)
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
