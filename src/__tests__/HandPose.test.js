import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import {
  analyseHands,
  migrateHandPose,
  analyticHandPose,
  captureHandPose,
  handPoseToBoneQuats,
  handPosesFromBVH,
  handSegments,
  isHandBone,
  BASIC_HANDS,
} from '../three/handPose.js'
import { makeHandRig, makeHandBVH, tipPos } from './helpers/syntheticHand.js'
import { fingerInfo } from '../three/fingers.js'

function setup(opts) {
  const rig = makeHandRig(opts)
  const rigs = analyseHands(rig.bones, rig.restQuatOf)
  expect(rigs).toHaveLength(1)
  return { ...rig, handRig: rigs[0] }
}

function pose(h, quats) {
  for (const [name, q] of Object.entries(quats)) {
    const bone = h.bones.find((b) => b.name === name)
    bone.quaternion.set(q[0], q[1], q[2], q[3])
  }
  h.hips.updateWorldMatrix(false, true)
}

function reset(h) {
  for (const b of h.bones) b.quaternion.copy(h.restQuatOf(b))
  h.hips.updateWorldMatrix(false, true)
}

const fist = BASIC_HANDS.find((b) => b.id === 'fist')

describe('hand rigs', () => {
  for (const names of ['mixamo', 'blender', 'plain']) {
    it(`finds 5 fingers of 3 bones and the side with ${names} bone names`, () => {
      const { handRig } = setup({ side: 'L', names })
      expect(handRig.side).toBe('L')
      expect(Object.keys(handRig.fingers).sort()).toEqual(['index', 'middle', 'pinky', 'ring', 'thumb'])
      for (const chain of Object.values(handRig.fingers)) expect(chain).toHaveLength(3)
    })
  }

  it('leaves the rig exactly as it was after measuring it', () => {
    const rig = makeHandRig({ side: 'R' })
    rig.bones[3].quaternion.set(0.2, 0.1, 0.3, 0.9).normalize()
    const before = rig.bones.map((b) => b.quaternion.clone())
    analyseHands(rig.bones, rig.restQuatOf)
    rig.bones.forEach((b, i) => expect(b.quaternion.equals(before[i])).toBe(true))
  })

  for (const nested of [false, true]) {
    it(`recognises control bones with ${nested ? 'nested' : 'sibling'} same-named skin joints`, () => {
      const h = makeHandRig({ side: 'L' })
      const tip = h.fingers.index[2].children.find((b) => b.isBone)
      for (const bone of [h.hand, ...Object.values(h.fingers).flat()]) {
        const duplicate = new THREE.Bone()
        duplicate.name = bone.name
        if (nested) {
          for (const child of [...bone.children]) duplicate.add(child)
          bone.add(duplicate)
        } else {
          bone.add(duplicate)
          bone.children.unshift(bone.children.pop())
        }
      }
      h.hips.updateWorldMatrix(false, true)
      const [rig] = analyseHands(h.bones, h.restQuatOf)
      expect(rig.hand).toBe(h.hand)
      for (const finger of Object.keys(h.fingers)) expect(rig.fingers[finger]).toEqual(h.fingers[finger])
      expect(fingerInfo(h.fingers.index[2], isHandBone)).toMatchObject({ segment: 3, tip: false })
      expect(fingerInfo(tip, isHandBone)).toMatchObject({ segment: 4, tip: true })
      const before = tip.getWorldPosition(new THREE.Vector3())
      pose(h, handPoseToBoneQuats(rig, analyticHandPose(rig, fist)))
      expect(tip.getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeGreaterThan(0.03)
      expect(handSegments(rig)).toHaveLength(20)
    })
  }
})

describe('curling is toward the palm, whatever the rig does with its bone axes', () => {
  const cases = []
  for (const side of ['R', 'L']) for (const seed of [1, 2, 3, 4]) cases.push({ side, seed })
  for (const { side, seed } of cases) {
    it(`${side} hand, random bone axes #${seed}: a fist moves every fingertip out of the palm`, () => {
      const h = setup({ side, seed, names: seed % 2 ? 'mixamo' : 'blender' })
      const restTips = Object.fromEntries(Object.keys(h.fingers).map((f) => [f, h.anat(h.tip(f))]))
      const quats = handPoseToBoneQuats(h.handRig, analyticHandPose(h.handRig, fist))
      pose(h, quats)
      for (const finger of ['index', 'middle', 'ring', 'pinky']) {
        const now = h.anat(h.tip(finger))
        // moved toward +z (out of the palm), pulled back toward the wrist, and stayed on its own side
        expect(now.z - restTips[finger].z).toBeGreaterThan(0.015)
        expect(now.y).toBeLessThan(restTips[finger].y - 0.03)
        expect(Math.abs(now.x - restTips[finger].x)).toBeLessThan(0.02)
      }
      // the thumb comes in across the palm, toward the pinky side
      const thumb = h.anat(h.tip('thumb'))
      expect(thumb.z - restTips.thumb.z).toBeGreaterThan(0.01)
      expect(thumb.x - restTips.thumb.x).toBeGreaterThan(0.01)
    })
  }

  it('a straight hand stays exactly at rest', () => {
    const h = setup({ side: 'R' })
    const quats = handPoseToBoneQuats(h.handRig, analyticHandPose(h.handRig, BASIC_HANDS[0]))
    for (const [name, q] of Object.entries(quats)) {
      const bone = h.bones.find((b) => b.name === name)
      expect(bone.quaternion.angleTo(new THREE.Quaternion(...q))).toBeLessThan(1e-6)
    }
  })

  it('also works with the hand turned into some other pose first (the palm frame follows the wrist)', () => {
    const h = setup({ side: 'R' })
    const restW = h.hand.getWorldQuaternion(new THREE.Quaternion())
    h.hand.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.6, -0.4, 0.9)))
    h.hips.updateWorldMatrix(false, true)
    // where the palm faces now: the anatomy normal carried along by the wrist's turn
    const turn = h.hand.getWorldQuaternion(new THREE.Quaternion()).multiply(restW.invert())
    const palmNow = h.A.ez.clone().applyQuaternion(turn)
    const wrist = h.hand.getWorldPosition(new THREE.Vector3())
    const outOfPalm = (v) => v.clone().sub(wrist).dot(palmNow)
    const before = outOfPalm(h.tip('index'))
    pose(h, handPoseToBoneQuats(h.handRig, analyticHandPose(h.handRig, fist)))
    expect(outOfPalm(h.tip('index')) - before).toBeGreaterThan(0.015)
  })

  for (const side of ['L', 'R']) {
    it(`${side} thumb folds across the fingers without bending back toward the wrist`, () => {
      const h = setup({ side, thumbDirection: new THREE.Vector3(-0.45, 0.77, 0.45) })
      const base = h.anat(h.fingers.thumb[0].getWorldPosition(new THREE.Vector3()))
      pose(h, handPoseToBoneQuats(h.handRig, analyticHandPose(h.handRig, fist)))
      const middle = h.anat(h.fingers.thumb[1].getWorldPosition(new THREE.Vector3()))
      const tip = h.anat(h.tip('thumb'))
      expect(middle.x).toBeGreaterThan(base.x)
      expect(tip.x).toBeGreaterThan(0)
      expect(tip.y).toBeGreaterThan(base.y + 0.03)
    })
  }
})

