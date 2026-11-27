import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { keyBone, keyTransform, sampleBoneKeys, sampleScaleKeys } from '../three/carryEdits.js'
import { initObjects } from '../three/objects.js'
import { initAnimation, setAnimationModel, selectClip, scrub, bakeClipToTracks } from '../three/animation.js'
import { __seedCharacterForTest, clearProjectScene } from '../three/scene.js'

const axisX = new THREE.Vector3(1, 0, 0)
const axisZ = new THREE.Vector3(0, 0, 1)
const rot = (axis, angle) => new THREE.Quaternion().setFromAxisAngle(axis, angle)
const q = (quat) => new THREE.Quaternion(quat[0], quat[1], quat[2], quat[3])
const angleBetween = (a, b) => q(a).angleTo(q(b))
const at = (keys, time) => keys.find((k) => Math.abs(k.time - time) < 1e-6)

// An arm that swings up 0 -> 30 -> 60 degrees about X over three keys.
const swing = () => [0, 1, 2].map((time) => ({ time, quat: rot(axisX, (time * Math.PI) / 6).toArray() }))
// "Move the arm out" by 20 degrees about Z, in the parent's frame.
const out = rot(axisZ, 0.35)

describe('carrying a pose edit forward', () => {
  it('without carrying, keying is plain insert / replace', () => {
    const keys = keyBone(swing(), 1, rot(axisZ, 0.35).toArray(), null, false)
    expect(keys.map((k) => k.time)).toEqual([0, 1, 2])
    expect(at(keys, 2).quat).toEqual(swing()[2].quat)
  })

  it('gives every later key the same change, and leaves earlier keys alone', () => {
    const original = swing()
    const edited = out.clone().multiply(q(original[1].quat)).toArray()
    const keys = keyBone(original, 1, edited, null, true)
    expect(at(keys, 0).quat).toEqual(original[0].quat)
    expect(angleBetween(at(keys, 1).quat, edited)).toBeLessThan(1e-6)
    // The later key is its own swing, turned by the same amount as the edit.
    expect(angleBetween(at(keys, 2).quat, out.clone().multiply(q(original[2].quat)).toArray())).toBeLessThan(1e-6)
  })

  it('the frames between later keys are the original animation plus the same change, as if every frame was edited', () => {
    const original = [0, 1, 2, 3].map((time) => ({ time, quat: rot(axisX, time * 0.4).toArray() }))
    const keys = keyBone(original, 1, out.clone().multiply(q(original[1].quat)).toArray(), null, true)
    for (const time of [1, 1.25, 1.5, 2, 2.6, 3]) {
      const was = q(sampleBoneKeys(original, time).quat)
      expect(angleBetween(sampleBoneKeys(keys, time).quat, out.clone().multiply(was).toArray())).toBeLessThan(1e-6)
    }
  })

  it('works from a time with no key: the change is measured against what the animation had there', () => {
    const original = swing()
    const was = q(sampleBoneKeys(original, 0.5).quat)
    const keys = keyBone(original, 0.5, out.clone().multiply(was).toArray(), null, true)
    expect(keys.map((k) => k.time)).toEqual([0, 0.5, 1, 2])
    expect(at(keys, 0).quat).toEqual(original[0].quat)
    expect(angleBetween(at(keys, 1).quat, out.clone().multiply(q(original[1].quat)).toArray())).toBeLessThan(1e-6)
    expect(angleBetween(at(keys, 2).quat, out.clone().multiply(q(original[2].quat)).toArray())).toBeLessThan(1e-6)
  })

  it('compounds when the same time is edited again', () => {
    const first = keyBone(swing(), 1, out.clone().multiply(q(swing()[1].quat)).toArray(), null, true)
    const second = keyBone(first, 1, out.clone().multiply(q(at(first, 1).quat)).toArray(), null, true)
    expect(angleBetween(at(second, 2).quat, out.clone().multiply(out).multiply(q(swing()[2].quat)).toArray())).toBeLessThan(1e-6)
  })

  it('leaves a bone alone when it did not really move (a whole-pose key records every bone)', () => {
    const original = swing()
    const noise = rot(axisZ, 1e-4).multiply(q(original[1].quat)).toArray()
    const keys = keyBone(original, 1, noise, null, true)
    expect(at(keys, 2).quat).toEqual(original[2].quat)
  })

  it('does nothing extra when there are no later keys or no keys at all', () => {
    expect(keyBone(swing(), 2, rot(axisZ, 1).toArray(), null, true).map((k) => k.time)).toEqual([0, 1, 2])
    expect(keyBone(undefined, 1, rot(axisZ, 1).toArray(), null, true)).toEqual([{ time: 1, quat: rot(axisZ, 1).toArray() }])
  })

  it('carries a position change onto later keys that have one, and keeps an existing position when none is given', () => {
    const keys0 = [0, 1, 2].map((time) => ({ time, quat: [0, 0, 0, 1], pos: [0, 1 + time * 0.1, 0] }))
    const keys = keyBone(keys0, 1, [0, 0, 0, 1], [0, 0.9, 0], true)
    expect(at(keys, 2).pos[1]).toBeCloseTo(1.2 - 0.2, 6)
    expect(at(keys, 0).pos).toEqual([0, 1, 0])
    expect(keyBone(keys0, 1, [0, 0, 0, 1], null, false).find((k) => k.time === 1).pos).toEqual([0, 1.1, 0])
  })
})

