import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import { recordOriginalMaterials, applyMaterials } from '../three/materials.js'
import {
  TEXTURE_LOOK_DEFAULT, TEXTURE_LOOK_PRESETS, DETAIL_OPTIONS, COLOUR_OPTIONS, BAND_OPTIONS, PIXEL_OPTIONS,
  FINISH_OPTIONS, BUMP_OPTIONS, presetLook, isTextureLookActive, resolveTextureLook, averageTextureColor,
} from '../three/textureLook.js'
import { useStore } from '../store.js'

describe('texture look: controls and presets', () => {
  it('the default look does nothing', () => {
    expect(isTextureLookActive(TEXTURE_LOOK_DEFAULT)).toBe(false)
    expect(resolveTextureLook(TEXTURE_LOOK_DEFAULT, 'character')).toBeNull()
  })

  it('every preset only uses values the controls offer, and only Original is inactive', () => {
    const allowed = {
      detail: DETAIL_OPTIONS, colour: COLOUR_OPTIONS, bands: BAND_OPTIONS, pixels: PIXEL_OPTIONS, finish: FINISH_OPTIONS, bumps: BUMP_OPTIONS,
    }
    const ids = new Set()
    for (const p of TEXTURE_LOOK_PRESETS) {
      expect(ids.has(p.id)).toBe(false)
      ids.add(p.id)
      for (const [k, v] of Object.entries(p.config)) {
        if (k === 'strength') expect(v).toBeGreaterThan(0)
        else if (['separation', 'contrast', 'brightness', 'saturation'].includes(k)) expect(Math.abs(v)).toBeLessThanOrEqual(1)
        else if (k === 'separation') expect(v).toBeGreaterThanOrEqual(0)
        else expect(allowed[k].map((o) => o.value)).toContain(v)
      }
      expect(isTextureLookActive(presetLook(p.id))).toBe(p.id !== 'original')
    }
  })

  it('Noir keeps the textures but takes the colour out; Flat colours replaces each texture by one colour', () => {
    const noir = resolveTextureLook(presetLook('noir'), 'character')
    expect(noir.grey).toBe(1)
    expect(noir.contrast).toBeGreaterThan(1)
    expect(noir.flat).toBe(0)
    expect(noir.bias).toBe(0) // still full texture detail
    const flat = plainFlat('character')
    expect(flat.flat).toBe(1)
    expect(flat.flatten).toBe(true)
    expect(flat.grey).toBe(0) // colours kept
  })

  it('Anime: flat colours that keep shapes at 0% sensitivity, vivid, no tone steps, matte, flat bumps, 70%', () => {
    expect(presetLook('anime')).toMatchObject({
      detail: 'regions', separation: 0, colour: 'vivid', bands: 0, pixels: 0, finish: 'matte', bumps: 'flatten', strength: 0.7,
    })
    const anime = resolveTextureLook(presetLook('anime'), 'character')
    expect(anime.regions).toBe(0.7)
    expect(anime.threshold).toBeCloseTo(0.4) // 0% sensitivity: only the most obvious colour changes stay separate
    expect(anime.bands).toBe(0)
    expect(anime.pixels).toBe(0)
    expect(anime.saturation).toBeGreaterThan(1)
    expect(anime.flatten).toBe(true)
    expect(anime.strength).toBe(0.7)
  })

  it('"Apply to" decides who gets it; strength 0 is off; a preset keeps your scope and strength', () => {
    const look = { ...presetLook('noir'), scope: 'objects' }
    expect(resolveTextureLook(look, 'character')).toBeNull()
    expect(resolveTextureLook(look, 'object')).not.toBeNull()
    expect(resolveTextureLook({ ...look, scope: 'characters' }, 'object')).toBeNull()
    expect(resolveTextureLook({ ...presetLook('noir'), strength: 0 }, 'object')).toBeNull()
    // a preset is a whole look: it sets the strength (full unless it says otherwise) but keeps WHERE it applies
    const kept = presetLook('noir', { scope: 'characters', strength: 0.4 })
    expect(kept.scope).toBe('characters')
    expect(kept.strength).toBe(1)
    expect(kept.preset).toBe('noir')
    expect(presetLook('anime', { scope: 'objects' }).scope).toBe('objects')
    expect(presetLook('noir', { strength: 0.7 }).strength).toBe(1) // not left over from Anime
  })

  it('strength softens the texture-sampling effects', () => {
    const simplified = { ...presetLook('original'), detail: 'simplified' }
    const full = resolveTextureLook({ ...simplified, strength: 1 }, 'object')
    const half = resolveTextureLook({ ...simplified, strength: 0.5 }, 'object')
    expect(half.bias).toBeCloseTo(full.bias / 2)
    expect(half.strength).toBe(0.5)
  })
})

