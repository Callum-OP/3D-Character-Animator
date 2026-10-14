import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initCameras, addCamera, removeCamera, getCameraById, snapshotCameraTransform, commitCameraTransform, getCameraRigById } from '../three/cameras.js'
import { __setViewCameraRefsForTest, dollyViewport } from '../three/scene.js'
import '../three/keyframeHistory.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory, getHistorySequence } from '../three/undoHistory.js'

const ctx = () => ({ selectedObjectId: null, mode: 'bone' })
const undo = () => performUndo(ctx())
const redo = () => performRedo(ctx())
const st = () => useStore.getState()
const setIgnore = (on) => useStore.setState({ cameraIgnoresUndo: on })

let scene
beforeAll(() => {
  scene = new THREE.Scene()
  initCameras({
    scene,
    camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: document.createElement('canvas') },
    controls: { enabled: true, locked: false },
    requestRender: () => {},
    getSceneScale: () => 1,
  })
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  useStore.setState({
    cameraIgnoresUndo: false,
    sceneCameras: [],
    activeCharacterId: 1,
    animData: { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} },
  })
  // Clear AFTER resetting the store: that reset is itself a recorded keyframe edit,
  // and the first edit of a test would otherwise coalesce into it.
  clearUndoHistory()
  vi.setSystemTime(Date.now() + 1000)
})
afterEach(() => vi.useRealTimers())

const tick = () => vi.setSystemTime(Date.now() + 1000) // step past the keyframe-edit coalescing window
const newCamera = () => {
  const meta = addCamera(50, { recordUndo: false })
  st().addSceneCamera(meta)
  return meta
}
const moveCamera = (id, x) => {
  snapshotCameraTransform(id)
  getCameraRigById(id).position.x = x
  commitCameraTransform(id)
}

describe('the setting', () => {
  it('is off by default, and is one of the saved app preferences', () => {
    useStore.setState({ cameraIgnoresUndo: false })
    st().setCameraIgnoresUndo(true)
    expect(st().cameraIgnoresUndo).toBe(true)
    expect(JSON.parse(localStorage.getItem('animator-app-settings') ?? localStorage.getItem(Object.keys(localStorage).find((k) => /settings/i.test(k)) ?? '') ?? '{}').cameraIgnoresUndo).toBe(true)
  })
})

describe('placed cameras', () => {
  it('normally, adding / moving / deleting a camera is undoable', () => {
    const before = getHistorySequence()
    const meta = addCamera(50)
    st().addSceneCamera(meta)
    expect(getHistorySequence()).toBeGreaterThan(before)
    undo()
    expect(getCameraById(meta.id)).toBeNull()
  })

  it('with the setting on, none of it is recorded, so undo never touches a camera', () => {
    setIgnore(true)
    const before = getHistorySequence()
    const meta = addCamera(50)
    st().addSceneCamera(meta)
    moveCamera(meta.id, 5)
    expect(getHistorySequence()).toBe(before)
    undo()
    expect(getCameraById(meta.id)).not.toBeNull()
    expect(getCameraRigById(meta.id).position.x).toBe(5)
  })

  it('deleting a camera with the setting on really removes it and frees it', () => {
    setIgnore(true)
    const meta = newCamera()
    const rig = getCameraRigById(meta.id)
    removeCamera(meta.id)
    expect(getCameraById(meta.id)).toBeNull()
    let found = false
    scene.traverse((o) => { if (o === rig) found = true })
    expect(found).toBe(false)
    undo() // nothing to bring it back
    expect(getCameraById(meta.id)).toBeNull()
  })

  it('camera edits no longer wipe the redo history of other edits', () => {
    setIgnore(true)
    const meta = newCamera()
    st().addKeyframe('Hips', 0, [0, 0, 0, 1])
    undo()
    expect(st().animData.tracks.Hips ?? []).toHaveLength(0)
    moveCamera(meta.id, 3) // would normally throw the redo branch away
    redo()
    expect(st().animData.tracks.Hips).toHaveLength(1)
  })
})

describe('camera keyframes', () => {
  const camKey = { time: 0, pos: [1, 2, 3], quat: [0, 0, 0, 1] }

  it('normally a camera keyframe is its own undo step', () => {
    st().addCameraKeyframe('Cam', 0, camKey)
    expect(st().animData.cameras.Cam).toHaveLength(1)
    undo()
    expect(st().animData.cameras.Cam ?? []).toHaveLength(0)
  })

  it('with the setting on, adding a camera keyframe is not recorded', () => {
    setIgnore(true)
    const before = getHistorySequence()
    st().addCameraKeyframe('Cam', 0, camKey)
    expect(getHistorySequence()).toBe(before)
    undo()
    expect(st().animData.cameras.Cam).toHaveLength(1)
  })

  it('other keyframes stay undoable, and undoing them leaves the camera keys alone', () => {
    setIgnore(true)
    st().addCameraKeyframe('Cam', 0, camKey)
    tick()
    st().addKeyframe('Hips', 0, [0, 0, 0, 1])
    expect(st().animData.tracks.Hips).toHaveLength(1)
    undo()
    expect(st().animData.tracks.Hips ?? []).toHaveLength(0)
    expect(st().animData.cameras.Cam).toHaveLength(1) // still there
    redo()
    expect(st().animData.tracks.Hips).toHaveLength(1)
    expect(st().animData.cameras.Cam).toHaveLength(1)
  })

  it('a single edit that changes both a joint key and a camera key: undo only reverts the joint', () => {
    setIgnore(true)
    const a = st().animData
    useStore.setState({
      animData: { ...a, tracks: { Hips: [{ time: 0, quat: [0, 0, 0, 1] }] }, cameras: { Cam: [camKey] } },
    })
    undo()
    expect(st().animData.tracks.Hips ?? []).toHaveLength(0)
    expect(st().animData.cameras.Cam).toHaveLength(1)
  })

  it('a camera edit made AFTER a recorded edit survives undoing that edit', () => {
    setIgnore(true)
    st().addKeyframe('Hips', 0, [0, 0, 0, 1])
    tick()
    st().addCameraKeyframe('Cam', 1, { ...camKey, time: 1 })
    undo()
    expect(st().animData.tracks.Hips ?? []).toHaveLength(0)
    expect(st().animData.cameras.Cam).toHaveLength(1)
  })
})

describe('the viewport (view) camera', () => {
  it('with the setting on, orbit/zoom/framing commits never reach undo history', () => {
    const cam = new THREE.PerspectiveCamera()
    cam.position.set(0, 1, 5)
    const dist = cam.position.distanceTo(new THREE.Vector3(0, 1, 0))
    const controls = { target: new THREE.Vector3(0, 1, 0), update() {}, enabled: true, locked: false, minDistance: dist, maxDistance: dist }
    __setViewCameraRefsForTest(cam, controls)
    setIgnore(true)
    const before = getHistorySequence()
    dollyViewport(-1)
    vi.advanceTimersByTime(500) // let the dolly's history timer fire
    expect(getHistorySequence()).toBe(before)
  })
})
