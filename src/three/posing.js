import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { poseToJSON, validatePose } from './poses.js'
import { classifyBone, detectSide } from './bvh.js'
import {
  setLimitsModel,
  clearLimitsModel,
  clampBoneLocal,
  clampQuaternionForBone,
} from './limits.js'

// ---------------------------------------------------------------------------
// Bone posing
//
// - A TransformControls gizmo attaches to the selected bone. Rotate mode is
//   plain FK: rotating a bone deforms the SkinnedMesh via the skeleton.
//   Translate mode is a small CCD IK solver (see solveIk): the gizmo actually
//   drags an invisible proxy target, and the selected bone's ancestor chain
//   (elbow/shoulder, knee/hip…) swings each frame to bring the bone to it,
//   naturally capped by the chain's reach and each joint's own limb limits.
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

// IK move (Pose mode's Move gizmo) ------------------------------------------
const IK_CHAIN_LINKS = 3 // ancestor joints an IK move may recruit (hand -> forearm -> upper-arm -> shoulder)
const IK_ITERATIONS = 12 // CCD passes per drag tick — chains are short (≤3), so this stays cheap
// Only real limb joints extend an IK chain; hitting the spine/hips/chest/head
// (or an unclassified bone) stops the climb, so moving a hand can't drag the
// whole torso along with it.
const IK_LIMB_ROLES = new Set([
  'hand', 'lowerArm', 'upperArm', 'shoulder',
  'foot', 'lowerLeg', 'upperLeg', 'toe',
])

const BASE_COLOR = new THREE.Color(0x9aa0b4)
const SELECTED_COLOR = new THREE.Color(0xffc24a)

// Body-part overlay ("Parts" view) -------------------------------------------
// A friendlier alternative to picking individual bone dots: whole regions of
// the mesh (an upper arm, a hand, the waist…) are tinted and clickable as one
// unit. Clicking a region just selects its "control" bone — whatever gizmo
// mode is already active (Rotate/Move) is left alone, same as clicking a bone
// dot. `ik: true` marks the limb regions where Move mode's IK solver has
// something to work with (see selectBone's self-inclusive-chain fallback for
// upper arm/leg, which have no further ancestor limb joint to swing).
//
// Regions are built from the same canonical slot classification BVH retargeting
// uses (classifyBone), so this works on any rig regardless of naming scheme —
// plus two bits classifyBone deliberately doesn't cover (see SLOT_TO_REGION
// and assignTorsoChainRegions below): individual fingers/toes, and which
// third of a rig's spine chain counts as "waist" vs "torso".
//
// `control` lists slots in priority order for which bone the gizmo actually
// attaches to when the region is clicked (most tip-ward first); an empty list
// means "no slot preference — just pick the shallowest bone in the region"
// (used for fingers/toes and the torso-chain buckets, none of which have a
// dedicated classifyBone slot of their own).
const REGION_DEFS = [
  { key: 'head', label: 'Head', color: 0x4fa3ff, control: ['head'] },
  { key: 'neck', label: 'Neck', color: 0x6bb6ff, control: ['neck'] },
  { key: 'upperTorso', label: 'Upper Torso', color: 0x7ee787, control: [] },
  { key: 'lowerTorso', label: 'Lower Torso', color: 0x9be3a0, control: [] },
  { key: 'waist', label: 'Waist', color: 0xc7ecb0, control: [] },
  // `hub: true` — see computeRegionControls: prefer the bone where the
  // skeleton actually branches (into spine + both legs), not whichever
  // same-slot bone happens to be shallowest. Some rigs put one or more
  // non-deforming "root"/master control bones *above* the real pelvis, all of
  // which classify as 'hips' too (classifyBone treats "root" as a hips
  // synonym for BVH retargeting) — picking the shallowest of those would grab
  // a bone that moves the entire character instead of just the hips.
  { key: 'hips', label: 'Hips', color: 0xf0c674, control: ['hips'], hub: true },

  { key: 'upperArm.L', label: 'Left Upper Arm', color: 0xff9db3, control: ['upperArm.L', 'shoulder.L'], ik: true },
  { key: 'lowerArm.L', label: 'Left Lower Arm', color: 0xff88a1, control: ['lowerArm.L'], ik: true },
  { key: 'hand.L', label: 'Left Hand', color: 0xff7893, control: ['hand.L'], ik: true },
  { key: 'fingers.L', label: 'Left Fingers', color: 0xffc0cd, control: [], ik: true },
  { key: 'upperArm.R', label: 'Right Upper Arm', color: 0xff9db3, control: ['upperArm.R', 'shoulder.R'], ik: true },
  { key: 'lowerArm.R', label: 'Right Lower Arm', color: 0xff88a1, control: ['lowerArm.R'], ik: true },
  { key: 'hand.R', label: 'Right Hand', color: 0xff7893, control: ['hand.R'], ik: true },
  { key: 'fingers.R', label: 'Right Fingers', color: 0xffc0cd, control: [], ik: true },

  { key: 'upperLeg.L', label: 'Left Upper Leg', color: 0x8fd0ff, control: ['upperLeg.L'], ik: true },
  { key: 'lowerLeg.L', label: 'Left Lower Leg', color: 0x79c3fb, control: ['lowerLeg.L'], ik: true },
  { key: 'foot.L', label: 'Left Foot', color: 0x63b6f7, control: ['foot.L'], ik: true },
  { key: 'toes.L', label: 'Left Toes', color: 0xbde5ff, control: ['toe.L'], ik: true },
  { key: 'upperLeg.R', label: 'Right Upper Leg', color: 0x8fd0ff, control: ['upperLeg.R'], ik: true },
  { key: 'lowerLeg.R', label: 'Right Lower Leg', color: 0x79c3fb, control: ['lowerLeg.R'], ik: true },
  { key: 'foot.R', label: 'Right Foot', color: 0x63b6f7, control: ['foot.R'], ik: true },
  { key: 'toes.R', label: 'Right Toes', color: 0xbde5ff, control: ['toe.R'], ik: true },
]

