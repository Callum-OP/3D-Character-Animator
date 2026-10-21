import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import * as THREE from 'three'

vi.mock('../three/scene.js', () => ({ applyModelMaterials: vi.fn(), getObjectRootById: () => null }))

import { undoScene, redoScene } from '../three/sceneHistory.js'
import { clearUndoHistory } from '../three/undoHistory.js'
import {
  initLights, addLight, getLightById, lightDataForPreset, applyLightPreset, setLightEffect, getLightEffect,
  applyLightEffects, restoreLightEffects, updateLightSources, getLightsData, applyLightsData,
  getLightClipboardData, pasteLight, setLightDirectional,
} from '../three/lights.js'
import {
  normalizeLightEffect, flickerLevel, lighthouseAngle, sampleLightEffect, HARD_FLICKER_LOW, SOFT_FLICKER_LOW,
} from '../three/lightEffects.js'

const range = (n, step) => Array.from({ length: n }, (_, i) => i * step)

describe('lightEffects: settings', () => {
  it('rejects unknown / missing effects and clamps the numbers', () => {
    expect(normalizeLightEffect(null)).toBeNull()
    expect(normalizeLightEffect({ type: 'disco' })).toBeNull()
    const fx = normalizeLightEffect({ type: 'flickerSoft', rate: 99, period: -4, consistent: 1 })
    expect(fx.rate).toBe(5)
    expect(fx.period).toBe(1)
    expect(fx.consistent).toBe(true)
    expect(normalizeLightEffect({ type: 'lighthouse' }).period).toBe(10)
  })
})

describe('lightEffects: flicker maths', () => {
  it('soft flicker wavers between its dimmest and full brightness, and is deterministic', () => {
    const fx = { type: 'flickerSoft', consistent: false, seed: 3 }
    const samples = range(2000, 0.017).map((t) => flickerLevel(fx, t))
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(SOFT_FLICKER_LOW - 1e-9)
    expect(Math.max(...samples)).toBeLessThanOrEqual(1)
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.3)
    expect(flickerLevel(fx, 12.345)).toBe(flickerLevel(fx, 12.345))
  })

  it('different seeds flicker differently when random', () => {
    const a = range(200, 0.05).map((t) => flickerLevel({ type: 'flickerSoft', seed: 1 }, t))
    const b = range(200, 0.05).map((t) => flickerLevel({ type: 'flickerSoft', seed: 2 }, t))
    expect(a).not.toEqual(b)
  })

  it('steady (consistent) soft flicker repeats exactly; random does not', () => {
    const steady = { type: 'flickerSoft', consistent: true, rate: 1 }
    const period = 1 / 1.5
    for (const t of [0.1, 0.37, 1.9]) expect(flickerLevel(steady, t + period)).toBeCloseTo(flickerLevel(steady, t), 6)
    const random = { type: 'flickerSoft', consistent: false }
    const repeats = range(60, 0.11).filter((t) => Math.abs(flickerLevel(random, t + period) - flickerLevel(random, t)) < 1e-6)
    expect(repeats.length).toBeLessThan(5)
  })

  it('steady hard flicker is a regular blink between full and (almost) off', () => {
    const fx = { type: 'flickerHard', consistent: true, rate: 1 }
    const values = new Set(range(400, 0.01).map((t) => flickerLevel(fx, t)))
    expect([...values].sort()).toEqual([HARD_FLICKER_LOW, 1].sort())
    expect(flickerLevel(fx, 0.1)).toBe(1)
    expect(flickerLevel(fx, 0.3)).toBe(HARD_FLICKER_LOW)
    expect(flickerLevel(fx, 0.1 + 1 / 2.5)).toBe(flickerLevel(fx, 0.1))
  })

  it('random hard flicker is mostly on, with sudden dips', () => {
    const fx = { type: 'flickerHard', consistent: false, seed: 5 }
    const samples = range(3000, 0.02).map((t) => flickerLevel(fx, t))
    const on = samples.filter((v) => v === 1).length
    expect(samples.some((v) => v === HARD_FLICKER_LOW)).toBe(true)
    expect(on / samples.length).toBeGreaterThan(0.6)
  })

  it('rate speeds it up', () => {
    const slow = { type: 'flickerHard', consistent: true, rate: 1 }
    const fast = { type: 'flickerHard', consistent: true, rate: 2 }
    expect(flickerLevel(fast, 0.05)).toBe(flickerLevel(slow, 0.1))
  })

  it('is 1 for anything that is not a flicker', () => {
    expect(flickerLevel(null, 3)).toBe(1)
    expect(flickerLevel({ type: 'lighthouse' }, 3)).toBe(1)
  })
})

