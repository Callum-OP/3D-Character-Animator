import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { markHistoryAction, pushUndoBatch, registerUndoHistory } from './undoHistory.js'
import { showMarquee, hideMarquee, pointInRect } from './marquee.js'

// ---------------------------------------------------------------------------
// Mesh editing (Mesh mode)
//
// Lets the user select an individual part of the character (eyes, hair, a hat…)
// and move / rotate / scale it with a TransformControls gizmo. Parts are picked
// by raycasting the character's meshes directly, so you click the thing you see.
//
// The gizmo does NOT attach to the mesh node directly. Exporters routinely bake
// a part's geometry in world space and leave its node at the origin, so the
// node pivot sits at the character's feet — rotating or resizing "the hair"
// around that would swing it across the scene. Instead, at load time, every
// mesh gets a dedicated invisible pivot Group inserted as its new parent
// (original parent → pivot Group → mesh), placed at the part's bounding-box
// centre with the mesh's rest orientation. The mesh's own local transform
// (relative to that pivot) is fixed once, at wrap time, and never touched
// again — everything the user does (drag the gizmo, type a value, undo,
// keyframe) edits the PIVOT GROUP's transform instead.
//
// This matters a lot for SKINNED parts: skinning is computed entirely in the
// mesh's own local space and only THEN composed with its ancestor transforms
// like any other mesh, so adding an ordinary ancestor (the pivot group) moves
// the already-posed shape rigidly, with zero special-casing. An earlier
// version of this file instead tried to bake the move into the SkinnedMesh's
// bindMatrix/bindMatrixInverse — but GLTFLoader binds every skinned mesh with
// an explicit IDENTITY bind matrix (this pipeline's meshes are always GLTF),
// so that approach was inserting an arbitrary matrix into the middle of the
// bone-skinning chain (between the bone matrices and the vertex) rather than
// applying a clean rigid offset — which is exactly why moved/skinned parts
// would warp, teleport, or vanish. The pivot-group approach never touches
// bindMatrix at all, so it can't hit that bug regardless of how a mesh was
// bound.
//
// Edits are stored on the pivot groups, captured relative to their own rest
// transform, so reset and save/load are exact.
//
// Multi-select (Shift/Ctrl-click, or Shift/Ctrl-drag a box) works the same way
// objects.js and posing.js do it: TransformControls can only attach to one
// Object3D, so with 2+ parts selected the gizmo sits on an invisible group
// pivot at their centroid. Dragging it is turned into a world-space delta
// matrix that is re-applied to every selected part's own pivot Group.
// ---------------------------------------------------------------------------

const DRAG_SLOP_PX = 4 // pointer travel above this is an orbit-drag, not a click
const HIGHLIGHT_COLOR = 0xffc24a // matches the selected bone-dot tint

// Module state (mirrors the scene-manager singleton style used elsewhere).
const m = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  requestRender: () => {},
  onSelect: null, // (meshUuid|null, additive) => void — reports picks up to the store
  onSelectMany: null, // (meshUuids[], additive) => void — reports a box-select up to the store
  onChange: null, // () => void — any transform edit; the panel re-reads values
  onVisibilityChange: null,

  transform: null, // TransformControls (move/rotate/scale)
  helper: null,

  model: null,
  meshes: [], // the character's Mesh/SkinnedMesh nodes
  objectMeshes: [], // Mesh/SkinnedMesh nodes belonging to scene objects (props), flattened
  objectMeshGroups: new Map(), // objectId -> meshes[] registered for that object (for clean removal)
  meshByUuid: new Map(),
  rest: new Map(), // Mesh -> { pivot, position, quaternion, scale } (see setMeshEditModel)

  selected: null, // primary selected Mesh (the last one picked), or null
  selectedList: [], // every selected Mesh (always includes `selected` when non-empty)
  boxes: new Map(), // Mesh -> BoxHelper/Box3Helper highlight around that selected part
  groupPivot: null, // invisible Object3D the gizmo attaches to when 2+ parts are selected
  groupStartMatrix: null, // groupPivot's matrix at the start of the current group drag
  groupStarts: null, // Map(Mesh -> world Matrix4 of its pivot) at drag start
  groupBefore: null, // [{ obj, before }] pivot snapshots at drag start, for undo
  marquee: null, // { x0, y0 } screen-space start point while Shift/Ctrl-dragging a box-select
  enabled: false, // true only while the app is in Mesh mode
  suspended: false, // true while animation playback drives the parts
  undoStack: [],
  redoStack: [],
  dragBefore: null, // selected part's pivot TRS at gizmo-drag start
  pointerDown: null, // { x, y, axis } for click-vs-drag discrimination
  gizmoMovedDuringDrag: false, // true once an axis-grab actually moves something (see onPointerDown/Up)
  raycaster: new THREE.Raycaster(),
  posedProxies: new Map(), // SkinnedMesh -> { proxy, geometry } — see getPosedLocalPositions()
}

const _ndc = new THREE.Vector2()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()

registerUndoHistory('mesh', () => ({ undo: m.undoStack, redo: m.redoStack }))

export function initMeshEdit(refs) {
  m.scene = refs.scene
  m.camera = refs.camera
  m.renderer = refs.renderer
  m.controls = refs.controls
  m.requestRender = refs.requestRender
  m.onSelect = refs.onSelect
  m.onSelectMany = refs.onSelectMany || null
  m.onChange = refs.onChange || null
  m.onVisibilityChange = refs.onVisibilityChange || null

  const transform = new TransformControls(m.camera, m.renderer.domElement)
  transform.setMode('translate')
  transform.setSize(0.9)
  transform.addEventListener('dragging-changed', (e) => {
    m.controls.enabled = !e.value && !m.controls.locked
  })
  transform.addEventListener('objectChange', () => {
    m.gizmoMovedDuringDrag = true // a real drag happened, not just a press on the handle's pick padding
    if (isGroupSelection() && m.groupStartMatrix) applyGroupDelta()
    notifyChange()
    m.requestRender()
  })
  transform.addEventListener('mouseDown', () => {
    if (isGroupSelection()) {
      beginGroupDrag()
    } else if (m.selected) {
      const rest = m.rest.get(m.selected)
      if (rest) m.dragBefore = snapshot(rest.pivot)
    }
  })
  transform.addEventListener('mouseUp', () => {
    if (isGroupSelection()) commitGroupUndo()
    else commitDragUndo()
    m.requestRender()
  })
  m.transform = transform

  const helper = transform.getHelper()
  excludeFromOutline(helper)
  m.scene.add(helper)
  m.helper = helper

  // Invisible anchor for the group gizmo — never rendered, never a mesh part.
  const groupPivot = new THREE.Object3D()
  groupPivot.visible = false
  m.scene.add(groupPivot)
  m.groupPivot = groupPivot

  const dom = m.renderer.domElement
  m._onPointerDown = onPointerDown
  m._onPointerUp = onPointerUp
  m._onPointerMove = onPointerMove
  dom.addEventListener('pointerdown', m._onPointerDown)
  dom.addEventListener('pointerup', m._onPointerUp)
  dom.addEventListener('pointermove', m._onPointerMove)
}

