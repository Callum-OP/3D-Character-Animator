import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from '../store.js'

const st = () => useStore.getState()

describe('mesh multi-selection in the store', () => {
  beforeEach(() => {
    useStore.setState({ selectedMeshUuid: null, selectedMeshUuids: [] })
  })

  it('setSelectedMeshUuid keeps the single-select contract and fills the list', () => {
    st().setSelectedMeshUuid('a')
    expect(st().selectedMeshUuid).toBe('a')
    expect(st().selectedMeshUuids).toEqual(['a'])
    st().setSelectedMeshUuid(null)
    expect(st().selectedMeshUuid).toBeNull()
    expect(st().selectedMeshUuids).toEqual([])
  })

  it('an additive toggle builds the selection; the last pick is the primary', () => {
    st().toggleMeshSelection('a', false)
    st().toggleMeshSelection('b', true)
    st().toggleMeshSelection('c', true)
    expect(st().selectedMeshUuids).toEqual(['a', 'b', 'c'])
    expect(st().selectedMeshUuid).toBe('c')
  })

  it('toggling a selected part off drops it and re-picks a primary if it was the primary', () => {
    st().setMeshSelection(['a', 'b', 'c'], false)
    st().toggleMeshSelection('c', true)
    expect(st().selectedMeshUuids).toEqual(['a', 'b'])
    expect(st().selectedMeshUuid).toBe('b')
    st().toggleMeshSelection('a', true) // not the primary — primary stays
    expect(st().selectedMeshUuids).toEqual(['b'])
    expect(st().selectedMeshUuid).toBe('b')
  })

  it('a plain (non-additive) pick replaces the whole selection', () => {
    st().setMeshSelection(['a', 'b'], false)
    st().toggleMeshSelection('z', false)
    expect(st().selectedMeshUuids).toEqual(['z'])
    expect(st().selectedMeshUuid).toBe('z')
  })

  it('a plain pick of nothing clears; an additive pick of nothing does not', () => {
    st().setMeshSelection(['a', 'b'], false)
    st().toggleMeshSelection(null, true)
    expect(st().selectedMeshUuids).toEqual(['a', 'b'])
    st().toggleMeshSelection(null, false)
    expect(st().selectedMeshUuids).toEqual([])
    expect(st().selectedMeshUuid).toBeNull()
  })

  it('setMeshSelection replaces, or merges without duplicates when additive', () => {
    st().setMeshSelection(['a', 'b'], false)
    st().setMeshSelection(['b', 'c'], true)
    expect(st().selectedMeshUuids).toEqual(['a', 'b', 'c'])
    expect(st().selectedMeshUuid).toBe('c')
    st().setMeshSelection(['x'], false)
    expect(st().selectedMeshUuids).toEqual(['x'])
    st().setMeshSelection([], false)
    expect(st().selectedMeshUuid).toBeNull()
  })
})

describe('setMeshesColor', () => {
  beforeEach(() => {
    useStore.setState({ meshOverrides: {}, characters: {}, activeCharacterId: 1 })
  })

  it('writes a colour per mesh and keeps the other per-mesh settings', () => {
    useStore.setState({ meshOverrides: { a: { outline: false, shading: 'soft', visible: false } } })
    st().setMeshesColor(['a', 'b'], { color: '#ff0000', solid: false })
    expect(st().meshOverrides.a).toEqual({ outline: false, shading: 'soft', visible: false, color: '#ff0000', solid: false })
    expect(st().meshOverrides.b).toEqual({ outline: true, shading: 'full', color: '#ff0000', solid: false })
  })

  it('changing the colour or the solid flag updates just that', () => {
    st().setMeshesColor(['a'], { color: '#112233', solid: false })
    st().setMeshesColor(['a'], { color: '#112233', solid: true })
    expect(st().meshOverrides.a.solid).toBe(true)
    st().setMeshesColor(['a'], { color: '#445566', solid: true })
    expect(st().meshOverrides.a.color).toBe('#445566')
  })

  it('color: null clears the tint AND the solid flag, leaving the rest alone', () => {
    st().setMeshesColor(['a'], { color: '#112233', solid: true })
    st().setMeshesColor(['a'], { color: null })
    expect(st().meshOverrides.a).toEqual({ outline: true, shading: 'full' })
  })

  it('writes into a character that is not the active one without touching the active overrides', () => {
    useStore.setState({ characters: { 2: { meshOverrides: { x: { outline: true, shading: 'full' } } } } })
    st().setMeshesColor(['x'], { color: '#00ff00' }, 2)
    expect(st().characters[2].meshOverrides.x.color).toBe('#00ff00')
    expect(st().meshOverrides).toEqual({})
  })

  it('writes to the live overrides when the given character is the active one', () => {
    st().setMeshesColor(['x'], { color: '#00ff00' }, 1)
    expect(st().meshOverrides.x.color).toBe('#00ff00')
  })
})
