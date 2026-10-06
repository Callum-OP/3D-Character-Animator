import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { disposeObject } from './loadModel.js'
import { markHistoryAction, pushUndoBatch, registerUndoHistory } from './undoHistory.js'
import { useStore } from '../store.js'
import {
  sampleCameraTracks,
  getCamerasPlaybackSnapshot,
  applyCamerasPlaybackSnapshot,
} from './cameras.js'
import {
  sampleLightTracks,
  getLightsPlaybackSnapshot,
  applyLightsPlaybackSnapshot,
} from './lights.js'
import {
  recordOriginalMaterials,
  applyMaterials,
  updateRimLightMaterials,
  restoreOriginalMaterials,
  disposeGeneratedMaterials,
} from './materials.js'

// ---------------------------------------------------------------------------
// Scene objects
//
// Props and backgrounds the character can interact with — separate from the one
// posable character model. Any number can be added; each is a plain Object3D you
// move/rotate/scale with a TransformControls gizmo. Usually one object is
// selected at a time, but shift/ctrl-clicking more than one in the panel
// attaches the gizmo to a shared pivot instead (see selectObjects), so a
// whole group can be moved, rotated or resized together in one drag.
//
// These are intentionally NOT run through the character's inverted-hull outline
// system (a background looks best without an anime-style ink line by default —
// outline is opt-in per object, see setObjectOutline). They DO run through the
// same material-mode pipeline as the character (materials.js), so a prop can
// either match the character's current style ('auto') or be pinned to its own
// look — e.g. a photoreal background behind a toon-shaded character.
// ---------------------------------------------------------------------------

let idCounter = 0

const o = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  requestRender: null,
  setContinuousRender: null,

  transform: null, // TransformControls (move/rotate/scale)
  helper: null,
  enabled: true, // false outside Object mode — gizmo stays detached even if something is selected
  objects: [], // { id, name, format, root } — props only
  characterRoots: new Map(), // id -> { root, name } — every LOADED character (owned elsewhere), keyed by character id
  selected: null, // single selected root (or null) — used when exactly one thing is selected
  undoStack: [],
  redoStack: [],
  dragBefore: null, // selected root's TRS at gizmo-drag start (single-select path)
  onMoveCommit: null, // (root) => void — fired after a gizmo drag actually changes a root's TRS
  onVisibilityChange: null,
  animationRest: null,
  sceneAnimationRest: null,
  resolveBone: null,
  gizmoGrabbed: false, // true once per interaction that actually MOVED something via the gizmo (see objectChange)
  draggingViaGizmo: false, // true between dragging-changed(true) and (false) — not by itself proof of an actual move
  lastStyleOpts: { mode: 'unlit', toonSteps: 3, soften: 0, colorGrading: 'none', overrides: {} }, // last scene-wide style, for 'auto' objects

  // --- Multi-select (shift/ctrl-click several objects to move/rotate/resize
  // them together) --- TransformControls can only attach to one Object3D, so
  // when 2+ things are selected the gizmo is attached to an invisible pivot
  // Object3D placed at the group's centroid instead. Dragging the pivot is
  // turned into a world-space delta matrix that gets re-applied to every
  // selected root, preserving their relative offsets from one another.
  pivot: null, // THREE.Object3D the gizmo attaches to when 2+ objects are selected
  pivotRoots: [], // roots currently driven by the pivot (empty unless 2+ selected)
  pivotStartMatrix: null, // pivot's matrix at the start of the current drag
  pivotRootStarts: null, // Map(root -> Matrix4) — each root's matrix at drag start
  multiDragBefore: null, // [{root, before}] snapshots at drag start, for undo
}

let objectClipboard = null

// Register a callback fired whenever a move/rotate/scale drag finishes having
// actually changed something. Used for "auto-key movement" — automatically
// saving a root-motion keyframe when the character is dragged mid-clip.
export function setOnObjectMoveCommit(fn) {
  o.onMoveCommit = fn || null
}

export function setOnObjectVisibilityChange(fn) {
  o.onVisibilityChange = fn || null
}

registerUndoHistory('object', () => ({ undo: o.undoStack, redo: o.redoStack }))

export function initObjects(refs) {
  o.scene = refs.scene
  o.camera = refs.camera
  o.renderer = refs.renderer
  o.controls = refs.controls
  o.requestRender = refs.requestRender
  o.setContinuousRender = refs.setContinuousRender
  o.resolveBone = refs.resolveBone || null

  const transform = new TransformControls(o.camera, o.renderer.domElement)
  transform.setMode('translate')
  transform.setSize(0.9)
  transform.addEventListener('dragging-changed', (e) => {
    // Don't orbit while dragging; stay locked if a camera view has orbit off.
    o.controls.enabled = !e.value && !o.controls.locked
    o.draggingViaGizmo = e.value
    // gizmoGrabbed itself is set from objectChange below, once something has
    // actually moved — see the comment there for why.
  })
  transform.addEventListener('objectChange', () => {
    // The gizmo's handles have generous invisible pick padding so they're
    // easy to grab, which also means a click aimed at a nearby object can
    // land on that padding instead. Only mark the interaction as "grabbed"
    // once it actually moved something; a press-and-release that hits the
    // padding but produces no motion falls through to normal object picking.
    if (o.draggingViaGizmo) o.gizmoGrabbed = true
    if (o.pivotRoots.length > 1 && o.pivotStartMatrix) applyPivotDelta()
    o.requestRender()
  })
  transform.addEventListener('mouseDown', () => {
    if (o.pivotRoots.length > 1) {
      o.pivot.updateMatrix()
      o.pivotStartMatrix = o.pivot.matrix.clone()
      o.pivotRootStarts = new Map(
        o.pivotRoots.map((r) => {
          r.updateMatrix()
          return [r, r.matrix.clone()]
        }),
      )
      o.multiDragBefore = o.pivotRoots.map((r) => ({ root: r, before: snapshot(r) }))
    } else if (o.selected) {
      o.dragBefore = snapshot(o.selected)
    }
  })
  transform.addEventListener('mouseUp', () => {
    if (o.pivotRoots.length > 1) commitMultiDragUndo()
    else commitDragUndo()
    o.requestRender()
  })
  o.transform = transform

  const helper = transform.getHelper()
  excludeFromOutline(helper)
  o.scene.add(helper)
  o.helper = helper

  // Invisible pivot used purely as a gizmo anchor for multi-object drags —
  // never rendered, never itself part of the objects list.
  const pivot = new THREE.Object3D()
  pivot.visible = false
  o.scene.add(pivot)
  o.pivot = pivot
}

// Register a character model root so it can be selected/moved like an object,
// keyed by character id. Its geometry is owned by the model system, not here.
export function setCharacterObject(id, root, name) {
  o.characterRoots.set(id, { root, name })
}

// Unregister one character (when its model is disposed / removed).
export function clearCharacterObject(id) {
  const entry = o.characterRoots.get(id)
  if (entry) {
    if (o.selected === entry.root && o.transform) o.transform.detach()
    if (o.selected === entry.root) o.selected = null
    o.pivotRoots = o.pivotRoots.filter((r) => r !== entry.root)
    o.characterRoots.delete(id)
  }
}

