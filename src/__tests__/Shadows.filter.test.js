import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  patchShadowmapChunk,
  patchOpaqueChunk,
  patchCommonChunk,
  installShadowDarkening,
  revertShadowFilter,
  installShadowFilter,
  isShadowFilterInstalled,
  shadowFilterKey,
  addShadowUniforms,
  setShadowTint,
  shadowTint,
  shadowFilterA,
  shadowFilterB,
} from '../three/shadowDarkening.js'
import {
  SHADOW_QUALITY,
  resolveShadowQuality,
  computeShadowFilter,
  chooseShadowMapSize,
  lightTanFromSize,
  MIN_BLUR_TEXELS,
} from '../three/shadowSettings.js'
import { useStore } from '../store.js'

describe('shadow filter shader patch', () => {
  it('replaces only the PCF branch of getShadow with the new filter', () => {
    const stock = THREE.ShaderChunk.shadowmap_pars_fragment
    const base = isShadowFilterInstalled() ? null : stock
    const { source, count } = patchShadowmapChunk(base || originalChunk())
    expect(count).toBe(1)
    expect(source).toContain('float dsFilteredShadow(')
    expect(source).toContain('shadow = dsFilteredShadow( shadowMap, shadowMapSize, shadowRadius, shadowCoord.xyz );')
    // the stock PCF lattice is gone from getShadow, and the other filter types are untouched
    expect(source).not.toContain('* ( 1.0 / 17.0 )')
    expect(source).toContain('SHADOWMAP_TYPE_PCF_SOFT')
    expect(source).toContain('SHADOWMAP_TYPE_VSM')
    expect(source).toContain('float getPointShadow')
  })

  it('does nothing if three changes the chunk shape', () => {
    expect(patchShadowmapChunk('void main() {}')).toEqual({ source: 'void main() {}', count: 0 })
  })

  it('declares the uniforms it reads, and the tint reaches the opaque patch', () => {
    const { source } = patchShadowmapChunk(originalChunk())
    expect(source).toContain('uniform vec4 uShadowFilterA;')
    expect(source).toContain('uniform vec4 uShadowFilterB;')
    expect(patchCommonChunk('')).toContain('uniform vec3 uShadowTint;')
    const opaque = patchOpaqueChunk('gl_FragColor = vec4( outgoingLight, diffuseColor.a );')
    expect(opaque.count).toBe(1)
    expect(opaque.source).toContain('uShadowTint')
  })

  it('every shader gets the shared uniforms', () => {
    const uniforms = {}
    addShadowUniforms(uniforms)
    expect(Object.keys(uniforms).sort()).toEqual(['uNightAmt', 'uNightImmune', 'uNightTint', 'uShadowDarkness', 'uShadowFilterA', 'uShadowFilterB', 'uShadowTint'])
    expect(uniforms.uShadowFilterA).toBe(shadowFilterA)
    expect(uniforms.uShadowFilterB).toBe(shadowFilterB)
  })

  it('can fall back to the stock filter, with a new program cache key so materials recompile', () => {
    installShadowDarkening()
    expect(isShadowFilterInstalled()).toBe(true)
    const keyBefore = shadowFilterKey()
    expect(THREE.ShaderChunk.shadowmap_pars_fragment).toContain('dsFilteredShadow')
    expect(revertShadowFilter()).toBe(true)
    expect(THREE.ShaderChunk.shadowmap_pars_fragment).not.toContain('dsFilteredShadow')
    expect(shadowFilterKey()).not.toBe(keyBefore)
    expect(new THREE.MeshStandardMaterial().customProgramCacheKey()).toContain(shadowFilterKey())
    expect(revertShadowFilter()).toBe(false) // already reverted: no loop
    expect(installShadowFilter()).toBe(true) // and it can be switched back on
    expect(THREE.ShaderChunk.shadowmap_pars_fragment).toContain('dsFilteredShadow')
  })
})

