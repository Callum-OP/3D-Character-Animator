import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'

// ---------------------------------------------------------------------------
// Mesh editing (Mesh mode)
//
// Lets the user select an individual part of the character (eyes, hair, a hat…)
// and move / rotate / scale it with a TransformControls gizmo. Parts are picked
// by raycasting the character's meshes directly, so you click the thing you see.
//
// Skinned parts need special handling: a SkinnedMesh's vertices are driven
// entirely by the skeleton, and in three.js the mesh node's own transform is
// cancelled out (attached bind mode recomputes bindMatrixInverse from the
// node's matrixWorld every frame). Setting position/rotation/scale on such a
// node is invisible. So while the gizmo still drags the node, we bake the
// node's offset-from-rest into the mesh's bindMatrix — the vertices shift in
// bind space BEFORE skinning, which means the part moves where you dragged it
// and still follows the skeleton (an offset eye keeps tracking the head).
//
// The gizmo does NOT attach to the mesh node directly. Exporters routinely bake
// a part's geometry in world space and leave its node at the origin, so the
// node pivot sits at the character's feet — rotating or resizing "the hair"
// around that would swing it across the scene. Instead the gizmo drives an
// invisible PROXY parked at the part's bounding-box centre (with the mesh's
// rest orientation), and every proxy movement is mapped back onto the mesh
// node as a delta around that pivot. Parts therefore rotate and resize about
// themselves, like in full animation packages.
//
// Edits are stored on the mesh nodes themselves and captured relative to the
// rest transform recorded at load, so reset and save/load are exact.
// ---------------------------------------------------------------------------

const UNDO_LIMIT = 100
const DRAG_SLOP_PX = 4 // pointer travel above this is an orbit-drag, not a click
const HIGHLIGHT_COLOR = 0xffc24a // matches the selected bone-dot tint

// Module state (mirrors the scene-manager singleton style used elsewhere).
const m = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  requestRender: null,
  onSelect: null, // (meshUuid|null) => void — reports picks up to the store
  onChange: null, // () => void — any transform edit; the panel re-reads values

  transform: null, // TransformControls (move/rotate/scale)
  helper: null,

  model: null,
  meshes: [], // the character's Mesh/SkinnedMesh nodes
  meshByUuid: new Map(),
  rest: new Map(), // Mesh -> rest transform captured at load (see setMeshEditModel)

  selected: null, // selected Mesh (or null)
  proxy: null, // invisible pivot Object3D the gizmo actually drives
  box: null, // THREE.BoxHelper highlight around the selection
  enabled: false, // true only while the app is in Mesh mode
  suspended: false, // true while animation playback drives the parts
  undoStack: [],
  redoStack: [],
  dragBefore: null, // selected mesh's TRS at gizmo-drag start
  pointerDown: null, // { x, y, axis } for click-vs-drag discrimination
  raycaster: new THREE.Raycaster(),
}

const _ndc = new THREE.Vector2()
const _delta = new THREE.Matrix4()
const _m1 = new THREE.Matrix4()
const _m2 = new THREE.Matrix4()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scl = new THREE.Vector3()

export function initMeshEdit(refs) {
  m.scene = refs.scene
  m.camera = refs.camera
  m.renderer = refs.renderer
  m.controls = refs.controls
  m.requestRender = refs.requestRender
  m.onSelect = refs.onSelect
  m.onChange = refs.onChange || null

  const transform = new TransformControls(m.camera, m.renderer.domElement)
  transform.setMode('translate')
  transform.setSize(0.9)
  transform.addEventListener('dragging-changed', (e) => {
    // Don't orbit while dragging; stay locked if a camera view has orbit off.
    m.controls.enabled = !e.value && !m.controls.locked
  })
  transform.addEventListener('objectChange', () => {
    if (m.selected) applyProxyToMesh(m.selected)
    notifyChange()
    m.requestRender()
  })
  transform.addEventListener('mouseDown', () => {
    if (m.selected) m.dragBefore = snapshot(m.selected)
  })
  transform.addEventListener('mouseUp', () => {
    commitDragUndo()
    m.requestRender()
  })
  m.transform = transform

  const helper = transform.getHelper()
  excludeFromOutline(helper)
  m.scene.add(helper)
  m.helper = helper

  const dom = m.renderer.domElement
  m._onPointerDown = onPointerDown
  m._onPointerUp = onPointerUp
  dom.addEventListener('pointerdown', m._onPointerDown)
  dom.addEventListener('pointerup', m._onPointerUp)
}