// Bind mesh editing to a freshly loaded model: give every part a dedicated
// pivot Group (see header comment) and record its rest transform.
export function setMeshEditModel(model) {
  clearMeshEditModel()
  m.model = model
  m.meshes = model.meshes || []
  for (const mesh of m.meshes) {
    m.meshByUuid.set(mesh.uuid, mesh)
    wrapMeshForEdit(mesh)
  }
}

// Give a scene object's (prop's) parts the same pivot-wrapped, gizmo-editable
// treatment as a character's parts (see the header comment for why the pivot
// indirection exists). Unlike the character — which is single-active and
// fully re-registered via setMeshEditModel on every switch — any number of
// props can be loaded at once, so their meshes are tracked additively here,
// keyed by objectId, and only ever added/removed as props are added/removed
// (never wholesale-cleared when the active character changes).
export function registerObjectMeshes(objectId, meshes) {
  const wrapped = []
  for (const mesh of meshes || []) {
    if (m.rest.has(mesh)) continue // already wrapped — don't double-wrap
    wrapMeshForEdit(mesh)
    m.meshByUuid.set(mesh.uuid, mesh)
    wrapped.push(mesh)
  }
  m.objectMeshGroups.set(objectId, wrapped)
  m.objectMeshes = m.objectMeshes.concat(wrapped)
}

// Unregister a prop's parts (called when the prop is removed/disposed). The
// pivot Groups themselves live inside the prop's own subtree and are freed
// along with it by the caller (objects.js) — this just drops our bookkeeping
// so they're no longer pickable/selectable and don't leak in these maps.
export function unregisterObjectMeshes(objectId) {
  const meshes = m.objectMeshGroups.get(objectId)
  if (!meshes || !meshes.length) {
    m.objectMeshGroups.delete(objectId)
    return
  }
  m.objectMeshGroups.delete(objectId)
  const removed = new Set(meshes)
  m.objectMeshes = m.objectMeshes.filter((mesh) => !removed.has(mesh))
  dropFromSelection(removed)
  for (const mesh of meshes) {
    m.meshByUuid.delete(mesh.uuid)
    m.rest.delete(mesh)
    m.posedProxies.delete(mesh)
  }
}

// Wraps a single mesh in an editable pivot Group (see the file header comment
// for the full rationale) and records its rest transform in m.rest. Shared by
// setMeshEditModel (the active character) and registerObjectMeshes (props).
function wrapMeshForEdit(mesh) {
  const parent = mesh.parent
  mesh.updateMatrix()

    // Mesh's local transform relative to `parent`, BEFORE wrapping — fixed
    // forever after this point. Needed below to keep SkinnedMesh rendering
    // correctly once wrapped.
    const restLocalMatrix = mesh.matrix.clone()

    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()

    const pivotPos = mesh.geometry.boundingBox.getCenter(new THREE.Vector3())
    pivotPos.applyMatrix4(mesh.matrix)
    const pivotLocalMatrix = new THREE.Matrix4().compose(
      pivotPos,
      mesh.quaternion.clone(),
      new THREE.Vector3(1, 1, 1),
    )
    const pivotLocalMatrixInverse = pivotLocalMatrix.clone().invert()
    const newMeshLocal = new THREE.Matrix4().multiplyMatrices(pivotLocalMatrixInverse, mesh.matrix)

    const pivot = new THREE.Object3D()
    pivot.name = (mesh.name || 'part') + ' (pivot)'
    pivot.userData.meshEditPivot = true
    pivotLocalMatrix.decompose(pivot.position, pivot.quaternion, pivot.scale)
    parent.add(pivot)
    pivot.add(mesh)
    newMeshLocal.decompose(mesh.position, mesh.quaternion, mesh.scale)
    mesh.updateMatrix()

    // SkinnedMesh recomputes bindMatrixInverse on EVERY updateMatrixWorld()
    // call, and neither built-in bindMode is right for a mesh we've just
    // wrapped in an editable pivot:
    //  - 'attached' derives it from the mesh's OWN live matrixWorld — which
    //    includes the pivot's edit — so it cancels our deliberate edit right
    //    back out. That's the original "Move/Rotate/Resize only ever moved
    //    the bounding-box helper, never the visible mesh" bug.
    //  - Freezing it to a fixed snapshot fixes THAT, but breaks the moment
    //    `parent` (an ancestor of the pivot — e.g. the whole character)
    //    moves or rotates afterward, since the snapshot can't track it:
    //    `parent`'s later transform ends up applied twice — a rotation gets
    //    doubled, turning a straight "move left" into a diagonal drift, and
    //    the pose bone dots (driven by the same skeleton, with no pivot in
    //    THEIR ancestry to double up) stop matching the mesh.
    //  - Cancelling `parent.matrixWorld` alone (live, no snapshot) fixes
    //    THAT in turn, but is still wrong whenever this mesh's own rest
    //    local transform (`restLocalMatrix` above — essentially always
    //    non-trivial, since a real mesh part's bounding-box centre is
    //    basically never exactly at its own local origin) is non-identity:
    //    that fixed piece then gets incorrectly dragged along by whatever
    //    `parent` does later, a different wrong amount for every mesh part
    //    (each has its own bounding box), which is exactly what scatters a
    //    multi-part character (tshirt/body/hair/shoes...) apart from itself.
    //
    // What's actually needed is dynamic in exactly one place — `parent`,
    // since only its ancestry can legitimately keep changing later (e.g. the
    // whole character moving) — while also still cancelling this mesh's own
    // FIXED rest-local transform, every frame, so the two compose correctly
    // together rather than one distorting the other.
    if (mesh.isSkinnedMesh) {
      mesh.updateMatrixWorld = function (force) {
        THREE.Object3D.prototype.updateMatrixWorld.call(mesh, force)
        mesh.bindMatrixInverse.multiplyMatrices(parent.matrixWorld, restLocalMatrix).invert()
      }
    }

    m.rest.set(mesh, {
      pivot,
      position: pivot.position.clone(),
      quaternion: pivot.quaternion.clone(),
      scale: pivot.scale.clone(),
    })
}

const MORPH_LINK_PROXIMITY_FACTOR = 3

