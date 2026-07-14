import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { poseToJSON, validatePose } from './poses.js'

// ---------------------------------------------------------------------------
// Bone posing
//
// - A TransformControls gizmo (rotate mode) attaches to the selected bone. FK
//   only: rotating a bone deforms the SkinnedMesh via the skeleton (no IK).
// - Bones have no geometry, so we draw a screen-constant dot per bone (a Points
//   cloud with sizeAttenuation off) and pick the nearest dot to the click in
//   screen space. Dots ignore depth so occluded bones stay pickable.
// - A capped undo stack records rotation edits (gizmo drag, reset, pose load) as
//   batches of { bone, before, after } quaternions. A matching redo stack is
//   cleared whenever a fresh edit lands.
// ---------------------------------------------------------------------------

const UNDO_LIMIT = 100
const SNAP_DEG = 15 // rotation snap increment (checkbox or Shift-hold)
const DOT_SIZE_PX = 9 // bone dot diameter in pixels (screen-constant)
const PICK_THRESHOLD_PX = 12 // click must land within this of a dot to select
const DRAG_SLOP_PX = 4 // pointer travel above this is an orbit-drag, not a click

const BASE_COLOR = new THREE.Color(0x9aa0b4)
const SELECTED_COLOR = new THREE.Color(0xffc24a)

// Module state (mirrors the scene-manager singleton style used elsewhere).
const p = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  requestRender: null,
  onSelect: null, // (boneName|null) => void — reports picks up to the store
  onPoseChange: null, // () => void — any pose edit (drag, undo, reset…); UI resync

  transform: null, // TransformControls
  helper: null, // transform.getHelper() (added to scene)

  model: null,
  bones: [],
  boneMap: new Map(), // name -> Bone
  restQuats: new Map(), // Bone -> THREE.Quaternion (rotation at load)
  pickable: [], // bones shown as dots / clickable (subset of bones)
  pickableNames: null, // Set of names restricting pickable, or null = all

  points: null,
  pointsGeom: null,
  pointsMat: null,

  selected: null, // selected Bone (or null)
  undoStack: [],
  redoStack: [],
  dragBefore: null, // selected bone's quaternion at drag start
  adjustBefore: null, // { bone, quat } captured by beginBoneAdjust (slider drags)
  pointerDown: null, // { x, y, axis } for click-vs-drag discrimination
  suspended: false, // true while animation playback drives the bones
  snapDeg: null, // rotation snap increment in degrees (null = free rotate)
  shiftHeld: false, // Shift temporarily inverts the snap setting
}

const _v = new THREE.Vector3() // scratch, reused every helper update

export function initPosing(refs) {
  p.scene = refs.scene
  p.camera = refs.camera
  p.renderer = refs.renderer
  p.controls = refs.controls
  p.requestRender = refs.requestRender
  p.onSelect = refs.onSelect
  p.onPoseChange = refs.onPoseChange || null

  const transform = new TransformControls(p.camera, p.renderer.domElement)
  transform.setMode('rotate')
  transform.setSpace('local')
  transform.setSize(0.8)
  // Suspend orbit while dragging the gizmo so the two don't fight.
  transform.addEventListener('dragging-changed', (e) => {
    p.controls.enabled = !e.value
  })
  transform.addEventListener('objectChange', () => {
    notifyPoseChange() // keep the rotation sliders in sync while dragging
    p.requestRender()
  })
  transform.addEventListener('mouseDown', () => {
    if (p.selected) p.dragBefore = p.selected.quaternion.clone()
  })
  transform.addEventListener('mouseUp', () => {
    commitDragUndo()
    p.requestRender()
  })
  p.transform = transform

  const helper = transform.getHelper()
  // Keep the outline pass off the gizmo itself.
  helper.traverse((obj) => {
    if (!obj.material) return
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const m of mats) m.userData.outlineParameters = { visible: false }
  })
  p.scene.add(helper)
  p.helper = helper

  // Pointer handlers for bone picking (kept alongside TransformControls' own).
  const dom = p.renderer.domElement
  p._onPointerDown = onPointerDown
  p._onPointerUp = onPointerUp
  dom.addEventListener('pointerdown', p._onPointerDown)
  dom.addEventListener('pointerup', p._onPointerUp)

  // Holding Shift temporarily inverts the angle-snap setting (snap when it's
  // off, free-rotate when it's on) — like precision modifiers in art programs.
  p._onKeyChange = (e) => {
    if (e.key !== 'Shift' || p.shiftHeld === (e.type === 'keydown')) return
    p.shiftHeld = e.type === 'keydown'
    applyRotationSnap()
  }
  window.addEventListener('keydown', p._onKeyChange)
  window.addEventListener('keyup', p._onKeyChange)
}