// The pristine three chunk (the module keeps it internally once patched).
function originalChunk() {
  const current = THREE.ShaderChunk.shadowmap_pars_fragment
  if (!current.includes('dsFilteredShadow')) return current
  // Undo the patch textually: drop the inserted filter and restore the PCF call site.
  return current
    .slice(0, current.indexOf('\tuniform vec4 uShadowFilterA;'))
    + current.slice(current.indexOf('\tfloat getShadow( sampler2D shadowMap,'))
      .replace(
        /shadow = dsFilteredShadow\([^;]*;/,
        'shadow = ( texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z ) ) * ( 1.0 / 17.0 );',
      )
}

describe('shadow quality', () => {
  it('has a blob option plus four real levels that get strictly better', () => {
    expect(SHADOW_QUALITY.map((q) => q.id)).toEqual(['blob', 'low', 'medium', 'high', 'ultra'])
    const real = SHADOW_QUALITY.filter((q) => q.id !== 'blob')
    for (let i = 1; i < real.length; i++) {
      expect(real[i].mapSize).toBeGreaterThan(real[i - 1].mapSize)
      expect(real[i].taps).toBeGreaterThan(real[i - 1].taps)
      expect(real[i].maxBlur).toBeGreaterThan(real[i - 1].maxBlur)
    }
  })

  it('defaults to High (4096) and clamps to what the GPU can do', () => {
    expect(useStore.getState().shadows.quality).toBe('high')
    expect(resolveShadowQuality('high').mapSize).toBe(4096)
    expect(resolveShadowQuality('ultra', { maxTextureSize: 4096 }).mapSize).toBe(4096)
    expect(resolveShadowQuality('nonsense').id).toBe('high')
  })

  it('performance mode always uses the lightest real level, and never turns the blob into a map', () => {
    expect(resolveShadowQuality('ultra', { performance: true })).toMatchObject({ id: 'low', mapSize: 1024, taps: 8 })
    expect(resolveShadowQuality('blob', { performance: true })).toMatchObject({ id: 'blob', blob: true, mapSize: 0 })
  })
})

describe('computeShadowFilter', () => {
  const base = { mapSize: 4096, taps: 28, maxBlurCap: 48, half: 6, depthRange: 40, modelRadius: 2 }

  it('contact-hardening: negative radius whose magnitude is tan of the light\'s angular radius', () => {
    const a = computeShadowFilter({ ...base, contact: true, size: 1 })
    const b = computeShadowFilter({ ...base, contact: true, size: 6 })
    const c = computeShadowFilter({ ...base, contact: true, size: 20 })
    for (const f of [a, b, c]) expect(f.radius).toBeLessThan(0)
    expect(-a.radius).toBeCloseTo(lightTanFromSize(1), 8)
    expect(-b.radius).toBeGreaterThan(-a.radius)
    expect(-c.radius).toBeGreaterThan(-b.radius)
  })

  it('a zero-size light is a plain hard shadow (anti-aliasing only), not a blocker search', () => {
    expect(computeShadowFilter({ ...base, contact: true, size: 0 }).radius).toBe(0)
    expect(computeShadowFilter({ ...base, contact: false, size: 0 }).radius).toBe(0)
  })

  it('even blur: non-negative radius that grows with size and respects the quality cap', () => {
    const soft = computeShadowFilter({ ...base, contact: false, size: 30 })
    expect(soft.radius).toBeGreaterThan(0)
    expect(soft.radius).toBeLessThanOrEqual(48)
    expect(computeShadowFilter({ ...base, contact: false, size: 5 }).radius).toBeLessThan(
      computeShadowFilter({ ...base, contact: false, size: 10 }).radius,
    )
  })

  it('an even blur keeps the same WORLD width when the map resolution changes', () => {
    const lo = computeShadowFilter({ ...base, mapSize: 2048, contact: false, size: 6 })
    const hi = computeShadowFilter({ ...base, mapSize: 4096, contact: false, size: 6 })
    const world = (f, size) => f.radius * ((2 * base.half) / size)
    expect(world(hi, 4096)).toBeCloseTo(world(lo, 2048), 5)
  })

  it('fills the uniforms: taps, texel size, depth range, anti-aliasing floor, blur limit', () => {
    const f = computeShadowFilter({ ...base, contact: true, size: 3 })
    expect(f.a[0]).toBe(28)
    expect(f.a[1]).toBeCloseTo((2 * 6) / 4096, 8)
    expect(f.a[2]).toBe(40)
    expect(f.a[3]).toBe(MIN_BLUR_TEXELS)
    expect(f.b[0]).toBeGreaterThanOrEqual(2)
    expect(f.b[0]).toBeLessThanOrEqual(48)
  })

  it('the blur limit comes from the quality, so better quality can search wider', () => {
    const lowQ = computeShadowFilter({ ...base, maxBlurCap: 20, contact: true, size: 25 })
    const ultra = computeShadowFilter({ ...base, maxBlurCap: 64, mapSize: 8192, contact: true, size: 25 })
    expect(lowQ.b[0]).toBeLessThanOrEqual(20)
    expect(ultra.b[0]).toBeGreaterThan(lowQ.b[0])
  })

  it('falls back to a plain positive blur when the custom shader filter is unavailable', () => {
    const f = computeShadowFilter({ ...base, contact: true, size: 6, advanced: false })
    expect(f.radius).toBeGreaterThanOrEqual(1)
  })

  it('survives odd input without NaN', () => {
    const f = computeShadowFilter({ contact: true, size: NaN, mapSize: 0, taps: 0, half: 0, depthRange: 0, modelRadius: 0 })
    for (const n of [f.radius, ...f.a, ...f.b]) expect(Number.isFinite(n)).toBe(true)
  })
})

describe('chooseShadowMapSize', () => {
  const base = { qualityMapSize: 4096, contact: true, half: 3, modelRadius: 2, maxBlurCap: 48 }

  it('keeps the full map for small lights', () => {
    expect(chooseShadowMapSize({ ...base, size: 0 })).toBe(4096)
    expect(chooseShadowMapSize({ ...base, size: 0.5 })).toBe(4096)
  })

  it('uses a smaller map for big soft lights so the blur is never cut short, in steps of 256', () => {
    const big = chooseShadowMapSize({ ...base, size: 15 })
    expect(big).toBeLessThan(4096)
    expect(big % 256).toBe(0)
    // the widest penumbra we want must fit inside the blur cap at that map size
    const texelWorld = (2 * base.half) / big
    const widest = lightTanFromSize(15) * base.modelRadius * 1.5
    expect(widest / texelWorld).toBeLessThanOrEqual(48 + 1e-6)
    expect(chooseShadowMapSize({ ...base, size: 30 })).toBeLessThanOrEqual(big)
  })

  it('never goes below 512 (or the quality\'s own size) and never above the quality', () => {
    expect(chooseShadowMapSize({ ...base, size: 30, half: 0.1 })).toBe(512)
    expect(chooseShadowMapSize({ ...base, qualityMapSize: 1024, size: 30 })).toBeGreaterThanOrEqual(512)
    expect(chooseShadowMapSize({ ...base, qualityMapSize: 1024, size: 0 })).toBe(1024)
    expect(chooseShadowMapSize({ ...base, qualityMapSize: 256, size: 30 })).toBe(256)
    expect(chooseShadowMapSize({ ...base, qualityMapSize: 0, size: 3 })).toBe(0)
  })
})

describe('shadow colour', () => {
  it('white is neutral', () => {
    setShadowTint('#ffffff')
    expect(shadowTint.value.r).toBeCloseTo(1, 5)
    expect(shadowTint.value.g).toBeCloseTo(1, 5)
    expect(shadowTint.value.b).toBeCloseTo(1, 5)
  })

  it('a colour shifts hue but keeps the same brightness as white', () => {
    setShadowTint('#5a6cff')
    const { r, g, b } = shadowTint.value
    expect(b).toBeGreaterThan(r)
    expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeCloseTo(1, 4)
    expect(Math.max(r, g, b)).toBeLessThanOrEqual(2.0001) // very saturated colours can't blow out
    setShadowTint('#ffffff')
  })

  it('black or garbage falls back to neutral instead of dividing by zero', () => {
    setShadowTint('#000000')
    expect(shadowTint.value.r).toBe(1)
    setShadowTint(undefined)
    expect(shadowTint.value.g).toBeCloseTo(1, 5)
  })
})
