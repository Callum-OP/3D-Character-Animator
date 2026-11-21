import { confirmDialog } from '../dialogs.js'
import { useStore } from '../store.js'
import { runWithoutHistoryCapture } from './undoHistory.js'
import {
  stop,
  selectClip,
  selectEdit,
  getClipEditKeys,
  markClipKeysAdopted,
  describeClipBoneMismatch,
} from './animation.js'

// Choosing which clip the active character plays. The Animate panel and the title bar's
// Animation menu both go through here, so picking a clip does exactly the same thing from either.

// A clip made with "Save as clip" remembers the keyframes it was built from. Selecting it loads
// those keys back into the editor so edits rebuild the clip rather than only touching a live
// overlay. Returns true when the editor now mirrors the clip's keys. Never silently throws away
// unsaved keyframes: it asks first.
export function adoptClipKeys(name) {
  const st = useStore.getState
  const keys = name ? getClipEditKeys(name) : null
  if (!keys) {
    markClipKeysAdopted(null)
    return false
  }
  const cur = st().animData
  const fingerprint = (tracks, root) => JSON.stringify([tracks || {}, root || []])
  if (fingerprint(cur.tracks, cur.root) !== fingerprint(keys.tracks, keys.root)) {
    const hasCurrent = Object.keys(cur.tracks || {}).length > 0 || (cur.root || []).length > 0
    if (
      hasCurrent &&
      !confirmDialog(
        `“${name}” remembers its own keyframes. Load them into the editor? This replaces the keyframes currently in “Edit keyframes” (they are not saved as a clip).`,
      )
    ) {
      markClipKeysAdopted(null)
      return false
    }
    runWithoutHistoryCapture(() => {
      st().setAnimData({ ...cur, tracks: keys.tracks, root: keys.root })
    })
  }
  markClipKeysAdopted(name)
  return true
}

// Make `name` the clip on screen, paused on its first frame. Returns the bone-mismatch warning
// for the clip (or null) so the caller can show it. `loop` / `speed` default to the store's.
export function switchToClip(name, { loop, speed } = {}) {
  const st = useStore.getState
  const opts = { loop: loop ?? st().loop, speed: speed ?? st().speed }
  st().setActiveClipName(name)
  stop()
  st().setPlaybackSource('clip')
  adoptClipKeys(name)
  const duration = selectClip(name, { ...opts, inPlace: st().removeClipMovement }, st().animData)
  st().setDuration(duration)
  st().setCurrentTime(0)
  st().setPlayback('paused')
  return describeClipBoneMismatch(name)
}

// Back to the character's own editable keyframe animation (no saved clip selected).
export function switchToEditAnimation({ loop, speed } = {}) {
  const st = useStore.getState
  stop()
  markClipKeysAdopted(null)
  st().setActiveClipName(null)
  st().setPlaybackSource('edit')
  st().setInsertTime(0)
  st().setCurrentTime(0)
  const duration = selectEdit(st().animData, st().animDuration, { loop: loop ?? st().loop, speed: speed ?? st().speed })
  st().setDuration(duration)
  st().setPlayback('paused')
}