// Bind mesh editing to a freshly loaded model: record every part's rest
// transform (and, for skinned parts, the rest bind matrix the offsets bake into).
export function setMeshEditModel(model) {
  clearMeshEditModel()
  m.model = model
  m.meshes = model.meshes || []
  for (const mesh of m.meshes) {
    m.meshByUuid.set(mesh.uuid, mesh)
    mesh.updateMatrix()
    // The edit pivot: the geometry's bounding-box centre carried into the
    // mesh's parent space, with the mesh's rest orientation (so the gizmo's
    // local axes line up with the part).
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const pivot = mesh.geometry.boundingBox.getCenter(new THREE.Vector3())
    pivot.applyMatrix4(mesh.matrix)
    const pivotMatrix = new THREE.Matrix4().compose(
      pivot,
      mesh.quaternion,
      new THREE.Vector3(1, 1, 1),
    )
    m.rest.set(mesh, {
      position: mesh.position.clone(),
      quaternion: mesh.quaternion.clone(),
      scale: mesh.scale.clone(),
      matrix: mesh.matrix.clone(),
      matrixInverse: mesh.matrix.clone().invert(),
      pivotMatrix,
      pivotMatrixInverse: pivotMatrix.clone().invert(),
      bindMatrix: mesh.isSkinnedMesh ? mesh.bindMatrix.clone() : null,
    })
  }
}

// Detach the gizmo and drop all references (called on model unload).
export function clearMeshEditModel() {
  if (m.transform) m.transform.detach()
  m.selected = null
  m.dragBefore = null
  m.suspended = false
  m.undoStack = []
  m.redoStack = []
  if (m.proxy) {
    if (m.proxy.parent) m.proxy.parent.remove(m.proxy)
    m.proxy = null
  }
  if (m.box) {
    m.scene.remove(m.box)
    m.box.geometry.dispose()
    m.box.material.dispose()
    m.box = null
  }
  m.model = null
  m.meshes = []
  m.meshByUuid = new Map()
  m.rest = new Map()
}

// Enable/disable the whole interaction (Mesh mode on/off). The selection is
// remembered across mode switches; only the gizmo, picking and highlight gate.
export function setMeshEditEnabled(enabled) {
  m.enabled = enabled
  if (m.transform) {
    if (enabled && m.selected && !m.suspended) attachToSelected()
    else m.transform.detach()
  }
  updateSelectionBox()
  m.requestRender()
}

// Select a mesh by uuid (or null to deselect). Idempotent: safe to call from
// both the panel and the viewport pick path.
export function selectMesh(uuid) {
  const mesh = uuid ? m.meshByUuid.get(uuid) || null : null
  m.selected = mesh
  if (m.transform) {
    if (mesh && m.enabled && !m.suspended) attachToSelected()
    else m.transform.detach()
  }
  updateSelectionBox()
  m.requestRender()
}

// Suspend interactive editing while animation playback drives the parts:
// detach the gizmo and ignore picks. resume() re-attaches the selection.
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

// Park the pivot proxy on the selected part and hang the gizmo off it.
function attachToSelected() {
  const mesh = m.selected
  if (!m.proxy) m.proxy = new THREE.Object3D()
  if (m.proxy.parent !== mesh.parent) mesh.parent.add(m.proxy)
  syncProxyFromMesh(mesh)
  m.transform.attach(m.proxy)
}

// Place the proxy where the mesh's current edit puts the pivot:
// proxyLocal = (local · restLocal⁻¹) · pivotRest.
function syncProxyFromMesh(mesh) {
  if (!m.proxy || m.selected !== mesh) return
  const rest = m.rest.get(mesh)
  mesh.updateMatrix()
  _m1.multiplyMatrices(mesh.matrix, rest.matrixInverse)
  _m2.multiplyMatrices(_m1, rest.pivotMatrix)
  _m2.decompose(m.proxy.position, m.proxy.quaternion, m.proxy.scale)
  m.proxy.updateMatrix()
}

// Map a gizmo edit on the proxy back onto the mesh node:
// local = (proxyLocal · pivotRest⁻¹) · restLocal — the proxy's departure from
// its rest becomes the mesh's delta, applied around the pivot.
function applyProxyToMesh(mesh) {
  const rest = m.rest.get(mesh)
  m.proxy.updateMatrix()
  _m1.multiplyMatrices(m.proxy.matrix, rest.pivotMatrixInverse)
  _m2.multiplyMatrices(_m1, rest.matrix)
  _m2.decompose(mesh.position, mesh.quaternion, mesh.scale)
  applyEdit(mesh)
}

