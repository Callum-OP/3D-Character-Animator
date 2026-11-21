import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import React from 'react'

const switchToClip = vi.fn(() => null)
const switchToEditAnimation = vi.fn()
vi.mock('../three/clipSwitch.js', () => ({
  switchToClip: (...a) => switchToClip(...a),
  switchToEditAnimation: (...a) => switchToEditAnimation(...a),
  adoptClipKeys: vi.fn(),
}))

const saveSceneModel = vi.fn(async () => ({ ok: true, message: 'saved model' }))
const saveImagePNG = vi.fn(() => ({ ok: true, message: 'saved png' }))
const saveBVH = vi.fn(() => ({ ok: true, message: 'saved bvh' }))
const saveFramesZip = vi.fn(async () => ({ ok: true, message: 'saved zip' }))
vi.mock('../three/exportActions.js', async (importOriginal) => ({
  ...(await importOriginal()),
  saveSceneModel: (...a) => saveSceneModel(...a),
  saveImagePNG: (...a) => saveImagePNG(...a),
  saveBVH: (...a) => saveBVH(...a),
  saveFramesZip: (...a) => saveFramesZip(...a),
}))

const runExportShot = vi.fn()
vi.mock('../three/exportShot.js', () => ({
  runExportShot: (...a) => runExportShot(...a),
  canRecordVideo: () => true,
  hideGizmosForShot: () => () => {},
}))

import TitleBar from '../panels/TitleBar.jsx'
import { useStore } from '../store.js'

const menuButton = (name) => screen.getByRole('button', { name })
const open = (name) => fireEvent.click(menuButton(name))
const item = (label) => screen.getByRole('menuitem', { name: label })

beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState({
    modelInfo: { name: 'Hero', clipNames: ['Idle', 'Run'] },
    importedClipNames: ['Mocap 1'],
    playbackSource: 'edit',
    activeClipName: null,
    loop: true,
    speed: 1,
    exportVideoFormat: 'mp4',
    autoRiggerOpen: false,
    manageClipsRequested: false,
  })
})
afterEach(() => {
  cleanup()
  delete window.animare
})

describe('title bar layout', () => {
  it('shows File, Edit, Animation, Pose Library, Tools, Help in that order', () => {
    const { container } = render(<TitleBar />)
    const labels = [...container.querySelectorAll('.titlebar-menu-btn')].map((b) => b.textContent)
    expect(labels).toEqual(['File', 'Edit', 'Animation', 'Pose Library', 'Tools', 'Help'])
  })
})

describe('Tools menu', () => {
  it('holds Pose Finder and the Auto Rigger, each with a description', () => {
    window.animare = { pose: {} }
    const onOpenPoseFinder = vi.fn()
    render(<TitleBar onOpenPoseFinder={onOpenPoseFinder} />)
    open('Tools')
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('Turn a video into a mocap clip')).toBeTruthy()
    fireEvent.click(item(/Pose Finder/))
    expect(onOpenPoseFinder).toHaveBeenCalledTimes(1)

    open('Tools')
    fireEvent.click(item(/Rig a character/))
    expect(useStore.getState().autoRiggerOpen).toBe(true)
  })

  it('stays visible on the web build and says it needs the desktop app', () => {
    const onOpenPoseFinder = vi.fn()
    render(<TitleBar onOpenPoseFinder={onOpenPoseFinder} />)
    open('Tools')
    expect(screen.getByText(/mocap clip · desktop app only/)).toBeTruthy()
    fireEvent.click(item(/Pose Finder/))
    expect(onOpenPoseFinder).toHaveBeenCalled() // the panel itself explains why it can't run
  })
})

describe('File > Quit', () => {
  it('is not offered in a browser', () => {
    render(<TitleBar />)
    open('File')
    expect(screen.queryByRole('menuitem', { name: 'Quit' })).toBeNull()
  })

  it('asks the desktop app to quit, the same path as the window X', () => {
    const quit = vi.fn()
    window.animare = { quit }
    render(<TitleBar />)
    open('File')
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent)
    expect(items[items.length - 1]).toBe('Quit') // last item in the menu
    fireEvent.click(item('Quit'))
    expect(quit).toHaveBeenCalledTimes(1)
  })
})

