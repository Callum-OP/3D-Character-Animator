const histories = new Map()
let sequence = 0
let historyLimit = 100

export function registerUndoHistory(domain, getStacks) {
  histories.set(domain, getStacks)
}

// A batch may carry a `discard()` hook, called when the batch is permanently
// dropped from history (trimmed off the end, or its redo branch overwritten by
// a new edit, or history cleared). Used by add/delete-object batches to free
// the Three.js resources of an object that is currently removed from the scene.
function discardBatch(batch) {
  if (batch && typeof batch.discard === 'function') {
    try { batch.discard() } catch { /* freeing resources is best-effort */ }
  }
}

export function pushUndoBatch(domain, batch) {
  const stacks = histories.get(domain)?.()
  if (!stacks) return
  batch.historyOrder = ++sequence
  stacks.undo.push(batch)
  for (const getHistory of histories.values()) {
    const redo = getHistory().redo
    const dropped = redo.splice(0, redo.length)
    dropped.forEach(discardBatch)
  }
  trimStack(stacks.undo)
}

// Latest history sequence number — lets a recorder check that nothing else has
// been pushed since its own last batch (used to coalesce rapid keyframe edits).
export function getHistorySequence() {
  return sequence
}

// While suspended, observers that auto-record history (the keyframe recorder)
// ignore store changes — for changes already covered by another history step.
let captureSuspended = 0
export function runWithoutHistoryCapture(fn) {
  captureSuspended++
  try {
    return fn()
  } finally {
    captureSuspended--
  }
}
export function isHistoryCaptureSuspended() {
  return captureSuspended > 0
}

// Empty every undo/redo stack (New Project / loading a project: nothing from
// the old scene can be meaningfully undone into the new one).
export function clearUndoHistory() {
  for (const getStacks of histories.values()) {
    const stacks = getStacks()
    stacks.undo.splice(0, stacks.undo.length).forEach(discardBatch)
    stacks.redo.splice(0, stacks.redo.length).forEach(discardBatch)
  }
}

export function markHistoryAction(batch) {
  if (batch) batch.historyOrder = ++sequence
}

export function setUndoHistoryLimit(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return historyLimit
  historyLimit = Math.max(1, Math.min(1000, Math.floor(parsed)))
  for (const getStacks of histories.values()) {
    const stacks = getStacks()
    trimStack(stacks.undo)
    trimStack(stacks.redo)
  }
  return historyLimit
}

export function resolveUndoHistoryTarget(state, direction = 'undo') {
  let selected = null
  let latestOrder = -1
  for (const [domain, getStacks] of histories) {
    const stack = getStacks()[direction]
    const order = stack.length ? stack[stack.length - 1].historyOrder || 0 : -1
    if (order > latestOrder) {
      latestOrder = order
      selected = domain
    }
  }
  return selected || fallbackTarget(state)
}

function trimStack(stack) {
  if (stack.length > historyLimit) stack.splice(0, stack.length - historyLimit).forEach(discardBatch)
}

function fallbackTarget(state) {
  if (state.selectedCameraId != null || state.selectedLightId != null) return 'scene'
  if (state.selectedObjectId != null) return 'object'
  if (state.mode === 'mesh') return 'mesh'
  return 'bone'
}