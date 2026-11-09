import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import React from 'react'

const save = vi.fn()
vi.mock('../three/projectSession.js', () => ({ saveCurrentProject: (...a) => save(...a) }))

import CloseGuard from '../panels/CloseGuard.jsx'
import { useStore } from '../store.js'
import { confirmDiscardUnsaved, markProjectClean } from '../three/projectDirty.js'

const makeDirty = () => act(() => useStore.setState({ sceneLights: [{ id: 77, name: 'Light 77' }] }))

beforeEach(() => {
  save.mockReset()
  markProjectClean()
  useStore.setState({ currentProject: { name: 'Chase scene', handle: null } })
})
afterEach(cleanup)

describe('confirmDiscardUnsaved uses the app\'s Save changes box', () => {
  it('resolves true without showing anything when nothing is unsaved', async () => {
    render(<CloseGuard />)
    await expect(confirmDiscardUnsaved('open another project')).resolves.toBe(true)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('shows the box with what the person is about to do, and Cancel resolves false', async () => {
    render(<CloseGuard />)
    makeDirty()
    let result
    act(() => { confirmDiscardUnsaved('start a new project').then((v) => { result = v }) })
    const box = await screen.findByRole('alertdialog')
    expect(box.textContent).toContain('Save changes to “Chase scene”?')
    expect(box.textContent).toContain('if you start a new project without saving')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(result).toBe(false))
    expect(save).not.toHaveBeenCalled()
  })

  it("Don't save resolves true without saving", async () => {
    render(<CloseGuard />)
    makeDirty()
    let result
    act(() => { confirmDiscardUnsaved('open another project').then((v) => { result = v }) })
    fireEvent.click(await screen.findByRole('button', { name: "Don't save" }))
    await waitFor(() => expect(result).toBe(true))
    expect(save).not.toHaveBeenCalled()
  })

  it('Save writes the project then resolves true; a cancelled save dialog keeps the box open', async () => {
    render(<CloseGuard />)
    makeDirty()
    let result
    act(() => { confirmDiscardUnsaved('open another project').then((v) => { result = v }) })
    save.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(result).toBeUndefined()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    save.mockResolvedValueOnce({ name: 'Chase scene' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(result).toBe(true))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('Escape counts as Cancel', async () => {
    render(<CloseGuard />)
    makeDirty()
    let result
    act(() => { confirmDiscardUnsaved('open another project').then((v) => { result = v }) })
    await screen.findByRole('alertdialog')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(result).toBe(false))
  })
})
