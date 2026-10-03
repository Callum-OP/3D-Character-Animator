import { describe, it, vi, expect } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import React from 'react'

// Regression test for a real black-screen crash: AnimationPanel used to call
// three useEffect hooks AFTER an early `if (!modelInfo) return null` (and a
// second early return just below it). React requires every hook to run on
// every render of a given component instance — AnimationPanel stays mounted
// regardless of whether a character is loaded (unlike BonePanel/MeshPanel,
// which unmount via their own Accordion's `mode === …` condition in
// App.jsx), so the moment it re-rendered with modelInfo going from set to
  // null on the SAME instance — e.g. starting a New Project, or the brief
// no-character moment partway through reopening a saved project — React
// threw "Minified React error #300: Rendered fewer hooks than expected",
// which (with no boundary around anything but the 3D viewport, at the time)
// took the whole app down to a blank screen. This only shows up with the
// Animate accordion actually open, since Accordion doesn't mount its
// children at all while collapsed (see Accordion.jsx) — that's why this
// wasn't caught by the AnimationPanel.hookorder eslint check alone; this
// test exercises the actual mount/unmount sequence end to end.

vi.mock('../three/Viewport.jsx', () => ({
  default: () => React.createElement('div', { 'data-testid': 'viewport-stub' }),
}))

import App from '../App.jsx'
import { useStore } from '../store.js'

