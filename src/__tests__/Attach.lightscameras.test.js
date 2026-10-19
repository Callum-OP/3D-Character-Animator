import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import * as THREE from 'three'
import { createMount, reparentKeepingWorld, setObjectWorldTransform, releaseFollowersOf } from '../three/attach.js'
import { initLights, addLight, removeLight, attachLightToRoot, detachLightFromObject, getLightById, getLightsData, applyLightsData, clearLights, setLightDirectional } from '../three/lights.js'
import { initCameras, addCamera, removeCamera, attachCameraToRoot, detachCameraFromObject, getCameraRigById, getCameraById, getCamerasData, snapCameraToView } from '../three/cameras.js'
import { useStore } from '../store.js'

const V = (x, y, z) => new THREE.Vector3(x, y, z)
const close = (a, b, eps = 1e-4) => a.distanceTo(b) < eps
const world = (o) => {
  o.updateWorldMatrix(true, false)
  return o.getWorldPosition(new THREE.Vector3())
}

// A "character-like" root: imported in centimetres, so its own scale is 0.01,
// and turned 90° about Z — the case that would wreck a camera parented directly.
function makeRoot(scene, { scale = 0.01, pos = V(5, 0, 0), rotZ = Math.PI / 2 } = {}) {
  const root = new THREE.Group()
  root.scale.setScalar(scale)
  root.position.copy(pos)
  root.rotation.z = rotZ
  scene.add(root)
  scene.updateMatrixWorld(true)
  return root
}

describe('attach.js primitives', () => {
  it('a mount follows its parent\'s position + rotation but cancels its scale', () => {
    const scene = new THREE.Scene()
    const root = makeRoot(scene)
    const mount = createMount()
    root.add(mount)
    const child = new THREE.Object3D()
    child.position.set(1, 0, 0)
    mount.add(child)
    scene.updateMatrixWorld(true)
    // 90° about Z turns local +X into world +Y; at world scale 1 the offset is a full unit.
    expect(close(world(child), V(5, 1, 0))).toBe(true)
    const sc = new THREE.Vector3()
    child.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc)
    expect(close(sc, V(1, 1, 1))).toBe(true)
  })

  it('keeps world scale 1 when the parent is resized afterwards', () => {
    const scene = new THREE.Scene()
    const root = makeRoot(scene, { scale: 1, rotZ: 0 })
    const mount = createMount()
    root.add(mount)
    const child = new THREE.Object3D()
    mount.add(child)
    root.scale.setScalar(4)
    scene.updateMatrixWorld(true)
    const sc = new THREE.Vector3()
    child.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc)
    expect(close(sc, V(1, 1, 1))).toBe(true)
  })

  it('reparentKeepingWorld leaves the world transform untouched', () => {
    const scene = new THREE.Scene()
    const root = makeRoot(scene)
    const mount = createMount()
    root.add(mount)
    const obj = new THREE.Object3D()
    obj.position.set(2, 3, 4)
    obj.rotation.set(0.3, 0.2, 0.1)
    scene.add(obj)
    scene.updateMatrixWorld(true)
    const before = obj.matrixWorld.clone()
    reparentKeepingWorld(obj, mount)
    scene.updateMatrixWorld(true)
    expect(obj.parent).toBe(mount)
    for (let i = 0; i < 16; i += 1) expect(obj.matrixWorld.elements[i]).toBeCloseTo(before.elements[i], 4)
  })

  it('setObjectWorldTransform places an attached object at a world pose', () => {
    const scene = new THREE.Scene()
    const root = makeRoot(scene)
    const mount = createMount()
    root.add(mount)
    const obj = new THREE.Object3D()
    mount.add(obj)
    const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), 0.7)
    setObjectWorldTransform(obj, V(-3, 2, 1), q)
    scene.updateMatrixWorld(true)
    expect(close(world(obj), V(-3, 2, 1))).toBe(true)
    expect(obj.getWorldQuaternion(new THREE.Quaternion()).angleTo(q)).toBeLessThan(1e-4)
  })

  it('releaseFollowersOf only touches followers mounted on that root', () => {
    const scene = new THREE.Scene()
    const rootA = makeRoot(scene)
    const rootB = makeRoot(scene)
    // (registry behaviour is exercised end-to-end below; here: no followers → no throw)
    expect(() => releaseFollowersOf(rootA)).not.toThrow()
    expect(() => releaseFollowersOf(null)).not.toThrow()
    expect(rootB.parent).toBe(scene)
  })
})

