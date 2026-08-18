import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { disposeObject } from './loadModel.js'
import { recordOriginalMaterials, applyMaterials, restoreOriginalMaterials, disposeGeneratedMaterials } from './materials.js'

// ---------------------------------------------------------------------------
// Scene objects
//
// Props and backgrounds the character can interact with — separate from the one
// posable character model. Any number can be added; each is a plain Object3D you
// move/rotate/scale with a TransformControls gizmo. Selection is single: attach
// the gizmo to one object at a time, cycling between them from the panel.
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

  transform: null, // TransformControls (move/rotate/scale)
  helper: null,
  objects: [], // { id, name, format, root } — props only
  characterRoots: new Map(), // id -> { root, name } — every LOADED character (owned elsewhere), keyed by character id
  selected: null, // selected root (or null)
  undoStack: [],
  redoStack: [],
  dragBefore: null, // selected root's TRS at gizmo-drag start
  onMoveCommit: null, // (root) => void — fired after a gizmo drag actually changes a root's TRS
  gizmoGrabbed: false, // true once per interaction that actually grabbed a gizmo handle
  lastStyleOpts: { mode: 'unlit', toonSteps: 3, soften: 0, rimLight: null }, // last scene-wide style, for 'auto' objects
}

// Register a callback fired whenever a move/rotate/scale drag finishes having
// actually changed something. Used for "auto-key movement" — automatically
// saving a root-motion keyframe when the character is dragged mid-clip.
export function setOnObjectMoveCommit(fn) {
  o.onMoveCommit = fn || null
}

const UNDO_LIMIT = 100

export function initObjects(refs) {
  o.scene = refs.scene
  o.camera = refs.camera
  o.renderer = refs.renderer
  o.controls = refs.controls
  o.requestRender = refs.requestRender

  const transform = new TransformControls(o.camera, o.renderer.domElement)
  transform.setMode('translate')
  transform.setSize(0.9)
  transform.addEventListener('dragging-changed', (e) => {
    // Don't orbit while dragging; stay locked if a camera view has orbit off.
    o.controls.enabled = !e.value && !o.controls.locked
    if (e.value) o.gizmoGrabbed = true // consumed by Viewport's empty-click deselect
  })
  transform.addEventListener('objectChange', () => o.requestRender())
  transform.addEventListener('mouseDown', () => {
    if (o.selected) o.dragBefore = snapshot(o.selected)
  })
  transform.addEventListener('mouseUp', () => {
    commitDragUndo()
    o.requestRender()
  })
  o.transform = transform

  const helper = transform.getHelper()
  excludeFromOutline(helper)
  o.scene.add(helper)
  o.helper = helper
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
    o.characterRoots.delete(id)
  }
}

// Unregister ALL characters (full scene teardown).
export function clearAllCharacterObjects() {
  for (const id of [...o.characterRoots.keys()]) clearCharacterObject(id)
}

// Add a loaded model as a scene object. Returns lightweight metadata for the UI.
// `file` (the original File) is retained so the object can be saved to a project.
export function addObject(parsed, name, format, file) {
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
  }
  o.objects.push(entry)
  applyObjectStyle(entry)
  o.requestRender()
  return { id, name, format, kind: 'model', style: entry.style, outline: entry.outline, castShadow: true }
}

// Add an image as a movable reference plane. `map` is a loaded THREE.Texture;
// `aspect` = image width / height. The plane is built ~1.6 units tall (a rough
// character height) and rests on the ground so it lines up with a standing
// figure out of the box; the user then moves/rotates/scales it like any object.
// Reference images opt out of shadows and the outline — they're 2D guides, not
// props the scene should light.
export function addImage(map, name, aspect, file) {
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
  o.objects.push({ id, name, format: 'image', root, kind: 'image', file: file || null })
  o.requestRender()
  return { id, name, format: 'image', kind: 'image' }
}

// Show or hide an object (prop, image, or the character) without removing it.
export function setObjectVisible(id, visible) {
  const root = rootFor(id)
  if (!root) return
  root.visible = visible
  o.requestRender()
}

