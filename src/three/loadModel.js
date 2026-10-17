import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js'
import { convertBlendToGlb } from './blendImport.js'
import {
  readArchive,
  pickMainModelPath,
  createResourceResolver,
  planLooseTextures,
  planExtraMaps,
  mimeOf,
  extOf,
  stemOf,
  isImageName,
} from './modelBundle.js'

export const IMPORT_DECIMATION_LEVELS = [
  { minVertices: 150_000, level: 1, reduction: 0.2 },
  { minVertices: 500_000, level: 2, reduction: 0.4 },
  { minVertices: 1_000_000, level: 3, reduction: 0.6 },
]

export function getImportDecimationPlan(vertexCount) {
  for (let i = IMPORT_DECIMATION_LEVELS.length - 1; i >= 0; i--) {
    const level = IMPORT_DECIMATION_LEVELS[i]
    if (vertexCount >= level.minVertices) return level
  }
  return null
}

// Minimal reader for the deprecated KHR_materials_pbrSpecularGlossiness
// extension, which GLTFLoader no longer supports — without this, materials on
// such files (common in older Sketchfab conversions) fall back to an untextured
// default and the model shows up blank. Map what this app actually renders:
// diffuse texture/colour onto map/color, glossiness onto an approximate
// roughness. The specular term has no metallic-roughness equivalent and is
// ignored — fine here, since the app defaults to unlit shading anyway.
class GLTFSpecularGlossinessExtension {
  constructor(parser) {
    this.parser = parser
    this.name = 'KHR_materials_pbrSpecularGlossiness'
  }

  getMaterialType(materialIndex) {
    const def = this.parser.json.materials[materialIndex]
    return def.extensions && def.extensions[this.name] ? THREE.MeshStandardMaterial : null
  }

  extendMaterialParams(materialIndex, materialParams) {
    const def = this.parser.json.materials[materialIndex]
    const ext = def.extensions && def.extensions[this.name]
    if (!ext) return Promise.resolve()

    const pending = []
    const diffuse = ext.diffuseFactor || [1, 1, 1, 1]
    materialParams.color = new THREE.Color().setRGB(
      diffuse[0],
      diffuse[1],
      diffuse[2],
      THREE.LinearSRGBColorSpace,
    )
    materialParams.opacity = diffuse[3] !== undefined ? diffuse[3] : 1
    if (ext.diffuseTexture) {
      pending.push(
        this.parser.assignTexture(materialParams, 'map', ext.diffuseTexture, THREE.SRGBColorSpace),
      )
    }
    materialParams.metalness = 0
    materialParams.roughness = ext.glossinessFactor !== undefined ? 1 - ext.glossinessFactor : 1
    return Promise.all(pending)
  }
}

// glTF is the common case, so its loader is bundled eagerly. FBXLoader drags in
// fflate + NURBS helpers (~hundreds of KB), so it is code-split behind a dynamic
// import and only fetched the first time someone actually opens a .fbx file.
const gltfLoader = new GLTFLoader()
gltfLoader.register((parser) => new GLTFSpecularGlossinessExtension(parser))
let fbxLoader = null

async function getFbxLoader() {
  if (!fbxLoader) {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
    fbxLoader = new FBXLoader()
  }
  return fbxLoader
}

// Supported input extensions, in the order we advertise them to the user. A .zip
// is a bundle: a model plus the textures/materials/buffers it references (see
// modelBundle.js — folders and multi-file picks are packed into one too).
export const SUPPORTED_EXTENSIONS = ['glb', 'gltf', 'fbx', 'obj', 'dae', 'stl', 'ply', 'blend', 'zip', 'rar']

// A single regex used both to validate drops and to strip the extension off the
// display name. Built from SUPPORTED_EXTENSIONS so the two never drift apart.
export const SUPPORTED_EXTENSION_RE = new RegExp(
  `\\.(${SUPPORTED_EXTENSIONS.join('|')})$`,
  'i',
)

