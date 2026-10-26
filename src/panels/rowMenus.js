import { useStore } from '../store.js'
import {
  removeObjectById,
  resetObjectById,
  setObjectVisibleById,
  setObjectStyleById,
  setObjectOutlineById,
  setObjectCastShadowById,
  setObjectNightImmuneById,
  setObjectShadowImmuneById,
  setObjectRimImmuneById,
  setObjectAttachmentById,
  keyObjectAttachmentById,
  clearObjectAttachmentTimeline,
  scrubAllTimeline,
  setCameraToObject,
  setCameraToMesh,
  getTransparentMeshUuidsForObject,
  setMeshVisibleByUuid,
  setMeshesVisibleByUuids,
  applyModelMaterials,
  attachCameraToObject,
  canAttachObjects,
  setObjectParentById,
  mergeObjectsToOne,
} from '../three/scene.js'
import { copyCurrentEdit, pasteCurrentEdit } from '../three/editClipboard.js'
import { copySceneItem, pasteSceneItem } from '../three/sceneClipboard.js'
import {
  setLightVisible,
  setLightCastShadow,
  setLightDirectional,
  setLightEffect,
  applyLightPreset,
  getLightKeyValue,
  LIGHT_PRESETS,
} from '../three/lights.js'
import { LIGHT_EFFECT_TYPES } from '../three/lightEffects.js'
import { removeCamera, snapCameraToView, getCameraKeyValue } from '../three/cameras.js'
import { resetMesh, resetMeshes } from '../three/meshedit.js'

// What each list row's menu contains, and what each entry does. The panels draw the menu
// (see rowMenu.jsx + ViewportContextMenu.jsx); everything here is plain functions so it
// can be tested without rendering anything.
//
// Every builder returns { items, run(id) }. Entries that are on/off switches carry
// `checked`, so the menu shows which state they're in.

// Per-object Look override. 'auto' means "match the character's Look panel settings live";
// everything else pins the prop to that style regardless of what the character is doing.
export const STYLE_OPTIONS = [
  { value: 'auto', label: 'Match scene' },
  { value: 'unlit', label: 'Flat colour' },
  { value: 'toon', label: 'Cartoon' },
  { value: 'soft', label: 'Soft Anime' },
  { value: 'standard', label: 'Studio' },
  { value: 'realistic', label: 'Realistic' },
]

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// ---------------------------------------------------------------------------
// Objects (props, images, characters)
// ---------------------------------------------------------------------------

// Which objects a right-click / ⋯ press on `row` acts on: the whole selection when the
// row is part of a multi-selection, otherwise just that row.
export function objectTargets(row, state = useStore.getState()) {
  const sel = state.selectedObjectIds || []
  if (sel.length > 1 && sel.includes(row.id)) {
    return state.sceneObjects.filter((o) => sel.includes(o.id))
  }
  return [row]
}

function alphaStateFor(object, state) {
  const meshes = getTransparentMeshUuidsForObject(object)
  if (!meshes.length) return null
  const overrides =
    object.isCharacter && object.id !== state.activeCharacterId
      ? state.characters?.[object.id]?.meshOverrides || {}
      : state.meshOverrides
  return { meshes, on: meshes.every((uuid) => overrides[uuid]?.alpha !== false) }
}