export function removeObject(id) {
  if (o.characterRoots.has(id)) return // characters are removed via removeCharacter(), not this
  const idx = o.objects.findIndex((e) => e.id === id)
  if (idx < 0) return
  const entry = o.objects[idx]
  if (o.selected === entry.root) {
    o.transform.detach()
    o.selected = null
  }
  o.scene.remove(entry.root)
  disposePropMaterials(entry)
  disposeObject(entry.root)
  o.objects.splice(idx, 1)
  o.undoStack = o.undoStack.filter((b) => b.root !== entry.root)
  o.redoStack = o.redoStack.filter((b) => b.root !== entry.root)
  o.requestRender()
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

function applyObjectStyle(entry, opts) {
  const use = opts || o.lastStyleOpts
  const mode = entry.style === 'auto' ? use.mode : entry.style
  applyMaterials(
    { meshes: entry.meshes, materials: entry.materials },
    { mode, toonSteps: use.toonSteps, soften: use.soften, rimLight: use.rimLight },
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

// Resolve an id (numeric prop id or a character id) to its root object.
function rootFor(id) {
  if (id == null) return null
  const charEntry = o.characterRoots.get(id)
  if (charEntry) return charEntry.root
  const entry = o.objects.find((e) => e.id === id)
  return entry ? entry.root : null
}

// Attach the gizmo to an object (or null to detach).
export function selectObject(id) {
  if (!o.transform) return
  const root = rootFor(id)
  o.selected = root
  if (root) o.transform.attach(root)
  else o.transform.detach()
  o.requestRender()
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
  applySnapshot(batch.root, batch.before)
  o.redoStack.push(batch)
  o.requestRender()
}

export function redo() {
  const batch = o.redoStack.pop()
  if (!batch) return
  applySnapshot(batch.root, batch.after)
  o.undoStack.push(batch)
  o.requestRender()
}

function snapshot(root) {
  return {
    position: root.position.clone(),
    quaternion: root.quaternion.clone(),
    scale: root.scale.clone(),
  }
}

function applySnapshot(root, snap) {
  root.position.copy(snap.position)
  root.quaternion.copy(snap.quaternion)
  root.scale.copy(snap.scale)
}

function sameSnapshot(a, b) {
  return a.position.equals(b.position) && a.quaternion.equals(b.quaternion) && a.scale.equals(b.scale)
}

function pushUndoIfChanged(root, before) {
  const after = snapshot(root)
  if (sameSnapshot(before, after)) return
  o.undoStack.push({ root, before, after })
  o.redoStack = [] // a fresh edit invalidates any redo history
  if (o.undoStack.length > UNDO_LIMIT) o.undoStack.shift()
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
export function getObjectsForSave() {
  return o.objects
    .filter((e) => e.file)
    .map((e) => ({
      kind: e.kind || 'model',
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
    }))
}

// --- Scene save/load (transforms only) ---------------------------------------

// Transforms of every prop (by name) for saving a scene layout.
// Live Object3D roots for every prop currently in the scene — used by the
// ragdoll to build obstacle colliders. Excludes the character itself.
export function getObjectRoots() {
  return o.objects.map((e) => e.root)
}

export function getObjectsData() {
  return o.objects.map((e) => ({
    name: e.name,
    position: e.root.position.toArray(),
    quaternion: e.root.quaternion.toArray(),
    scale: e.root.scale.toArray(),
  }))
}

// Apply saved transforms to the currently-loaded props, matching by name.
export function applyObjectsData(list) {
  if (!Array.isArray(list)) return
  const used = new Set()
  for (const item of list) {
    const idx = o.objects.findIndex((e, i) => e.name === item.name && !used.has(i))
    if (idx < 0) continue
    used.add(idx)
    const root = o.objects[idx].root
    if (item.position) root.position.fromArray(item.position)
    if (item.quaternion) root.quaternion.fromArray(item.quaternion)
    if (item.scale) root.scale.fromArray(item.scale)
  }
  o.requestRender()
}

export function disposeObjects() {
  if (o.transform) o.transform.detach()
  for (const e of o.objects) {
    if (o.scene) o.scene.remove(e.root)
    disposePropMaterials(e)
    disposeObject(e.root)
  }
  o.objects = []
  o.selected = null
  o.undoStack = []
  o.redoStack = []
  o.dragBefore = null
  o.characterRoots.clear() // owned by the model system; not disposed here
  if (o.helper && o.scene) o.scene.remove(o.helper)
  if (o.transform) {
    o.transform.dispose()
    o.transform = null
  }
  o.helper = null
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