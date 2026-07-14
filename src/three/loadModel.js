import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

// glTF is the common case, so its loader is bundled eagerly. FBXLoader drags in
// fflate + NURBS helpers (~hundreds of KB), so it is code-split behind a dynamic
// import and only fetched the first time someone actually opens a .fbx file.
const gltfLoader = new GLTFLoader()
let fbxLoader = null

async function getFbxLoader() {
  if (!fbxLoader) {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
    fbxLoader = new FBXLoader()
  }
  return fbxLoader
}

// Supported input extensions, in the order we advertise them to the user.
export const SUPPORTED_EXTENSIONS = ['glb', 'gltf', 'fbx']

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
 * Returns a plain object describing everything Phase 1+ needs:
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
 * NOTE: Draco/KTX2/meshopt compression is not wired up in v1. If a Blender glTF
 * export uses Draco mesh compression, the loader will throw; we surface a clear
 * message telling the user to re-export without it.
 */
export async function loadModel(file) {
  const ext = extensionOf(file.name)
  const url = URL.createObjectURL(file)
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const gltf = await gltfLoader.loadAsync(url)
      const root = gltf.scene || (gltf.scenes && gltf.scenes[0])
      return parseRoot(root, gltf.animations, file.name, ext, gltf)
    }
    if (ext === 'fbx') {
      // FBXLoader resolves to the model Group directly; clips live on .animations.
      const loader = await getFbxLoader()
      const group = await loader.loadAsync(url)
      return parseRoot(group, group.animations, file.name, ext, group)
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

// Backwards-compatible alias for the original Phase 1 entry point.
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

  const bones = Array.from(boneSet)
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

// --- Bone classification -----------------------------------------------------
//
// Dense game rigs (Mixamo, Unreal/Marvel-Rivals-style exports) carry hundreds of
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

// Human-friendly display names: drop "mixamorig:"-style namespace prefixes and
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
