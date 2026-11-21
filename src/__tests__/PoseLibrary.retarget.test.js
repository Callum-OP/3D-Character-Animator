import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  clearAnimationModel, getLibraryRig, initAnimation, prepareLibraryClip,
  retargetLibraryPose, setAnimationModel,
} from '../three/animation.js'

function model(names, twist = 0) {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = names[0]
  hips.position.y = 1
  const spine = new THREE.Bone()
  spine.name = names[1]
  spine.position.y = 0.4
  spine.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), twist)
  const head = new THREE.Bone()
  head.name = names[2]
  head.position.y = 0.4
  root.add(hips)
  hips.add(spine)
  spine.add(head)
  const bones = [hips, spine, head]
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  mesh.bind(new THREE.Skeleton(bones))
  root.add(mesh)
  root.updateMatrixWorld(true)
  return { root, bones, skinnedMeshes: [mesh], clips: [] }
}

const sourceNames = ['Hips', 'Spine', 'Head']
const targetNames = ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Head']
const values = (q) => q.toArray()
const turn = (angle) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle)

function fixture() {
  const source = model(sourceNames, Math.PI / 2)
  setAnimationModel(source, 'source')
  const rig = getLibraryRig()
  const rest = source.bones[1].quaternion.clone()
  const clip = new THREE.AnimationClip('Move', 2, [
    new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, 2], [...values(rest.clone().multiply(turn(0.3))), ...values(rest.clone().multiply(turn(0.9)))]),
    new THREE.QuaternionKeyframeTrack('Head.quaternion', [0, 1, 2], [...values(turn(0)), ...values(turn(0.2)), ...values(turn(0))]),
  ])
  const target = model(targetNames)
  setAnimationModel(target, 'target')
  return { source, target, rig, clip }
}

initAnimation({ requestRender: () => {} })
afterEach(() => {
  clearAnimationModel('source')
  clearAnimationModel('target')
})

describe('saved library retargeting', () => {
  it('retargets a clip from its real rest pose, including its first frame and independent track times', () => {
    const { target, rig, clip } = fixture()
    target.bones[1].quaternion.copy(turn(0.5))
    const before = target.bones[1].quaternion.clone()
    const result = prepareLibraryClip({ clip: clip.toJSON(), editKeys: { tracks: { Spine: [] } } }, rig)
    expect(result.retargeted).toBe(true)
    expect(result.clip.editKeys).toBeUndefined()
    expect(target.bones[1].quaternion.angleTo(before)).toBeCloseTo(0)
    const spine = result.clip.tracks.find((track) => track.name === 'mixamorig:Spine.quaternion')
    expect(Array.from(spine.times)).toEqual([0, 1, 2])
    const q0 = new THREE.Quaternion().fromArray(spine.values, 0)
    const q2 = new THREE.Quaternion().fromArray(spine.values, 8)
    expect(q0.angleTo(new THREE.Quaternion())).toBeCloseTo(0.3, 4)
    expect(q0.angleTo(q2)).toBeCloseTo(0.6, 4)
  })

  it('retargets a static pose instead of treating its first frame as rest', () => {
    const { source, target, rig } = fixture()
    const posed = source.bones[1].quaternion.clone().multiply(turn(0.7))
    const bones = Object.fromEntries(source.bones.map((bone) => [bone.name, values(bone === source.bones[1] ? posed : bone.quaternion)]))
    const result = retargetLibraryPose(bones, rig)
    expect(new THREE.Quaternion().fromArray(result[targetNames[1]]).angleTo(new THREE.Quaternion())).toBeCloseTo(0.7, 4)
    expect(target.bones[1].quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0)
  })

  it('retargets hip translation even when the clip has no rotation tracks', () => {
    const { rig } = fixture()
    const clip = new THREE.AnimationClip('Travel', 1, [
      new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0.2, 1, 0, 0.7, 1, 0]),
    ])
    const result = prepareLibraryClip({ clip: clip.toJSON() }, rig)
    const hip = result.clip.tracks.find((track) => track.name === 'mixamorig:Hips.position')
    expect(hip.values[0]).toBeCloseTo(0.2)
    expect(hip.values[3]).toBeCloseTo(0.7)
  })

  it('keeps same-rig clips intact and rejects incompatible legacy clips', () => {
    const { clip } = fixture()
    const rig = getLibraryRig()
    const same = new THREE.AnimationClip('Same', 1, [
      new THREE.QuaternionKeyframeTrack('mixamorig:Spine.quaternion', [0], values(turn(0.4))),
    ])
    const result = prepareLibraryClip({ clip: same.toJSON(), editKeys: { tracks: {}, duration: 1 } }, rig)
    expect(result.retargeted).toBe(false)
    expect(result.clip.editKeys.duration).toBe(1)
    expect(() => prepareLibraryClip({ clip: clip.toJSON() })).toThrow(/older library clip.*source rig/i)
  })

  it('remaps UUID-bound tracks on an otherwise identical rig', () => {
    const source = model(sourceNames)
    setAnimationModel(source, 'source')
    const rig = getLibraryRig()
    const clip = new THREE.AnimationClip('UUID', 1, [
      new THREE.QuaternionKeyframeTrack(`${source.bones[1].uuid}.quaternion`, [0], values(turn(0.4))),
    ])
    const target = model(sourceNames)
    setAnimationModel(target, 'target')
    const result = prepareLibraryClip({ clip: clip.toJSON() }, rig)
    expect(result.retargeted).toBe(false)
    expect(result.clip.tracks[0].name).toBe(`${target.bones[1].uuid}.quaternion`)
  })

  it('retargets rigs with the same bone names but different rest rotations', () => {
    const source = model(sourceNames, Math.PI / 2)
    setAnimationModel(source, 'source')
    const rig = getLibraryRig()
    const q = source.bones[1].quaternion.clone().multiply(turn(0.6))
    const clip = new THREE.AnimationClip('Pose', 1, [
      new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0], values(q)),
    ])
    setAnimationModel(model(sourceNames), 'target')
    const result = prepareLibraryClip({ clip: clip.toJSON() }, rig)
    const spine = result.clip.tracks.find((track) => track.name === 'Spine.quaternion')
    expect(result.retargeted).toBe(true)
    expect(new THREE.Quaternion().fromArray(spine.values).angleTo(new THREE.Quaternion())).toBeCloseTo(0.6, 4)
  })
})