// Unregister ALL characters (full scene teardown).
export function clearAllCharacterObjects() {
  for (const id of [...o.characterRoots.keys()]) clearCharacterObject(id)
}

// Add a loaded model as a scene object. Returns lightweight metadata for the UI.
// `file` (the original File) is retained so the object can be saved to a project.
function makeAnimationKey() {
  return globalThis.crypto?.randomUUID?.() || `object-${Date.now()}-${++idCounter}`
}

export function addObject(parsed, name, format, file, animationKey = null) {
  const root = parsed.root
  const meshes = []
  root.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true
      obj.receiveShadow = true
      meshes.push(obj)
    }
  })
  o.scene.add(root)
  const id = ++idCounter
  // Reuse the character's material-mode pipeline (materials.js) so props can
  // be styled exactly like a character — 'auto' just means "whatever style
  // the scene is currently using".
  const materialModel = { meshes }
  recordOriginalMaterials(materialModel)
  const entry = {
    id,
    animationKey: animationKey || makeAnimationKey(),
    name,
    format,
    root,
    kind: 'model',
    file: file || null,
    meshes,
    materials: materialModel.materials,
    style: 'auto', // 'auto' | 'unlit' | 'toon' | 'soft' | 'standard'
    outline: false, // props default to no ink outline, even in Cartoon/Soft styles
    castShadow: true,
    attachedBoneName: null, // bone name this prop is parented to, or null
    attachedCharacterId: null, // which character owns that bone
    attachedBone: null, // live Bone Object3D reference (not serialisable)
  }
  o.objects.push(entry)
  applyObjectStyle(entry)
  o.requestRender()
  return { id, animationKey: entry.animationKey, name, format, kind: 'model', style: entry.style, outline: entry.outline, castShadow: true }
}