function getWorldBoundingSphere(mesh) {
  if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere()
  const sphere = mesh.geometry.boundingSphere
  mesh.updateMatrixWorld()
  const center = sphere.center.clone().applyMatrix4(mesh.matrixWorld)
  const worldScale = mesh.getWorldScale(new THREE.Vector3())
  const radius = sphere.radius * Math.max(worldScale.x, worldScale.y, worldScale.z)
  return { center, radius }
}

export function getLinkedMorphTargets(sourceMesh, morphName) {
  if (!sourceMesh || !m.meshes.length) return []
  const src = getWorldBoundingSphere(sourceMesh)
  const results = []
  for (const mesh of m.meshes) {
    if (mesh === sourceMesh) continue
    const dict = mesh.morphTargetDictionary
    if (!dict || !(morphName in dict) || !mesh.morphTargetInfluences) continue
    const other = getWorldBoundingSphere(mesh)
    const threshold = (src.radius + other.radius) * MORPH_LINK_PROXIMITY_FACTOR
    if (src.center.distanceTo(other.center) <= threshold) {
      results.push({ mesh, idx: dict[morphName] })
    }
  }
  return results
}

export function getMeshIndex(mesh) {
  return m.meshes.indexOf(mesh)
}

// Name-based lookups for the ACTIVE CHARACTER's own meshes only (m.meshes —
// never props). Used to make saved clip data (mesh transform + morph keys)
// portable across characters: a clip is authored against mesh INDICES, which
// only mean anything for the character it was made on, so it gets converted
// to/from mesh NAME at save/load time. Two different models rarely share
// mesh indices but often share meaningful names (e.g. exported from the same
// rig/base mesh, or just conventionally named "Head", "Body", …).
//
// Names are only trusted when they're UNIQUE on the character. Exporters
// (some glTF exporters especially) routinely leave several parts sharing the
// same name, or no name at all — matching by a non-unique name would collapse
// two different meshes' data onto one key, or send an edit to the wrong part
// entirely (e.g. a moving keyframe meant for a hat pivot silently landing on
// a foot/shoe mesh instead, since both happened to be named "Object"). An
// ambiguous name is treated as unmatched — the data for that mesh is skipped
// rather than risking it lands on the wrong part.
function meshNameCounts() {
  const counts = new Map()
  for (const mesh of m.meshes) {
    if (!mesh.name) continue
    counts.set(mesh.name, (counts.get(mesh.name) || 0) + 1)
  }
  return counts
}

export function getMeshNameByIndex(index) {
  const mesh = m.meshes[index]
  if (!mesh || !mesh.name) return null
  return meshNameCounts().get(mesh.name) === 1 ? mesh.name : null
}

export function findMeshIndexByName(name) {
  if (!name) return -1
  let match = -1
  for (let i = 0; i < m.meshes.length; i++) {
    if (m.meshes[i].name !== name) continue
    if (match !== -1) return -1 // a second match makes this name ambiguous — refuse both
    match = i
  }
  return match
}

// Looks up any currently mesh-editable part by uuid — the active character's
// OR any loaded prop's. Lets the Parts panel resolve a selection generically
// instead of only ever checking the character's mesh list.
export function getMeshByUuid(uuid) {
  return m.meshByUuid.get(uuid) || null
}

// True if `mesh` belongs to a registered scene object (prop) rather than the
// active character — the panel uses this to hide character-only sections
// (cloth, morphs, animation keyframing) for a prop's part.
export function isObjectMesh(mesh) {
  return m.objectMeshes.includes(mesh)
}

// Also used by clothmod.js so it can find a mesh's pivot group directly.
export function getMeshPivot(mesh) {
  const rest = m.rest.get(mesh)
  return rest ? rest.pivot : null
}

// Clears out the ACTIVE CHARACTER's parts only. Scene objects (props)
// registered via registerObjectMeshes are intentionally left alone — they
// aren't tied to which character is active and shouldn't disappear (or lose
// their edits) just because the user switched characters.
export function clearMeshEditModel() {
  const oldMeshes = m.meshes
  dropFromSelection(new Set(oldMeshes))
  disposePosedProxies() // cheap to rebuild; simplest to drop proxies for everyone on a switch

  // Undo/redo batches reference pivots directly, so batches belonging to the
  // character being cleared would otherwise sit in the stack undoing a part
  // on a model that's no longer active/loaded. Drop just those; prop batches
  // (and any other character not being touched here) are unaffected.
  const oldPivots = new Set(oldMeshes.map((mesh) => m.rest.get(mesh)?.pivot).filter(Boolean))
  const keepsBatch = (batch) => !batch.some((e) => oldPivots.has(e.obj))
  m.undoStack = m.undoStack.filter(keepsBatch)
  m.redoStack = m.redoStack.filter(keepsBatch)

  for (const mesh of oldMeshes) {
    unwrapMeshForEdit(mesh)
    m.meshByUuid.delete(mesh.uuid)
    m.rest.delete(mesh)
  }
  m.model = null
  m.meshes = []
}

export function setMeshEditEnabled(enabled) {
  m.enabled = enabled
  if (m.transform) {
    if (enabled && m.selected && !m.suspended) attachToSelected()
    else m.transform.detach()
  }
  updateSelectionBoxes()
  m.requestRender()
}

export function selectMesh(uuid) {
  selectMeshes(uuid ? [uuid] : [])
}

// Select several parts at once (shift/ctrl-click, or a box-select). With 0 or
// 1 parts this is exactly the old single-select; with 2+ the gizmo attaches to
// a shared group pivot at their centroid so one drag edits them all. The LAST
// uuid becomes the primary part (the one the panel's single-part controls
// read), matching how bones and objects treat their own multi-selections.
export function selectMeshes(uuids) {
  const list = []
  const seen = new Set()
  for (const uuid of Array.isArray(uuids) ? uuids : uuids != null ? [uuids] : []) {
    const mesh = m.meshByUuid.get(uuid)
    if (mesh && !seen.has(mesh)) {
      seen.add(mesh)
      list.push(mesh)
    }
  }
  applySelection(list)
}

function applySelection(list) {
  m.selectedList = list
  m.selected = list.length ? list[list.length - 1] : null
  m.dragBefore = null
  clearGroupDrag()
  if (list.length > 1) placeGroupPivot()
  if (m.transform) {
    if (m.selected && m.enabled && !m.suspended) attachToSelected()
    else m.transform.detach()
  }
  updateSelectionBoxes()
  m.requestRender()
}

// World-space bounds of a part, for framing the camera on it. A skinned part is
// measured from its POSED vertices (a plain Box3.setFromObject would read the
// rest-pose geometry and frame the wrong spot on a posed character).
export function getMeshWorldBounds(uuid) {
  const mesh = uuid ? m.meshByUuid.get(uuid) || null : null
  if (!mesh) return null
  if (m.scene) m.scene.updateMatrixWorld(true)
  else mesh.updateWorldMatrix(true, false)
  if (mesh.isSkinnedMesh) {
    const { geometry } = refreshPosedProxy(mesh)
    return geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld)
  }
  return new THREE.Box3().setFromObject(mesh)
}

