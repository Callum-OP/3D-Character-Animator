import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import {
  initPosing,
  setPoseModel,
  selectBone,
  getBoneEulerDelta,
  setBoneEulerDelta,
  beginBoneAdjust,
  endBoneAdjust,
  resetBone,
  mirrorPose,
  symmetrisePose,
  undo,
  redo,
} from '../three/posing.js'

// Same "does moving something actually undo" bug class as objects.js, but
// for the bone-posing history — the app's *other* independent undo stack,
// which had no coverage at all.
function makeRig() {
  const root = new THREE.Bone()
  root.name = 'Hips'
  const spine = new THREE.Bone()
  spine.name = 'Spine'
  root.add(spine)
  const leftArm = new THREE.Bone()
  leftArm.name = 'LeftArm'
  const rightArm = new THREE.Bone()
  rightArm.name = 'RightArm'
  spine.add(leftArm)
  spine.add(rightArm)
  root.updateMatrixWorld(true)
  return { root, bones: [root, spine, leftArm, rightArm] }
}

describe('bone posing: undo/redo and rest-relative editing', () => {
  let rig

  beforeAll(() => {
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()
    const renderer = { domElement: document.createElement('canvas') }
    const controls = { enabled: true, locked: false }
    initPosing({ scene, camera, renderer, controls, requestRender: () => {} })

    rig = makeRig()
    scene.add(rig.root)
    setPoseModel({ bones: rig.bones, root: rig.root })
  })

  it('reports (0, 0, 0) at rest for a freshly loaded rig', () => {
    const delta = getBoneEulerDelta('Spine')
    expect(delta.x).toBeCloseTo(0)
    expect(delta.y).toBeCloseTo(0)
    expect(delta.z).toBeCloseTo(0)
  })

  it('setBoneEulerDelta rotates relative to rest, not absolute world space', () => {
    setBoneEulerDelta('Spine', { x: 20, y: 0, z: 0 })
    const delta = getBoneEulerDelta('Spine')
    expect(delta.x).toBeCloseTo(20, 0)
  })

  it('a slider drag bracketed by begin/endBoneAdjust is a single undoable step', () => {
    selectBone('Spine')
    setBoneEulerDelta('Spine', { x: 0, y: 0, z: 0 }) // known rest starting point
    beginBoneAdjust('Spine')
    setBoneEulerDelta('Spine', { x: 10, y: 0, z: 0 })
    setBoneEulerDelta('Spine', { x: 30, y: 0, z: 0 }) // simulate multiple drag ticks
    endBoneAdjust()

    expect(getBoneEulerDelta('Spine').x).toBeCloseTo(30, 0)
    undo()
    // one undo should return all the way to rest, not just the last tick
    expect(getBoneEulerDelta('Spine').x).toBeCloseTo(0, 0)
    redo()
    expect(getBoneEulerDelta('Spine').x).toBeCloseTo(30, 0)
  })

  it('resetBone is undoable', () => {
    setBoneEulerDelta('Spine', { x: 45, y: 0, z: 0 })
    beginBoneAdjust('Spine')
    endBoneAdjust() // commit the manual edit above as its own undo step first
    resetBone('Spine')

    expect(getBoneEulerDelta('Spine').x).toBeCloseTo(0, 0)
    undo()
    expect(getBoneEulerDelta('Spine').x).toBeCloseTo(45, 0)
  })

  it('endBoneAdjust with no actual change pushes nothing (no-op undo entries)', () => {
    // Establish one real, known undo step first.
    setBoneEulerDelta('Spine', { x: 0, y: 0, z: 0 })
    beginBoneAdjust('Spine')
    setBoneEulerDelta('Spine', { x: 12, y: 0, z: 0 })
    endBoneAdjust()
    expect(getBoneEulerDelta('Spine').x).toBeCloseTo(12, 0)

    // A begin/end pair with no actual change must not add a phantom entry —
    // otherwise a single undo afterwards would do nothing (still 12) instead
    // of returning to the pre-real-edit state (0).
    beginBoneAdjust('Spine')
    endBoneAdjust()

    undo()
    expect(getBoneEulerDelta('Spine').x).toBeCloseTo(0, 0)
  })

  it('symmetrisePose averages opposite-side rotations and is undoable', () => {
    setBoneEulerDelta('LeftArm', { x: 0, y: 30, z: 0 })
    setBoneEulerDelta('RightArm', { x: 0, y: -10, z: 0 })
    setBoneEulerDelta('Spine', { x: 0, y: 30, z: 0 })
    symmetrisePose()

    expect(getBoneEulerDelta('LeftArm').y).toBeCloseTo(10, 0)
    expect(getBoneEulerDelta('RightArm').y).toBeCloseTo(10, 0)
    expect(getBoneEulerDelta('Spine').y).toBeCloseTo(15, 0)
    undo()
    expect(getBoneEulerDelta('LeftArm').y).toBeCloseTo(30, 0)
    expect(getBoneEulerDelta('RightArm').y).toBeCloseTo(-10, 0)
    expect(getBoneEulerDelta('Spine').y).toBeCloseTo(30, 0)
  })

  it('mirrorPose swaps only verified left/right pairs', () => {
    setBoneEulerDelta('LeftArm', { x: 0, y: 25, z: 0 })
    setBoneEulerDelta('RightArm', { x: 0, y: -5, z: 0 })
    setBoneEulerDelta('Spine', { x: 0, y: 15, z: 0 })
    mirrorPose()

    expect(getBoneEulerDelta('LeftArm').y).toBeCloseTo(-5, 0)
    expect(getBoneEulerDelta('RightArm').y).toBeCloseTo(25, 0)
    expect(getBoneEulerDelta('Spine').y).toBeCloseTo(15, 0)
  })

  it('pairs exporter side names even when numeric suffixes differ', () => {
    const root = new THREE.Bone()
    root.name = '_rootJoint'
    const left = new THREE.Bone()
    left.name = 'upperarm_l_012'
    const right = new THREE.Bone()
    right.name = 'upperarm_r_064'
    root.add(left)
    root.add(right)
    root.updateMatrixWorld(true)
    setPoseModel({ root, bones: [root, left, right] })

    setBoneEulerDelta(left.name, { x: 0, y: 35, z: 0 })
    setBoneEulerDelta(right.name, { x: 0, y: -5, z: 0 })
    mirrorPose()

    expect(getBoneEulerDelta(left.name).y).toBeCloseTo(-5, 0)
    expect(getBoneEulerDelta(right.name).y).toBeCloseTo(35, 0)
  })
})