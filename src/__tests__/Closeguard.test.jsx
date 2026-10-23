import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import React from 'react'

const save = vi.fn()
vi.mock('../three/projectSession.js', () => ({ saveCurrentProject: (...a) => save(...a) }))

import CloseGuard from '../panels/CloseGuard.jsx'
import { useStore } from '../store.js'
import { isProjectDirty, markProjectClean } from '../three/projectDirty.js'
import { pushSceneHistory } from '../three/sceneHistory.js'

let requestClose
let bridge

beforeEach(() => {
  save.mockReset()
  markProjectClean()
  bridge = {
    onCloseRequested: vi.fn((cb) => {
      requestClose = cb
      return () => {}
    }),
    closeAck: vi.fn(),
    closeNow: vi.fn(),
  }
  window.animare = bridge
  useStore.setState({ currentProject: { name: 'Chase scene', handle: null } })
})
afterEach(() => {
  cleanup()
  delete window.animare
})

const makeDirty = () => act(() => useStore.setState({ sceneLights: [{ id: 99, name: 'Light 99' }] }))
const ask = () => act(() => requestClose())

describe('dirty tracking', () => {
  it('starts clean, becomes dirty when something the project stores changes, clean again when saved', () => {
    expect(isProjectDirty()).toBe(false)
    useStore.setState({ sceneCameras: [{ id: 1, name: 'Camera 1' }] })
    expect(isProjectDirty()).toBe(true)
    markProjectClean()
    expect(isProjectDirty()).toBe(false)
  })
  it('an undoable edit counts too', () => {
    pushSceneHistory(() => {}, () => {}) // any edit made to the scene lands in the history
    expect(isProjectDirty()).toBe(true)
    markProjectClean()
    expect(isProjectDirty()).toBe(false)
  })
  it('things that are not part of the project (selection, time) do not', () => {
    useStore.setState({ selectedObjectId: 5, currentTime: 1.5 })
    expect(isProjectDirty()).toBe(false)
  })
})

describe('closing the desktop app', () => {
  it('closes straight away when nothing is unsaved', () => {
    render(<CloseGuard />)
    ask()
    expect(bridge.closeAck).toHaveBeenCalled()
    expect(bridge.closeNow).toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('asks first when there is unsaved work, naming the project', () => {
    render(<CloseGuard />)
    makeDirty()
    ask()
    expect(bridge.closeAck).toHaveBeenCalled()
    expect(bridge.closeNow).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog').textContent).toContain('Save changes to “Chase scene”?')
  })

  it('Cancel keeps the app open', () => {
    render(<CloseGuard />)
    makeDirty()
    ask()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(bridge.closeNow).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it("Don't save closes without saving", () => {
    render(<CloseGuard />)
    makeDirty()
    ask()
    fireEvent.click(screen.getByRole('button', { name: "Don't save" }))
    expect(save).not.toHaveBeenCalled()
    expect(bridge.closeNow).toHaveBeenCalled()
  })

  it('Save writes the project, then closes', async () => {
    save.mockResolvedValue({ name: 'Chase scene' })
    render(<CloseGuard />)
    makeDirty()
    ask()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(bridge.closeNow).toHaveBeenCalled())
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('cancelling the save dialog keeps the app open and the box on screen', async () => {
    save.mockRejectedValue(Object.assign(new Error('Save cancelled.'), { name: 'AbortError' }))
    render(<CloseGuard />)
    makeDirty()
    ask()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(bridge.closeNow).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull() // a cancel is not an error
  })

  it('a save that fails says so and does not close', async () => {
    save.mockRejectedValue(new Error('disk full'))
    render(<CloseGuard />)
    makeDirty()
    ask()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('disk full'))
    expect(bridge.closeNow).not.toHaveBeenCalled()
  })

  it('Escape cancels', () => {
    render(<CloseGuard />)
    makeDirty()
    ask()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(bridge.closeNow).not.toHaveBeenCalled()
  })
})

describe('closing in a browser', () => {
  it('only warns about leaving when there is unsaved work (and never in the desktop app)', () => {
    delete window.animare
    render(<CloseGuard />)
    const fire = () => {
      const e = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(fire()).toBe(false)
    makeDirty()
    expect(fire()).toBe(true)
  })
})