describe('AnimationPanel stays mounted across modelInfo going to null', () => {
  it('does not crash the app when New Project is selected with the Animate panel open', async () => {
    useStore.setState({
      modelInfo: { name: 'TestChar', bones: [{ name: 'Hips', deform: true }], meshCount: 1, boneCount: 1, clipNames: ['Walk'] },
      mode: 'bone',
      sceneObjects: [],
    })
    render(React.createElement(App))

    // Open the Animate accordion — its children (AnimationPanel) only mount
    // once it's open (Accordion.jsx renders `{open && children}`).
    fireEvent.click(screen.getByText('Animate'))

    // Open File > New Project, same as the user's reported steps.
    fireEvent.click(screen.getByText('File'))
    const newProjectBtn = screen.getAllByText('New Project').find((el) => el.getAttribute('role') === 'menuitem')
    window.confirm = () => true
    fireEvent.click(newProjectBtn)
    await new Promise((r) => setTimeout(r, 50))

    // The real symptom: the app-level crash screen should never appear.
    expect(screen.queryByText('Something went wrong')).toBeNull()
    expect(useStore.getState().modelInfo).toBeNull()
  })

  it('offers object animation controls when no character model is loaded', () => {
    useStore.setState({
      modelInfo: null,
      mode: 'object',
      sceneObjects: [{ id: 11, name: 'Crate', animationKey: 'crate-track', visible: true }],
      selectedObjectId: 11,
      selectedObjectIds: [11],
      objectAnimData: {},
    })
    render(React.createElement(App))
    fireEvent.click(screen.getByText('Animate'))

    expect(screen.getByText('Object movement')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Key selected object/ })).toBeTruthy()
  })

  it('shows object animation controls only while a non-character object is selected', () => {
    useStore.setState({
      modelInfo: null,
      mode: 'object',
      sceneObjects: [{ id: 11, name: 'Crate', animationKey: 'crate-track', visible: true }],
      selectedObjectId: null,
      selectedObjectIds: [],
      objectAnimData: {},
    })
    render(React.createElement(App))
    fireEvent.click(screen.getByText('Animate'))

    expect(screen.queryByText('Object movement')).toBeNull()

    act(() => useStore.getState().setSelectedObjectId(11))
    expect(screen.getByText('Object movement')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Key selected object/ })).toBeTruthy()
  })

  it('shows character motion and movement when a character is selected, then hides character tools for a prop', () => {
    useStore.setState({
      modelInfo: { name: 'TestChar', bones: [{ name: 'Hips', deform: true }], meshCount: 1, boneCount: 1, clipNames: ['Walk'] },
      mode: 'object',
      playbackSource: 'clip',
      activeClipName: 'Walk',
      playback: 'paused',
      duration: 2,
      sceneObjects: [
        { id: 1, name: 'TestChar', isCharacter: true, characterId: 1, visible: true },
        { id: 11, name: 'Crate', animationKey: 'crate-track', visible: true },
      ],
      activeCharacterId: 1,
      selectedObjectId: 1,
      selectedObjectIds: [1],
      objectAnimData: {},
    })

    render(React.createElement(App))
    fireEvent.click(screen.getByText('Animate'))

    expect(screen.getByText('Character movement')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Key position/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Play a clip' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit keyframes' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit keyframes' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Import BVH…' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '▶ Play' }).disabled).toBe(false)

    act(() => useStore.getState().setSelectedObjectId(11))
    expect(screen.getByText('Object movement')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Key position/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Play a clip' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit keyframes' })).toBeNull()
  })

  it('selects a position key by clicking its row and lets its time be edited', () => {
    useStore.setState({
      modelInfo: { name: 'TestChar', bones: [{ name: 'Hips', deform: true }], meshCount: 1, boneCount: 1, clipNames: [] },
      mode: 'object',
      playbackSource: 'edit',
      playback: 'paused',
      currentTime: 0,
      animDuration: 2,
      duration: 2,
      animData: {
        tracks: { Hips: [{ time: 1, quat: [0, 0, 0, 1] }] },
        root: [{ time: 1, pos: [2, 0, 0], quat: [0, 0, 0, 1] }],
        meshes: {},
        cameras: {},
        cuts: [],
        morphs: {},
        lights: {},
      },
      sceneObjects: [{ id: 1, name: 'TestChar', isCharacter: true, characterId: 1, visible: true }],
      activeCharacterId: 1,
      selectedObjectId: 1,
    })

    render(React.createElement(App))
    fireEvent.click(screen.getByText('Animate'))

    fireEvent.click(screen.getByText('TestChar position'))
    expect(useStore.getState().currentTime).toBe(1)

    const time = screen.getByRole('button', { name: /Position key time/ })
    fireEvent.click(time)
    const input = screen.getByRole('spinbutton', { name: /Position key time/ })
    fireEvent.change(input, { target: { value: '1.5' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(useStore.getState().animData.root.map((key) => key.time)).toEqual([1.5])
    expect(useStore.getState().animData.tracks.Hips.map((key) => key.time)).toEqual([1.5])
    expect(useStore.getState().currentTime).toBe(1.5)
  })

  it('deletes a position key without selecting its row', () => {
    useStore.setState({
      modelInfo: { name: 'TestChar', bones: [{ name: 'Hips', deform: true }], meshCount: 1, boneCount: 1, clipNames: [] },
      mode: 'object',
      playbackSource: 'edit',
      playback: 'paused',
      currentTime: 0,
      animDuration: 2,
      duration: 2,
      animData: {
        tracks: {},
        root: [{ time: 1, pos: [2, 0, 0], quat: [0, 0, 0, 1] }],
        meshes: {},
        cameras: {},
        cuts: [],
        morphs: {},
        lights: {},
      },
      sceneObjects: [{ id: 1, name: 'TestChar', isCharacter: true, characterId: 1, visible: true }],
      activeCharacterId: 1,
      selectedObjectId: 1,
    })

    render(React.createElement(App))
    fireEvent.click(screen.getByText('Animate'))
    const playheadBeforeDelete = useStore.getState().currentTime
    fireEvent.click(screen.getByTitle('Delete this position keyframe'))

    expect(useStore.getState().animData.root).toEqual([])
    expect(useStore.getState().currentTime).toBe(playheadBeforeDelete)
  })

  it('shows only the selected object transport in an object-only scene', () => {
    useStore.setState({
      modelInfo: null,
      mode: 'object',
      sceneObjects: [{ id: 11, name: 'Crate', animationKey: 'crate-track', visible: true }],
      selectedObjectId: 11,
      selectedObjectIds: [11],
      objectAnimData: { 'crate-track': [{ time: 0, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }] },
      characterOrder: [],
      objectAnimDuration: 2,
      objectAnimPlaying: false,
    })

    render(React.createElement(App))
    fireEvent.click(screen.getByText('Animate'))

    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Play all/i })).toBeNull()
  })

  it('keeps detailed character keyframe controls available in an advanced disclosure', () => {
    useStore.setState({
      modelInfo: { name: 'TestChar', bones: [{ name: 'Hips', deform: true }], meshCount: 1, boneCount: 1, clipNames: [] },
      mode: 'bone',
      playbackSource: 'edit',
      sceneObjects: [],
    })

    const { container } = render(React.createElement(App))
    fireEvent.click(screen.getByText('Animate'))

    const advanced = screen.getByText('Advanced keyframe tools').closest('details')
    expect(advanced.open).toBe(false)
    expect(screen.getByRole('button', { name: 'Key selected joint' })).toBeTruthy()
    expect(container.querySelectorAll('.scrub-row input[type="range"]')).toHaveLength(1)
    expect(container.querySelectorAll('.keyframe-editor input[type="range"]')).toHaveLength(0)
    expect(container.querySelectorAll('.movement-track input[type="range"]')).toHaveLength(0)

    fireEvent.click(screen.getByText('Advanced keyframe tools'))
    expect(advanced.open).toBe(true)
    expect(screen.getByLabelText('Frames per second')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Insert blank frames' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New animation' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save as clip…' })).toBeTruthy()
  })

  it('starts a clean keyframe animation while keeping imported clips available', () => {
    useStore.setState({
      modelInfo: { name: 'TestChar', bones: [{ name: 'Hips', deform: true }], meshCount: 1, boneCount: 1, clipNames: ['Walk'] },
      mode: 'bone',
      playbackSource: 'edit',
      playback: 'stopped',
      activeClipName: 'Walk',
      animData: {
        tracks: { Hips: [{ time: 0, quat: [0, 0, 0, 1] }] },
        root: [],
        meshes: {},
        cameras: {},
        cuts: [],
        morphs: {},
        lights: {},
      },
      sceneObjects: [],
    })
    window.confirm = vi.fn(() => true)

    render(React.createElement(App))
    fireEvent.click(screen.getByText('Animate'))
    fireEvent.click(screen.getByRole('button', { name: 'New animation' }))

    expect(window.confirm).toHaveBeenCalled()
    expect(useStore.getState().animData.tracks).toEqual({})
    expect(useStore.getState().animDuration).toBe(2)
    expect(useStore.getState().activeClipName).toBeNull()
    expect(useStore.getState().playbackSource).toBe('edit')
    expect(screen.getByRole('button', { name: 'Play a clip' })).toBeTruthy()
  })

  it('keeps clip renaming in Manage clips and groups extra character actions', () => {
    useStore.setState({
      modelInfo: { name: 'TestChar', bones: [{ name: 'Hips', deform: true }], meshCount: 1, boneCount: 1, clipNames: [] },
      mode: 'bone',
      playbackSource: 'clip',
      playback: 'paused',
      activeClipName: 'Imported Walk',
      importedClipNames: ['Imported Walk'],
      sceneObjects: [],
    })

    render(React.createElement(App))
    fireEvent.click(screen.getByText('Animate'))

    expect(screen.queryByRole('button', { name: '✏️ Rename' })).toBeNull()
    const moreTools = screen.getByText('More character tools').closest('details')
    expect(moreTools.open).toBe(false)
    expect(screen.getByRole('button', { name: 'Use as pose' }).closest('details')).toBe(moreTools)
    fireEvent.click(screen.getByText(/Manage clips/))
    expect(screen.getByRole('button', { name: '✏️ Rename' })).toBeTruthy()
    expect(moreTools.open).toBe(false)
  })
})