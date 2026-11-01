import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects, addObject, removeObject, getObjectRootById } from '../three/objects.js'
import { releaseFollowersOf } from '../three/attach.js'
import {
  initIk,
  setIkConfig,
  clearIk,
  stepIkPins,
  addIkPin,
  removeIkPin,
  updateIkPin,
  attachIkMarker,
  pickIkMarker,
  getIkEntry,
  selectIkPin,
} from '../three/ikpins.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { ikPinsForSave, ikPinsFromSave } from '../three/scene.js'
import { clearUndoHistory } from '../three/undoHistory.js'

const CHAR = 1
let scene
let camera

// shoulder (0,0,0) -> elbow (1,0,0) -> wrist (1,0,0 further) -> hand tip. Each segment is 1 long.
function makeArm() {
  const root = new THREE.Group()
  const shoulder = new THREE.Bone()
  shoulder.name = 'shoulder'
  const elbow = new THREE.Bone()
  elbow.name = 'elbow'
  elbow.position.set(1, 0, 0)
  const wrist = new THREE.Bone()
  wrist.name = 'wrist'
  wrist.position.set(1, 0, 0)
  shoulder.add(elbow)
  elbow.add(wrist)
  root.add(shoulder)
  scene.add(root)
  return { root, bones: [shoulder, elbow, wrist], shoulder, elbow, wrist }
}

// What the animation mixer would write each frame: the elbow bent 90 degrees.
function animate(arm) {
  arm.shoulder.quaternion.identity()
  arm.elbow.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
  arm.wrist.quaternion.identity()
  arm.root.updateMatrixWorld(true)
}

const world = (bone) => bone.getWorldPosition(new THREE.Vector3())
let arm

beforeAll(() => {
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 6)
  camera.updateMatrixWorld(true)
  const canvas = document.createElement('canvas')
  const controls = { enabled: true, locked: false }
  initObjects({ scene, camera, renderer: { domElement: canvas }, controls, requestRender: () => {}, getSceneScale: () => 2 })
  initIk({ scene, camera, renderer: { domElement: canvas }, controls, requestRender: () => {}, getSceneScale: () => 2 })
})

beforeEach(() => {
  clearIk(CHAR)
  clearUndoHistory()
  if (arm) scene.remove(arm.root)
  arm = makeArm()
  animate(arm)
  useStore.setState({ activeCharacterId: CHAR, characters: {}, ikPins: [], ikEnabled: true, selectedIkPinId: null, sceneObjects: [] })
  setIkConfig(CHAR, arm, true, [])
})

function pinTo(position, patch = {}) {
  const pin = addIkPin('wrist', { characterId: CHAR })
  updateIkPin(pin.id, { position, ...patch })
  return pin
}

