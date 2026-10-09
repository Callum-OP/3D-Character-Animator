import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from '../store.js'

const st = () => useStore.getState()

describe('setMeshesAlpha', () => {
  beforeEach(() => {
    useStore.setState({ meshOverrides: {}, characters: {}, activeCharacterId: 1 })
  })

  it('writes alpha per mesh and keeps the other per-mesh settings', () => {
    useStore.setState({ meshOverrides: { a: { outline: false, shading: 'soft', visible: false } } })
    st().setMeshesAlpha(['a', 'b'], true)
    expect(st().meshOverrides.a).toEqual({ outline: false, shading: 'soft', visible: false, alpha: true })
    expect(st().meshOverrides.b).toEqual({ outline: true, shading: 'full', alpha: true })
    st().setMeshesAlpha(['a'], false)
    expect(st().meshOverrides.a.alpha).toBe(false)
  })

  it('writes into a character that is not the active one without touching the active overrides', () => {
    useStore.setState({ characters: { 2: { meshOverrides: { x: { outline: true, shading: 'full' } } } } })
    st().setMeshesAlpha(['x'], true, 2)
    expect(st().characters[2].meshOverrides.x.alpha).toBe(true)
    expect(st().meshOverrides).toEqual({})
  })

  it('writes to the live overrides when the given character is the active one', () => {
    st().setMeshesAlpha(['x'], true, 1)
    expect(st().meshOverrides.x.alpha).toBe(true)
  })
})
