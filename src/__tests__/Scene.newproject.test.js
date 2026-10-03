import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store.js'
import { clearProjectScene } from '../three/scene.js'

// Regression: "New Project" left old characters/objects in the Scene panel and
// the last character in the Character section (with an Unload button). Only
// the ACTIVE character's entries were being removed from the store, and the
// next character's fields were promoted to the top level before the registry
// was wiped.
function seed() {
  const s = useStore.getState()
  s.addCharacter('c1', { name: 'One', clipNames: [], bones: [] })
  s.addCharacter('c2', { name: 'Two', clipNames: [], bones: [] })
}

describe('clearProjectScene', () => {
  beforeEach(() => clearProjectScene())

  it('leaves no characters, scene objects or selection in the store', () => {
    seed()
    useStore.setState({ selectedObjectId: 'c1', selectedObjectIds: ['c1', 'c2'] })
    expect(useStore.getState().sceneObjects.filter((o) => o.isCharacter)).toHaveLength(2)

    clearProjectScene()

    const s = useStore.getState()
    expect(s.sceneObjects).toEqual([])
    expect(s.characterOrder).toEqual([])
    expect(s.characters).toEqual({})
    expect(s.activeCharacterId).toBeNull()
    expect(s.modelInfo).toBeNull()
    expect(s.selectedObjectId).toBeNull()
    expect(s.selectedObjectIds).toEqual([])
  })

  it('also clears a single remaining character', () => {
    useStore.getState().addCharacter('solo', { name: 'Solo', clipNames: [], bones: [] })
    clearProjectScene()
    const s = useStore.getState()
    expect(s.modelInfo).toBeNull()
    expect(s.sceneObjects).toEqual([])
    expect(s.characterOrder).toEqual([])
  })
})
