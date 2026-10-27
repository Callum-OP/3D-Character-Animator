import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { recordOriginalMaterials, applyMaterials } from '../three/materials.js'
import {
  TEXTURE_LOOK_DEFAULT, BAND_OPTIONS, presetLook, resolveTextureLook, isTextureLookActive, normalizeMaterialLook,
} from '../three/textureLook.js'

const resolve = (patch, base = 'original') => resolveTextureLook({ ...presetLook(base), ...patch }, 'object')

describe('contrast, brightness, saturation and tint', () => {
  it('contrast: 0 leaves it, +100% doubles it, -100% halves it', () => {
    expect(resolve({ contrast: 0, colour: 'bw' }).contrast).toBe(1)
    expect(resolve({ contrast: 1, colour: 'bw' }).contrast).toBeCloseTo(2)
    expect(resolve({ contrast: -1, colour: 'bw' }).contrast).toBeCloseTo(0.5)
  })
  it('adds to what the colour option already does (Noir is already contrasty)', () => {
    const noir = resolve({}, 'noir').contrast
    expect(resolve({ contrast: 0.5 }, 'noir').contrast).toBeCloseTo(noir * Math.SQRT2)
  })
  it('saturation: scales the colour option\'s own saturation; -100% is no colour, +100% twice as much', () => {
    expect(resolve({ saturation: -1, colour: 'vivid' }).saturation).toBe(0)
    expect(resolve({ saturation: 1, colour: 'original' }).saturation).toBeCloseTo(2)
    expect(resolve({ saturation: 0.5, colour: 'vivid' }).saturation).toBeCloseTo(1.6 * 1.5)
    expect(resolve({ saturation: 0, colour: 'muted' }).saturation).toBe(0.5)
  })
  it('brightness and tint come through, clamped and tidied', () => {
    expect(resolve({ brightness: 0.4, colour: 'bw' }).brightness).toBeCloseTo(0.4)
    expect(resolve({ brightness: 9, colour: 'bw' }).brightness).toBe(1)
    const red = resolve({ tint: '#ff0000', tintAmount: 0.6, colour: 'bw' })
    expect(red.tint).toEqual([1, 0, 0])
    expect(red.tintAmount).toBeCloseTo(0.6)
    expect(resolve({ tint: 'not a colour', tintAmount: 2, colour: 'bw' }).tint).toEqual([1, 1, 1])
    expect(resolve({ tintAmount: 2, colour: 'bw' }).tintAmount).toBe(1)
  })
  it('any one of them turns the look on; a tint colour with no amount does not', () => {
    expect(isTextureLookActive(TEXTURE_LOOK_DEFAULT)).toBe(false)
    for (const patch of [{ contrast: 0.2 }, { brightness: -0.2 }, { saturation: 0.3 }, { tintAmount: 0.3 }]) {
      expect(isTextureLookActive({ ...TEXTURE_LOOK_DEFAULT, ...patch })).toBe(true)
    }
    expect(isTextureLookActive({ ...TEXTURE_LOOK_DEFAULT, tint: '#ff0000' })).toBe(false)
  })
  it('a preset puts all the adjustments back to nothing', () => {
    const p = presetLook('manga')
    expect(p).toMatchObject({ contrast: 0, brightness: 0, saturation: 0, tintAmount: 0, tint: '#ffffff' })
  })
})

describe('more tone counts', () => {
  it('adds a few: 2, 5 and 12 alongside the existing ones', () => {
    expect(BAND_OPTIONS.map((o) => o.value)).toEqual([0, 2, 3, 4, 5, 6, 8, 10, 12])
    expect(BAND_OPTIONS.find((o) => o.value === 10).label).toBe('10 tones')
    expect(BAND_OPTIONS.find((o) => o.value === 12).label).toBe('12 tones')
  })
})

function model() {
  const mat = new THREE.MeshStandardMaterial({ color: 0x884422, map: new THREE.Texture() })
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), mat)
  const m = { meshes: [mesh] }
  recordOriginalMaterials(m)
  return { m, mesh }
}

