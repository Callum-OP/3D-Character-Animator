import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'

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
  requestRender: () => {},
  onSelect: null, // (meshUuid|null) => void — reports picks up to the store
  onChange: null, // () => void — any transform edit; the panel re-reads values

  transform: null, // TransformControls (move/rotate/scale)
  helper: null,

  model: null,
  meshes: [], // the character's Mesh/SkinnedMesh nodes
  meshByUuid: new Map(),
  rest: new Map(), // Mesh -> { pivot, position, quaternion, scale } (see setMeshEditModel)

  selected: null, // selected Mesh (or null)
  box: null, // THREE.BoxHelper highlight around the selection
  enabled: false, // true only while the app is in Mesh mode
  suspended: false, // true while animation playback drives the parts
  undoStack: [],
  redoStack: [],
  dragBefore: null, // selected part's pivot TRS at gizmo-drag start
  pointerDown: null, // { x, y, axis } for click-vs-drag discrimination
  raycaster: new THREE.Raycaster(),
  posedProxies: new Map(), // SkinnedMesh -> { proxy, geometry } — see getPosedLocalPositions()
}

const _ndc = new THREE.Vector2()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()

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
    m.controls.enabled = !e.value && !m.controls.locked
  })
  transform.addEventListener('objectChange', () => {
    notifyChange()
    m.requestRender()
  })
  transform.addEventListener('mouseDown', () => {
    if (m.selected) {
      const rest = m.rest.get(m.selected)
      if (rest) m.dragBefore = snapshot(rest.pivot)
    }
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

// Bind mesh editing to a freshly loaded model: give every part a dedicated
// pivot Group (see header comment) and record its rest transform.
export function setMeshEditModel(model) {
  clearMeshEditModel()
  m.model = model
  m.meshes = model.meshes || []
  for (const mesh of m.meshes) {
    m.meshByUuid.set(mesh.uuid, mesh)
    const parent = mesh.parent
    mesh.updateMatrix()
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
    pivotLocalMatrix.decompose(pivot.position, pivot.quaternion, pivot.scale)
    parent.add(pivot)
    pivot.add(mesh)
    newMeshLocal.decompose(mesh.position, mesh.quaternion, mesh.scale)
    mesh.updateMatrix()

    m.rest.set(mesh, {
      pivot,
      position: pivot.position.clone(),
      quaternion: pivot.quaternion.clone(),
      scale: pivot.scale.clone(),
    })
  }
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

// Also used by clothmod.js so it can find a mesh's pivot group directly.
export function getMeshPivot(mesh) {
  const rest = m.rest.get(mesh)
  return rest ? rest.pivot : null
}

export function clearMeshEditModel() {
  if (m.transform) m.transform.detach()
  m.selected = null
  m.dragBefore = null
  m.suspended = false
  m.undoStack = []
  m.redoStack = []
  removeSelectionBox()
  disposePosedProxies()
  m.model = null
  m.meshes = []
  m.meshByUuid = new Map()
  m.rest = new Map()
}

export function setMeshEditEnabled(enabled) {
  m.enabled = enabled
  if (m.transform) {
    if (enabled && m.selected && !m.suspended) attachToSelected()
    else m.transform.detach()
  }
  updateSelectionBox()
  m.requestRender()
}

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
  if (m.box && m.box.visible && typeof m.box.update === 'function') m.box.update()
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
  for (const { obj, before } of batch) applySnapshot(obj, before)
  m.redoStack.push(batch)
  notifyChange()
  m.requestRender()
}

export function redo() {
  const batch = m.redoStack.pop()
  if (!batch) return
  for (const { obj, after } of batch) applySnapshot(obj, after)
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
  m.undoStack.push(batch)
  m.redoStack = []
  if (m.undoStack.length > UNDO_LIMIT) m.undoStack.shift()
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
function updateSelectionBox() {
  const show = m.enabled && !!m.selected
  if (show) {
    const wantsSkinBox = m.selected.isSkinnedMesh
    const haveSkinBox = m.box instanceof THREE.Box3Helper
    if (wantsSkinBox) {
      m.scene.updateMatrixWorld(true)
      const { geometry } = refreshPosedProxy(m.selected)
      const box = geometry.boundingBox.clone().applyMatrix4(m.selected.matrix)
      if (!haveSkinBox) {
        removeSelectionBox()
        m.box = new THREE.Box3Helper(box, HIGHLIGHT_COLOR)
        m.box.material.transparent = true
        m.box.material.opacity = 0.7
        m.box.material.depthTest = false
        excludeFromOutline(m.box)
        const rest = m.rest.get(m.selected)
        ;(rest ? rest.pivot : m.scene).add(m.box)
      } else {
        m.box.box.copy(box)
      }
    } else {
      if (haveSkinBox) removeSelectionBox()
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
  }
  if (m.box) m.box.visible = show
}

function removeSelectionBox() {
  if (!m.box) return
  if (m.box.parent) m.box.parent.remove(m.box)
  m.box.geometry.dispose()
  m.box.material.dispose()
  m.box = null
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

function onPointerDown(e) {
  m.pointerDown = { x: e.clientX, y: e.clientY, axis: m.transform ? m.transform.axis : null }
}

function onPointerUp(e) {
  const down = m.pointerDown
  m.pointerDown = null
  if (m.suspended) return
  if (!m.enabled || !down || e.button !== 0 || m.meshes.length === 0) return
  if (down.axis !== null) return
  if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > DRAG_SLOP_PX) return

  const rect = m.renderer.domElement.getBoundingClientRect()
  _ndc.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  )
  m.raycaster.setFromCamera(_ndc, m.camera)

  // Make sure bone/ancestor matrices are current before trusting them below —
  // rendering may be on-demand, so a click right after a pose change could
  // otherwise read stale matrixWorld data.
  m.scene.updateMatrixWorld(true)

  const proxyToMesh = new Map()
  const targets = []
  for (const mesh of m.meshes) {
    if (!mesh.visible) continue
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
  const hit = hits.length ? proxyToMesh.get(hits[0].object) || hits[0].object : null
  m.onSelect(hit ? hit.uuid : null)
}

function excludeFromOutline(obj3d) {
  obj3d.traverse((obj) => {
    if (!obj.material) return
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of mats) mat.userData.outlineParameters = { visible: false }
  })
}