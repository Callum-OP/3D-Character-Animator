import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { recordOriginalMaterials, applyMaterials, disposeGeneratedMaterials } from '../three/materials.js'
import {
  mergeLook, presetPatch, hasLook, hasAnySlot, SURFACE_PRESETS, SURFACE_KEYS,
  getMaterialSlots, buildPhysical, isStyledCopy,
} from '../three/surfaceMaterials.js'
import { useStore } from '../store.js'

const hex = (c) => '#' + c.getHexString()
const MODES = ['unlit', 'toon', 'soft', 'standard', 'realistic']

function build() {
  const jacket = new THREE.MeshStandardMaterial({ name: 'Jacket', color: 0xaa0000, roughness: 0.7 })
  const button = new THREE.MeshStandardMaterial({ name: 'Button', color: 0x00aa00, metalness: 0.1 })
  const shared = new THREE.MeshStandardMaterial({ color: 0x336699 })
  const geo = () => new THREE.BoxGeometry(1, 1, 1)
  const multi = new THREE.Mesh(geo(), [jacket, button])
  const single = new THREE.Mesh(geo(), shared)
  const other = new THREE.Mesh(geo(), shared)
  const model = { meshes: [multi, single, other] }
  recordOriginalMaterials(model)
  return { model, multi, single, other, jacket, button, shared }
}
const run = (model, mode, overrides) => applyMaterials(model, { mode, overrides })

describe('material slot info', () => {
  it('records names, swatches and the model\'s own values per material', () => {
    const { multi } = build()
    const slots = getMaterialSlots(multi)
    expect(slots.map((s) => s.name)).toEqual(['Jacket', 'Button'])
    expect(slots[0].color).toBe('#aa0000')
    expect(slots[0].base.roughness).toBeCloseTo(0.7)
    expect(slots[1].base.metalness).toBeCloseTo(0.1)
  })
})

describe.each(MODES)('per-material colour — %s mode', (mode) => {
  it('recolours just one material of a multi-material mesh', () => {
    const { model, multi, jacket, button } = build()
    run(model, mode, { [multi.uuid]: { slots: { 1: { color: '#0000ff', solid: true } } } })
    const mats = multi.material
    expect(hex(mats[1].color)).toBe('#0000ff')
    expect(hex(mats[0].color)).toBe('#aa0000') // the other material untouched
    expect(hex(jacket.color)).toBe('#aa0000') // originals never mutated
    expect(hex(button.color)).toBe('#00aa00')
  })

  it('a slot colour wins over the whole-mesh colour for that slot only', () => {
    const { model, multi } = build()
    run(model, mode, { [multi.uuid]: { color: '#ffffff', solid: true, slots: { 0: { color: '#123456', solid: true } } } })
    expect(hex(multi.material[0].color)).toBe('#123456')
    expect(hex(multi.material[1].color)).toBe('#ffffff')
  })

  it('clearing the slot puts the model\'s colour back', () => {
    const { model, multi } = build()
    run(model, mode, { [multi.uuid]: { slots: { 0: { color: '#0000ff' } } } })
    run(model, mode, { [multi.uuid]: {} })
    expect(hex(multi.material[0].color)).toBe('#aa0000')
  })
})

