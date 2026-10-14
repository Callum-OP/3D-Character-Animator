import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { __setViewCameraRefsForTest, dollyViewport } from '../three/scene.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory, getHistorySequence } from '../three/undoHistory.js'

const ctx = () => ({ selectedObjectId: null, mode: 'bone' })
let cam, controls

function setup({ clamp = false } = {}) {
  cam = new THREE.PerspectiveCamera()
  cam.position.set(0, 1, 5)
  const dist = cam.position.distanceTo(new THREE.Vector3(0, 1, 0))
  controls = {
    target: new THREE.Vector3(0, 1, 0),
    update() {},
    enabled: true,
    locked: false,
    minDistance: clamp ? dist : 0.1,
    maxDistance: clamp ? dist : 500,
  }
  __setViewCameraRefsForTest(cam, controls)
}

beforeEach(() => {
  vi.useFakeTimers()
  useStore.setState({
    cameraIgnoresUndo: false,
    activeCharacterId: 1,
    animData: { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} },
  })
  clearUndoHistory() // after the reset above — it is itself a recorded edit
  vi.setSystemTime(Date.now() + 1000)
})
afterEach(() => vi.useRealTimers())

describe('the view camera in undo history', () => {
  it('a zoom that really moves the view is recorded, and undo/redo put the view back / forward', () => {
    setup()
    const start = cam.position.clone()
    dollyViewport(-3)
    vi.advanceTimersByTime(500)
    const moved = cam.position.clone()
    expect(moved.distanceTo(start)).toBeGreaterThan(0.01)
    performUndo(ctx())
    expect(cam.position.distanceTo(start)).toBeLessThan(1e-6)
    performRedo(ctx())
    expect(cam.position.distanceTo(moved)).toBeLessThan(1e-6)
  })

  it('a view change that goes nowhere (clamped zoom — like a plain click) records nothing', () => {
    setup({ clamp: true })
    const before = getHistorySequence()
    dollyViewport(-3)
    vi.advanceTimersByTime(500)
    expect(getHistorySequence()).toBe(before)
  })

  it('so it no longer wipes the redo history of your real edits', () => {
    setup({ clamp: true })
    useStore.getState().addKeyframe('Hips', 0, [0, 0, 0, 1])
    vi.setSystemTime(Date.now() + 1000)
    performUndo(ctx()) // undo the keyframe → there is now something to redo
    expect(useStore.getState().animData.tracks.Hips ?? []).toHaveLength(0)
    dollyViewport(-3) // a "click on the canvas"
    vi.advanceTimersByTime(500)
    performRedo(ctx())
    expect(useStore.getState().animData.tracks.Hips).toHaveLength(1) // redo survived
  })

  it('the first undo after a click on the canvas undoes your last edit, not an empty step', () => {
    setup({ clamp: true })
    useStore.getState().addKeyframe('Hips', 0, [0, 0, 0, 1])
    dollyViewport(-3)
    vi.advanceTimersByTime(500)
    performUndo(ctx())
    expect(useStore.getState().animData.tracks.Hips ?? []).toHaveLength(0)
  })

  it('with "camera is not affected by undo/redo" on, even a real zoom is not recorded', () => {
    setup()
    useStore.setState({ cameraIgnoresUndo: true })
    const before = getHistorySequence()
    dollyViewport(-3)
    vi.advanceTimersByTime(500)
    expect(getHistorySequence()).toBe(before)
  })
})