describe('IK pins: solver', () => {
  it('holds the hand on a fixed marker while the animation keeps writing its pose', () => {
    const target = [0.5, 1.5, 0.2]
    pinTo(target)
    for (let frame = 0; frame < 3; frame++) {
      animate(arm) // the mixer overwrites the bones every frame
      stepIkPins()
      expect(world(arm.wrist).distanceTo(new THREE.Vector3(...target))).toBeLessThan(1e-3)
    }
  })

  it('keeps the elbow bending the way the animation bent it', () => {
    const A = new THREE.Vector3()
    const oldNormal = new THREE.Vector3().crossVectors(world(arm.elbow).sub(A), world(arm.wrist).sub(A))
    pinTo([0.5, 1.5, 0.2])
    stepIkPins()
    const newNormal = new THREE.Vector3().crossVectors(world(arm.elbow).sub(A), world(arm.wrist).sub(A))
    expect(newNormal.dot(oldNormal)).toBeGreaterThan(0)
  })

  it('never stretches: an unreachable marker leaves the arm straight toward it', () => {
    pinTo([0, 10, 0])
    stepIkPins()
    expect(world(arm.elbow).length()).toBeCloseTo(1, 4)
    expect(world(arm.wrist).distanceTo(world(arm.elbow))).toBeCloseTo(1, 4)
    const w = world(arm.wrist)
    expect(w.y).toBeCloseTo(2, 3)
    expect(Math.abs(w.x) + Math.abs(w.z)).toBeLessThan(1e-3)
  })

  it('strength blends from the animation to the marker, and does not creep while paused', () => {
    const target = new THREE.Vector3(0.5, 1.5, 0.2)
    const animated = world(arm.wrist)
    pinTo(target.toArray(), { weight: 0.5 })
    stepIkPins()
    const once = world(arm.wrist)
    expect(once.distanceTo(target)).toBeLessThan(animated.distanceTo(target))
    expect(once.distanceTo(target)).toBeGreaterThan(1e-2)
    for (let i = 0; i < 5; i++) stepIkPins() // paused: no new animation frames
    expect(world(arm.wrist).distanceTo(once)).toBeLessThan(1e-5)
  })

  it('strength 0 leaves the animation alone', () => {
    const animated = world(arm.wrist)
    pinTo([0.5, 1.5, 0.2], { weight: 0 })
    stepIkPins()
    expect(world(arm.wrist).distanceTo(animated)).toBeLessThan(1e-6)
  })

  it('a disabled pin, or the master switch off, does nothing', () => {
    const animated = world(arm.wrist)
    const pin = pinTo([0.5, 1.5, 0.2], { enabled: false })
    stepIkPins()
    expect(world(arm.wrist).distanceTo(animated)).toBeLessThan(1e-6)
    updateIkPin(pin.id, { enabled: true })
    useStore.setState({ ikEnabled: false })
    setIkConfig(CHAR, arm, false, useStore.getState().ikPins)
    animate(arm)
    stepIkPins()
    expect(world(arm.wrist).distanceTo(animated)).toBeLessThan(1e-6)
  })

  it('a longer chain (CCD) also reaches a marker', () => {
    const pin = pinTo([0.6, 1.2, 0.3], { chainLength: 3 }) // only 2 ancestors exist: shoulder + elbow
    stepIkPins()
    expect(world(arm.wrist).distanceTo(new THREE.Vector3(0.6, 1.2, 0.3))).toBeLessThan(5e-3)
    expect(pin.id).toBeTruthy()
  })

  it('"match marker rotation" turns the tip to the marker orientation', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    const pin = pinTo([0.5, 1.5, 0.2], { matchRotation: true, quaternion: q.toArray() })
    stepIkPins()
    const got = arm.wrist.getWorldQuaternion(new THREE.Quaternion())
    expect(Math.abs(got.dot(q))).toBeGreaterThan(0.999)
    expect(pin.id).toBeTruthy()
  })
})

