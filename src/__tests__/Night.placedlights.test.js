import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import {
  patchLightsChunk, patchOpaqueChunk, patchCommonChunk, nightLightsKeep, setNightLook, addShadowUniforms,
} from '../three/shadowDarkening.js'
import { normalizeNight, DEFAULT_NIGHT } from '../three/shadowSettings.js'

describe('night mode and placed lights — the setting', () => {
  it('placed lights keep shining by default', () => {
    expect(DEFAULT_NIGHT.affectLights).toBe(false)
    expect(normalizeNight(undefined).affectLights).toBe(false)
    expect(normalizeNight({ enabled: true, strength: 0.9 }).affectLights).toBe(false) // an older save
  })
  it('keeps a real on/off and ignores rubbish', () => {
    expect(normalizeNight({ affectLights: true }).affectLights).toBe(true)
    expect(normalizeNight({ affectLights: false }).affectLights).toBe(false)
    expect(normalizeNight({ affectLights: 'yes' }).affectLights).toBe(false)
  })
})

describe('night mode and placed lights — the shader', () => {
  const lights = patchLightsChunk(THREE.ShaderChunk.lights_fragment_begin)

  it('follows what point and spot lights add (and only those — not the sun-like directional light)', () => {
    expect(lights.placedCount).toBe(2)
    const src = lights.source
    expect(src.match(/dsPlaced \+=/g)).toHaveLength(2)
    expect(src.match(/vec3 dsPre =/g)).toHaveLength(2)
    // the first is inside the point-light loop, the second inside the spot-light loop
    const point = src.indexOf('getPointLightInfo')
    const spot = src.indexOf('getSpotLightInfo')
    const dir = src.indexOf('getDirectionalLightInfo')
    const first = src.indexOf('dsPlaced +=')
    const second = src.indexOf('dsPlaced +=', first + 1)
    expect(first).toBeGreaterThan(point)
    expect(first).toBeLessThan(spot)
    expect(second).toBeGreaterThan(spot)
    // the directional loop is untouched: its RE_Direct call stays plain
    expect(dir).toBeGreaterThan(second)
    expect(src.slice(dir).match(/dsPlaced \+=/g)).toBeNull()
  })

  it('still adds up the light exactly as before (the original call is kept, inside)', () => {
    const calls = lights.source.match(/RE_Direct\( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight \);/g)
    expect(calls).toHaveLength(3) // point, spot, directional — none lost
  })

  it('the night wash leaves that light alone unless asked, and still applies the shadow darkening to it', () => {
    const opaque = patchOpaqueChunk(THREE.ShaderChunk.opaque_fragment).source
    expect(opaque).toContain('vec3 dsKeep = dsPlaced * dsShadowMul * uNightLightsKeep;')
    expect(opaque).toContain('outgoingLight = max( outgoingLight - dsKeep, vec3( 0.0 ) ) * dsNightMul + dsKeep;')
    expect(opaque.indexOf('outgoingLight *= dsShadowMul')).toBeLessThan(opaque.indexOf('dsKeep'))
    expect(opaque.indexOf('dsKeep')).toBeLessThan(opaque.indexOf('gl_FragColor'))
  })

  it('declares what it uses', () => {
    const common = patchCommonChunk('// common')
    expect(common).toContain('uniform float uNightLightsKeep;')
    expect(common).toContain('vec3 dsPlaced = vec3( 0.0 );')
  })

  it('the night arithmetic: full night leaves exactly the placed light; no night leaves everything', () => {
    // a JS copy of the shader's last lines, with numbers
    const wash = (outgoing, placed, shadowMul, night, keepFlag, tint = 1) => {
      const nightMul = (1 - night) * (1 * (1 - night) + tint * night) // (1-n) * mix(1, tint, n)
      const keep = placed * shadowMul * keepFlag
      return Math.max(outgoing - keep, 0) * nightMul + keep
    }
    // 0.3 of the pixel is the main light + ambient, 0.5 is a placed lamp
    expect(wash(0.8, 0.5, 1, 1, 1)).toBeCloseTo(0.5) // total darkness: only the lamp
    expect(wash(0.8, 0.5, 1, 1, 0)).toBeCloseTo(0) // asked to dim lamps too: black
    expect(wash(0.8, 0.5, 1, 0, 1)).toBeCloseTo(0.8) // no night: untouched
    expect(wash(0.8, 0, 1, 1, 1)).toBeCloseTo(0) // no placed light: just dark
    expect(wash(0.8, 0.5, 0.5, 1, 1)).toBeCloseTo(0.25) // a shadowed lamp is still shadowed
  })
})

describe('night mode and placed lights — the switch', () => {
  beforeEach(() => setNightLook(0, '#5b78d1', false))
  it('placed lights are kept (1) by default, dimmed (0) when asked', () => {
    setNightLook(0.8, '#5b78d1')
    expect(nightLightsKeep.value).toBe(1)
    setNightLook(0.8, '#5b78d1', true)
    expect(nightLightsKeep.value).toBe(0)
    setNightLook(0.8, '#5b78d1', false)
    expect(nightLightsKeep.value).toBe(1)
  })
  it('every material shares the one switch', () => {
    const u = {}
    addShadowUniforms(u)
    expect(u.uNightLightsKeep).toBe(nightLightsKeep)
  })
})
