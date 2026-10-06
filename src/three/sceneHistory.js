import { markHistoryAction, pushUndoBatch, registerUndoHistory } from './undoHistory.js'

const history = { undo: [], redo: [] }

registerUndoHistory('scene', () => history)

export function pushSceneHistory(undo, redo, discard) {
  pushUndoBatch('scene', {
    run(direction) {
      if (direction === 'undo') undo()
      else redo()
    },
    discard,
  })
}

export function undoScene() {
  const batch = history.undo.pop()
  if (!batch) return
  batch.run('undo')
  markHistoryAction(batch)
  history.redo.push(batch)
}

export function redoScene() {
  const batch = history.redo.pop()
  if (!batch) return
  batch.run('redo')
  markHistoryAction(batch)
  history.undo.push(batch)
}