// Add an image as a movable reference plane. `map` is a loaded THREE.Texture;
// `aspect` = image width / height. The plane is built ~1.6 units tall (a rough
// character height) and rests on the ground so it lines up with a standing
// figure out of the box; the user then moves/rotates/scales it like any object.
// Reference images opt out of shadows and the outline — they're 2D guides, not
// props the scene should light.
export function addImage(map, name, aspect, file, animationKey = null) {
  const h = 1.6
  const w = h * (aspect || 1)
  const geo = new THREE.PlaneGeometry(w, h)
  const mat = new THREE.MeshBasicMaterial({
    map,
    transparent: true, // honour PNG alpha
    side: THREE.DoubleSide, // visible from behind the character too
    toneMapped: false, // show the image's true colours
    depthWrite: false, // don't let the flat plane occlude via the depth buffer
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = false
  mesh.receiveShadow = false
  const root = new THREE.Group()
  root.add(mesh)
  root.position.y = h / 2 // rest the plane on the ground
  excludeFromOutline(root)
  o.scene.add(root)
  const id = ++idCounter
  const entry = {
    id,
    animationKey: animationKey || makeAnimationKey(),
    name,
    format: 'image',
    root,
    kind: 'image',
    file: file || null,
    attachedBoneName: null,
    attachedCharacterId: null,
    attachedBone: null,
  }
  o.objects.push(entry)
  o.requestRender()
  return { id, animationKey: entry.animationKey, name, format, kind: 'image' }
}

// ---------------------------------------------------------------------------
// Bone attachment — glue a prop (gun, shield, hat...) to a bone on the active
// character so it follows posing, animation playback and ragdoll for free.
// Bone attachment — glue a prop (gun, shield, hat...) to a bone on the active
// character so it follows posing, animation playback and ragdoll for free.
//
// Implementation: reparent the prop's root under the live Bone Object3D.
// Three.js's normal scene-graph traversal keeps a bone's children in lockstep
// with it every frame (posing, the animation mixer and the ragdoll solver all
// just rotate the bone) — no per-frame sync code needed here. The prop's
// position/quaternion/scale become bone-LOCAL the moment it's attached, which
// is exactly what you want: they now describe "offset from the bone", so the
// existing Move/Rotate/Resize gizmo can nudge the prop into place in the hand
// (or wherever) without fighting the bone's own transform.
// ---------------------------------------------------------------------------

// Snap `root`'s local TRS so its WORLD transform is unchanged after being
// reparented under `newParent` — used both when attaching (so the prop
// doesn't jump to the bone's origin) and detaching (so it doesn't jump back
// to the scene origin).
function reparentKeepingWorld(root, newParent) {
  root.updateMatrixWorld(true)
  const worldMatrix = root.matrixWorld.clone()
  newParent.add(root)
  newParent.updateMatrixWorld(true)
  const invParent = new THREE.Matrix4().copy(newParent.matrixWorld).invert()
  const localMatrix = new THREE.Matrix4().multiplyMatrices(invParent, worldMatrix)
  localMatrix.decompose(root.position, root.quaternion, root.scale)
}

// Attach a prop to a bone by name on a given character. `bone` is the live
// THREE.Bone (look it up via posing.js's getBoneByName). Re-attaching to a
// different bone (or the same one) is fine — it just reparents again from
// wherever the prop currently is.
export function attachObjectToBone(id, bone, boneName, characterId) {
  const entry = o.objects.find((e) => e.id === id)
  if (!entry || !bone) return
  if (o.selected === entry.root) o.transform.detach()
  o.pivotRoots = o.pivotRoots.filter((r) => r !== entry.root)
  reparentKeepingWorld(entry.root, bone)
  entry.attachedBoneName = boneName || bone.name
  entry.attachedCharacterId = characterId != null ? characterId : null
  entry.attachedBone = bone
  if (o.selected === entry.root && o.enabled) o.transform.attach(entry.root) // re-attach gizmo in new parent space
  o.requestRender()
}

function objectTransform(root) {
  return {
    position: root.position.toArray(),
    quaternion: root.quaternion.toArray(),
    scale: root.scale.toArray(),
  }
}

export function getObjectAnimationDuration(store = useStore.getState()) {
  const transformEnd = Object.values(store.objectAnimData || {}).reduce(
    (end, keys) => Math.max(end, keys?.[keys.length - 1]?.time || 0),
    0,
  )
  const attachmentEnd = Object.values(store.objectAttachmentData || {}).reduce(
    (end, track) => Math.max(end, track?.keys?.[track.keys.length - 1]?.time || 0),
    0,
  )
  const hasCharacters = (store.characterOrder || []).length > 0
  const cameraEnd = hasCharacters ? 0 : Object.values(store.animData?.cameras || {}).reduce(
    (end, keys) => Math.max(end, keys?.[keys.length - 1]?.time || 0),
    0,
  )
  const lightEnd = hasCharacters ? 0 : Object.values(store.animData?.lights || {}).reduce(
    (end, keys) => Math.max(end, keys?.[keys.length - 1]?.time || 0),
    0,
  )
  return Math.max(0.1, Number(store.objectAnimDuration) || 2, transformEnd, attachmentEnd, cameraEnd, lightEnd)
}

function applyObjectTransform(root, transform) {
  if (transform?.position) root.position.fromArray(transform.position)
  if (transform?.quaternion) root.quaternion.fromArray(transform.quaternion)
  if (transform?.scale) root.scale.fromArray(transform.scale)
}

function currentAttachmentState(entry) {
  const character = entry.attachedCharacterId != null
    ? o.characterRoots.get(entry.attachedCharacterId)
    : null
  return {
    boneName: entry.attachedBoneName || null,
    characterId: entry.attachedCharacterId ?? null,
    characterName: character?.name || null,
    transform: objectTransform(entry.root),
  }
}

// Save an attach/detach change at the shared timeline playhead. The first
// keyed change captures the original attachment and transform as the track's
// baseline, so scrubbing before the first key restores the starting state.
export function keyObjectAttachment(id, boneName, time, characterId, characterName, resolveBone = o.resolveBone) {
  const entry = o.objects.find((candidate) => candidate.id === id)
  if (!entry) return false
  const keyTime = Math.max(0, Number(time) || 0)
  const store = useStore.getState()
  const track = store.objectAttachmentData?.[entry.animationKey]
  const base = track?.base || currentAttachmentState(entry)
  if (boneName) {
    const bone = resolveBone?.(boneName, characterId)
    if (!bone) return false
    attachObjectToBone(id, bone, boneName, characterId)
  } else {
    detachObject(id)
  }
  const key = { time: keyTime, characterName: characterName || null, ...currentAttachmentState(entry) }
  const keys = (track?.keys || []).filter((item) => Math.abs(item.time - keyTime) > 1e-6)
  keys.push(key)
  keys.sort((a, b) => a.time - b.time)
  store.setObjectAttachmentTrack(entry.animationKey, { base, keys })
  store.setObjectAnimDuration(Math.max(Number(store.objectAnimDuration) || 2, keyTime))
  store.setObjectAttachment(id, entry.attachedBoneName)
  o.requestRender?.()
  return true
}

function applyAttachmentState(entry, state) {
  const targetName = state?.boneName || null
  const targetCharacterId = state?.characterId ?? null
  if (targetName) {
    const bone = o.resolveBone?.(targetName, targetCharacterId, state?.characterName)
    if (!bone) {
      if (entry.attachedBoneName) detachObject(entry.id)
      const current = useStore.getState().sceneObjects.find((object) => object.id === entry.id)
      if (current?.attachedBoneName) useStore.getState().setObjectAttachment(entry.id, null)
      return
    }
    if (
      entry.attachedBoneName !== targetName ||
      entry.attachedCharacterId !== targetCharacterId ||
      entry.attachedBone !== bone
    ) {
      attachObjectToBone(entry.id, bone, targetName, targetCharacterId)
    }
  } else if (entry.attachedBoneName) {
    detachObject(entry.id)
  }
  const current = useStore.getState().sceneObjects.find((object) => object.id === entry.id)
  if (current?.attachedBoneName !== (entry.attachedBoneName || null)) {
    useStore.getState().setObjectAttachment(entry.id, entry.attachedBoneName)
  }
}

function sampleAttachmentSegment(entry, track, time, transformKeys) {
  if (!track) return
  let segment = track.base
  let segmentStart = 0
  let nextKeyTime = Infinity
  for (const key of track.keys || []) {
    if (key.time <= time) {
      segment = key
      segmentStart = key.time
    } else {
      nextKeyTime = key.time
      break
    }
  }
  applyAttachmentState(entry, segment)
  const keys = [
    { time: segmentStart, ...segment.transform },
    ...(transformKeys || []).filter((key) => key.time >= segmentStart && key.time < nextKeyTime),
  ]
  const unique = [...new Map(keys.map((key) => [key.time, key])).values()]
    .sort((a, b) => a.time - b.time)
  if (unique.length) applyObjectTransform(entry.root, sampleObjectTrack(unique, time))
}

function applyAttachmentAnimationsAt(time, tracks, transformTracks) {
  for (const entry of o.objects) {
    const track = tracks[entry.animationKey]
    if (track?.base) sampleAttachmentSegment(entry, track, time, transformTracks[entry.animationKey] || [])
  }
}

// Detach a prop back into the scene root, preserving its current world
// position/rotation/scale (so it stays exactly where the bone left it).
export function detachObject(id) {
  const entry = o.objects.find((e) => e.id === id)
  if (!entry || !entry.attachedBoneName) return
  const wasSelected = o.selected === entry.root
  if (wasSelected) o.transform.detach()
  reparentKeepingWorld(entry.root, o.scene)
  entry.attachedBoneName = null
  entry.attachedCharacterId = null
  entry.attachedBone = null
  if (wasSelected && o.enabled) o.transform.attach(entry.root)
  o.requestRender()
}

// { boneName, characterId } if attached, else null. Used by the panel to show
// current attachment state and by save/load to persist it.
export function getObjectAttachment(id) {
  const entry = o.objects.find((e) => e.id === id)
  if (!entry || !entry.attachedBoneName) return null
  return { boneName: entry.attachedBoneName, characterId: entry.attachedCharacterId }
}

export function clearObjectAttachmentTrack(id) {
  const entry = o.objects.find((candidate) => candidate.id === id)
  if (!entry) return
  const store = useStore.getState()
  const track = store.objectAttachmentData?.[entry.animationKey]
  if (track?.base) {
    applyAttachmentState(entry, track.base)
    applyObjectTransform(entry.root, track.base.transform)
  }
  store.removeObjectAttachmentTrack(entry.animationKey)
  o.requestRender?.()
}

export function removeObjectAttachmentKey(id, time) {
  const entry = o.objects.find((candidate) => candidate.id === id)
  if (!entry) return false
  const store = useStore.getState()
  const track = store.objectAttachmentData?.[entry.animationKey]
  if (!track) return false
  if (track.keys.length <= 1) {
    clearObjectAttachmentTrack(id)
    return true
  }
  store.removeObjectAttachmentKey(entry.animationKey, time)
  applyObjectAnimationAt(store.globalTime)
  return true
}

// Detach every prop currently attached to bones belonging to `characterId` —
// called just before that character is disposed, so props don't get torn
// down along with the skeleton they were riding on (disposeObject() below
// frees an entire subtree, and a bone's children are part of that subtree).
// Returns the ids of any props that were detached, so the caller can also
// clear their attachment state in the store.
export function detachObjectsForCharacter(characterId) {
  const detached = []
  for (const entry of o.objects) {
    if (entry.attachedBoneName && entry.attachedCharacterId === characterId) {
      detachObject(entry.id)
      detached.push(entry.id)
    }
  }
  return detached
}

// Show or hide an object (prop, image, or the character) without removing it.
export function setObjectVisible(id, visible, recordHistory = true) {
  const root = rootFor(id)
  if (!root) return
  const before = recordHistory ? snapshot(root) : null
  root.visible = visible
  if (before) pushUndoIfChanged(root, before)
  o.requestRender()
}

export function copyObject(id) {
  const entry = o.objects.find((candidate) => candidate.id === id)
  if (!entry) return false
  if (objectClipboard) disposeObject(objectClipboard.root)
  const originalMaterials = entry.materials
    ? entry.meshes.map((mesh) => entry.materials.originals.get(mesh))
    : null
  const root = cloneObjectRoot(entry.root, originalMaterials)
  entry.root.updateWorldMatrix(true, false)
  entry.root.matrixWorld.decompose(root.position, root.quaternion, root.scale)
  objectClipboard = {
    root,
    name: entry.name,
    format: entry.format,
    kind: entry.kind,
    file: entry.file,
    style: entry.style,
    outline: entry.outline,
    castShadow: entry.kind === 'image' ? false : entry.castShadow !== false,
  }
  return true
}

export function pasteObject() {
  if (!objectClipboard || !o.scene) return null
  const source = objectClipboard
  const root = cloneObjectRoot(source.root)
  root.position.x += 0.25
  const meshes = []
  root.traverse((obj) => {
    if (!obj.isMesh) return
    meshes.push(obj)
    obj.castShadow = source.kind === 'image' ? false : source.castShadow !== false
    obj.receiveShadow = source.kind !== 'image'
  })
  o.scene.add(root)
  const id = ++idCounter
  let materials = null
  if (source.kind !== 'image') {
    const materialModel = { meshes }
    recordOriginalMaterials(materialModel)
    materials = materialModel.materials
  }
  const entry = {
    id,
    animationKey: makeAnimationKey(),
    name: `${source.name} Copy`,
    format: source.format,
    root,
    kind: source.kind,
    file: source.file || null,
    meshes,
    materials,
    style: source.style || 'auto',
    outline: !!source.outline,
    castShadow: source.kind === 'image' ? false : source.castShadow !== false,
    attachedBoneName: null,
    attachedCharacterId: null,
    attachedBone: null,
  }
  o.objects.push(entry)
  if (entry.kind === 'model') applyObjectStyle(entry)
  o.requestRender()
  return { id, animationKey: entry.animationKey, name: entry.name, format: entry.format, kind: entry.kind }
}

export function hasCopiedObject() {
  return !!objectClipboard
}

export function clearCopiedObject() {
  if (!objectClipboard) return
  disposeObject(objectClipboard.root)
  objectClipboard = null
}

export function removeObject(id) {
  if (o.characterRoots.has(id)) return // characters are removed via removeCharacter(), not this
  const idx = o.objects.findIndex((e) => e.id === id)
  if (idx < 0) return
  const entry = o.objects[idx]
  useStore.getState().removeObjectAnimationTrack(entry.animationKey)
  if (o.selected === entry.root) {
    o.transform.detach()
    o.selected = null
  }
  if (entry.root.parent) entry.root.parent.remove(entry.root) // may be a bone, not the scene, if attached
  disposePropMaterials(entry)
  disposeObject(entry.root)
  o.objects.splice(idx, 1)
  o.pivotRoots = o.pivotRoots.filter((r) => r !== entry.root)
  o.undoStack = o.undoStack.filter((b) => !b.entries.some((e) => e.root === entry.root))
  o.redoStack = o.redoStack.filter((b) => !b.entries.some((e) => e.root === entry.root))
  o.requestRender()
}

// --- Undoable add / delete of props & images ---------------------------------
// Deleting detaches the object from the scene but keeps its geometry/materials
// alive so Undo can put it straight back; the resources are only freed once the
// delete step falls out of history (see the batch's discard() below).

// Take a prop out of the scene WITHOUT disposing it. Returns a record that
// reattachObjectSoft() can restore, or null if `id` isn't a prop.
export function detachObjectSoft(id) {
  if (o.characterRoots.has(id)) return null
  const index = o.objects.findIndex((e) => e.id === id)
  if (index < 0) return null
  const entry = o.objects[index]
  const world = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    scale: new THREE.Vector3(),
  }
  entry.root.updateWorldMatrix(true, false)
  entry.root.matrixWorld.decompose(world.position, world.quaternion, world.scale)
  const wasAttached = Boolean(entry.attachedBone)
  if (o.selected === entry.root) {
    o.transform?.detach()
    o.selected = null
  }
  if (entry.root.parent) entry.root.parent.remove(entry.root)
  o.objects.splice(index, 1)
  o.pivotRoots = o.pivotRoots.filter((r) => r !== entry.root)
  o.requestRender?.()
  return { entry, index, world, wasAttached }
}

// Put a soft-detached prop back in the scene at its old list position. A prop
// that was glued to a bone comes back as a free prop at the same world pose.
export function reattachObjectSoft(record) {
  const { entry, index, world, wasAttached } = record
  if (wasAttached) {
    entry.attachedBone = null
    entry.attachedBoneName = null
    entry.attachedCharacterId = null
    entry.root.position.copy(world.position)
    entry.root.quaternion.copy(world.quaternion)
    entry.root.scale.copy(world.scale)
  }
  o.scene.add(entry.root)
  o.objects.splice(Math.min(index, o.objects.length), 0, entry)
  o.requestRender?.()
}

// Free a prop's GPU resources for good (it must already be out of the scene).
export function disposeObjectEntry(entry) {
  disposePropMaterials(entry)
  disposeObject(entry.root)
}

// Set a prop/background's look. 'auto' (the default) means "match whatever
// style the character is currently using" — pick an explicit mode instead to
// pin it (e.g. keep a realistic photo backdrop while the character is toon).
export function setObjectStyle(id, style) {
  const entry = o.objects.find((e) => e.id === id && e.kind === 'model')
  if (!entry) return
  entry.style = style
  applyObjectStyle(entry)
  o.requestRender()
}

// Toggle the ink outline on a prop (off by default — most props/backgrounds
// look better without the character's cel-shading outline, but it's there
// for anything meant to read as part of the same toon look).
export function setObjectOutline(id, outline) {
  const entry = o.objects.find((e) => e.id === id && e.kind === 'model')
  if (!entry) return
  entry.outline = outline
  applyObjectStyle(entry)
  o.requestRender()
}

// Re-apply the current scene style (mode/toonSteps/soften/rimLight/outline
// width) to every 'auto' prop, and re-stamp outline params on every prop —
// called whenever the character's Look settings change, so props following
// 'auto' track live.
export function applyAllObjectStyles(opts) {
  o.lastStyleOpts = opts
  for (const entry of o.objects) {
    if (entry.kind === 'model') applyObjectStyle(entry, opts)
  }
}

export function updateAllObjectRimLight(rimLight) {
  if (!rimLight) return
  for (const entry of o.objects) {
    if (entry.kind === 'model') updateRimLightMaterials(entry, rimLight)
  }
}

function applyObjectStyle(entry, opts) {
  const use = opts || o.lastStyleOpts
  const mode = entry.style === 'auto' ? use.mode : entry.style
  applyMaterials(
    { meshes: entry.meshes, materials: entry.materials },
    {
      mode,
      toonSteps: use.toonSteps,
      soften: use.soften,
      colorGrading: use.colorGrading,
      ambientOcclusionStrength: use.ambientOcclusionStrength,
      backlightColor: use.backlightColor,
      backlightFalloff: use.backlightFalloff,
      shadowStrength: use.shadowStrength,
      rimLight: use.rimLight,
      // Per-part visibility (H key / eye icon in the Parts panel) — same
      // meshOverrides map the character uses, keyed by mesh.uuid, which is
      // globally unique regardless of whether the mesh belongs to a
      // character or a prop.
      overrides: use.overrides || {},
    },
  )
  const width = use.outlineWidth != null ? use.outlineWidth : 0.0025
  for (const mesh of entry.meshes) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const mat of mats) {
      if (!mat) continue
      mat.userData.outlineParameters = {
        thickness: width,
        color: [0, 0, 0],
        alpha: 1,
        visible: entry.outline,
        keepAlive: false,
      }
    }
  }
}

