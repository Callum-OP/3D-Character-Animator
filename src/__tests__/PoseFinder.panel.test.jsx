import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('../three/scene.js', () => ({ importBVHAuto: vi.fn(), scrubTimeline: vi.fn() }))

import PoseFinderPanel from '../panels/PoseFinderPanel.jsx'

const baseStatus = { ortOk: true, ortError: null, modelReady: false, modelBytes: 0, expectedBytes: 1424013951, modelPath: '/x', licenseUrl: 'https://example.com/LICENSE', loaded: false, provider: null, platform: 'win32', arch: 'arm64' }

function mockPose(status) {
  const pose = {
    status: vi.fn().mockResolvedValue(status),
    download: vi.fn().mockResolvedValue({ ok: true }),
    cancelDownload: vi.fn(),
    onDownloadProgress: vi.fn(() => () => {}),
    load: vi.fn(), unload: vi.fn(), infer: vi.fn(),
  }
  window.animare = { pose }
  return pose
}

describe('PoseFinderPanel', () => {
  beforeEach(() => { delete window.animare })
  afterEach(() => { cleanup(); delete window.animare })

  it('explains itself on the web build', () => {
    render(<PoseFinderPanel onClose={() => {}} />)
    expect(screen.getByText(/only available in the desktop app/i)).toBeTruthy()
  })

  it('requires the licence to be accepted before the model can be downloaded', async () => {
    const pose = mockPose(baseStatus)
    render(<PoseFinderPanel onClose={() => {}} />)
    const btn = await screen.findByRole('button', { name: /download model/i })
    expect(btn.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/SAM License/))
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    await waitFor(() => expect(pose.download).toHaveBeenCalled())
  })

  it('shows the model as ready and offers compute choices incl. DirectML on Windows', async () => {
    mockPose({ ...baseStatus, modelReady: true })
    render(<PoseFinderPanel onClose={() => {}} />)
    expect(await screen.findByText(/model ready/i)).toBeTruthy()
    expect(screen.getByRole('option', { name: /DirectML/i })).toBeTruthy()
    const run = screen.getByRole('button', { name: /find poses/i })
    expect(run.disabled).toBe(true) // no video yet
  })

  it('reports a runtime that failed to load', async () => {
    mockPose({ ...baseStatus, ortOk: false, ortError: 'DLL load failed' })
    render(<PoseFinderPanel onClose={() => {}} />)
    expect(await screen.findByText(/DLL load failed/)).toBeTruthy()
  })
})
