import { describe, it, vi, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react'
import React from 'react'

vi.mock('../three/Viewport.jsx', () => ({
  default: () => React.createElement('div', { 'data-testid': 'viewport-stub' }),
}))

import App from '../App.jsx'
import { useStore } from '../store.js'
import * as THREE from 'three'
import { initAnimation, setAnimationModel, addGeneratedClip, removeClip, selectClip, getCharacterClipDuration } from '../three/animation.js'

const rowOf = (name) =>
  Array.from(document.querySelectorAll('.clip-row')).find((r) => r.querySelector('.clip-name')?.textContent === name)

const emptyAnim = () => ({ tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} })

function setup() {
  const a = addGeneratedClip(new THREE.AnimationClip('Wave', 2, []))
  const b = addGeneratedClip(new THREE.AnimationClip('Jump', 1, []))
  useStore.setState({
    modelInfo: { name: 'TestChar', bones: [{ name: 'Hips', deform: true, depth: 0 }], meshCount: 1, boneCount: 1, clipNames: ['Walk'] },
    mode: 'object',
    playbackSource: 'clip',
    activeClipName: null,
    importedClipNames: [a, b],
    playback: 'stopped',
    animDuration: 2,
    currentTime: 0,
    animData: emptyAnim(),
    sceneObjects: [{ id: 1, name: 'TestChar', isCharacter: true, characterId: 1, visible: true }],
    activeCharacterId: 1,
    selectedObjectId: 1,
    selectedObjectIds: [1],
    objectAnimData: {},
  })
  render(React.createElement(App))
  fireEvent.click(screen.getByText('Animate'))
  fireEvent.click(screen.getByText(/Manage clips/))
}

beforeEach(() => {
  window.confirm = vi.fn(() => true)
  initAnimation({
    requestRender: () => {}, suspendPosing: () => {}, resumePosing: () => {},
    onTime: () => {}, onEnded: () => {}, setContinuousRender: () => {},
  })
  setAnimationModel({ root: new THREE.Group(), bones: [], meshes: [], clips: [new THREE.AnimationClip('Walk', 1, [])] }, 1)
})
afterEach(cleanup)

describe('removeClip (engine)', () => {
  it('removes imported clips only, never built-in ones', () => {
    addGeneratedClip(new THREE.AnimationClip('Wave', 2, []))
    expect(removeClip('Walk')).toBe(false)
    expect(selectClip('Walk')).toBe(1)
    expect(removeClip('Wave')).toBe(true)
    expect(getCharacterClipDuration(1, 'Wave')).toBe(0)
    expect(removeClip('Wave')).toBe(false)
  })
})

describe('Clips on this character', () => {
  it('lists every clip, built-in ones flagged, and deletes an imported clip from the menu', () => {
    setup()
    expect(screen.getByText(/Clips on this character \(3\)/)).toBeTruthy()
    expect(screen.getByText('built in')).toBeTruthy()
    const row = rowOf('Wave')
    fireEvent.click(within(row).getByLabelText('Clip options'))
    fireEvent.click(screen.getByText('Delete clip'))
    expect(useStore.getState().importedClipNames).toEqual(['Jump'])
    expect(rowOf('Wave')).toBeUndefined()
    expect(getCharacterClipDuration(1, 'Wave')).toBe(0)
  })

  it('offers no rename or delete for a built-in clip', () => {
    setup()
    const row = rowOf('Walk')
    fireEvent.click(within(row).getByLabelText('Clip options'))
    expect(screen.queryByText('Delete clip')).toBeNull()
    expect(screen.queryByText('Rename')).toBeNull()
    expect(screen.getByText('Trim…')).toBeTruthy()
  })

  it('renames inline and keeps the renamed clip selected', () => {
    setup()
    fireEvent.click(rowOf('Wave'))
    expect(useStore.getState().activeClipName).toBe('Wave')
    const row = rowOf('Wave')
    fireEvent.click(within(row).getByLabelText('Clip options'))
    fireEvent.click(screen.getByText('Rename'))
    const input = screen.getByLabelText('Name')
    fireEvent.change(input, { target: { value: 'Big wave' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useStore.getState().importedClipNames).toEqual(['Big wave', 'Jump'])
    expect(useStore.getState().activeClipName).toBe('Big wave')
  })

  it('deleting the active clip lands on a neighbouring clip', () => {
    setup()
    fireEvent.click(rowOf('Jump'))
    const row = rowOf('Jump')
    fireEvent.click(within(row).getByLabelText('Clip options'))
    fireEvent.click(screen.getByText('Delete clip'))
    expect(useStore.getState().activeClipName).toBe('Wave')
    expect(useStore.getState().playbackSource).toBe('clip')
  })

  it('combines checked clips in selection order without changing the active clip on check', () => {
    setup()
    const combine = screen.getByRole('button', { name: /^Combine/ })
    expect(combine.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Select Jump for combining'))
    expect(combine.disabled).toBe(true)
    expect(useStore.getState().activeClipName).toBeNull()
    fireEvent.click(screen.getByLabelText('Select Walk for combining'))
    expect(combine.disabled).toBe(false)
    expect(within(rowOf('Jump')).getByTitle('Combine order').textContent).toBe('1')
    expect(within(rowOf('Walk')).getByTitle('Combine order').textContent).toBe('2')
    fireEvent.click(combine)
    expect(useStore.getState().activeClipName).toBe('Jump + Walk')
    expect(useStore.getState().importedClipNames).toContain('Jump + Walk')
    expect(combine.disabled).toBe(true)
  })

  it('keeps selection consistent when clips are renamed or deleted with the row button', () => {
    setup()
    fireEvent.click(screen.getByLabelText('Select Wave for combining'))
    fireEvent.click(screen.getByLabelText('Select Jump for combining'))
    fireEvent.click(within(rowOf('Wave')).getByLabelText('Clip options'))
    fireEvent.click(screen.getByText('Rename'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Big wave' } })
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' })
    expect(screen.getByLabelText('Select Big wave for combining').checked).toBe(true)
    expect(screen.queryByLabelText('Delete Walk')).toBeNull()
    window.confirm.mockReturnValueOnce(false)
    fireEvent.click(screen.getByLabelText('Delete Jump'))
    expect(rowOf('Jump')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Combine/ }).disabled).toBe(false)
    fireEvent.click(screen.getByLabelText('Delete Jump'))
    expect(rowOf('Jump')).toBeUndefined()
    expect(screen.getByRole('button', { name: /^Combine/ }).disabled).toBe(true)
    expect(useStore.getState().activeClipName).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.getByLabelText('Select Big wave for combining').checked).toBe(false)
  })

  it('clears combine selection when changing characters, even if clip names overlap', () => {
    setup()
    fireEvent.click(screen.getByLabelText('Select Wave for combining'))
    fireEvent.click(screen.getByLabelText('Select Walk for combining'))
    act(() => useStore.setState({ activeCharacterId: 2 }))
    expect(screen.getByLabelText('Select Wave for combining').checked).toBe(false)
    expect(screen.getByRole('button', { name: /^Combine/ }).disabled).toBe(true)
  })
})