/**
 * Load a model File (from a file input or drag-and-drop) into a parsed result.
 * Dispatches on file extension: .glb/.gltf use GLTFLoader, .fbx uses FBXLoader.
 * No server round-trip: we parse from an object URL over the local File blob.
 *
 * Returns a plain object describing everything the app needs:
 *   {
 *     source,          // raw loader result (gltf object, or FBX Group)
 *     root,            // THREE.Group/Object3D to add to the scene
 *     skinnedMeshes,   // SkinnedMesh[]
 *     meshes,          // all Mesh[] (incl. non-skinned)
 *     skeleton,        // first skeleton found (or null)
 *     bones,           // Bone[] (deduped)
 *     clips,           // THREE.AnimationClip[]
 *     info,            // { name, format, meshCount, boneCount, clipNames }
 *   }
 *
 * NOTE: Draco/KTX2/meshopt compression is not wired up. If a Blender glTF
 * export uses Draco mesh compression, the loader will throw; we surface a clear
 * message telling the user to re-export without it.
 */
export async function loadModel(file, { autoDecimate = true } = {}) {
  const ext = extensionOf(file.name)
  if (ext === 'zip' || ext === 'rar') return loadBundleFile(file, { autoDecimate })
  if (ext === 'blend') {
    const files = new Map([[file.name, new Uint8Array(await file.arrayBuffer())]])
    return loadBlend(file, files, file.name, { autoDecimate })
  }
  const url = URL.createObjectURL(file)
  try {
    if (ext === 'obj' || ext === 'dae' || ext === 'stl' || ext === 'ply' || ext === 'fbx') {
      // A lone file of these formats goes down the same code path as a bundle, just with
      // nothing else in it — so anything it refers to that ISN'T there (textures, an .mtl)
      // is found out and reported (info.bundle.missingTextures / missingFiles) instead of
      // silently loading untextured.
      const files = new Map([[file.name, new Uint8Array(await file.arrayBuffer())]])
      return await loadFromFiles(files, file.name, { autoDecimate, displayName: file.name })
    }
    if (ext === 'glb' || ext === 'gltf') {
      const gltf = await gltfLoader.loadAsync(url)
      const root = gltf.scene || (gltf.scenes && gltf.scenes[0])
      if (autoDecimate) applyImportOptimization(root)
      return parseRoot(root, gltf.animations, file.name, ext, gltf)
    }
    throw new Error(
      `Unsupported file type ".${ext}". Supported: ${SUPPORTED_EXTENSIONS.map((e) => '.' + e).join(', ')}.`,
    )
  } catch (err) {
    // Make the common Draco failure legible instead of a cryptic stack.
    const msg = String(err && err.message ? err.message : err)
    if (/draco/i.test(msg) || /KHR_draco/i.test(msg)) {
      throw new Error(
        'This file uses Draco compression, which is not supported yet. ' +
          'Re-export from Blender with "Compression" unchecked.',
      )
    }
    throw new Error('Failed to load model: ' + msg)
  } finally {
    // The blob is fully parsed into GPU/CPU memory by now; free the URL handle.
    URL.revokeObjectURL(url)
  }
}

// ---------------------------------------------------------------------------
// Loading from a bundle (a zip of a model + its textures/materials/buffers)
//
// Every loader asks for its extra files by NAME relative to the model. Handing
// the model over as a blob URL gives those names nothing to resolve against, so
// instead each loader is created with a LoadingManager whose URL modifier looks
// the request up inside the bundle and returns a blob URL for it — the technique
// three.js documents for loading assets from zips and drag-and-drop.
// ---------------------------------------------------------------------------

const BUNDLE_SCHEME = 'bundle:/'

async function loadBundleFile(file, { autoDecimate }) {
  let files
  try {
    files = await readArchive(await file.arrayBuffer())
  } catch (err) {
    const why = String(err && err.message ? err.message : err)
    // the RAR reader's own messages are already complete sentences
    throw new Error(/^(This RAR|could not read the RAR)/.test(why) ? 'Failed to load model: ' + why : 'Failed to load model: could not read the archive (' + why + ')')
  }
  const main = pickMainModelPath(files)
  if (!main) {
    throw new Error(
      'Failed to load model: no 3D model found inside the archive. Supported: ' +
        SUPPORTED_EXTENSIONS.filter((e) => e !== 'zip').map((e) => '.' + e).join(', ') + '.',
    )
  }
  if (extOf(main) === 'blend') return loadBlend(file, files, main, { autoDecimate })
  return loadFromFiles(files, main, { autoDecimate, displayName: file.name })
}

