import { beforeEach, describe, expect, it } from 'vitest'
import {
  SHADOW_STYLES,
  PRESET_SHADOW_STYLE,
  DEFAULT_SHADOWS,
  DEFAULT_SHADOW_STYLE,
  shadowStyleValues,
  detectShadowStyle,
  normalizeShadows,
} from '../three/shadowSettings.js'
import { STYLE_PRESETS } from '../panels/MaterialPanel.jsx'
import { useStore } from '../store.js'

beforeEach(() => {
  useStore.setState({ shadows: { ...DEFAULT_SHADOWS } })
})

describe('shadow styles', () => {
  it('offers six styles with valid values; Realistic comes first', () => {
    expect(SHADOW_STYLES.map((s) => s.id)).toEqual(['realistic', 'soft', 'hard', 'dramatic', 'cel', 'dreamy'])
    expect(SHADOW_STYLES[0].id).toBe(DEFAULT_SHADOW_STYLE)
    for (const s of SHADOW_STYLES) {
      expect(s.size).toBeGreaterThanOrEqual(0)
      expect(s.size).toBeLessThanOrEqual(30)
      expect(s.darkness).toBeGreaterThanOrEqual(0)
      expect(s.darkness).toBeLessThanOrEqual(1)
      expect(typeof s.contact).toBe('boolean')
    }
  })

  it('orders the styles sensibly: hard is crispest real shadow, soft is bigger, dramatic is darkest', () => {
    const by = Object.fromEntries(SHADOW_STYLES.map((s) => [s.id, s]))
    expect(by.hard.size).toBeLessThan(by.realistic.size)
    expect(by.realistic.size).toBeLessThan(by.soft.size)
    expect(by.soft.size).toBeLessThan(by.dreamy.size)
    for (const other of ['hard', 'realistic', 'soft', 'cel', 'dreamy']) {
      expect(by.dramatic.darkness).toBeGreaterThan(by[other].darkness)
    }
    // the stylised looks use an even edge, the photographic ones are contact-hardening
    expect(by.cel.contact).toBe(false)
    expect(by.dreamy.contact).toBe(false)
    expect(by.realistic.contact).toBe(true)
  })

  it('the app default IS the Realistic style at High quality', () => {
    const d = useStore.getState().shadows
    expect(d).toEqual(DEFAULT_SHADOWS)
    expect(d.enabled).toBe(true)
    expect(d.quality).toBe('high')
    expect(shadowStyleValues('realistic')).toEqual({ size: d.size, contact: d.contact, darkness: d.darkness })
    expect(detectShadowStyle(d)).toBe('realistic')
  })

  it('detects the active style from the values, and none once one is changed', () => {
    for (const s of SHADOW_STYLES) {
      expect(detectShadowStyle({ ...DEFAULT_SHADOWS, size: s.size, contact: s.contact, darkness: s.darkness })).toBe(s.id)
    }
    expect(detectShadowStyle({ ...DEFAULT_SHADOWS, size: 7.5 })).toBeNull()
    // same numbers, different edge type = not that style
    expect(detectShadowStyle({ ...DEFAULT_SHADOWS, contact: false })).toBeNull()
    expect(shadowStyleValues('nope')).toEqual({})
  })

  it('quality, colour and the master switch never change which style is detected', () => {
    expect(detectShadowStyle({ ...DEFAULT_SHADOWS, quality: 'ultra', tint: '#223366', enabled: false })).toBe('realistic')
  })

  it('every style is reachable through the store, and only touches size / contact / darkness', () => {
    useStore.getState().setShadows({ quality: 'ultra', tint: '#336699', enabled: true })
    for (const st of SHADOW_STYLES) {
      useStore.getState().applyShadowStyle(st.id)
      const s = useStore.getState().shadows
      expect(detectShadowStyle(s)).toBe(st.id)
      expect(s.quality).toBe('ultra')
      expect(s.tint).toBe('#336699')
    }
    const before = useStore.getState().shadows
    useStore.getState().applyShadowStyle('does-not-exist')
    expect(useStore.getState().shadows).toBe(before)
  })

  it('every Look preset names a shadow style and applying it sets the shadows', () => {
    expect(STYLE_PRESETS.length).toBeGreaterThan(0)
    for (const p of STYLE_PRESETS) {
      const id = PRESET_SHADOW_STYLE[p.label]
      expect(id, `${p.label} needs a shadow style`).toBeTruthy()
      expect(p.config.shadowStyle).toBe(id)
      useStore.getState().applyStylePreset(p.config)
      expect(detectShadowStyle(useStore.getState().shadows)).toBe(id)
      // the preset's own settings still apply, and the marker is not stored as a setting
      expect(useStore.getState().shadowStyle).toBeUndefined()
    }
  })

  it('applying Cinematic then Studio switches the shadows', () => {
    const cinematic = STYLE_PRESETS.find((p) => p.label === 'Cinematic')
    useStore.getState().applyStylePreset(cinematic.config)
    expect(detectShadowStyle(useStore.getState().shadows)).toBe('dramatic')
    const studio = STYLE_PRESETS.find((p) => p.label === 'Studio')
    useStore.getState().applyStylePreset(studio.config)
    const s = useStore.getState().shadows
    expect(detectShadowStyle(s)).toBe('soft')
    expect(s.contact).toBe(true)
  })

  it('setShadows always stores a complete, valid object', () => {
    useStore.getState().setShadows({ size: 9999, darkness: 'lots', quality: 'x', contact: 'yes', tint: 'blue' })
    // numbers clamp into range; anything that isn't valid falls back to the default
    expect(useStore.getState().shadows).toEqual({ ...normalizeShadows({}), size: 30 })
    useStore.getState().setShadows({ size: 8 })
    expect(useStore.getState().shadows.size).toBe(8)
    expect(useStore.getState().shadows.darkness).toBe(DEFAULT_SHADOWS.darkness)
  })

  it('Look presets: Realistic and Studio replace Toy / Figure and Realistic Studio', () => {
    const labels = STYLE_PRESETS.map((p) => p.label)
    expect(labels).toContain('Realistic')
    expect(labels).toContain('Studio')
    expect(labels).not.toContain('Toy / Figure')
    expect(labels).not.toContain('Realistic Studio')
    expect(STYLE_PRESETS.find((p) => p.label === 'Realistic').config.materialMode).toBe('realistic')
    expect(STYLE_PRESETS.find((p) => p.label === 'Studio').config.materialMode).toBe('standard')
  })

  it('Hard Anime hard rim line is 20% wide', () => {
    expect(STYLE_PRESETS.find((p) => p.label === 'Hard Anime').config.rimHardWidth).toBe(0.2)
  })
})
