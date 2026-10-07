import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import {
  addCamera,
  applyCamerasData,
  clearCameras,
  getCameraById,
  getCameraTransform,
  getCamerasData,
  initCameras,
  sampleCameraTracks,
  setCameraTransform,
} from '../three/cameras.js'
import {
  addLight,
  applyLightsData,
  clearLights,
  getLightById,
  getLightKeyValue,
  getLightsData,
  initLights,
  sampleLightTracks,
  setLightColor,
  setLightIntensity,
} from '../three/lights.js'

let scene
let viewportCamera

beforeAll(() => {
  scene = new THREE.Scene()
  viewportCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  viewportCamera.position.set(1, 2, 3)
  const refs = {
    scene,
    camera: viewportCamera,
    renderer: { domElement: document.createElement('canvas') },
    controls: { enabled: true, locked: false },
    requestRender: () => {},
    getSceneScale: () => 2,
  }
  initCameras(refs)
  initLights(refs)
})

beforeEach(() => {
  clearCameras()
  clearLights()
  useStore.setState({ sceneCameras: [], sceneLights: [], viewCameraId: null })
})

describe('placeable cameras', () => {
  it('starts at the viewport view and interpolates position and orientation between keys', () => {
    const camera = addCamera(42, { recordUndo: false })
    expect(getCameraById(camera.id).fov).toBe(42)
    expect(getCameraTransform(camera.id).position).toEqual([1, 2, 3])

    const quarterTurn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    sampleCameraTracks({
      [camera.name]: [
        { time: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        { time: 2, pos: [4, 2, -2], quat: quarterTurn.toArray(), scale: [3, 1, 1] },
      ],
    }, 1)

    const transform = getCameraTransform(camera.id)
    expect(transform.position).toEqual([2, 1, -1])
    expect(transform.scale).toEqual([2, 1, 1])
    expect(new THREE.Quaternion(...transform.quaternion).angleTo(quarterTurn)).toBeCloseTo(Math.PI / 4)
  })

  it('round-trips camera names and transforms through project data', () => {
    const original = applyCamerasData([{
      name: 'Close-up',
      fov: 35,
      position: [4, 5, 6],
      quaternion: [0, 0, 0, 1],
      scale: [0.7, 0.8, 0.9],
    }])

    expect(original).toHaveLength(1)
    expect(getCamerasData()).toMatchObject([{
      name: 'Close-up',
      fov: 35,
      position: [4, 5, 6],
      scale: [0.7, 0.8, 0.9],
    }])
  })

  it('records explicit transform changes and ignores missing camera ids', () => {
    const camera = addCamera(50, { recordUndo: false })
    setCameraTransform(camera.id, { position: [7, 8, 9] })
    expect(getCameraTransform(camera.id).position).toEqual([7, 8, 9])
    expect(() => setCameraTransform(-1, { position: [0, 0, 0] })).not.toThrow()
    expect(getCameraTransform(-1)).toBeNull()
  })
})

describe('placed lights', () => {
  it('round-trips saved light settings, including visibility and directional mode', () => {
    const metadata = applyLightsData([{
      name: 'Rim',
      color: '#336699',
      intensity: 3.5,
      directional: true,
      castShadow: false,
      visible: false,
      position: [2, 3, 4],
      quaternion: [0, 0, 0, 1],
      scale: [1, 2, 1],
    }])

    expect(metadata).toMatchObject([{ name: 'Rim', color: '#336699', intensity: 3.5, directional: true, visible: false }])
    expect(getLightsData()).toMatchObject([{
      name: 'Rim',
      color: '#336699',
      intensity: 3.5,
      directional: true,
      visible: false,
      position: [2, 3, 4],
      scale: [1, 2, 1],
    }])
  })

  it('interpolates animated position, color, and intensity and keeps the bulb color in sync', () => {
    const light = addLight({ recordUndo: false })
    const lightObject = getLightById(light.id)
    sampleLightTracks({
      [light.name]: [
        { time: 0, pos: [0, 0, 0], color: '#000000', intensity: 1 },
        { time: 2, pos: [4, 2, 6], color: '#ffffff', intensity: 5 },
      ],
    }, 1)

    expect(lightObject.position.toArray()).toEqual([2, 1, 3])
    expect(lightObject.intensity).toBe(3)
    expect(lightObject.color.r).toBeCloseTo(0.5)
    expect(lightObject.children[0].material.color.equals(lightObject.color)).toBe(true)
    expect(getLightKeyValue(light.id).intensity).toBe(3)
  })

  it('updates the placed light without changing the global key-light setting', () => {
    const light = addLight({ recordUndo: false })
    useStore.getState().setLightIntensity(1.75)
    setLightColor(light.id, '#ff8800')
    setLightIntensity(light.id, 4)

    expect(useStore.getState().lightIntensity).toBe(1.75)
    expect(getLightKeyValue(light.id)).toMatchObject({ color: '#ff8800', intensity: 4 })
  })
})