export function setMeshGizmoMode(mode) {
  if (!m.transform) return
  m.transform.setMode(mode) // 'translate' | 'rotate' | 'scale'
  m.requestRender()
}

// Keep the highlight box hugging its mesh (called each render, like the bone dots).
export function updateMeshEditHelpers() {
  if (m.box && m.box.visible) m.box.update()
}

// A part's current transform RELATIVE TO ITS REST, in friendly units:
// offset in model units, rotation in degrees, scale as a multiplier — so
// (0,0,0) / (0,0,0) / (1,1,1) always means "untouched". Expressed in the
// pivot frame, matching what dragging the gizmo does.
export function getMeshDelta(uuid) {
  const mesh = m.meshByUuid.get(uuid)
  const rest = mesh && m.rest.get(mesh)
  if (!mesh || !rest) return null
  // Dl = pivotRest⁻¹ · (local · restLocal⁻¹) · pivotRest
  mesh.updateMatrix()
  _m1.multiplyMatrices(mesh.matrix, rest.matrixInverse)
  _m2.multiplyMatrices(rest.pivotMatrixInverse, _m1).multiply(rest.pivotMatrix)
  _m2.decompose(_pos, _quat, _scl)
  const e = new THREE.Euler().setFromQuaternion(_quat, 'XYZ')
  return {
    offset: [_pos.x, _pos.y, _pos.z],
    rotation: [
      THREE.MathUtils.radToDeg(e.x),
      THREE.MathUtils.radToDeg(e.y),
      THREE.MathUtils.radToDeg(e.z),
    ],
    scale: [_scl.x, _scl.y, _scl.z],
  }
}

// Set a part's transform from rest-relative values (the panel's typed fields).
// Pass any subset of { offset, rotation, scale }; each is a full [x,y,z].
export function setMeshDelta(uuid, delta) {
  const mesh = m.meshByUuid.get(uuid)
  const rest = mesh && m.rest.get(mesh)
  if (!mesh || !rest) return
  const before = snapshot(mesh)
  const cur = { ...getMeshDelta(uuid), ...delta }
  // local = pivotRest · Dl · pivotRest⁻¹ · restLocal
  _m1.compose(
    _pos.set(cur.offset[0], cur.offset[1], cur.offset[2]),
    _quat.setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(cur.rotation[0]),
        THREE.MathUtils.degToRad(cur.rotation[1]),
        THREE.MathUtils.degToRad(cur.rotation[2]),
        'XYZ',
      ),
    ),
    _scl.set(cur.scale[0], cur.scale[1], cur.scale[2]),
  )
  _m2.multiplyMatrices(rest.pivotMatrix, _m1)
    .multiply(rest.pivotMatrixInverse)
    .multiply(rest.matrix)
  _m2.decompose(mesh.position, mesh.quaternion, mesh.scale)
  applyEdit(mesh)
  syncProxyFromMesh(mesh)
  pushUndoIfChanged(mesh, before)
  notifyChange()
  m.requestRender()
}

// Restore one part to its rest transform (undoable).
export function resetMesh(uuid) {
  const mesh = m.meshByUuid.get(uuid)
  const rest = mesh && m.rest.get(mesh)
  if (!mesh || !rest) return
  const before = snapshot(mesh)
  mesh.position.copy(rest.position)
  mesh.quaternion.copy(rest.quaternion)
  mesh.scale.copy(rest.scale)
  applyEdit(mesh)
  syncProxyFromMesh(mesh)
  pushUndoIfChanged(mesh, before)
  notifyChange()
  m.requestRender()
}

// Restore every part as one undoable batch.
export function resetAllMeshes() {
  const batch = []
  for (const mesh of m.meshes) {
    const rest = m.rest.get(mesh)
    if (!rest || isAtRest(mesh, rest)) continue
    batch.push({ mesh, before: snapshot(mesh), after: restSnapshot(rest) })
    mesh.position.copy(rest.position)
    mesh.quaternion.copy(rest.quaternion)
    mesh.scale.copy(rest.scale)
    applyEdit(mesh)
    syncProxyFromMesh(mesh)
  }
  if (batch.length) pushUndo(batch)
  notifyChange()
  m.requestRender()
}

// True if any part has been moved away from its rest transform.
export function hasMeshEdits() {
  for (const mesh of m.meshes) {
    const rest = m.rest.get(mesh)
    if (rest && !isAtRest(mesh, rest)) return true
  }
  return false
}