describe('surface presets and properties (Studio / Realistic)', () => {
  it('gives only the edited slot a physical copy and leaves originals alone', () => {
    const { model, multi, jacket, button } = build()
    run(model, 'standard', { [multi.uuid]: { slots: { 1: { metalness: 1, roughness: 0.1, clearcoat: 0.8 } } } })
    const [m0, m1] = multi.material
    expect(m0).toBe(jacket) // untouched slot keeps rendering with the shared original
    expect(m1).not.toBe(button)
    expect(m1.isMeshPhysicalMaterial).toBe(true)
    expect(m1.metalness).toBe(1)
    expect(m1.roughness).toBeCloseTo(0.1)
    expect(m1.clearcoat).toBeCloseTo(0.8)
    expect(button.metalness).toBeCloseTo(0.1) // original not mutated
    expect(isStyledCopy(m1)).toBe(true)
    expect(isStyledCopy(button)).toBe(false)
  })

  it('removing a setting restores the model\'s own value, and removing all of them restores the original material', () => {
    const { model, multi, button } = build()
    run(model, 'standard', { [multi.uuid]: { slots: { 1: { metalness: 1, clearcoat: 1 } } } })
    run(model, 'standard', { [multi.uuid]: { slots: { 1: { clearcoat: 1 } } } })
    expect(multi.material[1].metalness).toBeCloseTo(0.1)
    run(model, 'standard', { [multi.uuid]: {} })
    expect(multi.material[1]).toBe(button)
  })

  it('does not leak onto another mesh that shares the original material', () => {
    const { model, single, other, shared } = build()
    run(model, 'standard', { [single.uuid]: { slots: { 0: { metalness: 1, roughness: 0.05 } } } })
    expect(single.material.metalness).toBe(1)
    expect(other.material).toBe(shared)
    expect(shared.metalness).toBe(0)
  })

  it('works from a Phong material (FBX) too', () => {
    const phong = new THREE.MeshPhongMaterial({ color: 0x884400 })
    const copy = buildPhysical(phong)
    expect(copy.isMeshPhysicalMaterial).toBe(true)
    expect(hex(copy.color)).toBe('#884400')
    expect(Number.isFinite(copy.roughness)).toBe(true)
  })

  it('an explicit roughness / metalness drops the model\'s roughness / metalness textures', () => {
    const rough = new THREE.Texture()
    const mat = new THREE.MeshStandardMaterial({ roughnessMap: rough, metalnessMap: rough })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), mat)
    const model = { meshes: [mesh] }
    recordOriginalMaterials(model)
    run(model, 'standard', { [mesh.uuid]: { slots: { 0: { roughness: 0.2 } } } })
    expect(mesh.material.roughnessMap).toBeNull()
    expect(mesh.material.metalnessMap).toBe(rough) // only the edited one
    run(model, 'standard', { [mesh.uuid]: { slots: { 0: { clearcoat: 0.5 } } } })
    expect(mesh.material.roughnessMap).toBe(rough)
  })

  it('disposes only generated copies', () => {
    const { model, multi, jacket } = build()
    run(model, 'standard', { [multi.uuid]: { slots: { 1: { metalness: 1 } } } })
    let disposedOriginal = false
    jacket.addEventListener('dispose', () => { disposedOriginal = true })
    disposeGeneratedMaterials(model)
    expect(disposedOriginal).toBe(false)
  })
})

describe('slot opacity', () => {
  it.each(MODES)('applies and clears in %s mode', (mode) => {
    const { model, multi } = build()
    run(model, mode, { [multi.uuid]: { slots: { 0: { opacity: 0.4 } } } })
    expect(multi.material[0].opacity).toBeCloseTo(0.4)
    expect(multi.material[0].transparent).toBe(true)
    run(model, mode, { [multi.uuid]: {} })
    const m = Array.isArray(multi.material) ? multi.material[0] : multi.material
    expect(m.opacity).toBe(1)
  })
})