describe('adjustments reach the material', () => {
  it('sets the shader values, and switching off clears them', () => {
    const { m, mesh } = model()
    const look = resolve({ contrast: 0.5, brightness: 0.25, tint: '#3366ff', tintAmount: 0.7, bands: 12 })
    applyMaterials(m, { mode: 'toon', textureLook: look })
    const u = mesh.material.userData.texLookUniforms
    expect(u.tlA.value.w).toBeCloseTo(Math.SQRT2)
    expect(u.tlA.value.y).toBe(12)
    expect(u.tlE.value.x).toBeCloseTo(0.25)
    expect(u.tlE.value.y).toBeCloseTo(0.7)
    expect([u.tlTint.value.x, u.tlTint.value.y, u.tlTint.value.z].map((v) => +v.toFixed(2))).toEqual([0.2, 0.4, 1])
    applyMaterials(m, { mode: 'toon', textureLook: null })
    expect(u.tlE.value.toArray()).toEqual([0, 0, 0, 0])
    expect(u.tlC.value.w).toBe(0)
  })
  it.each([['standard', 'standard'], ['toon', 'toon'], ['unlit', 'basic']])('are in the real %s shader', (mode, kind) => {
    const { m, mesh } = model()
    applyMaterials(m, { mode, textureLook: resolve({ tintAmount: 0.5, tint: '#ff8800' }) })
    const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib[kind].fragmentShader, vertexShader: '' }
    mesh.material.onBeforeCompile(shader, {})
    expect(shader.fragmentShader).toContain('tlTint')
    expect(Object.keys(shader.uniforms)).toEqual(expect.arrayContaining(['tlE', 'tlTint']))
  })
})

describe('the new Clay grey and Manga shading, in the shader text', () => {
  it('Clay is a little darker than before', () => {
    const { m, mesh } = model()
    applyMaterials(m, { mode: 'toon', textureLook: resolve({}, 'clay') })
    const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.toon.fragmentShader, vertexShader: '' }
    mesh.material.onBeforeCompile(shader, {})
    expect(shader.fragmentShader).toContain('vec3( 0.26 )')
    expect(shader.fragmentShader).not.toContain('vec3( 0.32 )')
  })
  it('Manga is clean ink on clear paper: everything light is the same white, very dark areas are black', () => {
    const { m, mesh } = model()
    applyMaterials(m, { mode: 'toon', textureLook: resolve({}, 'manga') })
    const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.toon.fragmentShader, vertexShader: '' }
    mesh.material.onBeforeCompile(shader, {})
    const f = shader.fragmentShader
    expect(f).toContain('vec3 tlInk( vec3 lit, float manga, float hatch )')
    expect(f).toContain('tlInk( gl_FragColor.rgb, tlD.x, tlD.w )')
    expect(f).toContain('float ink = 1.0 - smoothstep( 0.06, 0.30, g )') // only very dark colours get ink
    expect(f).toContain('float clean = ink * 0.96') // without hatching the ink is flat and goes to black...
    expect(f).toContain('pow( 0.985 - darkness * 0.955, 2.2 )') // ...on clear paper white
    expect(f).toContain('mix( clean, hatched, hatch )') // hatching is a separate switch
  })
})

describe('normalizeMaterialLook — older or damaged settings', () => {
  it('an older save without the newer controls gets their defaults and keeps what it had', () => {
    const old = { preset: 'noir', detail: 'full', colour: 'noir', bands: 6, pixels: 0, finish: 'original', bumps: 'keep', strength: 0.5, scope: 'objects' }
    const n = normalizeMaterialLook(old)
    expect(n).toMatchObject({ preset: 'noir', colour: 'noir', bands: 6, strength: 0.5, scope: 'objects' })
    expect(n).toMatchObject({ separation: 0.5, contrast: 0, brightness: 0, saturation: 0, tint: '#ffffff', tintAmount: 0 })
  })
  it('anything unknown or out of range is put right', () => {
    const n = normalizeMaterialLook({ detail: 'sparkly', colour: 7, bands: 99, pixels: 'x', scope: null, strength: 4, contrast: -9, tint: 'blue', tintAmount: NaN })
    expect(n.detail).toBe('full')
    expect(n.colour).toBe('original')
    expect(n.bands).toBe(0)
    expect(n.pixels).toBe(0)
    expect(n.scope).toBe('all')
    expect(n.strength).toBe(1)
    expect(n.contrast).toBe(-1)
    expect(n.tint).toBe('#ffffff')
    expect(n.tintAmount).toBe(0)
  })
  it('nothing at all (or not an object) is the default', () => {
    expect(normalizeMaterialLook(undefined)).toEqual(TEXTURE_LOOK_DEFAULT)
    expect(normalizeMaterialLook('hello')).toEqual(TEXTURE_LOOK_DEFAULT)
  })
  it('a valid look comes back unchanged (colour lower-cased)', () => {
    const look = { ...presetLook('anime'), contrast: 0.3, tint: '#FFAA00', tintAmount: 0.4 }
    expect(normalizeMaterialLook(look)).toEqual({ ...look, tint: '#ffaa00' })
  })
})