describe('the colour a flat texture becomes', () => {
  const px = (rows) => ({ data: new Uint8Array(rows.flat().flatMap((c) => [...c, 255])), width: rows[0].length, height: rows.length })
  // two triangles: A in the left half of the texture, B in the right half
  function geometry(areaA = 1, areaB = 1) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, areaA, 0, 0, 0, 2, 0, 5, 0, 0, 5 + areaB, 0, 0, 5, 2, 0], 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0.2, 0.5, 0.3, 0.5, 0.2, 0.6, 0.7, 0.5, 0.8, 0.5, 0.7, 0.6], 2))
    return g
  }
  const tex = (o = {}) => Object.assign(new THREE.Texture(), { colorSpace: THREE.NoColorSpace, ...o })

  it('averages the texels the mesh really shows, weighted by triangle size', () => {
    const pixels = px([[[255, 0, 0], [0, 0, 255]]]) // left red, right blue
    const even = averageTextureColor(geometry(1, 1), 0, tex(), pixels)
    expect(even.r).toBeCloseTo(0.5, 2)
    expect(even.b).toBeCloseTo(0.5, 2)
    const redHeavy = averageTextureColor(geometry(3, 1), 0, tex(), pixels)
    expect(redHeavy.r).toBeCloseTo(0.75, 2) // three times the red area
    expect(redHeavy.b).toBeCloseTo(0.25, 2)
  })

  it('an atlas gives each part its own colour, not one muddy mix', () => {
    const pixels = px([[[255, 0, 0], [0, 0, 255]]])
    const g = geometry()
    g.addGroup(0, 3, 0)
    g.addGroup(3, 3, 1)
    const left = averageTextureColor(g, 0, tex(), pixels, true)
    const right = averageTextureColor(g, 1, tex(), pixels, true)
    expect(left.r).toBeCloseTo(1, 3)
    expect(left.b).toBeCloseTo(0, 3)
    expect(right.b).toBeCloseTo(1, 3)
  })

  it('reads sRGB textures in linear light, and respects which way up the image is', () => {
    const pixels = px([[[188, 188, 188]], [[0, 128, 0]]]) // top grey, bottom green (1 x 2)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0.5, 0.9, 0.5, 0.9, 0.5, 0.9], 2))
    const flipped = averageTextureColor(g, 0, tex({ colorSpace: THREE.SRGBColorSpace, flipY: true }), pixels)
    expect(flipped.r).toBeCloseTo(0.5, 1) // sRGB 188 is ~50% linear; v = 0.9 is the TOP row when flipped
    const upright = averageTextureColor(g, 0, tex({ colorSpace: THREE.SRGBColorSpace, flipY: false }), pixels)
    expect(upright.g).toBeGreaterThan(0.2) // the green row
    expect(upright.r).toBeLessThan(0.01)
  })

  it('tiles: UVs outside 0..1 wrap round', () => {
    const pixels = px([[[255, 0, 0], [0, 0, 255]]])
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute([3.7, 0.5, 3.7, 0.5, 3.7, 0.5], 2)) // 3.7 -> 0.7 -> right half
    expect(averageTextureColor(g, 0, tex(), pixels).b).toBeCloseTo(1, 3)
  })

  it('no UVs, no answer', () => {
    const g = new THREE.BoxGeometry()
    g.deleteAttribute('uv')
    expect(averageTextureColor(g, 0, tex(), px([[[1, 2, 3]]]))).toBeNull()
  })
})

// ---------------------------------------------------------------------------

function brownTexture() {
  const t = new THREE.DataTexture(new Uint8Array([150, 100, 50, 255, 150, 100, 50, 255, 150, 100, 50, 255, 150, 100, 50, 255]), 2, 2)
  t.colorSpace = THREE.SRGBColorSpace
  t.needsUpdate = true
  return t
}

