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

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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
