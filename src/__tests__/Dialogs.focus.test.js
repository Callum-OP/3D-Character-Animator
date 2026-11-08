import { afterEach, describe, it, expect, vi } from 'vitest'
import { confirmDialog, installNativeDialogFocusGuard } from '../dialogs.js'

describe('confirmDialog', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete window.animare
  })

  it('returns the answer and hands focus back to the page after the native dialog closes', () => {
    vi.useFakeTimers()
    window.confirm = vi.fn(() => true)
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    const refocusWindow = vi.fn()
    window.animare = { isElectron: true, refocusWindow }
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()

    expect(confirmDialog('Delete?')).toBe(true)
    expect(window.confirm).toHaveBeenCalledWith('Delete?')
    expect(document.activeElement).not.toBe(button)
    expect(focus).not.toHaveBeenCalled() // never move the window itself
    expect(refocusWindow).toHaveBeenCalledTimes(1)
    vi.runAllTimers()
    expect(refocusWindow).toHaveBeenCalledTimes(3)
    button.remove()
  })

  it('passes a cancel through and works without the Electron hook', () => {
    window.confirm = vi.fn(() => false)
    vi.spyOn(window, 'focus').mockImplementation(() => {})
    expect(confirmDialog('Delete?')).toBe(false)
  })

  it('uses the main-process confirm in Electron instead of window.confirm', () => {
    window.confirm = vi.fn(() => true)
    vi.spyOn(window, 'focus').mockImplementation(() => {})
    const confirm = vi.fn(() => false)
    window.animare = { isElectron: true, confirm, refocusWindow: vi.fn() }
    expect(confirmDialog('Delete?')).toBe(false)
    expect(confirm).toHaveBeenCalledWith('Delete?')
    expect(window.confirm).not.toHaveBeenCalled()
    window.animare.confirm = vi.fn(() => true)
    expect(confirmDialog('Again?')).toBe(true)
  })

  it('refocuses after a file picker is chosen or cancelled', () => {
    vi.useFakeTimers()
    vi.spyOn(window, 'focus').mockImplementation(() => {})
    const refocusWindow = vi.fn()
    window.animare = { isElectron: true, refocusWindow }
    const stop = installNativeDialogFocusGuard()
    const input = document.createElement('input')
    input.type = 'file'
    document.body.appendChild(input)
    input.dispatchEvent(new Event('cancel'))
    expect(refocusWindow).toHaveBeenCalledTimes(1)
    input.dispatchEvent(new Event('change', { bubbles: true }))
    expect(refocusWindow).toHaveBeenCalledTimes(2)
    const text = document.createElement('input')
    document.body.appendChild(text)
    text.dispatchEvent(new Event('change', { bubbles: true }))
    expect(refocusWindow).toHaveBeenCalledTimes(2)
    stop()
    input.remove()
    text.remove()
  })
})
