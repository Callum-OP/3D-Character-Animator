import { describe, it, vi, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import React from 'react'

vi.mock('../three/Viewport.jsx', () => ({
  default: () => React.createElement('div', { 'data-testid': 'viewport-stub' }),
}))

import App from '../App.jsx'
import { useStore } from '../store.js'
import * as THREE from 'three'
import { initAnimation, setAnimationModel } from '../three/animation.js'

const emptyAnim = () => ({ tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} })

function setup(overrides = {}) {
  useStore.setState({
    modelInfo: { name: 'TestChar', bones: [{ name: 'Hips', deform: true, depth: 0 }], meshCount: 1, boneCount: 1, clipNames: ['Walk'] },
    mode: 'object',
    playbackSource: 'edit',
    activeClipName: null,
    playback: 'stopped',
    animDuration: 2,
    currentTime: 0,
    animData: emptyAnim(),
    sceneObjects: [{ id: 1, name: 'TestChar', isCharacter: true, characterId: 1, visible: true }],
    activeCharacterId: 1,
    selectedObjectId: 1,
    selectedObjectIds: [1],
    objectAnimData: {},
    ...overrides,
  })
  render(React.createElement(App))
  fireEvent.click(screen.getByText('Animate'))
}

afterEach(cleanup)

// The Viewport is stubbed, so give the animation module the render hooks it would normally get.
beforeEach(() => {
  window.confirm = vi.fn(() => true)
  initAnimation({
    requestRender: () => {},
    suspendPosing: () => {},
    resumePosing: () => {},
    onTime: () => {},
    onEnded: () => {},
    setContinuousRender: () => {},
  })
  // Bind a stand-in character so selecting a built-in clip has something to arm.
  setAnimationModel({ root: new THREE.Group(), bones: [], meshes: [], clips: [new THREE.AnimationClip('Walk', 1, [])] }, 1)
})

describe('Default clip', () => {

  it('is selected out of the box, even when the character has built-in clips, with Duration beside the picker', () => {
    setup()
    const picker = screen.getByLabelText('Character motion clip')
    expect(picker.value).toBe('')
        expect(within(picker).getByText('Walk')).toBeTruthy()
    // Duration lives in the clip area now, once.
    expect(screen.getAllByLabelText(/Duration/)).toHaveLength(1)
    fireEvent.change(screen.getByLabelText(/Duration/), { target: { value: '5' } })
    expect(useStore.getState().animDuration).toBe(5)
  })

  it('switching to a clip and back returns to the default clip (editable, paused, source "edit")', () => {
    setup()
    const picker = screen.getByLabelText('Character motion clip')
    fireEvent.change(picker, { target: { value: 'Walk' } })
    expect(useStore.getState().playbackSource).toBe('clip')
    expect(useStore.getState().activeClipName).toBe('Walk')
    fireEvent.change(screen.getByLabelText('Character motion clip'), { target: { value: '' } })
    expect(useStore.getState().playbackSource).toBe('edit')
    expect(useStore.getState().activeClipName).toBeNull()
    expect(useStore.getState().playback).toBe('paused')
  })

  it('the "Play a clip" tab no longer strands you with nothing selected', () => {
    setup({ playbackSource: 'edit' })
    fireEvent.click(screen.getByRole('button', { name: 'Play a clip' }))
    expect(useStore.getState().playbackSource).toBe('edit')
    expect(useStore.getState().activeClipName).toBeNull()
  })
})