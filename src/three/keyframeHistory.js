import { useStore } from '../store.js'
import {
  registerUndoHistory,
  pushUndoBatch,
  markHistoryAction,
  getHistorySequence,
  isHistoryCaptureSuspended,
} from './undoHistory.js'
import { refreshEditPlayback } from './scene.js'
import { scrubObjectAnimation } from './objects.js'

// Undo/redo for keyframes — both the character timeline (joint/root/part/
// camera/light/morph keys, cuts) and object motion keys.
//
// Every keyframe edit in the app is a store mutation that replaces `animData`
// (per character) and/or `objectAnimData` with a new object, so rather than
// threading history calls through every button, this watches the store and
// records a before/after pair whenever either changes. Each pair is one undo
// step in its own 'keyframe' history, ordered against bone/mesh/object edits by
// the shared history sequence, so Ctrl+Z walks back through everything in the
// order it happened.

const stacks = { undo: [], redo: [] }
registerUndoHistory('keyframe', () => stacks)

const COALESCE_MS = 400 // rapid edits (dragging a slider, nudging a key) merge into one step
let applying = false
let lastRecord = { batch: null, at: 0 }

function charSnap(s) {
  return { animData: s.animData, animDuration: s.animDuration }
}
function objSnap(s) {
  return { objectAnimData: s.objectAnimData, objectAnimDuration: s.objectAnimDuration }
}

function record(s, prev) {
  if (applying || isHistoryCaptureSuspended()) return
  // Character data changing because the character itself changed (switched,
  // loaded, replaced, removed) is not a keyframe edit.
  const sameCharacter =
    s.activeCharacterId === prev.activeCharacterId && s.modelInfo === prev.modelInfo
  const charChanged = sameCharacter && s.animData !== prev.animData
  const objChanged = s.objectAnimData !== prev.objectAnimData
  if (!charChanged && !objChanged) return

  const now = Date.now()
  const top = stacks.undo[stacks.undo.length - 1]
  if (
    top &&
    top === lastRecord.batch &&
    now - lastRecord.at < COALESCE_MS &&
    top.historyOrder === getHistorySequence() &&
    top.characterId === s.activeCharacterId &&
    stacks.redo.length === 0
  ) {
    // Same gesture: keep the original "before", extend the "after".
    if (charChanged) {
      top.char = top.char ? { before: top.char.before, after: charSnap(s) } : { before: charSnap(prev), after: charSnap(s) }
    }
    if (objChanged) {
      top.obj = top.obj ? { before: top.obj.before, after: objSnap(s) } : { before: objSnap(prev), after: objSnap(s) }
    }
    lastRecord.at = now
    return
  }

  const batch = {
    entries: [],
    characterId: s.activeCharacterId,
    char: charChanged ? { before: charSnap(prev), after: charSnap(s) } : null,
    obj: objChanged ? { before: objSnap(prev), after: objSnap(s) } : null,
  }
  pushUndoBatch('keyframe', batch)
  lastRecord = { batch, at: now }
}

let unsubscribe = null
export function startKeyframeHistory() {
  if (unsubscribe) return
  unsubscribe = useStore.subscribe(record)
}
startKeyframeHistory()

function applyBatch(batch, which) {
  const s = useStore.getState()
  const patch = {}
  let touchedActiveChar = false
  if (batch.char) {
    const snap = batch.char[which]
    if (batch.characterId === s.activeCharacterId) {
      patch.animData = snap.animData
      patch.animDuration = snap.animDuration
      touchedActiveChar = true
    } else if (s.characters[batch.characterId]) {
      // That character isn't the one on screen any more; its saved timeline
      // lives in the per-character registry.
      patch.characters = {
        ...s.characters,
        [batch.characterId]: { ...s.characters[batch.characterId], animData: snap.animData },
      }
    }
  }
  if (batch.obj) {
    const snap = batch.obj[which]
    patch.objectAnimData = snap.objectAnimData
    patch.objectAnimDuration = snap.objectAnimDuration
  }
  applying = true
  try {
    useStore.setState(patch)
  } finally {
    applying = false
  }
  if (touchedActiveChar) refreshEditPlayback()
  if (batch.obj && !useStore.getState().objectAnimPlaying) {
    scrubObjectAnimation(useStore.getState().objectAnimTime)
  }
  lastRecord = { batch: null, at: 0 }
}

export function undo() {
  const batch = stacks.undo.pop()
  if (!batch) return
  applyBatch(batch, 'before')
  markHistoryAction(batch)
  stacks.redo.push(batch)
}

export function redo() {
  const batch = stacks.redo.pop()
  if (!batch) return
  applyBatch(batch, 'after')
  markHistoryAction(batch)
  stacks.undo.push(batch)
}
