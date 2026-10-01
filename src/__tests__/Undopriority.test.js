import { describe, it, expect } from 'vitest'
import { resolveUndoTarget } from '../three/undoPriority.js'
import {
  markHistoryAction,
  pushUndoBatch,
  registerUndoHistory,
  setUndoHistoryLimit,
} from '../three/undoHistory.js'
import { useStore } from '../store.js'

// Regression coverage for "object movements or resize don't undo". The root
// cause: mode defaults to 'bone' and stays there for most sessions (people
// rarely switch away from it just to move a prop), so a naive
// mode-first check routed Ctrl+Z to the bone-posing history even when a
// scene object was selected and had just been moved/resized.
describe('resolveUndoTarget', () => {
  it('prefers the selected scene object over the current mode', () => {
    expect(resolveUndoTarget({ selectedObjectId: 'obj-1', mode: 'bone' })).toBe('object')
    expect(resolveUndoTarget({ selectedObjectId: 'obj-1', mode: 'mesh' })).toBe('object')
  })

  it('falls back to mesh-edit history in mesh mode with nothing selected', () => {
    expect(resolveUndoTarget({ selectedObjectId: null, mode: 'mesh' })).toBe('mesh')
  })

  it('falls back to bone-pose history in bone mode with nothing selected', () => {
    expect(resolveUndoTarget({ selectedObjectId: null, mode: 'bone' })).toBe('bone')
  })

  it('defaults to bone history for any other/unknown mode with nothing selected', () => {
    expect(resolveUndoTarget({ selectedObjectId: null, mode: 'view' })).toBe('bone')
  })

  it('routes interleaved undo and redo by latest history and applies the cap', () => {
    const bone = { undo: [], redo: [] }
    const mesh = { undo: [], redo: [] }
    registerUndoHistory('bone', () => bone)
    registerUndoHistory('mesh', () => mesh)
    setUndoHistoryLimit(2)

    pushUndoBatch('bone', { id: 'pose' })
    pushUndoBatch('mesh', { id: 'mesh-edit' })
    expect(resolveUndoTarget({ mode: 'bone' })).toBe('mesh')

    const undoneMeshEdit = mesh.undo.pop()
    markHistoryAction(undoneMeshEdit)
    mesh.redo.push(undoneMeshEdit)
    expect(resolveUndoTarget({ mode: 'bone' })).toBe('bone')
    expect(resolveUndoTarget({ mode: 'bone' }, 'redo')).toBe('mesh')

    pushUndoBatch('bone', { id: 'pose-2' })
    expect(mesh.redo).toHaveLength(0)
    pushUndoBatch('bone', { id: 'pose-3' })
    expect(bone.undo.map((batch) => batch.id)).toEqual(['pose-2', 'pose-3'])
    setUndoHistoryLimit(100)
  })

  it('persists the history limit as an app-wide preference', () => {
    useStore.getState().setUndoLimit(18)
    expect(useStore.getState().undoLimit).toBe(18)
    expect(JSON.parse(localStorage.getItem('3d-animator-app-settings')).undoLimit).toBe(18)
    useStore.getState().setUndoLimit(100)
  })
})