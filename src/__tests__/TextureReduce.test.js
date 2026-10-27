import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as THREE from 'three'
import {
  reducedSize,
  reduceTexture,
  reduceMaterial,
  textureMaxOf,
  textureStats,
} from '../three/textureReduce.js'
import { recordOriginalMaterials, applyMaterials, materialsForExport, disposeGeneratedMaterials } from '../three/materials.js'
import { useStore } from '../store.js'

beforeEach(() => {
  // jsdom has no real 2D canvas: record what is drawn, which is all the size logic needs.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage() {}, imageSmoothingEnabled: true, imageSmoothingQuality: 'low' }))
})

const picture = (w, h) => {
  const t = new THREE.Texture({ width: w, height: h })
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
const sideOf = (tex) => Math.max(tex.image.width, tex.image.height)

describe('sizes', () => {
  it('shrinks to fit the cap, keeps the aspect, never grows', () => {
    expect(reducedSize(4096, 2048, 512)).toEqual({ width: 512, height: 256 })
    expect(reducedSize(300, 300, 512)).toEqual({ width: 300, height: 300 })
    expect(reducedSize(4096, 1, 64)).toEqual({ width: 64, height: 1 })
    expect(reducedSize(100, 100, null)).toEqual({ width: 100, height: 100 })
  })
  it('reads the cap from a part setting', () => {
    expect(textureMaxOf(undefined)).toBeNull()
    expect(textureMaxOf({ textureMax: 0 })).toBeNull()
    expect(textureMaxOf({ textureMax: 512 })).toBe(512)
  })
})

describe('reduceTexture', () => {
  it('makes a smaller copy and leaves the model\'s own texture and image alone', () => {
    const tex = picture(2048, 1024)
    const image = tex.image
    const small = reduceTexture(tex, 256)
    expect(small).not.toBe(tex)
    expect(sideOf(small)).toBe(256)
    expect(small.image.height).toBe(128)
    expect(small.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(tex.image).toBe(image)
    expect(sideOf(tex)).toBe(2048)
  })
  it('reuses the smaller image for the same size, and returns small / odd textures untouched', () => {
    const tex = picture(1024, 1024)
    expect(reduceTexture(tex, 256).source).toBe(reduceTexture(tex, 256).source)
    expect(reduceTexture(tex, 2048)).toBe(tex)
    const data = new THREE.DataTexture(new Uint8Array(4 * 4 * 4), 4, 4)
    expect(reduceTexture(data, 2)).toBe(data)
    const compressed = new THREE.CompressedTexture([], 512, 512)
    expect(reduceTexture(compressed, 64)).toBe(compressed)
  })
})

describe('reduceMaterial', () => {
  it('copies the material with smaller textures only where needed', () => {
    const m = new THREE.MeshStandardMaterial({ map: picture(2048, 2048), normalMap: picture(64, 64) })
    const made = reduceMaterial(m, 256)
    expect(made.material).not.toBe(m)
    expect(sideOf(made.material.map)).toBe(256)
    expect(made.material.normalMap).toBe(m.normalMap) // already small
    expect(sideOf(m.map)).toBe(2048)
    expect(reduceMaterial(new THREE.MeshStandardMaterial({ map: picture(100, 100) }), 256)).toBeNull()
  })
  it('counts textures once and estimates the memory', () => {
    const shared = picture(1024, 1024)
    const a = new THREE.MeshStandardMaterial({ map: shared })
    const b = new THREE.MeshStandardMaterial({ map: shared, roughnessMap: picture(512, 512) })
    const none = textureStats([a, b], null)
    expect(none.count).toBe(2)
    expect(none.largest).toBe(1024)
    const capped = textureStats([a, b], 256)
    expect(capped.reducedCount).toBe(2)
    expect(capped.bytesAfter).toBeLessThan(none.bytesBefore / 8)
  })
})

describe.each(['standard', 'toon', 'unlit'])('applied to a part — %s mode', (mode) => {
  function setup() {
    const big = picture(2048, 2048)
    const mat = new THREE.MeshStandardMaterial({ map: big })
    const geo = () => new THREE.BoxGeometry(1, 1, 1)
    const a = new THREE.Mesh(geo(), mat)
    const b = new THREE.Mesh(geo(), mat) // shares the material
    const model = { meshes: [a, b] }
    recordOriginalMaterials(model)
    return { model, a, b, mat, big }
  }
  const shownMap = (mesh) => {
    const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    return m.map
  }

  it('shows smaller textures on that part only, then goes back', () => {
    const { model, a, b, big } = setup()
    applyMaterials(model, { mode, overrides: { [a.uuid]: { textureMax: 256 } } })
    expect(sideOf(shownMap(a))).toBe(256)
    expect(shownMap(b)).toBe(big)
    expect(sideOf(big)).toBe(2048)
    applyMaterials(model, { mode, overrides: {} })
    expect(shownMap(a)).toBe(big)
    disposeGeneratedMaterials(model)
  })

  it('changes size when the cap changes', () => {
    const { model, a } = setup()
    applyMaterials(model, { mode, overrides: { [a.uuid]: { textureMax: 512 } } })
    expect(sideOf(shownMap(a))).toBe(512)
    applyMaterials(model, { mode, overrides: { [a.uuid]: { textureMax: 128 } } })
    expect(sideOf(shownMap(a))).toBe(128)
    disposeGeneratedMaterials(model)
  })
})

describe('export and clean-up', () => {
  it('the exported materials carry the smaller textures, and the model\'s own are untouched', () => {
    const big = picture(2048, 2048)
    const mat = new THREE.MeshStandardMaterial({ map: big })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat)
    const model = { meshes: [mesh] }
    recordOriginalMaterials(model)
    expect(materialsForExport(model, mesh, undefined)).toBe(mat)
    const out = materialsForExport(model, mesh, { textureMax: 256 })
    expect(sideOf(out.map)).toBe(256)
    expect(model.materials.originals.get(mesh)).toBe(mat)
    expect(sideOf(mat.map)).toBe(2048)
    disposeGeneratedMaterials(model)
    expect(model.materials.reduced.size).toBe(0)
  })
  it('keeps the transparency switch working on the smaller copy', () => {
    const mat = new THREE.MeshStandardMaterial({ map: picture(1024, 1024), transparent: true })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat)
    const model = { meshes: [mesh] }
    recordOriginalMaterials(model)
    applyMaterials(model, { mode: 'standard', overrides: { [mesh.uuid]: { textureMax: 128, alpha: true } } })
    expect(mesh.material.transparent).toBe(true)
    applyMaterials(model, { mode: 'standard', overrides: { [mesh.uuid]: { textureMax: 128, alpha: false } } })
    expect(mesh.material.transparent).toBe(false)
    expect(mat.transparent).toBe(true) // the model's own material is never switched
    disposeGeneratedMaterials(model)
  })
})

describe('store.setMeshesTextureMax', () => {
  it('stores the cap per part and clears it for the original', () => {
    useStore.setState({ meshOverrides: {} })
    useStore.getState().setMeshesTextureMax(['a', 'b'], 512)
    expect(useStore.getState().meshOverrides.a.textureMax).toBe(512)
    useStore.getState().setMeshesTextureMax(['a'], null)
    expect(useStore.getState().meshOverrides.a.textureMax).toBeUndefined()
    expect(useStore.getState().meshOverrides.b.textureMax).toBe(512)
  })
})
