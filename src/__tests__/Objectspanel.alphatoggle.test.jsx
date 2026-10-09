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

describe('Transparency switch in Scene objects', () => {
  it('only appears on models that actually have transparent materials', () => {
    render(<ObjectsPanel />)
    expect(within(rowOf('Hero')).getByLabelText('Transparency')).toBeTruthy()
    expect(within(rowOf('Window')).getByLabelText('Transparency')).toBeTruthy()
    expect(within(rowOf('Plain')).queryByLabelText('Transparency')).toBeNull()
  })

  it('starts on, and turning it off disables alpha on every transparent mesh and re-applies materials', () => {
    render(<ObjectsPanel />)
    const box = within(rowOf('Hero')).getByLabelText('Transparency')
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(useStore.getState().meshOverrides['skin-a'].alpha).toBe(false)
    expect(useStore.getState().meshOverrides['skin-b'].alpha).toBe(false)
    expect(apply).toHaveBeenCalled()
    expect(within(rowOf('Hero')).getByLabelText('Transparency').checked).toBe(false)
    fireEvent.click(within(rowOf('Hero')).getByLabelText('Transparency'))
    expect(useStore.getState().meshOverrides['skin-a'].alpha).toBe(true)
    expect(within(rowOf('Hero')).getByLabelText('Transparency').checked).toBe(true)
  })

  it('clicking the switch does not select the row', () => {
    render(<ObjectsPanel />)
    fireEvent.click(within(rowOf('Hero')).getByLabelText('Transparency'))
    expect(useStore.getState().selectedObjectId).toBeNull()
  })

  it('works for props too', () => {
    render(<ObjectsPanel />)
    fireEvent.click(within(rowOf('Window')).getByLabelText('Transparency'))
    expect(useStore.getState().meshOverrides.glass.alpha).toBe(false)
  })

  it('writes into a non-active character\'s own overrides', () => {
    transparent[2] = ['eyes']
    render(<ObjectsPanel />)
    fireEvent.click(within(rowOf('Plain')).getByLabelText('Transparency'))
    expect(useStore.getState().characters[2].meshOverrides.eyes.alpha).toBe(false)
    expect(useStore.getState().meshOverrides.eyes).toBeUndefined()
    delete transparent[2]
  })
})