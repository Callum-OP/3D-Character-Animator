import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { disposeObject } from './loadModel.js'
import { recordOriginalMaterials, applyMaterials, restoreOriginalMaterials, disposeGeneratedMaterials } from './materials.js'

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
  gizmoGrabbed: false, // true once per interaction that actually grabbed a gizmo handle
  lastStyleOpts: { mode: 'unlit', toonSteps: 3, soften: 0, rimLight: null }, // last scene-wide style, for 'auto' objects

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
  transform.addEventListener('objectChange', () => {
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
    attachedBoneName: null, // bone name this prop is parented to, or null
    attachedCharacterId: null, // which character owns that bone
    attachedBone: null, // live Bone Object3D reference (not serialisable)
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
  o.objects.push({
    id,
    name,
    format: 'image',
    root,
    kind: 'image',
    file: file || null,
    attachedBoneName: null,
    attachedCharacterId: null,
    attachedBone: null,
  })
  o.requestRender()
  return { id, name, format: 'image', kind: 'image' }
}

// ---------------------------------------------------------------------------
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
  if (entry.root.parent) entry.root.parent.remove(entry.root) // may be a bone, not the scene, if attached
  disposePropMaterials(entry)
  disposeObject(entry.root)
  o.objects.splice(idx, 1)
  o.pivotRoots = o.pivotRoots.filter((r) => r !== entry.root)
  o.undoStack = o.undoStack.filter((b) => !b.entries.some((e) => e.root === entry.root))
  o.redoStack = o.redoStack.filter((b) => !b.entries.some((e) => e.root === entry.root))
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
  o.undoStack.push({ entries })
  o.redoStack = []
  if (o.undoStack.length > UNDO_LIMIT) o.undoStack.shift()
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
  for (const e of batch.entries) applySnapshot(e.root, e.before)
  o.redoStack.push(batch)
  o.requestRender()
}

export function redo() {
  const batch = o.redoStack.pop()
  if (!batch) return
  for (const e of batch.entries) applySnapshot(e.root, e.after)
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
  o.undoStack.push({ entries: [{ root, before, after }] })
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
      // Bone this prop is riding, if any (transform above is already bone-local).
      attachedBoneName: e.attachedBoneName || undefined,
    }))
}

// --- Scene save/load (transforms only) ---------------------------------------

// Transforms of every prop (by name) for saving a scene layout.
// Live Object3D roots for every prop currently in the scene — used by the
// ragdoll to build obstacle colliders. Excludes the character itself.
export function getObjectRoots() {
  return o.objects.map((e) => e.root)
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