import * as THREE from 'three'
import { buildNameMatch, buildSlotMapping, mergeNames, parseBVH, retargetParsed } from './bvh.js'
import { libraryPoseClip, retargetLibraryClip } from './libraryRetarget.js'

export function previewModelFromRoot(root) {
  const bones = []
  const skinnedMeshes = []
  root.traverse((object) => {
    if (object.isBone) bones.push(object)
    if (object.isSkinnedMesh) skinnedMeshes.push(object)
  })
  return { root, bones, skinnedMeshes }
}

export async function retargetPreviewBVH(text, root, name = 'Preview') {
  const parsed = await parseBVH({ name: `${name}.bvh`, text: async () => text })
  const model = previewModelFromRoot(root)
  const targetNames = model.bones.map((bone) => bone.name)
  parsed.autoNames = buildNameMatch(targetNames, parsed.bones)
  const slots = buildSlotMapping(targetNames, parsed.bones, model.bones, parsed.skeleton.bones)
  const { names, hip } = mergeNames(parsed.autoNames, slots)
  const before = model.bones.map((bone) => ({
    bone,
    position: bone.position.clone(),
    quaternion: bone.quaternion.clone(),
  }))
  try {
    const { clip } = await retargetParsed(parsed, model, names, hip, name)
    return clip
  } finally {
    for (const item of before) {
      item.bone.position.copy(item.position)
      item.bone.quaternion.copy(item.quaternion)
    }
    root.updateWorldMatrix(true, true)
  }
}

export function animationClipFromJSON(json) {
  return json ? THREE.AnimationClip.parse(json.clip || json) : null
}

export function retargetLibraryPreview(entry, root) {
  const json = entry.kind === 'body' ? libraryPoseClip(entry.data.bones) : entry.data.clip
  return retargetLibraryClip(json, entry.data.rig, previewModelFromRoot(root))
}
