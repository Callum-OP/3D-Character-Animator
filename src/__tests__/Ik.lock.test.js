import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects } from '../three/objects.js'
import { initIk, setIkConfig, clearIk, stepIkPins, lockBonesInPlace, unlockBones, unlockAll, limbBoneNames, isLockPin } from '../three/ikpins.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

const CHAR = 1
let scene
let leg

// hips (0,1,0) -> upper leg -> lower leg (0.5 down) -> foot (0.5 further down): a straight, 1 m reach below the hips.
function makeLeg() {
  const root = new THREE.Group()
  const mk = (name, x, y, z, parent) => { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); parent.add(b); return b }
  const hips = mk('Hips', 0, 1, 0, root)
  const up = mk('LeftUpLeg', 0, 0, 0, hips)
  const low = mk('LeftLeg', 0, -0.5, 0, up)
  const foot = mk('LeftFoot', 0, -0.5, 0, low)
  const foot2 = mk('RightFoot', 0.3, -1, 0, hips) // a second, unrelated foot bone for the "both feet" helper
  scene.add(root)
  return { root, hips, up, low, foot, foot2, bones: [hips, up, low, foot, foot2] }
}

// What the mixer writes each frame: the hips sway and dip, the knee bends a little, the foot tips up.
function animate(l, t) {
  l.hips.position.set(0.05 * Math.sin(t), 0.94 - 0.04 * (1 - Math.cos(t * 2)), 0) // never higher than the locked pose, so the foot stays in reach
  l.up.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.25)
  l.low.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5)
  l.foot.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.6 * Math.sin(t))
  l.root.updateMatrixWorld(true)
}

const wpos = (b) => b.getWorldPosition(new THREE.Vector3())
const wq = (b) => b.getWorldQuaternion(new THREE.Quaternion())

beforeAll(() => {
  scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 6)
  camera.updateMatrixWorld(true)
  const canvas = document.createElement('canvas')
  const controls = { enabled: true, locked: false }
  const refs = { scene, camera, renderer: { domElement: canvas }, controls, requestRender: () => {}, getSceneScale: () => 2 }
  initObjects(refs)
  initIk(refs)
})

beforeEach(() => {
  clearIk(CHAR)
  clearUndoHistory()
  if (leg) scene.remove(leg.root)
  leg = makeLeg()
  animate(leg, 0)
  useStore.setState({
    activeCharacterId: CHAR, characters: {}, ikPins: [], ikEnabled: true, selectedIkPinId: null, sceneObjects: [],
    modelInfo: { bones: leg.bones.map((b) => ({ name: b.name })) },
  })
  setIkConfig(CHAR, leg, true, [])
})

describe('Lock in place', () => {
  it('holds a foot at its position AND rotation while the animation keeps moving it', () => {
    const wantPos = wpos(leg.foot)
    const wantRot = wq(leg.foot)
    const r = lockBonesInPlace(['LeftFoot'], { characterId: CHAR })
    expect(r).toMatchObject({ locked: 1, relocked: 0 })
    const pin = useStore.getState().ikPins[0]
    expect(isLockPin(pin)).toBe(true)
    expect(pin.matchRotation).toBe(true)
    expect(pin.attachObjectId).toBeNull()
    for (const t of [0.7, 1.3, 2.1, 3.0]) {
      animate(leg, t) // the animation tries to move it
      stepIkPins()
      expect(wpos(leg.foot).distanceTo(wantPos), `position at t=${t}`).toBeLessThan(2e-3)
      expect(wq(leg.foot).angleTo(wantRot), `rotation at t=${t}`).toBeLessThan(0.02)
    }
  })

  it('can lock position only', () => {
    const wantRot = wq(leg.foot)
    lockBonesInPlace(['LeftFoot'], { characterId: CHAR, rotation: false })
    animate(leg, 1.3)
    stepIkPins()
    expect(wq(leg.foot).angleTo(wantRot)).toBeGreaterThan(0.1) // rotation still follows the animation
  })

  it('re-locking moves the lock to the current pose instead of adding a second pin', () => {
    lockBonesInPlace(['LeftFoot'], { characterId: CHAR })
    animate(leg, 1.0)
    const moved = lockBonesInPlace(['LeftFoot'], { characterId: CHAR })
    expect(moved).toMatchObject({ locked: 0, relocked: 1 })
    expect(useStore.getState().ikPins).toHaveLength(1)
    const pin = useStore.getState().ikPins[0]
    expect(new THREE.Vector3(...pin.position).distanceTo(wpos(leg.foot))).toBeLessThan(1e-6)
  })

  it('is one undo step, and unlock removes only locks', () => {
    lockBonesInPlace(['LeftFoot', 'RightFoot'], { characterId: CHAR })
    expect(useStore.getState().ikPins).toHaveLength(2)
    performUndo()
    expect(useStore.getState().ikPins).toHaveLength(0)
    performRedo()
    expect(useStore.getState().ikPins).toHaveLength(2)
    expect(unlockBones(['LeftFoot'], { characterId: CHAR })).toBe(1)
    expect(useStore.getState().ikPins.map((p) => p.boneName)).toEqual(['RightFoot'])
    expect(unlockAll({ characterId: CHAR })).toBe(1)
    expect(useStore.getState().ikPins).toHaveLength(0)
  })

  it('reports bones it cannot find and turns the IK master switch on', () => {
    useStore.setState({ ikEnabled: false })
    const r = lockBonesInPlace(['NoSuchBone', 'LeftFoot'], { characterId: CHAR })
    expect(r.missing).toEqual(['NoSuchBone'])
    expect(r.locked).toBe(1)
    expect(useStore.getState().ikEnabled).toBe(true)
  })

  it('finds the foot bones for the quick "both feet" button', () => {
    expect(limbBoneNames('foot').sort()).toEqual(['LeftFoot', 'RightFoot'])
  })
})