// Toggle whether a prop casts shadows (it still receives them either way).
export function setObjectCastShadow(id, castShadow) {
  const entry = o.objects.find((e) => e.id === id && e.kind === 'model')
  if (!entry) return
  entry.castShadow = castShadow
  for (const mesh of entry.meshes) mesh.castShadow = castShadow
  o.requestRender()
}

// Put a prop's real materials back and free the generated (toon/unlit) shells
// before disposeObject frees geometry/materials/textures for good — mirrors
// the character unload path in scene.js so shared textures are only disposed
// once, via the real materials.
function disposePropMaterials(entry) {
  if (!entry.materials) return
  restoreOriginalMaterials({ meshes: entry.meshes, materials: entry.materials })
  disposeGeneratedMaterials({ meshes: entry.meshes, materials: entry.materials })
}

function cloneObjectRoot(source, originalMaterials = null) {
  const root = source.clone(true)
  let meshIndex = 0
  root.traverse((obj) => {
    if (!obj.isMesh) return
    const sourceMaterial = originalMaterials?.[meshIndex] || obj.material
    meshIndex++
    if (obj.geometry) obj.geometry = obj.geometry.clone()
    const cloneMaterial = (material) => {
      if (!material) return material
      const copy = material.clone()
      for (const key of Object.keys(copy)) {
        if (copy[key]?.isTexture) copy[key] = copy[key].clone()
      }
      return copy
    }
    obj.material = Array.isArray(sourceMaterial)
      ? sourceMaterial.map(cloneMaterial)
      : cloneMaterial(sourceMaterial)
  })
  return root
}