describe('Manga, Pencil hatching and the coloured comic', () => {
  const uniforms = (look, mode = 'toon') => {
    const { m, mesh } = model()
    applyMaterials(m, { mode, textureLook: look })
    return mesh.material.userData.texLookUniforms
  }

  it('Manga on its own is clean: ink on white, no hatching', () => {
    const u = uniforms(resolve({ colour: 'manga' }))
    expect(u.tlD.value.x).toBe(1) // manga colours
    expect(u.tlD.value.w).toBe(0) // no hatching
  })
  it('Pencil hatching is a Surface finish that can be switched on and off', () => {
    const on = uniforms(resolve({ finish: 'hatch' }))
    expect(on.tlD.value.w).toBe(1)
    expect(on.tlD.value.x).toBe(0) // ...on whatever colours there are: this is the coloured comic
    const off = uniforms(resolve({ finish: 'matte' }))
    expect(off.tlD.value.w).toBe(0)
  })
  it('switching the finish off again removes the hatching', () => {
    const { m, mesh } = model()
    applyMaterials(m, { mode: 'toon', textureLook: resolve({ finish: 'hatch' }) })
    applyMaterials(m, { mode: 'toon', textureLook: resolve({ finish: 'original', colour: 'noir' }) })
    expect(mesh.material.userData.texLookUniforms.tlD.value.w).toBe(0)
  })
  it('the Manga preset is anime-like flat shapes in manga colours with pencil hatching', () => {
    expect(presetLook('manga')).toMatchObject({
      detail: 'regions', separation: 0, colour: 'manga', bands: 0, pixels: 0, bumps: 'flatten', finish: 'hatch', strength: 1,
    })
    const u = uniforms(resolve({}, 'manga'))
    expect(u.tlD.value.x).toBe(1)
    expect(u.tlD.value.w).toBe(1)
  })
  it('hatching is drawn on matte paper: no shine, in the PBR and toon modes alike', () => {
    const { m, mesh } = model()
    applyMaterials(m, { mode: 'standard', textureLook: resolve({ finish: 'hatch' }) })
    expect(mesh.material.roughness).toBe(1)
    expect(mesh.material.metalness).toBe(0)
    const t = model()
    applyMaterials(t.m, { mode: 'toon', textureLook: resolve({ finish: 'hatch' }) })
    expect(t.mesh.material.userData.toonSurfUniforms).toBeUndefined() // nothing to highlight
  })
  it('works in every lighting mode, flat colour lighting included (it needs no shine)', () => {
    for (const mode of ['unlit', 'toon', 'soft', 'standard', 'realistic']) {
      expect(uniforms(resolve({ finish: 'hatch' }), mode).tlD.value.w).toBe(1)
    }
  })
  it.each([['standard', 'standard'], ['toon', 'toon'], ['unlit', 'basic']])('the real %s shader runs the ink stage for hatching alone', (mode, kind) => {
    const { m, mesh } = model()
    applyMaterials(m, { mode, textureLook: resolve({ finish: 'hatch' }) })
    const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib[kind].fragmentShader, vertexShader: '' }
    mesh.material.onBeforeCompile(shader, {})
    expect(shader.fragmentShader).toContain('( tlD.x > 0.5 || tlD.w > 0.5 )')
  })
})
