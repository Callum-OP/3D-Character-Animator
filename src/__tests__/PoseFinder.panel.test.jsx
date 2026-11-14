import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('../three/scene.js', () => ({ importBVHAuto: vi.fn(), scrubTimeline: vi.fn() }))
vi.mock('../three/ikpins.js', () => ({ lockBonesInPlace: vi.fn(() => ({ locked: 2, relocked: 0 })), limbBoneNames: vi.fn(() => ['LeftFoot', 'RightFoot']) }))
vi.mock('../three/poseFinder/videoFrames.js', () => ({ openVideo: vi.fn(), seekTo: vi.fn().mockResolvedValue(), makeCropper: vi.fn(() => vi.fn()) }))
vi.mock('../three/poseFinder/run.js', () => ({ runPoseFinder: vi.fn() }))

import PoseFinderPanel from '../panels/PoseFinderPanel.jsx'
import { useStore } from '../store.js'
import { openVideo } from '../three/poseFinder/videoFrames.js'
import { runPoseFinder } from '../three/poseFinder/run.js'
import { importBVHAuto } from '../three/scene.js'
import { lockBonesInPlace } from '../three/ikpins.js'

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
  beforeEach(() => { delete window.animare; vi.clearAllMocks(); useStore.setState({ modelInfo: null }) })
  afterEach(() => { cleanup(); delete window.animare; useStore.setState({ modelInfo: null }) })

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

  it('applies and resets presets while keeping advanced settings collapsed', async () => {
    mockPose({ ...baseStatus, modelReady: true })
    render(<PoseFinderPanel onClose={() => {}} />)
    await screen.findByText(/model ready/i)
    const advanced = screen.getByText('Advanced settings').closest('details')
    expect(advanced.open).toBe(false)
    const preset = screen.getByLabelText('Motion preset')
    const ground = screen.getByLabelText(/keep feet on the ground/i)
    expect(ground.checked).toBe(true)
    fireEvent.change(preset, { target: { value: 'flips' } })
    expect(ground.checked).toBe(false)
    expect(screen.getByLabelText('Analyse frames at').value).toBe('30')
    const lowerArms = screen.getByLabelText('Lower shoulders and arms')
    expect(lowerArms.value).toBe('slight')
    fireEvent.change(lowerArms, { target: { value: 'off' } })
    fireEvent.change(screen.getByLabelText('Analyse frames at'), { target: { value: '5' } })
    fireEvent.click(screen.getByText('Reset to Flips'))
    expect(screen.getByLabelText('Analyse frames at').value).toBe('30')
    expect(lowerArms.value).toBe('slight')
    fireEvent.change(preset, { target: { value: 'lying' } })
    expect(screen.getByLabelText('Ground reference').value).toBe('body')
    expect(lowerArms.value).toBe('slight')
    fireEvent.change(preset, { target: { value: 'adaptable' } })
    expect(screen.getByLabelText('Analyse frames at').value).toBe('30')
    expect(screen.getByLabelText(/foot lock \(stops/i).checked).toBe(true)
    expect(screen.getByLabelText(/level planted feet/i).checked).toBe(true)
    expect(lowerArms.value).toBe('slight')
    fireEvent.change(preset, { target: { value: 'standing' } })
    expect(ground.checked).toBe(true)
    fireEvent.click(ground)
    expect(screen.getByLabelText(/foot lock \(stops/i).checked).toBe(false)
    expect(screen.getByLabelText(/level planted feet/i).checked).toBe(false)
  })

  it('passes mixed-motion cleanup to the solver for Adaptable', async () => {
    const pose = mockPose({ ...baseStatus, modelReady: true })
    pose.load.mockResolvedValue({ ok: true, provider: 'cpu' })
    openVideo.mockResolvedValue({ video: document.createElement('video'), width: 640, height: 480, duration: 2, close: vi.fn() })
    runPoseFinder.mockResolvedValue({ bvh: 'bvh', solved: { fps: 30, info: { warnings: [], feetLocked: false, tiltDeg: 0, slouchDeg: 0, footLevelDeg: 0, limitDeg: 0, shoulderLowerDeg: 0, armLowerDeg: 0 } } })
    render(<PoseFinderPanel onClose={() => {}} />)
    await screen.findByText(/model ready/i)
    fireEvent.change(screen.getByLabelText('Motion preset'), { target: { value: 'adaptable' } })
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [new File(['video'], 'test.mp4', { type: 'video/mp4' })] } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Find poses' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Find poses' }))
    await screen.findByRole('button', { name: 'Download BVH' })
    expect(runPoseFinder.mock.calls[0][0]).toMatchObject({ sampleFps: 30, footLock: true, clean: { contactMode: 'screen', motionProfile: 'mixed', ground: 'natural' } })
  })

  it('uses the completed run settings when adding a result after settings change', async () => {
    const pose = mockPose({ ...baseStatus, modelReady: true })
    pose.load.mockResolvedValue({ ok: true, provider: 'cpu' })
    openVideo.mockResolvedValue({ video: document.createElement('video'), width: 640, height: 480, duration: 2, close: vi.fn() })
    runPoseFinder.mockResolvedValue({ bvh: 'bvh from run', solved: { fps: 30, info: { warnings: [], feetLocked: true, tiltDeg: 0, slouchDeg: 0, footLevelDeg: 0, limitDeg: 0, shoulderLowerDeg: 0, armLowerDeg: 0 } } })
    importBVHAuto.mockResolvedValue({ name: 'clip', matched: 20, total: 20 })
    useStore.setState({ modelInfo: { name: 'character' } })
    render(<PoseFinderPanel onClose={() => {}} />)
    await screen.findByText(/model ready/i)
    fireEvent.change(screen.getByLabelText('Motion preset'), { target: { value: 'flips' } })
    fireEvent.click(screen.getByLabelText(/pin both feet/i))
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [new File(['video'], 'test.mp4', { type: 'video/mp4' })] } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Find poses' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Find poses' }))
    await screen.findByRole('button', { name: 'Download BVH' })
    expect(runPoseFinder.mock.calls[0][0]).toMatchObject({ sampleFps: 30, footLock: true, clean: { lowerArms: 'slight', ground: 'natural', groundReference: 'body', lockFeet: true, contactMode: 'screen' } })
    fireEvent.change(screen.getByLabelText('Motion preset'), { target: { value: 'standing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to active character' }))
    await waitFor(() => expect(lockBonesInPlace).toHaveBeenCalled())
    expect(importBVHAuto.mock.calls[0][0].name).toBe('test-pose.bvh')
    expect(importBVHAuto.mock.calls[0][1]).toEqual({ preserveFootRest: true })
  })

  it('keeps the standing foot correction when the preset changes after a run', async () => {
    const pose = mockPose({ ...baseStatus, modelReady: true })
    pose.load.mockResolvedValue({ ok: true, provider: 'cpu' })
    openVideo.mockResolvedValue({ video: document.createElement('video'), width: 640, height: 480, duration: 2, close: vi.fn() })
    runPoseFinder.mockResolvedValue({ bvh: 'bvh from run', solved: { fps: 30, info: { warnings: [], feetLocked: false, tiltDeg: 0, slouchDeg: 0, footLevelDeg: 0, limitDeg: 0, shoulderLowerDeg: 0, armLowerDeg: 0 } } })
    importBVHAuto.mockResolvedValue({ name: 'clip', matched: 20, total: 20 })
    useStore.setState({ modelInfo: { name: 'character' } })
    render(<PoseFinderPanel onClose={() => {}} />)
    await screen.findByText(/model ready/i)
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [new File(['video'], 'test.mp4', { type: 'video/mp4' })] } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Find poses' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Find poses' }))
    await screen.findByRole('button', { name: 'Download BVH' })
    fireEvent.change(screen.getByLabelText('Motion preset'), { target: { value: 'flips' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to active character' }))
    await waitFor(() => expect(importBVHAuto).toHaveBeenCalled())
    expect(importBVHAuto.mock.calls[0][1]).toEqual({ preserveFootRest: true })
  })
})