// --- Object-mode click-to-pick --------------------------------------------
// Lets the user select a prop/image/character directly by clicking it in the
// viewport while in Object mode, instead of having to find it in a panel
// first. Characters are included too — Object mode is a distinct mode from
// Pose now, and a character can be moved/rotated/resized as a whole object
// exactly like a prop (see setCharacterObject / rootFor below).
const _pickRaycaster = new THREE.Raycaster()
const _pickNdc = new THREE.Vector2()

export function pickObjectId(ndcX, ndcY) {
  if (!o.camera) return null
  const propRoots = o.objects.filter((e) => e.root.visible).map((e) => e.root)
  const charEntries = [...o.characterRoots.entries()].filter(([, e]) => e.root.visible)
  const roots = propRoots.concat(charEntries.map(([, e]) => e.root))
  if (!roots.length) return null
  _pickNdc.set(ndcX, ndcY)
  _pickRaycaster.setFromCamera(_pickNdc, o.camera)
  const hits = _pickRaycaster.intersectObjects(roots, true)
  if (!hits.length) return null
  let obj = hits[0].object
  while (obj) {
    const entry = o.objects.find((e) => e.root === obj)
    if (entry) return entry.id
    const charHit = charEntries.find(([, e]) => e.root === obj)
    if (charHit) return charHit[0]
    obj = obj.parent
  }
  return null
}

// Box/marquee-select (Object mode's Ctrl/Cmd-drag — see Viewport.jsx): every
// visible prop/character whose root falls within a screen-space rectangle.
// `rect` is in the SAME pixel space as rectW/rectH (the canvas's own
// getBoundingClientRect() width/height) — Viewport.jsx does that conversion,
// same as posing.js's box-select does for bone dots.
const _boxV = new THREE.Vector3()
export function pickObjectIdsInRect(x0, y0, x1, y1, rectW, rectH) {
  if (!o.camera) return []
  const minX = Math.min(x0, x1)
  const maxX = Math.max(x0, x1)
  const minY = Math.min(y0, y1)
  const maxY = Math.max(y0, y1)
  const ids = []
  const entries = [
    ...o.objects.filter((e) => e.root.visible).map((e) => [e.id, e.root]),
    ...[...o.characterRoots.entries()].filter(([, e]) => e.root.visible).map(([id, e]) => [id, e.root]),
  ]
  for (const [id, root] of entries) {
    root.getWorldPosition(_boxV).project(o.camera)
    if (_boxV.z > 1) continue // behind the camera
    const sx = (_boxV.x * 0.5 + 0.5) * rectW
    const sy = (-_boxV.y * 0.5 + 0.5) * rectH
    if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) ids.push(id)
  }
  return ids
}

// Whether `id` refers to a loaded character (as opposed to a prop). Used by
// the viewport's click handler to tell "clicked a character" apart from
// "clicked a prop" so it knows when to switch the active character.
export function isCharacterId(id) {
  return id != null && o.characterRoots.has(id)
}

// Resolve an id (numeric prop id or a character id) to its root object.
function rootFor(id) {
  if (id == null) return null
  const charEntry = o.characterRoots.get(id)
  if (charEntry) return charEntry.root
  const entry = o.objects.find((e) => e.id === id)
  return entry ? entry.root : null
}

// Attach the gizmo to a single object (or null to detach). Also drops any
// active multi-selection — used by plain clicks, cycling, and deselecting.
export function selectObject(id) {
  if (!o.transform) return
  o.pivotRoots = []
  o.pivotStartMatrix = null
  o.pivotRootStarts = null
  o.multiDragBefore = null
  if (o.pivot) o.pivot.visible = false
  const root = rootFor(id)
  o.selected = root
  if (root && o.enabled) o.transform.attach(root)
  else o.transform.detach()
  o.requestRender()
}

// Enable/disable Object mode's gizmo as a whole (mirrors posing.js's /
// meshedit.js's setPosingEnabled/setMeshEditEnabled). The selection itself
// is remembered so switching back to Object mode re-attaches it — this only
// controls whether the gizmo is actually visible/attached right now, which
// is what was leaving the Move/Rotate/Resize gizmo stuck on screen after
// switching to another mode until the next click.
export function setObjectsEnabled(enabled) {
  o.enabled = enabled
  if (!o.transform) return
  if (!enabled) {
    o.transform.detach()
  } else if (o.pivotRoots.length > 1 && o.pivot) {
    o.transform.attach(o.pivot)
  } else if (o.selected) {
    o.transform.attach(o.selected)
  }
  o.requestRender()
}

// Whether the Move/Rotate/Resize gizmo is currently attached to anything.
// Exists mainly so tests can check the gizmo actually detaches on a mode
// switch, rather than just that setObjectsEnabled() didn't throw.
export function isObjectGizmoAttached() {
  return !!(o.transform && o.transform.object)
}