// Test hook: replay a group-gizmo drag — press, let the caller move/rotate/scale
// the invisible group pivot (what dragging the gizmo does), fire the change, and
// release — on the real TransformControls instance, without a full raycaster/DOM
// harness for the gizmo handles themselves. Mirrors objects.js's
// simulateGizmoDragForTest and posing.js's simulateGroupRotateForTest.
export function simulateGroupDragForTest(mutatePivot) {
  if (!m.transform || !m.groupPivot || !isGroupSelection()) return false
  m.transform.dispatchEvent({ type: 'mouseDown' })
  mutatePivot(m.groupPivot)
  m.transform.dispatchEvent({ type: 'objectChange' })
  m.transform.dispatchEvent({ type: 'mouseUp' })
  return true
}

export function getSelectedMeshUuids() {
  return m.selectedList.map((mesh) => mesh.uuid)
}

function isGroupSelection() {
  return m.selectedList.length > 1 && !!m.groupPivot
}

// Selected parts that are removed out from under the selection (a prop deleted,
// the active character swapped) just fall out of it; whatever is left stays.
function dropFromSelection(removed) {
  if (!m.selectedList.some((mesh) => removed.has(mesh))) return
  applySelection(m.selectedList.filter((mesh) => !removed.has(mesh)))
}

const _gc = new THREE.Vector3()
const _gw = new THREE.Vector3()
function placeGroupPivot() {
  _gc.set(0, 0, 0)
  for (const mesh of m.selectedList) {
    const rest = m.rest.get(mesh)
    if (!rest) continue
    rest.pivot.updateWorldMatrix(true, false)
    _gc.add(rest.pivot.getWorldPosition(_gw))
  }
  _gc.divideScalar(m.selectedList.length)
  m.groupPivot.position.copy(_gc)
  m.groupPivot.quaternion.identity()
  m.groupPivot.scale.set(1, 1, 1)
  m.groupPivot.updateMatrix()
  m.groupPivot.updateMatrixWorld(true)
}

function clearGroupDrag() {
  m.groupStartMatrix = null
  m.groupStarts = null
  m.groupBefore = null
}

function beginGroupDrag() {
  m.groupPivot.updateMatrix()
  m.groupStartMatrix = m.groupPivot.matrix.clone()
  m.groupStarts = new Map()
  m.groupBefore = []
  for (const mesh of m.selectedList) {
    const rest = m.rest.get(mesh)
    if (!rest) continue
    rest.pivot.updateWorldMatrix(true, false)
    m.groupStarts.set(mesh, rest.pivot.matrixWorld.clone())
    m.groupBefore.push({ obj: rest.pivot, before: snapshot(rest.pivot) })
  }
}

// Re-apply the group pivot's drag to every selected part:
//   delta = groupPivot.matrix * inverse(groupPivot.matrix at drag start)
//   part's new WORLD matrix = delta * its world matrix at drag start
// then convert that back into the part pivot's LOCAL transform under its own
// parent (parts live under different parents — character armature, each prop —
// so this can't be done in one shared space).
const _gDelta = new THREE.Matrix4()
const _gInv = new THREE.Matrix4()
const _gNext = new THREE.Matrix4()
function applyGroupDelta() {
  m.groupPivot.updateMatrix()
  _gDelta.multiplyMatrices(m.groupPivot.matrix, _gInv.copy(m.groupStartMatrix).invert())
  for (const mesh of m.selectedList) {
    const rest = m.rest.get(mesh)
    const start = m.groupStarts && m.groupStarts.get(mesh)
    if (!rest || !start) continue
    _gNext.multiplyMatrices(_gDelta, start)
    const parent = rest.pivot.parent
    if (parent) {
      parent.updateWorldMatrix(true, false)
      _gNext.premultiply(_gInv.copy(parent.matrixWorld).invert())
    }
    _gNext.decompose(rest.pivot.position, rest.pivot.quaternion, rest.pivot.scale)
  }
}

function commitGroupUndo() {
  const before = m.groupBefore
  clearGroupDrag()
  if (!before) return
  const batch = []
  for (const { obj, before: b } of before) {
    const after = snapshot(obj)
    if (!sameSnapshot(b, after)) batch.push({ obj, before: b, after })
  }
  if (batch.length) pushUndo(batch)
}

export function setMeshVisible(uuid, visible) {
  const mesh = uuid ? m.meshByUuid.get(uuid) || null : null
  if (!mesh || mesh.visible === visible) return
  const beforeVisible = mesh.visible
  mesh.visible = visible
  pushUndo([{ mesh, beforeVisible, afterVisible: visible }])
  notifyChange()
  m.requestRender()
}

// Show/hide several parts as ONE undo step.
export function setMeshesVisible(uuids, visible) {
  const batch = []
  for (const uuid of uuids || []) {
    const mesh = m.meshByUuid.get(uuid)
    if (!mesh || mesh.visible === visible) continue
    batch.push({ mesh, beforeVisible: mesh.visible, afterVisible: visible })
    mesh.visible = visible
  }
  if (batch.length) pushUndo(batch)
  notifyChange()
  m.requestRender()
}

export function suspendMeshEdit() {
  m.suspended = true
  if (m.transform) m.transform.detach()
  m.requestRender()
}

export function resumeMeshEdit() {
  m.suspended = false
  if (m.enabled && m.selected && m.transform) attachToSelected()
  m.requestRender()
}

function attachToSelected() {
  if (isGroupSelection()) {
    m.transform.attach(m.groupPivot)
    return
  }
  const rest = m.rest.get(m.selected)
  if (rest) m.transform.attach(rest.pivot)
}

export function setMeshGizmoMode(mode) {
  if (!m.transform) return
  m.transform.setMode(mode)
  m.requestRender()
}

export function updateMeshEditHelpers() {
  // Box3Helper (used for a skinned/posed part) has no per-frame update() —
  // it just sits under the pivot and follows gizmo drags via the transform
  // hierarchy. Only the rest-pose BoxHelper needs re-reading each frame.
  for (const box of m.boxes.values()) {
    if (box.visible && typeof box.update === 'function') box.update()
  }
}

