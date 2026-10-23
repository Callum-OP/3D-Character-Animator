import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects, addObject, getObjectRootById, removeObject, getObjectsForSave } from '../three/objects.js'
import {
  initLights, addLight, clearLights, getLightById, getLightsData, getLightClipboardData, attachLightToRoot,
} from '../three/lights.js'
import { initCameras, addCamera, clearCameras, getCamerasData, getCameraClipboardData, attachCameraToRoot } from '../three/cameras.js'
import { getContentBounds } from '../three/attach.js'
import {
  copyObjectById, pasteCopiedObject, attachLightToObject, attachCameraToObject, mergeObjectsToOne,
  setObjectParentById, removeObjectById,
} from '../three/scene.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

let scene
// Measure after a full scene update: mounts cancel their parent's scale in updateMatrixWorld,
// which updateWorldMatrix(true, false) would skip.
const world = (o) => {
  scene.updateMatrixWorld(true)
  return o.getWorldPosition(new THREE.Vector3())
}

beforeAll(() => {
  scene = new THREE.Scene()
  const refs = {
    scene,
    camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: document.createElement('canvas') },
    controls: { enabled: true, locked: false },
    requestRender: () => {},
    getSceneScale: () => 2,
  }
  initObjects(refs)
  initLights(refs)
  initCameras(refs)
})

beforeEach(() => {
  for (const o of [...useStore.getState().sceneObjects]) removeObject(o.id)
  clearLights()
  clearCameras()
  clearUndoHistory()
  useStore.setState({
    sceneObjects: [], sceneLights: [], sceneCameras: [], lightAttachments: {}, cameraAttachments: {},
    selectedObjectId: null, selectedObjectIds: [], mode: 'object', meshOverrides: {},
    animData: { tracks: {}, root: [], meshes: {}, morphs: {}, cameras: {}, lights: {}, cuts: [] },
  })
})

// A box-shaped prop turned, scaled and parked well away from the origin — the case where an
// attached light's object-relative numbers differ wildly from its world ones.
function makeProp(name, { pos = [10, 0, 5], scale = 2, rotY = Math.PI / 2, file = null } = {}) {
  const root = new THREE.Group()
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()))
  root.position.set(...pos)
  root.scale.setScalar(scale)
  root.rotation.y = rotY
  const meta = addObject({ root }, name, 'glb', file)
  useStore.getState().addSceneObject(meta)
  return { id: meta.id, root, meta }
}

function addAttachedLight(prop, data = {}) {
  const meta = addLight({ recordUndo: false, data: { position: [10, 2, 5], color: '#ff0000', intensity: 3, ...data } })
  useStore.getState().addSceneLight(meta)
  attachLightToObject(meta.id, prop.id)
  return meta
}

