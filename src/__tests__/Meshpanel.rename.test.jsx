import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import React from 'react'

vi.mock('../three/scene.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, applyModelMaterials: () => {} }
})

import MeshPanel from '../panels/MeshPanel.jsx'
import { useStore } from '../store.js'
import { clearUndoHistory } from '../three/undoHistory.js'

const st = () => useStore.getState()
const row = (name) => screen.getByText(name).closest('.obj-row')

beforeEach(() => {
  clearUndoHistory()
  useStore.setState({
    modelInfo: { meshes: [{ uuid: 'm1', name: 'Mesh_012' }, { uuid: 'm2', name: 'Eyes' }], bones: [] },
    sceneObjects: [],
    meshOverrides: {},
    selectedMeshUuid: null,
    selectedMeshUuids: [],
    partRenameRequest: null,
    mode: 'mesh',
  })
})
afterEach(cleanup)

describe('Parts panel: rename', () => {
  it('double-click turns the name into a text box; Enter keeps the new name', () => {
    render(<MeshPanel />)
    fireEvent.doubleClick(screen.getByText('Mesh_012'))
    const box = screen.getByLabelText('Name')
    fireEvent.change(box, { target: { value: '  Front hair ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(st().meshOverrides.m1.name).toBe('Front hair')
    expect(screen.getByText('Front hair')).toBeTruthy()
    expect(screen.queryByText('Mesh_012')).toBeNull()
    expect(screen.queryByLabelText('Name')).toBeNull()
  })

  it('Escape leaves the name alone, and an empty name goes back to the model\'s own', () => {
    render(<MeshPanel />)
    fireEvent.doubleClick(screen.getByText('Mesh_012'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cape' } })
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' })
    expect(st().meshOverrides.m1?.name).toBeUndefined()
    act(() => useStore.setState({ meshOverrides: { m1: { name: 'Cape' } } }))
    expect(screen.getByText('Cape')).toBeTruthy()
    fireEvent.doubleClick(screen.getByText('Cape'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } })
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' })
    expect(screen.getByText('Mesh_012')).toBeTruthy()
  })

  it('a double-click does not toggle the part\'s selection off again', () => {
    render(<MeshPanel />)
    fireEvent.click(row('Eyes'), { detail: 1 })
    fireEvent.click(row('Eyes'), { detail: 2 })
    expect(st().selectedMeshUuids).toEqual(['m2'])
  })

  it('the row menu has Rename, and it starts the same text box', () => {
    render(<MeshPanel />)
    fireEvent.contextMenu(row('Eyes'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }))
    expect(screen.getByLabelText('Name')).toBeTruthy()
  })

  it('a rename asked for from the 3D view\'s menu opens the box and clears the request', () => {
    render(<MeshPanel />)
    act(() => st().setPartRenameRequest('m2'))
    expect(screen.getByLabelText('Name').value).toBe('Eyes')
    expect(st().partRenameRequest).toBeNull()
  })

  it('the row menu\'s heading uses the new name', () => {
    useStore.setState({ meshOverrides: { m1: { name: 'Front hair' } } })
    render(<MeshPanel />)
    fireEvent.contextMenu(row('Front hair'))
    expect(screen.getAllByText('Front hair').length).toBeGreaterThan(1)
  })
})