function build() {
  const normalMap = new THREE.Texture()
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: brownTexture(), normalMap, roughness: 0.3, metalness: 0.4 })
  const plainMat = new THREE.MeshStandardMaterial({ color: 0x336699, roughness: 0.6, metalness: 0.1 })
  const floor = new THREE.Mesh(new THREE.BoxGeometry(4, 0.2, 4), floorMat)
  const plain = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), plainMat)
  const model = { meshes: [floor, plain] }
  recordOriginalMaterials(model)
  return { model, floor, plain, floorMat, plainMat, normalMap }
}
const look = (id, kind = 'object') => resolveTextureLook(presetLook(id), kind)
// the plain "one colour per surface" Flat colour detail (the Flat colours PRESET now keeps shapes)
const plainFlat = (kind = 'object') => resolveTextureLook({ ...presetLook('original'), detail: 'flat', bumps: 'flatten' }, kind)
const uni = (mesh) => mesh.material.userData.texLookUniforms

describe.each(['unlit', 'toon', 'soft', 'standard', 'realistic'])('texture look applied — %s lighting', (mode) => {
  it('grades the textures on the mesh\'s own material and leaves the loaded one alone', () => {
    const { model, floor, floorMat } = build()
    applyMaterials(model, { mode, textureLook: look('noir') })
    expect(floor.material).not.toBe(floorMat)
    expect(uni(floor).tlB.value.x).toBe(1) // grey
    expect(uni(floor).tlA.value.w).toBeGreaterThan(1) // contrast
    expect(uni(floor).tlC.value.w).toBe(1) // switched on
    expect(floor.material.map).toBe(floorMat.map) // the texture is still there
    expect(floorMat.userData.texLookUniforms).toBeUndefined()
  })

  it('switching it off puts the surface back exactly', () => {
    const { model, floor, floorMat } = build()
    applyMaterials(model, { mode, textureLook: look('noir') })
    applyMaterials(model, { mode, textureLook: null })
    if (mode === 'standard' || mode === 'realistic') expect(floor.material).toBe(floorMat)
    else expect(uni(floor).tlC.value.w).toBe(0)
  })

  it('flat colour swaps the texture for its own average — a brown floor stays brown', () => {
    const { model, floor } = build()
    applyMaterials(model, { mode, textureLook: plainFlat() })
    expect(uni(floor).tlB.value.w).toBe(1) // flat mix
    const c = uni(floor).tlFlat.value // linear
    const lin = (v) => Math.pow((v / 255 + 0.055) / 1.055, 2.4)
    expect(c.r).toBeCloseTo(lin(150), 3)
    expect(c.g).toBeCloseTo(lin(100), 3)
    expect(c.b).toBeCloseTo(lin(50), 3)
    expect(floor.material.map).toBeTruthy() // the hook swaps the sample; the slot is unchanged
  })

  it('a texture whose pixels cannot be read keeps its texture rather than going wrong', () => {
    const { model, floor, floorMat } = build()
    floorMat.map = new THREE.Texture() // no image to read
    applyMaterials(model, { mode, textureLook: plainFlat() })
    expect(uni(floor).tlB.value.w).toBe(0)
    applyMaterials(model, { mode, textureLook: look('anime') }) // and the keep-shapes version (Anime uses it)
    expect(uni(floor).tlD.value.z).toBe(0)
  })

  it('an untextured mesh is left as it is (apart from colour grading)', () => {
    const { model, plain } = build()
    applyMaterials(model, { mode, textureLook: plainFlat() })
    expect(uni(plain).tlB.value.w).toBe(0)
  })

  it('"Apply to" objects only: a character is untouched', () => {
    const { model, floor, floorMat } = build()
    const characterLook = resolveTextureLook({ ...presetLook('noir'), scope: 'objects' }, 'character')
    applyMaterials(model, { mode, textureLook: characterLook })
    if (mode === 'standard' || mode === 'realistic') expect(floor.material).toBe(floorMat)
    else expect(floor.material.userData.texLookUniforms).toBeUndefined()
  })
})

