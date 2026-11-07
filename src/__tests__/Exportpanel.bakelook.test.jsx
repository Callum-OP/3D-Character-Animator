import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'

vi.mock('../three/scene.js', () => ({
  exportPNG: vi.fn(),
  capturePNG: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  captureAnimationPNGs: vi.fn(async (fps, scale, onFrame) => {
    const count = Math.ceil(fps) + 1
    for (let frame = 0; frame < count; frame++) {
      await onFrame(new Blob([String(frame)], { type: 'image/png' }), frame, count)
    }
    return { count, duration: 1 }
  }),
  getAllTimelineDuration: vi.fn(() => 1),
  previewOutputSize: vi.fn(() => ({ width: 100, height: 100 })),
  exportSceneModel: vi.fn(async () => ({ ok: true, message: 'Exported.' })),
  enterFullscreen: vi.fn(),
}))
vi.mock('../three/animation.js', () => ({ exportAnimationBVH: vi.fn() }))
vi.mock('../three/exportShot.js', () => ({
  runExportShot: vi.fn(),
  canRecordVideo: () => false,
  resolveShotView: () => ({}),
  hideGizmosForShot: () => () => {},
}))

import ExportPanel from '../panels/ExportPanel.jsx'
import { forgetAccordionStates } from '../panels/Accordion.jsx'
import { capturePNG, captureAnimationPNGs, exportSceneModel } from '../three/scene.js'
import { useStore } from '../store.js'

let originalClipboard
afterEach(() => {
  cleanup()
  forgetAccordionStates()
  vi.clearAllMocks()
  if (originalClipboard === undefined) delete navigator.clipboard
  else Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
  originalClipboard = undefined
  vi.unstubAllGlobals()
  useStore.getState().setExportVideoFps(30)
  useStore.getState().setShowTargetFrameRateInPreview(true)
})

// Only Export video starts open; open another group by its title.
function openSection(title) {
  const head = screen.getByRole('button', { name: new RegExp(title) })
  if (head.getAttribute('aria-expanded') !== 'true') fireEvent.click(head)
}

function enableImageClipboard() {
  originalClipboard = navigator.clipboard
  const write = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } })
  vi.stubGlobal('ClipboardItem', class {
    constructor(data) {
      this.data = data
    }
  })
  return write
}

describe('Export panel — Include Material look in export', () => {
  it('is off by default and passes the choice to the scene export', async () => {
    render(<ExportPanel />)
    openSection('Export 3D model')
    const box = screen.getByLabelText('Include Material look in export')
    expect(box.checked).toBe(false)
    fireEvent.click(screen.getByText('Save as .glb'))
    await waitFor(() => expect(exportSceneModel).toHaveBeenCalledTimes(1))
    expect(exportSceneModel.mock.calls[0][3]).toEqual({ bakeLook: false, combineMeshes: false })

    fireEvent.click(box)
    fireEvent.click(screen.getByText('Save as .glb'))
    await waitFor(() => expect(exportSceneModel).toHaveBeenCalledTimes(2))
    expect(exportSceneModel.mock.calls[1][3]).toEqual({ bakeLook: true, combineMeshes: false })
  })
})

describe('Export panel — copy images', () => {
  it('copies a PNG without downloading it', async () => {
    const write = enableImageClipboard()
    render(<ExportPanel />)
    openSection('Export image')
    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }))

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(capturePNG).toHaveBeenCalledWith(2)
    expect(write.mock.calls[0][0][0].data['image/png']).toBeInstanceOf(Blob)
  })

  it('saves every animation frame as a numbered PNG in one zip, in order', async () => {
    let zipBlob = null
    let fileName = null
    URL.createObjectURL = vi.fn((blob) => { zipBlob = blob; return 'blob:zip' })
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { fileName = this.download })
    try {
      render(<ExportPanel />)
      fireEvent.change(screen.getByLabelText('Custom FPS'), { target: { value: '24' } })
      openSection('Export image')
      fireEvent.click(screen.getByRole('button', { name: 'Save all as images (zip)' }))

      await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
      expect(captureAnimationPNGs).toHaveBeenCalledWith(24, 2, expect.any(Function))
      expect(fileName).toBe('render_frames.zip')
      const bytes = Buffer.from(await zipBlob.arrayBuffer())
      // central directory: entry count, then names in frame order
      const eocd = bytes.length - 22
      expect(bytes.readUInt32LE(eocd)).toBe(0x06054b50)
      expect(bytes.readUInt16LE(eocd + 10)).toBe(25)
      const names = []
      for (let at = bytes.readUInt32LE(eocd + 16), i = 0; i < 25; i++) {
        const len = bytes.readUInt16LE(at + 28)
        names.push(bytes.subarray(at + 46, at + 46 + len).toString())
        at += 46 + len
      }
      expect(names[0]).toBe('render_00001.png')
      expect(names[24]).toBe('render_00025.png')
      expect([...names].sort()).toEqual(names)
      await waitFor(() => expect(screen.getByText(/Saved 25 images/)).toBeTruthy())
    } finally {
      click.mockRestore()
    }
  })

})