// A .blend: Blender (desktop app) converts it to a .glb, which then loads like any other.
// The converted .glb — not the .blend — is what a saved project keeps (parsed.persistFile),
// so reopening a project never needs Blender again.
async function loadBlend(sourceFile, files, mainPath, { autoDecimate }) {
  let converted
  try {
    converted = await convertBlendToGlb(sourceFile, files, mainPath, sourceFile.name)
  } catch (err) {
    throw new Error(String(err && err.message ? err.message : err))
  }
  const parsed = await loadModel(converted.file, { autoDecimate })
  parsed.info.name = cleanName(sourceFile.name)
  parsed.info.convertedFrom = 'blend'
  parsed.info.bundle = {
    ...(parsed.info.bundle || {}),
    converted: 'blender',
    blenderVersion: converted.blenderVersion,
    conversionWarnings: converted.warnings,
    missingTextures: converted.warnings.filter((w) => /texture not found/i.test(w)).map((w) => w.replace(/^.*texture not found:\s*/i, '')),
  }
  parsed.persistFile = converted.file
  return parsed
}

async function loadFromFiles(files, mainPath, { autoDecimate, displayName }) {
  const ext = extOf(mainPath)
  const resolver = createResourceResolver(files.keys())
  const mainDir = mainPath.includes('/') ? mainPath.slice(0, mainPath.lastIndexOf('/') + 1) : ''
  const base = BUNDLE_SCHEME + mainDir

  const blobUrls = new Map() // bundle path -> blob URL, created on first request
  const served = new Set() // bundle paths a loader actually asked for
  const missing = new Set()
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => {
    // Anything that isn't one of our bundle URLs (data:, blob:, http…) passes straight through.
    if (!url.startsWith(BUNDLE_SCHEME)) return url
    const key = resolver.find(url.slice(BUNDLE_SCHEME.length))
    if (!key) {
      missing.add(url.slice(BUNDLE_SCHEME.length))
      return url
    }
    served.add(key)
    if (!blobUrls.has(key)) blobUrls.set(key, URL.createObjectURL(new Blob([files.get(key)], { type: mimeOf(key) })))
    return blobUrls.get(key)
  })
  const { TGALoader } = await import('three/examples/jsm/loaders/TGALoader.js')
  manager.addHandler(/\.tga$/i, new TGALoader(manager))

  // Loaders start fetching textures during parse and finish later; the blob URLs
  // must outlive that. A sentinel item keeps the manager "busy" across the parse
  // so onLoad fires exactly once, after the last texture has settled.
  const idle = new Promise((resolve) => {
    manager.onLoad = resolve
  })
  manager.itemStart('bundle:parse')
  let result
  try {
    result = await parseMainModel(ext, files.get(mainPath), mainPath, base, files, manager)
    if (autoDecimate) applyImportOptimization(result.root)
  } catch (err) {
    manager.itemEnd('bundle:parse')
    revokeAll(blobUrls)
    const msg = String(err && err.message ? err.message : err)
    if (/draco/i.test(msg) || /KHR_draco/i.test(msg)) {
      throw new Error(
        'This file uses Draco compression, which is not supported yet. ' +
          'Re-export from Blender with "Compression" unchecked.',
      )
    }
    throw new Error('Failed to load model: ' + msg)
  }
  manager.itemEnd('bundle:parse')
  await Promise.race([idle, new Promise((r) => setTimeout(r, 60_000))])

  let loose = { colour: 0, extra: 0 }
  try {
    loose = await applyLooseTextures(result.root, files, served, manager)
  } finally {
    revokeAll(blobUrls)
  }

  const parsed = parseRoot(result.root, result.animations, displayName, ext, result.source)
  parsed.info.bundle = {
    files: files.size,
    texturesFound: served.size + loose.colour + loose.extra,
    missingTextures: [...missing].filter(isImageName),
    missingFiles: result.missingFiles || [],
    looseTexturesApplied: loose.colour,
    extraMapsApplied: loose.extra,
  }
  return parsed
}

function revokeAll(blobUrls) {
  for (const url of blobUrls.values()) URL.revokeObjectURL(url)
  blobUrls.clear()
}

const textDecoder = new TextDecoder()

