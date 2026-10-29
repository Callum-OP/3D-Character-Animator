import { describe, it, expect, vi, afterEach } from 'vitest'
import * as THREE from 'three'
import { planKeyShadow } from '../three/shadowReuse.js'
import { trimMemory } from '../three/memoryTrim.js'
import { initPostFX, setDepthOfField, setBlurEffect } from '../three/postfx.js'
import { useStore } from '../store.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete globalThis.gc
})

describe('the key light only holds a shadow map while something casts on it', () => {
  it('an empty scene casts nothing and gives back a map it has', () => {
    expect(planKeyShadow({ wanted: true, hasCasters: false, castShadow: true, hasMap: true })).toEqual({ cast: false, freeMap: true, change: true })
    expect(planKeyShadow({ wanted: true, hasCasters: false, castShadow: false, hasMap: false })).toEqual({ cast: false, freeMap: false, change: false })
  })
  it('turns on the moment something can cast, and not before', () => {
    expect(planKeyShadow({ wanted: true, hasCasters: true, castShadow: false, hasMap: false })).toEqual({ cast: true, freeMap: false, change: true })
    expect(planKeyShadow({ wanted: true, hasCasters: true, castShadow: true, hasMap: true })).toEqual({ cast: true, freeMap: false, change: false })
  })
  it('never casts when the settings do not ask for real shadows', () => {
    expect(planKeyShadow({ wanted: false, hasCasters: true, castShadow: true, hasMap: true })).toEqual({ cast: false, freeMap: true, change: true })
    expect(planKeyShadow({ wanted: false, hasCasters: true, castShadow: false, hasMap: false }).cast).toBe(false)
  })
})

describe('trimMemory', () => {
  it('clears the renderer lists and asks for one collection after things settle', () => {
    vi.useFakeTimers()
    const gc = vi.fn()
    globalThis.gc = gc
    const dispose = vi.fn()
    trimMemory({ renderLists: { dispose } })
    trimMemory({ renderLists: { dispose } }) // two clears close together: one collection
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(gc).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)
    expect(gc).toHaveBeenCalledTimes(1)
  })
  it('does nothing where the page cannot collect, and copes with no renderer', () => {
    vi.useFakeTimers()
    expect(() => trimMemory(null)).not.toThrow()
    expect(() => trimMemory({})).not.toThrow()
    vi.advanceTimersByTime(2000)
  })
})

describe('the depth-of-field / blur render target is freed when no effect is on', () => {
  it('disposes it when the last effect is switched off, not while one is on', () => {
    initPostFX({})
    const dispose = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose')
    setDepthOfField(true, 5, 0.3, 12)
    expect(dispose).not.toHaveBeenCalled()
    setBlurEffect(true, 6)
    setDepthOfField(false)
    expect(dispose).not.toHaveBeenCalled() // blur still needs it
    setBlurEffect(false)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

describe('edge smoothing setting', () => {
  it('is on by default and can be turned off', () => {
    expect(useStore.getState().edgeSmoothing).toBe(true)
    useStore.getState().setEdgeSmoothing(false)
    expect(useStore.getState().edgeSmoothing).toBe(false)
    useStore.getState().setEdgeSmoothing(true)
  })
})

describe('removed lights give their shadow maps back', () => {
  async function setup() {
    const lights = await import('../three/lights.js')
    const scene = new THREE.Scene()
    lights.initLights({ scene, camera: new THREE.PerspectiveCamera(), renderer: { domElement: document.createElement('canvas') }, controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 2 })
    const entry = lights.addLight({ recordUndo: false })
    const light = lights.getLightById(entry.id || entry).light || lights.getLightById(entry.id || entry)
    light.shadow.map = new THREE.WebGLRenderTarget(4, 4) // stands in for the allocated shadow map
    return { lights, light, id: entry.id ?? entry }
  }

  it('deleting a light frees its shadow map', async () => {
    const { lights, light, id } = await setup()
    const dispose = vi.spyOn(light.shadow, 'dispose')
    lights.removeLight(id)
    expect(dispose).toHaveBeenCalled()
  })

  it('clearing every light (New Project) frees their shadow maps', async () => {
    const { lights, light } = await setup()
    const dispose = vi.spyOn(light.shadow, 'dispose')
    lights.clearLights()
    expect(dispose).toHaveBeenCalled()
  })
})
