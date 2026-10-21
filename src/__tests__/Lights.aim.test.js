import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import * as THREE from 'three'
import {
  initLights, addLight, getLightById, setLightDirectional, attachLightToRoot, updateLightSources, getLightAim, setLightAim,
  flipLightAim, directionFromAim, LIGHT_PRESETS, lightDataForPreset,
} from '../three/lights.js'
import { faceOfObject, outwardDirection, adjustDirection } from '../three/lightFromPart.js'
import { withGlowRegion, GLOW_REGION_NAME } from '../three/glowRegions.js'
import { undoScene } from '../three/sceneHistory.js'
import { clearUndoHistory } from '../three/undoHistory.js'
import { MAX_REGIONS } from '../three/regions.js'

let scene
beforeAll(() => {
  scene = new THREE.Scene()
  initLights({ scene, camera: new THREE.PerspectiveCamera(), renderer: { domElement: document.createElement('canvas') }, controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 2 })
})
beforeEach(() => clearUndoHistory())

const beamWorld = (light) => {
  light.updateMatrixWorld(true)
  light.target.updateMatrixWorld(true)
  return light.target.getWorldPosition(new THREE.Vector3()).sub(light.getWorldPosition(new THREE.Vector3())).normalize()
}
const near = (v, x, y, z) => { expect(v.x).toBeCloseTo(x, 4); expect(v.y).toBeCloseTo(y, 4); expect(v.z).toBeCloseTo(z, 4) }

describe('a cone attached to an object turns with it', () => {
  function attachedCone() {
    const root = new THREE.Group()
    scene.add(root)
    const meta = addLight({ recordUndo: false, data: { ...lightDataForPreset('headlight'), position: [0, 1, 2], direction: [0, 0, 1] } })
    const light = getLightById(meta.id)
    attachLightToRoot(meta.id, root, 99, { keepLocal: false })
    return { root, light, id: meta.id }
  }

  it('the beam rotates when the object rotates (the bug: the aim only updated on light edits)', () => {
    const { root, light } = attachedCone()
    updateLightSources()
    near(beamWorld(light), 0, 0, 1)
    root.rotation.y = Math.PI / 2 // turn the car a quarter turn
    root.updateMatrixWorld(true)
    updateLightSources() // what every rendered frame does
    near(beamWorld(light), 1, 0, 0)
    root.rotation.y = Math.PI
    updateLightSources()
    near(beamWorld(light), 0, 0, -1)
  })

  it('also follows the object being tilted and moved', () => {
    const { root, light } = attachedCone()
    root.rotation.x = -Math.PI / 2 // nose pitched to point up
    root.position.set(10, 0, 0)
    updateLightSources()
    near(beamWorld(light), 0, 1, 0)
    expect(light.getWorldPosition(new THREE.Vector3()).x).toBeCloseTo(10, 4)
  })
})