// Direct classifyBone-slot → region mapping. 'spine'/'chest' are deliberately
// left out — they're split across waist/lowerTorso/upperTorso by chain
// position instead (assignTorsoChainRegions), since classifyBone has no way
// to know which vertebra counts as which without seeing the whole chain.
const SLOT_TO_REGION = new Map([
  ['hips', 'hips'],
  ['neck', 'neck'],
  ['head', 'head'],
  ['shoulder.L', 'upperArm.L'],
  ['upperArm.L', 'upperArm.L'],
  ['lowerArm.L', 'lowerArm.L'],
  ['hand.L', 'hand.L'],
  ['shoulder.R', 'upperArm.R'],
  ['upperArm.R', 'upperArm.R'],
  ['lowerArm.R', 'lowerArm.R'],
  ['hand.R', 'hand.R'],
  ['upperLeg.L', 'upperLeg.L'],
  ['lowerLeg.L', 'lowerLeg.L'],
  ['foot.L', 'foot.L'],
  ['toe.L', 'toes.L'],
  ['upperLeg.R', 'upperLeg.R'],
  ['lowerLeg.R', 'lowerLeg.R'],
  ['foot.R', 'foot.R'],
  ['toe.R', 'toes.R'],
])

// Regions with no inherent left/right side of their own — a bone that lands
// in one of these but whose own name still carries an L/R marker is almost
// certainly a corrective (see computeRegionControls).
const CENTRELINE_REGIONS = new Set(['head', 'neck', 'hips', 'waist', 'lowerTorso', 'upperTorso'])

// Idle/hover/selected opacity for the region overlays. Idle is fully
// invisible by design — the character looks completely normal in Parts view
// until you interact with it; hover gives a light preview of what a click
// would select; selected is the only state meant to stand out.
const PART_OPACITY = { idle: 0, allSubtle: 0.12, hover: 0.16, selected: 0.55 }

// Module state (mirrors the scene-manager singleton style used elsewhere).
const p = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  requestRender: () => {},
  onSelect: null, // (boneName|null) => void — reports picks up to the store
  onPoseChange: null, // () => void — any pose edit (drag, undo, reset…); UI resync

  transform: null, // TransformControls
  helper: null, // transform.getHelper() (added to scene)
  gizmoMode: 'rotate', // 'rotate' (FK) | 'translate' (IK move) — bones have no resize gizmo

  ikProxy: null, // invisible Object3D the translate gizmo actually drags
  ikChain: [], // selected bone's ancestor joints (nearest first) solved by solveIk()
  ikTipRef: null, // set only when ikChain is self-inclusive (see selectBone) — the limb's
  // actual tip (hand/foot), used as the CCD position reference instead of the effector itself
  ikDragBefore: null, // Map<Bone, Quaternion> captured at IK-drag start, for undo

  model: null,
  bones: [],
  boneMap: new Map(), // name -> Bone
  restQuats: new Map(), // Bone -> THREE.Quaternion (rotation at load)
  pickable: [], // bones shown as dots / clickable (subset of bones)
  pickableNames: null, // Set of names restricting pickable, or null = all

  points: null,
  pointsGeom: null,
  pointsMat: null,

  viewMode: 'bones', // 'bones' (dot overlay) | 'parts' (body-part regions)
  showAllHighlights: false, // Parts view: tint every region faintly, not just hover/selected
  boneRegionMap: new Map(), // Bone -> region key (or null), built per model
  regionControl: new Map(), // region key -> control bone name, built per model
  partMaterials: new Map(), // region key -> shared MeshBasicMaterial
  partMeshes: [], // [{ region, mesh (SkinnedMesh overlay) }]
  hoverRegion: null, // region key under the pointer in Parts view
  onGizmoModeChange: null, // (mode) => void — keeps the store's gizmo toggle in sync

  selected: null, // selected Bone (or null)
  enabled: true, // false outside Bone mode: overlay hidden, gizmo detached, no picking
  overlayVisible: true, // the user's "Show joints" toggle (independent of mode)
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
  p.onGizmoModeChange = refs.onGizmoModeChange || null

  const transform = new TransformControls(p.camera, p.renderer.domElement)
  transform.setMode('rotate')
  transform.setSpace('local')
  transform.setSize(0.8)
  // Suspend orbit while dragging the gizmo so the two don't fight (and stay
  // locked if a camera view has orbit off).
  transform.addEventListener('dragging-changed', (e) => {
    p.controls.enabled = !e.value && !p.controls.locked
  })
  transform.addEventListener('objectChange', () => {
    if (p.gizmoMode === 'translate') {
      solveIk() // drag the proxy → CCD-solve the ancestor chain toward it
    } else if (p.selected) {
      clampBoneLocal(p.selected) // keep gizmo edits inside the limb limits
    }
    notifyPoseChange() // keep the rotation sliders in sync while dragging
    p.requestRender()
  })
  transform.addEventListener('mouseDown', () => {
    if (!p.selected) return
    if (p.gizmoMode === 'translate') {
      p.ikDragBefore = new Map(p.ikChain.map((b) => [b, b.quaternion.clone()]))
    } else {
      p.dragBefore = p.selected.quaternion.clone()
    }
  })
  transform.addEventListener('mouseUp', () => {
    if (p.gizmoMode === 'translate') commitIkDragUndo()
    else commitDragUndo()
    p.requestRender()
  })
  p.transform = transform

  // An invisible target the translate gizmo drags instead of the bone itself
  // — the bone's actual position is FK-derived from its ancestors' rotations,
  // so "moving" it means solving those rotations, not setting a position.
  const ikProxy = new THREE.Object3D()
  ikProxy.name = '(ik target)'
  p.scene.add(ikProxy)
  p.ikProxy = ikProxy

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
  p._onPointerMove = onPointerMove
  dom.addEventListener('pointerdown', p._onPointerDown)
  dom.addEventListener('pointerup', p._onPointerUp)
  dom.addEventListener('pointermove', p._onPointerMove)

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
  setLimitsModel(model) // measure the limb limits against this rest pose
  p.boneRegionMap = buildBoneRegionMap()
  buildPartOverlays(model)
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
  applyOverlayVisibility()
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
  p.ikChain = []
  p.ikTipRef = null
  p.ikDragBefore = null
  p.suspended = false
  p.undoStack = []
  p.redoStack = []
  disposePartOverlays()
  p.boneRegionMap = new Map()
  p.regionControl = new Map()
  p.hoverRegion = null
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
  clearLimitsModel()
}

