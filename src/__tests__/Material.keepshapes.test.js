import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { recordOriginalMaterials, applyMaterials } from '../three/materials.js'
import { extractPalette, sampleTextureColours, averageTextureColor, resolveTextureLook, presetLook, DETAIL_OPTIONS } from '../three/textureLook.js'

// ---- helpers ---------------------------------------------------------------
// deterministic "noise" so the tests are stable
let seed = 7
const noise = (amp) => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return (seed / 4294967296 - 0.5) * 2 * amp
}
const colours = (groups) => {
  const out = []
  for (const [count, [r, g, b], jitter] of groups) {
    for (let i = 0; i < count; i++) out.push(r + noise(jitter), g + noise(jitter), b + noise(jitter))
  }
  return Float32Array.from(out)
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const BEIGE = [0.82, 0.74, 0.62]
const BLUE = [0.3, 0.45, 0.75]
const DARK = [0.22, 0.14, 0.1]

describe('extractPalette — telling clearly different colours apart', () => {
  it('a wall with a window and a frame keeps those three colours separate', () => {
    const wall = colours([[8500, BEIGE, 0.04], [1100, BLUE, 0.04], [400, DARK, 0.03]])
    const palette = extractPalette(wall)
    expect(palette).toHaveLength(3)
    expect(dist(palette[0], BEIGE)).toBeLessThan(0.05) // most common first
    expect(palette.some((p) => dist(p, BLUE) < 0.06)).toBe(true)
    expect(palette.some((p) => dist(p, DARK) < 0.06)).toBe(true)
  })

  it('the plain texture of a wall — grain, dirt, gentle gradient — stays ONE colour', () => {
    const wall = colours([[6000, BEIGE, 0.09]]) // lots of variation, none of it "obvious"
    expect(extractPalette(wall)).toHaveLength(1)
    const gradient = []
    for (let i = 0; i < 5000; i++) gradient.push(0.55 + (i / 5000) * 0.12, 0.45 + (i / 5000) * 0.12, 0.35)
    expect(extractPalette(Float32Array.from(gradient))).toHaveLength(1)
  })

  it('stray specks (under 2% of the surface) are not separate shapes', () => {
    const palette = extractPalette(colours([[9900, BEIGE, 0.03], [100, BLUE, 0.02]]))
    expect(palette).toHaveLength(1)
  })

  it('sensitivity decides how subtle a change counts as a shape', () => {
    const faint = [BEIGE[0] - 0.19, BEIGE[1] - 0.19, BEIGE[2] - 0.19] // a fairly subtle second colour
    const samples = colours([[6000, BEIGE, 0.02], [3000, faint, 0.02]])
    expect(extractPalette(samples, { threshold: 0.4 })).toHaveLength(1) // low sensitivity: only very obvious
    expect(extractPalette(samples, { threshold: 0.12 })).toHaveLength(2) // high sensitivity: this counts
  })

  it('never returns more than the palette size, and handles nothing at all', () => {
    const many = []
    for (let i = 0; i < 12; i++) many.push(...colours([[500, [i / 12, ((i * 5) % 12) / 12, ((i * 7) % 12) / 12], 0.005]]))
    const flat = Float32Array.from(many)
    expect(extractPalette(flat, { threshold: 0.05 }).length).toBeLessThanOrEqual(8)
    expect(extractPalette(new Float32Array(0))).toEqual([])
    expect(extractPalette(null)).toEqual([])
  })
})

// ---- sampling a real mesh ---------------------------------------------------
// an 8 x 8 wall texture with a 2 x 2 blue window in the middle (~6% of the area)
function wallPixels() {
  const w = 8
  const data = new Uint8Array(w * w * 4)
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const window = x >= 3 && x <= 4 && y >= 3 && y <= 4
      const c = window ? BLUE : BEIGE
      data.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], (y * w + x) * 4)
    }
  }
  return { data, width: w, height: w }
}
function quad() {
  // ONE big wall: two triangles covering the whole texture (so a centroid-only reading never sees the window)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 0, 0, 4, 3, 0, 0, 3, 0], 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2))
  return g
}
const wallTexture = () => Object.assign(new THREE.Texture(), { colorSpace: THREE.SRGBColorSpace, flipY: false })

