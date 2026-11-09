import { markHistoryAction, pushUndoBatch, registerUndoHistory } from './undoHistory.js'

const history = { undo: [], redo: [] }

registerUndoHistory('scene', () => history)

// While a group is open, every step pushed is collected instead, then recorded as ONE step when the group ends
// (undo runs them last to first). Used when one action makes several edits, e.g. copying effects between characters.
let group = null

export function runAsOneSceneStep(fn) {
  if (group) return fn()
  group = []
  try {
    return fn()
  } finally {
    const steps = group
    group = null
    if (steps.length === 1) pushSceneHistory(steps[0].undo, steps[0].redo, steps[0].discard)
    else if (steps.length > 1) {
      pushSceneHistory(
        () => [...steps].reverse().forEach((step) => step.undo()),
        () => steps.forEach((step) => step.redo()),
        () => steps.forEach((step) => step.discard?.()),
      )
    }
  }
}

export function pushSceneHistory(undo, redo, discard) {
  if (group) {
    group.push({ undo, redo, discard })
    return
  }
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