// Attach the gizmo to several objects at once (shift/ctrl-click in the
// panel) so dragging it moves, rotates or resizes all of them together.
// Falls back to the plain single-select path for 0 or 1 ids so existing
// behaviour (and undo history) is unchanged in the common case.
//
// Bone-attached props are left out of the shared group: applyPivotDelta below
// treats every root's local matrix as its world matrix (true for anything
// added directly to the scene), which no longer holds once a prop's parent is
// a bone. Attached props still get moved individually via the bone panel /
// re-attaching, just not through this group gizmo.
export function selectObjects(ids) {
  if (!o.transform) return
  const list = Array.isArray(ids) ? ids : ids != null ? [ids] : []
  const roots = []
  const seen = new Set()
  for (const id of list) {
    const root = rootFor(id)
    if (root && !seen.has(root) && root.parent === o.scene) {
      seen.add(root)
      roots.push(root)
    }
  }
  if (roots.length <= 1) {
    selectObject(list.find((id) => rootFor(id)) ?? null)
    return
  }
  o.selected = null
  o.transform.detach()
  o.pivotRoots = roots
  o.pivotStartMatrix = null
  o.pivotRootStarts = null
  o.multiDragBefore = null
  const center = new THREE.Vector3()
  for (const r of roots) center.add(r.getWorldPosition(new THREE.Vector3()))
  center.divideScalar(roots.length)
  o.pivot.position.copy(center)
  o.pivot.quaternion.identity()
  o.pivot.scale.set(1, 1, 1)
  o.pivot.updateMatrix()
  o.pivot.visible = true
  if (o.enabled) o.transform.attach(o.pivot)
  o.requestRender()
}

// Re-apply a completed pivot drag's world-space delta to every selected
// root: delta = pivot.matrix (now) * inverse(pivot.matrix at drag start),
// then each root's new matrix = delta * that root's matrix at drag start.
// This composes correctly for translate, rotate AND scale because every
// prop/character root is added directly to the scene (no parent transform
// of its own), so each root's local matrix already IS its world matrix.
function applyPivotDelta() {
  o.pivot.updateMatrix()
  const delta = o.pivot.matrix.clone().multiply(o.pivotStartMatrix.clone().invert())
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scl = new THREE.Vector3()
  for (const root of o.pivotRoots) {
    const startMatrix = o.pivotRootStarts.get(root)
    if (!startMatrix) continue
    const next = delta.clone().multiply(startMatrix)
    next.decompose(pos, quat, scl)
    root.position.copy(pos)
    root.quaternion.copy(quat)
    root.scale.copy(scl)
  }
}

// Called once a multi-object drag ends: one undo step covers every object
// that actually moved, so a single Ctrl+Z undoes the whole group edit.
function commitMultiDragUndo() {
  const before = o.multiDragBefore
  o.multiDragBefore = null
  o.pivotStartMatrix = null
  o.pivotRootStarts = null
  if (!before) return
  const entries = before
    .map(({ root, before }) => ({ root, before, after: snapshot(root) }))
    .filter(({ before, after }) => !sameSnapshot(before, after))
  if (!entries.length) return
  pushUndoBatch('object', { entries })
  if (o.onMoveCommit) {
    for (const { root } of entries) o.onMoveCommit(root)
  }
}

export function setObjectMode(mode) {
  if (!o.transform) return
  o.transform.setMode(mode) // 'translate' | 'rotate' | 'scale'
  o.requestRender()
}

// Read (and clear) whether the most recent gizmo interaction actually grabbed
// a handle. Used by Viewport's "click empty space to deselect" handler to
// tell a real gizmo drag apart from a click that missed it entirely.
export function consumeObjectGizmoGrab() {
  const grabbed = o.gizmoGrabbed
  o.gizmoGrabbed = false
  return grabbed
}

// Test hook: replay a press → (optional) move → release on the real
// TransformControls instance, the same events a genuine drag fires, without
// needing a full DOM/raycaster harness. Lets tests cover the
// press-on-the-padding-but-nothing-moved case that consumeObjectGizmoGrab()
// exists to handle.
export function simulateGizmoDragForTest(actuallyMoved) {
  if (!o.transform) return
  o.transform.dispatchEvent({ type: 'dragging-changed', value: true })
  if (actuallyMoved) o.transform.dispatchEvent({ type: 'objectChange' })
  o.transform.dispatchEvent({ type: 'dragging-changed', value: false })
}

// Swap the camera the gizmo works against (view-through-camera mode).
export function setViewCamera(camera) {
  o.camera = camera
  if (o.transform) o.transform.camera = camera
}

// Reset the selected/target object back to the scene origin, unrotated, unscaled.
export function resetObject(id) {
  const root = rootFor(id)
  if (!root) return
  const before = snapshot(root)
  root.position.set(0, 0, 0)
  root.quaternion.identity()
  root.scale.set(1, 1, 1)
  pushUndoIfChanged(root, before)
  o.requestRender()
}

// Read the selected object's current uniform scale (average of the three
// axes, so it still shows something sane if a prop was scaled unevenly).
export function getSelectedUniformScale(id) {
  const root = rootFor(id)
  if (!root) return 1
  return (root.scale.x + root.scale.y + root.scale.z) / 3
}

// Set the selected object's scale uniformly on all three axes at once —
// backs the circular resize dial (Blender/Clip Studio style: drag around the
// ring, every side grows or shrinks together instead of one axis at a time).
export function setSelectedUniformScale(id, value) {
  const root = rootFor(id)
  if (!root) return
  const v = Math.max(0.01, value)
  root.scale.set(v, v, v)
  o.requestRender()
}

// Called once at the end of a drag on the radial dial, so the whole gesture
// is a single undo step rather than one per pixel of movement.
export function commitUniformScale(id, before) {
  const root = rootFor(id)
  if (!root || !before) return
  pushUndoIfChanged(root, before)
}

export function snapshotObject(id) {
  const root = rootFor(id)
  return root ? snapshot(root) : null
}

export function getObjectTransform(id) {
  const root = rootFor(id)
  return root
    ? {
        position: root.position.toArray(),
        quaternion: root.quaternion.toArray(),
        scale: root.scale.toArray(),
      }
    : null
}

export function setObjectTransformWithUndo(id, transform) {
  const root = rootFor(id)
  if (!root || !transform) return
  const before = snapshot(root)
  if (transform.position) root.position.fromArray(transform.position)
  if (transform.quaternion) root.quaternion.fromArray(transform.quaternion)
  if (transform.scale) root.scale.fromArray(transform.scale)
  pushUndoIfChanged(root, before)
  o.requestRender()
}

// Set an object's full transform at once (used when restoring a saved project).
export function setObjectTransform(id, t) {
  const root = rootFor(id)
  if (!root || !t) return
  if (t.position) root.position.fromArray(t.position)
  if (t.quaternion) root.quaternion.fromArray(t.quaternion)
  if (t.scale) root.scale.fromArray(t.scale)
  o.requestRender()
}

// Undo/redo for moving, rotating, or resizing a prop/image/character with the
// gizmo (or hitting Reset). Mirrors the mesh-edit undo stack: each drag is one
// undo step, keyed by the root object so redo/undo still work if the user
// selects something else in between.
export function undo() {
  const batch = o.undoStack.pop()
  if (!batch) return
  if (batch.run) batch.run('undo') // add/delete-object step (see recordObjectPresence)
  else for (const e of batch.entries) applySnapshot(e.root, e.before)
  markHistoryAction(batch)
  o.redoStack.push(batch)
  o.requestRender()
}

export function redo() {
  const batch = o.redoStack.pop()
  if (!batch) return
  if (batch.run) batch.run('redo')
  else for (const e of batch.entries) applySnapshot(e.root, e.after)
  markHistoryAction(batch)
  o.undoStack.push(batch)
  o.requestRender()
}