describe('aim in degrees', () => {
  const fresh = () => {
    const meta = addLight({ recordUndo: false, data: { ...lightDataForPreset('flood'), position: [0, 3, 0], direction: [0, 0, 1] } })
    clearUndoHistory()
    return meta.id
  }

  it('reads yaw 0-360 and pitch from the world direction', () => {
    const id = fresh()
    let aim = getLightAim(id)
    expect(aim.yaw).toBeCloseTo(0)
    expect(aim.pitch).toBeCloseTo(0)
    setLightAim(id, { yaw: 90 })
    near(beamWorld(getLightById(id)), 1, 0, 0)
    aim = getLightAim(id)
    expect(aim.yaw).toBeCloseTo(90)
    setLightAim(id, { yaw: 270, pitch: 45 })
    aim = getLightAim(id)
    expect(aim.yaw).toBeCloseTo(270)
    expect(aim.pitch).toBeCloseTo(45)
    expect(beamWorld(getLightById(id)).y).toBeCloseTo(Math.sin(Math.PI / 4), 4)
  })

  it('yaw wraps 0-360 and pitch is clamped to straight up / down', () => {
    const id = fresh()
    setLightAim(id, { pitch: 500 })
    expect(getLightAim(id).pitch).toBeCloseTo(90)
    setLightAim(id, { pitch: 0, yaw: 359 })
    expect(getLightAim(id).yaw).toBeCloseTo(359)
  })

  it('flip turns the beam the opposite way', () => {
    const id = fresh()
    flipLightAim(id)
    near(beamWorld(getLightById(id)), 0, 0, -1)
    expect(getLightAim(id).yaw).toBeCloseTo(180)
  })

  it('on an attached light the angles are world angles, so they follow the object', () => {
    const root = new THREE.Group()
    scene.add(root)
    const meta = addLight({ recordUndo: false, data: { ...lightDataForPreset('torch'), position: [0, 1, 0], direction: [0, 0, 1] } })
    attachLightToRoot(meta.id, root, 7, { keepLocal: false })
    root.rotation.y = Math.PI / 2
    updateLightSources()
    expect(getLightAim(meta.id).yaw).toBeCloseTo(90)
    setLightAim(meta.id, { yaw: 180 }) // point it world-south
    near(beamWorld(getLightById(meta.id)), 0, 0, -1)
    root.rotation.y = 0 // car turns back a quarter turn: the beam, fixed to the car, turns with it (south -> east)
    updateLightSources()
    expect(getLightAim(meta.id).yaw).toBeCloseTo(90, 3)
  })

  it('aim changes can be undone', () => {
    const id = fresh()
    setLightAim(id, { yaw: 120 })
    undoScene()
    expect(getLightAim(id).yaw).toBeCloseTo(0)
  })

  it('a point light has no aim', () => {
    const meta = addLight({ recordUndo: false })
    expect(getLightAim(meta.id)).toBeNull()
  })

  it('directionFromAim is a unit vector', () => {
    for (const [y, p] of [[0, 0], [90, 30], [200, -60], [359, 89]]) expect(directionFromAim(y, p).length()).toBeCloseTo(1)
  })
})

describe('smart aiming', () => {
  // A car 4 long (Z) x 2 wide (X) x 1 high, as one mesh, optionally rotated in the world.
  const car = (rotY = 0) => {
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshBasicMaterial()))
    root.rotation.y = rotY
    root.position.set(5, 0.5, 5)
    root.updateMatrixWorld(true)
    return root
  }
  const at = (root, x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(root.matrixWorld)

  it('finds the side of the object a point is on, in the object\'s own axes', () => {
    const root = car()
    near(faceOfObject(at(root, 0.4, 0, 1.9), root), 0, 0, 1) // front
    near(faceOfObject(at(root, -0.3, 0, -1.9), root), 0, 0, -1) // back
    near(faceOfObject(at(root, 0.95, 0, 0.5), root), 1, 0, 0) // right side
    near(faceOfObject(at(root, 0, 0.45, 0.2), root), 0, 1, 0) // roof
    expect(faceOfObject(at(root, 0, 0, 0), root)).toBeNull() // dead centre: no side
  })

  it('a rotated car still has its own front', () => {
    const root = car(Math.PI / 2)
    const front = faceOfObject(at(root, 0.4, 0, 1.9), root)
    near(front, 1, 0, 0) // local +Z is now world +X
  })

  it('smart: a headlight whose faces point INTO the car still shines out of the front', () => {
    const root = car()
    const position = at(root, 0.5, 0, 1.9)
    const surface = { position, normal: new THREE.Vector3(0, 0, -1), size: 0.3 } // winding is flipped
    const faceDir = faceOfObject(position, root)
    near(outwardDirection(surface, at(root, 0, 0, 0), { mode: 'smart', faceDir }), 0, 0, 1)
  })

  it('smart keeps a slightly angled lens normal when it agrees with the side of the car', () => {
    const root = car()
    const position = at(root, 0.5, 0, 1.9)
    const n = new THREE.Vector3(0.3, 0, 1).normalize()
    const out = outwardDirection({ position, normal: n, size: 0.3 }, at(root, 0, 0, 0), { mode: 'smart', faceDir: faceOfObject(position, root) })
    expect(out.x).toBeGreaterThan(0.2)
  })

  it('smart ignores a lens normal that disagrees with the side of the car', () => {
    const root = car()
    const position = at(root, 0.5, 0, 1.9)
    const sideways = new THREE.Vector3(1, 0, 0)
    near(outwardDirection({ position, normal: sideways, size: 0.3 }, at(root, 0, 0, 0), { mode: 'smart', faceDir: faceOfObject(position, root) }), 0, 0, 1)
  })

  it('the other modes behave as named', () => {
    const root = car()
    const position = at(root, 0.5, 0, 1.9)
    const surface = { position, normal: new THREE.Vector3(1, 0, 0), size: 0.3 }
    const faceDir = faceOfObject(position, root)
    near(outwardDirection(surface, at(root, 0, 0, 0), { mode: 'surface', faceDir }), 1, 0, 0)
    near(outwardDirection(surface, at(root, 0, 0, 0), { mode: 'face', faceDir }), 0, 0, 1)
  })

  it('manual adjustment: flip, yaw 0-360, pitch', () => {
    const fwd = new THREE.Vector3(0, 0, 1)
    near(adjustDirection(fwd, { flip: true }), 0, 0, -1)
    near(adjustDirection(fwd, { yaw: 90 }), 1, 0, 0)
    near(adjustDirection(fwd, { yaw: 180 }), 0, 0, -1)
    near(adjustDirection(fwd, { yaw: 360 }), 0, 0, 1)
    const up = adjustDirection(fwd, { pitch: 30 })
    expect(up.y).toBeCloseTo(0.5, 4)
    expect(adjustDirection(fwd, { pitch: -30 }).y).toBeCloseTo(-0.5, 4)
    near(adjustDirection(fwd, {}), 0, 0, 1)
  })
})