describe('Animation menu', () => {
  it('toggles loop', () => {
    render(<TitleBar />)
    open('Animation')
    fireEvent.click(item('✓ Loop'))
    expect(useStore.getState().loop).toBe(false)
  })

  it('sets the playback speed from its own list', () => {
    render(<TitleBar />)
    open('Animation')
    fireEvent.click(item('Speed: 1× ▸'))
    fireEvent.click(item('2×'))
    expect(useStore.getState().speed).toBe(2)
  })

  it('lists the character’s clips and switches to the one picked', () => {
    render(<TitleBar />)
    open('Animation')
    fireEvent.click(item('Clips ▸'))
    expect(item('✓ Editable animation (keyframes)')).toBeTruthy()
    for (const name of ['Idle', 'Run', 'Mocap 1']) expect(item(name)).toBeTruthy()
    fireEvent.click(item('Run'))
    expect(switchToClip).toHaveBeenCalledWith('Run', { loop: true, speed: 1 })
  })

  it('goes back to the editable animation from the clip list', () => {
    useStore.setState({ playbackSource: 'clip', activeClipName: 'Run' })
    render(<TitleBar />)
    open('Animation')
    fireEvent.click(item('Clips ▸'))
    expect(item('✓ Run')).toBeTruthy()
    fireEvent.click(item('Editable animation (keyframes)'))
    expect(switchToEditAnimation).toHaveBeenCalled()
  })

  it('Manage clips… asks the Animate panel to open its clip tools', () => {
    render(<TitleBar />)
    open('Animation')
    fireEvent.click(item('Manage clips…'))
    expect(useStore.getState().manageClipsRequested).toBe(true)
  })

  it('needs a character for clip actions', () => {
    useStore.setState({ modelInfo: null })
    render(<TitleBar />)
    open('Animation')
    expect(item('Clips ▸').disabled).toBe(true)
    expect(item('Manage clips…').disabled).toBe(true)
  })
})

describe('File > Export As', () => {
  // A running export disables the File button until it finishes, so wait for it before reopening.
  const openExport = async () => {
    await waitFor(() => expect(menuButton('File').disabled).toBe(false))
    open('File')
    fireEvent.click(item('Export As… ▸'))
  }

  it('offers every format the Export panel can write', async () => {
    render(<TitleBar />)
    await openExport()
    for (const label of [
      'Record video (.mp4)',
      'Preview video',
      'Current view (.png)',
      'All animation frames (.zip)',
      'Animation (.bvh)',
      'Scene model (.glb) — recommended',
      'Scene model (.gltf)',
      'Scene model (.obj)',
      'Scene model (.stl)',
      'Scene model (.ply)',
      'More export options…',
    ]) {
      expect(item(label)).toBeTruthy()
    }
  })

  it('names the video format from the Export panel setting', async () => {
    useStore.setState({ exportVideoFormat: 'webm' })
    render(<TitleBar />)
    await openExport()
    expect(item('Record video (.webm)')).toBeTruthy()
  })

  it('writes the chosen 3D format for the scene', async () => {
    render(<TitleBar />)
    await openExport()
    fireEvent.click(item('Scene model (.obj)'))
    await Promise.resolve()
    expect(saveSceneModel).toHaveBeenCalledWith('obj', 'Hero')
  })

  it('records and previews through the shared video path', async () => {
    render(<TitleBar />)
    await openExport()
    fireEvent.click(item('Record video (.mp4)'))
    await Promise.resolve()
    expect(runExportShot).toHaveBeenLastCalledWith(expect.objectContaining({ record: true, name: 'Hero' }))
    await openExport()
    fireEvent.click(item('Preview video'))
    await Promise.resolve()
    expect(runExportShot).toHaveBeenLastCalledWith(expect.objectContaining({ record: false }))
  })

  it('image, frames and mocap go through the shared export actions', async () => {
    render(<TitleBar />)
    await openExport()
    fireEvent.click(item('Current view (.png)'))
    await Promise.resolve()
    expect(saveImagePNG).toHaveBeenCalledWith('Hero')
    await openExport()
    fireEvent.click(item('Animation (.bvh)'))
    await Promise.resolve()
    expect(saveBVH).toHaveBeenCalledWith('Hero')
    await openExport()
    fireEvent.click(item('All animation frames (.zip)'))
    await Promise.resolve()
    expect(saveFramesZip).toHaveBeenCalled()
  })
})
