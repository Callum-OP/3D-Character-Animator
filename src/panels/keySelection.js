// Pure helpers for selecting several keyframe rows at once in the Animate
// panel (Ctrl/Cmd-click toggles a row, Shift-click selects a range). Kept free
// of React so the behaviour can be unit-tested directly.

const EPS = 1e-6

export function sameTime(a, b) {
  return Math.abs(a - b) <= EPS
}

export function isTimeSelected(selection, time) {
  return selection.some((t) => sameTime(t, time))
}

// Drop selected times that no longer have a key (deleted, moved, track switched).
export function pruneSelection(selection, times) {
  return selection.filter((t) => times.some((k) => sameTime(k, t)))
}

// Work out the new selection after a click on the row at `time`.
//  - toggle (Ctrl/Cmd): add/remove just that row
//  - shift: select the range from the anchor row to this row
//  - plain click: clears the multi-selection (caller still scrubs as before)
// `handled` is true when a modifier was used, so the caller should not also
// treat the click as a normal "jump to this key" click.
export function applyKeyClick({ selection, anchor, times, time, shift, toggle }) {
  if (!shift && !toggle) {
    return { selection: [], anchor: time, handled: false }
  }
  if (shift) {
    const sorted = [...times].sort((a, b) => a - b)
    const from = sorted.findIndex((t) => sameTime(t, anchor ?? time))
    const to = sorted.findIndex((t) => sameTime(t, time))
    if (to === -1) return { selection, anchor: anchor ?? time, handled: true }
    const start = from === -1 ? to : Math.min(from, to)
    const end = from === -1 ? to : Math.max(from, to)
    const range = sorted.slice(start, end + 1)
    const merged = toggle
      ? [...selection, ...range.filter((t) => !isTimeSelected(selection, t))]
      : range
    return { selection: merged, anchor: anchor ?? time, handled: true }
  }
  const next = isTimeSelected(selection, time)
    ? selection.filter((t) => !sameTime(t, time))
    : [...selection, time]
  return { selection: next, anchor: time, handled: true }
}

// Pressing × on a row deletes the whole selection if that row is part of it,
// otherwise just that one row (the original single-delete behaviour).
export function timesToDelete(selection, time) {
  return isTimeSelected(selection, time) ? [...selection] : [time]
}