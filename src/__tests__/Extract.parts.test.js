import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildPartsGroup, safeFileStem } from '../three/extractParts.js'
import { recordOriginalMaterials, applyMaterials, materialsForExport } from '../three/materials.js'

const box = (x, y, z, w = 1, h = 1, d = 1) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial())
  m.position.set(x, y, z)
  m.updateMatrixWorld(true)
  return m
}
const worldCenter = (obj) => new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3())

describe('buildPartsGroup (mesh -> object)', () => {
  it('puts the pivot under the parts\' footprint and keeps their placement relative to it', () => {
    const a = box(10, 1, 5)
    const b = box(12, 1, 5)
    const { group, pivot } = buildPartsGroup([a, b], () => null)
    expect(pivot.x).toBeCloseTo(11) // middle of x 9.5..12.5
    expect(pivot.y).toBeCloseTo(0.5) // lowest point
    expect(pivot.z).toBeCloseTo(5)
    // placing the new object at the pivot reproduces the original world positions exactly
    group.position.copy(pivot)
    group.updateMatrixWorld(true)
    const copies = group.children
    expect(worldCenter(copies[0]).distanceTo(worldCenter(a))).toBeLessThan(1e-5)
    expect(worldCenter(copies[1]).distanceTo(worldCenter(b))).toBeLessThan(1e-5)
  })

  it('bakes the parent object\'s rotation and scale into the parts', () => {
    const parent = new THREE.Group()
    parent.scale.setScalar(2)
    parent.rotation.y = Math.PI / 2
    parent.position.set(3, 0, -4)
    const part = box(1, 0.5, 0)
    parent.add(part)
    parent.updateMatrixWorld(true)
    const { group, pivot } = buildPartsGroup([part], () => null)
    group.position.copy(pivot)
    group.updateMatrixWorld(true)
    const copy = group.children[0]
    expect(worldCenter(copy).distanceTo(worldCenter(part))).toBeLessThan(1e-5)
    expect(new THREE.Box3().setFromObject(copy).getSize(new THREE.Vector3()).x).toBeCloseTo(2) // the 2x scale came with it
  })

  it('uses the supplied material, falling back to the mesh\'s own, and shares the geometry', () => {
    const a = box(0, 0, 0)
    const b = box(2, 0, 0)
    const special = new THREE.MeshStandardMaterial({ color: 0xff0000 })
    const { group } = buildPartsGroup([a, b], (m) => (m === a ? special : null))
    expect(group.children[0].material).toBe(special)
    expect(group.children[1].material).toBe(b.material)
    expect(group.children[0].geometry).toBe(a.geometry)
  })

  it('keeps names, and makes safe file names', () => {
    const a = box(0, 0, 0)
    a.name = 'Car_01 body'
    expect(buildPartsGroup([a], () => null, 'Car').group.children[0].name).toBe('Car_01 body')
    expect(safeFileStem('Car: "red" / 01?')).toBe('Car red 01')
    expect(safeFileStem('???', 'Extracted object')).toBe('Extracted object')
  })
})

describe('materialsForExport (what gets written to a file)', () => {
  function setup() {
    const tex = new THREE.Texture()
    const original = new THREE.MeshPhongMaterial({ map: tex, color: 0x969696 })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), original)
    const model = { meshes: [mesh] }
    recordOriginalMaterials(model)
    return { model, mesh, original, tex }
  }

  it('is the model\'s own textured material even while the viewport shows toon or unlit', () => {
    const { model, mesh, original, tex } = setup()
    for (const mode of ['toon', 'soft', 'unlit']) {
      applyMaterials(model, { mode })
      expect(mesh.material).not.toBe(original) // the viewport stand-in
      const out = materialsForExport(model, mesh, undefined)
      expect(out).toBe(original)
      expect(out.map).toBe(tex)
    }
  })

  it('carries the user\'s colour and material edits on a private copy, never touching the original or the live mesh', () => {
    const { model, mesh, original, tex } = setup()
    applyMaterials(model, { mode: 'toon' })
    const live = mesh.material
    const out = materialsForExport(model, mesh, { slots: { 0: { metalness: 1, roughness: 0.2 } }, color: '#00ff00' })
    expect(out).not.toBe(original)
    expect(out.isMeshPhysicalMaterial).toBe(true)
    expect(out.metalness).toBe(1)
    expect(out.roughness).toBeCloseTo(0.2)
    expect(out.map).toBe(tex)
    expect(original.metalness).toBeUndefined() // Phong original untouched
    expect(mesh.material).toBe(live)
  })

  it('returns null for a mesh it knows nothing about', () => {
    const { model } = setup()
    expect(materialsForExport(model, new THREE.Mesh(), undefined)).toBeNull()
    expect(materialsForExport(null, new THREE.Mesh(), undefined)).toBeNull()
  })
})