// Bind the posing system to a freshly loaded model: capture rest rotations and
// build the pickable bone-dot overlay.
export function setPoseModel(model) {
  clearPoseModel()
  p.model = model
  p.bones = model.bones || []
  p.boneMap = new Map()
  p.restQuats = new Map()
  for (const b of p.bones) {
    p.boneMap.set(b.name, b)
    p.restQuats.set(b, b.quaternion.clone())
  }
  if (p.bones.length === 0) return

  // One dot per bone (buffer sized for the full set; drawRange trims it when a
  // helper-bone filter is active). Positions filled every render.
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p.bones.length * 3), 3))
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(p.bones.length * 3), 3))
  const mat = new THREE.PointsMaterial({
    size: DOT_SIZE_PX,
    sizeAttenuation: false, // constant pixel size regardless of zoom
    vertexColors: true,
    depthTest: false, // draw over the mesh so occluded bones stay visible/pickable
    depthWrite: false,
    transparent: true,
  })
  const points = new THREE.Points(geom, mat)
  points.frustumCulled = false
  points.renderOrder = 999 // on top
  points.userData.outlineParameters = { visible: false } // never outline the dots
  p.scene.add(points)
  p.points = points
  p.pointsGeom = geom
  p.pointsMat = mat

  applyPickableFilter()
  updateBoneHelpers()
}

// Restrict the dot overlay and click-picking to the named bones (null = all).
// Used to hide helper bones on dense game rigs — a 684-joint rig is unpickable
// with every dot drawn. Selection by name (panel, poses) still reaches every
// bone; this only trims the dots.
export function setPickableBones(names) {
  p.pickableNames = names ? new Set(names) : null
  applyPickableFilter()
  updateBoneHelpers()
  p.requestRender()
}

function applyPickableFilter() {
  p.pickable = p.pickableNames
    ? p.bones.filter((b) => p.pickableNames.has(b.name))
    : p.bones
  if (p.pointsGeom) p.pointsGeom.setDrawRange(0, p.pickable.length)
}

// Detach the gizmo and tear down the overlay (called on model unload).
export function clearPoseModel() {
  if (p.transform) p.transform.detach()
  p.selected = null
  p.dragBefore = null
  p.adjustBefore = null
  p.suspended = false
  p.undoStack = []
  p.redoStack = []
  if (p.points) {
    p.scene.remove(p.points)
    p.pointsGeom.dispose()
    p.pointsMat.dispose()
    p.points = null
    p.pointsGeom = null
    p.pointsMat = null
  }
  p.model = null
  p.bones = []
  p.boneMap = new Map()
  p.restQuats = new Map()
  p.pickable = []
  p.pickableNames = null
}

// Called each render (before draw) to park each dot on its bone's head and tint
// the selected one. Reads live world matrices, so it tracks bones during a drag.
export function updateBoneHelpers() {
  if (!p.points || !p.model) return
  p.model.root.updateWorldMatrix(true, true) // refresh bone world matrices
  const pos = p.pointsGeom.attributes.position
  const col = p.pointsGeom.attributes.color
  for (let i = 0; i < p.pickable.length; i++) {
    const bone = p.pickable[i]
    bone.getWorldPosition(_v)
    pos.setXYZ(i, _v.x, _v.y, _v.z)
    const c = bone === p.selected ? SELECTED_COLOR : BASE_COLOR
    col.setXYZ(i, c.r, c.g, c.b)
  }
  pos.needsUpdate = true
  col.needsUpdate = true
}

// Select a bone by name (or null to deselect). Idempotent: safe to call from
// both the panel and the viewport pick path. While suspended (animation playing)
// we remember the selection but don't attach the gizmo.
export function selectBone(name) {
  const bone = name ? p.boneMap.get(name) || null : null
  p.selected = bone
  if (!p.suspended) {
    if (bone) p.transform.attach(bone)
    else p.transform.detach()
  }
  p.requestRender()
}