function snapshot(root) {
  return {
    position: root.position.clone(),
    quaternion: root.quaternion.clone(),
    scale: root.scale.clone(),
    visible: root.visible,
  }
}

function applySnapshot(root, snap) {
  root.position.copy(snap.position)
  root.quaternion.copy(snap.quaternion)
  root.scale.copy(snap.scale)
  if (snap.visible != null && root.visible !== snap.visible) {
    root.visible = snap.visible
    const id = idForRoot(root)
    if (id != null && o.onVisibilityChange) o.onVisibilityChange(id, snap.visible)
  }
}

function sameSnapshot(a, b) {
  return a.position.equals(b.position) && a.quaternion.equals(b.quaternion) &&
    a.scale.equals(b.scale) && a.visible === b.visible
}

function idForRoot(root) {
  const object = o.objects.find((entry) => entry.root === root)
  if (object) return object.id
  for (const [id, entry] of o.characterRoots) {
    if (entry.root === root) return id
  }
  return null
}

function pushUndoIfChanged(root, before) {
  const after = snapshot(root)
  if (sameSnapshot(before, after)) return
  pushUndoBatch('object', { entries: [{ root, before, after }] })
}

function commitDragUndo() {
  if (!o.selected || !o.dragBefore) return
  const before = o.dragBefore
  const root = o.selected
  pushUndoIfChanged(root, before)
  o.dragBefore = null
  if (o.onMoveCommit && !sameSnapshot(before, snapshot(root))) o.onMoveCommit(root)
}

// --- Full project save (props + images WITH their source file blobs) ---------

// Everything needed to recreate the props/images: the original file blob, kind,
// transform and visibility. Entries without a retained blob (e.g. added before
// this feature, or restored from a transforms-only scene file) are skipped —
// there's nothing to reload them from.
// `meshOverrides` is the store's map of per-part overrides (outline/shading/
// visible), keyed by mesh uuid — the SAME map the active character uses (see
// MeshPanel). Since a prop's mesh uuids are only ever meaningful while that
// exact mesh instance is loaded, we remap them onto each prop's own mesh
// INDEX here (mirroring meshOverridesByIndexFor in scene.js for characters),
// so per-part visibility on props actually survives a save→reload round trip
// instead of silently being dropped (the uuids never match anything after
// reload, so `applyProjectData` had nothing to restore them from).
function objectMeshOverridesByIndex(entry, meshOverrides) {
  if (!meshOverrides || !entry.meshes || !entry.meshes.length) return undefined
  const byIndex = {}
  entry.meshes.forEach((mesh, i) => {
    const ov = meshOverrides[mesh.uuid]
    if (ov) byIndex[i] = ov
  })
  return Object.keys(byIndex).length ? byIndex : undefined
}

export function getObjectsForSave(meshOverrides) {
  return o.objects
    .filter((e) => e.file)
    .map((e) => ({
      kind: e.kind || 'model',
      animationKey: e.animationKey,
      fileName: e.file.name,
      blob: e.file,
      name: e.name,
      format: e.format,
      transform: {
        position: e.root.position.toArray(),
        quaternion: e.root.quaternion.toArray(),
        scale: e.root.scale.toArray(),
      },
      visible: e.root.visible,
      style: e.kind === 'model' ? e.style : undefined,
      outline: e.kind === 'model' ? e.outline : undefined,
      castShadow: e.kind === 'model' ? e.castShadow : undefined,
      // Bone this prop is riding, if any (transform above is already bone-local).
      attachedBoneName: e.attachedBoneName || undefined,
      // Per-part (mesh) visibility/outline/shading overrides — see comment above.
      meshOverridesByIndex: e.kind === 'model' ? objectMeshOverridesByIndex(e, meshOverrides) : undefined,
    }))
}

// Look up an object's own ordered mesh list by id (same order used when the
// record was built above) — used on load to remap saved per-part overrides
// back onto the freshly-created meshes' (new) uuids.
export function getObjectMeshesById(id) {
  const entry = o.objects.find((e) => e.id === id)
  return (entry && entry.meshes) || []
}

// --- Scene save/load (transforms only) ---------------------------------------

// Transforms of every prop (by name) for saving a scene layout.
// Live Object3D roots for every prop currently in the scene — used by the
// ragdoll to build obstacle colliders. Excludes the character itself.
export function getObjectRoots() {
  return o.objects.map((e) => e.root)
}

export function getObjectAnimationKey(id) {
  return o.objects.find((entry) => entry.id === id)?.animationKey || null
}

export function getObjectAnimationKeyForRoot(root) {
  return o.objects.find((entry) => entry.root === root)?.animationKey || null
}

function sampleObjectTrack(keys, time) {
  if (time <= keys[0].time) return keys[0]
  const last = keys[keys.length - 1]
  if (time >= last.time) return last
  let index = 0
  while (index < keys.length - 1 && keys[index + 1].time < time) index++
  const from = keys[index]
  const to = keys[index + 1]
  const span = to.time - from.time
  const amount = span > 0 ? (time - from.time) / span : 0
  const quaternion = new THREE.Quaternion(...from.quaternion).slerp(new THREE.Quaternion(...to.quaternion), amount)
  return {
    position: from.position.map((value, axis) => value + (to.position[axis] - value) * amount),
    quaternion: quaternion.toArray(),
    scale: from.scale.map((value, axis) => value + (to.scale[axis] - value) * amount),
  }
}

function applyObjectAnimationAt(time, includeSceneTracks = true) {
  const store = useStore.getState()
  const tracks = store.objectAnimData || {}
  for (const entry of o.objects) {
    const keys = tracks[entry.animationKey]
    if (!keys?.length || store.objectAttachmentData?.[entry.animationKey]?.base) continue
    const transform = sampleObjectTrack(keys, time)
    applyObjectTransform(entry.root, transform)
  }
  applyAttachmentAnimationsAt(time, store.objectAttachmentData || {}, tracks)
  if (includeSceneTracks && !(store.characterOrder || []).length) {
    sampleCameraTracks(store.animData?.cameras || {}, time)
    sampleLightTracks(store.animData?.lights || {}, time)
  }
  o.requestRender?.()
}

export function startObjectAnimation() {
  const store = useStore.getState()
  const hasKeys =
    Object.values(store.objectAnimData || {}).some((keys) => keys?.length) ||
    Object.values(store.objectAttachmentData || {}).some((track) => track?.keys?.length) ||
    (!(store.characterOrder || []).length &&
      (Object.values(store.animData?.cameras || {}).some((keys) => keys?.length) ||
        Object.values(store.animData?.lights || {}).some((keys) => keys?.length)))
  if (!hasKeys) return 0
  const duration = getObjectAnimationDuration(store)
  o.animationRest = new Map(o.objects.map((entry) => [entry.animationKey, snapshot(entry.root)]))
  o.sceneAnimationRest = !(store.characterOrder || []).length
    ? {
        cameras: getCamerasPlaybackSnapshot(),
        lights: getLightsPlaybackSnapshot(),
      }
    : null
  store.setObjectAnimTime(0)
  store.setObjectAnimPlaying(true)
  applyObjectAnimationAt(0)
  o.setContinuousRender?.(true)
  return duration
}

export function pauseObjectAnimation() {
  useStore.getState().setObjectAnimPlaying(false)
  o.setContinuousRender?.(false)
  o.requestRender?.()
}