describe('carrying a resize forward', () => {
  const sized = () => [1, 2, 3].map((value, i) => ({ time: i, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [value, value, value] }))

  it('scales every later key by the same factor and leaves earlier keys alone', () => {
    const keys = keyTransform(sized(), 1, { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [3, 3, 3] }, true)
    expect(at(keys, 0).scale).toEqual([1, 1, 1])
    expect(at(keys, 1).scale).toEqual([3, 3, 3])
    expect(at(keys, 2).scale).toEqual([4.5, 4.5, 4.5])
  })

  it('works per axis and from a time between keys', () => {
    const was = sampleScaleKeys(sized(), 0.5)
    expect(was[0]).toBeCloseTo(1.5, 6)
    const keys = keyTransform(sized(), 0.5, { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [3, 1.5, 1.5] }, true)
    expect(at(keys, 1).scale[0]).toBeCloseTo(4, 6)
    expect(at(keys, 1).scale[1]).toBeCloseTo(2, 6)
  })

  it('does nothing when the size did not change, or when carrying is off', () => {
    const same = keyTransform(sized(), 1, { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [2, 2, 2] }, true)
    expect(at(same, 2).scale).toEqual([3, 3, 3])
    const off = keyTransform(sized(), 1, { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [3, 3, 3] }, false)
    expect(at(off, 2).scale).toEqual([3, 3, 3])
  })
})

describe('the store actions carry when asked', () => {
  beforeEach(() => {
    useStore.getState().resetAnimData?.()
    useStore.setState({ animData: { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} }, objectAnimData: {} })
  })

  it('addKeyframe and addKeyframesAtTime', () => {
    useStore.setState({ animData: { ...useStore.getState().animData, tracks: { Arm: swing(), Leg: swing() } } })
    const edited = out.clone().multiply(q(swing()[1].quat)).toArray()
    useStore.getState().addKeyframe('Arm', 1, edited, true)
    useStore.getState().addKeyframesAtTime([{ name: 'Leg', quat: edited }], 1, false)
    const { tracks } = useStore.getState().animData
    expect(angleBetween(at(tracks.Arm, 2).quat, out.clone().multiply(q(swing()[2].quat)).toArray())).toBeLessThan(1e-6)
    expect(at(tracks.Leg, 2).quat).toEqual(swing()[2].quat)
  })

  it('addObjectTransformKeyframe and addMeshKeyframe resize later keys', () => {
    const key = (s) => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [s, s, s] })
    const store = useStore.getState()
    store.addObjectTransformKeyframe('box', 0, key(1))
    store.addObjectTransformKeyframe('box', 2, key(2))
    store.addObjectTransformKeyframe('box', 1, key(1.5), true)
    expect(at(useStore.getState().objectAnimData.box, 2).scale).toEqual([2, 2, 2]) // 1.5 was what it already was: no change
    store.addObjectTransformKeyframe('box', 0, key(2), true)
    expect(at(useStore.getState().objectAnimData.box, 2).scale).toEqual([4, 4, 4])

    store.addMeshKeyframe(0, 0, { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] })
    store.addMeshKeyframe(0, 2, { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] })
    store.addMeshKeyframe(0, 0, { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [2, 2, 2] }, true)
    expect(at(useStore.getState().animData.meshes[0], 2).scale).toEqual([2, 2, 2])
  })
})

