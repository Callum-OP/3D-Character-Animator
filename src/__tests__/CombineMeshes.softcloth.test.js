import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { combineMeshes } from '../three/combineMeshes.js'
import { initSoftCloth, disposeSoftCloth, syncSoftCloth, stepSoftCloth, suspendSoftCloth, resumeSoftCloth, getSoftEntry, makeSoftZone } from '../three/softcloth.js'

// A part with a soft cloth effect running must still export (and combine) as its clean pose, never mid-swing.
describe('Combine meshes with soft cloth running', () => {
  it('the combined mesh carries the clean pose, not the swinging one', () => {
    initSoftCloth({ requestRender: () => {} })
    const scene = new THREE.Scene()
    const root = new THREE.Group()
    scene.add(root)
    const b0 = new THREE.Bone()
    const b1 = new THREE.Bone()
    b1.position.set(0, 1, 0)
    b0.add(b1)
    root.add(b0)
    root.updateMatrixWorld(true)
    const skeleton = new THREE.Skeleton([b0, b1])
    const part = (geometry, color, name) => {
      const n = geometry.getAttribute('position').count
      const si = new Uint16Array(n * 4)
      const sw = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) {
        const t = Math.min(1, Math.max(0, geometry.getAttribute('position').getY(i)))
        si[4 * i + 1] = 1
        sw[4 * i] = 1 - t
        sw[4 * i + 1] = t
      }
      geometry.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4))
      geometry.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
      const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ color }))
      mesh.name = name
      root.add(mesh)
      root.updateMatrixWorld(true)
      mesh.bind(skeleton)
      return mesh
    }
    const cloth = part(new THREE.PlaneGeometry(1, 1.2, 6, 8).translate(0, 0.9, 0), 'red', 'Hoodie')
    part(new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0.9, 0.5, 0), 'blue', 'Body')
    const clean = Float32Array.from(cloth.geometry.getAttribute('position').array)

    syncSoftCloth([{ meshes: [cloth], overrides: { [cloth.uuid]: { softZones: [{ ...makeSoftZone('soft', { kind: 'all' }, 'hem'), range: 0.3, lockTop: 0.2 }] } } }])
    for (let f = 0; f < 30; f++) {
      b0.position.x = Math.sin(f * 0.5) * 0.5
      root.updateMatrixWorld(true)
      stepSoftCloth(1 / 60)
    }
    // mid-swing: the part's buffer really does hold offsets
    const entry = getSoftEntry(cloth)
    expect(Array.from(cloth.geometry.getAttribute('position').array)).not.toEqual(Array.from(entry.rest))

    // what the export does: hold the effect off, then combine the copy
    suspendSoftCloth()
    const report = combineMeshes(root)
    resumeSoftCloth()
    expect(report.combined).toHaveLength(1)
    let merged = null
    root.traverse((o) => o.isSkinnedMesh && (merged = o))
    // every vertex of the merged mesh is a clean-pose vertex: the cloth's rest positions are all in there
    const p = merged.geometry.getAttribute('position')
    const have = new Set()
    for (let i = 0; i < p.count; i++) have.add(`${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`)
    for (let i = 0; i < clean.length; i += 3) expect(have.has(`${clean[i].toFixed(4)},${clean[i + 1].toFixed(4)},${clean[i + 2].toFixed(4)}`)).toBe(true)
    disposeSoftCloth()
  })
})
