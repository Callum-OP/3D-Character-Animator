import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initCameras, addCamera, getCameraById, clearCameras } from '../three/cameras.js'
import {
  setViewCameraById,
  transitionViewCameraTo,
  settleCameraTransition,
  isCameraTransitionActive,
  __setViewCameraRefsForTest,
  __tickCameraTransitionForTest,
  __getViewCameraForTest,
} from '../three/scene.js'

let free
let idA
let idB

beforeAll(() => {
  const scene = new THREE.Scene()
  free = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  initCameras({
    scene,
    camera: free,
    renderer: { domElement: document.createElement('canvas') },
    controls: { enabled: true, locked: false },
    requestRender: () => {},
  })
  __setViewCameraRefsForTest(free, { enabled: true, locked: false })
})

beforeEach(() => {
  clearCameras()
  idA = addCamera(50, { recordUndo: false, position: [0, 0, 5] }).id
  idB = addCamera(50, { recordUndo: false, position: [10, 0, 5] }).id
  setViewCameraById(null)
  useStore.setState({ viewCameraId: null })
})

describe('camera glide vs recording', () => {
  it('a hard camera set cancels a glide still in flight (it must not finish mid-recording)', () => {
    setViewCameraById(idA)
    useStore.setState({ viewCameraId: idA })
    transitionViewCameraTo(idB) // e.g. the previous shot's restore glide
    expect(isCameraTransitionActive()).toBe(true)

    setViewCameraById(idA) // a new recording arms its camera
    expect(isCameraTransitionActive()).toBe(false)

    __tickCameraTransitionForTest(5) // time passes; the stale glide must be dead
    expect(useStore.getState().viewCameraId).toBe(idA)
    expect(__getViewCameraForTest()).toBe(getCameraById(idA))
  })

  it('settleCameraTransition lands exactly on the destination and syncs the store', () => {
    setViewCameraById(idA)
    useStore.setState({ viewCameraId: idA })
    transitionViewCameraTo(idB)
    expect(settleCameraTransition()).toBe(true)
    expect(isCameraTransitionActive()).toBe(false)
    expect(useStore.getState().viewCameraId).toBe(idB)
    expect(__getViewCameraForTest()).toBe(getCameraById(idB))
    expect(settleCameraTransition()).toBe(false) // nothing left to settle
  })

  it('a glide that ends on the id the store already holds still lands on the REAL camera', () => {
    setViewCameraById(idA)
    useStore.setState({ viewCameraId: idB }) // store already says B, so no Viewport effect will fire
    transitionViewCameraTo(idB)
    expect(__getViewCameraForTest()).not.toBe(getCameraById(idB)) // gliding on the scratch camera
    __tickCameraTransitionForTest(5)
    expect(isCameraTransitionActive()).toBe(false)
    expect(__getViewCameraForTest()).toBe(getCameraById(idB))
  })

  it('a normal glide still completes and lands on the target', () => {
    setViewCameraById(idA)
    useStore.setState({ viewCameraId: idA })
    transitionViewCameraTo(idB, 0.6)
    __tickCameraTransitionForTest(0.3)
    expect(isCameraTransitionActive()).toBe(true)
    __tickCameraTransitionForTest(0.4)
    expect(isCameraTransitionActive()).toBe(false)
    expect(useStore.getState().viewCameraId).toBe(idB)
    expect(__getViewCameraForTest()).toBe(getCameraById(idB))
  })
})