describe('lights attached to an object', () => {
  let scene, root, canvas

  beforeAll(() => {
    scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()
    canvas = document.createElement('canvas')
    initLights({ scene, camera, renderer: { domElement: canvas }, controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 1 })
  })

  beforeEach(() => {
    clearLights()
    if (root) scene.remove(root)
    root = makeRoot(scene)
    useStore.setState({ sceneLights: [], lightAttachments: {}, sceneObjects: [{ id: 7, name: 'Prop' }] })
  })

  function newLight(pos = V(2, 3, 4)) {
    const meta = addLight({ recordUndo: false, data: { position: pos.toArray() } })
    useStore.getState().addSceneLight(meta)
    return meta
  }

  it('attaching keeps the light where it is, then it follows the object', () => {
    const { id } = newLight()
    const light = getLightById(id)
    scene.updateMatrixWorld(true)
    const start = world(light)
    expect(attachLightToRoot(id, root, 7)).toBe(true)
    scene.updateMatrixWorld(true)
    expect(close(world(light), start)).toBe(true)
    expect(useStore.getState().lightAttachments[id]).toBe(7)

    root.position.add(V(10, 0, 0))
    scene.updateMatrixWorld(true)
    expect(close(world(light), start.clone().add(V(10, 0, 0)))).toBe(true)
  })

  it('the light marker is not blown up by a 0.01-scaled parent', () => {
    const { id } = newLight()
    attachLightToRoot(id, root, 7)
    scene.updateMatrixWorld(true)
    const sc = new THREE.Vector3()
    getLightById(id).matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc)
    expect(close(sc, V(1, 1, 1))).toBe(true)
  })

  it('detaching puts it back in the scene at the same world spot', () => {
    const { id } = newLight()
    attachLightToRoot(id, root, 7)
    root.position.add(V(0, 5, 0))
    scene.updateMatrixWorld(true)
    const moved = world(getLightById(id))
    detachLightFromObject(id)
    scene.updateMatrixWorld(true)
    expect(getLightById(id).parent).toBe(scene)
    expect(close(world(getLightById(id)), moved)).toBe(true)
    expect(useStore.getState().lightAttachments[id]).toBeUndefined()
  })

  it('deleting the object first frees the light instead of taking it along', () => {
    const { id } = newLight()
    attachLightToRoot(id, root, 7)
    root.position.add(V(1, 1, 1))
    scene.updateMatrixWorld(true)
    const spot = world(getLightById(id))
    releaseFollowersOf(root) // what removeObject / removeCharacter do before disposing
    scene.remove(root)
    scene.updateMatrixWorld(true)
    expect(getLightById(id).parent).toBe(scene)
    expect(close(world(getLightById(id)), spot)).toBe(true)
    expect(useStore.getState().lightAttachments[id]).toBeUndefined()
  })

  it('removing an attached light takes it out of the scene graph completely', () => {
    const { id } = newLight()
    const light = getLightById(id)
    attachLightToRoot(id, root, 7)
    removeLight(id)
    let found = false
    scene.traverse((o) => { if (o === light) found = true })
    expect(found).toBe(false)
    expect(root.children.filter((c) => c.userData.isAttachMount)).toHaveLength(0)
  })

  it('re-attaching to a different object moves it without a jump', () => {
    const { id } = newLight()
    const other = makeRoot(scene, { scale: 2, pos: V(-8, 1, 0), rotZ: 0.4 })
    attachLightToRoot(id, root, 7)
    scene.updateMatrixWorld(true)
    const spot = world(getLightById(id))
    attachLightToRoot(id, other, 8)
    scene.updateMatrixWorld(true)
    expect(close(world(getLightById(id)), spot)).toBe(true)
    expect(root.children.filter((c) => c.userData.isAttachMount)).toHaveLength(0)
    expect(useStore.getState().lightAttachments[id]).toBe(8)
    scene.remove(other)
  })

  it('switching an attached light to directional keeps it attached', () => {
    const { id } = newLight()
    attachLightToRoot(id, root, 7)
    setLightDirectional(id, true)
    const light = getLightById(id)
    expect(light.isSpotLight).toBe(true)
    expect(light.parent.userData.isAttachMount).toBe(true)
  })

  it('saves which object a light is attached to, and its local offset', () => {
    const { id } = newLight()
    attachLightToRoot(id, root, 7)
    const [saved] = getLightsData()
    expect(saved.attachedObjectIndex).toBe(0)
    // position is relative to the object, not the world
    const local = new THREE.Vector3().fromArray(saved.position)
    expect(close(local, V(2, 3, 4))).toBe(false)
  })

  it('an unattached light saves attachedObjectIndex: null', () => {
    newLight()
    expect(getLightsData()[0].attachedObjectIndex).toBeNull()
  })

  it('load: re-attaching with keepLocal puts the light back at the same world spot', () => {
    const { id } = newLight()
    attachLightToRoot(id, root, 7)
    scene.updateMatrixWorld(true)
    const spot = world(getLightById(id))
    const saved = getLightsData()
    clearLights()
    useStore.setState({ lightAttachments: {} })
    const metas = applyLightsData(saved)
    attachLightToRoot(metas[0].id, root, 7, { keepLocal: true })
    scene.updateMatrixWorld(true)
    expect(close(world(getLightById(metas[0].id)), spot)).toBe(true)
  })
})