// Called each render (before draw) to park each dot on its bone's head and tint
// the selected one. Reads live world matrices, so it tracks bones during a drag.
export function updateBoneHelpers() {
  if (!p.enabled || p.suspended || !p.points || !p.model) return
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
  p.ikChain = bone ? buildIkChain(bone) : []
  // A bone like an upper arm/leg with no shoulder/hip-equivalent link above
  // it (either the rig has none, or that link isn't recognisable by name)
  // gets an empty chain from buildIkChain — there'd be nothing for Move mode
  // to actually rotate, so dragging it would silently do nothing. In that
  // specific case, let the clicked bone rotate itself (it's a real limb
  // joint, just the topmost one available) and aim the drag at that limb's
  // tip (hand/foot) instead of the bone's own position, which never moves.
  p.ikTipRef = null
  if (bone && p.ikChain.length === 0) {
    const slot = classifyBone(bone.name)
    const role = slot ? slot.split('.')[0] : null
    if (IK_LIMB_ROLES.has(role)) {
      p.ikChain = [bone]
      p.ikTipRef = findLimbTip(bone)
    }
  }
  if (!p.suspended && p.enabled) {
    attachGizmoToSelected()
  } else if (!bone && p.transform) {
    p.transform.detach()
  }
  applyOverlayVisibility() // attach/detach set helper visibility; re-apply the gates
  updatePartMaterials()
  p.requestRender()
}

// Attach the (already-moded) TransformControls to whatever the current gizmo
// mode needs: the bone directly for FK rotate, or the IK proxy — parked on
// the bone's current world position — for an IK move.
function attachGizmoToSelected() {
  if (!p.transform) return
  if (!p.selected) {
    p.transform.detach()
    return
  }
  if (p.gizmoMode === 'translate') {
    p.selected.getWorldPosition(p.ikProxy.position)
    p.transform.attach(p.ikProxy)
  } else {
    p.transform.attach(p.selected)
  }
}

// Enable/disable interactive posing as a whole (Bone mode on/off). Unlike
// suspend/resume (playback-driven), this also hides the dot overlay. The
// selection is remembered so switching back re-attaches the gizmo.
export function setPosingEnabled(enabled) {
  p.enabled = enabled
  if (p.transform) {
    if (enabled && p.selected && !p.suspended) attachGizmoToSelected()
    else if (!enabled) p.transform.detach()
  }
  applyOverlayVisibility()
  p.requestRender()
}

// Suspend interactive posing while animation drives the bones: detach the gizmo
// and ignore picks. resume() re-attaches to the remembered selection.
export function suspendPosing() {
  p.suspended = true
  if (p.transform) p.transform.detach()
  applyOverlayVisibility()
  p.requestRender()
}

export function resumePosing() {
  p.suspended = false
  if (p.enabled && p.selected && p.transform) attachGizmoToSelected()
  applyOverlayVisibility()
  p.requestRender()
}

// Switch the Pose-mode gizmo between FK rotate (drag rings to bend the joint)
// and IK move (drag the joint itself; its ancestor chain swings to follow it,
// capped by its reach and each joint's own limb limits). Bones have no resize
// gizmo — there's nothing on a bone to resize.
export function setBoneGizmoMode(mode) {
  p.gizmoMode = mode === 'translate' ? 'translate' : 'rotate'
  if (p.transform) p.transform.setMode(p.gizmoMode)
  if (p.selected) attachGizmoToSelected()
  p.requestRender()
}

// Debug/test surface: the gizmo mode as posing.js currently sees it.
export function getBoneGizmoMode() {
  return p.gizmoMode
}

// Debug/test surface: inspect the IK chain actually built for the current
// selection, including the self-inclusive-chain fallback (see selectBone).
export function getIkDebugInfo() {
  return {
    chain: p.ikChain.map((b) => b.name),
    tipRef: p.ikTipRef ? p.ikTipRef.name : null,
    selected: p.selected ? p.selected.name : null,
  }
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
  clampBoneLocal(bone) // slider edits respect the limb limits too
  updateBoneHelpers()
  p.requestRender()
}

