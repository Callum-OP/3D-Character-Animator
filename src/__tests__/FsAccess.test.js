import { afterEach, describe, expect, it, vi } from 'vitest'
import { inCrossOriginFrame, pickerUsable, isPickerBlocked, pickFileWithInput } from '../three/fsAccess.js'
import { hasFileSystemAccess, openProjectFromDisk, saveProjectAs } from '../three/projectStore.js'
import { openClipFromDisk, saveClipAs } from '../three/clipLibrary.js'

// A fake window for the pure helpers. `top` mimics a cross-origin parent:
// touching its location throws, exactly as it does for html.itch.zone embedded
// in a page on itch.io.
const crossOriginWin = () => {
  const win = { showOpenFilePicker: () => {} }
  win.self = win
  win.top = {
    get location() {
      throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError')
    },
  }
  return win
}
const topLevelWin = () => {
  const win = { showOpenFilePicker: () => {} }
  win.self = win
  win.top = win
  return win
}
const sameOriginFrameWin = () => {
  const win = { showOpenFilePicker: () => {} }
  win.self = win
  win.top = { location: { href: 'https://same.example/' } }
  return win
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete window.showOpenFilePicker
  delete window.showSaveFilePicker
})

describe('file picker availability', () => {
  it('is unavailable inside a cross-origin iframe (itch.io) even though the API exists', () => {
    expect(inCrossOriginFrame(crossOriginWin())).toBe(true)
    expect(pickerUsable(crossOriginWin())).toBe(false)
  })

  it('is available top-level and in a same-origin frame', () => {
    expect(pickerUsable(topLevelWin())).toBe(true)
    expect(pickerUsable(sameOriginFrameWin())).toBe(true)
  })

  it('is unavailable where the API does not exist', () => {
    expect(pickerUsable({ self: 1, top: 1 })).toBe(false)
  })

  it('recognises a browser-refused picker but not a user cancel', () => {
    expect(isPickerBlocked(new DOMException('x', 'SecurityError'))).toBe(true)
    expect(isPickerBlocked(new DOMException('x', 'AbortError'))).toBe(false)
  })
})

describe('a refused picker falls back instead of failing', () => {
  const blocked = () => Promise.reject(new DOMException("Cross origin sub frames aren't allowed to show a file picker.", 'SecurityError'))

  it('open (project + clip) asks the caller for the file-input fallback', async () => {
    window.showOpenFilePicker = blocked
    expect(hasFileSystemAccess()).toBe(true) // top-level in jsdom, so it tries…
    await expect(openProjectFromDisk()).rejects.toThrow('FILE_SYSTEM_ACCESS_UNAVAILABLE') // …and falls back
    await expect(openClipFromDisk()).rejects.toThrow('FILE_SYSTEM_ACCESS_UNAVAILABLE')
  })

  it('a user cancelling is still a cancel, not a fallback', async () => {
    window.showOpenFilePicker = () => Promise.reject(new DOMException('cancelled', 'AbortError'))
    await expect(openProjectFromDisk()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('save (project + clip) downloads instead of throwing', async () => {
    window.showOpenFilePicker = () => {}
    window.showSaveFilePicker = blocked
    const clicks = []
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreate(tag)
      if (tag === 'a') el.click = () => clicks.push(el.download)
      return el
    })
    URL.createObjectURL = () => 'blob:test'
    URL.revokeObjectURL = () => {}

    const project = await saveProjectAs({ name: 'My Project' }, 'My Project')
    expect(project.handle).toBeNull()
    expect(clicks.some((n) => n.endsWith('.3dcp'))).toBe(true)

    const clip = await saveClipAs({ clip: { name: 'Walk' } }, 'Walk')
    expect(clip.handle).toBeNull()
    expect(clicks).toHaveLength(2)
  })
})

describe('pickFileWithInput', () => {
  it('opens a plain file chooser and resolves with the chosen file', async () => {
    let created
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreate(tag)
      if (tag === 'input') {
        created = el
        el.click = () => {
          Object.defineProperty(el, 'files', { value: [new File(['{}'], 'proj.3dcp')], configurable: true })
          el.dispatchEvent(new Event('change'))
        }
      }
      return el
    })
    const file = await pickFileWithInput('.3dcp')
    expect(created.type).toBe('file')
    expect(created.accept).toBe('.3dcp')
    expect(file.name).toBe('proj.3dcp')
    expect(document.body.contains(created)).toBe(false) // cleaned up
  })

  it('resolves null when the dialog is dismissed', async () => {
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreate(tag)
      if (tag === 'input') el.click = () => el.dispatchEvent(new Event('cancel'))
      return el
    })
    expect(await pickFileWithInput()).toBeNull()
  })
})