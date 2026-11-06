import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { advanceWind, applyWind, setWindConfig } from '../three/wind.js'

describe('shared wind force', () => {
  afterEach(() => setWindConfig(false, [1, 0, 0], 5))

  it('normalizes direction and applies the configured strength', () => {
    const force = new THREE.Vector3()
    setWindConfig(true, [3, 4, 0], 10)

    applyWind(force)

    expect(force.x).toBeCloseTo(6)
    expect(force.y).toBeCloseTo(8)
    expect(force.z).toBe(0)
  })

  it('scales the force for model units and returns zero when disabled', () => {
    const force = new THREE.Vector3()
    setWindConfig(true, [0, 0, -1], 8)
    applyWind(force, 0.01)
    expect(force.toArray()).toEqual([0, 0, -0.08])

    setWindConfig(false, [1, 0, 0], 8)
    applyWind(force)
    expect(force.toArray()).toEqual([0, 0, 0])
  })

  it('does not apply force for a zero direction or invalid strength', () => {
    const force = new THREE.Vector3()
    setWindConfig(true, [0, 0, 0], Number.NaN)
    applyWind(force)
    expect(force.toArray()).toEqual([0, 0, 0])
  })

  it('varies gust strength and direction over time', () => {
    const steady = new THREE.Vector3()
    const gust = new THREE.Vector3()
    setWindConfig(true, [1, 0, 0], 10)
    applyWind(steady)

    advanceWind(0.8)
    applyWind(gust)

    expect(gust.length()).toBeGreaterThan(steady.length())
    expect(Math.abs(gust.z)).toBeGreaterThan(0.1)
  })

  it('lets fluctuation be disabled or adjusted independently from wind strength', () => {
    const steady = new THREE.Vector3()
    const unchanged = new THREE.Vector3()
    const higherStrength = new THREE.Vector3()
    setWindConfig(true, [1, 0, 0], 10, 0)
    applyWind(steady)

    advanceWind(0.8)
    applyWind(unchanged)
    expect(unchanged.toArray()).toEqual(steady.toArray())

    setWindConfig(true, [1, 0, 0], 200, 0)
    applyWind(higherStrength)
    expect(higherStrength.length()).toBe(100)
  })
})