describe('sampling what the mesh shows of its texture', () => {
  it('finds a small window inside a big wall triangle (triangle centres alone would miss it)', () => {
    const g = quad()
    const samples = sampleTextureColours(g, 0, wallTexture(), wallPixels())
    expect(samples.length / 3).toBeGreaterThan(5000)
    let blue = 0
    for (let i = 0; i < samples.length; i += 3) if (dist([samples[i], samples[i + 1], samples[i + 2]], BLUE) < 0.08) blue++
    const share = blue / (samples.length / 3)
    expect(share).toBeGreaterThan(0.03) // window is 4/64 = 6.25% of the wall
    expect(share).toBeLessThan(0.1)
    // whereas the simple average-per-surface reading just blurs it into the wall colour
    const avg = averageTextureColor(g, 0, wallTexture(), wallPixels())
    expect(avg.b).toBeLessThan(0.45)
  })

  it('gives the same answer every time', () => {
    const a = sampleTextureColours(quad(), 0, wallTexture(), wallPixels())
    const b = sampleTextureColours(quad(), 0, wallTexture(), wallPixels())
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('end to end: wall + window gives a two-colour palette, in the right colours', () => {
    const samples = sampleTextureColours(quad(), 0, wallTexture(), wallPixels())
    const palette = extractPalette(samples, { threshold: 0.26 })
    expect(palette).toHaveLength(2)
    expect(dist(palette[0], BEIGE)).toBeLessThan(0.05)
    expect(dist(palette[1], BLUE)).toBeLessThan(0.05)
  })

  it('only the texels a material slot uses count (an atlas)', () => {
    const g = quad()
    g.addGroup(0, 3, 0)
    g.addGroup(3, 3, 1)
    const left = sampleTextureColours(g, 0, wallTexture(), wallPixels(), true)
    expect(left.length).toBeGreaterThan(0)
    expect(sampleTextureColours(g, 7, wallTexture(), wallPixels(), true)).toBeNull() // no triangles use slot 7
  })

  it('no UVs, no samples', () => {
    const g = quad()
    g.deleteAttribute('uv')
    expect(sampleTextureColours(g, 0, wallTexture(), wallPixels())).toBeNull()
  })
})

// ---- applying it ------------------------------------------------------------
function wallModel({ readable = true } = {}) {
  const px = wallPixels()
  const tex = readable ? new THREE.DataTexture(px.data, px.width, px.height) : new THREE.Texture()
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = false
  tex.needsUpdate = true
  const mat = new THREE.MeshStandardMaterial({ map: tex })
  const mesh = new THREE.Mesh(quad(), mat)
  const model = { meshes: [mesh] }
  recordOriginalMaterials(model)
  return { model, mesh, mat }
}
const keep = (separation = 0.5, extra = {}) =>
  resolveTextureLook({ ...presetLook('original'), detail: 'regions', separation, ...extra }, 'object')

describe.each(['unlit', 'toon', 'soft', 'standard', 'realistic'])('Flat — keep shapes — %s lighting', (mode) => {
  it('hands the shader the wall and window colours', () => {
    const { model, mesh } = wallModel()
    applyMaterials(model, { mode, textureLook: keep() })
    const u = mesh.material.userData.texLookUniforms
    expect(u.tlD.value.z).toBe(2) // palette size
    expect(u.tlD.value.y).toBe(1) // fully applied
    const [a, b] = u.tlPal.value
    expect(dist([a.x, a.y, a.z], BEIGE)).toBeLessThan(0.05)
    expect(dist([b.x, b.y, b.z], BLUE)).toBeLessThan(0.05)
  })

  it('a texture that can not be read is left as it is', () => {
    const { model, mesh } = wallModel({ readable: false })
    applyMaterials(model, { mode, textureLook: keep() })
    expect(mesh.material.userData.texLookUniforms.tlD.value.z).toBe(0)
  })

  it('switches off cleanly', () => {
    const { model, mesh } = wallModel()
    applyMaterials(model, { mode, textureLook: keep() })
    applyMaterials(model, { mode, textureLook: null })
    if (mode === 'toon' || mode === 'soft' || mode === 'unlit') expect(mesh.material.userData.texLookUniforms.tlD.value.z).toBe(0)
  })
})

describe('Flat — keep shapes — the controls', () => {
  it('is a Texture detail option (next to the plain Flat colour), used by Anime and Flat Pixel', () => {
    expect(DETAIL_OPTIONS.map((d) => d.value)).toContain('regions')
    expect(DETAIL_OPTIONS.map((d) => d.value)).toContain('flat')
    expect(presetLook('anime').detail).toBe('regions')
    expect(presetLook('flatpixel').detail).toBe('regions')
    expect(presetLook('flat').detail).toBe('flat') // the Flat colour preset is the plain one
  })
  it('sensitivity moves the threshold from "very obvious changes" to "subtle ones"', () => {
    expect(keep(0).threshold).toBeCloseTo(0.4)
    expect(keep(1).threshold).toBeCloseTo(0.12)
    expect(keep(0.5).threshold).toBeGreaterThan(keep(1).threshold)
    expect(keep(0.5).threshold).toBeLessThan(keep(0).threshold)
  })
  it('a preset sets the sensitivity (Anime: 0%), and others put it back to the middle', () => {
    expect(presetLook('anime', { separation: 0.8 }).separation).toBe(0)
    expect(presetLook('flat', { separation: 0.8 }).separation).toBe(0.5)
    expect(presetLook('noir', { separation: 0.2 }).separation).toBe(0.5)
  })
  it('more sensitivity keeps more colours on the same wall', () => {
    const { model, mesh } = wallModel()
    applyMaterials(model, { mode: 'toon', textureLook: keep(0) })
    const strict = mesh.material.userData.texLookUniforms.tlD.value.z
    applyMaterials(model, { mode: 'toon', textureLook: keep(1) })
    const fine = mesh.material.userData.texLookUniforms.tlD.value.z
    expect(fine).toBeGreaterThanOrEqual(strict)
    expect(strict).toBe(2) // wall and window are very obviously different even at the lowest sensitivity
  })

  it.each([['standard', 'standard'], ['toon', 'toon'], ['unlit', 'basic']])('patches the real %s shader', (mode, kind) => {
    const { model, mesh } = wallModel()
    applyMaterials(model, { mode, textureLook: keep() })
    const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib[kind].fragmentShader, vertexShader: '' }
    mesh.material.onBeforeCompile(shader, {})
    expect(shader.fragmentShader).toContain('tlPal[ i ]')
    expect(Object.keys(shader.uniforms)).toContain('tlPal')
    expect(shader.uniforms.tlPal.value).toHaveLength(8)
  })
})

// ---- finish in the toon modes ----------------------------------------------
function plainModel() {
  const normalMap = new THREE.Texture()
  const mat = new THREE.MeshStandardMaterial({ color: 0x889966, normalMap, roughness: 0.4 })
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), mat)
  const model = { meshes: [mesh] }
  recordOriginalMaterials(model)
  return { model, mesh, mat }
}
const finishLook = (finish, extra = {}) => resolveTextureLook({ ...presetLook('original'), finish, ...extra }, 'object')
const toonSurf = (mesh) => mesh.material.userData.toonSurfUniforms

