import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'
import ViewportContextMenu from '../panels/ViewportContextMenu.jsx'

afterEach(cleanup)

const items = [
  { id: 'copy', label: 'Copy', shortcut: 'Ctrl+C' },
  { id: 'paste', label: 'Paste', shortcut: 'Ctrl+V', disabled: true },
  { id: 'visibility', label: 'Hide', shortcut: 'H' },
  { separator: true },
  { id: 'delete', label: 'Delete', danger: true },
]

function setup(extra = {}) {
  const onAction = vi.fn()
  const onClose = vi.fn()
  render(<ViewportContextMenu menu={{ x: 50, y: 60, items, ...extra }} onAction={onAction} onClose={onClose} />)
  return { onAction, onClose }
}

describe('ViewportContextMenu', () => {
  it('shows every item with its shortcut, a separator, and greys out disabled ones', () => {
    setup()
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['CopyCtrl+C', 'PasteCtrl+V', 'HideH', 'Delete'])
    expect(screen.getByRole('separator')).toBeTruthy()
    expect(screen.getByText('Paste').closest('button').disabled).toBe(true)
  })

  it('is drawn at the pointer position', () => {
    setup()
    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('50px')
    expect(menu.style.top).toBe('60px')
  })

  it('clicking an item runs it and closes the menu', () => {
    const { onAction, onClose } = setup()
    fireEvent.click(screen.getByText('Hide'))
    expect(onAction).toHaveBeenCalledWith('visibility')
    expect(onClose).toHaveBeenCalled()
  })

  it('a disabled item does nothing', () => {
    const { onAction, onClose } = setup()
    fireEvent.click(screen.getByText('Paste'))
    expect(onAction).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Escape closes it, and does not reach the viewport\'s own Escape (deselect) handler', () => {
    const { onClose } = setup()
    const viewportKeys = vi.fn()
    window.addEventListener('keydown', viewportKeys)
    fireEvent.keyDown(window, { key: 'Escape' })
    window.removeEventListener('keydown', viewportKeys)
    expect(onClose).toHaveBeenCalled()
    expect(viewportKeys).not.toHaveBeenCalled()
  })

  it('other keys leave it open', () => {
    const { onClose } = setup()
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a click outside closes it; a click inside does not by itself', () => {
    const { onClose } = setup()
    fireEvent.pointerDown(screen.getByRole('menu'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('scrolling/zooming the view or losing focus closes it', () => {
    const { onClose } = setup()
    fireEvent.wheel(window)
    fireEvent.blur(window)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('the browser\'s own context menu is suppressed on top of it', () => {
    setup()
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    screen.getByRole('menu').dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })
})
