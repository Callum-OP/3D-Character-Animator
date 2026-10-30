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

// A character that isn't the active one keeps its overrides in the roster (characters[id]).
const rosterId = (s, characterId) =>
  characterId != null && characterId !== s.activeCharacterId && s.characters[characterId] ? characterId : null
const overridesOf = (s, characterId) => {
  const id = rosterId(s, characterId)
  return id == null ? s.meshOverrides : s.characters[id].meshOverrides || {}
}

function restore(entries, characterId = null) {
  useStore.setState((s) => {
    const next = { ...overridesOf(s, characterId) }
    for (const [uuid, entry] of Object.entries(entries)) {
      if (entry === undefined) delete next[uuid]
      else next[uuid] = entry
    }
    const id = rosterId(s, characterId)
    if (id == null) return { meshOverrides: next }
    return { characters: { ...s.characters, [id]: { ...s.characters[id], meshOverrides: next } } }
  })
  applyModelMaterials()
}

// Run `mutate` (which edits store.meshOverrides for `uuids`) and record it as an undo step.
export function recordOverrideEdit(uuids, mutate, characterId = null) {
  const list = [...new Set(uuids)]
  const read = () => {
    const overrides = overridesOf(useStore.getState(), characterId)
    return Object.fromEntries(list.map((u) => [u, overrides[u] === undefined ? undefined : JSON.parse(JSON.stringify(overrides[u]))]))
  }
  const before = read()
  mutate()
  const after = read()
  if (list.every((u) => same(before[u], after[u]))) return

  const key = (characterId != null ? characterId + ':' : '') + list.slice().sort().join(',')
  const now = Date.now()
  if (last && last.key === key && last.epoch === getHistoryEpoch() && last.seq === getHistorySequence() && now - last.time < COALESCE_MS) {
    last.after = after
    last.time = now
    return
  }
  const rec = { key, before, after, time: now, seq: 0, epoch: getHistoryEpoch() }
  pushSceneHistory(
    () => restore(rec.before, characterId),
    () => restore(rec.after, characterId),
  )
  rec.seq = getHistorySequence()
  last = rec
}

// Switch per-part looks (transparency, ink outline, casts shadows) for one or more parts, as ONE
// undo step, and re-apply the materials. patch: { alpha?, outline?, castShadow? }.
export function setPartLook(uuids, patch, characterId = null) {
  const list = [...new Set(uuids || [])]
  if (!list.length) return
  recordOverrideEdit(list, () => useStore.getState().setMeshesLook(list, patch, characterId), characterId)
  applyModelMaterials()
}