describe('copying an object that carries a light', () => {
  it('makes a real, listed, attached light on the copy — not a stray cloned sphere', () => {
    const prop = makeProp('Lamp post')
    const light = addAttachedLight(prop)
    useStore.getState().addLightKeyframe(light.name, 0, { pos: [0, 1, 0], intensity: 1 })
    useStore.getState().addLightKeyframe(light.name, 1, { pos: [0, 2, 0], intensity: 4 })

    expect(copyObjectById(prop.id)).toBe(true)
    const pasted = pasteCopiedObject()
    const pastedRoot = getObjectRootById(pasted.id)

    const lights = useStore.getState().sceneLights
    expect(lights).toHaveLength(2)
    const copy = lights.find((l) => l.id !== light.id)
    expect(useStore.getState().lightAttachments[copy.id]).toBe(pasted.id)

    // exactly one light lives under the copy, and it is the registered one
    const lightsUnderCopy = []
    pastedRoot.traverse((o) => o.isLight && lightsUnderCopy.push(o))
    expect(lightsUnderCopy).toHaveLength(1)
    expect(lightsUnderCopy[0]).toBe(getLightById(copy.id))
    expect(pastedRoot.children.filter((c) => c.userData.isAttachMount)).toHaveLength(1)

    // same keyframes, independent of the original's
    const keys = useStore.getState().animData.lights
    expect(keys[copy.name]).toEqual(keys[light.name])
    expect(keys[copy.name]).not.toBe(keys[light.name])

    // it is saved with the project, attached to the copy (not the original)
    const saved = getLightsData()
    expect(saved).toHaveLength(2)
    expect(saved.map((d) => d.attachedObjectIndex).sort()).toEqual([0, 1])
  })

  it('pastes in place: the copy and its light land exactly on the originals', () => {
    const prop = makeProp('Lamp post')
    const light = addAttachedLight(prop)
    copyObjectById(prop.id)
    const pasted = pasteCopiedObject()
    const copy = useStore.getState().sceneLights.find((l) => l.id !== light.id)

    expect(world(getObjectRootById(pasted.id)).distanceTo(world(prop.root))).toBeLessThan(1e-6)
    expect(world(getLightById(copy.id)).distanceTo(world(getLightById(light.id)))).toBeLessThan(1e-4)
  })

  it('also carries attached cameras', () => {
    const prop = makeProp('Rig')
    const cam = addCamera(40, { recordUndo: false, position: [10, 3, 5] })
    useStore.getState().addSceneCamera(cam)
    attachCameraToObject(cam.id, prop.id)
    copyObjectById(prop.id)
    const pasted = pasteCopiedObject()
    const cams = useStore.getState().sceneCameras
    expect(cams).toHaveLength(2)
    const copy = cams.find((c) => c.id !== cam.id)
    expect(useStore.getState().cameraAttachments[copy.id]).toBe(pasted.id)
    expect(getCamerasData().map((d) => d.attachedObjectIndex).sort()).toEqual([0, 1])
  })

  it('one undo takes the pasted object AND its light away; redo brings both back attached', () => {
    const prop = makeProp('Lamp post')
    const light = addAttachedLight(prop)
    clearUndoHistory()
    copyObjectById(prop.id)
    const pasted = pasteCopiedObject()
    expect(useStore.getState().sceneLights).toHaveLength(2)

    performUndo()
    expect(useStore.getState().sceneLights.map((l) => l.id)).toEqual([light.id])
    expect(useStore.getState().sceneObjects.map((o) => o.id)).toEqual([prop.id])
    let stray = 0
    scene.traverse((o) => o.isLight && stray++)
    expect(stray).toBe(1) // no orphaned light left lit in the scene

    performRedo()
    expect(useStore.getState().sceneLights).toHaveLength(2)
    const copy = useStore.getState().sceneLights.find((l) => l.id !== light.id)
    expect(useStore.getState().lightAttachments[copy.id]).toBe(pasted.id)
    expect(world(getLightById(copy.id)).distanceTo(world(getLightById(light.id)))).toBeLessThan(1e-4)
  })
})

describe('copy & paste of a light or camera is placed in the world', () => {
  it('an attached light copies its WORLD position, not the object-relative numbers', () => {
    const prop = makeProp('Lamp post', { pos: [100, 0, -40], scale: 3 })
    const light = addAttachedLight(prop, { position: [100, 5, -40] })
    const data = getLightClipboardData(light.id)
    const w = world(getLightById(light.id))
    expect(data.position[0]).toBeCloseTo(w.x, 4)
    expect(data.position[1]).toBeCloseTo(w.y, 4)
    expect(data.position[2]).toBeCloseTo(w.z, 4)
    expect(data.attachedObjectId).toBe(prop.id)
    // and the object-relative numbers really are different (that was the bug)
    expect(getLightClipboardData(light.id, { local: true }).position[0]).not.toBeCloseTo(w.x, 1)
  })

  it('an attached camera copies its world position too', () => {
    const prop = makeProp('Rig', { pos: [50, 0, 20], scale: 2 })
    const cam = addCamera(40, { recordUndo: false, position: [50, 4, 20] })
    useStore.getState().addSceneCamera(cam)
    attachCameraToRoot(cam.id, prop.root, prop.id)
    const data = getCameraClipboardData(cam.id)
    const rig = scene.getObjectByProperty('isPerspectiveCamera', true)
    expect(data.position[0]).toBeCloseTo(50, 3)
    expect(data.position[1]).toBeCloseTo(4, 3)
    expect(data.position[2]).toBeCloseTo(20, 3)
    expect(rig).toBeTruthy()
  })
})

describe('framing an object ignores what is attached to it', () => {
  it('a light far from the prop does not stretch the box', () => {
    const prop = makeProp('Small', { pos: [0, 0, 0], scale: 1, rotY: 0 })
    const far = addLight({ recordUndo: false, data: { position: [0, 400, 0], directional: true } })
    useStore.getState().addSceneLight(far)
    attachLightToRoot(far.id, prop.root, prop.id)
    scene.updateMatrixWorld(true)

    const naive = new THREE.Box3().setFromObject(prop.root).getSize(new THREE.Vector3())
    const content = getContentBounds(prop.root).getSize(new THREE.Vector3())
    expect(naive.y).toBeGreaterThan(50) // the old behaviour: a huge box for a 1-unit prop
    expect(content.x).toBeCloseTo(1, 3)
    expect(content.y).toBeCloseTo(1, 3)
    expect(content.z).toBeCloseTo(1, 3)
  })
})

