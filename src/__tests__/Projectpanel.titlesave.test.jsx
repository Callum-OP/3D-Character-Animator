import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'

const fixtures = vi.hoisted(() => ({ recents: [] }))

vi.mock('../three/scene.js', () => ({
  getProjectData: vi.fn(() => ({ scene: 'test' })),
  applyProjectData: vi.fn(),
  clearProjectScene: vi.fn(),
  importModelAuto: vi.fn(),
  importBVHAuto: vi.fn(),
  exportPNG: vi.fn(),
  exportSceneModel: vi.fn(),
  setObjectVisibleById: vi.fn((id, visible) => useStore.getState().setObjectVisible(id, visible)),
  loadModelFile: vi.fn(),
  disposeCurrentModel: vi.fn(),
  setActiveCharacter: vi.fn(),
  removeCharacter: vi.fn(),
}))

vi.mock('../three/projectStore.js', () => ({
  hasFileSystemAccess: () => true,
  listRecentProjects: vi.fn(async () => fixtures.recents),
  requestPersistentStorage: vi.fn(),
  removeRecentProject: vi.fn(),
  openRecentProject: vi.fn(),
  openProjectFromDisk: vi.fn(),
  openProjectFromFileObject: vi.fn(),
  saveProjectToHandle: vi.fn(),
  saveProjectAs: vi.fn(),
}))

vi.mock('../three/animation.js', () => ({ exportAnimationBVH: vi.fn() }))
vi.mock('../three/exportShot.js', () => ({ runExportShot: vi.fn(), canRecordVideo: () => false }))
vi.mock('../three/posing.js', () => ({ getPose: vi.fn(), applyPose: vi.fn(), resetPose: vi.fn() }))
vi.mock('../three/undoPriority.js', () => ({ performUndo: vi.fn(), performRedo: vi.fn() }))
vi.mock('../three/editClipboard.js', () => ({
  canCopyCurrentEdit: () => false,
  canPasteCurrentEdit: () => false,
  copyCurrentEdit: vi.fn(),
  pasteCurrentEdit: vi.fn(),
  toggleCurrentVisibility: vi.fn(),
}))

import ProjectPanel from '../panels/ProjectPanel.jsx'
import TitleBar from '../panels/TitleBar.jsx'
import { setObjectVisibleById } from '../three/scene.js'
import { saveProjectAs, saveProjectToHandle } from '../three/projectStore.js'
import { useStore } from '../store.js'

afterEach(() => {
  cleanup()
  fixtures.recents = []
  useStore.setState({ currentProject: null, sceneObjects: [], lastProjectSave: null })
  vi.clearAllMocks()
})

describe('title-bar project saves', () => {
  it('shows the saved status and refreshes the Project panel timestamp', async () => {
    const oldSavedAt = 1_700_000_000_000
    const savedAt = oldSavedAt + 60_000
    fixtures.recents = [{ id: 'scene', name: 'Scene.3dcp', savedAt: oldSavedAt, handle: {} }]
    useStore.setState({
      currentProject: { name: 'Scene.3dcp', handle: {} },
      sceneObjects: [{ id: 'object' }],
      lastProjectSave: null,
    })
    saveProjectToHandle.mockImplementation(async () => {
      fixtures.recents = [{ id: 'scene', name: 'Scene.3dcp', savedAt, handle: {} }]
      return { name: 'Scene.3dcp', savedAt, handle: {} }
    })

    render(
      <>
        <TitleBar />
        <ProjectPanel />
      </>
    )

    const oldDate = new Date(oldSavedAt).toLocaleString()
    const updatedDate = new Date(savedAt).toLocaleString()
    await waitFor(() => expect(screen.getByText(oldDate)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'File' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save' }))

    await waitFor(() => expect(screen.getByText('Saved “Scene.3dcp”.')).toBeTruthy())
    await waitFor(() => expect(screen.getByText(updatedDate)).toBeTruthy())
    expect(saveProjectToHandle).toHaveBeenCalledOnce()
  })

  it('updates the Project panel after title-bar Save As', async () => {
    const savedAt = 1_700_000_060_000
    useStore.setState({ currentProject: null, sceneObjects: [{ id: 'object' }], lastProjectSave: null })
    saveProjectAs.mockImplementation(async () => {
      fixtures.recents = [{ id: 'new-scene', name: 'New Scene.3dcp', savedAt, handle: {} }]
      return { name: 'New Scene.3dcp', savedAt, handle: {} }
    })

    render(
      <>
        <TitleBar />
        <ProjectPanel />
      </>
    )

    fireEvent.click(screen.getByRole('button', { name: 'File' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save As…' }))

    await waitFor(() => expect(screen.getByText('Saved “New Scene.3dcp”.')).toBeTruthy())
    await waitFor(() => expect(screen.getByText(new Date(savedAt).toLocaleString())).toBeTruthy())
    expect(useStore.getState().currentProject.name).toBe('New Scene.3dcp')
    expect(saveProjectAs).toHaveBeenCalledOnce()
  })

  it.each([
    ['title bar Save', 'menuitem', 'Save'],
    ['title bar Save As', 'menuitem', 'Save As…'],
    ['project panel Save', 'button', 'Save'],
    ['project panel Save As', 'button', 'Save As…'],
  ])('shows a persistent error dialog for %s failures', async (_label, role, name) => {
    useStore.setState({ currentProject: { name: 'Scene.3dcp', handle: {} }, sceneObjects: [{ id: 'object' }] })
    saveProjectToHandle.mockRejectedValue(new Error('disk full'))
    saveProjectAs.mockRejectedValue(new Error('disk full'))
    render(role === 'menuitem' ? <TitleBar /> : <ProjectPanel />)
    if (role === 'menuitem') fireEvent.click(screen.getByRole('button', { name: 'File' }))
    fireEvent.click(screen.getByRole(role, { name }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('Save failed')
    expect(dialog.textContent).toContain('disk full')
    expect(dialog.textContent).toContain('changes are still in the app')
    fireEvent.keyDown(screen.getByRole('button', { name: 'OK' }), { key: 'Escape' })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('does not show an error when the save picker is cancelled', async () => {
    useStore.setState({ currentProject: null, sceneObjects: [{ id: 'object' }] })
    saveProjectAs.mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
    render(<TitleBar />)
    fireEvent.click(screen.getByRole('button', { name: 'File' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save As…' }))
    await waitFor(() => expect(saveProjectAs).toHaveBeenCalled())
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('toggles all scene objects and switches the command when any object is hidden', () => {
    useStore.setState({
      sceneObjects: [
        { id: 'first', visible: true },
        { id: 'second', visible: false },
      ],
    })
    render(<TitleBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unhide All' }))
    expect(useStore.getState().sceneObjects.every((entry) => entry.visible === true)).toBe(true)
    expect(setObjectVisibleById).toHaveBeenNthCalledWith(1, 'first', true)
    expect(setObjectVisibleById).toHaveBeenNthCalledWith(2, 'second', true)

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide All' }))
    expect(useStore.getState().sceneObjects.every((entry) => entry.visible === false)).toBe(true)
    expect(setObjectVisibleById).toHaveBeenNthCalledWith(3, 'first', false)
    expect(setObjectVisibleById).toHaveBeenNthCalledWith(4, 'second', false)
  })
})