export function getMeshDelta(uuid) {
  const mesh = m.meshByUuid.get(uuid)
  const rest = mesh && m.rest.get(mesh)
  if (!mesh || !rest) return null
  const pivot = rest.pivot
  const invRestQuat = _quat.copy(rest.quaternion).invert()
  const offset = _pos.copy(pivot.position).sub(rest.position).applyQuaternion(invRestQuat)
  const relQuat = invRestQuat.clone().multiply(pivot.quaternion)
  const e = new THREE.Euler().setFromQuaternion(relQuat, 'XYZ')
  return {
    offset: [offset.x, offset.y, offset.z],
    rotation: [
      THREE.MathUtils.radToDeg(e.x),
      THREE.MathUtils.radToDeg(e.y),
      THREE.MathUtils.radToDeg(e.z),
    ],
    scale: [
      pivot.scale.x / rest.scale.x,
      pivot.scale.y / rest.scale.y,
      pivot.scale.z / rest.scale.z,
    ],
  }
}

export function setMeshDelta(uuid, delta) {
  const mesh = m.meshByUuid.get(uuid)
  const rest = mesh && m.rest.get(mesh)
  if (!mesh || !rest) return
  const pivot = rest.pivot
  const before = snapshot(pivot)
  const cur = { ...getMeshDelta(uuid), ...delta }

  const offset = _pos.set(cur.offset[0], cur.offset[1], cur.offset[2]).applyQuaternion(rest.quaternion)
  pivot.position.copy(rest.position).add(offset)

  const rotQuat = _quat.setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(cur.rotation[0]),
      THREE.MathUtils.degToRad(cur.rotation[1]),
      THREE.MathUtils.degToRad(cur.rotation[2]),
      'XYZ',
    ),
  )
  pivot.quaternion.copy(rest.quaternion).multiply(rotQuat)
  pivot.scale.set(
    rest.scale.x * cur.scale[0],
    rest.scale.y * cur.scale[1],
    rest.scale.z * cur.scale[2],
  )

  pushUndoIfChanged(pivot, before)
  notifyChange()
  m.requestRender()
}

export function resetMesh(uuid) {
  const mesh = m.meshByUuid.get(uuid)
  const rest = mesh && m.rest.get(mesh)
  if (!mesh || !rest) return
  const before = snapshot(rest.pivot)
  applySnapshot(rest.pivot, rest)
  pushUndoIfChanged(rest.pivot, before)
  notifyChange()
  m.requestRender()
}

// Put several parts back to rest as ONE undo step (the multi-selection's
// "Reset selected").
export function resetMeshes(uuids) {
  const batch = []
  for (const uuid of uuids || []) {
    const mesh = m.meshByUuid.get(uuid)
    const rest = mesh && m.rest.get(mesh)
    if (!rest || isAtRest(rest.pivot, rest)) continue
    batch.push({ obj: rest.pivot, before: snapshot(rest.pivot), after: restSnapshot(rest) })
    applySnapshot(rest.pivot, rest)
  }
  if (batch.length) pushUndo(batch)
  if (isGroupSelection()) placeGroupPivot()
  notifyChange()
  m.requestRender()
}

export function resetAllMeshes() {
  const batch = []
  for (const mesh of m.meshes) {
    const rest = m.rest.get(mesh)
    if (!rest || isAtRest(rest.pivot, rest)) continue
    batch.push({ obj: rest.pivot, before: snapshot(rest.pivot), after: restSnapshot(rest) })
    applySnapshot(rest.pivot, rest)
  }
  if (batch.length) pushUndo(batch)
  notifyChange()
  m.requestRender()
}

export function hasMeshEdits() {
  for (const mesh of m.meshes) {
    const rest = m.rest.get(mesh)
    if (rest && !isAtRest(rest.pivot, rest)) return true
  }
  return false
}

export function undo() {
  const batch = m.undoStack.pop()
  if (!batch) return
  for (const entry of batch) applyHistoryEntry(entry, 'before')
  if (isGroupSelection()) placeGroupPivot() // keep the group gizmo on the parts after undo/redo
  markHistoryAction(batch)
  m.redoStack.push(batch)
  notifyChange()
  m.requestRender()
}

export function redo() {
  const batch = m.redoStack.pop()
  if (!batch) return
  for (const entry of batch) applyHistoryEntry(entry, 'after')
  if (isGroupSelection()) placeGroupPivot() // keep the group gizmo on the parts after undo/redo
  markHistoryAction(batch)
  m.undoStack.push(batch)
  notifyChange()
  m.requestRender()
}

export function getMeshKeyValue(uuid) {
  const mesh = m.meshByUuid.get(uuid)
  const rest = mesh && m.rest.get(mesh)
  if (!rest) return null
  return {
    pos: rest.pivot.position.toArray(),
    quat: rest.pivot.quaternion.toArray(),
    scale: rest.pivot.scale.toArray(),
  }
}

export function getMeshPlaybackSnapshot() {
  return m.meshes.map((mesh) => {
    const rest = m.rest.get(mesh)
    return { obj: rest.pivot, ...snapshot(rest.pivot) }
  })
}

export function applyMeshPlaybackSnapshot(snap) {
  if (!snap) return
  for (const s of snap) applySnapshot(s.obj, s)
}

export function sampleMeshTracks(tracks, t) {
  for (const [index, keys] of Object.entries(tracks)) {
    const mesh = m.meshes[Number(index)]
    const rest = mesh && m.rest.get(mesh)
    if (!rest || !keys || keys.length === 0) continue
    sampleMeshKeys(keys, t, rest.pivot)
  }
}

const _kq0 = new THREE.Quaternion()
const _kq1 = new THREE.Quaternion()

function sampleMeshKeys(keys, t, pivot) {
  if (t <= keys[0].time) return applyMeshKey(pivot, keys[0])
  const last = keys[keys.length - 1]
  if (t >= last.time) return applyMeshKey(pivot, last)
  let i = 0
  while (i < keys.length - 1 && keys[i + 1].time < t) i++
  const k0 = keys[i]
  const k1 = keys[i + 1]
  const span = k1.time - k0.time
  const f = span > 0 ? (t - k0.time) / span : 0
  const lerp3 = (out, v0, v1) =>
    out.set(v0[0] + (v1[0] - v0[0]) * f, v0[1] + (v1[1] - v0[1]) * f, v0[2] + (v1[2] - v0[2]) * f)
  lerp3(pivot.position, k0.pos, k1.pos)
  lerp3(pivot.scale, k0.scale, k1.scale)
  _kq0.fromArray(k0.quat)
  _kq1.fromArray(k1.quat)
  pivot.quaternion.slerpQuaternions(_kq0, _kq1, f)
}

function applyMeshKey(pivot, k) {
  pivot.position.fromArray(k.pos)
  pivot.quaternion.fromArray(k.quat)
  pivot.scale.fromArray(k.scale)
}

export function getMeshEditsData() {
  const out = []
  m.meshes.forEach((mesh, index) => {
    const rest = m.rest.get(mesh)
    if (!rest || isAtRest(rest.pivot, rest)) return
    out.push({
      index,
      position: rest.pivot.position.toArray(),
      quaternion: rest.pivot.quaternion.toArray(),
      scale: rest.pivot.scale.toArray(),
    })
  })
  return out
}