async function parseMainModel(ext, bytes, mainPath, base, files, manager) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  if (ext === 'fbx') {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
    const group = new FBXLoader(manager).parse(buffer, base)
    return { root: group, animations: group.animations, source: group }
  }
  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader(manager)
    loader.register((parser) => new GLTFSpecularGlossinessExtension(parser))
    const gltf = await loader.parseAsync(ext === 'glb' ? buffer : textDecoder.decode(bytes), base)
    const root = gltf.scene || (gltf.scenes && gltf.scenes[0])
    return { root, animations: gltf.animations, source: gltf }
  }
  if (ext === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js')
    const text = textDecoder.decode(bytes)
    const loader = new OBJLoader(manager)
    // The .mtl the OBJ names (mtllib), else the only .mtl in the bundle.
    const named = /^\s*mtllib\s+(.+?)\s*$/im.exec(text)
    const mtlKeys = [...files.keys()].filter((k) => extOf(k) === 'mtl')
    const mtlKey = (named && createResourceResolver(mtlKeys).find(named[1].trim())) || (mtlKeys.length === 1 ? mtlKeys[0] : null)
    if (mtlKey) {
      const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js')
      const mtlDir = mtlKey.includes('/') ? mtlKey.slice(0, mtlKey.lastIndexOf('/') + 1) : ''
      const creator = new MTLLoader(manager).parse(textDecoder.decode(files.get(mtlKey)), BUNDLE_SCHEME + mtlDir)
      creator.preload()
      loader.setMaterials(creator)
    }
    const group = loader.parse(text)
    // An .mtl the OBJ asks for that wasn't provided: every material falls back to plain grey.
    const missingFiles = named && !mtlKey ? [named[1].trim()] : []
    return { root: group, animations: [], source: group, missingFiles }
  }
  if (ext === 'dae') {
    const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js')
    const collada = new ColladaLoader(manager).parse(textDecoder.decode(bytes), base)
    return { root: collada.scene, animations: collada.animations || [], source: collada }
  }
  if (ext === 'stl') {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js')
    const geometry = new STLLoader(manager).parse(buffer)
    const material = new THREE.MeshStandardMaterial({ color: 0xcccccc, vertexColors: !!geometry.hasColors })
    const group = new THREE.Group()
    group.add(Object.assign(new THREE.Mesh(geometry, material), { name: stemOf(mainPath) }))
    return { root: group, animations: [], source: group }
  }
  if (ext === 'ply') {
    const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js')
    const geometry = new PLYLoader(manager).parse(buffer)
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
    const material = new THREE.MeshStandardMaterial({ color: 0xcccccc, vertexColors: !!geometry.getAttribute('color') })
    const group = new THREE.Group()
    group.add(Object.assign(new THREE.Mesh(geometry, material), { name: stemOf(mainPath) }))
    return { root: group, animations: [], source: group }
  }
  throw new Error(`Unsupported file type ".${ext}".`)
}

// Pair up images nothing referenced with the model's materials (see
// planLooseTextures / planExtraMaps for the rules): colour pictures for plain
// materials, and normal / specular / roughness / metalness / AO / emissive maps
// for whichever material they're named after. Returns { colour, extra } — how many
// of each got applied.
const EXTRA_SLOTS = {
  normal: 'normalMap',
  specular: 'specularMap', // Phong-family materials only (an OBJ's default material is one)
  roughness: 'roughnessMap',
  metalness: 'metalnessMap',
  ao: 'aoMap',
  emissive: 'emissiveMap',
}
const COLOR_SPACE_ROLES = new Set(['emissive'])