// ctx: { boneNames, keyAtPlayhead, setKeyAtPlayhead(bool), startRename(id), notify(msg) }
export function objectMenu(targets, ctx, state = useStore.getState()) {
  const first = targets[0]
  const count = targets.length
  const multi = count > 1
  const anyModel = targets.some((o) => o.kind === 'model')
  const alphaStates = targets.map((o) => ({ o, alpha: alphaStateFor(o, state) })).filter((x) => x.alpha)
  const props = targets.filter((o) => !o.isCharacter)
  const canAttach = !multi && !first.isCharacter && (ctx.boneNames || []).length > 0
  const attachData = canAttach ? state.objectAttachmentData?.[first.animationKey] : null
  const t = state.globalTime || 0

  const items = [{ header: multi ? plural(count, 'object') + ' selected' : first.isCharacter ? `${first.name} (character)` : first.name }]
  if (!multi) {
    items.push({ id: 'rename', label: 'Rename', shortcut: 'Dbl-click' })
    items.push({ id: 'duplicate', label: 'Duplicate' })
  } else if (targets.every((o) => !o.isCharacter && o.kind === 'model')) {
    items.push({
      id: 'merge',
      label: `Merge ${count} objects into one`,
      hint: 'Join them into a single object. Lights, cameras and props attached to any of them follow the new object.',
    })
  }
  items.push({ id: 'visibility', label: first.visible === false ? 'Show' : 'Hide', shortcut: 'H' })

  const look = []
  if (anyModel) {
    const current = first.kind === 'model' ? first.style || 'auto' : 'auto'
    look.push({
      label: 'Look',
      value: STYLE_OPTIONS.find((o) => o.value === current)?.label,
      hint: "How this prop is shaded — 'Match scene' follows the character's Look panel",
      children: STYLE_OPTIONS.map((o) => ({ id: 'style:' + o.value, label: o.label, checked: current === o.value })),
    })
    look.push({ id: 'outline', label: 'Ink outline', checked: !!first.outline, hint: 'Draw a cartoon ink outline around this prop' })
  }
  if (alphaStates.length) {
    look.push({
      id: 'alpha',
      label: 'Transparency',
      checked: alphaStates[0].alpha.on,
      hint: 'Turn off if inner parts (mouth, teeth) show through the skin — hair, lashes or glass that rely on it will look solid.',
    })
  }
  if (look.length) items.push({ separator: true }, ...look)

  items.push(
    { separator: true },
    { header: 'Light & shadow' },
    ...(anyModel ? [{ id: 'cast', label: 'Casts shadows', checked: first.castShadow !== false }] : []),
    {
      id: 'receive',
      label: 'Receives shadows',
      checked: !first.shadowImmune,
      hint: 'Off = shadows from other objects never fall on this (Night mode still applies)',
    },
    {
      id: 'rim',
      label: 'Ignore rim lighting',
      checked: !!first.rimImmune,
      hint: "On = the edge highlight from the Lighting tab's rim light never touches this",
    },
    {
      id: 'night',
      label: 'Darkens at night',
      checked: !first.nightImmune,
      hint: state.night?.enabled ? 'Off = stays in daylight when Night mode is on' : 'Only matters while Night mode is on',
    },
  )

  // Another prop to ride on (a flag on a pole, a gun on a car roof): follows every move of it.
  const parentChoices = !multi && !first.isCharacter
    ? state.sceneObjects.filter((o) => !o.isCharacter && canAttachObjects(first.id, o.id))
    : []
  const currentParent = !multi && first.attachedToObjectId != null ? state.sceneObjects.find((o) => o.id === first.attachedToObjectId) : null
  if (!multi && !first.isCharacter && (parentChoices.length || currentParent)) {
    items.push(
      { separator: true },
      { header: 'Attach' },
      {
        label: 'Attach to object',
        value: currentParent ? currentParent.name : 'None',
        hint: 'Parent this to another object so it follows it when that is moved, rotated or resized',
        children: [
          { id: 'parent:', label: 'Not attached', checked: !currentParent },
          { separator: true },
          ...parentChoices.map((o) => ({ id: 'parent:' + o.id, label: o.name, checked: first.attachedToObjectId === o.id })),
        ],
      },
    )
  }
  if (canAttach) {
    items.push(
      ...(parentChoices.length || currentParent ? [] : [{ separator: true }, { header: 'Attach' }]),
      {
        label: 'Attach to bone',
        value: first.attachedBoneName || 'None',
        hint: 'Parent this prop to a bone (e.g. a gun to a hand) so it follows posing and animation',
        children: [
          { id: 'bone:', label: 'Not attached', checked: !first.attachedBoneName },
          { separator: true },
          ...ctx.boneNames.map((name) => ({ id: 'bone:' + name, label: name, checked: first.attachedBoneName === name })),
        ],
      },
      {
        id: 'keyAtPlayhead',
        label: `Key changes at ${t.toFixed(2)}s`,
        checked: !!ctx.keyAtPlayhead,
        hint: 'When on, picking a bone keys the attachment at the playhead on the All animation timeline instead of changing it now',
      },
    )
    if (attachData) {
      items.push({
        label: 'Attachment keys',
        children: [
          ...(attachData.keys || []).map((key) => ({
            id: 'goto:' + key.time,
            label: `${key.boneName || 'Detach'} · ${key.time.toFixed(2)}s`,
          })),
          { separator: true },
          { id: 'clearKeys', label: 'Clear all keys', danger: true },
        ],
      })
    }
  }

  items.push(
    { separator: true },
    ...(!multi ? [{ id: 'frame', label: 'Frame in viewport', hint: 'Frame this object and orbit around it' }] : []),
    { id: 'reset', label: multi ? `Reset position (${count})` : 'Reset position' },
    { separator: true },
    { id: 'delete', label: multi ? `Delete ${count} objects` : first.isCharacter ? 'Delete character' : 'Delete', danger: true },
  )

  function run(id) {
    const st = useStore.getState()
    if (id === 'rename') return ctx.startRename?.(first.id)
    if (id === 'duplicate') {
      // The clipboard works on "the selected thing in Object mode", so make that this row.
      st.setMode('object')
      st.setSelectedObjectId(first.id)
      if (copyCurrentEdit(useStore.getState())) pasteCurrentEdit(useStore.getState())
      return
    }
    if (id === 'visibility') {
      const visible = first.visible === false
      for (const o of targets) setObjectVisibleById(o.id, visible)
      return
    }
    if (id.startsWith('style:')) {
      for (const o of targets.filter((x) => x.kind === 'model')) setObjectStyleById(o.id, id.slice(6))
      return
    }
    if (id === 'outline') {
      for (const o of targets.filter((x) => x.kind === 'model')) setObjectOutlineById(o.id, !first.outline)
      return
    }
    if (id === 'alpha') {
      const next = !alphaStates[0].alpha.on
      for (const { o, alpha } of alphaStates) st.setMeshesAlpha(alpha.meshes, next, o.isCharacter ? o.id : null)
      applyModelMaterials()
      return
    }
    if (id === 'cast') {
      for (const o of targets.filter((x) => x.kind === 'model')) setObjectCastShadowById(o.id, first.castShadow === false)
      return
    }
    if (id === 'receive') {
      for (const o of targets) setObjectShadowImmuneById(o.id, !first.shadowImmune)
      return
    }
    if (id === 'rim') {
      for (const o of targets) setObjectRimImmuneById(o.id, !first.rimImmune)
      return
    }
    if (id === 'night') {
      for (const o of targets) setObjectNightImmuneById(o.id, !first.nightImmune)
      return
    }
    if (id === 'merge') {
      return mergeObjectsToOne(targets.map((o) => o.id)).then((r) => ctx.notify?.(r.message))
    }
    if (id.startsWith('parent:')) {
      const raw = id.slice(7)
      const parentId = raw === '' ? null : parentChoices.find((o) => String(o.id) === raw)?.id
      if (raw !== '' && parentId == null) return
      if (!setObjectParentById(first.id, parentId)) ctx.notify?.("That would put an object inside itself — pick a different one.")
      return
    }
    if (id === 'keyAtPlayhead') return ctx.setKeyAtPlayhead?.(!ctx.keyAtPlayhead)
    if (id.startsWith('bone:')) {
      const boneName = id.slice(5) || null
      if (ctx.keyAtPlayhead) {
        const ok = keyObjectAttachmentById(first.id, boneName, t)
        ctx.notify?.(ok ? `Attachment keyed at ${t.toFixed(2)}s.` : `Could not find "${boneName}" on the active character.`)
      } else {
        setObjectAttachmentById(first.id, boneName)
      }
      return
    }
    if (id.startsWith('goto:')) return scrubAllTimeline(Number(id.slice(5)))
    if (id === 'clearKeys') {
      clearObjectAttachmentTimeline(first.id)
      ctx.notify?.('Timed attachment keys cleared.')
      return
    }
    if (id === 'frame') return setCameraToObject(first.id)
    if (id === 'reset') {
      for (const o of targets) resetObjectById(o.id)
      return
    }
    if (id === 'delete') {
      const message = multi
        ? `Are you sure you want to delete these ${count} objects?`
        : `Are you sure you want to delete this${first.isCharacter ? ' character' : ' object'}?`
      if (!window.confirm(message)) return
      for (const o of targets) removeObjectById(o.id) // each is its own undo step
    }
  }

  return { items, run }
}

