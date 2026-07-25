import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { disposeObject } from './loadModel.js'

// ---------------------------------------------------------------------------
// Scene objects
//
// Props and backgrounds the character can interact with — separate from the one
// posable character model. Any number can be added; each is a plain Object3D you
// move/rotate/scale with a TransformControls gizmo. Selection is single: attach
// the gizmo to one object at a time, cycling between them from the panel.
//
// These are intentionally NOT run through the material-mode/outline system — a
// background looks best with its own materials, so we also opt them out of the
// character's inverted-hull outline.
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
  characterRoot: null, // the character model root (id 'character'); owned elsewhere
  selected: null, // selected root (or null)
  undoStack: [],
  redoStack: [],
  dragBefore: null, // selected root's TRS at gizmo-drag start
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

// Register the character model root so it can be selected/moved like an object
// (id 'character'). Its geometry is owned by the model system, not here.
export function setCharacterObject(root, name) {
  o.characterRoot = root
  o.characterName = name
}

export function clearCharacterObject() {
  if (o.selected === o.characterRoot && o.transform) o.transform.detach()
  if (o.selected === o.characterRoot) o.selected = null
  o.characterRoot = null
}

// Add a loaded model as a scene object. Returns lightweight metadata for the UI.
// `file` (the original File) is retained so the object can be saved to a project.
export function addObject(parsed, name, format, file) {
  const root = parsed.root
  excludeFromOutline(root) // props aren't part of the toon-outline look
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
  o.objects.push({
    id,
    name,
    format,
    root,
    kind: 'model',
    file: file || null,
    meshes,
    originalMaterials: meshes.map((m) => m.material), // for the lit/unlit toggle
    unlitMaterials: null, // built lazily the first time lighting is turned off
    lit: true,
    castShadow: true,
  })
  o.requestRender()
  return { id, name, format, kind: 'model', lit: true, castShadow: true }
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
  if (id === 'character') return // the character can't be removed here
  const idx = o.objects.findIndex((e) => e.id === id)
  if (idx < 0) return
  const entry = o.objects[idx]
  if (o.selected === entry.root) {
    o.transform.detach()
    o.selected = null
  }
  o.scene.remove(entry.root)
  disposeUnattachedPropMaterials(entry)
  disposeObject(entry.root)
  o.objects.splice(idx, 1)
  o.undoStack = o.undoStack.filter((b) => b.root !== entry.root)
  o.redoStack = o.redoStack.filter((b) => b.root !== entry.root)
  o.requestRender()
}

// Toggle whether a prop responds to the scene's lights. Off swaps in a flat
// MeshBasicMaterial clone (same map/colour, zero shading) — useful for a
// backdrop or prop that should stay visually constant regardless of the light
// rig. Only applies to model props; reference images are already unlit.
export function setObjectLit(id, lit) {
  const entry = o.objects.find((e) => e.id === id && e.kind === 'model')
  if (!entry) return
  entry.lit = lit
  if (!lit && !entry.unlitMaterials) {
    entry.unlitMaterials = entry.meshes.map((m) =>
      Array.isArray(m.material) ? m.material.map(toUnlit) : toUnlit(m.material),
    )
  }
  const source = lit ? entry.originalMaterials : entry.unlitMaterials
  entry.meshes.forEach((mesh, i) => {
    mesh.material = source[i]
  })
  o.requestRender()
}

// Toggle whether a prop casts shadows (it still receives them either way).
export function setObjectCastShadow(id, castShadow) {
  const entry = o.objects.find((e) => e.id === id && e.kind === 'model')
  if (!entry) return
  entry.castShadow = castShadow
  for (const mesh of entry.meshes) mesh.castShadow = castShadow
  o.requestRender()
}

function toUnlit(mat) {
  return new THREE.MeshBasicMaterial({
    map: mat.map || null,
    color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
    transparent: mat.transparent,
    opacity: mat.opacity,
    alphaTest: mat.alphaTest,
    side: mat.side,
    toneMapped: mat.toneMapped,
  })
}

// Dispose whichever of the lit/unlit material sets ISN'T currently attached
// (the attached set is disposed normally, textures and all, by disposeObject).
// Plain .dispose() only — the shared texture is freed once, via the attached
// set, so this must not touch it again.
function disposeUnattachedPropMaterials(entry) {
  if (!entry.unlitMaterials) return
  const other = entry.lit ? entry.unlitMaterials : entry.originalMaterials
  for (const m of other) {
    const mats = Array.isArray(m) ? m : [m]
    for (const mat of mats) mat.dispose()
  }
}

// Resolve an id (numeric prop id or 'character') to its root object.
function rootFor(id) {
  if (id == null) return null
  if (id === 'character') return o.characterRoot
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
  pushUndoIfChanged(o.selected, o.dragBefore)
  o.dragBefore = null
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
      lit: e.kind === 'model' ? e.lit : undefined,
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
    disposeUnattachedPropMaterials(e)
    disposeObject(e.root)
  }
  o.objects = []
  o.selected = null
  o.undoStack = []
  o.redoStack = []
  o.dragBefore = null
  o.characterRoot = null // owned by the model system; not disposed here
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