describe('presets for mesh lights', () => {
  it('has a tail light and an indicator: coloured cones with no shadows', () => {
    const byId = Object.fromEntries(LIGHT_PRESETS.map((p) => [p.id, p]))
    expect(byId.taillight.directional).toBe(true)
    expect(byId.taillight.color).toMatch(/^#ff/i)
    expect(byId.taillight.castShadow).toBe(false)
    expect(byId.indicator.castShadow).toBe(false)
  })
})

describe('turning a part into a light makes the part glow too', () => {
  const quadMesh = () => new THREE.Mesh(new THREE.PlaneGeometry(1, 1).toNonIndexed(), new THREE.MeshBasicMaterial())

  it('adds a whole-part glow region FIRST, so existing regions still win', () => {
    const mesh = quadMesh()
    const existing = [{ id: 'a', name: 'Lens', tris: [[0, 0]], vertexCount: 6, look: { mode: 'solid', color: '#ff0000' } }]
    const out = withGlowRegion(mesh, existing, '#ff3030')
    expect(out).toHaveLength(2)
    expect(out[0].name).toBe(GLOW_REGION_NAME)
    expect(out[0].tris).toEqual([[0, 1]]) // both triangles in one range
    expect(out[0].look.glowColor).toBe('#ff3030')
    expect(out[0].look.glow).toBeGreaterThan(0)
    expect(out[1].id).toBe('a')
  })

  it('updates the glow instead of adding another, and respects the region limit and rigged parts', () => {
    const mesh = quadMesh()
    const once = withGlowRegion(mesh, [], '#ff0000')
    const twice = withGlowRegion(mesh, once, '#00ff00')
    expect(twice).toHaveLength(1)
    expect(twice[0].look.glowColor).toBe('#00ff00')
    const full = Array.from({ length: MAX_REGIONS }, (_, i) => ({ id: 'r' + i, name: 'R' + i, tris: [[0, 0]], look: {} }))
    expect(withGlowRegion(mesh, full, '#ff0000')).toBeNull()
    expect(withGlowRegion(new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()), [], '#fff')).toBeNull()
  })
})
