import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { confirmDiscardUnsaved, markProjectClean, isProjectDirty } from '../three/projectDirty.js'
import { useStore } from '../store.js'

describe('confirmDiscardUnsaved', () => {
  let confirmSpy
  beforeEach(() => {
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    markProjectClean()
  })
  afterEach(() => confirmSpy.mockRestore())

  it('does not ask when nothing has changed since the last save', async () => {
    await expect(confirmDiscardUnsaved('open another project')).resolves.toBe(true)
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('asks when there is unsaved work and respects the answer', async () => {
    useStore.setState({ showGrid: !useStore.getState().showGrid })
    expect(isProjectDirty()).toBe(true)
    
    // Since confirmDiscardUnsaved triggers the component prompt asynchronously, 
    // we can test the resolution using async expectations:
    const promise1 = confirmDiscardUnsaved('start a new project')
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    await expect(promise1).resolves.toBe(false)

    confirmSpy.mockReturnValue(true)
    const promise2 = confirmDiscardUnsaved('start a new project')
    await expect(promise2).resolves.toBe(true)
  })

  it('stops asking once the project is marked clean again', async () => {
    useStore.setState({ showGrid: !useStore.getState().showGrid })
    markProjectClean()
    await expect(confirmDiscardUnsaved('open another project')).resolves.toBe(true)
    expect(confirmSpy).not.toHaveBeenCalled()
  })
})