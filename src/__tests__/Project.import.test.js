import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store.js'
import { importProjectData, getProjectData } from '../three/scene.js'
import { describeImport } from '../three/importProject.js'

describe('Import Project', () => {
  beforeEach(() => {
    useStore.setState({ night: { enabled: true }, outlineEnabled: true, showGrid: false, lightIntensity: 3, backgroundColor: '#123456' })
  })

  it('refuses a file that is not a saved project', async () => {
    await expect(importProjectData({ format: 'something-else' })).rejects.toThrow(/not a valid saved project/i)
    await expect(importProjectData(null)).rejects.toThrow(/not a valid saved project/i)
  })

  it('leaves the scene\'s own settings alone, whatever the file says', async () => {
    const before = getProjectData().settings
    const result = await importProjectData({
      format: 'project-v2',
      settings: { night: { enabled: false }, outlineEnabled: false, showGrid: true, lightIntensity: 0.1, backgroundColor: '#ffffff', materialLook: { tones: 3 } },
      characters: [],
      objects: [],
      lights: [{ name: 'Loose light', intensity: 5, position: [0, 1, 0] }], // free-standing: stays out
    })
    expect(result).toEqual({ characters: 0, objects: 0, lights: 0, skippedPartRigs: [] })
    const after = getProjectData().settings
    expect(after).toEqual(before)
    expect(useStore.getState().sceneLights).toEqual([])
  })

  it('says what came in', () => {
    expect(describeImport('Car', { characters: 1, objects: 3, lights: 2 })).toBe('Imported 1 character, 3 objects, 2 attached lights from “Car”.')
    expect(describeImport('Car', { characters: 0, objects: 1, lights: 0 })).toBe('Imported 1 object from “Car”.')
    expect(describeImport('Empty', { characters: 0, objects: 0, lights: 0 })).toMatch(/no characters or objects/)
  })
})