describe('IK pins: marker on a moving object', () => {
  it('the hand follows the object when it moves', () => {
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial()))
    const meta = addObject({ root }, 'Rail', 'glb', null)
    root.position.set(0.5, 1.2, 0)
    root.updateMatrixWorld(true)

    const pin = pinTo([0.5, 1.2, 0]) // a spot on the rail
    attachIkMarker(pin.id, meta.id)
    expect(getIkEntry(pin.id).objectId).toBe(meta.id)
    expect(useStore.getState().ikPins[0].attachObjectId).toBe(meta.id)

    stepIkPins()
    expect(world(arm.wrist).distanceTo(new THREE.Vector3(0.5, 1.2, 0))).toBeLessThan(1e-3)

    root.position.set(-0.4, 1.0, 0.3) // the object moves
    animate(arm)
    stepIkPins()
    expect(world(arm.wrist).distanceTo(new THREE.Vector3(-0.4, 1.0, 0.3))).toBeLessThan(1e-3)

    root.rotation.y = Math.PI / 2 // ...and turns: the offset turns with it
    root.updateMatrixWorld(true)
    animate(arm)
    stepIkPins()
    const marker = new THREE.Vector3()
    getIkEntry(pin.id).marker.getWorldPosition(marker)
    expect(world(arm.wrist).distanceTo(marker)).toBeLessThan(1e-3)
    removeObject(meta.id)
  })

  it('when the object is deleted the marker stays where it was in the world', () => {
    const root = new THREE.Group()
    const meta = addObject({ root }, 'Crate', 'glb', null)
    root.position.set(0.3, 1.1, 0)
    root.updateMatrixWorld(true)
    const pin = pinTo([0, 0, 0])
    attachIkMarker(pin.id, meta.id)
    stepIkPins()
    const before = new THREE.Vector3()
    getIkEntry(pin.id).marker.getWorldPosition(before)
    releaseFollowersOf(getObjectRootById(meta.id))
    const after = new THREE.Vector3()
    getIkEntry(pin.id).marker.getWorldPosition(after)
    expect(after.distanceTo(before)).toBeLessThan(1e-6)
    expect(useStore.getState().ikPins[0].attachObjectId).toBeNull()
    removeObject(meta.id)
  })

  it('attaching and detaching keeps the marker where it is in the world', () => {
    const root = new THREE.Group()
    const meta = addObject({ root }, 'Box', 'glb', null)
    root.position.set(2, 0, 0)
    root.rotation.y = 0.7
    root.updateMatrixWorld(true)
    const pin = pinTo([0.2, 1.1, 0.3])
    const start = new THREE.Vector3()
    getIkEntry(pin.id).marker.getWorldPosition(start)
    attachIkMarker(pin.id, meta.id)
    const attached = new THREE.Vector3()
    getIkEntry(pin.id).marker.getWorldPosition(attached)
    expect(attached.distanceTo(start)).toBeLessThan(1e-5)
    attachIkMarker(pin.id, null)
    const detached = new THREE.Vector3()
    getIkEntry(pin.id).marker.getWorldPosition(detached)
    expect(detached.distanceTo(start)).toBeLessThan(1e-5)
    removeObject(meta.id)
  })
})

describe('IK pins: editing, undo and picking', () => {
  it('adding, editing and removing a pin are undoable', () => {
    const pin = addIkPin('wrist', { characterId: CHAR })
    expect(useStore.getState().ikPins).toHaveLength(1)
    updateIkPin(pin.id, { weight: 0.4 })
    expect(useStore.getState().ikPins[0].weight).toBe(0.4)
    performUndo(useStore.getState())
    expect(useStore.getState().ikPins[0].weight).toBe(1)
    performUndo(useStore.getState())
    expect(useStore.getState().ikPins).toHaveLength(0)
    expect(getIkEntry(pin.id)).toBeNull()
    performRedo(useStore.getState())
    expect(useStore.getState().ikPins).toHaveLength(1)
    expect(getIkEntry(pin.id)).toBeTruthy()
    removeIkPin(pin.id)
    expect(useStore.getState().ikPins).toHaveLength(0)
    performUndo(useStore.getState())
    expect(useStore.getState().ikPins).toHaveLength(1)
  })

  it('a slider drag (many quick edits) is one undo step', () => {
    const pin = addIkPin('wrist', { characterId: CHAR })
    for (const w of [0.9, 0.8, 0.7, 0.6]) updateIkPin(pin.id, { weight: w })
    performUndo(useStore.getState())
    expect(useStore.getState().ikPins[0].weight).toBe(1)
  })

  it('a pin starts exactly where the bone is, so nothing jumps when it is added', () => {
    const animated = world(arm.wrist)
    const pin = addIkPin('wrist', { characterId: CHAR })
    expect(new THREE.Vector3(...pin.position).distanceTo(animated)).toBeLessThan(1e-6)
    stepIkPins()
    expect(world(arm.wrist).distanceTo(animated)).toBeLessThan(1e-3)
  })

  it('a marker can be picked in the viewport', () => {
    const pin = addIkPin('wrist', { characterId: CHAR })
    updateIkPin(pin.id, { position: [0, 0, 0] })
    const hit = pickIkMarker(0, 0)
    expect(hit).toBe(pin.id)
    expect(pickIkMarker(0.9, 0.9)).toBeNull()
    selectIkPin(pin.id)
  })
})

