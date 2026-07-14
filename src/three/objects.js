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
}

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
    o.controls.enabled = !e.value // don't orbit while dragging the gizmo
  })
  transform.addEventListener('objectChange', () => o.requestRender())
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
  root.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true
      obj.receiveShadow = true
    }
  })
  o.scene.add(root)
  const id = ++idCounter
  o.objects.push({ id, name, format, root, kind: 'model', file: file || null })
  o.requestRender()
  return { id, name, format }
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
  return { id, name, format: 'image' }
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
  disposeObject(entry.root)
  o.objects.splice(idx, 1)
  o.requestRender()
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

// Reset the selected/target object back to the scene origin, unrotated, unscaled.
export function resetObject(id) {
  const root = rootFor(id)
  if (!root) return
  root.position.set(0, 0, 0)
  root.quaternion.identity()
  root.scale.set(1, 1, 1)
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
    }))
}

// --- Scene save/load (transforms only) ---------------------------------------

// Transforms of every prop (by name) for saving a scene layout.
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
    disposeObject(e.root)
  }
  o.objects = []
  o.selected = null
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
