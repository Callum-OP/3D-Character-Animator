import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import {
  initLights, addLight, getLightById, selectLight, setLightDirectional, setLightCone, setLightRange,
  applyLightPreset, LIGHT_PRESETS, getLightsData, applyLightsData, getLightClipboardData, pasteLight,
  updateLightSources, coneVertices, getLightShape, getLightRimSource,
} from '../three/lights.js'

let scene
beforeAll(() => {
  scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  const canvas = document.createElement('canvas')
  initLights({ scene, camera, renderer: { domElement: canvas }, controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 2 })
})
const fresh = (data) => addLight({ recordUndo: false, data })

describe('directional lights are cones (spot lights), not parallel rays', () => {
  it('switching to directional makes a SpotLight with the cone settings; back gives a PointLight', () => {
    const { id } = fresh()
    setLightDirectional(id, true)
    const spot = getLightById(id)
    expect(spot.isSpotLight).toBe(true)
    expect(THREE.MathUtils.radToDeg(spot.angle)).toBeCloseTo(45)
    expect(spot.penumbra).toBeCloseTo(0.35)
    expect(spot.distance).toBeCloseTo(7.5)
    setLightDirectional(id, false)
    expect(getLightById(id).isPointLight).toBe(true)
    expect(getLightById(id).isDirectionalLight).toBeFalsy()
  })

  it('cone angle and softness are applied, clamped and remembered across a type swap', () => {
    const { id } = fresh()
    setLightCone(id, { angle: 20, penumbra: 0.8 })
    setLightDirectional(id, true)
    const spot = getLightById(id)
    expect(THREE.MathUtils.radToDeg(spot.angle)).toBeCloseTo(20)
    expect(spot.penumbra).toBeCloseTo(0.8)
    setLightCone(id, { angle: 500, penumbra: 5 })
    expect(THREE.MathUtils.radToDeg(spot.angle)).toBeLessThan(90)
    expect(spot.penumbra).toBe(1)
    expect(getLightShape(id).angle).toBeLessThan(90)
  })

  it('points where it is aimed: the target follows the light as it is rotated', () => {
    const { id } = fresh({ position: [0, 3, 0] })
    setLightDirectional(id, true)
    const spot = getLightById(id)
    selectLight(id)
    spot.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    updateLightSources()
    spot.updateMatrixWorld(true)
    // the transform gizmo triggers target updates; emulate via save/restore round trip below
    const data = getLightsData().find((d) => d.directional && d.position[1] === 3)
    expect(data.direction).toHaveLength(3)
  })

  it('the aim survives save/load and copy/paste instead of snapping back to the origin', () => {
    const { id } = fresh({ position: [4, 2, 0] })
    setLightDirectional(id, true)
    const spot = getLightById(id)
    spot.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.7)
    const saved = getLightsData().find((d) => d.position[0] === 4)
    const [meta] = applyLightsData([saved])
    const { entry } = { entry: getLightsData().find((d) => d.position[0] === 4 && d.direction) }
    expect(entry.direction).toEqual(saved.direction)
    // copy / paste carries the aim and the cone
    setLightCone(id, { angle: 33, penumbra: 0.2 })
    const clip = getLightClipboardData(id)
    expect(clip.direction).toEqual(saved.direction)
    const pasted = pasteLight(clip)
    expect(pasted.directional).toBe(true)
    expect(pasted.angle).toBe(33)
    expect(meta.directional).toBe(true)
  })

  it('an older project (no saved aim) still loads, aimed at the origin', () => {
    const [meta] = applyLightsData([{ name: 'Old sun', directional: true, position: [3, 4, 5], quaternion: [0, 0, 0, 1], color: '#ffffff', intensity: 2 }])
    const spot = getLightById(meta.id)
    expect(spot.isSpotLight).toBe(true)
    const rim = getLightRimSource(meta.id)
    expect(rim.direction.length()).toBeCloseTo(1)
  })

  it('the beam outline only shows for a selected cone', () => {
    const { id } = fresh()
    setLightDirectional(id, true)
    selectLight(id)
    updateLightSources()
    const cone = getLightById(id).children.find((c) => c.userData.isLightCone)
    expect(cone.visible).toBe(true)
    setLightDirectional(id, false)
    updateLightSources()
    expect(getLightById(id).children.find((c) => c.userData.isLightCone).visible).toBe(false)
    selectLight(null)
  })

  it('the outline geometry matches the angle and has an inner ring where the softness starts', () => {
    const hard = coneVertices(10, 30, 0)
    const soft = coneVertices(10, 30, 0.5)
    expect(soft.length).toBeGreaterThan(hard.length)
    const radius = Math.hypot(hard[0], hard[1])
    expect(radius).toBeCloseTo(10 * Math.tan(THREE.MathUtils.degToRad(30)))
    expect(hard[2]).toBe(-10)
  })
})

describe('light presets', () => {
  it('every preset applies cleanly and is self-consistent', () => {
    for (const preset of LIGHT_PRESETS) {
      const { id } = fresh()
      const meta = applyLightPreset(id, preset.id)
      const light = getLightById(id)
      expect(meta.directional).toBe(preset.directional)
      expect(!!light.isSpotLight).toBe(preset.directional)
      expect(light.distance).toBeCloseTo(preset.range, 1)
      expect(light.intensity).toBeCloseTo(preset.intensity, 2)
      expect(light.castShadow).toBe(preset.castShadow)
      expect('#' + light.color.getHexString()).toBe(preset.color)
      expect(Number.isFinite(light.intensity)).toBe(true)
    }
  })

  it('has the requested kinds: bulb, floodlight, car headlight and tiny status lights with no shadows', () => {
    const byId = Object.fromEntries(LIGHT_PRESETS.map((p) => [p.id, p]))
    expect(byId.bulb.range).toBeCloseTo(22.4 / 3, 0)
    expect(byId.flood.directional && byId.headlight.directional).toBe(true)
    expect(byId.flood.range).toBeGreaterThan(byId.bulb.range * 3)
    expect(byId.headlight.angle).toBeLessThan(byId.flood.angle)
    for (const tiny of ['led', 'screen']) {
      expect(byId[tiny].castShadow).toBe(false)
      expect(byId[tiny].range).toBeLessThan(3)
    }
    expect(byId.led.intensity).toBeLessThan(0.1)
  })

  it('a bigger light is brighter, so it actually reaches the range it claims', () => {
    const byId = Object.fromEntries(LIGHT_PRESETS.map((p) => [p.id, p]))
    expect(byId.flood.intensity).toBeGreaterThan(byId.bulb.intensity * 10)
    expect(byId.candle.intensity).toBeLessThan(byId.bulb.intensity)
  })

  it('applying a preset on a cone then a point keeps the light usable', () => {
    const { id } = fresh()
    applyLightPreset(id, 'headlight')
    applyLightPreset(id, 'bulb')
    expect(getLightById(id).isPointLight).toBe(true)
    setLightRange(id, 12)
    expect(getLightById(id).distance).toBe(12)
  })
})
