import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  recordOriginalMaterials,
  applyMaterials,
  normalizeTransparency,
} from '../three/materials.js'

// Regression coverage for "Transparent BSDF doesn't work (isn't transparent)".
// The common real-world cause: an exporter (or a Blender material whose
// Blend Mode was left on "Opaque") writes opacity < 1 without also setting
// the material's transparent flag — three.js then renders it fully opaque
// regardless of opacity, since blending only activates when transparent is
// true.
describe('material transparency normalization', () => {
  it('flags a material transparent when opacity < 1 but transparent was left false', () => {
    const mat = new THREE.MeshStandardMaterial({ opacity: 0.3, transparent: false })
    normalizeTransparency(mat)
    expect(mat.transparent).toBe(true)
  })

  it('flags a material transparent when it has an alpha map, even at opacity 1', () => {
    const mat = new THREE.MeshStandardMaterial({ opacity: 1, transparent: false })
    mat.alphaMap = new THREE.Texture()
    normalizeTransparency(mat)
    expect(mat.transparent).toBe(true)
  })

  it('leaves a genuinely opaque material alone', () => {
    const mat = new THREE.MeshStandardMaterial({ opacity: 1, transparent: false })
    normalizeTransparency(mat)
    expect(mat.transparent).toBe(false)
  })

  it('does not override a material that already explicitly opted out at full opacity', () => {
    // opacity 1 + transparent explicitly true (e.g. an additive glow) should
    // still just pass through untouched by this normalisation step.
    const mat = new THREE.MeshStandardMaterial({ opacity: 1, transparent: true })
    normalizeTransparency(mat)
    expect(mat.transparent).toBe(true)
  })

  it('carries the fix through recordOriginalMaterials, so "Realistic" (standard) mode sees it', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const mat = new THREE.MeshStandardMaterial({ opacity: 0.4, transparent: false })
    const mesh = new THREE.Mesh(geo, mat)
    const model = { meshes: [mesh] }

    recordOriginalMaterials(model)
    applyMaterials(model, { mode: 'standard' })

    expect(mesh.material.transparent).toBe(true)
    expect(mesh.material.opacity).toBeCloseTo(0.4)
  })

  it('carries opacity/transparent through into Flat colour (unlit) and Cartoon (toon) modes too', () => {
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const mat = new THREE.MeshStandardMaterial({ opacity: 0.5, transparent: false })
    const mesh = new THREE.Mesh(geo, mat)
    const model = { meshes: [mesh] }
    recordOriginalMaterials(model)

    applyMaterials(model, { mode: 'unlit' })
    expect(mesh.material.transparent).toBe(true)
    expect(mesh.material.opacity).toBeCloseTo(0.5)

    applyMaterials(model, { mode: 'toon' })
    expect(mesh.material.transparent).toBe(true)
    expect(mesh.material.opacity).toBeCloseTo(0.5)
  })
})