describe('bumps and finish', () => {
  it('Flatten removes the surface relief on the copy, never on the loaded material', () => {
    const { model, floor, floorMat } = build()
    applyMaterials(model, { mode: 'standard', textureLook: plainFlat() })
    expect(floor.material.normalScale.x).toBe(0)
    expect(floorMat.normalScale.x).toBe(1)
    applyMaterials(model, { mode: 'toon', textureLook: plainFlat() })
    expect(floor.material.normalScale.x).toBe(0)
  })

  it('Matte / glossy / metallic set the shine on the copy; Original restores it', () => {
    const { model, floor, floorMat } = build()
    const base = presetLook('original')
    applyMaterials(model, { mode: 'standard', textureLook: resolveTextureLook({ ...base, finish: 'matte' }, 'object') })
    expect(floor.material.roughness).toBe(1)
    expect(floor.material.metalness).toBe(0)
    expect(floorMat.roughness).toBe(0.3) // the loaded one is untouched
    applyMaterials(model, { mode: 'standard', textureLook: resolveTextureLook({ ...base, finish: 'metallic' }, 'object') })
    expect(floor.material.metalness).toBeGreaterThan(0.8)
    // a copy that has to stay (the mesh is also recoloured) gets its own values back
    const ov = { [floor.uuid]: { color: '#ff0000' } }
    applyMaterials(model, { mode: 'standard', overrides: ov, textureLook: resolveTextureLook({ ...base, finish: 'glossy' }, 'object') })
    expect(floor.material.roughness).toBeLessThan(0.2)
    applyMaterials(model, { mode: 'standard', overrides: ov, textureLook: null })
    expect(floor.material.roughness).toBe(0.3)
    expect(floor.material.metalness).toBe(0.4)
  })

  it('a surface set in the material editor beats the finish', () => {
    const { model, floor } = build()
    const ov = { [floor.uuid]: { slots: { 0: { roughness: 0.05, metalness: 1 } } } }
    applyMaterials(model, { mode: 'standard', overrides: ov, textureLook: resolveTextureLook({ ...presetLook('original'), finish: 'matte' }, 'object') })
    expect(floor.material.roughness).toBeCloseTo(0.05)
    expect(floor.material.metalness).toBe(1)
  })

  it('stacks with other colour overrides and does not drift when re-applied', () => {
    const { model, floor } = build()
    const ov = { [floor.uuid]: { color: '#00ff00' } }
    applyMaterials(model, { mode: 'standard', overrides: ov, textureLook: look('noir') })
    const first = floor.material
    applyMaterials(model, { mode: 'standard', overrides: ov, textureLook: look('noir') })
    expect(floor.material).toBe(first)
    expect('#' + first.color.getHexString()).toBe('#00ff00')
  })
})

describe('the store', () => {
  beforeEach(() => useStore.setState({ materialLook: { ...TEXTURE_LOOK_DEFAULT } }))

  it('starts as the original materials', () => {
    expect(useStore.getState().materialLook).toEqual(TEXTURE_LOOK_DEFAULT)
  })
  it('a preset sets its controls; touching a control by hand makes it "custom"', () => {
    useStore.getState().applyMaterialLookPreset('anime')
    expect(useStore.getState().materialLook.preset).toBe('anime')
    expect(useStore.getState().materialLook.detail).toBe('regions')
    useStore.getState().setMaterialLook({ bands: 3 })
    expect(useStore.getState().materialLook.preset).toBe('custom')
    expect(useStore.getState().materialLook.detail).toBe('regions') // the rest stays
  })
  it('Original after another preset is a clean reset, but keeps where it applies', () => {
    useStore.getState().setMaterialLook({ scope: 'objects' })
    useStore.getState().applyMaterialLookPreset('noir')
    useStore.getState().applyMaterialLookPreset('original')
    const l = useStore.getState().materialLook
    expect(isTextureLookActive(l)).toBe(false)
    expect(l.scope).toBe('objects')
  })
})

