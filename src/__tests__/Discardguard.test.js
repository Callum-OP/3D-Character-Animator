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

  it('does not ask when nothing has changed since the last save', () => {
    expect(confirmDiscardUnsaved('open another project')).toBe(true)
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('asks when there is unsaved work and respects the answer', () => {
    useStore.setState({ showGrid: !useStore.getState().showGrid })
    expect(isProjectDirty()).toBe(true)
    expect(confirmDiscardUnsaved('start a new project')).toBe(false)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    confirmSpy.mockReturnValue(true)
    expect(confirmDiscardUnsaved('start a new project')).toBe(true)
  })

  it('stops asking once the project is marked clean again', () => {
    useStore.setState({ showGrid: !useStore.getState().showGrid })
    markProjectClean()
    expect(confirmDiscardUnsaved('open another project')).toBe(true)
    expect(confirmSpy).not.toHaveBeenCalled()
  })
})