describe('attaching a prop to another prop', () => {
  it('keeps its place, then follows the parent', () => {
    const car = makeProp('Car', { pos: [0, 0, 0], scale: 1, rotY: 0 })
    const flag = makeProp('Flag', { pos: [3, 0, 0], scale: 1, rotY: 0 })
    expect(setObjectParentById(flag.id, car.id)).toBe(true)
    expect(useStore.getState().sceneObjects.find((o) => o.id === flag.id).attachedToObjectId).toBe(car.id)
    scene.updateMatrixWorld(true)
    expect(world(flag.root).x).toBeCloseTo(3, 5)
    car.root.position.x = 10
    scene.updateMatrixWorld(true)
    expect(world(flag.root).x).toBeCloseTo(13, 5)
    expect(setObjectParentById(flag.id, null)).toBe(true)
    scene.updateMatrixWorld(true)
    expect(world(flag.root).x).toBeCloseTo(13, 5) // let go where it stands
    expect(useStore.getState().sceneObjects.find((o) => o.id === flag.id).attachedToObjectId).toBeNull()
  })

  it('refuses to attach something into its own subtree', () => {
    const a = makeProp('A')
    const b = makeProp('B')
    const c = makeProp('C')
    setObjectParentById(b.id, a.id)
    setObjectParentById(c.id, b.id)
    expect(setObjectParentById(a.id, c.id)).toBe(false)
    expect(setObjectParentById(a.id, a.id)).toBe(false)
  })

  it('deleting the parent lets the child go where it stands instead of deleting it too', () => {
    const car = makeProp('Car', { pos: [0, 0, 0], scale: 1, rotY: 0 })
    const flag = makeProp('Flag', { pos: [3, 0, 0], scale: 1, rotY: 0 })
    setObjectParentById(flag.id, car.id)
    car.root.position.x = 5
    scene.updateMatrixWorld(true)
    removeObjectById(car.id)
    expect(useStore.getState().sceneObjects.map((o) => o.id)).toEqual([flag.id])
    expect(flag.root.parent).toBe(scene)
    scene.updateMatrixWorld(true)
    expect(world(flag.root).x).toBeCloseTo(8, 5)
  })

  it('is saved by the parent\'s key, with the child\'s transform relative to it', () => {
    const car = makeProp('Car', { pos: [0, 0, 0], scale: 1, rotY: 0, file: new File(['x'], 'car.glb') })
    const flag = makeProp('Flag', { pos: [3, 0, 0], scale: 1, rotY: 0, file: new File(['x'], 'flag.glb') })
    car.root.position.x = 10
    scene.updateMatrixWorld(true)
    setObjectParentById(flag.id, car.id)
    const carKey = useStore.getState().sceneObjects.find((o) => o.id === car.id).animationKey
    const records = getObjectsForSave()
    const flagRecord = records.find((r) => r.name === 'Flag')
    expect(flagRecord.attachedToKey).toBe(carKey)
    expect(flagRecord.transform.position[0]).toBeCloseTo(-7, 5) // 3 in the world, 10 along the car
    expect(records.find((r) => r.name === 'Car').attachedToKey).toBeUndefined()
  })

  it('a copy of the parent brings its attached prop along (and no phantom clone)', () => {
    const car = makeProp('Car', { pos: [0, 0, 0], scale: 1, rotY: 0 })
    const flag = makeProp('Flag', { pos: [3, 0, 0], scale: 1, rotY: 0 })
    setObjectParentById(flag.id, car.id)
    copyObjectById(car.id)
    const pasted = pasteCopiedObject()
    const objs = useStore.getState().sceneObjects
    expect(objs).toHaveLength(4)
    const kidCopy = objs.find((o) => o.attachedToObjectId === pasted.id)
    expect(kidCopy).toBeTruthy()
    expect(kidCopy.name).toBe('Flag Copy')
    // and it didn't leave a phantom cloned flag inside the copied car
    let meshes = 0
    getObjectRootById(pasted.id).traverse((o) => o.isMesh && meshes++)
    expect(meshes).toBe(2) // the car's box + the one real attached flag
  })
})

describe('merging objects — the guards', () => {
  it('needs two or more', async () => {
    const a = makeProp('A')
    const r = await mergeObjectsToOne([a.id])
    expect(r.ok).toBe(false)
  })
  it('will not merge a character or an image', async () => {
    const a = makeProp('A')
    const b = makeProp('B')
    useStore.setState({ sceneObjects: useStore.getState().sceneObjects.map((o) => (o.id === b.id ? { ...o, kind: 'image' } : o)) })
    expect((await mergeObjectsToOne([a.id, b.id])).message).toMatch(/images/i)
    useStore.setState({ sceneObjects: useStore.getState().sceneObjects.map((o) => (o.id === b.id ? { ...o, kind: 'model', isCharacter: true } : o)) })
    expect((await mergeObjectsToOne([a.id, b.id])).message).toMatch(/character/i)
  })
})
