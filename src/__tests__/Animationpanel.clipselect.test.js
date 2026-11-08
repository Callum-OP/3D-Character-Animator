import { afterEach, describe, it, vi, expect } from 'vitest'
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react'
import React from 'react'

// The clip dropdown looked dead whenever another character was playing: the Animate panel re-renders every
// frame (currentTime / globalTime) and React re-applied `selected` on the open native <select>'s options each
// time, which makes the browser close the popup immediately. The select must not be touched by those ticks.

vi.mock('../three/Viewport.jsx', () => ({
  default: () => React.createElement('div', { 'data-testid': 'viewport-stub' }),
}))

// Choosing a clip drives the real animation engine, which needs a loaded character and a scene to work
// against. These tests are about the dropdown, so the engine calls are stubbed.
vi.mock('../three/animation.js', async (importOriginal) => ({
  ...(await importOriginal()),
  stop: vi.fn(),
  selectClip: vi.fn(() => 1),
  describeClipBoneMismatch: vi.fn(() => null),
  getClipEditKeys: vi.fn(() => null),
  markClipKeysAdopted: vi.fn(),
}))

import App from '../App.jsx'
import { useStore } from '../store.js'

describe('Animate panel clip dropdown', () => {
  afterEach(cleanup)

  it('is left alone while the panel re-renders every frame', async () => {
    useStore.setState({
      modelInfo: { name: 'TestChar', bones: [{ name: 'Hips', deform: true, depth: 0 }], meshCount: 1, boneCount: 1, clipNames: ['Walk', 'Run'] },
      mode: 'bone',
      sceneObjects: [{ id: 1, name: 'TestChar', isCharacter: true, characterId: 1, visible: true }],
      characterOrder: [1],
      activeCharacterId: 1,
      selectedObjectId: 1,
      importedClipNames: [],
      activeClipName: null,
      playback: 'stopped',
    })
    render(React.createElement(App))
    fireEvent.click(screen.getByText('Animate'))
    const select = screen.getByLabelText('Character motion clip')

    let writes = 0
    const proto = HTMLOptionElement.prototype
    const desc = Object.getOwnPropertyDescriptor(proto, 'selected')
    Object.defineProperty(proto, 'selected', {
      configurable: true,
      get: desc.get,
      set(v) { writes++; desc.set.call(this, v) },
    })
    try {
      for (let i = 0; i < 20; i++) {
        await act(async () => {
          useStore.setState({ currentTime: i / 30, globalTime: i / 30 })
        })
      }
    } finally {
      Object.defineProperty(proto, 'selected', desc)
    }
    expect(screen.getByLabelText('Character motion clip')).toBe(select)
    expect(writes).toBe(0)
  })

  it('still lists clips and changes the active clip', async () => {
    useStore.setState({
      modelInfo: { name: 'TestChar', bones: [{ name: 'Hips', deform: true, depth: 0 }], meshCount: 1, boneCount: 1, clipNames: ['Walk', 'Run'] },
      mode: 'bone',
      sceneObjects: [{ id: 1, name: 'TestChar', isCharacter: true, characterId: 1, visible: true }],
      characterOrder: [1],
      activeCharacterId: 1,
      selectedObjectId: 1,
      importedClipNames: ['Mocap'],
      activeClipName: null,
    })
    render(React.createElement(App))
    fireEvent.click(screen.getByText('Animate'))
    const select = screen.getByLabelText('Character motion clip')
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'Walk', 'Run', 'Mocap'])
    await act(async () => {
      fireEvent.change(select, { target: { value: 'Run' } })
    })
    expect(useStore.getState().activeClipName).toBe('Run')
  })
})
