import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  addCamera,
  disposeCameras,
  getCameraKeyValue,
  getCameraTransform,
  initCameras,
  removeCamera,
  setCameraTransform,
  sampleCameraTracks,
} from '../three/cameras.js'
import {
  addLight,
  disposeLights,
  getLightById,
  getLightKeyValue,
  getLightTransform,
  initLights,
  removeLight,
  sampleLightTracks,
  setLightTransform,
} from '../three/lights.js'
import { undoScene, redoScene } from '../three/sceneHistory.js'
import { useStore } from '../store.js'
import { clearUndoHistory } from '../three/undoHistory.js'
import { copyCurrentEdit, pasteCurrentEdit, toggleCurrentVisibility } from '../three/editClipboard.js'
import { setLightUniformScale, snapshotLightTransform, commitLightTransform } from '../three/lights.js'
import {
  disposeObjects,
  initObjects,
  scrubObjectAnimation,
  startObjectAnimation,
  stopObjectAnimation,
} from '../three/objects.js'

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)

function makeRefs() {
  return {
    scene,
    camera,
    renderer: { domElement: document.createElement('canvas') },
    controls: { enabled: true, locked: false },
    requestRender: () => {},
    getSceneScale: () => 1,
  }
}

beforeEach(() => {
  clearUndoHistory()
  useStore.setState({ sceneCameras: [], sceneLights: [], selectedCameraId: null, selectedLightId: null, sceneClipboardType: null })
  const refs = makeRefs()
  initCameras(refs)
  initLights(refs)
  initObjects(refs)
})

afterEach(() => {
  clearUndoHistory()
  stopObjectAnimation()
  disposeObjects()
  disposeCameras()
  disposeLights()
  useStore.setState({ sceneCameras: [], sceneLights: [], selectedCameraId: null, selectedLightId: null, sceneClipboardType: null })
})

