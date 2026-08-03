import { describe, it, expect } from 'vitest'
import { resolveUndoTarget } from '../three/undoPriority.js'

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
})