describe('the shader hook', () => {
  const sources = {
    standard: () => THREE.ShaderLib.standard.fragmentShader,
    toon: () => THREE.ShaderLib.toon.fragmentShader,
    basic: () => THREE.ShaderLib.basic.fragmentShader,
  }
  function compileText(mat, kind) {
    const shader = { uniforms: {}, fragmentShader: sources[kind](), vertexShader: '' }
    mat.onBeforeCompile(shader, {})
    return shader
  }

  it.each([['standard', 'standard'], ['toon', 'toon'], ['unlit', 'basic']])('patches the real %s shader (anchors exist) and adds its uniforms', (mode, kind) => {
    const { model, floor } = build()
    applyMaterials(model, { mode, textureLook: look('noir') })
    const shader = compileText(floor.material, kind)
    expect(shader.fragmentShader).toContain('tlGrade(')
    expect(shader.fragmentShader).toContain('textureGrad(')
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>') // replaced
    expect(Object.keys(shader.uniforms)).toEqual(expect.arrayContaining(['tlA', 'tlB', 'tlC', 'tlFlat']))
  })

  it('chains with Colour replace instead of replacing it', () => {
    const { model, floor } = build()
    const ov = { [floor.uuid]: { slots: { 0: { replace: { from: '#ff0000', to: '#0000ff', range: 0.4, softness: 0.4 } } } } }
    applyMaterials(model, { mode: 'toon', overrides: ov, textureLook: look('noir') })
    const shader = compileText(floor.material, 'toon')
    expect(shader.fragmentShader).toContain('tlGrade(')
    expect(shader.fragmentShader).toContain('rcApply(')
  })

  it('is installed once per material however often the look changes', () => {
    const { model, floor } = build()
    applyMaterials(model, { mode: 'toon', textureLook: look('noir') })
    const key = floor.material.customProgramCacheKey()
    applyMaterials(model, { mode: 'toon', textureLook: resolveTextureLook({ ...presetLook('original'), colour: 'vivid' }, 'object') })
    applyMaterials(model, { mode: 'toon', textureLook: resolveTextureLook({ ...presetLook('original'), colour: 'sepia' }, 'object') })
    expect(floor.material.customProgramCacheKey()).toBe(key) // same shader: changing the look only changes uniforms
    expect(uni(floor).tlB.value.y).toBe(1) // sepia now
    expect(uni(floor).tlB.value.x).toBe(0)
  })
})

describe('the material editor keeps priority', () => {
  it('its bump strength survives a look that keeps bumps, and is back after the look goes', () => {
    const { model, floor } = build()
    const ov = { [floor.uuid]: { slots: { 0: { roughness: 0.2, normalStrength: 0.4 } } } }
    applyMaterials(model, { mode: 'standard', overrides: ov, textureLook: look('noir') })
    expect(floor.material.normalScale.x).toBeCloseTo(0.4)
    applyMaterials(model, { mode: 'standard', overrides: ov, textureLook: plainFlat() })
    expect(floor.material.normalScale.x).toBe(0) // Flatten is the broader choice
    applyMaterials(model, { mode: 'standard', overrides: ov, textureLook: null })
    expect(floor.material.normalScale.x).toBeCloseTo(0.4)
    expect(floor.material.roughness).toBeCloseTo(0.2)
  })
})