describe('amount and round trips', () => {
  it('half strength lands between rest and the full pose', () => {
    const h = setup({ side: 'R' })
    const p = analyticHandPose(h.handRig, fist)
    const half = handPoseToBoneQuats(h.handRig, p, 0.5)
    const full = handPoseToBoneQuats(h.handRig, p, 1)
    const name = h.fingers.index[0].name
    const rest = h.restQuatOf(h.fingers.index[0])
    const aHalf = rest.angleTo(new THREE.Quaternion(...half[name]))
    const aFull = rest.angleTo(new THREE.Quaternion(...full[name]))
    expect(aHalf).toBeGreaterThan(0.01)
    expect(aHalf).toBeCloseTo(aFull / 2, 3)
  })

  it('amount can be set per finger', () => {
    const h = setup({ side: 'R' })
    const p = analyticHandPose(h.handRig, fist)
    const q = handPoseToBoneQuats(h.handRig, p, { index: 0, middle: 1 })
    const rest = (f) => h.restQuatOf(h.fingers[f][0])
    expect(rest('index').angleTo(new THREE.Quaternion(...q[h.fingers.index[0].name]))).toBeLessThan(1e-6)
    expect(rest('middle').angleTo(new THREE.Quaternion(...q[h.fingers.middle[0].name]))).toBeGreaterThan(0.5)
    expect(q[h.fingers.ring[0].name]).toBeDefined() // fingers left out of the object still use the default of 1
  })

  it('capture then apply reproduces the same bone rotations', () => {
    const h = setup({ side: 'R', seed: 7 })
    const quats = handPoseToBoneQuats(h.handRig, analyticHandPose(h.handRig, { curl: { thumb: 0.6, index: 0.3, middle: 0.9, ring: 0.5, pinky: 0.2 }, spread: 0.7 }))
    pose(h, quats)
    const captured = captureHandPose(h.handRig)
    reset(h)
    const again = handPoseToBoneQuats(h.handRig, captured)
    for (const [name, q] of Object.entries(quats)) {
      expect(new THREE.Quaternion(...q).angleTo(new THREE.Quaternion(...again[name]))).toBeLessThan(1e-5)
    }
  })

  it('a right hand pose put on a left hand on a differently-built rig is its mirror image', () => {
    const R = setup({ side: 'R', seed: 11, names: 'mixamo' })
    const L = setup({ side: 'L', seed: 99, names: 'blender' })
    const custom = analyticHandPose(R.handRig, { curl: { thumb: 0.7, index: 0.2, middle: 0.6, ring: 1, pinky: 0.4 }, spread: 1 })
    pose(R, handPoseToBoneQuats(R.handRig, custom))
    pose(L, handPoseToBoneQuats(L.handRig, custom))
    for (const finger of Object.keys(R.fingers)) {
      const r = R.anat(R.tip(finger))
      const l = L.anat(L.tip(finger))
      expect(l.x).toBeCloseTo(r.x, 2)
      expect(l.y).toBeCloseTo(r.y, 2)
      expect(l.z).toBeCloseTo(r.z, 2)
    }
  })

  it('spreading moves the index toward the thumb on both hands', () => {
    for (const side of ['R', 'L']) {
      const h = setup({ side, seed: 5 })
      const rest = h.anat(h.tip('index'))
      const restPinky = h.anat(h.tip('pinky'))
      pose(h, handPoseToBoneQuats(h.handRig, analyticHandPose(h.handRig, { spread: 1 })))
      expect(h.anat(h.tip('index')).x).toBeLessThan(rest.x - 0.005) // toward the thumb (-x in anatomy axes)
      expect(h.anat(h.tip('pinky')).x).toBeGreaterThan(restPinky.x + 0.005)
    }
  })
})

