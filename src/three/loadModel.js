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
  }

  return { source, root, skinnedMeshes, meshes, skeleton, bones, clips, info }
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