describe('lightEffects: lighthouse maths', () => {
  it('turns one full circle per period and wraps', () => {
    const fx = { type: 'lighthouse', period: 10 }
    expect(lighthouseAngle(fx, 0)).toBe(0)
    expect(lighthouseAngle(fx, 2.5)).toBeCloseTo(Math.PI / 2, 6)
    expect(lighthouseAngle(fx, 5)).toBeCloseTo(Math.PI, 6)
    expect(lighthouseAngle(fx, 10)).toBeCloseTo(0, 6)
    expect(lighthouseAngle(fx, 12.5)).toBeCloseTo(Math.PI / 2, 6)
  })

  it('can be sampled into plain keyframes (for exporting)', () => {
    const keys = sampleLightEffect({ type: 'lighthouse', period: 4 }, 4, 10)
    expect(keys).toHaveLength(41)
    expect(keys[10].value).toBeCloseTo(Math.PI / 2, 6)
    const flick = sampleLightEffect({ type: 'flickerSoft' }, 2, 30)
    expect(flick.every((k) => k.value >= SOFT_FLICKER_LOW - 1e-9 && k.value <= 1)).toBe(true)
    expect(sampleLightEffect(null, 2)).toEqual([])
  })
})

describe('lights with effects', () => {
  let now = 0
  beforeAll(() => {
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
    const canvas = document.createElement('canvas')
    initLights({ scene, camera, renderer: { domElement: canvas }, controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 2 })
  })
  afterEach(() => vi.restoreAllMocks())
  const at = (seconds) => vi.spyOn(performance, 'now').mockReturnValue(seconds * 1000)
  const fresh = (data) => addLight({ recordUndo: false, data })
  const glowOf = (id) => getLightById(id).children.find((c) => c.userData.isLightGlow)

  it('the Lighthouse preset makes a levelled cone with a glow', () => {
    const meta = fresh({ ...lightDataForPreset('lighthouse'), position: [0, 5, 0] })
    const light = getLightById(meta.id)
    expect(meta.name).toBe('Lighthouse')
    expect(meta.directional).toBe(true)
    expect(light.isSpotLight).toBe(true)
    expect(meta.effect.type).toBe('lighthouse')
    expect(glowOf(meta.id)).toBeTruthy()
    expect(glowOf(meta.id).isPointLight).toBe(true)
    // flat to the horizon, not aimed down at the origin
    const sat = getLightsData().find((d) => d.name === 'Lighthouse')
    expect(sat.direction[1]).toBeCloseTo(0, 6)
  })

  it('the beam sweeps clockwise round its own vertical axis', () => {
    const meta = fresh({ ...lightDataForPreset('lighthouse'), position: [0, 5, 0] })
    const light = getLightById(meta.id)
    const period = meta.effect.period
    at(0)
    updateLightSources()
    const p0 = light.target.position.clone().sub(light.position)
    expect(p0.x).toBeCloseTo(0, 5)
    expect(p0.z).toBeCloseTo(-1, 5)
    at(period / 4)
    updateLightSources()
    const p1 = light.target.position.clone().sub(light.position)
    expect(p1.x).toBeCloseTo(1, 5)
    expect(p1.z).toBeCloseTo(0, 5)
    at(period)
    updateLightSources()
    const p2 = light.target.position.clone().sub(light.position)
    expect(p2.z).toBeCloseTo(-1, 5)
  })

  it('flicker dims the light for the draw only, then puts the saved brightness back', () => {
    const meta = fresh({ ...lightDataForPreset('flickerhard'), position: [1, 2, 1] })
    setLightEffect(meta.id, { consistent: true })
    const light = getLightById(meta.id)
    const base = light.intensity
    at(0.3) // inside the "off" part of the steady blink
    applyLightEffects()
    expect(light.intensity).toBeCloseTo(base * HARD_FLICKER_LOW, 6)
    restoreLightEffects()
    expect(light.intensity).toBe(base)
    at(0.1) // "on"
    applyLightEffects()
    expect(light.intensity).toBeCloseTo(base, 6)
    restoreLightEffects()
    expect(getLightsData().find((d) => d.name === meta.name).intensity).toBe(base)
  })

  it('lights without an effect are never touched', () => {
    const meta = fresh({ intensity: 3 })
    const light = getLightById(meta.id)
    applyLightEffects()
    expect(light.intensity).toBe(3)
    restoreLightEffects()
    expect(light.intensity).toBe(3)
    expect(meta.effect).toBeNull()
  })

  it('choosing Lighthouse on a plain bulb makes it a cone with a glow; clearing removes the glow', () => {
    const meta = fresh()
    const result = setLightEffect(meta.id, { type: 'lighthouse' })
    expect(result.directional).toBe(true)
    expect(result.effect.type).toBe('lighthouse')
    expect(getLightById(meta.id).isSpotLight).toBe(true)
    expect(glowOf(meta.id)).toBeTruthy()
    setLightEffect(meta.id, null)
    expect(getLightEffect(meta.id)).toBeNull()
    expect(glowOf(meta.id)).toBeUndefined()
  })

  it('the glow survives the light changing between cone and bulb', () => {
    const meta = fresh({ ...lightDataForPreset('lighthouse') })
    setLightDirectional(meta.id, false)
    expect(glowOf(meta.id)).toBeTruthy()
    setLightDirectional(meta.id, true)
    expect(glowOf(meta.id)).toBeTruthy()
  })

  it('changing the type keeps the speed and pattern the user chose', () => {
    const meta = fresh()
    setLightEffect(meta.id, { type: 'flickerSoft', consistent: true, rate: 2.5 })
    setLightEffect(meta.id, { type: 'flickerHard' })
    expect(getLightEffect(meta.id)).toMatchObject({ type: 'flickerHard', consistent: true, rate: 2.5 })
  })

  it('applying a non-effect preset clears the effect; an effect preset sets it', () => {
    const meta = fresh()
    applyLightPreset(meta.id, 'flickersoft')
    expect(getLightEffect(meta.id).type).toBe('flickerSoft')
    applyLightPreset(meta.id, 'bulb')
    expect(getLightEffect(meta.id)).toBeNull()
    applyLightPreset(meta.id, 'lighthouse')
    expect(glowOf(meta.id)).toBeTruthy()
    applyLightPreset(meta.id, 'bulb')
    expect(glowOf(meta.id)).toBeUndefined()
  })

  it('is saved and restored with the project, keeping the aim as saved', () => {
    const meta = fresh({ ...lightDataForPreset('lighthouse'), position: [2, 3, 4] })
    setLightEffect(meta.id, { period: 25 })
    const saved = JSON.parse(JSON.stringify(getLightsData().find((d) => d.name === meta.name)))
    expect(saved.effect).toMatchObject({ type: 'lighthouse', period: 25 })
    const [loaded] = applyLightsData([saved])
    expect(loaded.effect).toEqual(saved.effect)
    expect(loaded.directional).toBe(true)
    expect(getLightById(loaded.id).children.some((c) => c.userData.isLightGlow)).toBe(true)
    const again = getLightsData().find((d) => d.name === loaded.name)
    expect(again.direction).toEqual(saved.direction)
  })

  it('older saves without an effect load as plain lights', () => {
    const [loaded] = applyLightsData([{ name: 'Old light', color: '#ffffff', intensity: 2, position: [0, 1, 0] }])
    expect(loaded.effect).toBeNull()
  })

  it('a pasted copy keeps the effect but gets its own seed, so they do not blink in step', () => {
    const meta = fresh({ ...lightDataForPreset('flickersoft') })
    const copy = pasteLight(getLightClipboardData(meta.id))
    expect(copy.effect.type).toBe('flickerSoft')
    expect(copy.effect.seed).not.toBe(meta.effect.seed)
  })

  it('undo and redo bring an effect back and take it away', () => {
    clearUndoHistory()
    const meta = fresh()
    setLightEffect(meta.id, { type: 'flickerHard' })
    expect(getLightEffect(meta.id).type).toBe('flickerHard')
    undoScene()
    expect(getLightEffect(meta.id)).toBeNull()
    redoScene()
    expect(getLightEffect(meta.id).type).toBe('flickerHard')
  })
})