// Clamp the CURRENT pose — however it was made (loaded file, mocap frame,
// mirror…) — to the limb limits, as one undoable batch. This is the explicit
// override; passive posing never rewrites an existing pose. Returns how many
// joints changed.
export function applyLimitsToPose() {
  const changes = []
  for (const bone of p.bones) {
    const before = bone.quaternion.clone()
    if (clampQuaternionForBone(bone, bone.quaternion)) {
      changes.push({ bone, before, after: bone.quaternion.clone() })
    }
  }
  if (changes.length) pushUndo(changes)
  updateBoneHelpers()
  notifyPoseChange()
  p.requestRender()
  return changes.length
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
// Look up a live Bone Object3D by name on the currently active character —
// used by the Objects panel to attach a prop (gun, shield, hat...) to a bone
// so it follows posing/animation automatically via the normal scene graph.
export function getBoneByName(name) {
  return name ? p.boneMap.get(name) || null : null
}

// Debug/test surface for the body-parts overlay: which region a bone belongs
// to, and which bone a region's click resolves to. Also handy if a future
// panel wants to label the currently hovered/selected region by name.
export function getBoneRegionKey(name) {
  const bone = p.boneMap.get(name)
  return bone ? p.boneRegionMap.get(bone) || null : null
}

// Debug/test surface: the built overlay meshes, keyed by region.
export function getPartOverlayMeshes() {
  return p.partMeshes.map(({ region, mesh }) => ({ region, mesh }))
}

export function getRegionControlBoneName(regionKey) {
  return p.regionControl.get(regionKey) || null
}


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

// Swap the camera the dot-picking projection and gizmo work against (used when
// the viewport looks through a placed camera).
export function setViewCamera(camera) {
  p.camera = camera
  if (p.transform) p.transform.camera = camera
}

export function setBonesVisible(visible) {
  p.overlayVisible = visible
  applyOverlayVisibility()
  p.requestRender()
}

// The dots (and gizmo) show only when the user toggle is on AND Bone mode is
// active. Hiding the helper with the overlay keeps the view clean. The helper
// additionally needs a bone attached — forcing a detached TransformControls
// visible would draw the gizmo floating at the world origin.
function applyOverlayVisibility() {
  const on = p.overlayVisible && p.enabled
  const bonesOn = on && p.viewMode !== 'parts'
  const partsOn = on && p.viewMode === 'parts'
  if (p.points) p.points.visible = bonesOn
  for (const { mesh } of p.partMeshes) mesh.visible = partsOn
  if (p.helper) p.helper.visible = on && !!p.selected && !p.suspended
  if (!partsOn) p.hoverRegion = null
}

// Switch Pose mode's overlay between bone dots and body-part regions. Both
// share the same selection/gizmo machinery — this only changes what's drawn
// and how a click resolves to a bone.
export function setBoneViewMode(mode) {
  p.viewMode = mode === 'parts' ? 'parts' : 'bones'
  applyOverlayVisibility()
  updatePartMaterials()
  p.requestRender()
}

// Parts view: show every region faintly all the time, instead of only on
// hover/selection — a quick way to see the whole segmentation at a glance.
export function setShowAllPartHighlights(enabled) {
  p.showAllHighlights = !!enabled
  updatePartMaterials()
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

// --- world-space mirroring helpers -------------------------------------

// Reflects a WORLD (root-relative) rotation across the character's X=0
// plane. Standard humanoid rig convention: X = left/right, Y = up,
// Z = forward. This is what makes mirroring correct regardless of how any
// individual bone's own local axes happen to be authored — unlike copying a
// bone's local rest-relative delta straight across (which only works if the
// two bones' local axes happen to agree, and otherwise flips something like
// forward/backward on the mirrored side).
function mirrorQuatAcrossX(q, out = new THREE.Quaternion()) {
  return out.set(q.x, -q.y, -q.z, q.w)
}

// Temporarily poses every bone from `localQuatMap` (falling back to its
// current quaternion when absent), then reads back each bone's world
// rotation expressed relative to the model root — i.e. in the character's
// own left-right frame, not the scene's. Restores the original pose before
// returning.
function computeRootRelativeWorldQuats(localQuatMap) {
  const saved = new Map(p.bones.map((b) => [b, b.quaternion.clone()]))
  for (const b of p.bones) {
    const q = localQuatMap.get(b)
    if (q) b.quaternion.copy(q)
  }
  p.model.root.updateWorldMatrix(true, true)
  const rootInv = new THREE.Quaternion()
  p.model.root.getWorldQuaternion(rootInv).invert()
  const result = new Map()
  for (const b of p.bones) {
    const wq = new THREE.Quaternion()
    b.getWorldQuaternion(wq)
    wq.premultiply(rootInv)
    result.set(b, wq)
  }
  for (const [b, q] of saved) b.quaternion.copy(q)
  p.model.root.updateWorldMatrix(true, true)
  return result
}

// Resolves the local quaternion for every bone in `newWorldMap` at once.
// Looks up a parent's NEW world rotation when the parent is itself part of
// the mirrored/symmetrised set (e.g. lowerArm under a mirrored upperArm), or
// its unchanged current world rotation otherwise (e.g. an unsided chest) —
// so chain order doesn't matter, only map contents.
function resolveLocalsFromWorld(newWorldMap, currentWorld) {
  const changes = []
  for (const [target, newWorld] of newWorldMap) {
    const parent = target.parent
    const parentQuat =
      parent && parent.isBone && p.boneMap.has(parent.name)
        ? newWorldMap.get(parent) || currentWorld.get(parent) || new THREE.Quaternion()
        : new THREE.Quaternion()
    const after = parentQuat.clone().invert().multiply(newWorld)
    if (!target.quaternion.equals(after)) {
      changes.push({ bone: target, before: target.quaternion.clone(), after })
      target.quaternion.copy(after)
    }
  }
  return changes
}

// Flip the left/right pose as one undoable batch. Only bones with a verified
// opposite-side counterpart are changed; centre bones are intentionally left
// alone. Mirroring happens in world space (see mirrorQuatAcrossX) so it's
// correct regardless of each bone's own local axis conventions — this is
// what fixes limbs coming out bent the wrong way (e.g. an arm pointing
// forward ending up pointing backward after mirroring).
export function mirrorPose() {
  if (!p.model || p.bones.length === 0) return 0
  const snapshot = new Map(p.bones.map((b) => [b, b.quaternion.clone()]))
  const restWorld = computeRootRelativeWorldQuats(p.restQuats)
  const currentWorld = computeRootRelativeWorldQuats(snapshot)

  const processed = new Set()
  const pairs = []
  for (const bone of p.bones) {
    if (processed.has(bone)) continue
    const counterpartName = mirrorBoneName(bone.name)
    const src = counterpartName ? p.boneMap.get(counterpartName) : null
    if (!src || src === bone) continue
    processed.add(bone)
    processed.add(src)
    pairs.push([bone, src])
  }

  // Each affected bone's new world rotation is self-contained (its own rest
  // + its counterpart's rest/current), so it doesn't matter that a bone and
  // its parent might both be mirrored — no ordering dependency here.
  const newWorldMap = new Map()
  for (const [a, b] of pairs) {
    for (const [target, source] of [[a, b], [b, a]]) {
      const restW = restWorld.get(target)
      const restSrcW = restWorld.get(source)
      const curSrcW = currentWorld.get(source)
      if (!restW || !restSrcW || !curSrcW) continue
      const deltaWorld = curSrcW.clone().multiply(restSrcW.clone().invert())
      const mirrored = mirrorQuatAcrossX(deltaWorld)
      newWorldMap.set(target, mirrored.multiply(restW))
    }
  }

  const changes = resolveLocalsFromWorld(newWorldMap, currentWorld)
  if (changes.length) pushUndo(changes)
  updateBoneHelpers()
  notifyPoseChange()
  p.requestRender()
  return changes.length
}

// Average each pair's rest-relative rotation, reflected across the centre
// plane, then apply that shared result to both sides. Centre bones are
// averaged with their own reflection so the entire character becomes
// symmetrical. Paired limbs are reconciled in world space (see
// mirrorQuatAcrossX) for the same reason mirrorPose is.
export function symmetrisePose(strategy = 'average') {
  if (!p.model || p.bones.length === 0) return 0
  const snapshot = new Map(p.bones.map((b) => [b, b.quaternion.clone()]))
  const restWorld = computeRootRelativeWorldQuats(p.restQuats)
  const currentWorld = computeRootRelativeWorldQuats(snapshot)

  const processed = new Set()
  const changes = []
  const newWorldMap = new Map()

  for (const bone of p.bones) {
    if (processed.has(bone)) continue
    const counterpartName = mirrorBoneName(bone.name)
    const counterpart = counterpartName ? p.boneMap.get(counterpartName) : null

    if (!counterpart || counterpart === bone) {
      // Centreline bone (spine, hips, head…): no side-mismatch to reconcile,
      // so this stays a plain local-space average toward zero deflection.
      processed.add(bone)
      const rest = p.restQuats.get(bone)
      const current = snapshot.get(bone)
      if (!rest || !current) continue
      const delta = rest.clone().invert().multiply(current)
      const target = strategy === 'average' ? delta.clone().slerp(new THREE.Quaternion(), 0.5) : new THREE.Quaternion()
      const after = rest.clone().multiply(target)
      if (!bone.quaternion.equals(after)) {
        changes.push({ bone, before: bone.quaternion.clone(), after })
        bone.quaternion.copy(after)
      }
      continue
    }

    processed.add(bone)
    processed.add(counterpart)

    // Normalize which of the pair is "left" so the left/right strategy
    // options mean what they say, regardless of iteration order.
    const boneIsLeft = sideKey(bone.name)?.side === 'left'
    const left = boneIsLeft ? bone : counterpart
    const right = boneIsLeft ? counterpart : bone

    const restLeftW = restWorld.get(left)
    const restRightW = restWorld.get(right)
    const curLeftW = currentWorld.get(left)
    const curRightW = currentWorld.get(right)
    if (!restLeftW || !restRightW || !curLeftW || !curRightW) continue

    // Express both sides' motion in the SAME (left) convention so they can
    // be compared/averaged directly.
    const deltaLeft = curLeftW.clone().multiply(restLeftW.clone().invert())
    const deltaRightAsLeft = mirrorQuatAcrossX(curRightW.clone().multiply(restRightW.clone().invert()))

    const shared =
      strategy === 'left' ? deltaLeft
      : strategy === 'right' ? deltaRightAsLeft
      : deltaLeft.clone().slerp(deltaRightAsLeft, 0.5)

    newWorldMap.set(left, shared.clone().multiply(restLeftW))
    newWorldMap.set(right, mirrorQuatAcrossX(shared).multiply(restRightW))
  }

  changes.push(...resolveLocalsFromWorld(newWorldMap, currentWorld))

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
    dom.removeEventListener('pointermove', p._onPointerMove)
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
  if (p.ikProxy) {
    p.scene.remove(p.ikProxy)
    p.ikProxy = null
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

function mirrorBoneName(name) {
  const info = sideKey(name)
  if (!info) return null
  for (const candidate of p.bones) {
    const other = sideKey(candidate.name)
    if (other && other.side !== info.side && other.key === info.key) return candidate.name
  }
  return null
}

function sideKey(name) {
  let normalized = name.toLowerCase()
  let side = null
  if (/left/.test(normalized)) {
    side = 'left'
    normalized = normalized.replace(/left/g, '{side}')
  } else if (/right/.test(normalized)) {
    side = 'right'
    normalized = normalized.replace(/right/g, '{side}')
  } else {
    const marker = /(^|[._-])([lr])(?=$|[._-])/.exec(normalized)
    if (!marker) return null
    side = marker[2] === 'l' ? 'left' : 'right'
    normalized = normalized.replace(marker[0], `${marker[1]}{side}`)
  }
  normalized = normalized.replace(/([._-])\d+$/g, '')
  return { side, key: normalized }
}

// Exposed mainly so the IK solve can be exercised directly (drag simulation
// in tests, or future scripting) without going through a simulated pointer
// drag on the TransformControls widget. The real gizmo path sets
// p.ikProxy.position itself (that's literally what dragging it does) and
// just calls solveIk() from the 'objectChange' listener above.
export function debugMoveSelectedBoneToward(worldPos) {
  if (!p.ikProxy) return null
  p.ikProxy.position.copy(worldPos)
  solveIk()
  return p.ikProxy.position.clone()
}

function commitDragUndo() {
  if (!p.selected || !p.dragBefore) return
  const after = p.selected.quaternion.clone()
  if (!after.equals(p.dragBefore)) {
    pushUndo([{ bone: p.selected, before: p.dragBefore, after }])
  }
  p.dragBefore = null
}

// The ancestor joints an IK move on `effector` is allowed to swing: nearest
// first, stopping at IK_CHAIN_LINKS or as soon as an ancestor isn't itself a
// limb joint (spine/chest/hips/neck/head, or anything unclassified). A bone
// rotating its own joint doesn't move ITS OWN position — only its ancestors'
// rotations do — so the effector bone itself is never part of the chain.
function buildIkChain(effector) {
  const chain = []
  let b = effector.parent
  while (b && b.isBone && p.boneMap.has(b.name) && chain.length < IK_CHAIN_LINKS) {
    const slot = classifyBone(b.name)
    const role = slot ? slot.split('.')[0] : null
    if (!IK_LIMB_ROLES.has(role)) break
    chain.push(b)
    b = b.parent
  }
  return chain
}

// Walk DOWN from a limb-root bone (upper arm/leg) toward the tip of that same
// limb (hand/foot), following the single-child chain that exists before any
// finger/toe branching starts. Used only as a *position reference* for CCD
// when the clicked bone itself has to be the thing that rotates (see
// selectBone) — dragging "upper arm" needs something to visibly reach for the
// target with, and the upper arm bone's own origin never moves (it's pinned
// at the shoulder), so the hand's position is what the drag should actually
// aim.
function findLimbTip(bone) {
  let cur = bone
  for (let i = 0; i < 12; i++) {
    // hard cap: guards against any unusual rig producing a cycle-like walk
    const slot = classifyBone(cur.name)
    const role = slot ? slot.split('.')[0] : null
    if (role === 'hand' || role === 'foot') return cur
    const kids = cur.children.filter((c) => c.isBone && p.boneMap.has(c.name))
    if (!kids.length) return cur
    cur = kids[0] // no branching before hand/foot in a normal rig, so this is unambiguous
  }
  return cur
}

const _effPos = new THREE.Vector3()
const _jPos = new THREE.Vector3()
const _toEff = new THREE.Vector3()
const _toTarget = new THREE.Vector3()
const _jWorldQuat = new THREE.Quaternion()
const _parentWorldQuat = new THREE.Quaternion()
const _deltaQuat = new THREE.Quaternion()
const _newWorldQuat = new THREE.Quaternion()

// CCD (cyclic coordinate descent): for each joint in the chain (nearest to
// the moved bone first), swing it so the vector from the joint to the bone
// points at the target instead, then clamp it to its limb limits and move on.
// Repeat a handful of passes to converge. If the target is farther than the
// chain can reach, this just leaves the limb fully extended toward it rather
// than doing anything unnatural — reach and per-joint limits are the only
// "budget", exactly like a real arm or leg.
function solveIk() {
  const effector = p.selected
  if (!effector || !p.model) return
  // Normally the effector's own position is what CCD tries to move — its
  // ancestors rotate, it doesn't. In the self-inclusive-chain case (see
  // selectBone) the effector IS one of the joints being rotated, so its own
  // position barely changes; the limb's actual tip is what the drag should
  // be judged against instead.
  const posRef = p.ikTipRef || effector
  const target = p.ikProxy.position // ikProxy is a scene-root child, so this IS its world position
  if (p.ikChain.length) {
    for (let iter = 0; iter < IK_ITERATIONS; iter++) {
      for (const joint of p.ikChain) {
        posRef.getWorldPosition(_effPos)
        joint.getWorldPosition(_jPos)
        _toEff.copy(_effPos).sub(_jPos)
        _toTarget.copy(target).sub(_jPos)
        if (_toEff.lengthSq() < 1e-10 || _toTarget.lengthSq() < 1e-10) continue
        _toEff.normalize()
        _toTarget.normalize()
        _deltaQuat.setFromUnitVectors(_toEff, _toTarget)

        joint.getWorldQuaternion(_jWorldQuat)
        _newWorldQuat.copy(_deltaQuat).multiply(_jWorldQuat)
        if (joint.parent) joint.parent.getWorldQuaternion(_parentWorldQuat)
        else _parentWorldQuat.identity()
        joint.quaternion.copy(_parentWorldQuat.invert().multiply(_newWorldQuat))

        clampBoneLocal(joint) // each step stays inside the joint's natural range
        joint.updateWorldMatrix(true, true) // so the next joint/iteration sees the new pose
      }
    }
    updateBoneHelpers()
  }
  // Keep the gizmo glued to the bone it's actually moving, rather than
  // letting it drift toward wherever the mouse currently is. Without this,
  // dragging past the chain's reach (or dragging a bone with no eligible
  // chain at all — e.g. the hips) leaves the handle sliding further and
  // further from the model the longer the drag continues, since nothing
  // was otherwise pulling the proxy itself back toward the actual result.
  posRef.getWorldPosition(p.ikProxy.position)
}

function commitIkDragUndo() {
  const before = p.ikDragBefore
  p.ikDragBefore = null
  if (!before) return
  const changes = []
  for (const [bone, beforeQuat] of before) {
    const after = bone.quaternion.clone()
    if (!after.equals(beforeQuat)) changes.push({ bone, before: beforeQuat, after })
  }
  if (changes.length) pushUndo(changes)
}

function onPointerDown(e) {
  // Record where the press started and whether it landed on a gizmo axis, so
  // pointerup can tell a bone-pick from a gizmo-drag or an orbit-drag.
  p.pointerDown = { x: e.clientX, y: e.clientY, axis: p.transform ? p.transform.axis : null }
}

function onPointerUp(e) {
  const down = p.pointerDown
  p.pointerDown = null
  if (p.suspended || !p.enabled) return // no picking while animation plays or mode is off
  if (!down || e.button !== 0) return
  if (down.axis !== null) return // was dragging the gizmo
  if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > DRAG_SLOP_PX) return // orbit-drag

  if (p.viewMode === 'parts') {
    if (!p.overlayVisible || !p.partMeshes.length) return
    selectRegion(pickPartRegion(e))
    return
  }

  if (!p.points || p.points.visible === false) return
  const name = pickBoneName(e)
  p.onSelect(name) // null on empty-space click → deselect
}

// Live hover highlight for Parts view — brightens the region under the
// pointer so it's obvious what a click will select, before committing to it.
function onPointerMove(e) {
  if (!p.enabled || p.suspended || p.viewMode !== 'parts' || !p.overlayVisible || !p.partMeshes.length) {
    if (p.hoverRegion) {
      p.hoverRegion = null
      updatePartMaterials()
      p.requestRender()
    }
    return
  }
  const region = pickPartRegion(e)
  if (region !== p.hoverRegion) {
    p.hoverRegion = region
    updatePartMaterials()
    p.requestRender()
  }
}

// Resolve a body-part region click to its control bone and select it. The
// gizmo mode is left exactly as the user had it — clicking a limb doesn't
// force Move mode, since that's surprising if you were mid-way through
// rotating something. Move mode (IK) still works great on these bones if the
// user switches to it themselves; see selectBone's self-inclusive-chain
// fallback for the case where a bone has no ancestor limb joint to swing.
function selectRegion(regionKey) {
  if (!regionKey) {
    p.onSelect(null)
    return
  }
  const controlName = p.regionControl.get(regionKey)
  p.onSelect(controlName || null)
}

const _partRaycaster = new THREE.Raycaster()
const _partNdc = new THREE.Vector2()

// Raycast pick against the region overlay meshes (accurate even on a posed
// character — SkinnedMesh applies bone transforms during raycasting, not just
// on the GPU). Returns a region key or null.
function pickPartRegion(e) {
  const rect = p.renderer.domElement.getBoundingClientRect()
  _partNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
  _partNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  _partRaycaster.setFromCamera(_partNdc, p.camera)
  const meshes = p.partMeshes.map((pm) => pm.mesh)
  const hits = _partRaycaster.intersectObjects(meshes, false)
  if (!hits.length) return null
  const found = p.partMeshes.find((pm) => pm.mesh === hits[0].object)
  return found ? found.region : null
}

// Recolor/re-opacity the region materials for the current selection + hover.
// Cheap (one material per region) so this can run on every selection change
// and pointer move without needing to be throttled.
function updatePartMaterials() {
  if (!p.partMaterials.size) return
  const selectedRegion = p.selected ? resolveBoneRegion(p.selected) : null
  const idleOpacity = p.showAllHighlights ? PART_OPACITY.allSubtle : PART_OPACITY.idle
  for (const def of REGION_DEFS) {
    const mat = p.partMaterials.get(def.key)
    if (!mat) continue
    const isSelected = def.key === selectedRegion
    const isHover = def.key === p.hoverRegion
    mat.opacity = isSelected ? PART_OPACITY.selected : isHover ? PART_OPACITY.hover : idleOpacity
    mat.color.copy(isSelected ? SELECTED_COLOR : new THREE.Color(def.color))
  }
}

// The region a bone belongs to, via the precomputed per-bone map (walks up to
// the nearest classified ancestor at build time — see buildBoneRegionMap).
function resolveBoneRegion(bone) {
  return p.boneRegionMap.get(bone) || null
}

// Classify a bone directly into a region by its canonical slot (bvh.js) —
// only for slots with an unambiguous mapping (SLOT_TO_REGION). Returns null
// for 'spine'/'chest' (handled by assignTorsoChainRegions) and for anything
// classifyBone itself doesn't recognise (fingers, twist correctives, facial
// bones…) — those get resolved by inheritance in buildBoneRegionMap.
function directRegionKeyForBone(bone) {
  const slot = classifyBone(bone.name)
  if (!slot) return null
  return SLOT_TO_REGION.get(slot) || null
}

// A bone whose region comes from inheriting its parent's, rather than its own
// slot, needs one adjustment: children of a hand/foot are fingers/toes, not
// more "hand"/"foot" — otherwise a region built by inheritance would just be
// a bigger hand/foot with no separate finger/toe highlight at all.
function substituteChildRegion(parentRegion) {
  if (parentRegion === 'hand.L') return 'fingers.L'
  if (parentRegion === 'hand.R') return 'fingers.R'
  if (parentRegion === 'foot.L') return 'toes.L'
  if (parentRegion === 'foot.R') return 'toes.R'
  return parentRegion
}

// classifyBone reports every vertebra as plain 'spine' (or 'chest') — it has
// no way to know, from one bone's name alone, whether it's near the hips or
// near the shoulders. This splits the actual spine *chain* (ordered root to
// tip) into thirds: waist / lower torso / upper torso. Sided bones (e.g. a
// rig with only "L_Chest_01_Jnt"/"R_Chest_01_Jnt" and no unsided chest bone)
// are corrective, not chain members — they're excluded from the ordering and
// bucketed straight into 'upperTorso' — unless a rig has *only* sided
// spine/chest bones, in which case they're all that's available and are used
// as-is rather than leaving the torso with no regions at all.
// Mutates `direct` in place (a plain slot->region Map, pre-inheritance).
function assignTorsoChainRegions(direct) {
  const spineBones = p.bones.filter((b) => {
    const slot = classifyBone(b.name)
    return slot === 'spine' || slot === 'chest'
  })
  if (!spineBones.length) return

  const unsided = spineBones.filter((b) => !detectSide(b.name.toLowerCase()))
  const sided = spineBones.filter((b) => detectSide(b.name.toLowerCase()))
  const chain = (unsided.length ? unsided : spineBones).slice().sort((a, b) => boneChainDepth(a) - boneChainDepth(b))

  const buckets = ['waist', 'lowerTorso', 'upperTorso']
  const n = chain.length
  chain.forEach((bone, i) => {
    const bucketIdx = Math.min(2, Math.floor((i * 3) / n))
    direct.set(bone, buckets[bucketIdx])
  })
  if (unsided.length) {
    for (const bone of sided) direct.set(bone, 'upperTorso')
  }
}

// Every bone gets a region: bones with an unambiguous slot get it directly
// (plus the spine/chest chain, bucketed by position — see
// assignTorsoChainRegions); everything else (fingers, toes, twist/volume
// correctives, sockets…) inherits its nearest already-resolved ancestor's
// region, so a highlighted region also covers its helper bones rather than
// leaving gaps in the overlay.
function buildBoneRegionMap() {
  const direct = new Map()
  for (const b of p.bones) {
    const region = directRegionKeyForBone(b)
    if (region) direct.set(b, region)
  }
  assignTorsoChainRegions(direct)

  const final = new Map()
  function resolve(bone) {
    if (final.has(bone)) return final.get(bone)
    final.set(bone, null) // guard against cycles while resolving
    let region = direct.get(bone) || null
    if (!region) {
      const parent = bone.parent && bone.parent.isBone && p.boneMap.has(bone.parent.name) ? bone.parent : null
      region = substituteChildRegion(parent ? resolve(parent) : null)
    }
    final.set(bone, region)
    return region
  }
  for (const b of p.bones) resolve(b)
  return final
}

// How many Bone ancestors sit above this bone (within the rig) — used to break
// ties in favour of the more distal (tip-ward) bone when picking a region's
// control bone.
function boneChainDepth(bone) {
  let d = 0
  let cur = bone.parent
  while (cur && cur.isBone && p.boneMap.has(cur.name)) {
    d++
    cur = cur.parent
  }
  return d
}

// How many of this bone's direct children are themselves rig bones — used to
// find the skeleton's true branch points (e.g. the pelvis, where the spine
// and both legs split off), as distinct from a non-deforming root/master
// bone above it that only ever has one child on the way down to the pelvis.
function boneChildBoneCount(bone) {
  let count = 0
  for (const child of bone.children) {
    if (child.isBone && p.boneMap.has(child.name)) count++
  }
  return count
}

// Pick each region's control bone — the one the gizmo attaches to when the
// region is clicked — preferring the most tip-ward slot in `def.control`
// (e.g. the hand over the shoulder). On ties, prefer the SHALLOWEST bone
// (closest to the rig root): many game rigs add corrective/twist "fix"
// joints (e.g. "L_Wrist_Fix_2_Jnt") as extra children *underneath* the real
// hand/foot/chest bone for fine deformation — those still classify into the
// same slot but sit deeper in the hierarchy, so picking the deepest bone
// here would grab a barely-visible corrective joint instead of the actual
// hand/foot, making a click-and-drag look like it does nothing. For centreline
// regions (torso/head/hips), a bone whose own name carries a left/right side
// marker (e.g. "R_Chest_01_Jnt") is *always* a corrective, even if it matches
// a slot no unsided bone also matches (some rigs have only sided "chest"
// correctives and no single unsided chest joint at all) — so for those
// regions, being unsided is checked before slot priority, not just as a
// tie-break after it, and a lower-priority unsided slot (e.g. "spine") wins
// over a higher-priority sided one (e.g. "chest").
function computeRegionControls() {
  const controls = new Map()
  for (const def of REGION_DEFS) {
    const centreline = CENTRELINE_REGIONS.has(def.key)
    let best = null
    let bestSidePenalty = 1
    let bestPriority = -1
    let bestChildCount = -1
    let bestDepth = Infinity
    for (const bone of p.bones) {
      if (p.boneRegionMap.get(bone) !== def.key) continue
      const slot = classifyBone(bone.name)
      const idx = slot ? def.control.indexOf(slot) : -1
      const priority = idx === -1 ? -1 : def.control.length - idx
      const sidePenalty = centreline && detectSide(bone.name.toLowerCase()) ? 1 : 0
      const depth = boneChainDepth(bone)
      const childCount = def.hub ? boneChildBoneCount(bone) : 0
      const better =
        sidePenalty < bestSidePenalty ||
        (sidePenalty === bestSidePenalty &&
          (priority > bestPriority ||
            (priority === bestPriority &&
              (def.hub
                ? childCount > bestChildCount || (childCount === bestChildCount && depth < bestDepth)
                : depth < bestDepth))))
      if (better) {
        best = bone
        bestSidePenalty = sidePenalty
        bestPriority = priority
        bestChildCount = childCount
        bestDepth = depth
      }
    }
    if (best) controls.set(def.key, best.name)
  }
  return controls
}

// Tear down the region overlay meshes/materials (model unload or rebuild).
function disposePartOverlays() {
  for (const { mesh } of p.partMeshes) {
    if (mesh.parent) mesh.parent.remove(mesh)
    mesh.geometry.dispose()
  }
  p.partMeshes = []
  for (const mat of p.partMaterials.values()) mat.dispose()
  p.partMaterials = new Map()
  p.regionControl = new Map()
}

// Build the clickable, tinted body-part overlay: one transparent SkinnedMesh
// per (source mesh, region) pair, sharing the source mesh's geometry
// attributes and skeleton so it deforms identically — just with an index
// buffer trimmed to the triangles whose dominant bone falls in that region.
function buildPartOverlays(model) {
  disposePartOverlays()
  const meshes = model.skinnedMeshes || []
  if (!meshes.length || p.bones.length === 0) return

  for (const def of REGION_DEFS) {
    p.partMaterials.set(
      def.key,
      new THREE.MeshBasicMaterial({
        color: def.color,
        transparent: true,
        opacity: PART_OPACITY.idle,
        depthTest: false, // always draw over the character mesh (matches the bone-dot overlay's
        depthWrite: false, // convention) — avoids z-fighting since this sits exactly on the surface
        side: THREE.DoubleSide,
      }),
    )
  }

  for (const mesh of meshes) {
    const geom = mesh.geometry
    const posAttr = geom.getAttribute('position')
    const normalAttr = geom.getAttribute('normal')
    const skinIdx = geom.getAttribute('skinIndex')
    const skinWt = geom.getAttribute('skinWeight')
    if (!posAttr || !skinIdx || !skinWt || !mesh.skeleton) continue
    const bones = mesh.skeleton.bones

    // Dominant (highest-weight) bone's region per vertex.
    const vertexRegion = new Array(posAttr.count)
    for (let i = 0; i < posAttr.count; i++) {
      let bestW = -1
      let bestBoneIdx = 0
      for (let k = 0; k < 4; k++) {
        const w = skinWt.getComponent(i, k)
        if (w > bestW) {
          bestW = w
          bestBoneIdx = skinIdx.getComponent(i, k)
        }
      }
      const bone = bones[bestBoneIdx]
      vertexRegion[i] = bone ? resolveBoneRegion(bone) : null
    }

    // Group triangles by region (majority vote of their 3 verts).
    const indexAttr = geom.getIndex()
    const triCount = indexAttr ? indexAttr.count / 3 : Math.floor(posAttr.count / 3)
    const regionIndices = new Map() // region key -> number[]
    for (let t = 0; t < triCount; t++) {
      let a, b, c
      if (indexAttr) {
        a = indexAttr.getX(t * 3)
        b = indexAttr.getX(t * 3 + 1)
        c = indexAttr.getX(t * 3 + 2)
      } else {
        a = t * 3
        b = t * 3 + 1
        c = t * 3 + 2
      }
      const ra = vertexRegion[a]
      const rb = vertexRegion[b]
      const rc = vertexRegion[c]
      let region = ra
      if (rb && rb === rc && rb !== ra) region = rb
      if (!region) region = ra || rb || rc
      if (!region) continue
      if (!regionIndices.has(region)) regionIndices.set(region, [])
      regionIndices.get(region).push(a, b, c)
    }

    for (const [regionKey, idxArr] of regionIndices) {
      const mat = p.partMaterials.get(regionKey)
      if (!mat || idxArr.length === 0) continue

      const overlayGeom = new THREE.BufferGeometry()
      overlayGeom.setAttribute('position', posAttr)
      if (normalAttr) overlayGeom.setAttribute('normal', normalAttr)
      overlayGeom.setAttribute('skinIndex', skinIdx)
      overlayGeom.setAttribute('skinWeight', skinWt)
      const IndexArray = posAttr.count > 65535 ? Uint32Array : Uint16Array
      overlayGeom.setIndex(new THREE.BufferAttribute(new IndexArray(idxArr), 1))

      const overlay = new THREE.SkinnedMesh(overlayGeom, mat)
      overlay.name = `(part overlay: ${regionKey})`
      overlay.frustumCulled = false
      overlay.renderOrder = 500 // above the character mesh, below the bone dots
      // Copy the mesh's LOCAL MATRIX directly rather than position/quaternion/
      // scale: meshes produced by the decimation/optimization pipeline can have
      // matrixAutoUpdate=false with a matrix baked directly (no synced
      // position/quaternion/scale), which silently left the overlay sitting at
      // identity transform — invisible and unpickable — while looking like it
      // "just didn't highlight". Decompose back into position/quaternion/scale
      // too so debugging tools that read those still see the right values.
      overlay.matrixAutoUpdate = false
      overlay.matrix.copy(mesh.matrix)
      overlay.matrix.decompose(overlay.position, overlay.quaternion, overlay.scale)
      overlay.bind(mesh.skeleton, mesh.bindMatrix)
      overlay.userData.outlineParameters = { visible: false } // never outline the highlight overlay
      mesh.parent.add(overlay)
      p.partMeshes.push({ region: regionKey, mesh: overlay })
    }
  }

  p.regionControl = computeRegionControls()
  if (p.partMeshes.length === 0) {
    console.warn(
      '[posing] Body Parts view: no regions could be built for this model — its bone names may not ' +
        'match any recognised naming convention (Mixamo/Rigify/CMU/etc.), or its mesh has no skinning ' +
        'weights. The classic Bones (dot) view is unaffected.',
    )
  }
  applyOverlayVisibility()
  updatePartMaterials()
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