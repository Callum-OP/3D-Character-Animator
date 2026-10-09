import { describe, it, vi, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import React from 'react'
import * as THREE from 'three'

vi.mock('../three/Viewport.jsx', () => ({
  default: () => React.createElement('div', { 'data-testid': 'viewport-stub' }),
}))

// A character with a face split over two meshes, and a root to key.
const charRoot = new THREE.Group()
const hips = new THREE.Bone()
hips.name = 'Hips'
charRoot.add(hips)
const mesh = (names) => {
  const m = new THREE.Mesh() // a real scene node, so animation bindings can find it
  m.name = 'M'
  m.morphTargetDictionary = Object.fromEntries(names.map((n, i) => [n, i]))
  m.morphTargetInfluences = names.map(() => 0)
  charRoot.add(m)
  return m
}
const head = mesh(['Smile', 'Blink'])
const teeth = mesh(['Smile'])
const fakeModel = { root: charRoot, bones: [hips], meshes: [head, teeth], clips: [], info: {} }

vi.mock('../three/scene.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getCurrentModel: () => fakeModel }
})
vi.mock('../three/objects.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getObjectRootById: () => charRoot }
})

import App from '../App.jsx'
import { useStore } from '../store.js'
import { initAnimation, setAnimationModel } from '../three/animation.js'

const emptyAnim = () => ({ tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} })
const st = () => useStore.getState()

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
  setAnimationModel(fakeModel, 1)
  head.morphTargetInfluences.fill(0)
  teeth.morphTargetInfluences.fill(0)
  useStore.setState({
    modelInfo: { name: 'TestChar', bones: [{ name: 'Hips', deform: true, depth: 0 }], meshCount: 2, boneCount: 1, clipNames: [] },
    mode: 'object',
    playbackSource: 'edit',
    activeClipName: null,
    playback: 'stopped',
    animDuration: 4,
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
})
afterEach(cleanup)

describe('Shape keys in the Animate panel', () => {
  it('picking a shape key and pressing Key position saves its current value on every mesh that has it', () => {
    fireEvent.change(screen.getByLabelText('Shape key'), { target: { value: 'Smile' } })
    fireEvent.change(screen.getByLabelText('Smile shape key'), { target: { value: '0.8' } })
    fireEvent.click(screen.getByRole('button', { name: /Key position/ }))
    const morphs = st().animData.morphs
    expect(morphs[0].Smile).toEqual([{ time: 0, value: 0.8 }])
    expect(morphs[1].Smile).toEqual([{ time: 0, value: 0.8 }])
    expect(morphs[0].Blink).toBeUndefined() // untouched shape keys add nothing
    expect(st().animData.root).toHaveLength(1)
  })

  it('keying at another time with a different value adds a second key, and a key reset to 0 is keyed as 0', () => {
    fireEvent.change(screen.getByLabelText('Shape key'), { target: { value: 'Smile' } })
    fireEvent.change(screen.getByLabelText('Smile shape key'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: /Key position/ }))

    act_setTime(2)
    fireEvent.change(screen.getByLabelText('Smile shape key'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: /Key position/ }))

    expect(st().animData.morphs[0].Smile).toEqual([
      { time: 0, value: 1 },
      { time: 2, value: 0 }, // already has keys, so the 0 is kept and the smile fades out
    ])
  })

  it('a shape key set but never touched by the user is not keyed (no clutter on the timeline)', () => {
    fireEvent.click(screen.getByRole('button', { name: /Key position/ }))
    expect(st().animData.morphs).toEqual({})
    expect(st().animData.root).toHaveLength(1)
  })
})

function act_setTime(t) {
  act(() => useStore.setState({ currentTime: t, insertTime: t }))
}