describe('Export panel — custom frame rate', () => {
  it('accepts a custom FPS and keeps the preset buttons in sync', () => {
    render(<ExportPanel />)
    const input = screen.getByLabelText('Custom FPS')

    fireEvent.change(input, { target: { value: '48' } })
    expect(useStore.getState().exportVideoFps).toBe(48)
    expect(input.value).toBe('48')

    fireEvent.change(input, { target: { value: '29.97' } })
    expect(useStore.getState().exportVideoFps).toBe(29.97)
    expect(screen.getByText(/29\.97 fps, about/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '24' }))
    expect(useStore.getState().exportVideoFps).toBe(24)
    expect(input.value).toBe('24')
  })

  it('bounds manually entered frame rates when editing ends', () => {
    render(<ExportPanel />)
    const input = screen.getByLabelText('Custom FPS')

    fireEvent.change(input, { target: { value: '240' } })
    fireEvent.blur(input)

    expect(useStore.getState().exportVideoFps).toBe(240)
    expect(input.value).toBe('240')
  })
})

describe('Export panel — preview frame rate', () => {
  it('uses the target frame rate in preview by default and saves the toggle preference', () => {
    render(<ExportPanel />)
    const toggle = screen.getByLabelText('Show target frame rate in preview')

    expect(toggle.checked).toBe(true)
    expect(useStore.getState().showTargetFrameRateInPreview).toBe(true)

    fireEvent.click(toggle)
    expect(useStore.getState().showTargetFrameRateInPreview).toBe(false)
    expect(JSON.parse(localStorage.getItem('3d-animator-app-settings')).showTargetFrameRateInPreview).toBe(false)
  })
})

describe('Export panel — Combine meshes into one', () => {
  it('is off by default and passes the choice to the scene export', async () => {
    render(<ExportPanel />)
    openSection('Export 3D model')
    const box = screen.getByLabelText('Combine meshes into one')
    expect(box.checked).toBe(false)
    fireEvent.click(screen.getByText('Save as .glb'))
    await waitFor(() => expect(exportSceneModel).toHaveBeenCalledTimes(1))
    expect(exportSceneModel.mock.calls[0][3]).toEqual({ bakeLook: false, combineMeshes: false })

    fireEvent.click(box)
    fireEvent.click(screen.getByText('Save as .glb'))
    await waitFor(() => expect(exportSceneModel).toHaveBeenCalledTimes(2))
    expect(exportSceneModel.mock.calls[1][3]).toEqual({ bakeLook: false, combineMeshes: true })
  })
})