export function applyMeshEditsData(list) {
  if (!Array.isArray(list)) return
  for (const item of list) {
    const mesh = m.meshes[item.index]
    const rest = mesh && m.rest.get(mesh)
    if (!rest) continue
    if (item.position) rest.pivot.position.fromArray(item.position)
    if (item.quaternion) rest.pivot.quaternion.fromArray(item.quaternion)
    if (item.scale) rest.pivot.scale.fromArray(item.scale)
  }
  notifyChange()
  m.requestRender()
}

export function setViewCamera(camera) {
  m.camera = camera
  if (m.transform) m.transform.camera = camera
}

export function disposeMeshEdit() {
  const dom = m.renderer && m.renderer.domElement
  if (dom) {
    dom.removeEventListener('pointerdown', m._onPointerDown)
    dom.removeEventListener('pointerup', m._onPointerUp)
    dom.removeEventListener('pointermove', m._onPointerMove)
  }
  hideMarquee()
  m.marquee = null
  clearMeshEditModel()
  m.objectMeshes = []
  m.objectMeshGroups = new Map()
  m.meshByUuid = new Map()
  m.rest = new Map()
  m.undoStack = []
  m.redoStack = []
  m.selected = null
  m.selectedList = []
  clearGroupDrag()
  removeAllSelectionBoxes()
  if (m.groupPivot) {
    if (m.scene) m.scene.remove(m.groupPivot)
    m.groupPivot = null
  }
  m.suspended = false
  if (m.helper) {
    m.scene.remove(m.helper)
    m.helper = null
  }
  if (m.transform) {
    m.transform.dispose()
    m.transform = null
  }
  m.scene = null
  m.camera = null
  m.renderer = null
  m.controls = null
}

function snapshot(obj) {
  return {
    position: obj.position.clone(),
    quaternion: obj.quaternion.clone(),
    scale: obj.scale.clone(),
  }
}

function restSnapshot(rest) {
  return {
    position: rest.position.clone(),
    quaternion: rest.quaternion.clone(),
    scale: rest.scale.clone(),
  }
}

function applySnapshot(obj, snap) {
  obj.position.copy(snap.position)
  obj.quaternion.copy(snap.quaternion)
  obj.scale.copy(snap.scale)
}

function applyHistoryEntry(entry, side) {
  if (entry.mesh) {
    const visible = entry[`${side}Visible`]
    entry.mesh.visible = visible
    if (m.onVisibilityChange) m.onVisibilityChange(entry.mesh.uuid, visible)
    return
  }
  applySnapshot(entry.obj, entry[side])
}

function isAtRest(obj, rest) {
  return (
    obj.position.equals(rest.position) &&
    obj.quaternion.equals(rest.quaternion) &&
    obj.scale.equals(rest.scale)
  )
}

function sameSnapshot(a, b) {
  return a.position.equals(b.position) && a.quaternion.equals(b.quaternion) && a.scale.equals(b.scale)
}

function pushUndo(batch) {
  pushUndoBatch('mesh', batch)
}

function pushUndoIfChanged(obj, before) {
  const after = snapshot(obj)
  if (!sameSnapshot(before, after)) pushUndo([{ obj, before, after }])
}

function commitDragUndo() {
  if (!m.selected || !m.dragBefore) return
  const rest = m.rest.get(m.selected)
  if (rest) pushUndoIfChanged(rest.pivot, m.dragBefore)
  m.dragBefore = null
}

function notifyChange() {
  if (m.onChange) m.onChange()
}

// A plain BoxHelper(mesh) reads the mesh's REST-pose geometry, which is fine
// for an unposed/unskinned part but places the box at the wrong spot for a
// skinned part on a posed character (see the posed-skin comment above
// onPointerUp). For those, build the box from the same posed proxy used for
// picking, expressed in the PIVOT's local space (mesh's own local transform
// relative to its pivot is fixed forever — see setMeshEditModel — so this
// still tracks live gizmo drags for free once parented under the pivot).
//
// One highlight box per selected part (a multi-selection shows them all).
function updateSelectionBoxes() {
  const show = m.enabled
  const wanted = new Set(show ? m.selectedList : [])
  for (const mesh of [...m.boxes.keys()]) {
    if (!wanted.has(mesh)) removeSelectionBox(mesh)
  }
  for (const mesh of wanted) ensureSelectionBox(mesh)
  for (const box of m.boxes.values()) box.visible = show
}

function styleBox(box) {
  box.material.transparent = true
  box.material.opacity = 0.7
  box.material.depthTest = false
  excludeFromOutline(box)
}

function ensureSelectionBox(mesh) {
  let box = m.boxes.get(mesh)
  if (mesh.isSkinnedMesh) {
    m.scene.updateMatrixWorld(true)
    const { geometry } = refreshPosedProxy(mesh)
    const bounds = geometry.boundingBox.clone().applyMatrix4(mesh.matrix)
    if (box instanceof THREE.Box3Helper) {
      box.box.copy(bounds)
      return
    }
    if (box) removeSelectionBox(mesh)
    box = new THREE.Box3Helper(bounds, HIGHLIGHT_COLOR)
    styleBox(box)
    const rest = m.rest.get(mesh)
    ;(rest ? rest.pivot : m.scene).add(box)
    m.boxes.set(mesh, box)
    return
  }
  if (box instanceof THREE.BoxHelper) {
    box.setFromObject(mesh)
    return
  }
  if (box) removeSelectionBox(mesh)
  box = new THREE.BoxHelper(mesh, HIGHLIGHT_COLOR)
  styleBox(box)
  m.scene.add(box)
  m.boxes.set(mesh, box)
}

function removeSelectionBox(mesh) {
  const box = m.boxes.get(mesh)
  if (!box) return
  if (box.parent) box.parent.remove(box)
  box.geometry.dispose()
  box.material.dispose()
  m.boxes.delete(mesh)
}

function removeAllSelectionBoxes() {
  for (const mesh of [...m.boxes.keys()]) removeSelectionBox(mesh)
}