// The case that prompted this: a clip with no keys of its own, a limb edited part way through, then keyed.
describe('keying an edited limb on a clip that has no keys', () => {
  const scene = new THREE.Scene()

  it('the pose you set up is what gets keyed, and every later frame carries the same change', () => {
    initObjects({ scene, camera: new THREE.PerspectiveCamera(), renderer: { domElement: document.createElement('canvas') }, controls: { enabled: true, locked: false }, requestRender: () => {} })
    initAnimation({ requestRender: () => {}, suspendPosing: () => {}, resumePosing: () => {}, onTime: () => {}, setContinuousRender: () => {}, onEnded: () => {} })
    clearProjectScene()
    const root = new THREE.Group()
    const hips = new THREE.Bone(); hips.name = 'Hips'; root.add(hips)
    const arm = new THREE.Bone(); arm.name = 'Arm'; arm.position.set(0.3, 0.5, 0); hips.add(arm)
    const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
    mesh.bind(new THREE.Skeleton([hips, arm])); root.add(mesh)
    const clip = new THREE.AnimationClip('Wave', 2, [
      new THREE.QuaternionKeyframeTrack('Arm.quaternion', [0, 2], [...rot(axisX, 0).toArray(), ...rot(axisX, 1.2).toArray()]),
    ])
    const parsed = { root, bones: [hips, arm], skinnedMeshes: [mesh], meshes: [mesh], skeleton: mesh.skeleton, clips: [clip], info: { name: 'x', clipNames: ['Wave'], bones: [], meshCount: 1, boneCount: 2 } }
    __seedCharacterForTest('c1', parsed, scene)
    setAnimationModel(parsed, 'c1')
    selectClip('Wave', { loop: false, speed: 1 })
    scrub(1)

    // The user moves the arm out, on top of the clip's own pose at 1s.
    arm.quaternion.premultiply(out)
    const pose = [hips, arm].map((bone) => ({ name: bone.name, quat: bone.quaternion.toArray(), pos: bone.position.toArray() }))

    // Key position bakes the clip to keys, then keys the pose that was read BEFORE the bake.
    const baked = bakeClipToTracks('Wave', 24, 2, false)
    useStore.setState({ animData: { ...useStore.getState().animData, tracks: baked.tracks } })
    const before = baked.tracks.Arm
    useStore.getState().addKeyframesAtTime(pose, 1, true)
    const keyed = useStore.getState().animData.tracks.Arm

    expect(angleBetween(at(keyed, 1).quat, pose[1].quat)).toBeLessThan(1e-3) // the pose set up is kept
    expect(angleBetween(at(keyed, 0).quat, at(before, 0).quat)).toBeLessThan(1e-6) // earlier frames untouched
    for (const frame of keyed.filter((k) => k.time > 1.0001)) {
      const original = at(before, frame.time)
      expect(angleBetween(frame.quat, out.clone().multiply(q(original.quat)).toArray())).toBeLessThan(1e-3)
    }
    expect(keyed.filter((k) => k.time > 1.0001).length).toBeGreaterThan(10)
  })
})
