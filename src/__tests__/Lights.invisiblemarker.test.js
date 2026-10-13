import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import * as THREE from 'three'
import { initLights, addLight, pickLightId, getLightById, selectLight, setLightsEnabled, setViewCamera, updateLightSources, setLightUniformScale, setLightCastShadow } from '../three/lights.js'

// Camera at z=10 looking at the origin, 100x100 canvas: NDC (0,0) is the screen centre.
describe('light source sphere: size, selection-only visibility, click target', () => {
  let scene, camera, id, light, bulb

  beforeAll(() => {
    scene = new THREE.Scene()
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
    camera.position.set(0, 0, 10)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    const canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 })
    initLights({ scene, camera, renderer: { domElement: canvas }, controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 1 })
    id = addLight({ recordUndo: false, data: { position: [0, 0, 0] } }).id
    light = getLightById(id)
    bulb = light.children.find((c) => c.userData.isLightBulb)
    scene.updateMatrixWorld(true)
  })

  beforeEach(() => {
    setLightsEnabled(true)
    setViewCamera(null)
    selectLight(null)
    setLightUniformScale(id, 1)
  })

  it('is hidden unless the light is selected', () => {
    updateLightSources()
    expect(bulb.visible).toBe(false)
    selectLight(id)
    updateLightSources()
    expect(bulb.visible).toBe(true)
    selectLight(null)
    updateLightSources()
    expect(bulb.visible).toBe(false)
  })

  it('is a white sphere about 40% visible', () => {
    expect(bulb.material.transparent).toBe(true)
    expect(bulb.material.opacity).toBeCloseTo(0.4)
    expect(bulb.material.color.getHex()).toBe(0xffffff)
    expect(bulb.material.depthWrite).toBe(false)
  })

  it('stays hidden while looking through a placed camera, and when lights are not being edited', () => {
    selectLight(id)
    setViewCamera(new THREE.PerspectiveCamera())
    updateLightSources()
    expect(bulb.visible).toBe(false)
    setViewCamera(camera) // back on the free camera
    updateLightSources()
    expect(bulb.visible).toBe(true)
    setLightsEnabled(false)
    updateLightSources()
    expect(bulb.visible).toBe(false)
  })

  it('its world radius follows the light\'s size', () => {
    const radiusAt = (scale) => {
      setLightUniformScale(id, scale)
      scene.updateMatrixWorld(true)
      const sc = new THREE.Vector3()
      bulb.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc)
      bulb.geometry.computeBoundingSphere()
      return bulb.geometry.boundingSphere.radius * sc.x
    }
    const r1 = radiusAt(1)
    expect(radiusAt(3)).toBeCloseTo(r1 * 3, 5)
    expect(radiusAt(0.5)).toBeCloseTo(r1 * 0.5, 5)
  })

  it('source size softens the light\'s shadows; size 1 leaves them as before', () => {
    setLightCastShadow(id, true)
    updateLightSources()
    expect(light.shadow.radius).toBe(1)
    setLightUniformScale(id, 3)
    updateLightSources()
    expect(light.shadow.radius).toBeGreaterThan(1)
    const mid = light.shadow.radius
    setLightUniformScale(id, 6)
    updateLightSources()
    expect(light.shadow.radius).toBeGreaterThan(mid)
    setLightUniformScale(id, 0.3)
    updateLightSources()
    expect(light.shadow.radius).toBe(1) // never sharper than the default
    setLightUniformScale(id, 1000)
    updateLightSources()
    expect(light.shadow.radius).toBeLessThanOrEqual(10) // capped
  })

  describe('clicking', () => {
    it('picks a light when you click on it, and nothing when you click away', () => {
      expect(pickLightId(0, 0)).toBe(id)
      expect(pickLightId(0.9, 0.9)).toBeNull()
    })

    it('the click target does NOT grow with the light: a huge source cannot block clicks nearby', () => {
      setLightUniformScale(id, 50)
      scene.updateMatrixWorld(true)
      expect(pickLightId(0, 0)).toBe(id)
      expect(pickLightId(0.3, 0)).toBeNull() // 15px away on a 100px canvas — well outside the click radius
    })

    it('the sphere itself can never be hit by a raycast (so nothing else can be blocked by it)', () => {
      selectLight(id)
      updateLightSources()
      setLightUniformScale(id, 50)
      scene.updateMatrixWorld(true)
      const rc = new THREE.Raycaster()
      rc.setFromCamera(new THREE.Vector2(0, 0), camera)
      expect(rc.intersectObject(bulb, false)).toHaveLength(0)
    })

    it('a hidden light cannot be picked', () => {
      light.visible = false
      expect(pickLightId(0, 0)).toBeNull()
      light.visible = true
    })
  })
})
