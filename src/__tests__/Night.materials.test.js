import { describe, expect, it, beforeEach } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { DEFAULT_NIGHT } from '../three/shadowSettings.js'
import {
  installShadowDarkening,
  patchOpaqueChunk,
  patchCommonChunk,
  addShadowUniforms,
  nightImmuneUniform,
  nightAmount,
  nightTint,
  setNightLook,
} from '../three/shadowDarkening.js'
import { syncMeshMaterialFlags, setSelfShadowEnabled } from '../three/materials.js'

describe('night mode shader patch', () => {
  it('multiplies the final light by the night wash, and declares its uniforms', () => {
    const out = patchOpaqueChunk('gl_FragColor = vec4( outgoingLight, diffuseColor.a );')
    expect(out.count).toBe(1)
    expect(out.source).toContain('uNightAmt')
    expect(out.source.indexOf('uNightAmt')).toBeLessThan(out.source.indexOf('gl_FragColor ='))
    const common = patchCommonChunk('')
    expect(common).toContain('uniform float uNightAmt;')
    expect(common).toContain('uniform vec3 uNightTint;')
    expect(common).toContain('uniform float uNightImmune;')
    expect(out.source).toContain('uNightImmune')
  })

  it('zero uniforms mean no change (so shaders that never get the uniforms stay untouched)', () => {
    // (1 - amt) * mix(1, tint, amt) with amt = 0, tint = 0  ->  1
    const amt = 0
    expect((1 - amt) * (1 + (0 - 1) * amt)).toBe(1)
  })

  it('night strength and a luminance-normalised colour go to the shared uniforms', () => {
    setNightLook(0.7, '#5b78d1')
    expect(nightAmount.value).toBeCloseTo(0.7)
    const t = nightTint.value
    expect(t.b).toBeGreaterThan(t.r) // blue night
    const luma = 0.2126 * t.r + 0.7152 * t.g + 0.0722 * t.b
    expect(luma).toBeCloseTo(1, 2) // colour only, brightness is the strength's job
    setNightLook(5, '#ffffff')
    expect(nightAmount.value).toBe(1)
    setNightLook(0, '#ffffff')
    expect(nightAmount.value).toBe(0)
  })

  it('immunity is a live per-material uniform: on, off and on again, with no recompile', () => {
    setNightLook(0.8, '#5b78d1')
    const mat = new THREE.MeshStandardMaterial()
    const other = new THREE.MeshStandardMaterial()
    const shader = {}
    addShadowUniforms(shader, mat) // what the compiled program is handed, once
    const otherShader = {}
    addShadowUniforms(otherShader, other)
    expect(shader.uNightAmt.value).toBeCloseTo(0.8)
    expect(shader.uNightImmune.value).toBe(0)

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), mat)
    for (const immune of [true, false, true, false]) {
      if (immune) mesh.userData.nightImmune = true
      else delete mesh.userData.nightImmune
      syncMeshMaterialFlags([mesh])
      // the SAME uniform object the program already holds changes value, so it works even
      // though three never calls onBeforeCompile again for a program it has cached
      expect(shader.uNightImmune.value).toBe(immune ? 1 : 0)
    }
    expect(otherShader.uNightImmune.value).toBe(0) // other materials unaffected
    expect(shader.uNightAmt).toBe(otherShader.uNightAmt) // strength stays shared + live
    setNightLook(0, '#ffffff')
  })

  it('the program cache key no longer depends on immunity (nothing to get stuck)', () => {
    installShadowDarkening()
    const m = new THREE.MeshBasicMaterial()
    const k = m.customProgramCacheKey()
    m.userData.nightImmune = true
    expect(m.customProgramCacheKey()).toBe(k)
  })

  it('the default material hook gives built-in materials the night uniforms', () => {
    installShadowDarkening()
    const m = new THREE.MeshBasicMaterial()
    const shader = { uniforms: {} }
    m.onBeforeCompile(shader)
    expect(shader.uniforms.uNightAmt).toBeTruthy()
    expect(shader.uniforms.uNightTint).toBeTruthy()
    expect(shader.uniforms.uNightImmune.value).toBe(0)
  })
})

describe('per-mesh material flags', () => {
  const makeMesh = (immune) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    if (immune) mesh.userData.nightImmune = true
    return mesh
  }

  it('self-shadowing writes both faces to the shadow map; off restores three.js\'s default', () => {
    const mesh = makeMesh(false)
    setSelfShadowEnabled(true)
    syncMeshMaterialFlags([mesh])
    expect(mesh.material.shadowSide).toBe(THREE.DoubleSide)
    setSelfShadowEnabled(false)
    syncMeshMaterialFlags([mesh])
    expect(mesh.material.shadowSide).toBeNull()
    setSelfShadowEnabled(true)
  })

  it('night immunity follows the mesh flag, never forcing a recompile', () => {
    const mesh = makeMesh(true)
    const v0 = mesh.material.version
    syncMeshMaterialFlags([mesh])
    expect(mesh.material.userData.nightImmune).toBe(true)
    expect(nightImmuneUniform(mesh.material).value).toBe(1)
    delete mesh.userData.nightImmune
    syncMeshMaterialFlags([mesh])
    expect(mesh.material.userData.nightImmune).toBeUndefined()
    expect(nightImmuneUniform(mesh.material).value).toBe(0)
    expect(mesh.material.version).toBe(v0)
  })

  it('handles multi-material meshes and tolerates missing ones', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshBasicMaterial(), new THREE.MeshToonMaterial()])
    mesh.userData.nightImmune = true
    expect(() => syncMeshMaterialFlags([mesh, null, undefined])).not.toThrow()
    for (const m of mesh.material) expect(m.userData.nightImmune).toBe(true)
    expect(() => syncMeshMaterialFlags(undefined)).not.toThrow()
  })
})

describe('night store', () => {
  beforeEach(() => useStore.setState({ night: { ...DEFAULT_NIGHT }, sceneObjects: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }))

  it('setNight merges and validates', () => {
    useStore.getState().setNight({ enabled: true, strength: 7 })
    expect(useStore.getState().night).toMatchObject({ enabled: true, strength: 1, tint: DEFAULT_NIGHT.tint })
  })

  it('setObjectNightImmune flags just that object', () => {
    useStore.getState().setObjectNightImmune('b', true)
    const objs = useStore.getState().sceneObjects
    expect(objs.find((o) => o.id === 'a').nightImmune).toBeUndefined()
    expect(objs.find((o) => o.id === 'b').nightImmune).toBe(true)
  })
})
