import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import React from 'react'

const apply = vi.fn()
const transparent = { 1: ['skin-a', 'skin-b'], 3: ['glass'] } // object id -> meshes that use alpha
vi.mock('../three/scene.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getTransparentMeshUuidsForObject: (o) => transparent[o.id] || [],
    applyModelMaterials: (...a) => apply(...a),
  }
})

import ObjectsPanel from '../panels/ObjectsPanel.jsx'
import { useStore } from '../store.js'

beforeEach(() => {
  apply.mockClear()
  useStore.setState({
    sceneObjects: [
      { id: 1, name: 'Hero', isCharacter: true, characterId: 1, visible: true, kind: 'character' },
      { id: 2, name: 'Plain', isCharacter: true, characterId: 2, visible: true, kind: 'character' },
      { id: 3, name: 'Window', visible: true, kind: 'model', style: 'auto' },
    ],
    activeCharacterId: 1,
    selectedObjectId: null,
    selectedObjectIds: [],
    meshOverrides: {},
    characters: { 2: { meshOverrides: {} } },
  })
})
afterEach(cleanup)

const rowOf = (name) => screen.getByText(new RegExp(`^${name}`)).closest('.obj-row')

// The Transparency switch lives in the row's right-click menu now.
const openMenu = (name) => fireEvent.contextMenu(rowOf(name))
const entry = () => screen.queryByRole('menuitemcheckbox', { name: /Transparency/ })

describe('Transparency switch in the object menu', () => {
  it('only appears on models that actually have transparent materials', () => {
    render(<ObjectsPanel />)
    openMenu('Hero')
    expect(entry()).toBeTruthy()
    cleanup()
    render(<ObjectsPanel />)
    openMenu('Window')
    expect(entry()).toBeTruthy()
    cleanup()
    render(<ObjectsPanel />)
    openMenu('Plain')
    expect(entry()).toBeNull()
  })

  it('starts on, and turning it off disables alpha on every transparent mesh and re-applies materials', () => {
    render(<ObjectsPanel />)
    openMenu('Hero')
    expect(entry().getAttribute('aria-checked')).toBe('true')
    fireEvent.click(entry())
    expect(useStore.getState().meshOverrides['skin-a'].alpha).toBe(false)
    expect(useStore.getState().meshOverrides['skin-b'].alpha).toBe(false)
    expect(apply).toHaveBeenCalled()
    openMenu('Hero')
    expect(entry().getAttribute('aria-checked')).toBe('false')
    fireEvent.click(entry())
    expect(useStore.getState().meshOverrides['skin-a'].alpha).toBe(true)
    openMenu('Hero')
    expect(entry().getAttribute('aria-checked')).toBe('true')
  })

  it('right-clicking selects the row, and using the switch leaves it selected', () => {
    render(<ObjectsPanel />)
    openMenu('Hero')
    expect(useStore.getState().selectedObjectId).toBe(1)
    fireEvent.click(entry())
    expect(useStore.getState().selectedObjectId).toBe(1)
  })

  it('works for props too', () => {
    render(<ObjectsPanel />)
    openMenu('Window')
    fireEvent.click(entry())
    expect(useStore.getState().meshOverrides.glass.alpha).toBe(false)
  })

  it('writes into a non-active character\'s own overrides', () => {
    transparent[2] = ['eyes']
    render(<ObjectsPanel />)
    openMenu('Plain')
    fireEvent.click(entry())
    expect(useStore.getState().characters[2].meshOverrides.eyes.alpha).toBe(false)
    expect(useStore.getState().meshOverrides.eyes).toBeUndefined()
    delete transparent[2]
  })
})
