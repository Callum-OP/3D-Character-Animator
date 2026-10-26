import { useStore } from '../store.js'
import {
  registerUndoHistory,
  pushUndoBatch,
  markHistoryAction,
  getHistorySequence,
  getHistoryEpoch,
  isHistoryCaptureSuspended,
} from './undoHistory.js'

// Undo/redo for the Look panel: everything on the Lighting tab (style, shadow steps, grading,
// rim / backlight / outline / soften, scene-light direction and intensity, shadow style) and the
// Material tab. They are plain store settings, so — like the keyframe history — this watches the
// store and records a before/after pair for whichever of them changed. Only the settings that
// changed are stored, so undoing one never rolls back another.
//
// Dragging a slider changes a value many times a second; changes made within COALESCE_MS of each
// other (with nothing else done in between) merge into ONE step.

const stacks = { undo: [], redo: [] }
registerUndoHistory('look', () => stacks)

export const LOOK_HISTORY_KEYS = [
  // Lighting tab
  'materialMode', 'toonSteps', 'colorGrading', 'ambientOcclusionStrength',
  'backlightColor', 'backlightFalloff', 'lightLinks',
  'rimLightColor', 'rimSideOnly', 'rimSoftEnabled', 'rimSoftIntensity', 'rimSoftWidth',
  'rimHardEnabled', 'rimHardIntensity', 'rimHardWidth', 'rimFollowLight', 'rimFollowLightId',
  'lightIntensity', 'lightAzimuth', 'lightElevation', 'defaultLightingEnabled',
  'envLightingEnabled', 'envLightingIntensity',
  'outlineEnabled', 'outlineWidth', 'outlineColor', 'outlineOpacity',
  'softenEnabled', 'softenAmount', 'shadows', 'night',
  // Material tab
  'materialLook',
]

const COALESCE_MS = 500
let applying = false
let lastRecord = { batch: null, at: 0, epoch: 0 }

function pick(source, keys) {
  const out = {}
  for (const key of keys) out[key] = source[key]
  return out
}

function record(state, previous) {
  if (applying || isHistoryCaptureSuspended()) return
  const changed = LOOK_HISTORY_KEYS.filter((key) => state[key] !== previous[key])
  if (!changed.length) return

  const now = Date.now()
  const top = stacks.undo[stacks.undo.length - 1]
  if (
    top &&
    top === lastRecord.batch &&
    lastRecord.epoch === getHistoryEpoch() &&
    now - lastRecord.at < COALESCE_MS &&
    top.historyOrder === getHistorySequence() &&
    stacks.redo.length === 0
  ) {
    // Same gesture: keep the original "before" of every setting already in it, and take the
    // "before" of any newly touched one from just now.
    for (const key of changed) {
      if (!(key in top.before)) top.before[key] = previous[key]
      top.after[key] = state[key]
    }
    lastRecord.at = now
    return
  }

  const batch = { entries: [], kind: 'look', before: pick(previous, changed), after: pick(state, changed) }
  pushUndoBatch('look', batch)
  lastRecord = { batch, at: now, epoch: getHistoryEpoch() }
}

let unsubscribe = null
export function startLookHistory() {
  if (unsubscribe) return
  unsubscribe = useStore.subscribe(record)
}
startLookHistory()

function applyBatch(batch, which) {
  applying = true
  try {
    useStore.setState({ ...batch[which] })
  } finally {
    applying = false
  }
  lastRecord = { batch: null, at: 0, epoch: 0 }
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
