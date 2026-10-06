import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store.js'

beforeEach(() => {
  useStore.setState({
    characters: {},
    characterOrder: [],
    activeCharacterId: null,
    sceneObjects: [],
    selectedObjectId: null,
    selectedObjectIds: [],
    selectedCameraId: null,
    selectedLightId: null,
  })
})

describe('active characters are selected in the scene object list', () => {
  it('selects a newly loaded character', () => {
    useStore.getState().addCharacter('char-1', { name: 'First' })

    expect(useStore.getState().selectedObjectId).toBe('char-1')
    expect(useStore.getState().selectedObjectIds).toEqual(['char-1'])
  })

  it('selects a character when switching the active character', () => {
    const store = useStore.getState()
    store.addCharacter('char-1', { name: 'First' })
    useStore.getState().addCharacter('char-2', { name: 'Second' })
    useStore.getState().setSelectedObjectId(null)
    useStore.getState().setActiveCharacterId('char-1')

    expect(useStore.getState().selectedObjectId).toBe('char-1')
    expect(useStore.getState().selectedObjectIds).toEqual(['char-1'])
  })
})