// ---------------------------------------------------------------------------
// Posed-skin support
//
// THREE.Mesh's built-in raycast (inherited by SkinnedMesh) tests against the
// geometry's REST-pose vertex positions — it has no idea about the skeleton.
// It only ever produced correct hits because it also applies the mesh node's
// own matrixWorld, and an unposed character's meshes just happen to sit where
// they visually render. The moment a bone bends (Pose mode), the actual
// on-screen shape is entirely a GPU/CPU skinning effect that the mesh node's
// own transform knows nothing about, so clicking the (now-bent) arm raycasts
// against where the STRAIGHT arm used to be and misses — Mesh mode's
// click-to-select (and the selection highlight box) silently broke for any
// posed character.
//
// Fix: for SkinnedMesh parts, don't raycast the mesh itself. Build a small
// proxy Mesh that shares the same triangle indices but whose position
// attribute is recomputed on demand from THREE's own applyBoneTransform() —
// i.e. the same per-vertex skin math the GPU uses — so it matches whatever
// pose is currently on screen. Recomputed only at the moment of a click (or a
// selection change), never per-frame, since posing is disabled while in Mesh
// mode anyway.
//
// Bounding-sphere pre-filter: a click only ever needs the exact per-vertex
// pass for the (usually one) part actually near the ray. Before paying for
// refreshPosedProxy() on a given skinned mesh, do a cheap ray/sphere test
// against a bounding sphere built from a small SAMPLE of that mesh's verts
// run through the same applyBoneTransform() the full pass uses.
//
// The pad below only needs to cover what a coarse sample might miss between
// sample points (e.g. a fingertip that falls between sampled indices), not
// whole-limb-scale pose changes — those are already captured because the
// samples themselves are posed. Worst case of the pad being too tight is a
// missed click on a thin extremity, never a wrong hit, so this stays a pure
// perf optimisation rather than a correctness-sensitive one.
// ---------------------------------------------------------------------------
const _skinTarget = new THREE.Vector3()
const _worldScale = new THREE.Vector3()
const _sphereHit = new THREE.Vector3()
const _pickSphere = new THREE.Sphere()
const _pickCenter = new THREE.Vector3()
const SAMPLE_COUNT = 48 // upper bound on verts sampled per mesh per click
const POSE_PICK_SPHERE_PAD = 1.6 // slack to cover gaps between sample points

// Cheap reject test: does the current raycaster ray even pass near a coarse,
// correctly-posed approximation of this mesh? No full per-vertex work.
function rayMightHitMesh(mesh) {
  const srcPos = mesh.geometry.attributes.position
  const count = srcPos.count
  const step = Math.max(1, Math.floor(count / SAMPLE_COUNT))

  _pickCenter.set(0, 0, 0)
  let n = 0
  for (let i = 0; i < count; i += step) {
    _skinTarget.fromBufferAttribute(srcPos, i)
    mesh.applyBoneTransform(i, _skinTarget)
    _pickCenter.add(_skinTarget)
    n += 1
  }
  _pickCenter.multiplyScalar(1 / n)

  let maxDistSq = 0
  for (let i = 0; i < count; i += step) {
    _skinTarget.fromBufferAttribute(srcPos, i)
    mesh.applyBoneTransform(i, _skinTarget)
    const d = _skinTarget.distanceToSquared(_pickCenter)
    if (d > maxDistSq) maxDistSq = d
  }

  mesh.updateMatrixWorld()
  mesh.getWorldScale(_worldScale)
  const worldMaxScale = Math.max(_worldScale.x, _worldScale.y, _worldScale.z)
  _pickSphere.center.copy(_pickCenter).applyMatrix4(mesh.matrixWorld)
  _pickSphere.radius = Math.sqrt(maxDistSq) * POSE_PICK_SPHERE_PAD * worldMaxScale
  return m.raycaster.ray.intersectSphere(_pickSphere, _sphereHit) !== null
}

// Returns { proxy, geometry } for a skinned mesh, creating it on first use.
// `geometry`'s position attribute holds MESH-LOCAL (pre-matrixWorld) posed
// vertex positions — the same space applyBoneTransform() returns.
function getPosedProxyEntry(mesh) {
  let entry = m.posedProxies.get(mesh)
  if (entry) return entry
  const srcPos = mesh.geometry.attributes.position
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(srcPos.count * 3), 3))
  if (mesh.geometry.index) geometry.setIndex(mesh.geometry.index)
  const proxy = new THREE.Mesh(geometry)
  proxy.matrixAutoUpdate = false
  entry = { proxy, geometry }
  m.posedProxies.set(mesh, entry)
  return entry
}

// Recomputes a skinned mesh's proxy geometry to match its CURRENT pose and
// returns the entry. Cheap enough to call once per click/selection, not
// meant to run every frame.
function refreshPosedProxy(mesh) {
  const entry = getPosedProxyEntry(mesh)
  const srcPos = mesh.geometry.attributes.position
  const outPos = entry.geometry.attributes.position
  for (let i = 0; i < outPos.count; i += 1) {
    // applyBoneTransform reads its target vector as the vertex's REST
    // position on input, then overwrites it with the skinned result.
    _skinTarget.fromBufferAttribute(srcPos, i)
    mesh.applyBoneTransform(i, _skinTarget)
    outPos.setXYZ(i, _skinTarget.x, _skinTarget.y, _skinTarget.z)
  }
  outPos.needsUpdate = true
  entry.geometry.computeBoundingSphere()
  entry.geometry.computeBoundingBox()
  return entry
}

function disposePosedProxies() {
  for (const { geometry } of m.posedProxies.values()) geometry.dispose()
  m.posedProxies.clear()
}

// A character's meshes are only ever registered here while that character is
// active, so `mesh.visible` alone was enough to skip a hidden PART. Props are
// all registered at once regardless of which is "active", though, so a click
// must also skip every part of a prop that's hidden as a WHOLE (root.visible
// false, e.g. the eye icon in the Objects panel) — mesh.visible on its own
// doesn't see that, since visibility doesn't cascade through intersectObjects.
function isMeshEffectivelyVisible(mesh) {
  let node = mesh
  while (node && node !== m.scene) {
    if (!node.visible) return false
    node = node.parent
  }
  return true
}

// Is this pointer event a Shift/Ctrl/Cmd press (additive pick / box-select)?
function isAdditive(e) {
  return !!(e.shiftKey || e.ctrlKey || e.metaKey)
}

function hasPickableMeshes() {
  return !!(m.meshes.length || m.objectMeshes.length)
}

function onPointerDown(e) {
  m.pointerDown = { x: e.clientX, y: e.clientY, axis: m.transform ? m.transform.axis : null }
  m.gizmoMovedDuringDrag = false

  // Shift/Ctrl/Cmd held (and not grabbing the gizmo) arms a possible
  // box-select — same arming rule as bone mode in posing.js. It only becomes
  // one in onPointerUp if the drag actually travels past DRAG_SLOP_PX (the
  // SAME threshold the click-vs-drag check uses, so a shaky click can't read
  // as a tiny box one way and a plain click the other); a modifier-click that
  // barely moves falls through to the normal additive single pick. Shift is
  // included because on macOS Ctrl+click/drag is the system's secondary-click
  // gesture and isn't reliably delivered as a left-button drag everywhere.
  if (
    e.button === 0 &&
    isAdditive(e) &&
    m.enabled &&
    !m.suspended &&
    hasPickableMeshes() &&
    (!m.transform || m.transform.axis === null)
  ) {
    m.marquee = { x0: e.clientX, y0: e.clientY }
    if (m.controls) m.controls.enabled = false // no orbit/pan while dragging the box
  }
}