describe('cameras attached to an object', () => {
  let scene, root, snapCam

  beforeAll(() => {
    scene = new THREE.Scene()
    snapCam = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
    const canvas = document.createElement('canvas')
    initCameras({ scene, camera: snapCam, renderer: { domElement: canvas }, controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 1 })
  })

  beforeEach(() => {
    if (root) scene.remove(root)
    root = makeRoot(scene)
    useStore.setState({ sceneCameras: [], cameraAttachments: {}, sceneObjects: [{ id: 7, name: 'Prop' }] })
  })

  function newCamera(pos = V(1, 2, 3)) {
    const meta = addCamera(50, { recordUndo: false, position: pos.toArray() })
    useStore.getState().addSceneCamera(meta)
    return meta
  }

  it('follows the object and is NOT distorted by its 0.01 scale', () => {
    const { id } = newCamera()
    scene.updateMatrixWorld(true)
    const start = world(getCameraById(id))
    attachCameraToRoot(id, root, 7)
    scene.updateMatrixWorld(true)
    const cam = getCameraById(id)
    expect(close(world(cam), start)).toBe(true)
    const sc = new THREE.Vector3()
    cam.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc)
    expect(close(sc, V(1, 1, 1))).toBe(true) // view matrix isn't magnified 100x
    root.position.add(V(0, 0, 9))
    scene.updateMatrixWorld(true)
    expect(close(world(cam), start.clone().add(V(0, 0, 9)))).toBe(true)
  })

  it('it also turns with the object (a head-cam looks where the head looks)', () => {
    const { id } = newCamera(V(0, 0, 0))
    attachCameraToRoot(id, root, 7)
    scene.updateMatrixWorld(true)
    const dirBefore = new THREE.Vector3(0, 0, -1).applyQuaternion(getCameraById(id).getWorldQuaternion(new THREE.Quaternion()))
    root.rotation.z += Math.PI / 2
    scene.updateMatrixWorld(true)
    const dirAfter = new THREE.Vector3(0, 0, -1).applyQuaternion(getCameraById(id).getWorldQuaternion(new THREE.Quaternion()))
    expect(dirBefore.angleTo(dirAfter)).toBeCloseTo(0, 4) // rotation was about Z; look axis is -Z so it's unchanged…
    root.rotation.x += Math.PI / 2
    scene.updateMatrixWorld(true)
    const dirTurned = new THREE.Vector3(0, 0, -1).applyQuaternion(getCameraById(id).getWorldQuaternion(new THREE.Quaternion()))
    expect(dirBefore.angleTo(dirTurned)).toBeGreaterThan(1) // …but a tilt swings it
  })

  it('"Snap to view" puts an attached camera at the viewport pose in WORLD space', () => {
    const { id } = newCamera()
    attachCameraToRoot(id, root, 7)
    snapCam.position.set(-6, 4, 2)
    snapCam.quaternion.setFromAxisAngle(V(0, 1, 0), 0.9)
    snapCameraToView(id)
    scene.updateMatrixWorld(true)
    const cam = getCameraById(id)
    expect(close(world(cam), V(-6, 4, 2))).toBe(true)
    expect(cam.getWorldQuaternion(new THREE.Quaternion()).angleTo(snapCam.quaternion)).toBeLessThan(1e-4)
  })

  it('detach and object-delete both free the camera at its world spot', () => {
    const { id } = newCamera()
    attachCameraToRoot(id, root, 7)
    scene.updateMatrixWorld(true)
    const spot = world(getCameraById(id))
    releaseFollowersOf(root)
    scene.updateMatrixWorld(true)
    expect(getCameraRigById(id).parent).toBe(scene)
    expect(close(world(getCameraById(id)), spot)).toBe(true)
    expect(useStore.getState().cameraAttachments[id]).toBeUndefined()

    attachCameraToRoot(id, root, 7)
    detachCameraFromObject(id)
    expect(getCameraRigById(id).parent).toBe(scene)
  })

  it('removing an attached camera leaves nothing behind in the scene', () => {
    const { id } = newCamera()
    const rig = getCameraRigById(id)
    attachCameraToRoot(id, root, 7)
    removeCamera(id)
    let found = false
    scene.traverse((o) => { if (o === rig) found = true })
    expect(found).toBe(false)
  })

  it('saves the attached object index', () => {
    const { id } = newCamera()
    attachCameraToRoot(id, root, 7)
    expect(getCamerasData()[0].attachedObjectIndex).toBe(0)
  })
})