// True when object motion has been started and is currently paused part-way
// (as opposed to never started / stopped), so it can be resumed in place.
export function isObjectAnimationPaused() {
  return !!o.animationRest && !useStore.getState().objectAnimPlaying
}

export function resumeObjectAnimation() {
  const store = useStore.getState()
  if (!o.animationRest) return 0
  const duration = getObjectAnimationDuration(store)
  // Finished a non-looping run? Resuming replays from the start.
  if (store.objectAnimTime >= duration) store.setObjectAnimTime(0)
  store.setObjectAnimPlaying(true)
  o.setContinuousRender?.(true)
  o.requestRender?.()
  return duration
}

export function stopObjectAnimation() {
  pauseObjectAnimation()
  if (o.animationRest) {
    for (const entry of o.objects) {
      const before = o.animationRest.get(entry.animationKey)
      if (before) applySnapshot(entry.root, before)
    }
  }
  const sceneRest = o.sceneAnimationRest
  o.animationRest = null
  o.sceneAnimationRest = null
  applyObjectAnimationAt(0, false)
  if (sceneRest) {
    applyCamerasPlaybackSnapshot(sceneRest.cameras)
    applyLightsPlaybackSnapshot(sceneRest.lights)
  }
  useStore.getState().setObjectAnimTime(0)
  o.requestRender?.()
}

export function scrubObjectAnimation(time) {
  const store = useStore.getState()
  const safeTime = Math.max(0, Math.min(Number(time) || 0, getObjectAnimationDuration(store)))
  store.setObjectAnimTime(safeTime)
  applyObjectAnimationAt(safeTime)
}

export function stepObjectAnimation(delta, loopOverride) {
  const store = useStore.getState()
  if (!store.objectAnimPlaying) return
  const duration = getObjectAnimationDuration(store)
  let time = store.objectAnimTime + Math.max(0, delta) * (Number(store.speed) || 1)
  if (time >= duration) {
    if (loopOverride ?? store.loop) time %= duration
    else {
      time = duration
      store.setObjectAnimPlaying(false)
      o.setContinuousRender?.(false)
    }
  }
  store.setObjectAnimTime(time)
  applyObjectAnimationAt(time)
}

// Resolve a prop or character id to its live scene root for viewport commands.
export function getObjectRootById(id) {
  const prop = o.objects.find((entry) => entry.id === id)
  if (prop) return prop.root
  return o.characterRoots.get(id)?.root || null
}

// Every prop root plus every loaded character root, for a combined scene
// export (see scene.js exportSceneModel). Each root keeps its own current
// world transform (including any bone attachment), so the caller just needs
// to bake that world transform when flattening into one export group.
export function getAllRootsForExport() {
  const props = o.objects
    .filter((e) => e.root.visible)
    .map((e) => ({ root: e.root, name: e.name || 'Object' }))
  const chars = [...o.characterRoots.entries()]
    .filter(([, e]) => e.root.visible)
    .map(([, e]) => ({ root: e.root, name: e.name || 'Character' }))
  return props.concat(chars)
}

// Lightweight per-part listing for every loaded prop (Mesh mode's Parts panel
// uses this to offer props' parts alongside the character's, since — unlike
// the character — every prop's parts are pickable at once with no separate
// "active object" step). Images are a single flat plane already fully
// covered by Object mode, so only real multi-mesh models are listed here.
export function getObjectMeshesInfo() {
  return o.objects
    .filter((e) => e.kind === 'model' && e.meshes.length)
    .map((e) => ({
      objectId: e.id,
      objectName: e.name,
      parts: e.meshes.map((mesh, i) => ({ uuid: mesh.uuid, name: mesh.name || `Part ${i + 1}` })),
    }))
}

export function getObjectsData() {
  return o.objects.map((e) => ({
    name: e.name,
    position: e.root.position.toArray(),
    quaternion: e.root.quaternion.toArray(),
    scale: e.root.scale.toArray(),
    // Bone attachment, if any — position/quaternion/scale above are already
    // bone-LOCAL in that case (see attachObjectToBone), so restoring both
    // together puts the prop right back where it was riding the bone.
    attachedBoneName: e.attachedBoneName || undefined,
    attachedCharacterId: e.attachedCharacterId ?? undefined,
  }))
}

// Apply saved transforms to the currently-loaded props, matching by name.
// `resolveBone(name)` is an optional lookup (e.g. posing.js's getBoneByName)
// used to re-attach a prop that was saved while riding a bone; without it,
// attachment info is ignored and props just land at their saved local TRS.
export function applyObjectsData(list, resolveBone) {
  if (!Array.isArray(list)) return
  const used = new Set()
  for (const item of list) {
    const idx = o.objects.findIndex((e, i) => e.name === item.name && !used.has(i))
    if (idx < 0) continue
    used.add(idx)
    const entry = o.objects[idx]
    const root = entry.root
    const bone = item.attachedBoneName && resolveBone ? resolveBone(item.attachedBoneName) : null
    if (bone) {
      // Raw reparent (no world-preserving math needed — the saved
      // position/quaternion/scale below, applied next, are already the
      // correct bone-local offset).
      bone.add(root)
      entry.attachedBoneName = item.attachedBoneName
      entry.attachedCharacterId = item.attachedCharacterId ?? null
      entry.attachedBone = bone
    } else if (entry.attachedBoneName) {
      // Was attached but the save says otherwise (or the bone no longer
      // exists on whatever's currently loaded) — make sure it's not left
      // dangling under a stale parent.
      if (o.scene) o.scene.add(root)
      entry.attachedBoneName = null
      entry.attachedCharacterId = null
      entry.attachedBone = null
    }
    if (item.position) root.position.fromArray(item.position)
    if (item.quaternion) root.quaternion.fromArray(item.quaternion)
    if (item.scale) root.scale.fromArray(item.scale)
  }
  o.requestRender()
}

export function disposeObjects() {
  if (o.transform) o.transform.detach()
  for (const e of o.objects) {
    if (e.root.parent) e.root.parent.remove(e.root) // may be a bone, not the scene, if attached
    disposePropMaterials(e)
    disposeObject(e.root)
  }
  o.objects = []
  o.selected = null
  for (const batch of [...o.undoStack, ...o.redoStack]) batch.discard?.()
  o.undoStack = []
  o.redoStack = []
  o.dragBefore = null
  o.pivotRoots = []
  o.pivotStartMatrix = null
  o.pivotRootStarts = null
  o.multiDragBefore = null
  o.characterRoots.clear() // owned by the model system; not disposed here
  if (o.helper && o.scene) o.scene.remove(o.helper)
  if (o.pivot && o.scene) o.scene.remove(o.pivot)
  if (o.transform) {
    o.transform.dispose()
    o.transform = null
  }
  o.helper = null
  o.pivot = null
  o.scene = null
  o.camera = null
  o.renderer = null
  o.controls = null
}

// --- internals ---------------------------------------------------------------

// Stamp every material in a subtree so the OutlineEffect skips it.
function excludeFromOutline(obj3d) {
  obj3d.traverse((obj) => {
    if (!obj.material) return
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const m of mats) m.userData.outlineParameters = { visible: false }
  })
}