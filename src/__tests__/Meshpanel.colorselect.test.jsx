import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

const apply = vi.fn()
vi.mock('../three/scene.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, applyModelMaterials: (...a) => apply(...a) }
})

import MeshPanel from '../panels/MeshPanel.jsx'
import { useStore } from '../store.js'

const st = () => useStore.getState()

beforeEach(() => {
  apply.mockClear()
  useStore.setState({
    modelInfo: { meshes: [{ uuid: 'm1', name: 'Hair' }, { uuid: 'm2', name: 'Eyes' }, { uuid: 'm3', name: 'Shoes' }], bones: [] },
    sceneObjects: [],
    meshOverrides: {},
    selectedMeshUuid: null,
    selectedMeshUuids: [],
    mode: 'mesh',
  })
})
afterEach(cleanup)

const row = (name) => screen.getByText(name).closest('.obj-row')

describe('Parts panel: multi-select from the list', () => {
  it('a plain click selects one part; clicking it again deselects', () => {
    render(<MeshPanel />)
    fireEvent.click(row('Hair'))
    expect(st().selectedMeshUuids).toEqual(['m1'])
    fireEvent.click(row('Hair'))
    expect(st().selectedMeshUuids).toEqual([])
  })

  it('Shift-click and Ctrl-click add parts, and toggle them off again', () => {
    render(<MeshPanel />)
    fireEvent.click(row('Hair'))
    fireEvent.click(row('Eyes'), { shiftKey: true })
    fireEvent.click(row('Shoes'), { ctrlKey: true })
    expect(st().selectedMeshUuids).toEqual(['m1', 'm2', 'm3'])
    expect(st().selectedMeshUuid).toBe('m3')
    fireEvent.click(row('Eyes'), { shiftKey: true })
    expect(st().selectedMeshUuids).toEqual(['m1', 'm3'])
  })

  it('a plain click while several are selected narrows to just that part', () => {
    render(<MeshPanel />)
    useStore.setState({ selectedMeshUuid: 'm2', selectedMeshUuids: ['m1', 'm2'] })
    fireEvent.click(row('Shoes'))
    expect(st().selectedMeshUuids).toEqual(['m3'])
  })

  it('says how many parts are selected and offers group actions only then', () => {
    render(<MeshPanel />)
    fireEvent.click(row('Hair'))
    expect(screen.queryByText(/parts selected/)).toBeNull()
    fireEvent.click(row('Eyes'), { shiftKey: true })
    expect(screen.getByText(/2 parts selected/)).toBeTruthy()
    expect(screen.getByText('Reset selected')).toBeTruthy()
  })
})

describe('Parts panel: colour', () => {
  it('has no colour controls until something is selected', () => {
    render(<MeshPanel />)
    expect(screen.queryByLabelText('Colour')).toBeNull()
    fireEvent.click(row('Hair'))
    expect(screen.getByLabelText('Colour')).toBeTruthy()
  })

  it('picking a colour recolours every selected part and re-applies materials', () => {
    render(<MeshPanel />)
    fireEvent.click(row('Hair'))
    fireEvent.click(row('Eyes'), { shiftKey: true })
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: '#ff0000' } })
    expect(st().meshOverrides.m1.color).toBe('#ff0000')
    expect(st().meshOverrides.m2.color).toBe('#ff0000')
    expect(st().meshOverrides.m3).toBeUndefined()
    expect(apply).toHaveBeenCalled()
  })

  it('"Replace texture" is disabled until there is a colour, then flips the solid flag', () => {
    render(<MeshPanel />)
    fireEvent.click(row('Hair'))
    const box = screen.getByLabelText('Replace texture')
    expect(box.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: '#00ff00' } })
    expect(screen.getByLabelText('Replace texture').disabled).toBe(false)
    fireEvent.click(screen.getByLabelText('Replace texture'))
    expect(st().meshOverrides.m1).toMatchObject({ color: '#00ff00', solid: true })
    expect(screen.getByLabelText('Replace texture').checked).toBe(true)
  })

  it('"Reset colour" clears the tint on every selected part', () => {
    render(<MeshPanel />)
    fireEvent.click(row('Hair'))
    fireEvent.click(row('Eyes'), { shiftKey: true })
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: '#0000ff' } })
    apply.mockClear()
    fireEvent.click(screen.getByText('Reset colour'))
    expect(st().meshOverrides.m1.color).toBeUndefined()
    expect(st().meshOverrides.m2.color).toBeUndefined()
    expect(apply).toHaveBeenCalled()
  })

  it('shows the primary part\'s colour in the picker', () => {
    useStore.setState({ meshOverrides: { m2: { outline: true, shading: 'full', color: '#123456' } } })
    render(<MeshPanel />)
    fireEvent.click(row('Eyes'))
    expect(screen.getByLabelText('Colour').value).toBe('#123456')
  })
})
