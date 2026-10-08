import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  installShadowDarkening,
  patchLightsChunk,
  patchOpaqueChunk,
  patchCommonChunk,
  shadowDarkness,
  setShadowDarkness,
} from '../three/shadowDarkening.js'

describe('shadow darkening shader patch', () => {
  it('patches every shadow-casting light type in three\'s lighting chunk', () => {
    const { source, count } = patchLightsChunk(THREE.ShaderChunk.lights_fragment_begin)
    expect(count).toBe(3) // directional, spot and point
    expect(source.match(/dsShadowMin = min/g)).toHaveLength(3)
    // original behaviour is preserved: the light is still multiplied by its shadow factor
    expect(source.match(/directLight\.color \*= dsShadow;/g)).toHaveLength(3)
    expect(source).not.toMatch(/directLight\.color \*= \( directLight\.visible && receiveShadow \) \?/)
  })

  it('applies the darkening to the final colour, and declares what it uses in every material', () => {
    const opaque = patchOpaqueChunk(THREE.ShaderChunk.opaque_fragment)
    expect(opaque.count).toBe(1)
    expect(opaque.source).toContain('outgoingLight *= 1.0 - uShadowDarkness * ( 1.0 - dsShadowMin );')
    expect(opaque.source.indexOf('outgoingLight *=')).toBeLessThan(opaque.source.indexOf('gl_FragColor'))
    const common = patchCommonChunk('// common')
    expect(common).toContain('uniform float uShadowDarkness;')
    expect(common).toContain('float dsShadowMin = 1.0;')
  })

  it('does nothing (rather than breaking shaders) if a chunk no longer matches', () => {
    expect(patchLightsChunk('void main() {}').count).toBe(0)
    expect(patchOpaqueChunk('void main() {}')).toEqual({ source: 'void main() {}', count: 0 })
  })

  it('installs against the real three.js chunks, once, and gives built-in materials the shared uniform', () => {
    expect(installShadowDarkening()).toBe(true)
    expect(installShadowDarkening()).toBe(true) // idempotent: no double patching
    expect(THREE.ShaderChunk.lights_fragment_begin.match(/dsShadowMin = min/g)).toHaveLength(3)
    expect(THREE.ShaderChunk.common.match(/uniform float uShadowDarkness;/g)).toHaveLength(1)

    const shader = { uniforms: {} }
    new THREE.MeshStandardMaterial().onBeforeCompile(shader)
    expect(shader.uniforms.uShadowDarkness).toBe(shadowDarkness)
  })

  it('the darkness value is clamped to 0..1 and shared by reference', () => {
    setShadowDarkness(0.45)
    expect(shadowDarkness.value).toBe(0.45)
    setShadowDarkness(7)
    expect(shadowDarkness.value).toBe(1)
    setShadowDarkness(-1)
    expect(shadowDarkness.value).toBe(0)
    setShadowDarkness(undefined)
    expect(shadowDarkness.value).toBe(0)
  })
})