async function applyLooseTextures(root, files, served, manager) {
  const candidates = [...files.keys()].filter((k) => isImageName(k) && !served.has(k))
  if (!candidates.length) return { colour: 0, extra: 0 }

  const entries = new Map() // material -> { id, names, textured, has, material }
  root.traverse((obj) => {
    if (!obj.isMesh) return
    for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      if (!material || !('map' in material) || material.isShaderMaterial) continue
      if (!entries.has(material)) {
        const has = {}
        for (const [role, slot] of Object.entries(EXTRA_SLOTS)) has[role] = !(slot in material) || !!material[slot]
        entries.set(material, { id: entries.size, names: [material.name], textured: !!material.map || !!material.vertexColors, has, material })
      }
      entries.get(material).names.push(obj.name)
    }
  })
  const list = [...entries.values()]
  const colourPlan = planLooseTextures(list, candidates)
  const extraPlan = planExtraMaps(list, candidates)
  if (!colourPlan.length && !extraPlan.length) return { colour: 0, extra: 0 }

  const textures = new Map() // image path -> Promise<Texture>
  const loadTexture = (path, srgb) => {
    const key = path + (srgb ? '#srgb' : '')
    if (!textures.has(key)) {
      const url = URL.createObjectURL(new Blob([files.get(path)], { type: mimeOf(path) }))
      const loader = extOf(path) === 'tga' ? manager.getHandler('.tga') : new THREE.TextureLoader(manager)
      textures.set(
        key,
        loader.loadAsync(url).then((tex) => {
          if (srgb) tex.colorSpace = THREE.SRGBColorSpace
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping
          URL.revokeObjectURL(url)
          return tex
        }),
      )
    }
    return textures.get(key)
  }
  const byId = new Map(list.map((e) => [e.id, e]))

  let colour = 0
  for (const { id, path } of colourPlan) {
    const { material } = byId.get(id)
    try {
      material.map = await loadTexture(path, true)
      if (material.color) material.color.set(0xffffff) // grey default would otherwise dim the picture
      material.needsUpdate = true
      colour++
    } catch {
      // an undecodable image just leaves the material as it was
    }
  }
  let extra = 0
  for (const { id, role, path } of extraPlan) {
    const { material } = byId.get(id)
    const slot = EXTRA_SLOTS[role]
    if (!slot || !(slot in material) || material[slot]) continue
    try {
      material[slot] = await loadTexture(path, COLOR_SPACE_ROLES.has(role))
      if (role === 'emissive' && material.emissive) material.emissive.set(0xffffff)
      material.needsUpdate = true
      extra++
    } catch {
      // as above
    }
  }
  return { colour, extra }
}

// SimplifyModifier intentionally removes skin attributes, so applying it to a
// SkinnedMesh would break animation. Static meshes and morph targets are also
// skipped when their vertex data has animation-specific semantics.
export function applyImportOptimization(root) {
  if (!root) return { optimizedMeshes: 0, skippedMeshes: 0, savedVertices: 0 }

  const modifier = new SimplifyModifier()
  const result = { optimizedMeshes: 0, skippedMeshes: 0, savedVertices: 0 }
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return

    const position = obj.geometry.getAttribute('position')
    const vertexCount = position ? position.count : 0
    const plan = getImportDecimationPlan(vertexCount)
    if (!plan) return

    const hasMorphTargets =
      Object.keys(obj.morphTargetDictionary || {}).length > 0 ||
      Object.keys(obj.geometry.morphAttributes || {}).length > 0
    if (obj.isSkinnedMesh || hasMorphTargets || obj.geometry.groups.length > 0) {
      result.skippedMeshes++
      return
    }

    const simplified = modifier.modify(obj.geometry, Math.floor(vertexCount * plan.reduction))
    const oldGeometry = obj.geometry
    obj.geometry = simplified
    oldGeometry.dispose()
    result.optimizedMeshes++
    result.savedVertices += Math.max(0, vertexCount - simplified.getAttribute('position').count)
  })
  return result
}

// Backwards-compatible alias (some callers still import loadGLB).
export { loadModel as loadGLB }

// Walk a loaded scene graph and collect the references the app cares about.
// Format-agnostic: works for both glTF scenes and FBX groups.
function parseRoot(root, animations, fileName, format, source) {
  if (!root) throw new Error('Model contains no scene/root object.')

  const skinnedMeshes = []
  const meshes = []
  const boneSet = new Set()
  let skeleton = null

  root.traverse((obj) => {
    if (obj.isSkinnedMesh) {
      // Keep animated meshes eligible for culling. The old blanket opt-out made
      // every high-poly character pay for every draw even when off-screen.
      obj.frustumCulled = true
      skinnedMeshes.push(obj)
      if (!skeleton && obj.skeleton) skeleton = obj.skeleton
      if (obj.skeleton) {
        for (const b of obj.skeleton.bones) boneSet.add(b)
      }
    }
    if (obj.isMesh) meshes.push(obj)
    // Some rigs expose bones as loose Bone nodes; catch those too.
    if (obj.isBone) boneSet.add(obj)
  })

  const bones = collapseNestedBoneDuplicates(Array.from(boneSet))
  const clips = animations || []

  const info = {
    name: cleanName(fileName),
    format,
    meshCount: meshes.length,
    boneCount: bones.length,
    clipNames: clips.map((c) => c.name),
    // Lightweight mesh list for per-mesh UI controls (outline/shading overrides).
    // uuid is the stable per-load key; name falls back to a positional label.
    meshes: meshes.map((m, i) => ({ uuid: m.uuid, name: m.name || `Mesh ${i + 1}` })),
    // Flat bone list for the pose panel's tree: depth = number of Bone ancestors
    // (for indentation); deform=false marks helper bones the UI can hide.
    bones: classifyBones(bones),
  }

  return { source, root, skinnedMeshes, meshes, skeleton, bones, clips, info }
}