describe('Surface finish now shows in the toon-style lighting modes too', () => {
  it.each(['toon', 'soft'])('glossy draws a highlight in %s lighting', (mode) => {
    const { model, mesh } = plainModel()
    applyMaterials(model, { mode, textureLook: finishLook('glossy') })
    const u = toonSurf(mesh)
    expect(u.tsC.value.w).toBe(1) // switched on
    expect(u.tsA.value.z).toBe(1) // specular
    expect(u.tsA.value.x).toBeCloseTo(0.15) // roughness
    expect(u.tsB.value.x).toBeCloseTo(0.5) // clear-coat glint
    expect(u.tsB.value.w).toBe(mode === 'soft' ? 1 : 0) // soft anime airbrushes the edge
  })

  it('satin is a broad soft sheen, metallic reflects the sky', () => {
    const { model, mesh } = plainModel()
    applyMaterials(model, { mode: 'toon', textureLook: finishLook('satin') })
    expect(toonSurf(mesh).tsA.value.z).toBeCloseTo(0.6)
    applyMaterials(model, { mode: 'toon', textureLook: finishLook('metallic') })
    expect(toonSurf(mesh).tsA.value.y).toBeCloseTo(0.9)
    expect(toonSurf(mesh).tsA.value.x).toBeCloseTo(0.32)
  })

  it('matte draws nothing, so it installs nothing', () => {
    const { model, mesh } = plainModel()
    applyMaterials(model, { mode: 'toon', textureLook: finishLook('matte') })
    expect(toonSurf(mesh)).toBeUndefined()
  })

  it('going back to Original takes the highlight off again', () => {
    const { model, mesh } = plainModel()
    applyMaterials(model, { mode: 'toon', textureLook: finishLook('glossy') })
    applyMaterials(model, { mode: 'toon', textureLook: finishLook('original', { colour: 'noir' }) })
    expect(toonSurf(mesh).tsC.value.w).toBe(0)
  })

  it('a surface set in the material editor still wins', () => {
    const { model, mesh } = plainModel()
    const ov = { [mesh.uuid]: { slots: { 0: { roughness: 0.05, metalness: 0.2 } } } }
    applyMaterials(model, { mode: 'toon', overrides: ov, textureLook: finishLook('glossy') })
    expect(toonSurf(mesh).tsA.value.x).toBeCloseTo(0.05) // the editor's roughness, not the finish's 0.15
    expect(toonSurf(mesh).tsA.value.y).toBeCloseTo(0.2)
  })

  it('flattened bumps stay flat even with a finish', () => {
    const { model, mesh } = plainModel()
    applyMaterials(model, { mode: 'toon', textureLook: finishLook('glossy', { bumps: 'flatten' }) })
    expect(mesh.material.normalScale.x).toBe(0)
  })

  it('flat (unlit) lighting has no shine to change', () => {
    const { model, mesh } = plainModel()
    applyMaterials(model, { mode: 'unlit', textureLook: finishLook('glossy') })
    expect(toonSurf(mesh)).toBeUndefined()
  })
})
