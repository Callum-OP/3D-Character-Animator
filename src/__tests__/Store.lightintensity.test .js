import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from '../store.js'

// Behavioural companion to store.duplicateKeys.test.js: even with unique
// keys, make sure the two "intensity" setters actually do the right,
// independent thing — one for the single key light (Look panel's
// Brightness slider), one for a specific placed scene light (Lights panel).
describe('light intensity setters stay independent', () => {
  beforeEach(() => {
    useStore.setState({
      lightIntensity: 2,
      sceneLights: [
        { id: 'a', name: 'Fill', color: '#ffffff', intensity: 1, castShadow: false },
        { id: 'b', name: 'Rim', color: '#ffffff', intensity: 1, castShadow: false },
      ],
    })
  })

  it('setLightIntensity updates only the single key-light value', () => {
    useStore.getState().setLightIntensity(3.5)
    expect(useStore.getState().lightIntensity).toBe(3.5)
    // scene lights (a different concept entirely) must be untouched
    expect(useStore.getState().sceneLights.map((l) => l.intensity)).toEqual([1, 1])
  })

  it('Brightness slider stays responsive across repeated drags (regression for the "stuck" bug)', () => {
    const values = [0, 1.2, 2.5, 5, 0.1]
    for (const v of values) {
      useStore.getState().setLightIntensity(v)
      expect(useStore.getState().lightIntensity).toBe(v)
    }
  })

  it('setSceneLightIntensity updates only the targeted placed light', () => {
    useStore.getState().setSceneLightIntensity('b', 4)
    const lights = useStore.getState().sceneLights
    expect(lights.find((l) => l.id === 'a').intensity).toBe(1)
    expect(lights.find((l) => l.id === 'b').intensity).toBe(4)
    // and it must not have silently touched the key light
    expect(useStore.getState().lightIntensity).toBe(2)
  })
})