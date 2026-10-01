import { resolveUndoHistoryTarget } from './undoHistory.js'
import { undo as undoObject, redo as redoObject } from './objects.js'
import { undo as undoMesh, redo as redoMesh } from './meshedit.js'
import { undo as undoPose, redo as redoPose } from './posing.js'

export function resolveUndoTarget(state, direction = 'undo') {
  return resolveUndoHistoryTarget(state, direction)
}

export function performUndo(state) {
  const target = resolveUndoTarget(state, 'undo')
  if (target === 'object') undoObject()
  else if (target === 'mesh') undoMesh()
  else undoPose()
}

export function performRedo(state) {
  const target = resolveUndoTarget(state, 'redo')
  if (target === 'object') redoObject()
  else if (target === 'mesh') redoMesh()
  else redoPose()
}