// Suspend interactive posing while animation drives the bones: detach the gizmo
// and ignore picks. resume() re-attaches to the remembered selection.
export function suspendPosing() {
  p.suspended = true
  if (p.transform) p.transform.detach()
  p.requestRender()
}

export function resumePosing() {
  p.suspended = false
  if (p.selected && p.transform) p.transform.attach(p.selected)
  p.requestRender()
}

// Read a bone's current local rotation as [x, y, z, w] (for keyframing).
export function getBoneQuaternion(name) {
  const b = p.boneMap.get(name)
  if (!b) return null
  const q = b.quaternion
  return [q.x, q.y, q.z, q.w]
}

// All bones currently rotated away from their rest pose, as { name, quat }.
// Used by "key all posed bones".
export function getPosedBones() {
  const out = []
  for (const bone of p.bones) {
    const rest = p.restQuats.get(bone)
    if (rest && !bone.quaternion.equals(rest)) {
      const q = bone.quaternion
      out.push({ name: bone.name, quat: [q.x, q.y, q.z, q.w] })
    }
  }
  return out
}

// A bone's current rotation as X/Y/Z degrees RELATIVE TO ITS REST POSE, so
// (0, 0, 0) always means "straight" — far friendlier than raw quaternions.
export function getBoneEulerDelta(name) {
  const bone = p.boneMap.get(name)
  const rest = bone && p.restQuats.get(bone)
  if (!bone || !rest) return null
  const delta = rest.clone().invert().multiply(bone.quaternion)
  const e = new THREE.Euler().setFromQuaternion(delta, 'XYZ')
  return {
    x: THREE.MathUtils.radToDeg(e.x),
    y: THREE.MathUtils.radToDeg(e.y),
    z: THREE.MathUtils.radToDeg(e.z),
  }
}

// Set a bone's rotation from rest-relative X/Y/Z degrees (the panel sliders).
// Undo batching is the caller's job via beginBoneAdjust/endBoneAdjust.
export function setBoneEulerDelta(name, deg) {
  const bone = p.boneMap.get(name)
  const rest = bone && p.restQuats.get(bone)
  if (!bone || !rest) return
  const e = new THREE.Euler(
    THREE.MathUtils.degToRad(deg.x),
    THREE.MathUtils.degToRad(deg.y),
    THREE.MathUtils.degToRad(deg.z),
    'XYZ',
  )
  bone.quaternion.copy(rest).multiply(new THREE.Quaternion().setFromEuler(e))
  updateBoneHelpers()
  p.requestRender()
}

// Bracket a continuous slider drag so it lands as ONE undo entry.
export function beginBoneAdjust(name) {
  const bone = p.boneMap.get(name)
  if (bone) p.adjustBefore = { bone, quat: bone.quaternion.clone() }
}

export function endBoneAdjust() {
  const adj = p.adjustBefore
  p.adjustBefore = null
  if (!adj || adj.bone.quaternion.equals(adj.quat)) return
  pushUndo([{ bone: adj.bone, before: adj.quat, after: adj.bone.quaternion.clone() }])
}

// Restore a single bone to its rest rotation (undoable).
export function resetBone(name) {
  const bone = p.boneMap.get(name)
  const rest = bone && p.restQuats.get(bone)
  if (!bone || !rest || bone.quaternion.equals(rest)) return
  pushUndo([{ bone, before: bone.quaternion.clone(), after: rest.clone() }])
  bone.quaternion.copy(rest)
  updateBoneHelpers()
  notifyPoseChange()
  p.requestRender()
}

// The selected bone's parent bone name (for "select parent" navigation).
export function getBoneParentName(name) {
  const bone = p.boneMap.get(name)
  const parent = bone && bone.parent
  return parent && parent.isBone && p.boneMap.has(parent.name) ? parent.name : null
}

// Turn gizmo angle snapping on (degrees) or off (null). Shift-hold inverts it.
export function setRotationSnapDeg(deg) {
  p.snapDeg = deg
  applyRotationSnap()
}

export function setTransformSpace(space) {
  if (p.transform) p.transform.setSpace(space)
  p.requestRender()
}

export function setBonesVisible(visible) {
  if (p.points) p.points.visible = visible
  // Hide the gizmo too when the overlay is hidden (keeps the view clean).
  if (p.helper) p.helper.visible = visible
  p.requestRender()
}