// ---------------------------------------------------------------------------
// Lights
// ---------------------------------------------------------------------------

// ctx: { startRename(id), select(id), onRemove(id) }
export function lightMenu(light, ctx, state = useStore.getState()) {
  const effect = light.effect ? light.effect.type : ''
  const rim = state.rimFollowLight && state.rimFollowLightId === light.id
  const keyCount = (state.animData.lights?.[light.name] || []).length

  const items = [
    { header: light.name },
    { id: 'rename', label: 'Rename', shortcut: 'Dbl-click' },
    { id: 'duplicate', label: 'Duplicate' },
    { id: 'visibility', label: light.visible === false ? 'Show' : 'Hide', shortcut: 'H' },
    { separator: true },
    { id: 'cast', label: 'Casts shadows', checked: !!light.castShadow },
    { id: 'directional', label: 'Directional beam (cone)', checked: !!light.directional, hint: 'A cone aimed one way, like a torch or headlight. Off = shines every way, like a bulb.' },
    { id: 'rim', label: "Drives the rim light", checked: rim, hint: "This light's colour and direction control the character's rim light" },
    {
      label: 'Preset',
      hint: 'Turn this light into a ready-made one: bulb, floodlight, headlight, status LED…',
      children: LIGHT_PRESETS.map((p) => ({ id: 'preset:' + p.id, label: `${p.directional ? '🔦' : '💡'} ${p.label}`, hint: p.hint })),
    },
    {
      label: 'Animation',
      value: LIGHT_EFFECT_TYPES.find((e) => e.id === effect)?.label || 'None',
      children: [
        { id: 'effect:', label: 'None (steady)', checked: !effect },
        ...LIGHT_EFFECT_TYPES.map((e) => ({ id: 'effect:' + e.id, label: e.label, checked: effect === e.id, hint: e.hint })),
      ],
    },
    { separator: true },
    { id: 'key', label: keyCount ? `Key light (${keyCount})` : 'Key light', hint: "Save this light's position, colour and intensity at the Animate panel's insert time" },
    { separator: true },
    { id: 'delete', label: 'Delete', danger: true },
  ]

  function run(id) {
    const st = useStore.getState()
    if (id === 'rename') return ctx.startRename?.(light.id)
    if (id === 'duplicate') {
      if (copySceneItem('light', light.id)) pasteSceneItem('light')
      return
    }
    if (id === 'visibility') return setLightVisible(light.id, light.visible === false)
    if (id === 'cast') {
      setLightCastShadow(light.id, !light.castShadow)
      st.setLightCastShadow(light.id, !light.castShadow)
      return
    }
    if (id === 'directional') {
      setLightDirectional(light.id, !light.directional)
      st.setLightDirectional(light.id, !light.directional)
      return
    }
    if (id === 'rim') {
      st.setRimFollowLight(!rim)
      st.setRimFollowLightId(!rim ? light.id : null)
      applyModelMaterials()
      return
    }
    if (id.startsWith('preset:')) {
      const meta = applyLightPreset(light.id, id.slice(7))
      if (meta) st.patchSceneLight(light.id, meta)
      return
    }
    if (id.startsWith('effect:')) {
      const type = id.slice(7)
      const meta = setLightEffect(light.id, type ? { type } : null)
      if (meta) st.patchSceneLight(light.id, meta)
      return
    }
    if (id === 'key') {
      const key = getLightKeyValue(light.id)
      if (!key) return
      const snap = Math.round(st.insertTime * st.animFps) / st.animFps // snap to the fps grid
      st.addLightKeyframe(light.name, snap, { pos: key.pos, quat: key.quat, scale: key.scale, color: key.color, intensity: key.intensity })
      return
    }
    if (id === 'delete') ctx.onRemove?.(light.id)
  }

  return { items, run }
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

// ctx: { startRename(id) }
export function cameraMenu(camera, ctx, state = useStore.getState()) {
  const looking = state.viewCameraId === camera.id
  const keyCount = (state.animData.cameras?.[camera.name] || []).length
  const cutCount = (state.animData.cuts || []).filter((k) => k.camera === camera.name).length
  const attachedTo = state.cameraAttachments?.[camera.id] ?? null

  const items = [
    { header: camera.name },
    { id: 'rename', label: 'Rename', shortcut: 'Dbl-click' },
    { id: 'duplicate', label: 'Duplicate' },
    { id: 'look', label: 'Look through this camera', checked: looking, shortcut: '0', hint: 'See exactly what this camera sees — exports and videos film whatever the view shows' },
    { separator: true },
    { id: 'snap', label: 'Snap to current view', hint: 'Move this camera to match the free view' },
    { id: 'key', label: keyCount ? `Key camera (${keyCount})` : 'Key camera', hint: "Save this camera's position at the Animate panel's insert time" },
    { id: 'cut', label: cutCount ? `Cut to this camera here (${cutCount})` : 'Cut to this camera here', hint: 'Switch the view to this camera from the insert time on, until the next cut' },
    { separator: true },
    {
      label: 'Attach to',
      value: attachedTo != null ? state.sceneObjects.find((o) => o.id === attachedTo)?.name : 'Nothing',
      disabled: state.sceneObjects.length === 0,
      hint: 'Pick a prop or character and this camera rides along with it',
      children: [
        { id: 'attach:', label: 'Nothing (free-standing)', checked: attachedTo == null },
        { separator: true },
        ...state.sceneObjects.map((o) => ({ id: 'attach:' + o.id, label: o.name, checked: attachedTo === o.id })),
      ],
    },
    { separator: true },
    { id: 'delete', label: 'Delete', danger: true },
  ]

  function run(id) {
    const st = useStore.getState()
    if (id === 'rename') return ctx.startRename?.(camera.id)
    if (id === 'duplicate') {
      if (copySceneItem('camera', camera.id)) pasteSceneItem('camera')
      return
    }
    if (id === 'look') return st.setViewCameraId(looking ? null : camera.id)
    if (id === 'snap') return snapCameraToView(camera.id)
    if (id === 'key') {
      const key = getCameraKeyValue(camera.id)
      if (!key) return
      const snap = Math.round(st.insertTime * st.animFps) / st.animFps
      st.addCameraKeyframe(camera.name, snap, { pos: key.pos, quat: key.quat, scale: key.scale })
      return
    }
    if (id === 'cut') {
      st.addCameraCut(Math.round(st.insertTime * st.animFps) / st.animFps, camera.name)
      return
    }
    if (id.startsWith('attach:')) {
      const v = id.slice(7)
      return attachCameraToObject(camera.id, v === '' ? null : Number(v))
    }
    if (id === 'delete') removeCamera(camera.id)
  }

  return { items, run }
}

// ---------------------------------------------------------------------------
// Parts (meshes of a character or prop)
// ---------------------------------------------------------------------------

// Which parts a right-click / ⋯ press on `uuid` acts on: the whole selection when the
// row is part of a multi-selection, otherwise just that part.
export function partTargets(uuid, state = useStore.getState()) {
  const sel = state.selectedMeshUuids || []
  return sel.length > 1 && sel.includes(uuid) ? [...sel] : [uuid]
}

// ctx: { isCharacterPart(uuid), keyPart(uuid), extract(uuids, removeOriginals), extracting }
export function partMenu(uuids, ctx, state = useStore.getState()) {
  const multi = uuids.length > 1
  const first = uuids[0]
  const hidden = state.meshOverrides[first]?.visible === false
  const canKey = !multi && ctx.isCharacterPart?.(first)

  const items = [
    { header: multi ? plural(uuids.length, 'part') + ' selected' : ctx.nameOf?.(first) || 'Part' },
    { id: 'visibility', label: hidden ? 'Show' : 'Hide', shortcut: 'H' },
    ...(multi ? [{ id: 'only', label: 'Select only this part' }] : []),
    { separator: true },
    { id: 'reset', label: multi ? `Reset ${uuids.length} parts` : 'Reset part', hint: 'Put the part back where it started' },
    ...(!multi ? [{ id: 'frame', label: 'Frame in viewport', shortcut: 'F' }] : []),
    ...(canKey ? [{ id: 'key', label: 'Key part', hint: "Save this part's position, rotation and size at the Animate panel's insert time" }] : []),
    { separator: true },
    { header: 'Make into a new object' },
    { id: 'extract', label: multi ? `Extract ${uuids.length} parts` : 'Extract to object', disabled: !!ctx.extracting, hint: 'Move the part(s) out into an object of their own (the originals are hidden)' },
    { id: 'copyOut', label: 'Copy to object', disabled: !!ctx.extracting, hint: 'Make a new object from the part(s) and leave the originals where they are' },
  ]

  function run(id) {
    const st = useStore.getState()
    if (id === 'visibility') {
      if (multi) setMeshesVisibleByUuids(uuids, hidden)
      else setMeshVisibleByUuid(first, hidden)
      return
    }
    if (id === 'only') return st.setSelectedMeshUuid(first)
    if (id === 'reset') return multi ? resetMeshes(uuids) : resetMesh(first)
    if (id === 'frame') return setCameraToMesh(first)
    if (id === 'key') return ctx.keyPart?.(first)
    if (id === 'extract') return ctx.extract?.(uuids, true)
    if (id === 'copyOut') return ctx.extract?.(uuids, false)
  }

  return { items, run }
}