describe('Export panel — layout', () => {
  const TITLES = ['Export video', 'Export image', 'Export mocap', 'Export 3D model']
  const heads = () => TITLES.map((t) => screen.getByRole('button', { name: new RegExp(t) }))

  it('has the four groups in priority order, with only Export video open', () => {
    render(<ExportPanel />)
    const all = heads()
    expect(all.map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false', 'false'])
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].compareDocumentPosition(all[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    // preview + record are the first things in the open group
    expect(screen.getByRole('button', { name: '▶ Preview video' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Record video' })).toBeTruthy()
    // the others' controls are not on the page until opened
    expect(screen.queryByRole('button', { name: 'Save image (PNG)' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export mocap file (bvh)' })).toBeNull()
    expect(screen.queryByText('Save as .glb')).toBeNull()
  })

  it('gives every group exactly one orange main action, and keeps the rest grey', () => {
    render(<ExportPanel />)
    TITLES.slice(1).forEach(openSection)
    const sections = document.querySelectorAll('.acc')
    expect(sections).toHaveLength(4)
    const main = [...sections].map((s) => [...s.querySelectorAll('button.btn:not(.secondary)')].map((b) => b.textContent))
    expect(main).toEqual([['Record video'], ['Save image (PNG)'], ['Export mocap file (bvh)'], ['Save as .glb']])
  })

  it('keeps each group open or closed as you left it when the panel is reopened', () => {
    const first = render(<ExportPanel />)
    openSection('Export 3D model')
    fireEvent.click(screen.getByRole('button', { name: /Export video/ })) // close the default one
    first.unmount()
    render(<ExportPanel />)
    expect(heads().map((h) => h.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false', 'true'])
  })

  it('shows a result next to the button that made it', async () => {
    render(<ExportPanel />)
    openSection('Export 3D model')
    fireEvent.click(screen.getByText('Save as .glb'))
    await waitFor(() => expect(screen.getByText('Exported.')).toBeTruthy())
    const section = screen.getByText('Exported.').closest('.acc')
    expect(section.textContent).toContain('Export 3D model')
  })
})

describe('Export panel — 3D model formats', () => {
  const format = () => screen.getByLabelText('3D model format')

  it('defaults to GLB, listing rigged formats before static ones', () => {
    render(<ExportPanel />)
    openSection('Export 3D model')
    expect(format().value).toBe('glb')
    expect([...format().querySelectorAll('option')].map((o) => o.value)).toEqual(['glb', 'gltf', 'obj', 'stl', 'ply'])
    expect([...format().querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Rigged, with materials', 'Static mesh (geometry only)'])
  })

  it('exports the chosen format, relabels the button and sends the right options', async () => {
    render(<ExportPanel />)
    openSection('Export 3D model')
    fireEvent.change(format(), { target: { value: 'obj' } })
    fireEvent.click(screen.getByText('Save as .obj'))
    await waitFor(() => expect(exportSceneModel).toHaveBeenCalledTimes(1))
    // static formats: current pose, no material baking
    expect(exportSceneModel.mock.calls[0]).toEqual(['obj', 'render', 'current', { bakeLook: false, combineMeshes: false }])
  })

  it('static formats offer current/rest pose only and hide the material-look option', async () => {
    render(<ExportPanel />)
    openSection('Export 3D model')
    expect([...screen.getByLabelText('Pose').querySelectorAll('option')].map((o) => o.value)).toEqual(['baked', 'current', 'rest'])
    expect(screen.queryByLabelText('Include Material look in export')).toBeTruthy()

    fireEvent.change(format(), { target: { value: 'stl' } })
    expect([...screen.getByLabelText('Pose').querySelectorAll('option')].map((o) => o.value)).toEqual(['current', 'rest'])
    expect(screen.queryByLabelText('Include Material look in export')).toBeNull()
    expect(screen.getByLabelText('Combine meshes into one')).toBeTruthy() // still applies

    fireEvent.change(screen.getByLabelText('Pose'), { target: { value: 'rest' } })
    fireEvent.click(screen.getByLabelText('Combine meshes into one'))
    fireEvent.click(screen.getByText('Save as .stl'))
    await waitFor(() => expect(exportSceneModel).toHaveBeenCalledTimes(1))
    expect(exportSceneModel.mock.calls[0]).toEqual(['stl', 'render', 'rest', { bakeLook: false, combineMeshes: true }])
  })

  it('keeps the rigged pose choice when switching formats back and forth', () => {
    render(<ExportPanel />)
    openSection('Export 3D model')
    fireEvent.change(screen.getByLabelText('Pose'), { target: { value: 'rest' } })
    fireEvent.change(format(), { target: { value: 'ply' } })
    fireEvent.change(format(), { target: { value: 'gltf' } })
    expect(screen.getByLabelText('Pose').value).toBe('rest')
    expect(screen.getByText('Save as .gltf')).toBeTruthy()
  })
})