// Restore every bone to its rest rotation as one undoable batch.
export function resetPose() {
  if (!p.model) return
  const changes = []
  for (const bone of p.bones) {
    const rest = p.restQuats.get(bone)
    if (!rest || bone.quaternion.equals(rest)) continue
    changes.push({ bone, before: bone.quaternion.clone(), after: rest.clone() })
    bone.quaternion.copy(rest)
  }
  if (changes.length) pushUndo(changes)
  updateBoneHelpers()
  notifyPoseChange()
  p.requestRender()
}

// Flip the pose left ↔ right as one undoable batch. Each bone takes its
// mirrored counterpart's rest-relative rotation (found by the usual L/R naming
// conventions), reflected across the character's centre plane; bones with no
// counterpart (spine, head…) mirror in place. Works on the mirrored-rig
// conventions Mixamo/Rigify-style skeletons follow.
export function mirrorPose() {
  if (!p.model || p.bones.length === 0) return 0
  const snapshot = new Map(p.bones.map((b) => [b, b.quaternion.clone()]))
  const changes = []
  for (const bone of p.bones) {
    const restDst = p.restQuats.get(bone)
    if (!restDst) continue
    const counterpart = mirrorBoneName(bone.name)
    const src = counterpart ? p.boneMap.get(counterpart) : bone
    const restSrc = p.restQuats.get(src)
    if (!restSrc) continue
    // Rest-relative rotation of the source side…
    const delta = restSrc.clone().invert().multiply(snapshot.get(src))
    // …reflected across the YZ plane: axis x flips, so (x,y,z,w) → (x,-y,-z,w).
    delta.set(delta.x, -delta.y, -delta.z, delta.w)
    const after = restDst.clone().multiply(delta)
    if (!bone.quaternion.equals(after)) {
      changes.push({ bone, before: bone.quaternion.clone(), after: after.clone() })
      bone.quaternion.copy(after)
    }
  }
  if (changes.length) pushUndo(changes)
  updateBoneHelpers()
  notifyPoseChange()
  p.requestRender()
  return changes.length
}

// Apply a parsed pose (validated) as one undoable batch. Bones absent from this
// rig are skipped. Returns { applied, missing } for UI feedback.
export function applyPose(json) {
  validatePose(json)
  const changes = []
  const missing = []
  for (const [name, q] of Object.entries(json.bones)) {
    const bone = p.boneMap.get(name)
    if (!bone) {
      missing.push(name)
      continue
    }
    const after = new THREE.Quaternion(q[0], q[1], q[2], q[3])
    if (!bone.quaternion.equals(after)) {
      changes.push({ bone, before: bone.quaternion.clone(), after })
      bone.quaternion.copy(after)
    }
  }
  if (missing.length) {
    console.warn(`Pose: skipped ${missing.length} bone(s) not in this rig:`, missing)
  }
  if (changes.length) pushUndo(changes)
  updateBoneHelpers()
  notifyPoseChange()
  p.requestRender()
  return { applied: Object.keys(json.bones).length - missing.length, missing }
}

export function getPose() {
  return poseToJSON(p.bones)
}

export function undo() {
  const batch = p.undoStack.pop()
  if (!batch) return
  for (const { bone, before } of batch) bone.quaternion.copy(before)
  p.redoStack.push(batch)
  updateBoneHelpers()
  notifyPoseChange()
  p.requestRender()
}

export function redo() {
  const batch = p.redoStack.pop()
  if (!batch) return
  for (const { bone, after } of batch) bone.quaternion.copy(after)
  p.undoStack.push(batch)
  updateBoneHelpers()
  notifyPoseChange()
  p.requestRender()
}

export function disposePosing() {
  const dom = p.renderer && p.renderer.domElement
  if (dom) {
    dom.removeEventListener('pointerdown', p._onPointerDown)
    dom.removeEventListener('pointerup', p._onPointerUp)
  }
  if (p._onKeyChange) {
    window.removeEventListener('keydown', p._onKeyChange)
    window.removeEventListener('keyup', p._onKeyChange)
    p._onKeyChange = null
  }
  clearPoseModel()
  if (p.helper) {
    p.scene.remove(p.helper)
    p.helper = null
  }
  if (p.transform) {
    p.transform.dispose()
    p.transform = null
  }
  p.scene = null
  p.camera = null
  p.renderer = null
  p.controls = null
}

