import { useStore } from '../store.js'
import { copyCurrentEdit, pasteCurrentEdit, canPasteCurrentEdit } from './editClipboard.js'
import {
  removeObjectById,
  setObjectVisibleById,
  applyModelMaterials,
  setMeshVisibleByUuid,
  setMeshesVisibleByUuids,
  setCameraToMesh,
  extractPartsToObject,
  mergeObjectsToOne,
} from './scene.js'
import { resetMesh, resetMeshes } from './meshedit.js'
import { removeLight, setLightVisible } from './lights.js'
import { removeCamera } from './cameras.js'

// ---------------------------------------------------------------------------
// Right-click menu for the viewport (Object mode)
//
// Logic only — the viewport decides WHEN to open it (see createRightClickGesture)
// and ViewportContextMenu.jsx draws it. A "target" is what was under the cursor:
//   { kind: 'objects', ids: [..] }   one or more props/characters/images (Object mode)
//   { kind: 'meshes',  uuids: [..] } one or more parts of a model (Mesh mode)
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
  if (state.mode === 'mesh') {
    const uuid = api.pickMeshUuid ? api.pickMeshUuid(ndcX, ndcY) : null
    if (uuid == null) return { kind: 'empty' }
    const sel = state.selectedMeshUuids || []
    return { kind: 'meshes', uuids: sel.length > 1 && sel.includes(uuid) ? [...sel] : [uuid] }
  }
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
  if (target.kind === 'meshes') {
    const alreadyIn = target.uuids.length > 1 || (state.selectedMeshUuids || []).includes(target.uuids[0])
    if (!alreadyIn) state.setSelectedMeshUuid(target.uuids[0])
  } else if (target.kind === 'camera') state.setSelectedCameraId(target.id)
  else if (target.kind === 'light') state.setSelectedLightId(target.id)
  else if (target.kind === 'objects') {
    const alreadyIn = target.ids.length > 1 || state.selectedObjectIds.includes(target.ids[0])
    if (!alreadyIn) state.setSelectedObjectId(target.ids[0])
  }
}

export function getContextMenuItems(target, state = useStore.getState()) {
  const paste = { id: 'paste', label: 'Paste', shortcut: 'Ctrl+V', disabled: !canPasteCurrentEdit(state) }
  if (!target || target.kind === 'empty') return paste.disabled ? [] : [paste]

  if (target.kind === 'meshes') return getPartMenuItems(target, state, paste)

  const items = [{ id: 'copy', label: 'Copy', shortcut: 'Ctrl+C' }, paste]
  if (target.kind === 'objects') {
    const hidden = state.sceneObjects.find((o) => o.id === target.ids[0])?.visible === false
    items.push({ id: 'visibility', label: hidden ? 'Show' : 'Hide', shortcut: 'H' })
    if (canMerge(target.ids, state)) {
      items.push({ id: 'merge', label: `Merge ${target.ids.length} objects into one`, hint: 'Join them into a single object; attached lights and cameras follow it' })
    }
  } else if (target.kind === 'light') {
    const hidden = state.sceneLights.find((x) => x.id === target.id)?.visible === false
    items.push({ id: 'visibility', label: hidden ? 'Show' : 'Hide', shortcut: 'H' })
  }
  items.push({ separator: true })
  const count = target.kind === 'objects' ? target.ids.length : 1
  items.push({ id: 'delete', label: count > 1 ? `Delete ${count} objects` : 'Delete', danger: true })
  return items
}

// Two or more selected 3D models (not characters or images) can be merged into one object.
function canMerge(ids, state) {
  if (ids.length < 2) return false
  const chosen = ids.map((id) => state.sceneObjects.find((o) => o.id === id))
  return chosen.every((o) => o && !o.isCharacter && o.kind === 'model')
}

// The menu for right-clicking a part in Mesh mode.
function getPartMenuItems(target, state, paste) {
  const count = target.uuids.length
  const hidden = state.meshOverrides[target.uuids[0]]?.visible === false
  return [
    { id: 'copy', label: 'Copy', shortcut: 'Ctrl+C', hint: "Copy this part's move / rotate / resize" },
    paste,
    { id: 'visibility', label: hidden ? 'Show' : 'Hide', shortcut: 'H' },
    { separator: true },
    { id: 'reset', label: count > 1 ? `Reset ${count} parts` : 'Reset part', hint: 'Put the part back where it started' },
    ...(count === 1 ? [{ id: 'frame', label: 'Frame in viewport', shortcut: 'F' }] : []),
    { separator: true },
    { id: 'extract', label: count > 1 ? `Extract ${count} parts to an object` : 'Extract to object', hint: 'Move the part(s) out into an object of their own (the originals are hidden)' },
    { id: 'copyOut', label: 'Copy to object', hint: 'Make a new object from the part(s) and leave the originals in place' },
  ]
}

function runPartAction(actionId, target, state) {
  const uuids = target.uuids
  if (actionId === 'visibility') {
    const visible = state.meshOverrides[uuids[0]]?.visible === false
    if (uuids.length > 1) setMeshesVisibleByUuids(uuids, visible)
    else setMeshVisibleByUuid(uuids[0], visible)
    return { visible }
  }
  if (actionId === 'reset') {
    if (uuids.length > 1) resetMeshes(uuids)
    else resetMesh(uuids[0])
    return { reset: true }
  }
  if (actionId === 'frame') return setCameraToMesh(uuids[0])
  if (actionId === 'extract' || actionId === 'copyOut') {
    return extractPartsToObject(uuids, { removeOriginals: actionId === 'extract' }).then((r) => {
      useStore.getState().setLoadNotice(r.message)
      return r
    })
  }
  return null
}

export function runContextMenuAction(actionId, target, state = useStore.getState()) {
  if (actionId === 'paste') return pasteCurrentEdit(state)
  if (!target || target.kind === 'empty') return null

  if (actionId === 'copy') return copyCurrentEdit(state)
  if (target.kind === 'meshes') return runPartAction(actionId, target, state)

  if (actionId === 'merge' && target.kind === 'objects') {
    return mergeObjectsToOne(target.ids).then((r) => {
      useStore.getState().setLoadNotice(r.message)
      return r
    })
  }

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