export function undo() {
  const batch = m.undoStack.pop()
  if (!batch) return
  for (const { mesh, before } of batch) applySnapshot(mesh, before)
  m.redoStack.push(batch)
  notifyChange()
  m.requestRender()
}

export function redo() {
  const batch = m.redoStack.pop()
  if (!batch) return
  for (const { mesh, after } of batch) applySnapshot(mesh, after)
  m.undoStack.push(batch)
  notifyChange()
  m.requestRender()
}

// --- Keyframing / playback -----------------------------------------------------

// The selected part's current local transform, in keyframe form.
export function getMeshKeyValue(uuid) {
  const mesh = m.meshByUuid.get(uuid)
  if (!mesh) return null
  return {
    pos: mesh.position.toArray(),
    quat: mesh.quaternion.toArray(),
    scale: mesh.scale.toArray(),
  }
}

// Snapshot every part's placement before playback drives them, so Stop puts
// the user's static edits back.
export function getMeshPlaybackSnapshot() {
  return m.meshes.map((mesh) => ({ mesh, ...snapshot(mesh) }))
}

export function applyMeshPlaybackSnapshot(snap) {
  if (!snap) return
  for (const s of snap) applySnapshot(s.mesh, s)
}

// Drive the parts from keyframe tracks at time t (called from the animation
// engine each frame). tracks: { [meshIndex]: [{time,pos,quat,scale}] }, each
// sorted by time. Re-bakes the skinned bind matrices so driven skinned parts
// actually move.
export function sampleMeshTracks(tracks, t) {
  if (!tracks) return
  for (const [index, keys] of Object.entries(tracks)) {
    const mesh = m.meshes[Number(index)]
    if (!mesh || !keys || keys.length === 0) continue
    sampleMeshKeys(keys, t, mesh)
    applyEdit(mesh)
  }
}

const _kq0 = new THREE.Quaternion()
const _kq1 = new THREE.Quaternion()

function sampleMeshKeys(keys, t, mesh) {
  if (t <= keys[0].time) return applyMeshKey(mesh, keys[0])
  const last = keys[keys.length - 1]
  if (t >= last.time) return applyMeshKey(mesh, last)
  let i = 0
  while (i < keys.length - 1 && keys[i + 1].time < t) i++
  const k0 = keys[i]
  const k1 = keys[i + 1]
  const span = k1.time - k0.time
  const f = span > 0 ? (t - k0.time) / span : 0
  const lerp3 = (out, v0, v1) =>
    out.set(v0[0] + (v1[0] - v0[0]) * f, v0[1] + (v1[1] - v0[1]) * f, v0[2] + (v1[2] - v0[2]) * f)
  lerp3(mesh.position, k0.pos, k1.pos)
  lerp3(mesh.scale, k0.scale, k1.scale)
  _kq0.fromArray(k0.quat)
  _kq1.fromArray(k1.quat)
  mesh.quaternion.slerpQuaternions(_kq0, _kq1, f)
}

function applyMeshKey(mesh, k) {
  mesh.position.fromArray(k.pos)
  mesh.quaternion.fromArray(k.quat)
  mesh.scale.fromArray(k.scale)
}

// --- Save / load --------------------------------------------------------------

// Edited parts as { index, position, quaternion, scale } (absolute local TRS).
// Keyed by mesh INDEX, not uuid — uuids regenerate on every reload of the same
// file, index order is stable (same remap the mesh-override save uses).
export function getMeshEditsData() {
  const out = []
  m.meshes.forEach((mesh, index) => {
    const rest = m.rest.get(mesh)
    if (!rest || isAtRest(mesh, rest)) return
    out.push({
      index,
      position: mesh.position.toArray(),
      quaternion: mesh.quaternion.toArray(),
      scale: mesh.scale.toArray(),
    })
  })
  return out
}

// Apply saved part transforms to the currently loaded model (not undoable —
// it's a restore, and the load path clears the stacks anyway).
export function applyMeshEditsData(list) {
  if (!Array.isArray(list)) return
  for (const item of list) {
    const mesh = m.meshes[item.index]
    if (!mesh) continue
    if (item.position) mesh.position.fromArray(item.position)
    if (item.quaternion) mesh.quaternion.fromArray(item.quaternion)
    if (item.scale) mesh.scale.fromArray(item.scale)
    applyEdit(mesh)
    syncProxyFromMesh(mesh)
  }
  notifyChange()
  m.requestRender()
}

// Swap the camera the picking raycaster and gizmo work against (used when the
// viewport looks through a placed camera).
export function setViewCamera(camera) {
  m.camera = camera
  if (m.transform) m.transform.camera = camera
}

