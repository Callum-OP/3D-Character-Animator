import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

const apply = vi.fn()
const meshesOf = { 1: ['hero-a', 'hero-b'], 2: ['npc-a'], 3: ['crate-a', 'crate-b'], 4: [] } // object id -> mesh uuids
vi.mock('../three/scene.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getTransparentMeshUuidsForObject: () => [],
    getMeshUuidsForObject: (o) => meshesOf[o.id] || [],
    applyModelMaterials: (...a) => apply(...a),
  }
})

import ObjectsPanel from '../panels/ObjectsPanel.jsx'
import { useStore } from '../store.js'

const st = () => useStore.getState()

beforeEach(() => {
  apply.mockClear()
  useStore.setState({
    sceneObjects: [
      { id: 1, name: 'Hero', isCharacter: true, characterId: 1, visible: true, kind: 'character' },
      { id: 2, name: 'Npc', isCharacter: true, characterId: 2, visible: true, kind: 'character' },
      { id: 3, name: 'Crate', visible: true, kind: 'model', style: 'auto' },
      { id: 4, name: 'Poster', visible: true, kind: 'image' },
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

describe('Objects panel: colour', () => {
  it('appears only once a recolourable object is selected', () => {
    render(<ObjectsPanel />)
    expect(screen.queryByLabelText('Colour')).toBeNull()
    fireEvent.click(rowOf('Crate'))
    expect(screen.getByLabelText('Colour')).toBeTruthy()
  })

  it('is not offered for an image (it has no meshes)', () => {
    render(<ObjectsPanel />)
    fireEvent.click(rowOf('Poster'))
    expect(screen.queryByLabelText('Colour')).toBeNull()
  })

  it('recolours every mesh of the selected prop and re-applies materials', () => {
    render(<ObjectsPanel />)
    fireEvent.click(rowOf('Crate'))
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: '#ff8800' } })
    expect(st().meshOverrides['crate-a'].color).toBe('#ff8800')
    expect(st().meshOverrides['crate-b'].color).toBe('#ff8800')
    expect(apply).toHaveBeenCalled()
  })

  it('works on the active character too', () => {
    render(<ObjectsPanel />)
    fireEvent.click(rowOf('Hero'))
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: '#00aa00' } })
    expect(st().meshOverrides['hero-a'].color).toBe('#00aa00')
    expect(st().meshOverrides['hero-b'].color).toBe('#00aa00')
  })

  it('writes a non-active character\'s colour into the roster, not the live overrides', () => {
    render(<ObjectsPanel />)
    fireEvent.click(rowOf('Npc'))
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: '#0000ff' } })
    expect(st().characters[2].meshOverrides['npc-a'].color).toBe('#0000ff')
    expect(st().meshOverrides['npc-a']).toBeUndefined()
  })

  it('recolours every selected object at once when several are selected', () => {
    render(<ObjectsPanel />)
    fireEvent.click(rowOf('Crate'))
    fireEvent.click(rowOf('Hero'), { shiftKey: true })
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: '#ff00ff' } })
    for (const uuid of ['crate-a', 'crate-b', 'hero-a', 'hero-b']) {
      expect(st().meshOverrides[uuid].color).toBe('#ff00ff')
    }
    expect(st().meshOverrides['npc-a']).toBeUndefined()
  })

  it('"Reset colour" clears it, and the swatch shows the object\'s current colour', () => {
    useStore.setState({ meshOverrides: { 'crate-a': { outline: true, shading: 'full', color: '#abcdef' } } })
    render(<ObjectsPanel />)
    fireEvent.click(rowOf('Crate'))
    expect(screen.getByLabelText('Colour').value).toBe('#abcdef')
    fireEvent.click(screen.getByText('Reset colour'))
    expect(st().meshOverrides['crate-a'].color).toBeUndefined()
  })
})