// --- internals ---------------------------------------------------------------

function pushUndo(batch) {
  p.undoStack.push(batch)
  p.redoStack = [] // a fresh edit invalidates the redo history
  if (p.undoStack.length > UNDO_LIMIT) p.undoStack.shift()
}

function notifyPoseChange() {
  if (p.onPoseChange) p.onPoseChange()
}

// The effective gizmo snap: the checkbox setting, inverted while Shift is held.
function applyRotationSnap() {
  if (!p.transform) return
  const snapOn = p.shiftHeld ? !p.snapDeg : !!p.snapDeg
  p.transform.setRotationSnap(snapOn ? THREE.MathUtils.degToRad(p.snapDeg || SNAP_DEG) : null)
}

// Find a bone's opposite-side counterpart by the common L/R naming schemes
// (Left/Right words, .L/.R, _l/_r, l_/r_ affixes). Returns a name that actually
// exists in this rig, or null for centre bones.
const SIDE_PATTERNS = [
  [/Left/g, 'Right'],
  [/Right/g, 'Left'],
  [/left/g, 'right'],
  [/right/g, 'left'],
  [/LEFT/g, 'RIGHT'],
  [/RIGHT/g, 'LEFT'],
  [/([._-])L($|[._-])/g, '$1R$2'],
  [/([._-])R($|[._-])/g, '$1L$2'],
  [/([._-])l($|[._-])/g, '$1r$2'],
  [/([._-])r($|[._-])/g, '$1l$2'],
  [/^L([._-])/, 'R$1'],
  [/^R([._-])/, 'L$1'],
  [/^l([._-])/, 'r$1'],
  [/^r([._-])/, 'l$1'],
]

function mirrorBoneName(name) {
  for (const [re, sub] of SIDE_PATTERNS) {
    re.lastIndex = 0
    const swapped = name.replace(re, sub)
    if (swapped !== name && p.boneMap.has(swapped)) return swapped
  }
  return null
}

function commitDragUndo() {
  if (!p.selected || !p.dragBefore) return
  const after = p.selected.quaternion.clone()
  if (!after.equals(p.dragBefore)) {
    pushUndo([{ bone: p.selected, before: p.dragBefore, after }])
  }
  p.dragBefore = null
}

function onPointerDown(e) {
  // Record where the press started and whether it landed on a gizmo axis, so
  // pointerup can tell a bone-pick from a gizmo-drag or an orbit-drag.
  p.pointerDown = { x: e.clientX, y: e.clientY, axis: p.transform ? p.transform.axis : null }
}

function onPointerUp(e) {
  const down = p.pointerDown
  p.pointerDown = null
  if (p.suspended) return // no picking while animation plays
  if (!down || e.button !== 0 || !p.points || p.points.visible === false) return
  if (down.axis !== null) return // was dragging the gizmo
  if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > DRAG_SLOP_PX) return // orbit-drag

  const name = pickBoneName(e)
  p.onSelect(name) // null on empty-space click → deselect
}

// Nearest-dot-in-screen-space pick. Returns a bone name or null. When several
// dots overlap within PICK_TIE_PX of each other (common on dense rigs), the
// bone nearest the camera wins — you pick what you can see, not what's buried
// inside the mesh behind it.
const PICK_TIE_PX = 4

function pickBoneName(e) {
  const rect = p.renderer.domElement.getBoundingClientRect()
  const px = e.clientX - rect.left
  const py = e.clientY - rect.top

  let best = null // { name, d, z }
  for (const bone of p.pickable) {
    bone.getWorldPosition(_v).project(p.camera)
    if (_v.z > 1) continue // behind the camera
    const sx = (_v.x * 0.5 + 0.5) * rect.width
    const sy = (-_v.y * 0.5 + 0.5) * rect.height
    const d = Math.hypot(sx - px, sy - py)
    if (d >= PICK_THRESHOLD_PX) continue
    if (
      !best ||
      d < best.d - PICK_TIE_PX ||
      (d < best.d + PICK_TIE_PX && _v.z < best.z)
    ) {
      best = { name: bone.name, d, z: _v.z }
    }
  }
  return best ? best.name : null
}
