import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import {
  initLights, addLight, lightDataForPreset, getLightClipboardData, pasteLight, getLightsData, applyLightsData,
} from '../three/lights.js'

beforeAll(() => {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  const canvas = document.createElement('canvas')
  initLights({ scene, camera, renderer: { domElement: canvas }, controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 2 })
})

describe('lights made from a preset are named after it', () => {
  it('uses the preset name, then numbers further copies so names stay unique', () => {
    const a = addLight({ recordUndo: false, data: lightDataForPreset('headlight') })
    const b = addLight({ recordUndo: false, data: lightDataForPreset('headlight') })
    const c = addLight({ recordUndo: false, data: lightDataForPreset('headlight') })
    expect(a.name).toBe('Car headlight')
    expect(b.name).toBe('Car headlight 2')
    expect(c.name).toBe('Car headlight 3')
  })

  it('a plain new light keeps the generic "Light N" name', () => {
    expect(addLight({ recordUndo: false }).name).toMatch(/^Light \d+$/)
  })

  it('a pasted copy of a preset light keeps the preset name (numbered); a generic light pastes as a generic one', () => {
    const preset = addLight({ recordUndo: false, data: lightDataForPreset('flood') })
    const copy = pasteLight(getLightClipboardData(preset.id))
    expect(copy.name).toBe('Floodlight 2')
    const plain = addLight({ recordUndo: false })
    expect(pasteLight(getLightClipboardData(plain.id)).name).toMatch(/^Light \d+$/)
  })

  it('names survive a save / load round trip', () => {
    const made = addLight({ recordUndo: false, data: lightDataForPreset('candle') })
    const saved = getLightsData().find((d) => d.name === made.name)
    expect(saved).toBeTruthy()
    const [loaded] = applyLightsData([saved])
    expect(loaded.name).toBe('Candle')
  })
})
