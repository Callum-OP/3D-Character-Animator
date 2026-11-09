import { pushSceneHistory } from './sceneHistory.js'

// The faces picked in the Add bones editor, before (or while) a rig is made from them: part uuid -> face numbers.
// Lives here rather than in the panel so that every change to the picked area (a click, Grow, Shrink, Clear) is a
// step in the app's undo / redo, and Ctrl+Z / Ctrl+Y work on the area the same way they do everywhere else.
// Snapshots are never edited in place, so an undo step simply puts a whole earlier snapshot back.

let draft = {}
const listeners = new Set()

export const getPartRigDraft = () => draft

export function subscribePartRigDraft(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function publish(next) {
  draft = next
  listeners.forEach((listener) => listener())
}

const sameFaces = (a = [], b = []) => a.length === b.length && a.every((face, i) => face === b[i])

function sameDraft(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (!sameFaces(a[key], b[key])) return false
  return true
}

// Replace the picked area without recording anything: opening another part, starting an edit, finishing a rig.
export function resetPartRigDraft(next = {}) {
  publish({ ...next })
}

// Change the picked area as ONE undo step. `update` gets the current snapshot and returns the new one.
export function editPartRigDraft(update) {
  const before = draft
  const after = update(before)
  if (!after || sameDraft(before, after)) return
  publish(after)
  pushSceneHistory(
    () => publish(before),
    () => publish(after),
  )
}