// Drives the box-select rectangle while a marquee drag is in progress.
function onPointerMove(e) {
  if (!m.marquee || !m.renderer) return
  const container = m.renderer.domElement.parentElement
  if (!container) return
  const rect = container.getBoundingClientRect()
  showMarquee(container, m.marquee.x0 - rect.left, m.marquee.y0 - rect.top, e.clientX - rect.left, e.clientY - rect.top)
}

function onPointerUp(e) {
  const down = m.pointerDown
  m.pointerDown = null

  if (m.marquee) {
    const { x0, y0 } = m.marquee
    m.marquee = null
    hideMarquee()
    if (m.controls) m.controls.enabled = !m.controls.locked
    if (Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) > DRAG_SLOP_PX) {
      // A real box-select drag — resolve it and skip the single-pick logic.
      const rect = m.renderer.domElement.getBoundingClientRect()
      const uuids = pickMeshUuidsInRect(x0 - rect.left, y0 - rect.top, e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height)
      if (m.onSelectMany) m.onSelectMany(uuids, e.shiftKey)
      return
    }
    // Too small to count as a drag — fall through as a plain (additive) click.
  }

  if (m.suspended) return
  if (!m.enabled || !down || e.button !== 0 || !hasPickableMeshes()) return
  // See the matching comment in posing.js: the gizmo's invisible pick padding
  // is bigger than what's drawn, so only treat this as "gizmo, not a pick"
  // once it actually moved something — a press-and-release on the padding
  // with no resulting move falls through to the normal mesh pick below.
  if (down.axis !== null && m.gizmoMovedDuringDrag) return
  if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > DRAG_SLOP_PX) return

  const hit = pickMeshAt(e.clientX, e.clientY)
  const additive = isAdditive(e)
  // An additive click on empty space must not wipe the selection you've been
  // building — only a plain click on nothing deselects.
  if (!hit && additive) return
  m.onSelect(hit ? hit.uuid : null, additive)
}

// Raycast the pointer position against every pickable part (character AND
// props, posed skins via their proxies — see the posed-skin block above).
function pickMeshAt(clientX, clientY) {
  const rect = m.renderer.domElement.getBoundingClientRect()
  _ndc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  )
  m.raycaster.setFromCamera(_ndc, m.camera)

  // Make sure bone/ancestor matrices are current before trusting them below —
  // rendering may be on-demand, so a click right after a pose change could
  // otherwise read stale matrixWorld data.
  m.scene.updateMatrixWorld(true)

  const proxyToMesh = new Map()
  const targets = []
  // Character parts AND every loaded prop's parts are all pickable at once in
  // Mesh mode — a prop has no separate "active" concept the way characters
  // do, so all of them are always live targets here.
  for (const mesh of m.meshes.concat(m.objectMeshes)) {
    if (!isMeshEffectivelyVisible(mesh)) continue
    if (mesh.isSkinnedMesh) {
      // Cheap sphere reject first — skip the per-vertex pose recompute
      // entirely for parts the ray couldn't plausibly touch. This is what
      // keeps a click affordable even with many parts or one very-high-poly
      // mesh (see comment above rayMightHitMesh).
      if (!rayMightHitMesh(mesh)) continue
      const { proxy } = refreshPosedProxy(mesh)
      proxy.matrixWorld.copy(mesh.matrixWorld)
      proxyToMesh.set(proxy, mesh)
      targets.push(proxy)
    } else {
      targets.push(mesh)
    }
  }
  const hits = m.raycaster.intersectObjects(targets, false)
  return hits.length ? proxyToMesh.get(hits[0].object) || hits[0].object : null
}

// Box-select: every visible part whose (posed) bounding-box CENTRE projects
// inside the screen-space rectangle — the same "one representative point per
// thing" rule bone dots (posing.js) and props (objects.js) use. A centre test
// rather than "touches the rectangle" is deliberate: boxing the eyes and
// eyebrows shouldn't also grab the big face/body mesh they happen to sit on.
// Coordinates are in the canvas's own pixel space (rectW/rectH = its size).
const _boxC = new THREE.Vector3()
const _boxBounds = new THREE.Box3()
const BOX_SELECT_SAMPLES = 400 // posed-vertex samples per skinned part (bounds only need to be close)

function posedWorldCentre(mesh, out) {
  mesh.updateMatrixWorld()
  const pos = mesh.geometry.attributes.position
  if (mesh.isSkinnedMesh) {
    const step = Math.max(1, Math.floor(pos.count / BOX_SELECT_SAMPLES))
    _boxBounds.makeEmpty()
    for (let i = 0; i < pos.count; i += step) {
      _skinTarget.fromBufferAttribute(pos, i)
      mesh.applyBoneTransform(i, _skinTarget)
      _boxBounds.expandByPoint(_skinTarget)
    }
    _boxBounds.getCenter(out)
  } else {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    mesh.geometry.boundingBox.getCenter(out)
  }
  return out.applyMatrix4(mesh.matrixWorld)
}

export function pickMeshUuidsInRect(x0, y0, x1, y1, rectW, rectH) {
  if (!m.camera) return []
  m.scene.updateMatrixWorld(true)
  const uuids = []
  for (const mesh of m.meshes.concat(m.objectMeshes)) {
    if (!isMeshEffectivelyVisible(mesh)) continue
    posedWorldCentre(mesh, _boxC).project(m.camera)
    if (_boxC.z > 1) continue // behind the camera
    const sx = (_boxC.x * 0.5 + 0.5) * rectW
    const sy = (-_boxC.y * 0.5 + 0.5) * rectH
    if (pointInRect(sx, sy, x0, y0, x1, y1)) uuids.push(mesh.uuid)
  }
  return uuids
}

function excludeFromOutline(obj3d) {
  obj3d.traverse((obj) => {
    if (!obj.material) return
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of mats) mat.userData.outlineParameters = { visible: false }
  })
}

function unwrapMeshForEdit(mesh) {
  const pivot = mesh.parent
  if (!pivot || !pivot.userData.meshEditPivot) return

  const parent = pivot.parent
  if (!parent) return

  pivot.updateMatrix()
  mesh.updateMatrix()
  const localMatrix = pivot.matrix.clone().multiply(mesh.matrix)
  parent.add(mesh)
  localMatrix.decompose(mesh.position, mesh.quaternion, mesh.scale)
  mesh.updateMatrix()
  parent.remove(pivot)
}