describe('poses from a BVH', () => {
  function parse(text) {
    const result = new BVHLoader().parse(text)
    return { skeleton: result.skeleton, clip: result.clip }
  }

  it('reads the right hand and applies its fist to a rig with different axes, on either hand', () => {
    const parsed = parse(makeHandBVH({ side: 'R', curlDeg: [70, 90, 60], thumbCurlDeg: [20, 40, 50] }))
    const poses = handPosesFromBVH(parsed)
    expect(Object.keys(poses)).toEqual(['R'])
    for (const side of ['R', 'L']) {
      const h = setup({ side, seed: 21 })
      const restTip = h.anat(h.tip('middle'))
      pose(h, handPoseToBoneQuats(h.handRig, poses.R))
      const tip = h.anat(h.tip('middle'))
      expect(tip.z - restTip.z).toBeGreaterThan(0.03)
      expect(tip.y).toBeLessThan(restTip.y - 0.03)
    }
  })

  it('a straight BVH hand gives an (almost) identity pose', () => {
    const poses = handPosesFromBVH(parse(makeHandBVH({ side: 'L' })))
    expect(Object.keys(poses)).toEqual(['L'])
    for (const segs of Object.values(poses.L.fingers)) for (const q of segs) expect(Math.abs(q[3])).toBeCloseTo(1, 5)
  })
})

describe('thumbnails', () => {
  it('gives line segments that change when the hand is curled', () => {
    const h = setup({ side: 'R' })
    const open = handSegments(h.handRig)
    pose(h, handPoseToBoneQuats(h.handRig, analyticHandPose(h.handRig, fist)))
    const curled = handSegments(h.handRig)
    expect(open.length).toBe(curled.length)
    expect(open.length).toBe(20)
    const span = (segs) => Math.max(...segs.map((s) => Math.max(s[1], s[3])))
    expect(span(curled)).toBeLessThan(span(open) - 0.03)
  })
})

describe('palm direction (real anatomy)', () => {
  it('a right hand held palm to the face, fingers up, has its thumb on the right: a fist curls toward the face', () => {
    // anatomy in world coords: fingers +Y, palm faces the viewer (+Z), so the right thumb is at +X (pinky at -X)
    const h = setup({ side: 'R', names: 'mixamo', anatomy: { ex: new THREE.Vector3(-1, 0, 0), ey: new THREE.Vector3(0, 1, 0), ez: new THREE.Vector3(0, 0, 1) } })
    const thumbX = h.fingers.thumb[0].getWorldPosition(new THREE.Vector3()).x - h.fingers.index[0].getWorldPosition(new THREE.Vector3()).x
    expect(thumbX).toBeGreaterThan(0) // thumb on the +X side of the index
    const rest = h.tip('middle')
    pose(h, handPoseToBoneQuats(h.handRig, analyticHandPose(h.handRig, fist)))
    expect(h.tip('middle').z - rest.z).toBeGreaterThan(0.015) // toward the palm side, not the back of the hand
  })
  it('left hand mirrors it', () => {
    const h = setup({ side: 'L', names: 'mixamo', anatomy: { ex: new THREE.Vector3(-1, 0, 0), ey: new THREE.Vector3(0, 1, 0), ez: new THREE.Vector3(0, 0, 1) } })
    const thumbX = h.fingers.thumb[0].getWorldPosition(new THREE.Vector3()).x - h.fingers.index[0].getWorldPosition(new THREE.Vector3()).x
    expect(thumbX).toBeLessThan(0)
    const rest = h.tip('middle')
    pose(h, handPoseToBoneQuats(h.handRig, analyticHandPose(h.handRig, fist)))
    expect(h.tip('middle').z - rest.z).toBeGreaterThan(0.015)
  })
  it('migrates poses saved with the old frame and leaves current ones alone', () => {
    const old = { format: 'hand-v1', fingers: { index: [[0.5, 0.1, 0.2, 0.8]] } }
    const moved = migrateHandPose(old)
    expect(moved.frame).toBe(2)
    expect(moved.fingers.index[0]).toEqual([-0.5, 0.1, -0.2, 0.8])
    expect(migrateHandPose(moved)).toBe(moved)
  })
})
