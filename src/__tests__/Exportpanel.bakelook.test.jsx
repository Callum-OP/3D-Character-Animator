import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'

vi.mock('../three/scene.js', () => ({
  exportPNG: vi.fn(),
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
import { exportSceneModel } from '../three/scene.js'
import { useStore } from '../store.js'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useStore.getState().setExportVideoFps(30)
})

describe('Export panel — Include Material look in export', () => {
  it('is off by default and passes the choice to the scene export', async () => {
    render(<ExportPanel />)
    const box = screen.getByLabelText('Include Material look in export')
    expect(box.checked).toBe(false)
    fireEvent.click(screen.getByText('Save as .glb'))
    await waitFor(() => expect(exportSceneModel).toHaveBeenCalledTimes(1))
    expect(exportSceneModel.mock.calls[0][3]).toEqual({ bakeLook: false })

    fireEvent.click(box)
    fireEvent.click(screen.getByText('Save as .glb'))
    await waitFor(() => expect(exportSceneModel).toHaveBeenCalledTimes(2))
    expect(exportSceneModel.mock.calls[1][3]).toEqual({ bakeLook: true })
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
