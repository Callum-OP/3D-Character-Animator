import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as THREE from 'three'
import { limitTextureSizes, releaseLoaderCaches } from '../three/textureImport.js'
import { reduceTexture } from '../three/textureReduce.js'
import { recordOriginalMaterials, applyMaterials } from '../three/materials.js'
import { ensureDecimatorReady, applyMeshDecimation, decimateSpecOf } from '../three/decimate.js'
import { useStore } from '../store.js'

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage() {}, imageSmoothingEnabled: true, imageSmoothingQuality: 'low' }))
})

const picture = (w, h, close = vi.fn()) => {
  const t = new THREE.Texture({ width: w, height: h, close })
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
const rootWith = (...materials) => {
  const root = new THREE.Group()
  for (const m of materials) root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m))
  return root
}
const side = (tex) => Math.max(tex.image.width, tex.image.height)

describe('limitTextureSizes (texture size on import)', () => {
  it('redraws oversized textures smaller, keeps small ones, and frees the decoded original', () => {
    const close = vi.fn()
    const big = picture(1024, 512, close)
    const small = picture(128, 128)
    const root = rootWith(new THREE.MeshStandardMaterial({ map: big, normalMap: small }))
    const stats = limitTextureSizes(root, 256)
    expect(side(big)).toBe(256)
    expect(big.image.height).toBe(128)
    expect(side(small)).toBe(128)
    expect(close).toHaveBeenCalledTimes(1)
    expect(stats).toMatchObject({ textures: 2, reduced: 1 })
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore / 3)
  })

  it('handles a texture shared by several materials once', () => {
    const close = vi.fn()
    const shared = picture(1024, 1024, close)
    const second = shared.clone() // shares its Source, like glTF textures of one image
    const root = rootWith(new THREE.MeshStandardMaterial({ map: shared }), new THREE.MeshStandardMaterial({ map: second }))
    const stats = limitTextureSizes(root, 512)
    expect(side(shared)).toBe(512)
    expect(second.source).toBe(shared.source)
    expect(close).toHaveBeenCalledTimes(1)
    expect(stats).toMatchObject({ textures: 1, reduced: 1 })
  })

  it('keeps colour space and settings, and does nothing for "Original" or textures it cannot redraw', () => {
    const tex = picture(1024, 1024)
    tex.wrapS = THREE.RepeatWrapping
    const data = new THREE.DataTexture(new Uint8Array(16), 2, 2)
    const root = rootWith(new THREE.MeshStandardMaterial({ map: tex, roughnessMap: data }))
    expect(limitTextureSizes(root, 0)).toMatchObject({ textures: 0, reduced: 0 })
    expect(side(tex)).toBe(1024)
    limitTextureSizes(root, 256)
    expect(tex.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(tex.wrapS).toBe(THREE.RepeatWrapping)
    expect(data.image.width).toBe(2)
  })

  it('copes with no root', () => {
    expect(limitTextureSizes(null, 512)).toMatchObject({ reduced: 0 })
  })
})

describe('releaseLoaderCaches', () => {
  it('lets go of the glTF parser (which holds the file\'s bytes) and nothing else', () => {
    const parsed = { source: { parser: { cache: {} }, scenes: [1], animations: [] }, root: {} }
    releaseLoaderCaches(parsed)
    expect(parsed.source.parser).toBeNull()
    expect(parsed.source.scenes).toEqual([1])
    expect(parsed.root).toEqual({})
  })
  it('is safe for anything else', () => {
    expect(() => releaseLoaderCaches(null)).not.toThrow()
    expect(() => releaseLoaderCaches({ source: null })).not.toThrow()
    expect(() => releaseLoaderCaches({ source: new THREE.Group() })).not.toThrow()
  })
})

describe('graphics memory is freed for what is no longer drawn', () => {
  it('a part given smaller textures frees the full-size ones from the graphics card', () => {
    const big = picture(2048, 2048)
    const disposed = vi.fn()
    big.addEventListener('dispose', disposed)
    const mat = new THREE.MeshStandardMaterial({ map: big })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat)
    const model = { meshes: [mesh] }
    recordOriginalMaterials(model)
    applyMaterials(model, { mode: 'standard', overrides: { [mesh.uuid]: { textureMax: 256 } } })
    expect(disposed).toHaveBeenCalled()
    expect(side(big)).toBe(2048) // the pixels are untouched: going back to Original just uploads them again
    expect(mesh.material.map).not.toBe(big)
  })

  it('a reduced mesh frees the full geometry\'s graphics buffers', async () => {
    await ensureDecimatorReady()
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), new THREE.MeshStandardMaterial())
    const original = mesh.geometry
    const disposed = vi.fn()
    original.addEventListener('dispose', disposed)
    applyMeshDecimation(mesh, decimateSpecOf({ decimate: { ratio: 0.2 } }))
    expect(disposed).toHaveBeenCalled()
    expect(original.attributes.position.count).toBeGreaterThan(0) // still there to restore
    applyMeshDecimation(mesh, null)
    expect(mesh.geometry).toBe(original)
  })
})

describe('smaller-texture cache stays small', () => {
  it('remembers only the latest sizes of a texture', () => {
    const tex = picture(2048, 2048)
    const a = reduceTexture(tex, 1024).source
    reduceTexture(tex, 512)
    reduceTexture(tex, 256)
    expect(reduceTexture(tex, 256).source).toBe(reduceTexture(tex, 256).source) // recent: reused
    expect(reduceTexture(tex, 1024).source).not.toBe(a) // oldest was let go and is redrawn
  })
})

describe('texture size on import setting', () => {
  it('is an extra limit that defaults to none (the Quality preset sets the normal one) and accepts a value', () => {
    expect(useStore.getState().importTextureLimit).toBe(0)
    useStore.getState().setImportTextureLimit('1024')
    expect(useStore.getState().importTextureLimit).toBe(1024)
    useStore.getState().setImportTextureLimit('0')
    expect(useStore.getState().importTextureLimit).toBe(0)
  })
})

describe('estimateTextureMB (stats readout)', () => {
  it('counts each image once, with a third more for mipmaps', async () => {
    const { estimateTextureMB } = await import('../three/textureImport.js')
    const shared = picture(1024, 1024)
    const scene = rootWith(new THREE.MeshStandardMaterial({ map: shared }), new THREE.MeshStandardMaterial({ map: shared.clone() }))
    expect(estimateTextureMB(scene)).toBeCloseTo((1024 * 1024 * 4 * 1.33) / (1024 * 1024), 1)
    expect(estimateTextureMB(null)).toBe(0)
  })
})
