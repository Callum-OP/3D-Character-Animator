import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { recordOriginalMaterials, applyMaterials, getTransparentMeshes } from '../three/materials.js'

// A face whose skin texture has its alpha connected (glTF "BLEND": transparent,
// depth writes off) next to a plain opaque body, and a hair card that is alpha-tested.
function build() {
  const skin = new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false })
  const body = new THREE.MeshStandardMaterial()
  const hair = new THREE.MeshStandardMaterial({ alphaTest: 0.5 })
  const meshes = [skin, body, hair].map((m) => new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m))
  const model = { meshes }
  recordOriginalMaterials(model)
  return { model, skinMesh: meshes[0], bodyMesh: meshes[1], hairMesh: meshes[2] }
}

describe('transparency detection', () => {
  it('lists only meshes that were loaded with alpha', () => {
    const { model, skinMesh, hairMesh } = build()
    expect(getTransparentMeshes(model)).toEqual([skinMesh, hairMesh])
  })

  it('a model with no alpha has nothing for the toggle to do', () => {
    const model = { meshes: [new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())] }
    recordOriginalMaterials(model)
    expect(getTransparentMeshes(model)).toEqual([])
  })

  it('counts materials the loader flagged transparent only because of an alpha map or partial opacity', () => {
    const mat = new THREE.MeshStandardMaterial({ opacity: 0.6 }) // transparent flag gets fixed up on record
    const model = { meshes: [new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat)] }
    recordOriginalMaterials(model)
    expect(getTransparentMeshes(model)).toHaveLength(1)
  })

  it('counts every sub-material of a multi-material mesh', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial({ transparent: true })])
    const model = { meshes: [mesh] }
    recordOriginalMaterials(model)
    expect(getTransparentMeshes(model)).toEqual([mesh])
  })
})

describe('transparency switch', () => {
  it('stays as loaded when the default is left alone (existing behaviour)', () => {
    const { model, skinMesh } = build()
    applyMaterials(model, { mode: 'standard' })
    expect(skinMesh.material.transparent).toBe(true)
  })

  it.each(['standard', 'unlit', 'toon', 'soft'])('default-off makes alpha materials fully opaque in %s mode', (mode) => {
    const { model, skinMesh, hairMesh, bodyMesh } = build()
    applyMaterials(model, { mode, transparencyDefault: false })
    expect(skinMesh.material.transparent).toBe(false)
    expect(skinMesh.material.depthWrite).toBe(true) // so it hides what's behind it
    expect(hairMesh.material.alphaTest).toBe(0)
    expect(bodyMesh.material.transparent).toBe(false)
    expect(bodyMesh.material.depthWrite).toBe(true)
  })

  it('a mesh can opt back in, and gets exactly its original alpha settings back', () => {
    const { model, skinMesh, hairMesh } = build()
    applyMaterials(model, { mode: 'standard', transparencyDefault: false })
    applyMaterials(model, {
      mode: 'standard',
      transparencyDefault: false,
      overrides: { [skinMesh.uuid]: { alpha: true }, [hairMesh.uuid]: { alpha: true } },
    })
    expect(skinMesh.material.transparent).toBe(true)
    expect(skinMesh.material.depthWrite).toBe(false)
    expect(hairMesh.material.alphaTest).toBe(0.5)
  })

  it('works across mode switches in both directions without losing the original settings', () => {
    const { model, skinMesh } = build()
    const on = { [skinMesh.uuid]: { alpha: true } }
    applyMaterials(model, { mode: 'toon', transparencyDefault: false })
    expect(skinMesh.material.transparent).toBe(false)
    applyMaterials(model, { mode: 'toon', transparencyDefault: false, overrides: on })
    expect(skinMesh.material.transparent).toBe(true) // the cached toon copy is updated too
    applyMaterials(model, { mode: 'unlit', transparencyDefault: false, overrides: on })
    expect(skinMesh.material.transparent).toBe(true)
    applyMaterials(model, { mode: 'standard', transparencyDefault: false })
    expect(skinMesh.material.transparent).toBe(false)
    applyMaterials(model, { mode: 'standard', transparencyDefault: false, overrides: on })
    expect(skinMesh.material.transparent).toBe(true)
    expect(skinMesh.material.depthWrite).toBe(false)
  })

  it('an explicit per-mesh "off" beats an "on" default', () => {
    const { model, skinMesh } = build()
    applyMaterials(model, { mode: 'standard', overrides: { [skinMesh.uuid]: { alpha: false } } })
    expect(skinMesh.material.transparent).toBe(false)
  })

  it('recompiles the shader when transparency flips (it is a compile-time switch)', () => {
    const { model, skinMesh } = build()
    applyMaterials(model, { mode: 'standard' })
    const v = skinMesh.material.version
    applyMaterials(model, { mode: 'standard', transparencyDefault: false })
    expect(skinMesh.material.version).toBeGreaterThan(v)
  })
})
