import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import {
  patchLightsChunk, patchCommonChunk, installShadowDarkening, shadowImmuneUniform, setShadowImmune, addShadowUniforms,
} from '../three/shadowDarkening.js'
import { syncMeshMaterialFlags, recordOriginalMaterials, applyMaterials } from '../three/materials.js'
import {
  initLights, addLight, getLightById, setLightCastShadow, setLightRange, getLightShape,
  setLightDirectional, getLightsData, applyLightsData, DEFAULT_LIGHT_RANGE, MIN_LIGHT_RANGE, MAX_LIGHT_RANGE,
} from '../three/lights.js'
import { useStore } from '../store.js'

describe('shadow immunity (shader + uniform)', () => {
  it('every light type skips its shadow for an immune material, but still multiplies the light by dsShadow', () => {
    const { source, count } = patchLightsChunk(THREE.ShaderChunk.lights_fragment_begin)
    expect(count).toBe(3)
    expect(source.match(/receiveShadow && uShadowImmune < 0\.5/g)).toHaveLength(3)
    expect(source.match(/directLight\.color \*= dsShadow;/g)).toHaveLength(3)
  })

  it('declares the uniform and the reach fade in every material', () => {
    const common = patchCommonChunk('// common')
    expect(common).toContain('uniform float uShadowImmune;')
    expect(common).toContain('float dsReachFade(')
  })

  it('point and spot lights fade their shadow out at their own range; the sun-like key light never does', () => {
    const { source } = patchLightsChunk(THREE.ShaderChunk.lights_fragment_begin)
    const fades = source.match(/dsShadow = mix\( 1\.0, dsShadow, dsReachFade\(.*?\) \);/g) || []
    expect(fades).toHaveLength(2)
    expect(fades.some((f) => f.includes('pointLight.position - geometryPosition') && f.includes('pointLight.distance'))).toBe(true)
    expect(fades.some((f) => f.includes('spotLight.position - geometryPosition') && f.includes('spotLight.distance'))).toBe(true)
  })

  it('the fade is a long smooth ramp, and a light with no range is never faded', () => {
    const common = patchCommonChunk('// common')
    expect(common).toContain('reach > 0.0 ? 1.0 - smoothstep( reach * 0.1, reach, dist ) : 1.0')
  })

  it('is a live per-material uniform, handed to the shader', () => {
    installShadowDarkening()
    const a = new THREE.MeshStandardMaterial()
    const b = new THREE.MeshStandardMaterial()
    expect(shadowImmuneUniform(a).value).toBe(0)
    setShadowImmune(a, true)
    expect(shadowImmuneUniform(a).value).toBe(1)
    expect(shadowImmuneUniform(b).value).toBe(0) // not shared between materials
    const uniforms = {}
    addShadowUniforms(uniforms, a)
    expect(uniforms.uShadowImmune).toBe(shadowImmuneUniform(a))
    setShadowImmune(a, false)
    expect(uniforms.uShadowImmune.value).toBe(0) // the shader's copy follows, no recompile needed
  })

  it('syncMeshMaterialFlags drives it from mesh.userData.shadowImmune, independently of night immunity', () => {
    const m = new THREE.MeshStandardMaterial()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), m)
    syncMeshMaterialFlags([mesh])
    expect(shadowImmuneUniform(m).value).toBe(0)
    mesh.userData.shadowImmune = true
    syncMeshMaterialFlags([mesh])
    expect(shadowImmuneUniform(m).value).toBe(1)
    expect(m.userData.nightImmune).toBeUndefined() // still follows Night mode
    delete mesh.userData.shadowImmune
    syncMeshMaterialFlags([mesh])
    expect(shadowImmuneUniform(m).value).toBe(0)
  })

  it('survives a style switch: generated toon / unlit materials get it too', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    const model = { meshes: [mesh] }
    recordOriginalMaterials(model)
    mesh.userData.shadowImmune = true
    for (const mode of ['toon', 'unlit', 'standard']) {
      applyMaterials(model, { mode })
      syncMeshMaterialFlags(model.meshes)
      expect(shadowImmuneUniform(mesh.material).value).toBe(1)
    }
  })

  it('the store action flags the object', () => {
    useStore.setState({ sceneObjects: [{ id: 7, name: 'Wall' }] })
    useStore.getState().setObjectShadowImmune(7, true)
    expect(useStore.getState().sceneObjects[0].shadowImmune).toBe(true)
  })
})

describe('light range', () => {
  let scene
  beforeAll(() => {
    scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
    const canvas = document.createElement('canvas')
    initLights({ scene, camera, renderer: { domElement: canvas }, controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 2 })
  })

  it('a new light is a bulb: it fades out at 7.5 units (about a third of the old reach)', () => {
    const { id, range } = addLight({ recordUndo: false, data: { castShadow: true } })
    const light = getLightById(id)
    expect(range).toBe(DEFAULT_LIGHT_RANGE)
    expect(light.distance).toBe(DEFAULT_LIGHT_RANGE)
    expect(light.isPointLight).toBe(true)
    expect(DEFAULT_LIGHT_RANGE).toBeCloseTo(22.4 / 3, 0)
  })

  it('the range can be changed and is clamped; it drives the light and so its shadow camera', () => {
    const { id } = addLight({ recordUndo: false, data: { castShadow: true } })
    const light = getLightById(id)
    setLightRange(id, 40)
    expect(light.distance).toBe(40)
    expect(getLightShape(id).range).toBe(40)
    setLightRange(id, 99999)
    expect(light.distance).toBe(MAX_LIGHT_RANGE)
    setLightRange(id, -3)
    expect(light.distance).toBeGreaterThanOrEqual(MIN_LIGHT_RANGE)
  })

  it('keeps its range when shadows are turned on or the type is swapped', () => {
    const { id } = addLight({ recordUndo: false })
    setLightRange(id, 25)
    setLightCastShadow(id, true)
    expect(getLightById(id).distance).toBe(25)
    setLightDirectional(id, true)
    expect(getLightById(id).distance).toBe(25)
    setLightDirectional(id, false)
    expect(getLightById(id).distance).toBe(25)
  })

  it('is saved and restored; a range saved as shadowReach by the previous build still loads', () => {
    const { id } = addLight({ recordUndo: false, data: { castShadow: true } })
    setLightRange(id, 33)
    const saved = getLightsData().find((d) => d.range === 33)
    expect(saved).toBeTruthy()
    const metas = applyLightsData([saved, { name: 'Old', shadowReach: 18, position: [0, 1, 0] }])
    expect(metas[0].range).toBe(33)
    expect(getLightById(metas[0].id).distance).toBe(33)
    expect(metas[1].range).toBe(18)
    expect(getLightById(metas[1].id).distance).toBe(18)
  })
})
