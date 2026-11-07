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
import { capturePNG, captureAnimationPNGs, exportSceneModel } from '../three/scene.js'
import { useStore } from '../store.js'

let originalClipboard
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  if (originalClipboard === undefined) delete navigator.clipboard
  else Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
  originalClipboard = undefined
  vi.unstubAllGlobals()
  useStore.getState().setExportVideoFps(30)
  useStore.getState().setShowTargetFrameRateInPreview(true)
})

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
    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }))

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(capturePNG).toHaveBeenCalledWith(2)
    expect(write.mock.calls[0][0][0].data['image/png']).toBeInstanceOf(Blob)
  })

  it('copies ordered animation frames as one rich clipboard item at the configured FPS', async () => {
    const write = enableImageClipboard()
    render(<ExportPanel />)
    fireEvent.change(screen.getByLabelText('Custom FPS'), { target: { value: '24' } })
    fireEvent.click(screen.getByRole('button', { name: 'Copy all as images' }))

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(captureAnimationPNGs).toHaveBeenCalledWith(24, 2, expect.any(Function))
    expect(write.mock.calls[0][0]).toHaveLength(1)
    const item = write.mock.calls[0][0][0]
    expect(item.data['image/png']).toBeInstanceOf(Promise)
    await expect(item.data['image/png']).resolves.toBeInstanceOf(Blob)
    const html = await item.data['text/html']
    expect(html).toBeInstanceOf(Blob)
    const contents = await html.text()
    expect(contents.indexOf('Animation frame 1')).toBeLessThan(contents.indexOf('Animation frame 2'))
    expect(contents).toContain('Animation frame 25')
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
