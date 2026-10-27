import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as THREE from 'three'
import { gradeColour, bakeLookIntoMaterials, lookExportNotes } from '../three/bakeLook.js'
import { resolveTextureLook, normalizeMaterialLook, presetLook, TEXTURE_LOOK_DEFAULT } from '../three/textureLookOptions.js'

// jsdom has no 2D canvas, so give every canvas a pixel buffer and the few calls the baker makes.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    const canvas = this
    if (!canvas.__ctx) {
      const px = () => (canvas.__px = canvas.__px || new Uint8ClampedArray(canvas.width * canvas.height * 4))
      canvas.__ctx = {
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'low',
        drawImage(src, _x, _y, dw, dh) {
          const out = new Uint8ClampedArray(dw * dh * 4)
          const from = src.__px
          for (let y = 0; y < dh; y++) {
            for (let x = 0; x < dw; x++) {
              const sx = Math.min(src.width - 1, Math.floor((x / dw) * src.width))
              const sy = Math.min(src.height - 1, Math.floor((y / dh) * src.height))
              for (let c = 0; c < 4; c++) out[(y * dw + x) * 4 + c] = from[(sy * src.width + sx) * 4 + c]
            }
          }
          canvas.width = dw
          canvas.height = dh
          canvas.__px = out
        },
        getImageData: (x, y, w, h) => ({ data: px(), width: w, height: h }),
        putImageData: (img) => (canvas.__px = img.data),
      }
    }
    return canvas.__ctx
  })
})

function source(w, h, rgba) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const px = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) px.set(rgba(i % w, Math.floor(i / w)), i * 4)
  canvas.__px = px
  const t = new THREE.Texture(canvas)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
const look = (cfg) => resolveTextureLook(normalizeMaterialLook({ ...TEXTURE_LOOK_DEFAULT, ...cfg }), 'character')
const presetResolved = (id) => resolveTextureLook(normalizeMaterialLook(presetLook(id)), 'character')
const pixel = (tex, i = 0) => Array.from(tex.image.__px.slice(i * 4, i * 4 + 4))
const bake = (material, l, extra = {}) => {
  const mesh = extra.mesh || new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material)
  return bakeLookIntoMaterials(material, { mesh, sources: extra.sources || material, look: l, cache: extra.cache || new Map() })
}

describe('gradeColour', () => {
  it('leaves a colour as it is with no look settings', () => {
    const out = gradeColour(0.4, 0.2, 0.1, look({ colour: 'vivid', saturation: 0 }) && { ...look({ colour: 'vivid' }), saturation: 1 })
    expect(out[0]).toBeCloseTo(0.4, 2)
    expect(out[1]).toBeCloseTo(0.2, 2)
    expect(out[2]).toBeCloseTo(0.1, 2)
  })
  it('clay is one plain grey; noir and black & white have no colour', () => {
    const clay = gradeColour(0.9, 0.1, 0.1, look({ colour: 'clay' }))
    expect(clay[0]).toBeCloseTo(0.26, 2)
    expect(clay[1]).toBeCloseTo(0.26, 2)
    const noir = gradeColour(0.8, 0.2, 0.1, look({ colour: 'noir' }))
    expect(noir[0]).toBeCloseTo(noir[1], 5)
    expect(noir[1]).toBeCloseTo(noir[2], 5)
  })
  it('snaps to the chosen number of tones', () => {
    const l = look({ colour: 'bw', bands: 2 })
    for (const v of [0.05, 0.2, 0.5, 0.8]) {
      const [r] = gradeColour(v, v, v, l)
      expect(Math.min(Math.abs(r), Math.abs(r - 1))).toBeLessThan(0.001)
    }
  })
})

