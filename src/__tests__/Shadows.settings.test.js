import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHADOWS,
  normalizeShadows,
  shadowsFromLegacy,
  shadowsFromProject,
  lightTanFromSize,
  DEFAULT_NIGHT,
  normalizeNight,
  SHADOW_STYLES,
  PRESET_SHADOW_STYLE,
} from '../three/shadowSettings.js'

describe('normalizeShadows', () => {
  it('gives the realistic default for nothing / junk', () => {
    expect(normalizeShadows(undefined)).toEqual(DEFAULT_SHADOWS)
    expect(normalizeShadows(null)).toEqual(DEFAULT_SHADOWS)
    expect(normalizeShadows('x')).toEqual(DEFAULT_SHADOWS)
    expect(normalizeShadows({})).toEqual(DEFAULT_SHADOWS)
  })

  it('realistic, contact-hardening shadows at High quality are the default', () => {
    expect(DEFAULT_SHADOWS).toMatchObject({ enabled: true, quality: 'high', contact: true })
    expect(DEFAULT_SHADOWS.size).toBeGreaterThan(0)
    expect(DEFAULT_SHADOWS.darkness).toBeGreaterThan(0.3)
  })

  it('clamps and repairs every field independently', () => {
    expect(normalizeShadows({ size: -5, darkness: 7 })).toMatchObject({ size: 0, darkness: 1 })
    expect(normalizeShadows({ size: NaN, darkness: Infinity })).toMatchObject({ size: DEFAULT_SHADOWS.size, darkness: DEFAULT_SHADOWS.darkness })
    expect(normalizeShadows({ quality: 'blob' }).quality).toBe('blob')
    expect(normalizeShadows({ quality: 'nope' }).quality).toBe('high')
    expect(normalizeShadows({ tint: '#ABCDEF' }).tint).toBe('#abcdef')
    expect(normalizeShadows({ tint: 'red' }).tint).toBe('#ffffff')
    expect(normalizeShadows({ enabled: false }).enabled).toBe(false)
    expect(normalizeShadows({ enabled: 'no' }).enabled).toBe(true)
  })

  it('is idempotent', () => {
    const once = normalizeShadows({ size: 12.3, darkness: 0.2, tint: '#112233', contact: false, quality: 'ultra', enabled: false })
    expect(normalizeShadows(once)).toEqual(once)
  })
})

describe('lightTanFromSize', () => {
  it('is tan of the angular RADIUS: 0 for a point light, grows with size', () => {
    expect(lightTanFromSize(0)).toBe(0)
    expect(lightTanFromSize(0.526)).toBeCloseTo(Math.tan((0.263 * Math.PI) / 180), 8)
    expect(lightTanFromSize(10)).toBeGreaterThan(lightTanFromSize(5))
    expect(lightTanFromSize(1000)).toBe(lightTanFromSize(30))
    expect(Number.isFinite(lightTanFromSize(NaN))).toBe(true)
  })
})

describe('opening projects saved by the old shadow system', () => {
  it('converts old flat fields into the new object', () => {
    const out = shadowsFromLegacy({ showShadow: true, shadowMapping: true, shadowSoftness: 0.4, shadowStrength: 0.7, shadowType: 'uniform', shadowQuality: 'medium', shadowTint: '#334455' })
    expect(out).toMatchObject({ enabled: true, quality: 'medium', darkness: 0.7, contact: false, tint: '#334455' })
    // old softness 0.4 = tan 0.0456 of the light radius = ~5.2 degrees across
    expect(out.size).toBeGreaterThan(4)
    expect(out.size).toBeLessThan(6.5)
  })

  it('old softness maps monotonically onto the new light size', () => {
    const at = (v) => shadowsFromLegacy({ shadowSoftness: v }).size
    expect(at(0)).toBeLessThan(at(0.3))
    expect(at(0.3)).toBeLessThan(at(0.7))
    expect(at(0.7)).toBeLessThan(at(1))
    expect(at(1)).toBeLessThanOrEqual(30)
  })

  it('blob (shadowMapping off) and shadows-off survive', () => {
    expect(shadowsFromLegacy({ showShadow: true, shadowMapping: false }).quality).toBe('blob')
    expect(shadowsFromLegacy({ showShadow: false }).enabled).toBe(false)
  })

  it('a project with no shadow fields leaves the current setup alone', () => {
    expect(shadowsFromProject({ showGrid: true }, DEFAULT_SHADOWS)).toBeNull()
    expect(shadowsFromProject(undefined)).toBeNull()
  })

  it('new projects carry `shadows` and win over any leftover legacy fields', () => {
    const out = shadowsFromProject({ shadows: { size: 9, quality: 'low' }, shadowStrength: 0.99 }, DEFAULT_SHADOWS)
    expect(out).toMatchObject({ size: 9, quality: 'low', darkness: DEFAULT_SHADOWS.darkness })
  })

  it('ignores the faint 0.15 values of the very old defaults, keeping the current setting', () => {
    const current = normalizeShadows({ darkness: 0.8, size: 2 })
    const out = shadowsFromProject({ showShadow: true, shadowStrength: 0.15, shadowSoftness: 0.15 }, current)
    expect(out.darkness).toBe(0.8)
    expect(out.size).toBe(2)
    // but a project that records its defaults version means the numbers were deliberate
    const deliberate = shadowsFromProject({ shadowDefaultsVersion: 2, shadowStrength: 0.15 }, current)
    expect(deliberate.darkness).toBe(0.15)
  })
})

describe('self-shadowing setting', () => {
  it('is on by default and survives normalising / bad input', () => {
    expect(DEFAULT_SHADOWS.selfShadow).toBe(true)
    expect(normalizeShadows({}).selfShadow).toBe(true)
    expect(normalizeShadows({ selfShadow: false }).selfShadow).toBe(false)
    expect(normalizeShadows({ selfShadow: 'no' }).selfShadow).toBe(true)
    // an older project's shadows object (no selfShadow field) gets it switched on
    expect(shadowsFromProject({ shadows: { size: 5 } }, DEFAULT_SHADOWS).selfShadow).toBe(true)
  })
})

describe('style tweaks', () => {
  it('Soft shadows are 50% dark', () => {
    expect(SHADOW_STYLES.find((s) => s.id === 'soft').darkness).toBe(0.5)
  })
  it('Manga Panel and Hard Anime use the cel / anime shadow style', () => {
    expect(PRESET_SHADOW_STYLE['Manga Panel']).toBe('cel')
    expect(PRESET_SHADOW_STYLE['Hard Anime']).toBe('cel')
  })
})

describe('night settings', () => {
  it('is off by default, with a usable strength and colour', () => {
    expect(DEFAULT_NIGHT.enabled).toBe(false)
    expect(DEFAULT_NIGHT.strength).toBeGreaterThan(0.3)
    expect(normalizeNight(undefined)).toEqual(DEFAULT_NIGHT)
  })
  it('clamps and repairs', () => {
    expect(normalizeNight({ strength: 9 }).strength).toBe(1)
    expect(normalizeNight({ strength: -1 }).strength).toBe(0)
    expect(normalizeNight({ strength: 'x' }).strength).toBe(DEFAULT_NIGHT.strength)
    expect(normalizeNight({ tint: 'red' }).tint).toBe(DEFAULT_NIGHT.tint)
    expect(normalizeNight({ enabled: true }).enabled).toBe(true)
    const once = normalizeNight({ enabled: true, strength: 0.3, tint: '#112233' })
    expect(normalizeNight(once)).toEqual(once)
  })
})
