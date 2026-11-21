import * as THREE from 'three'
import { buildNameMatch, buildSlotMapping, mergeNames, retargetParsed } from './bvh.js'

// Capture the rest hierarchy, including non-bone parents that define bone space.
export function captureLibraryRig(model) {
  const bones = model.bones || []
  const included = new Set()
  for (const bone of bones) {
    for (let node = bone; node && node !== model.root; node = node.parent) included.add(node)
  }
  const nodes = [...included]
  const indices = new Map(nodes.map((node, i) => [node, i]))
  return {
    nodes: nodes.map((node) => ({
      name: node.name,
      uuid: node.uuid,
      bone: !!node.isBone,
      parent: indices.has(node.parent) ? indices.get(node.parent) : -1,
      position: node.position.toArray(),
      quaternion: node.quaternion.toArray(),
      scale: node.scale.toArray(),
    })),
  }
}

function restoreSource(rig) {
  if (!Array.isArray(rig?.nodes) || !rig.nodes.length) throw new Error('The saved source rig is invalid.')
  const root = new THREE.Group()
  const nodes = rig.nodes.map((item) => {
    const node = item.bone ? new THREE.Bone() : new THREE.Object3D()
    node.name = item.name
    node.position.fromArray(item.position)
    node.quaternion.fromArray(item.quaternion)
    node.scale.fromArray(item.scale)
    return node
  })
  for (let i = 0; i < nodes.length; i++) {
    const parent = rig.nodes[i].parent
    if (parent !== -1 && (!Number.isInteger(parent) || !nodes[parent] || parent === i)) throw new Error('The saved source rig has an invalid hierarchy.')
    ;(parent === -1 ? root : nodes[parent]).add(nodes[i])
  }
  let reachable = 0
  root.traverse(() => { reachable++ })
  if (reachable !== nodes.length + 1) throw new Error('The saved source rig has an invalid hierarchy.')
  const bones = nodes.filter((node) => node.isBone)
  if (!bones.length || new Set(bones.map((bone) => bone.name)).size !== bones.length) {
    throw new Error('The saved source rig needs uniquely named bones for retargeting.')
  }
  root.updateMatrixWorld(true)
  return { root, bones }
}

export function libraryRigsMatch(source, target) {
  if (!source?.nodes || !target?.nodes || source.nodes.length !== target.nodes.length) return false
  return source.nodes.every((node, i) => {
    const other = target.nodes[i]
    return node.name === other.name && node.bone === other.bone && node.parent === other.parent &&
      ['position', 'quaternion', 'scale'].every((key) =>
        Array.isArray(node[key]) && node[key].length === other[key].length &&
        node[key].every((value, j) => Math.abs(value - other[key][j]) < 1e-5))
  })
}

// Reuse the BVH retargeter with the actual saved rest pose rather than BVH's
// first-frame calibration. Resample independent track times onto a common grid.
export function retargetLibraryClip(json, rig, model) {
  const source = restoreSource(rig)
  const clip = THREE.AnimationClip.parse(json?.clip || json)
  const byId = new Map()
  for (const node of rig.nodes) if (node.bone) {
    byId.set(node.uuid, node.name)
    if (!byId.has(node.name)) byId.set(node.name, node.name)
  }
  const sourceTracks = []
  for (const track of clip.tracks) {
    let binding
    try { binding = THREE.PropertyBinding.parseTrackName(track.name) } catch { continue }
    if (binding.propertyName !== 'quaternion' && binding.propertyName !== 'position') continue
    const id = binding.objectName === 'bones' ? binding.objectIndex : binding.nodeName
    const name = byId.get(id)
    if (name) sourceTracks.push({ track, name, property: binding.propertyName })
  }
  const sourceNames = source.bones.map((bone) => bone.name)
  const targetBones = model.bones || []
  const targetNames = targetBones.map((bone) => bone.name)
  const slots = buildSlotMapping(targetNames, sourceNames, targetBones, source.bones)
  const { names, hip } = mergeNames(buildNameMatch(targetNames, sourceNames), slots)
  const driven = new Set(sourceTracks.filter((item) => item.property === 'quaternion' || item.name === hip).map((item) => item.name))
  if (!Object.values(names).some((name) => driven.has(name))) {
    throw new Error('No animated source bones could be matched to this character.')
  }
  if (!sourceTracks.some((item) => item.property === 'quaternion')) {
    const bone = source.bones.find((item) => item.name === hip)
    if (!bone || !sourceTracks.some((item) => item.name === hip && item.property === 'position')) {
      throw new Error('This clip has no bone rotations or hip translation to retarget.')
    }
    sourceTracks.push({
      name: bone.name,
      property: 'quaternion',
      track: new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, [0], bone.quaternion.toArray()),
    })
  }
  const times = [...new Set([0, clip.duration, ...sourceTracks.flatMap(({ track }) => Array.from(track.times))])].sort((a, b) => a - b)
  const tracks = sourceTracks.map(({ track, name, property }) => {
    const interpolant = track.createInterpolant()
    const values = times.flatMap((time) => Array.from(interpolant.evaluate(time)))
    return property === 'quaternion'
      ? new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, values)
      : new THREE.VectorKeyframeTrack(`${name}.position`, times, values)
  })
  const parsed = {
    root: source.root,
    skeleton: { bones: source.bones },
    clip: new THREE.AnimationClip(clip.name, clip.duration, tracks),
    name: clip.name,
    useSourceRest: true,
  }
  return retargetParsed(parsed, model, names, hip, clip.name).clip
}

export function libraryPoseClip(bones) {
  const tracks = Object.entries(bones).map(([name, value]) => new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0], value))
  return new THREE.AnimationClip('Pose', 0, tracks).toJSON()
}
