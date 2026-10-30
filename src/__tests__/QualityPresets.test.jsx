import { describe, it, expect, afterEach } from 'vitest'
import * as THREE from 'three'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import {
  QUALITY_PRESETS,
  DEFAULT_QUALITY_PRESET,
  getQualityPreset,
  effectiveTextureMax,
  effectiveEdgeSmoothing,
  frameIntervalFor,
  viewportPixelRatio,
} from '../three/qualityPresets.js'
import { resolveShadowQuality } from '../three/shadowSettings.js'
import { ensureDecimatorReady, limitMeshTriangles, triangleCount } from '../three/decimate.js'
import { useStore } from '../store.js'
import QualitySection from '../panels/QualitySection.jsx'

afterEach(() => {
  cleanup()
  useStore.getState().setQualityPreset(DEFAULT_QUALITY_PRESET)
})

describe('the presets', () => {
  it('are High, Standard, Low, Very low, with Standard the default', () => {
    expect(QUALITY_PRESETS.map((p) => p.id)).toEqual(['high', 'standard', 'low', 'verylow'])
    expect(DEFAULT_QUALITY_PRESET).toBe('standard')
    expect(useStore.getState().qualityPreset).toBe('standard')
    expect(getQualityPreset('nonsense').id).toBe('standard')
  })

  it('every limit gets stricter (or stays) from High down to Very low', () => {
    const order = ['blob', 'low', 'medium', 'high', 'ultra']
    let last = null
    for (const p of QUALITY_PRESETS) {
      if (last) {
        expect(p.textureMax).toBeGreaterThan(0)
        expect(last.textureMax === 0 || p.textureMax <= last.textureMax).toBe(true)
        expect(p.pixelRatioCap).toBeLessThanOrEqual(last.pixelRatioCap)
        expect(order.indexOf(p.shadowCap)).toBeLessThanOrEqual(last.shadowCap ? order.indexOf(last.shadowCap) : 99)
        expect(last.frameCap === 0 || (p.frameCap > 0 && p.frameCap <= last.frameCap)).toBe(true)
        expect(last.meshBudget === 0 || p.meshBudget <= last.meshBudget).toBe(true)
        expect(p.meshBudget !== 0 || last.meshBudget === 0).toBe(true)
      }
      last = p
    }
  })

  it('High is the best there is: nothing limited', () => {
    const high = getQualityPreset('high')
    expect(high).toMatchObject({ textureMax: 0, shadowCap: null, msaa: true, frameCap: 0, meshBudget: 0, hideDistant: false })
  })
})

describe('what a preset decides', () => {
  it('import texture limit: the preset, or the stricter of it and the user\'s own', () => {
    expect(effectiveTextureMax('high', 0)).toBe(0)
    expect(effectiveTextureMax('high', 1024)).toBe(1024)
    expect(effectiveTextureMax('standard', 0)).toBe(2048)
    expect(effectiveTextureMax('standard', 512)).toBe(512)
    expect(effectiveTextureMax('standard', 4096)).toBe(2048)
    expect(effectiveTextureMax('verylow', 0)).toBe(512)
  })
  it('edge smoothing needs the preset to allow it and the user not to have turned it off', () => {
    expect(effectiveEdgeSmoothing('high', true)).toBe(true)
    expect(effectiveEdgeSmoothing('high', false)).toBe(false)
    expect(effectiveEdgeSmoothing('low', true)).toBe(false)
  })
  it('frame interval and viewport resolution', () => {
    expect(frameIntervalFor('high')).toBe(0)
    expect(frameIntervalFor('low')).toBeCloseTo(1000 / 30, 5)
    expect(viewportPixelRatio('high', 3)).toBe(1.5)
    expect(viewportPixelRatio('standard', 3)).toBe(1.25)
    expect(viewportPixelRatio('low', 2)).toBe(1)
    expect(viewportPixelRatio('verylow', 2)).toBe(0.75)
    expect(viewportPixelRatio('low', 0.5)).toBe(0.5) // never raised above the screen's own ratio
  })
})

describe('shadow quality ceiling', () => {
  it('limits a project that asks for more, and keeps one that asks for less', () => {
    expect(resolveShadowQuality('high', { cap: 'medium' }).id).toBe('medium')
    expect(resolveShadowQuality('ultra', { cap: 'low' }).id).toBe('low')
    expect(resolveShadowQuality('low', { cap: 'medium' }).id).toBe('low')
    expect(resolveShadowQuality('blob', { cap: 'high' }).blob).toBe(true)
    expect(resolveShadowQuality('high', { cap: 'blob' }).blob).toBe(true)
    expect(resolveShadowQuality('high', {}).id).toBe('high') // no cap: as before
    expect(resolveShadowQuality('high', { cap: null }).mapSize).toBe(4096)
  })
})

describe('limitMeshTriangles (mesh budget on import)', () => {
  it('thins meshes over the budget, keeps small ones, and keeps UVs / skinning data', async () => {
    await ensureDecimatorReady()
    const dense = new THREE.SphereGeometry(1, 128, 96)
    const small = new THREE.SphereGeometry(1, 8, 6)
    const root = new THREE.Group()
    const a = new THREE.Mesh(dense, new THREE.MeshStandardMaterial())
    const b = new THREE.Mesh(small, new THREE.MeshStandardMaterial())
    root.add(a, b)
    const smallBefore = small
    const before = triangleCount(dense)
    const stats = await limitMeshTriangles(root, 5000)
    expect(stats.meshes).toBe(1)
    expect(triangleCount(a.geometry)).toBeLessThan(before / 2)
    expect(triangleCount(a.geometry)).toBeGreaterThan(2000)
    expect(a.geometry.attributes.uv).toBeTruthy()
    expect(b.geometry).toBe(smallBefore)
  })
  it('does nothing without a budget or a root', async () => {
    expect(await limitMeshTriangles(null, 1000)).toMatchObject({ meshes: 0 })
    const root = new THREE.Group()
    expect(await limitMeshTriangles(root, 0)).toMatchObject({ meshes: 0 })
  })
})

describe('Quality section', () => {
  it('shows the four presets and applies the one clicked', () => {
    render(<QualitySection />)
    for (const label of ['High', 'Standard', 'Low', 'Potato']) expect(screen.getByRole('button', { name: label })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Standard' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Low' }))
    expect(useStore.getState().qualityPreset).toBe('low')
    expect(screen.getByRole('button', { name: 'Low' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByText(/MB/)).toBeNull() // simple descriptions
  })
})