describe('IK pins: real-world rigs', () => {
  it('works on a rig imported tiny and rotated (a 0.01-scale armature turned on its side)', () => {
    scene.remove(arm.root)
    const root = new THREE.Group()
    root.scale.setScalar(0.01)
    root.rotation.x = Math.PI / 2
    const mk = (name, x) => {
      const b = new THREE.Bone()
      b.name = name
      b.position.set(x, 0, 0)
      return b
    }
    const shoulder = mk('shoulder', 0)
    const elbow = mk('elbow', 30)
    const wrist = mk('wrist', 28)
    shoulder.add(elbow)
    elbow.add(wrist)
    root.add(shoulder)
    root.position.set(0, 1, 0)
    scene.add(root)
    elbow.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.2)
    root.updateMatrixWorld(true)
    const model = { root, bones: [shoulder, elbow, wrist] }
    setIkConfig(CHAR, model, true, [])
    const pin = addIkPin('wrist', { characterId: CHAR })
    const target = new THREE.Vector3(0.15, 1.3, 0.2)
    updateIkPin(pin.id, { position: target.toArray() })
    stepIkPins()
    expect(world(wrist).distanceTo(target)).toBeLessThan(1e-3)
    scene.remove(root)
  })

  it('holds against a real AnimationMixer rewriting the bones every frame, also when paused', () => {
    const track = new THREE.QuaternionKeyframeTrack(
      'elbow.quaternion',
      [0, 1],
      [
        ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3).toArray(),
        ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.4).toArray(),
      ],
    )
    const mixer = new THREE.AnimationMixer(arm.root)
    mixer.clipAction(new THREE.AnimationClip('bend', 1, [track])).play()
    const target = new THREE.Vector3(0.4, 1.4, 0.1)
    pinTo(target.toArray())
    for (let i = 0; i < 30; i++) {
      mixer.update(1 / 30)
      arm.root.updateMatrixWorld(true)
      stepIkPins()
      expect(world(arm.wrist).distanceTo(target)).toBeLessThan(2e-3)
    }
    // paused: the mixer stops advancing, renders keep happening
    for (let i = 0; i < 5; i++) {
      arm.root.updateMatrixWorld(true)
      stepIkPins()
    }
    expect(world(arm.wrist).distanceTo(target)).toBeLessThan(2e-3)
  })

  it('a limb animated perfectly straight still bends sensibly (no NaN)', () => {
    arm.elbow.quaternion.identity()
    arm.root.updateMatrixWorld(true)
    pinTo([0.8, 1.0, 0.0])
    stepIkPins()
    const w = world(arm.wrist)
    expect(Number.isFinite(w.x + w.y + w.z)).toBe(true)
    expect(w.distanceTo(new THREE.Vector3(0.8, 1.0, 0))).toBeLessThan(1e-3)
  })
})

describe('IK pins: saving', () => {
  it('a marker attached to an object is saved as that object\'s place in the list and found again on load', () => {
    useStore.setState({ sceneObjects: [{ id: 11, name: 'A' }, { id: 12, name: 'B' }] })
    const pins = [
      { id: 'p1', boneName: 'wrist', attachObjectId: 12, position: [0, 1, 0] },
      { id: 'p2', boneName: 'ankle', attachObjectId: null, position: [1, 0, 0] },
    ]
    const saved = JSON.parse(JSON.stringify(ikPinsForSave(pins)))
    expect(saved[0].attachedObjectIndex).toBe(1)
    expect(saved[0]).not.toHaveProperty('attachObjectId')
    expect(saved[1].attachedObjectIndex).toBeNull()
    // objects get new ids after a reload; the index still points at the same one
    useStore.setState({ sceneObjects: [{ id: 41, name: 'A' }, { id: 42, name: 'B' }] })
    const loaded = ikPinsFromSave(saved)
    expect(loaded[0].attachObjectId).toBe(42)
    expect(loaded[1].attachObjectId).toBeNull()
  })
})
