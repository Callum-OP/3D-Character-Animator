import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import { analyseSurface, outwardDirection, averageSurfaceColor, lightColourFrom } from '../three/lightFromPart.js'
import { initLights, addLight, getLightById, lightDataForPreset } from '../three/lights.js'

// A flat panel facing +Z at z = 1, made of 2 triangles, textured with one colour.
function panel(color = [230, 20, 20]) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 1, 1, 0, 1, 1, 2, 1, -1, 0, 1, 1, 2, 1, -1, 2, 1], 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2))
  const data = new Uint8Array([...color, 255])
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat)
  tex.flipY = false
  tex.needsUpdate = true
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex }))
  mesh.updateMatrixWorld(true)
  return mesh
}

describe('analyseSurface', () => {
  it('finds the middle, the facing and the size of a panel', () => {
    const s = analyseSurface(panel(), null)
    expect(s.position.x).toBeCloseTo(0, 5)
    expect(s.position.y).toBeCloseTo(1, 5)
    expect(s.position.z).toBeCloseTo(1, 5)
    expect(s.normal.z).toBeCloseTo(1)
    expect(s.size).toBeCloseTo(Math.hypot(2, 2))
  })

  it('works on just some of the faces (a region)', () => {
    const s = analyseSurface(panel(), [0]) // one triangle: centroid of (-1,0),(1,0),(1,2)
    expect(s.position.x).toBeCloseTo(1 / 3, 4)
    expect(s.position.y).toBeCloseTo(2 / 3, 4)
  })

  it('follows the mesh\'s world transform, including rotation, and a mirrored one', () => {
    const m = panel()
    m.rotation.y = Math.PI / 2 // the +Z facing turns to +X
    m.position.set(5, 0, 0)
    m.updateMatrixWorld(true)
    const s = analyseSurface(m, null)
    expect(s.normal.x).toBeCloseTo(1)
    expect(s.position.x).toBeCloseTo(6, 4)
    const mirror = panel()
    mirror.scale.x = -1
    mirror.updateMatrixWorld(true)
    expect(analyseSurface(mirror, null).normal.z).toBeCloseTo(1) // winding flip is compensated
  })

  it('a closed shape has no single facing', () => {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    box.updateMatrixWorld(true)
    expect(analyseSurface(box, null).normal).toBeNull()
  })
})

describe('outwardDirection', () => {
  it('points along the surface facing, flipped to point away from the part it sits on', () => {
    const surface = { position: new THREE.Vector3(0, 1, 1), normal: new THREE.Vector3(0, 0, 1), size: 1 }
    expect(outwardDirection(surface, new THREE.Vector3(0, 1, 0)).z).toBeCloseTo(1) // centre behind it: keep
    expect(outwardDirection(surface, new THREE.Vector3(0, 1, 5)).z).toBeCloseTo(-1) // centre in front: the normal pointed inward, flip
  })
  it('without a facing, goes straight out from the centre, or up if it IS the centre', () => {
    const at = (p) => ({ position: new THREE.Vector3(...p), normal: null, size: 1 })
    expect(outwardDirection(at([2, 0, 0]), new THREE.Vector3(0, 0, 0)).x).toBeCloseTo(1)
    expect(outwardDirection(at([0, 0, 0]), new THREE.Vector3(0, 0, 0)).y).toBe(1)
  })
})

describe('colour', () => {
  it('reads the texture colour of the faces (from the original material)', () => {
    const m = panel([230, 20, 20])
    const original = m.material
    m.material = new THREE.MeshToonMaterial({ color: 0xffffff })
    const hex = averageSurfaceColor(m, null, original)
    const c = new THREE.Color(hex)
    expect(c.r).toBeGreaterThan(0.7)
    expect(c.g).toBeLessThan(0.2)
  })

  it('turns a dull colour into a clear light colour of the same hue; greys become soft white', () => {
    const red = new THREE.Color(lightColourFrom('#6a1b1b'))
    const hsl = {}
    red.getHSL(hsl)
    expect(hsl.h === 0 || hsl.h > 0.95 || hsl.h < 0.03).toBe(true)
    expect(hsl.l).toBeGreaterThan(0.45)
    expect(hsl.s).toBeGreaterThan(0.6)
    const grey = new THREE.Color(lightColourFrom('#555555'))
    expect(grey.r).toBeGreaterThan(0.8)
  })
})

describe('a light made from a part', () => {
  let scene
  beforeAll(() => {
    scene = new THREE.Scene()
    initLights({ scene, camera: new THREE.PerspectiveCamera(), renderer: { domElement: document.createElement('canvas') }, controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 2 })
  })

  it('a cone preset is aimed along the given direction from the given spot', () => {
    const meta = addLight({
      recordUndo: false,
      data: { ...lightDataForPreset('headlight'), color: '#ffeeaa', position: [1, 2, 3], direction: [0, 0, 1] },
    })
    const light = getLightById(meta.id)
    expect(light.isSpotLight).toBe(true)
    expect(light.position.toArray()).toEqual([1, 2, 3])
    expect(light.color.getHexString()).toBe('ffeeaa')
    expect(meta.range).toBe(35)
    scene.updateMatrixWorld(true)
  })

  it('a point preset (soft glow) has a short range and no shadows', () => {
    const meta = addLight({ recordUndo: false, data: { ...lightDataForPreset('glow'), position: [0, 1, 0] } })
    const light = getLightById(meta.id)
    expect(light.isPointLight).toBe(true)
    expect(light.distance).toBe(3)
    expect(light.castShadow).toBe(false)
  })
})
