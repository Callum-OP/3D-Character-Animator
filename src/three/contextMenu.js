import { useStore } from '../store.js'
import { copyCurrentEdit, pasteCurrentEdit, canPasteCurrentEdit } from './editClipboard.js'
import { removeObjectById, setObjectVisibleById, applyModelMaterials } from './scene.js'
import { removeLight, setLightVisible } from './lights.js'
import { removeCamera } from './cameras.js'

// ---------------------------------------------------------------------------
// Right-click menu for the viewport (Object mode)
//
// Logic only — the viewport decides WHEN to open it (see createRightClickGesture)
// and ViewportContextMenu.jsx draws it. A "target" is what was under the cursor:
//   { kind: 'objects', ids: [..] }   one or more props/characters/images
//   { kind: 'light',   id }
//   { kind: 'camera',  id }
//   { kind: 'empty' }                nothing — only Paste makes sense there
// ---------------------------------------------------------------------------

const SLOP_PX = 5 // same "this was a click, not a drag" threshold the viewport uses

// Opens the menu only for a genuine right-CLICK: the right button is also how
// you pan the view, so if the pointer travelled (a pan/drag) when it was
// released, no menu. Uses pointerup rather than the `contextmenu` event because
// macOS fires `contextmenu` on press — before a drag can even start.
export function createRightClickGesture({ onOpen, slop = SLOP_PX }) {
  let start = null
  return {
    pointerDown(e) {
      if (e.button === 2) start = { x: e.clientX, y: e.clientY, moved: false }
    },
    pointerMove(e) {
      if (!start) return
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > slop) start.moved = true
    },
    pointerUp(e) {
      if (e.button !== 2 || !start) return
      const moved = start.moved || Math.hypot(e.clientX - start.x, e.clientY - start.y) > slop
      start = null
      if (!moved) onOpen(e)
    },
    cancel() {
      start = null
    },
  }
}

// Work out what's under the cursor. Camera and light markers win over objects
// (as in a left-click). A right-clicked character that isn't the active one
// becomes it, same as a left-click. Right-clicking something that's part of a
// multi-selection targets the whole selection. `api` supplies the pickers so
// this stays testable without a WebGL scene.
export function resolveContextTarget(ndcX, ndcY, state, api) {
  const cameraId = api.pickCameraId(ndcX, ndcY)
  if (cameraId != null) return { kind: 'camera', id: cameraId }
  const lightId = api.pickLightId(ndcX, ndcY)
  if (lightId != null) return { kind: 'light', id: lightId }
  const hitId = api.pickObjectId(ndcX, ndcY)
  if (hitId == null) return { kind: 'empty' }
  if (api.isCharacterId(hitId) && hitId !== state.activeCharacterId) api.setActiveCharacter(hitId)
  const sel = state.selectedObjectIds
  return { kind: 'objects', ids: sel.length > 1 && sel.includes(hitId) ? [...sel] : [hitId] }
}

// Make the thing that was right-clicked the selection (so Copy/Hide/Delete act on
// it, and the gizmo shows). Right-clicking something that's already part of a
// multi-selection keeps the whole selection, like most apps.
export function selectContextTarget(target, state = useStore.getState()) {
  if (!target) return
  if (target.kind === 'camera') state.setSelectedCameraId(target.id)
  else if (target.kind === 'light') state.setSelectedLightId(target.id)
  else if (target.kind === 'objects') {
    const alreadyIn = target.ids.length > 1 || state.selectedObjectIds.includes(target.ids[0])
    if (!alreadyIn) state.setSelectedObjectId(target.ids[0])
  }
}

export function getContextMenuItems(target, state = useStore.getState()) {
  const paste = { id: 'paste', label: 'Paste', shortcut: 'Ctrl+V', disabled: !canPasteCurrentEdit(state) }
  if (!target || target.kind === 'empty') return paste.disabled ? [] : [paste]

  const items = [{ id: 'copy', label: 'Copy', shortcut: 'Ctrl+C' }, paste]
  if (target.kind === 'objects') {
    const hidden = state.sceneObjects.find((o) => o.id === target.ids[0])?.visible === false
    items.push({ id: 'visibility', label: hidden ? 'Show' : 'Hide', shortcut: 'H' })
  } else if (target.kind === 'light') {
    const hidden = state.sceneLights.find((x) => x.id === target.id)?.visible === false
    items.push({ id: 'visibility', label: hidden ? 'Show' : 'Hide', shortcut: 'H' })
  }
  items.push({ separator: true })
  const count = target.kind === 'objects' ? target.ids.length : 1
  items.push({ id: 'delete', label: count > 1 ? `Delete ${count} objects` : 'Delete', danger: true })
  return items
}

export function runContextMenuAction(actionId, target, state = useStore.getState()) {
  if (actionId === 'paste') return pasteCurrentEdit(state)
  if (!target || target.kind === 'empty') return null

  if (actionId === 'copy') return copyCurrentEdit(state)

  if (actionId === 'visibility') {
    if (target.kind === 'objects') {
      // Flip the whole selection to the opposite of the first one's state, so a
      // mixed selection ends up uniform.
      const visible = state.sceneObjects.find((o) => o.id === target.ids[0])?.visible === false
      for (const id of target.ids) setObjectVisibleById(id, visible)
      return { visible }
    }
    if (target.kind === 'light') {
      const visible = state.sceneLights.find((x) => x.id === target.id)?.visible === false
      setLightVisible(target.id, visible)
      return { visible }
    }
    return null
  }

  if (actionId === 'delete') {
    if (target.kind === 'objects') {
      for (const id of target.ids) removeObjectById(id) // each is its own undo step
    } else if (target.kind === 'camera') {
      removeCamera(target.id)
    } else if (target.kind === 'light') {
      removeLight(target.id)
      // Same clean-up the Lights panel does when the removed light drove the rim light.
      if (state.rimFollowLightId === target.id) {
        state.setRimFollowLight(false)
        state.setRimFollowLightId(null)
        applyModelMaterials()
      }
    }
    return { deleted: true }
  }
  return null
}
