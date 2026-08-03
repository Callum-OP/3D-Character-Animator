import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  recordOriginalMaterials,
  applyMaterials,
  restoreOriginalMaterials,
  disposeGeneratedMaterials,
} from '../three/materials.js'

function makeModel() {
  const geo = new THREE.BoxGeometry(1, 1, 1)
  const original = new THREE.MeshStandardMaterial({ color: 0xff0000 })
  const mesh = new THREE.Mesh(geo, original)
  const model = { meshes: [mesh] }
  recordOriginalMaterials(model)
  return { model, mesh, original }
}

describe('material mode switching', () => {
  it('standard mode uses the untouched original, unchanged', () => {
    const { model, mesh, original } = makeModel()
    applyMaterials(model, { mode: 'standard' })
    expect(mesh.material).toBe(original)
  })

  it('generates exactly one cached material per mesh per mode, reused on repeat switches', () => {
    const { model, mesh } = makeModel()

    applyMaterials(model, { mode: 'unlit' })
    const unlitFirst = mesh.material

    applyMaterials(model, { mode: 'toon' })
    applyMaterials(model, { mode: 'standard' })
    applyMaterials(model, { mode: 'unlit' })

    // Switching back to unlit must reuse the SAME generated material object,
    // not silently build a new one each time (that would leak GPU resources
    // over a long session of toggling modes).
    expect(mesh.material).toBe(unlitFirst)
  })

  it('repeated switches between all three modes are stable (idempotent)', () => {
    const { model, mesh } = makeModel()
    const sequence = ['unlit', 'toon', 'standard', 'toon', 'unlit', 'standard']
    const seenPerMode = { unlit: new Set(), toon: new Set(), standard: new Set() }

    for (const mode of sequence) {
      applyMaterials(model, { mode })
      seenPerMode[mode].add(mesh.material)
    }

    // Every time a given mode was applied, it must have produced/reused the
    // exact same material instance — never more than one distinct object.
    expect(seenPerMode.unlit.size).toBe(1)
    expect(seenPerMode.toon.size).toBe(1)
    expect(seenPerMode.standard.size).toBe(1)
  })

  it('restoreOriginalMaterials puts the real original back verbatim', () => {
    const { model, mesh, original } = makeModel()
    applyMaterials(model, { mode: 'toon' })
    expect(mesh.material).not.toBe(original)

    restoreOriginalMaterials(model)
    expect(mesh.material).toBe(original)
  })

  it('disposeGeneratedMaterials clears the caches so the next apply rebuilds fresh', () => {
    const { model, mesh } = makeModel()
    applyMaterials(model, { mode: 'unlit' })
    const before = mesh.material

    disposeGeneratedMaterials(model)
    applyMaterials(model, { mode: 'unlit' })
    const after = mesh.material

    // A fresh material must be built post-dispose — reusing the disposed one
    // would render broken/blank once its GPU resources were freed.
    expect(after).not.toBe(before)
  })

  it('toon steps/soften changes update the existing toon material rather than replacing it', () => {
    const { model, mesh } = makeModel()
    applyMaterials(model, { mode: 'toon', toonSteps: 3, soften: 0 })
    const mat = mesh.material
    applyMaterials(model, { mode: 'toon', toonSteps: 6, soften: 0.5 })
    expect(mesh.material).toBe(mat) // same object, just its gradient map changed
  })
})