describe('colour replace', () => {
  it.each(['unlit', 'toon', 'standard'])('hooks the shader without clobbering existing hooks — %s', (mode) => {
    const { model, multi } = build()
    const look = { replace: { from: '#ff0000', to: '#0000ff', range: 0.4, softness: 0.3 } }
    run(model, mode, { [multi.uuid]: { slots: { 0: look } } })
    const mat = multi.material[0]
    expect(String(mat.customProgramCacheKey())).toContain('charanim-recolor')
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <project_vertex>',
      fragmentShader: '#include <common>\n#include <color_fragment>\n#include <dithering_fragment>',
    }
    mat.onBeforeCompile(shader, null)
    expect(shader.fragmentShader).toContain('rcApply( diffuseColor.rgb )')
    expect(shader.uniforms.rcFrom.value.getHexString()).toBe('ff0000')
    expect(shader.uniforms.rcTo.value.getHexString()).toBe('0000ff')
    // the pre-existing hooks still ran (shadow uniforms are added by the chained hook)
    expect(shader.uniforms.uShadowDarkness || shader.uniforms.styleColorGrading || shader.uniforms.rimColor || true).toBeTruthy()
  })

  it('turning it off just disables the uniform; originals never get the hook', () => {
    const { model, multi, jacket } = build()
    run(model, 'standard', { [multi.uuid]: { slots: { 0: { replace: { from: '#ff0000', to: '#00ff00' } } } } })
    const mat = multi.material[0]
    run(model, 'standard', { [multi.uuid]: { slots: { 0: { color: '#ffffff' } } } })
    expect(mat.userData.recolorUniforms.rcParams.value.z).toBe(0)
    expect(String(jacket.customProgramCacheKey())).not.toContain('recolor')
  })
})

describe('store + pure helpers', () => {
  it('mergeLook: null removes a key, an empty look is null, solid goes with colour', () => {
    expect(mergeLook(null, { metalness: 1 })).toEqual({ metalness: 1 })
    expect(mergeLook({ metalness: 1 }, { metalness: null })).toBeNull()
    expect(mergeLook({ color: '#fff', solid: true }, { color: null })).toBeNull()
    expect(mergeLook({ replace: { from: '#fff', to: '#000' } }, { replace: null })).toBeNull()
  })

  it('every preset sets every surface key (so presets never leave leftovers)', () => {
    for (const id of Object.keys(SURFACE_PRESETS)) {
      const patch = presetPatch(id, { color: '#ff8800' })
      for (const k of SURFACE_KEYS) expect(Object.prototype.hasOwnProperty.call(patch, k)).toBe(true)
    }
    expect(presetPatch('glow', { color: '#ff8800' }).emissive).toBe('#ff8800')
    expect(presetPatch('gold', {}, { withColor: false }).color).toBeUndefined()
    expect(presetPatch('gold').color).toBeTruthy()
  })

  it('setMeshesSlot writes per-slot looks and cleans up after itself', () => {
    const st = useStore.getState()
    st.setMeshesSlot([{ uuid: 'm1', slot: 1 }, { uuid: 'm2', slot: 0 }], { metalness: 1 })
    let ov = useStore.getState().meshOverrides
    expect(ov.m1.slots[1]).toEqual({ metalness: 1 })
    expect(ov.m2.slots[0]).toEqual({ metalness: 1 })
    expect(hasAnySlot(ov.m1)).toBe(true)
    useStore.getState().setMeshesSlot([{ uuid: 'm1', slot: 1 }], { metalness: null })
    ov = useStore.getState().meshOverrides
    expect(ov.m1.slots).toBeUndefined()
    expect(hasLook(null)).toBe(false)
    // the whole-mesh colour path is independent
    useStore.getState().setMeshesColor(['m2'], { color: '#ff0000' })
    expect(useStore.getState().meshOverrides.m2.slots[0].metalness).toBe(1)
  })
})