describe('bakeLookIntoMaterials', () => {
  it('bakes noir into the texture (no colour left) and leaves the model\'s own material and image alone', () => {
    const map = source(8, 8, () => [200, 50, 50, 255])
    const mat = new THREE.MeshStandardMaterial({ map })
    const { material, baked } = bake(mat, look({ colour: 'noir' }))
    expect(baked).toBe(1)
    expect(material).not.toBe(mat)
    const [r, g, b, a] = pixel(material.map)
    expect(r).toBe(g)
    expect(g).toBe(b)
    expect(a).toBe(255)
    expect(material.color.r).toBeCloseTo(1, 5)
    expect(mat.map).toBe(map)
    expect(pixel(map)).toEqual([200, 50, 50, 255])
    expect(material.map.colorSpace).toBe(THREE.SRGBColorSpace)
  })

  it('clay drops the texture and uses one grey, with matte finish and no relief', () => {
    const mat = new THREE.MeshStandardMaterial({ map: source(8, 8, () => [10, 200, 30, 255]), normalMap: source(8, 8, () => [128, 128, 255, 255]), roughness: 0.2, metalness: 0.8 })
    const { material } = bake(mat, presetResolved('clay'))
    expect(material.map).toBeNull()
    expect(material.color.r).toBeCloseTo(0.26, 2)
    expect(material.color.g).toBeCloseTo(0.26, 2)
    expect(material.normalMap).toBeNull()
    expect(material.roughness).toBe(1)
    expect(material.metalness).toBe(0)
    expect(mat.map).not.toBeNull()
    expect(mat.roughness).toBe(0.2)
  })

  it('grades a plain colour with no texture', () => {
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.8, 0.1, 0.1) })
    const { material } = bake(mat, look({ colour: 'bw' }))
    expect(material.color.r).toBeCloseTo(material.color.g, 5)
    expect(mat.color.g).toBeCloseTo(0.1, 5)
  })

  it('pixel look stores a small grid with hard edges', () => {
    const mat = new THREE.MeshStandardMaterial({ map: source(256, 256, (x) => [x, 100, 50, 255]) })
    const { material } = bake(mat, presetResolved('pixel'))
    expect(material.map.image.width).toBe(16)
    expect(material.map.image.height).toBe(16)
    expect(material.map.magFilter).toBe(THREE.NearestFilter)
  })

  it('smoothed / simplified looks store the texture smaller', () => {
    const mat = new THREE.MeshStandardMaterial({ map: source(1024, 512, () => [90, 90, 90, 255]) })
    const smooth = bake(mat, look({ detail: 'smooth' })).material
    expect(smooth.map.image.width).toBeLessThan(1024 / 4)
    const simple = bake(mat, look({ detail: 'simplified' })).material
    expect(simple.map.image.width).toBeLessThan(smooth.map.image.width)
    expect(simple.map.image.width).toBeGreaterThanOrEqual(4)
  })

  it('blends by strength', () => {
    const map = () => source(4, 4, () => [200, 50, 50, 255])
    const full = pixel(bake(new THREE.MeshStandardMaterial({ map: map() }), look({ colour: 'noir', strength: 1 })).material.map)
    const half = pixel(bake(new THREE.MeshStandardMaterial({ map: map() }), look({ colour: 'noir', strength: 0.5 })).material.map)
    expect(half[0]).toBeGreaterThan(full[0] - 1) // red is above the grey, so it stays between the two
    expect(half[0]).toBeLessThan(200)
    expect(half[0]).not.toBe(half[1])
  })

  it('bakes a texture shared by several parts once', () => {
    const map = source(8, 8, () => [10, 80, 200, 255])
    const a = new THREE.MeshStandardMaterial({ map })
    const b = new THREE.MeshStandardMaterial({ map })
    const cache = new Map()
    const l = look({ colour: 'sepia' })
    const first = bake(a, l, { cache }).material
    const second = bake(b, l, { cache }).material
    expect(first.map).toBe(second.map)
  })

  it('flat colour becomes one plain colour from the texture\'s own average', () => {
    const mat = new THREE.MeshStandardMaterial({ map: source(8, 8, () => [220, 20, 20, 255]) })
    const { material, baked } = bake(mat, look({ detail: 'flat' }))
    expect(baked).toBe(1)
    expect(material.map).toBeNull()
    expect(material.color.r).toBeGreaterThan(0.5)
    expect(material.color.g).toBeLessThan(0.1)
  })

  it('keeps the texture where its alpha matters (cut-outs)', () => {
    const mat = new THREE.MeshStandardMaterial({ map: source(4, 4, (x) => [100, 100, 100, x < 2 ? 0 : 255]), transparent: true })
    const { material } = bake(mat, presetResolved('clay'))
    expect(material.map).not.toBeNull()
    expect(pixel(material.map, 0)[3]).toBe(0)
    expect(pixel(material.map, 3)[3]).toBe(255)
  })

  it('leaves a material it cannot read as it is and counts it', () => {
    const data = new THREE.DataTexture(new Uint8Array(16), 2, 2)
    const mat = new THREE.MeshStandardMaterial({ map: data })
    const out = bake(mat, look({ colour: 'noir' }))
    expect(out.material).toBe(mat)
    expect(out.baked).toBe(0)
    expect(out.failed).toBe(1)
  })

  it('bakes every material of a multi-material part', () => {
    const list = [new THREE.MeshStandardMaterial({ color: 0xff0000 }), new THREE.MeshStandardMaterial({ color: 0x00ff00 })]
    const out = bake(list, look({ colour: 'clay' }), { sources: list })
    expect(Array.isArray(out.material)).toBe(true)
    expect(out.baked).toBe(2)
    expect(out.material[1].color.g).toBeCloseTo(0.26, 2)
  })

  it('does nothing when there is no look', () => {
    const mat = new THREE.MeshStandardMaterial()
    expect(bakeLookIntoMaterials(mat, { look: null, cache: new Map() }).material).toBe(mat)
  })
})

describe('what cannot be baked is reported', () => {
  it('names Manga ink and pencil hatching', () => {
    expect(lookExportNotes(presetLook('manga'))).toEqual(['Manga ink', 'pencil hatching'])
    expect(lookExportNotes(presetLook('clay'))).toEqual([])
    expect(lookExportNotes(null)).toEqual([])
  })
})

describe('Manga preset', () => {
  it('uses 80% contrast', () => {
    expect(presetLook('manga').contrast).toBe(0.8)
  })
})
