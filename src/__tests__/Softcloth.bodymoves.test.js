import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { initSoftCloth, disposeSoftCloth, syncSoftCloth, stepSoftCloth, makeSoftZone } from '../three/softcloth.js'

beforeAll(() => initSoftCloth({ requestRender: () => {} }))
afterEach(() => disposeSoftCloth())

// A tube of cloth stays put while a closed body slides sideways into it. The cloth's own animated
// positions end up inside the body, so "stay on the side the animated position is on" is not enough:
// the body's own outside has to be used.
describe('soft cloth against a body that moves into it', () => {
  it('is pushed out of the body, not further into it', () => {
    const root = new THREE.Group()
    new THREE.Scene().add(root)
    const cloth = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.8, 32, 24, true).translate(0, 1, 0), new THREE.MeshBasicMaterial())
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.8, 48, 40, false).translate(0, 0.9, 0), new THREE.MeshBasicMaterial())
    root.add(cloth, body)
    root.updateMatrixWorld(true)
    const zone = { ...makeSoftZone('soft', { kind: 'all' }), collideWithMeshes: true, lockTop: 0.1, range: 0.2, gravity: 1, stiffness: 0.1, damping: 0.2 }
    syncSoftCloth([{ meshes: [cloth, body], overrides: { [cloth.uuid]: { softZones: [zone] } } }])

    let worst = 0
    let inside = 0
    let samples = 0
    for (let f = 0; f < 80; f++) {
      body.position.x = Math.sin(f * 0.25) * 0.035
      root.updateMatrixWorld(true)
      stepSoftCloth(1 / 60)
      if (f < 20) continue
      const p = cloth.geometry.getAttribute('position')
      for (let i = 0; i < p.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(cloth.matrixWorld)
        if (v.y > 1.32) continue // the locked top band follows the pose
        const depth = 0.12 - Math.hypot(v.x - body.position.x, v.z)
        samples++
        if (depth > 0.003) inside++
        worst = Math.max(worst, depth)
      }
    }
    // Before: roughly 15% of the vertices inside, up to ~27 mm deep.
    expect(worst).toBeLessThan(0.01)
    expect(inside / samples).toBeLessThan(0.01)
  })
})
