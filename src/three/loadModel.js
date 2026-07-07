import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import * as THREE from 'three'

// One shared loader instance. GLTFLoader is stateless per-parse, so reuse is fine.
const loader = new GLTFLoader()

/**
 * Load a .glb / .gltf File (from a file input or drag-and-drop) into a parsed
 * result. No server round-trip: we use an object URL over the local File blob.
 *
 * Returns a plain object describing everything Phase 1+ needs:
 *   {
 *     gltf,            // raw GLTFLoader result (kept for animations later)
 *     root,            // THREE.Group to add to the scene
 *     skinnedMeshes,   // SkinnedMesh[]
 *     meshes,          // all Mesh[] (incl. non-skinned)
 *     skeleton,        // first skeleton found (or null)
 *     bones,           // Bone[] (deduped)
 *     clips,           // THREE.AnimationClip[]
 *     info,            // { name, meshCount, boneCount, clipNames }
 *   }
 *
 * NOTE: Draco/KTX2/meshopt compression is not wired up in v1. If a Blender
 * export uses Draco mesh compression, the loader will throw; we surface a clear
 * message telling the user to re-export without it.
 */
export async function loadGLB(file) {
  const url = URL.createObjectURL(file)
  try {
    const gltf = await loader.loadAsync(url)
    return parseGltf(gltf, file.name)
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

// Walk the loaded scene graph and collect the references the app cares about.
function parseGltf(gltf, fileName) {
  const root = gltf.scene || (gltf.scenes && gltf.scenes[0])
  if (!root) throw new Error('glTF contains no scene.')

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
  const clips = gltf.animations || []

  const info = {
    name: cleanName(fileName),
    meshCount: meshes.length,
    boneCount: bones.length,
    clipNames: clips.map((c) => c.name),
  }

  return { gltf, root, skinnedMeshes, meshes, skeleton, bones, clips, info }
}

function cleanName(fileName) {
  return fileName.replace(/\.(glb|gltf)$/i, '')
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