// Some FBX exports nest same-named skin joints below the bones that control
// them. Keep the outer controls so posing and animation retain FK inheritance.
export function collapseNestedBoneDuplicates(bones) {
  const boneSet = new Set(bones)
  return bones.filter((bone) => {
    if (!bone.name) return true
    for (let parent = bone.parent; parent; parent = parent.parent) {
      if (parent.isBone && parent.name && parent.name === bone.name && boneSet.has(parent)) return false
    }
    return true
  })
}

// --- Bone classification -----------------------------------------------------
//
// Dense game rigs carry hundreds of
// bones nobody poses by hand: auto-generated "_end" tail bones, twist/volume/
// roll correctives, weapon sockets. Flag those as deform=false so the UI can
// hide their dots and rows. Two schemes:
// - Rigify rigs (any DEF- bone present): primary = the DEF- bones, as before.
// - Everything else: primary = bones that don't match the helper name patterns.

// Blender/Sketchfab tail bones: "..._end", possibly followed by uniquifying
// numeric suffixes ("HeadTop_End_07", "index_03_l_end_0458").
const END_BONE_RE = /_end(_\d+)*$/i
// Twist / volume-preservation / roll correctives, sockets and weapon mounts.
const HELPER_BONE_RE = /(twist|(^|_)vol(ume)?(_|$)|socket|weapon|(^|_)roll(_|$)|(^|_)ik(_|$))/i

function classifyBones(bones) {
  const names = bones.map((b, i) => b.name || `Bone ${i + 1}`)
  const rigify = names.some((n) => /^DEF-/.test(n))
  const labels = displayLabels(names)
  return bones.map((b, i) => ({
    name: names[i],
    label: labels[i],
    depth: boneDepth(b),
    deform: rigify
      ? /^DEF-/.test(names[i])
      : !(END_BONE_RE.test(names[i]) || HELPER_BONE_RE.test(names[i])),
  }))
}

// Human-friendly display names: drop namespace prefixes and
// the "_0NN" uniquifying suffixes Sketchfab's FBX→glTF pipeline appends — but
// only when the stripped names stay unique across the whole rig, so we never
// show two bones with the same label. Selection/pose files always use the real
// name; labels are display-only.
function displayLabels(names) {
  const noNs = names.map((n) => (n.includes(':') ? n.slice(n.lastIndexOf(':') + 1) : n))
  const stripped = noNs.map((n) => n.replace(/_0?\d+$/, ''))
  const strippedOk =
    stripped.every(Boolean) && new Set(stripped).size === stripped.length
  if (strippedOk) return stripped
  const noNsOk = noNs.every(Boolean) && new Set(noNs).size === noNs.length
  return noNsOk ? noNs : names
}

// Count how many Bone ancestors a bone has (used for tree indentation).
function boneDepth(bone) {
  let depth = 0
  let node = bone.parent
  while (node && node.isBone) {
    depth++
    node = node.parent
  }
  return depth
}

function extensionOf(fileName) {
  const m = /\.([^.]+)$/.exec(fileName)
  return m ? m[1].toLowerCase() : ''
}

function cleanName(fileName) {
  return fileName.replace(SUPPORTED_EXTENSION_RE, '')
}

/**
 * Deep-dispose an Object3D subtree: geometries, materials, and any textures the
 * materials reference. Called before loading a new model so the GPU memory of
 * the old one is actually released (the whole point of this app).
 */
export function disposeObject(object) {
  if (!object) return
  object.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose()
    if (obj.material) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
      for (const mat of materials) disposeMaterial(mat)
    }
  })
}

function disposeMaterial(material) {
  if (!material) return
  // Dispose every texture-like property the material holds.
  for (const key of Object.keys(material)) {
    const value = material[key]
    if (value && value.isTexture) value.dispose()
  }
  material.dispose()
}
