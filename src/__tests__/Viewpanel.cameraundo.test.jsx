import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'
import ViewPanel from '../panels/ViewPanel.jsx'
import { useStore } from '../store.js'
import { clearUndoHistory, hasUndoHistory } from '../three/undoHistory.js'
import '../three/keyframeHistory.js'

const st = () => useStore.getState()
const toggle = () => screen.getByLabelText('Camera is not affected by undo / redo')

beforeEach(() => {
  vi.useFakeTimers()
  useStore.setState({
    cameraIgnoresUndo: false,
    activeCharacterId: 1,
    animData: { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} },
  })
  clearUndoHistory()
  vi.setSystemTime(Date.now() + 1000)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('turning "camera is not affected by undo/redo" on or off', () => {
  it('with nothing to undo it just changes the setting — no prompt', () => {
    const confirm = vi.spyOn(window, 'confirm')
    render(<ViewPanel />)
    fireEvent.click(toggle())
    expect(confirm).not.toHaveBeenCalled()
    expect(st().cameraIgnoresUndo).toBe(true)
  })

  it('with history, it asks first; on OK it changes the setting and clears undo/redo', () => {
    st().addKeyframe('Hips', 0, [0, 0, 0, 1])
    expect(hasUndoHistory()).toBe(true)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ViewPanel />)
    fireEvent.click(toggle())
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toMatch(/clears your undo and redo history/)
    expect(st().cameraIgnoresUndo).toBe(true)
    expect(hasUndoHistory()).toBe(false)
  })

  it('on Cancel nothing changes: the setting stays and the history is kept', () => {
    st().addKeyframe('Hips', 0, [0, 0, 0, 1])
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ViewPanel />)
    fireEvent.click(toggle())
    expect(st().cameraIgnoresUndo).toBe(false)
    expect(hasUndoHistory()).toBe(true)
  })

  it('works the same turning it back OFF', () => {
    useStore.setState({ cameraIgnoresUndo: true })
    st().addKeyframe('Hips', 0, [0, 0, 0, 1])
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ViewPanel />)
    fireEvent.click(toggle())
    expect(st().cameraIgnoresUndo).toBe(false)
    expect(hasUndoHistory()).toBe(false)
  })

  it('a stale camera step recorded before the change can no longer be undone afterwards', () => {
    st().addCameraKeyframe('Cam', 0, { time: 0, pos: [1, 2, 3], quat: [0, 0, 0, 1] })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ViewPanel />)
    fireEvent.click(toggle())
    expect(hasUndoHistory()).toBe(false) // the old camera step is gone, so it can't replay against the new setting
  })
})