describe('placeable camera and light transforms', () => {
  it('interpolates camera position, orientation, and visible-body scale', () => {
    const { id, name } = addCamera()
    const start = getCameraKeyValue(id)
    const endQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0)).toArray()

    sampleCameraTracks({
      [name]: [
        { time: 0, pos: start.pos, quat: start.quat, scale: [1, 1, 1] },
        { time: 1, pos: [2, 4, 6], quat: endQuat, scale: [3, 5, 7] },
      ],
    }, 0.5)

    const result = getCameraKeyValue(id)
    expect(result.pos).toEqual(start.pos.map((value, axis) => value + ([2, 4, 6][axis] - value) * 0.5))
    expect(result.quat[1]).toBeCloseTo(Math.sin(Math.PI / 4))
    expect(result.scale).toEqual([2, 3, 4])
  })

  it('interpolates light position, orientation, and marker scale', () => {
    const { id, name } = addLight()
    const start = getLightKeyValue(id)
    const light = getLightById(id)
    const endQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0)).toArray()

    sampleLightTracks({
      [name]: [
        { time: 0, pos: start.pos, quat: start.quat, scale: [1, 1, 1], color: start.color, intensity: start.intensity },
        { time: 1, pos: [2, 4, 6], quat: endQuat, scale: [3, 5, 7], color: '#ffffff', intensity: 4 },
      ],
    }, 0.5)

    const result = getLightKeyValue(id)
    expect(result.pos).toEqual(start.pos.map((value, axis) => value + ([2, 4, 6][axis] - value) * 0.5))
    expect(result.quat[1]).toBeCloseTo(Math.sin(Math.PI / 4))
    expect(result.scale).toEqual([2, 3, 4])
    expect(light.intensity).toBeCloseTo((start.intensity + 4) / 2)
  })

  it('plays and restores camera and light tracks without a character loaded', () => {
    const cameraMeta = addCamera()
    const lightMeta = addLight()
    const cameraStart = getCameraKeyValue(cameraMeta.id)
    const lightStart = getLightKeyValue(lightMeta.id)
    useStore.setState({
      characterOrder: [],
      objectAnimData: {},
      objectAttachmentData: {},
      objectAnimDuration: 0.5,
      objectAnimTime: 0,
      objectAnimPlaying: false,
      animData: {
        tracks: {},
        root: [],
        meshes: {},
        cameras: {
          [cameraMeta.name]: [
            { time: 0, pos: cameraStart.pos, quat: cameraStart.quat, scale: cameraStart.scale },
            { time: 1, pos: [2, 4, 6], quat: cameraStart.quat, scale: [2, 2, 2] },
          ],
        },
        cuts: [],
        morphs: {},
        lights: {
          [lightMeta.name]: [
            { time: 0, pos: lightStart.pos, quat: lightStart.quat, scale: lightStart.scale, color: lightStart.color, intensity: lightStart.intensity },
            { time: 1, pos: [2, 4, 6], quat: lightStart.quat, scale: [2, 2, 2], color: lightStart.color, intensity: 4 },
          ],
        },
      },
    })

    expect(startObjectAnimation()).toBe(1)
    scrubObjectAnimation(0.5)
    expect(getCameraKeyValue(cameraMeta.id).pos).toEqual(cameraStart.pos.map((value, axis) => value + ([2, 4, 6][axis] - value) * 0.5))
    expect(getCameraKeyValue(cameraMeta.id).scale).toEqual([1.5, 1.5, 1.5])
    expect(getLightKeyValue(lightMeta.id).pos).toEqual(lightStart.pos.map((value, axis) => value + ([2, 4, 6][axis] - value) * 0.5))

    stopObjectAnimation()
    expect(getCameraKeyValue(cameraMeta.id).pos).toEqual(cameraStart.pos)
    expect(getLightKeyValue(lightMeta.id).pos).toEqual(lightStart.pos)
  })

  it('undoes and redoes adding and removing cameras and lights', () => {
    const cameraMeta = addCamera()
    useStore.getState().addSceneCamera(cameraMeta)
    useStore.getState().setMode('object')
    undoScene()
    expect(scene.children.some((child) => child.name === cameraMeta.name)).toBe(false)
    expect(useStore.getState().sceneCameras).toEqual([])
    redoScene()
    expect(scene.children.some((child) => child.name === cameraMeta.name)).toBe(true)
    expect(useStore.getState().sceneCameras).toEqual([cameraMeta])
    const cameraBefore = getCameraTransform(cameraMeta.id)
    setCameraTransform(cameraMeta.id, { position: [4, 5, 6] })
    undoScene()
    expect(getCameraTransform(cameraMeta.id).position).toEqual(cameraBefore.position)
    redoScene()
    expect(getCameraTransform(cameraMeta.id).position).toEqual([4, 5, 6])
    removeCamera(cameraMeta.id)
    undoScene()
    expect(getCameraTransform(cameraMeta.id).position).toEqual([4, 5, 6])

    const lightMeta = addLight()
    useStore.getState().addSceneLight(lightMeta)
    useStore.getState().setMode('object')
    undoScene()
    expect(getLightById(lightMeta.id)).toBeNull()
    expect(useStore.getState().sceneLights).toEqual([])
    redoScene()
    expect(getLightById(lightMeta.id)).not.toBeNull()
    expect(useStore.getState().sceneLights).toEqual([lightMeta])
    const lightBefore = getLightTransform(lightMeta.id)
    setLightTransform(lightMeta.id, { position: [7, 8, 9] })
    undoScene()
    expect(getLightTransform(lightMeta.id).position).toEqual(lightBefore.position)
    redoScene()
    expect(getLightTransform(lightMeta.id).position).toEqual([7, 8, 9])
    removeLight(lightMeta.id)
    undoScene()
    expect(getLightById(lightMeta.id)).not.toBeNull()
  })

  it('copies and pastes camera transforms and body scale', () => {
    const cameraMeta = addCamera()
    useStore.getState().addSceneCamera(cameraMeta)
    setCameraTransform(cameraMeta.id, {
      position: [3, 4, 5],
      scale: [2, 2, 2],
    })

    expect(copyCurrentEdit()).toBe('camera')
    const pasted = pasteCurrentEdit()
    expect(pasted.type).toBe('camera')
    expect(getCameraTransform(pasted.result.id)).toEqual(getCameraTransform(cameraMeta.id))
    expect(useStore.getState().sceneCameras).toHaveLength(2)

    undoScene()
    expect(useStore.getState().sceneCameras).toHaveLength(1)
  })

  it('copies hidden lights and tracks visibility and radial resize in scene history', () => {
    const lightMeta = addLight()
    useStore.getState().addSceneLight(lightMeta)
    expect(toggleCurrentVisibility()).toEqual({ type: 'light', visible: false })
    expect(useStore.getState().sceneLights[0].visible).toBe(false)

    expect(copyCurrentEdit()).toBe('light')
    const pasted = pasteCurrentEdit()
    expect(pasted.type).toBe('light')
    expect(useStore.getState().sceneLights.find((light) => light.id === pasted.result.id).visible).toBe(false)
    expect(getLightById(pasted.result.id).visible).toBe(false)

    undoScene()
    expect(useStore.getState().sceneLights).toHaveLength(1)
    undoScene()
    expect(useStore.getState().sceneLights[0].visible).toBe(true)
    redoScene()
    expect(useStore.getState().sceneLights[0].visible).toBe(false)

    const before = snapshotLightTransform(lightMeta.id)
    setLightUniformScale(lightMeta.id, 2.5)
    commitLightTransform(lightMeta.id, before)
    expect(getLightTransform(lightMeta.id).scale).toEqual([2.5, 2.5, 2.5])
    undoScene()
    expect(getLightTransform(lightMeta.id).scale).toEqual(before.scale.toArray())
  })
})