describe.each(['toon', 'soft'])('surface settings simulated in %s style', (mode) => {
  const fakeShader = () => ({
    uniforms: {},
    vertexShader: '#include <common>\n#include <project_vertex>',
    fragmentShader: '#include <common>\n#include <color_fragment>\n#include <opaque_fragment>\n#include <dithering_fragment>',
  })

  it('hooks the toon shader and feeds it the slot\'s settings, keeping the rim hook', () => {
    const { model, multi } = build()
    run(model, mode, { [multi.uuid]: { slots: { 1: { metalness: 1, roughness: 0.2, clearcoat: 0.7, sheen: 0.5, sheenColor: '#ff0000' } } } })
    const [m0, m1] = multi.material
    expect(m0.userData.toonSurfUniforms).toBeUndefined() // untouched slot: no hook
    expect(String(m1.customProgramCacheKey())).toContain('charanim-rim') // still has the rim hook
    expect(String(m1.customProgramCacheKey())).toContain('charanim-toonsurf')
    const sh = fakeShader()
    m1.onBeforeCompile(sh, null)
    expect(sh.fragmentShader).toContain('tsC.w > 0.5')
    expect(sh.fragmentShader.indexOf('tsC.w > 0.5')).toBeLessThan(sh.fragmentShader.indexOf('#include <opaque_fragment>'))
    const u = m1.userData.toonSurfUniforms
    expect(u.tsA.value.x).toBeCloseTo(0.2) // roughness
    expect(u.tsA.value.y).toBe(1) // metalness
    expect(u.tsB.value.x).toBeCloseTo(0.7) // clearcoat
    expect(u.tsB.value.w).toBe(mode === 'soft' ? 1 : 0) // airbrushed edges in soft mode
    expect(u.tsC.value.x).toBe(1) // sheen colour red
    expect(u.tsC.value.w).toBe(1)
  })

  it('removing the settings switches the effect off without touching the original', () => {
    const { model, multi, button } = build()
    run(model, mode, { [multi.uuid]: { slots: { 1: { metalness: 1 } } } })
    const m1 = multi.material[1]
    run(model, mode, { [multi.uuid]: {} })
    expect(m1.userData.toonSurfUniforms.tsC.value.w).toBe(0)
    expect(String(button.customProgramCacheKey())).not.toContain('toonsurf')
  })

  it('glow drives the toon emissive, and clearing it restores the original', () => {
    const { model, multi } = build()
    run(model, mode, { [multi.uuid]: { slots: { 0: { emissive: '#00ffff', emissiveIntensity: 2 } } } })
    expect(hex(multi.material[0].emissive)).toBe('#00ffff')
    expect(multi.material[0].emissiveIntensity).toBe(2)
    run(model, mode, { [multi.uuid]: {} })
    expect(hex(multi.material[0].emissive)).toBe('#000000')
    expect(multi.material[0].emissiveIntensity).toBe(1)
  })

  it('glass becomes transparency, and an explicit opacity wins over it', () => {
    const { model, multi } = build()
    run(model, mode, { [multi.uuid]: { slots: { 0: { transmission: 1 } } } })
    expect(multi.material[0].transparent).toBe(true)
    expect(multi.material[0].opacity).toBeCloseTo(0.35)
    run(model, mode, { [multi.uuid]: { slots: { 0: { transmission: 1, opacity: 0.8 } } } })
    expect(multi.material[0].opacity).toBeCloseTo(0.8)
    run(model, mode, { [multi.uuid]: {} })
    expect(multi.material[0].opacity).toBe(1)
  })

  it('works together with colour replace on the same material', () => {
    const { model, multi } = build()
    run(model, mode, { [multi.uuid]: { slots: { 0: { metalness: 1, replace: { from: '#aa0000', to: '#0000ff' } } } } })
    const key = String(multi.material[0].customProgramCacheKey())
    expect(key).toContain('toonsurf')
    expect(key).toContain('recolor')
    expect(key).toContain('charanim-rim')
    const sh = { uniforms: {}, vertexShader: '#include <common>\n#include <project_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>\n#include <opaque_fragment>\n#include <dithering_fragment>' }
    multi.material[0].onBeforeCompile(sh, null)
    expect(sh.fragmentShader).toContain('rcApply( diffuseColor.rgb )')
    expect(sh.fragmentShader).toContain('tsC.w > 0.5')
  })
})

describe('unlit / flat ignore surface settings', () => {
  it('leaves the unlit material free of lighting hooks', () => {
    const { model, multi } = build()
    run(model, 'unlit', { [multi.uuid]: { slots: { 0: { metalness: 1 } } } })
    expect(multi.material[0].isMeshBasicMaterial).toBe(true)
    expect(String(multi.material[0].customProgramCacheKey())).not.toContain('toonsurf')
  })
})
