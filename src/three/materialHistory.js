import { useStore } from '../store.js'
import { pushSceneHistory } from './sceneHistory.js'
import { getHistorySequence, getHistoryEpoch } from './undoHistory.js'
import { applyModelMaterials } from './scene.js'

// Undo / redo for edits to a part's look: colour, the Material editor (per-material colour,
// surface presets, colour replace) and regions. All of it lives in the per-mesh override map
// (store.meshOverrides), so one recorder covers every one of them: it snapshots the override
// entries of the parts being edited before and after, and the undo / redo steps put those
// entries back and re-apply the materials.
//
// Dragging a slider fires dozens of edits a second; consecutive edits to the same parts within
// COALESCE_MS (with nothing else recorded in between) merge into ONE undo step.
const COALESCE_MS = 800
let last = null

const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b)

function restore(entries) {
  useStore.setState((s) => {
    const next = { ...s.meshOverrides }
    for (const [uuid, entry] of Object.entries(entries)) {
      if (entry === undefined) delete next[uuid]
      else next[uuid] = entry
    }
    return { meshOverrides: next }
  })
  applyModelMaterials()
}

// Run `mutate` (which edits store.meshOverrides for `uuids`) and record it as an undo step.
export function recordOverrideEdit(uuids, mutate) {
  const list = [...new Set(uuids)]
  const read = () => {
    const overrides = useStore.getState().meshOverrides
    return Object.fromEntries(list.map((u) => [u, overrides[u] === undefined ? undefined : JSON.parse(JSON.stringify(overrides[u]))]))
  }
  const before = read()
  mutate()
  const after = read()
  if (list.every((u) => same(before[u], after[u]))) return

  const key = list.slice().sort().join(',')
  const now = Date.now()
  if (last && last.key === key && last.epoch === getHistoryEpoch() && last.seq === getHistorySequence() && now - last.time < COALESCE_MS) {
    last.after = after
    last.time = now
    return
  }
  const rec = { key, before, after, time: now, seq: 0, epoch: getHistoryEpoch() }
  pushSceneHistory(
    () => restore(rec.before),
    () => restore(rec.after),
  )
  rec.seq = getHistorySequence()
  last = rec
}