export function disposeMeshEdit() {
  const dom = m.renderer && m.renderer.domElement
  if (dom) {
    dom.removeEventListener('pointerdown', m._onPointerDown)
    dom.removeEventListener('pointerup', m._onPointerUp)
  }
  clearMeshEditModel()
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

// --- internals ---------------------------------------------------------------

// Make a node-transform edit actually show up. For plain meshes the node
// transform IS the edit; for skinned meshes bake the offset-from-rest into the
// bind matrix (see the header comment): bind' = bindRest * (restLocal⁻¹ · local).
function applyEdit(mesh) {
  mesh.updateMatrix()
  const rest = m.rest.get(mesh)
  if (!rest || !rest.bindMatrix) return
  _delta.multiplyMatrices(rest.matrixInverse, mesh.matrix)
  mesh.bindMatrix.multiplyMatrices(rest.bindMatrix, _delta)
}

function snapshot(mesh) {
  return {
    position: mesh.position.clone(),
    quaternion: mesh.quaternion.clone(),
    scale: mesh.scale.clone(),
  }
}

function restSnapshot(rest) {
  return {
    position: rest.position.clone(),
    quaternion: rest.quaternion.clone(),
    scale: rest.scale.clone(),
  }
}

function applySnapshot(mesh, snap) {
  mesh.position.copy(snap.position)
  mesh.quaternion.copy(snap.quaternion)
  mesh.scale.copy(snap.scale)
  applyEdit(mesh)
  syncProxyFromMesh(mesh)
}

function isAtRest(mesh, rest) {
  return (
    mesh.position.equals(rest.position) &&
    mesh.quaternion.equals(rest.quaternion) &&
    mesh.scale.equals(rest.scale)
  )
}

function sameSnapshot(a, b) {
  return (
    a.position.equals(b.position) &&
    a.quaternion.equals(b.quaternion) &&
    a.scale.equals(b.scale)
  )
}

function pushUndo(batch) {
  m.undoStack.push(batch)
  m.redoStack = [] // a fresh edit invalidates the redo history
  if (m.undoStack.length > UNDO_LIMIT) m.undoStack.shift()
}

function pushUndoIfChanged(mesh, before) {
  const after = snapshot(mesh)
  if (!sameSnapshot(before, after)) pushUndo([{ mesh, before, after }])
}

function commitDragUndo() {
  if (!m.selected || !m.dragBefore) return
  pushUndoIfChanged(m.selected, m.dragBefore)
  m.dragBefore = null
}

function notifyChange() {
  if (m.onChange) m.onChange()
}

function updateSelectionBox() {
  const show = m.enabled && !!m.selected
  if (show) {
    if (!m.box) {
      m.box = new THREE.BoxHelper(m.selected, HIGHLIGHT_COLOR)
      m.box.material.transparent = true
      m.box.material.opacity = 0.7
      m.box.material.depthTest = false
      excludeFromOutline(m.box)
      m.scene.add(m.box)
    } else {
      m.box.setFromObject(m.selected)
    }
  }
  if (m.box) m.box.visible = show
}

function onPointerDown(e) {
  // Record where the press started and whether it landed on a gizmo axis, so
  // pointerup can tell a mesh-pick from a gizmo-drag or an orbit-drag.
  m.pointerDown = { x: e.clientX, y: e.clientY, axis: m.transform ? m.transform.axis : null }
}

function onPointerUp(e) {
  const down = m.pointerDown
  m.pointerDown = null
  if (m.suspended) return // no picking while animation plays
  if (!m.enabled || !down || e.button !== 0 || m.meshes.length === 0) return
  if (down.axis !== null) return // was dragging the gizmo
  if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > DRAG_SLOP_PX) return

  const rect = m.renderer.domElement.getBoundingClientRect()
  _ndc.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  )
  m.raycaster.setFromCamera(_ndc, m.camera)
  // Raycast the visible parts only; SkinnedMesh raycasting follows the current
  // pose, so you pick the part where it's drawn. Nearest hit wins.
  const hits = m.raycaster.intersectObjects(
    m.meshes.filter((mesh) => mesh.visible),
    false,
  )
  m.onSelect(hits.length ? hits[0].object.uuid : null) // null on empty-space click
}

// Stamp every material in a subtree so the OutlineEffect skips it.
function excludeFromOutline(obj3d) {
  obj3d.traverse((obj) => {
    if (!obj.material) return
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of mats) mat.userData.outlineParameters = { visible: false }
  })
}