describe('the presets as asked for', () => {
  const ids = TEXTURE_LOOK_PRESETS.map((p) => p.id)
  it('lays out three rows of four', () => {
    expect(ids.slice(0, 4)).toEqual(['original', 'flat', 'cel', 'anime']) // flat | cel | anime, left to right
    expect(ids.slice(4, 8)).toEqual(['toonsmooth', 'pixel', 'flatpixel', 'retro']) // Toon Smoothed left of the three pixel ones
    expect(ids.slice(8, 12)).toEqual(['clay', 'manga', 'noirink', 'noir']) // Clay left of Manga, both noir last
    expect(ids).toHaveLength(12)
    expect(new Set(ids).size).toBe(12)
  })
  it('Sepia and Pastel presets are gone; Pixel (chunky) and Manga replace them', () => {
    expect(ids).not.toContain('sepia')
    expect(ids).not.toContain('pastel')
    expect(presetLook('pixel').pixels).toBe(16) // "Chunky"
    expect(PIXEL_OPTIONS.find((o) => o.value === 16).label).toBe('Chunky')
    expect(presetLook('manga').colour).toBe('manga')
    // the colours themselves are still choosable by hand
    expect(COLOUR_OPTIONS.map((o) => o.value)).toEqual(expect.arrayContaining(['sepia', 'pastel', 'muted', 'clay', 'manga']))
  })
  it('Noir Ink uses 6 tones', () => {
    expect(presetLook('noirink').bands).toBe(6)
  })
  it('Toon Smoothed is the previous Anime (8 tones, 70%); Cel Paint is the same at 12 tones and full strength', () => {
    const { preset: _p, strength: toonStrength, ...toon } = presetLook('toonsmooth')
    const { preset: _c, strength: celStrength, ...cel } = presetLook('cel')
    expect(toon).toMatchObject({ detail: 'simplified', colour: 'vivid', bands: 8, pixels: 0, finish: 'matte', bumps: 'flatten' })
    expect(toonStrength).toBe(0.7)
    expect(cel).toEqual({ ...toon, bands: 12, contrast: 0.05, brightness: 0.05 }) // every setting the same except the tones...
    expect(celStrength).toBe(1) // ...at full strength
    expect(resolveTextureLook(presetLook('cel'), 'object').bands).toBe(12)
  })
  it('Simplified, Smoothed and Vivid are no longer presets, but are still choosable as controls', () => {
    const ids = TEXTURE_LOOK_PRESETS.map((p) => p.id)
    for (const gone of ['simplified', 'smoothed', 'vivid']) expect(ids).not.toContain(gone)
    expect(DETAIL_OPTIONS.map((d) => d.value)).toEqual(expect.arrayContaining(['smooth', 'simplified']))
    expect(COLOUR_OPTIONS.map((c) => c.value)).toContain('vivid')
    // asking for one that is gone just gives the original look
    expect(presetLook('simplified').preset).toBe('original')
  })
  it('Flat colour is the plain one-colour-per-surface version, not keep-shapes', () => {
    expect(presetLook('flat')).toMatchObject({ detail: 'flat', bumps: 'flatten' })
    expect(TEXTURE_LOOK_PRESETS.find((p) => p.id === 'flat').label).toBe('Flat colour')
    const r = resolveTextureLook(presetLook('flat'), 'object')
    expect(r.flat).toBe(1)
    expect(r.regions).toBe(0)
  })
  it('Flat Pixel is Pixel with flat colours that keep their shapes', () => {
    expect(presetLook('pixel')).toMatchObject({ pixels: 16, detail: 'full' })
    expect(presetLook('flatpixel')).toMatchObject({ pixels: 16, detail: 'regions' })
  })
  it('Clay is its own colour (one plain grey), separate from Muted, with no shine or relief', () => {
    const clay = resolveTextureLook(presetLook('clay'), 'object')
    expect(clay.clay).toBe(1)
    expect(clay.saturation).toBe(1) // not the "muted" colour
    expect(clay.flatten).toBe(true)
    expect(clay.finish).toEqual({ roughness: 1, metalness: 0 })
    expect(resolveTextureLook({ ...presetLook('original'), colour: 'muted' }, 'object').clay).toBe(0)
    expect(resolveTextureLook({ ...presetLook('original'), colour: 'muted' }, 'object').saturation).toBe(0.5)
  })
  it('every preset still works in every lighting mode', () => {
    for (const p of TEXTURE_LOOK_PRESETS.filter((x) => x.id !== 'original')) {
      for (const mode of ['unlit', 'toon', 'soft', 'standard', 'realistic']) {
        const { model, floor } = build()
        applyMaterials(model, { mode, textureLook: look(p.id) })
        expect(uni(floor).tlC.value.w).toBe(1)
      }
    }
  })
})

describe('Clay and Manga in the shader', () => {
  it('Clay switches on the plain-grey replacement; Manga the paper-and-pencil stage', () => {
    const { model, floor } = build()
    applyMaterials(model, { mode: 'toon', textureLook: look('clay') })
    expect(uni(floor).tlC.value.z).toBe(1)
    expect(uni(floor).tlD.value.x).toBe(0)
    applyMaterials(model, { mode: 'toon', textureLook: look('manga') })
    expect(uni(floor).tlC.value.z).toBe(0)
    expect(uni(floor).tlD.value.x).toBe(1)
    applyMaterials(model, { mode: 'toon', textureLook: look('noir') })
    expect(uni(floor).tlD.value.x).toBe(0)
  })

  it.each([['standard', 'standard'], ['toon', 'toon'], ['unlit', 'basic']])('manga hooks the final lit colour of the real %s shader', (mode, kind) => {
    const { model, floor } = build()
    applyMaterials(model, { mode, textureLook: look('manga') })
    const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib[kind].fragmentShader, vertexShader: '' }
    floor.material.onBeforeCompile(shader, {})
    expect(shader.fragmentShader).toContain('tlInk(')
    expect(shader.fragmentShader.indexOf('tlInk( gl_FragColor.rgb, tlD.x, tlD.w )')).toBeLessThan(shader.fragmentShader.indexOf('#include <tonemapping_fragment>'))
    expect(Object.keys(shader.uniforms)).toContain('tlD')
  })

  it('switching off clears both', () => {
    const { model, floor } = build()
    applyMaterials(model, { mode: 'toon', textureLook: look('manga') })
    applyMaterials(model, { mode: 'toon', textureLook: null })
    expect(uni(floor).tlD.value.x).toBe(0)
    expect(uni(floor).tlC.value.w).toBe(0)
  })
})
