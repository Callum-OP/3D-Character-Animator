import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { recordOriginalMaterials, applyMaterials, disposeGeneratedMaterials, restoreOriginalMaterials } from '../three/materials.js'

function tex() {
  return new THREE.Texture()
}

// Two meshes SHARING one material (common on props), plus a textured one with
// an alpha map, plus one with a multi-material array.
function build() {
  const shared = new THREE.MeshStandardMaterial({ color: 0x336699 })
  const map = tex()
  const textured = new THREE.MeshStandardMaterial({ color: 0xffffff, map, alphaMap: tex(), transparent: true })
  const multiA = new THREE.MeshStandardMaterial({ color: 0xaa0000 })
  const multiB = new THREE.MeshStandardMaterial({ color: 0x00aa00, map })
  const geo = () => new THREE.BoxGeometry(1, 1, 1)
  const meshes = [
    new THREE.Mesh(geo(), shared),
    new THREE.Mesh(geo(), shared),
    new THREE.Mesh(geo(), textured),
    new THREE.Mesh(geo(), [multiA, multiB]),
  ]
  const model = { meshes }
  recordOriginalMaterials(model)
  return { model, meshes, shared, textured, map, multiA, multiB }
}

const hex = (c) => '#' + c.getHexString()
const MODES = ['unlit', 'toon', 'soft', 'standard']

describe.each(MODES)('mesh colour override — %s mode', (mode) => {
  it('tints just the recoloured mesh, even when its material is shared with another mesh', () => {
    const { model, meshes, shared } = build()
    applyMaterials(model, { mode, overrides: { [meshes[0].uuid]: { color: '#ff0000' } } })
    expect(hex(meshes[0].material.color)).toBe('#ff0000')
    expect(hex(meshes[1].material.color)).toBe('#336699') // sibling untouched
    expect(hex(shared.color)).toBe('#336699') // the loaded original is never mutated
  })

  it('by default keeps the texture (a tint); "solid" drops it but keeps the alpha cut-out', () => {
    const { model, meshes, map, textured } = build()
    const uuid = meshes[2].uuid
    applyMaterials(model, { mode, overrides: { [uuid]: { color: '#00ffff', solid: false } } })
    expect(meshes[2].material.map).toBe(map)
    applyMaterials(model, { mode, overrides: { [uuid]: { color: '#00ffff', solid: true } } })
    expect(meshes[2].material.map).toBeNull()
    expect(meshes[2].material.alphaMap).toBe(textured.alphaMap)
    expect(hex(meshes[2].material.color)).toBe('#00ffff')
    expect(textured.map).toBe(map) // original keeps its texture
  })

  it('clearing the override restores the loaded colour and texture exactly', () => {
    const { model, meshes, map } = build()
    const uuid = meshes[2].uuid
    applyMaterials(model, { mode, overrides: { [uuid]: { color: '#ff00ff', solid: true } } })
    applyMaterials(model, { mode, overrides: {} })
    expect(hex(meshes[2].material.color)).toBe('#ffffff')
    expect(meshes[2].material.map).toBe(map)
  })

  it('re-applying with the same override is stable (no drift, no extra materials)', () => {
    const { model, meshes } = build()
    const ov = { [meshes[0].uuid]: { color: '#123456' } }
    applyMaterials(model, { mode, overrides: ov })
    const first = meshes[0].material
    applyMaterials(model, { mode, overrides: ov })
    expect(meshes[0].material).toBe(first)
    expect(hex(first.color)).toBe('#123456')
  })

  it('recolours every sub-material of a multi-material mesh', () => {
    const { model, meshes } = build()
    applyMaterials(model, { mode, overrides: { [meshes[3].uuid]: { color: '#abcdef' } } })
    expect(meshes[3].material).toHaveLength(2)
    for (const m of meshes[3].material) expect(hex(m.color)).toBe('#abcdef')
  })

  it('colour override does not disturb transparency handling', () => {
    const { model, meshes } = build()
    applyMaterials(model, { mode, overrides: { [meshes[2].uuid]: { color: '#ff0000', alpha: false } } })
    expect(meshes[2].material.transparent).toBe(false)
    applyMaterials(model, { mode, overrides: { [meshes[2].uuid]: { color: '#ff0000', alpha: true } } })
    expect(meshes[2].material.transparent).toBe(true)
  })
})

describe('mesh colour override — mode switching and cleanup', () => {
  it('survives switching modes back and forth', () => {
    const { model, meshes } = build()
    const overrides = { [meshes[0].uuid]: { color: '#ff8800' } }
    for (const mode of ['standard', 'toon', 'unlit', 'soft', 'standard']) {
      applyMaterials(model, { mode, overrides })
      expect(hex(meshes[0].material.color)).toBe('#ff8800')
      expect(hex(meshes[1].material.color)).toBe('#336699')
    }
  })

  it('Standard mode leaves un-recoloured meshes on the exact original material', () => {
    const { model, meshes, shared } = build()
    applyMaterials(model, { mode: 'standard', overrides: { [meshes[0].uuid]: { color: '#ff0000' } } })
    expect(meshes[1].material).toBe(shared)
    expect(meshes[0].material).not.toBe(shared)
    // …and un-recolouring puts the mesh straight back on it.
    applyMaterials(model, { mode: 'standard', overrides: {} })
    expect(meshes[0].material).toBe(shared)
  })

  it('a recoloured Standard-mode copy starts with a clean userData (no stale rim-light flag)', () => {
    const { model, meshes, shared } = build()
    applyMaterials(model, { mode: 'standard', overrides: {} })
    expect(shared.userData.rimLightInstalled).toBe(true)
    applyMaterials(model, { mode: 'standard', overrides: { [meshes[0].uuid]: { color: '#ff0000' } } })
    const copy = meshes[0].material
    expect(copy.userData.rimLightInstalled).toBe(true) // freshly installed on the copy…
    expect(typeof copy.onBeforeCompile).toBe('function') // …with its shader hook actually present
    expect(copy.userData.rimColor).toBeInstanceOf(THREE.Color)
  })

  it('disposing generated materials also frees the recoloured copies', () => {
    const { model, meshes } = build()
    applyMaterials(model, { mode: 'standard', overrides: { [meshes[0].uuid]: { color: '#ff0000' } } })
    const copy = meshes[0].material
    let disposed = false
    copy.addEventListener('dispose', () => { disposed = true })
    restoreOriginalMaterials(model)
    disposeGeneratedMaterials(model)
    expect(disposed).toBe(true)
  })

  it('a model whose materials record predates the tinted cache still works', () => {
    const { model, meshes } = build()
    delete model.materials.tinted
    applyMaterials(model, { mode: 'standard', overrides: { [meshes[0].uuid]: { color: '#ff0000' } } })
    expect(hex(meshes[0].material.color)).toBe('#ff0000')
  })
})
