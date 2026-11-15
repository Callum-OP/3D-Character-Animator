import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { useStore } from '../store.js'
import { pushSceneHistory } from './sceneHistory.js'
import { getHistorySequence, getHistoryEpoch } from './undoHistory.js'
import { registerFollower, unregisterFollower, reparentKeepingWorld } from './attach.js'
import { getObjectRootById } from './objects.js'
import { classifyBone } from './bvh.js'

// ---------------------------------------------------------------------------
// IK pins
//
// An IK pin holds a limb's tip bone (a hand, a foot, any bone) on a MARKER while the
// animation keeps playing. The marker is either fixed in the world or attached to a
// scene object (it is re-parented under that object's root, so it follows every move,
// rotation and resize of the object, including the object's own animation).
//
// Each rendered frame — after the animation mixer and the object animation have run —
// every enabled pin re-solves its limb toward the marker's current world position:
//   * a two-bone chain (shoulder-elbow-wrist, hip-knee-ankle: the default) uses the
//     analytic two-bone solution and keeps the bend direction the animation had, so an
//     elbow or knee keeps pointing the way the animator meant;
//   * longer or shorter chains use CCD (the same idea as the Move gizmo's IK).
// The animated pose is the starting point every frame, so the animation still drives
// everything the pin does not touch. A pin's "weight" blends between the animated pose
// (0) and the fully pinned pose (1). A target out of reach leaves the limb fully
// extended toward it (nothing stretches).
//
// The pin settings live in the store (per character, saved with the project); this
// module owns the markers, the solver and the undo steps.
// ---------------------------------------------------------------------------

const MAX_CHAIN = 6
const CCD_ITERATIONS = 14
const COALESCE_MS = 800

const k = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  requestRender: () => {},
  getSceneScale: () => 1,
  transform: null,
  helper: null,
  selected: null, // the selected entry (its marker carries the gizmo)
  visible: true,
  gizmoMode: 'translate',
  gizmoGrabbed: false,
}

// characterId -> { model, enabled, entries: Map<pinId, entry> }
// entry = { pinId, characterId, marker, visual, cfg, objectId, follower, tip, chain, base, out, pole }
const runtimes = new Map()

const _ndc = new THREE.Vector2()
const _ray = new THREE.Raycaster()
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()

export function initIk(refs) {
  k.scene = refs.scene
  k.camera = refs.camera
  k.renderer = refs.renderer
  k.controls = refs.controls
  k.requestRender = refs.requestRender || (() => {})
  k.getSceneScale = refs.getSceneScale || (() => 1)

  const transform = new TransformControls(k.camera, k.renderer.domElement)
  transform.setMode('translate')
  transform.setSize(0.8)
  transform.addEventListener('dragging-changed', (e) => {
    k.controls.enabled = !e.value && !k.controls.locked
    if (e.value) k.gizmoGrabbed = true
    else commitMarkerDrag()
  })
  transform.addEventListener('objectChange', () => k.requestRender())
  k.transform = transform
  k.helper = transform.getHelper()
  k.helper.traverse((o) => {
    if (o.material) o.material.userData.outlineParameters = { visible: false }
  })
  k.scene.add(k.helper)
}

export function disposeIk() {
  for (const id of [...runtimes.keys()]) clearIk(id)
  if (k.helper && k.scene) k.scene.remove(k.helper)
  if (k.transform) k.transform.dispose()
  k.transform = null
  k.helper = null
  k.selected = null
}

// ---------------------------------------------------------------------------
// Pin data
// ---------------------------------------------------------------------------

const clone = (v) => JSON.parse(JSON.stringify(v))

export function newPinId() {
  return `ik_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
}

function readPins(characterId) {
  const s = useStore.getState()
  if (s.activeCharacterId === characterId) return s.ikPins || []
  return s.characters[characterId]?.ikPins || []
}

function readEnabled(characterId) {
  const s = useStore.getState()
  if (s.activeCharacterId === characterId) return s.ikEnabled !== false
  return s.characters[characterId]?.ikEnabled !== false
}

// Write a character's pin list into the store (the live fields when it is the active
// character, its roster entry otherwise).
export function writePins(characterId, pins) {
  useStore.setState((s) => {
    if (s.activeCharacterId === characterId) return { ikPins: pins }
    const c = s.characters[characterId]
    if (!c) return {}
    return { characters: { ...s.characters, [characterId]: { ...c, ikPins: pins } } }
  })
}

function syncCharacter(characterId) {
  const rt = runtimes.get(characterId)
  if (!rt) return
  setIkConfig(characterId, rt.model, readEnabled(characterId), readPins(characterId))
}

let last = null

// Change a character's pins and record ONE undo step. `mutate` gets a copy of the list and
// returns the new list. Edits with the same `key` in quick succession (a slider drag) merge.
export function editPins(characterId, mutate, { key = null, record = true } = {}) {
  const before = clone(readPins(characterId))
  const next = mutate(clone(before))
  if (!next) return
  if (JSON.stringify(before) === JSON.stringify(next)) return
  writePins(characterId, next)
  syncCharacter(characterId)
  if (!record) return

  const now = Date.now()
  if (
    key &&
    last &&
    last.key === key &&
    last.characterId === characterId &&
    last.epoch === getHistoryEpoch() &&
    last.seq === getHistorySequence() &&
    now - last.time < COALESCE_MS
  ) {
    last.after = clone(next)
    last.time = now
    return
  }
  const rec = { key, characterId, before, after: clone(next), time: now, seq: 0, epoch: getHistoryEpoch() }
  pushSceneHistory(
    () => {
      writePins(characterId, clone(rec.before))
      syncCharacter(characterId)
    },
    () => {
      writePins(characterId, clone(rec.after))
      syncCharacter(characterId)
    },
  )
  rec.seq = getHistorySequence()
  last = rec
}

// Edit one pin by id (merging `patch` into it).
export function updateIkPin(pinId, patch, { key = null } = {}) {
  const e = findEntry(pinId)
  if (!e) return
  editPins(e.characterId, (pins) => pins.map((p) => (p.id === pinId ? { ...p, ...patch } : p)), { key: key || (`${pinId}:${Object.keys(patch).join(',')}`) })
}

function findBone(model, name) {
  if (!model || !name) return null
  const fromList = (model.bones || []).find((b) => b.name === name)
  if (fromList) return fromList
  const found = model.root ? model.root.getObjectByName(name) : null
  return found && found.isBone ? found : null
}

function defaultChainLength() {
  return 2
}

// Add a pin on `boneName` of the active character. The marker starts exactly where the
// bone is now (and with its orientation), so nothing moves until the marker does.
export function addIkPin(boneName, { characterId = useStore.getState().activeCharacterId } = {}) {
  const rt = runtimes.get(characterId)
  const bone = rt ? findBone(rt.model, boneName) : null
  if (!bone) return null
  bone.updateWorldMatrix(true, false)
  bone.matrixWorld.decompose(_p, _q, _s)
  const pin = {
    id: newPinId(),
    name: boneName,
    boneName,
    chainLength: defaultChainLength(boneName),
    enabled: true,
    weight: 1,
    matchRotation: false,
    attachObjectId: null,
    position: _p.toArray(),
    quaternion: _q.toArray(),
  }
  editPins(characterId, (pins) => [...pins, pin])
  useStore.getState().setSelectedIkPinId(pin.id)
  return pin
}

export function removeIkPin(pinId) {
  const e = findEntry(pinId)
  if (!e) return
  editPins(e.characterId, (pins) => pins.filter((p) => p.id !== pinId))
  if (useStore.getState().selectedIkPinId === pinId) useStore.getState().setSelectedIkPinId(null)
}

// Put the marker on the bone's CURRENT position / orientation (a "grab where it is now").
export function snapIkMarkerToBone(pinId) {
  const e = findEntry(pinId)
  const rt = e && runtimes.get(e.characterId)
  const bone = e && rt ? findBone(rt.model, e.cfg.boneName) : null
  if (!bone) return
  bone.updateWorldMatrix(true, false)
  bone.matrixWorld.decompose(_p, _q, _s)
  const world = { position: _p.clone(), quaternion: _q.clone() }
  editPins(e.characterId, (pins) =>
    pins.map((p) => {
      if (p.id !== pinId) return p
      if (e.objectId != null && e.marker.parent) {
        // an attached marker stores its transform relative to the object
        const local = worldToLocal(e.marker.parent, world.position, world.quaternion)
        return { ...p, position: local.position, quaternion: local.quaternion }
      }
      return { ...p, position: world.position.toArray(), quaternion: world.quaternion.toArray() }
    }),
  )
}

const _m1 = new THREE.Matrix4()
const _m2 = new THREE.Matrix4()
function worldToLocal(parent, position, quaternion) {
  parent.updateWorldMatrix(true, false)
  _m1.compose(position, quaternion, new THREE.Vector3(1, 1, 1))
  _m2.copy(parent.matrixWorld).invert()
  _m1.premultiply(_m2)
  const lp = new THREE.Vector3()
  const lq = new THREE.Quaternion()
  _m1.decompose(lp, lq, new THREE.Vector3())
  return { position: lp.toArray(), quaternion: lq.toArray() }
}

// Attach the marker to a scene object (objectId) — or back into the world (null). The marker
// stays exactly where it is in the world at the moment of switching.
export function attachIkMarker(pinId, objectId) {
  const e = findEntry(pinId)
  if (!e) return
  const target = objectId == null ? null : objectId
  if (target === (e.cfg.attachObjectId ?? null)) return
  const root = target != null ? getObjectRootById(target) : null
  if (target != null && !root) return

  e.marker.updateWorldMatrix(true, false)
  e.marker.matrixWorld.decompose(_p, _q, _s)
  const wp = _p.clone()
  const wq = _q.clone()
  editPins(e.characterId, (pins) =>
    pins.map((p) => {
      if (p.id !== pinId) return p
      if (!root) return { ...p, attachObjectId: null, position: wp.toArray(), quaternion: wq.toArray() }
      const local = worldToLocal(root, wp, wq)
      return { ...p, attachObjectId: target, position: local.position, quaternion: local.quaternion }
    }),
  )
}

// ---------------------------------------------------------------------------
// Runtime: markers
// ---------------------------------------------------------------------------

function findEntry(pinId) {
  for (const rt of runtimes.values()) {
    const e = rt.entries.get(pinId)
    if (e) return e
  }
  return null
}

export function getIkEntry(pinId) {
  return findEntry(pinId)
}

function markerSize() {
  return Math.max(0.01, (k.getSceneScale() || 1) * 0.03)
}

function makeVisual(size) {
  const group = new THREE.Group()
  const mat = new THREE.MeshBasicMaterial({ color: 0xffa13a, transparent: true, opacity: 0.92, depthTest: false })
  const ball = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 12), mat)
  ball.renderOrder = 999
  ball.userData.isIkMarker = true
  group.add(ball)
  // three short axes so a rotated marker reads as an orientation
  const axisMat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false })
  const len = size * 2.6
  const geo = new THREE.BufferGeometry()
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, len, 0, 0, 0, 0, 0, 0, len, 0, 0, 0, 0, 0, 0, len], 3),
  )
  geo.setAttribute(
    'color',
    new THREE.Float32BufferAttribute([1, 0.2, 0.2, 1, 0.2, 0.2, 0.2, 1, 0.2, 0.2, 1, 0.2, 0.3, 0.5, 1, 0.3, 0.5, 1], 3),
  )
  const axes = new THREE.LineSegments(geo, axisMat)
  axes.renderOrder = 999
  group.add(axes)
  group.traverse((o) => {
    if (o.material) o.material.userData.outlineParameters = { visible: false }
  })
  return { group, ball, mat }
}

function createEntry(rt, characterId, pin) {
  const marker = new THREE.Group()
  marker.name = `ik-marker ${pin.name || pin.boneName}`
  const { group, ball, mat } = makeVisual(markerSize())
  marker.add(group)
  marker.userData.isIkMarkerRoot = true
  k.scene.add(marker)
  const entry = {
    pinId: pin.id,
    characterId,
    marker,
    visual: group,
    ball,
    mat,
    cfg: pin,
    objectId: null,
    follower: null,
    pending: false,
    tip: null,
    tipModel: null,
    chain: null,
    chainKey: '',
    base: null,
    out: null,
    pole: null,
  }
  rt.entries.set(pin.id, entry)
  return entry
}

function removeEntry(rt, e) {
  if (k.selected === e) {
    k.selected = null
    if (k.transform) k.transform.detach()
  }
  if (e.follower) unregisterFollower(e.follower)
  if (e.marker.parent) e.marker.parent.remove(e.marker)
  e.visual.traverse((o) => {
    if (o.geometry) o.geometry.dispose()
    if (o.material) o.material.dispose()
  })
  rt.entries.delete(e.pinId)
}

// The object this marker rides on was deleted: keep the marker where it is in the world.
function releaseAttached(e) {
  if (!e.follower) return
  e.marker.updateWorldMatrix(true, false)
  e.marker.matrixWorld.decompose(_p, _q, _s)
  const wp = _p.toArray()
  const wq = _q.toArray()
  unregisterFollower(e.follower)
  e.follower = null
  e.objectId = null
  k.scene.add(e.marker)
  e.marker.position.fromArray(wp)
  e.marker.quaternion.fromArray(wq)
  e.marker.scale.set(1, 1, 1)
  const pinId = e.pinId
  writePins(
    e.characterId,
    readPins(e.characterId).map((p) => (p.id === pinId ? { ...p, attachObjectId: null, position: wp, quaternion: wq } : p)),
  )
  syncCharacter(e.characterId)
}

function lookOf(e) {
  const slot = classifyBone(e.cfg.boneName || '') || ''
  const role = slot.split('.')[0]
  if (!e.cfg.enabled) return 0x8a8f99
  if (k.selected === e) return 0xffffff
  if (role === 'hand') return 0xffa13a
  if (role === 'foot') return 0x4fd37a
  return 0x4f8cff
}

function applyLook(e) {
  e.visual.visible = k.selected === e
  e.mat.color.setHex(lookOf(e))
  e.mat.opacity = e.cfg.enabled ? 0.92 : 0.55
}

function syncEntry(e) {
  const want = e.cfg.attachObjectId ?? null
  if (want !== e.objectId) {
    if (e.follower) {
      unregisterFollower(e.follower)
      e.follower = null
    }
    e.objectId = null
    k.scene.add(e.marker)
    if (want != null) {
      const root = getObjectRootById(want)
      if (root) {
        root.add(e.marker)
        e.objectId = want
        // releaseFollowersOf(root) looks at follower.mount.parent: the marker itself is the child.
        e.follower = { mount: e.marker, release: () => releaseAttached(e) }
        registerFollower(e.follower)
      }
    }
  }
  e.pending = want != null && e.objectId == null
  if (!e.pending && !(k.gizmoGrabbed && k.selected === e && isDragging())) {
    e.marker.position.fromArray(e.cfg.position || [0, 0, 0])
    e.marker.quaternion.fromArray(e.cfg.quaternion || [0, 0, 0, 1])
  }
  e.marker.visible = k.visible && !e.pending
  applyLook(e)
}

function isDragging() {
  return !!(k.transform && k.transform.dragging)
}

// Reconcile one character's markers with its saved pin list. Safe to call any time.
export function setIkConfig(characterId, model, enabled, pins) {
  if (!characterId || !model || !k.scene) return
  let rt = runtimes.get(characterId)
  if (!rt) {
    rt = { model, enabled: !!enabled, entries: new Map() }
    runtimes.set(characterId, rt)
  }
  if (rt.model !== model) {
    for (const e of rt.entries.values()) {
      e.tip = null
      e.base = e.out = null
    }
  }
  rt.model = model
  rt.enabled = enabled !== false
  const list = Array.isArray(pins) ? pins : []
  const wanted = new Set(list.map((p) => p.id))
  for (const e of [...rt.entries.values()]) if (!wanted.has(e.pinId)) removeEntry(rt, e)
  for (const pin of list) {
    const e = rt.entries.get(pin.id) || createEntry(rt, characterId, pin)
    e.cfg = pin
    syncEntry(e)
  }
  if (k.selected && !k.selected.marker.parent) k.selected = null
  refreshGizmo()
  k.requestRender()
}

export function clearIk(characterId) {
  const rt = runtimes.get(characterId)
  if (!rt) return
  for (const e of [...rt.entries.values()]) removeEntry(rt, e)
  runtimes.delete(characterId)
  refreshGizmo()
}

export function setIkEnabledFor(characterId, enabled) {
  const rt = runtimes.get(characterId)
  if (rt) rt.enabled = !!enabled
  k.requestRender()
}

// ---------------------------------------------------------------------------
// Runtime: selection, gizmo, picking
// ---------------------------------------------------------------------------

function refreshGizmo() {
  if (!k.transform) return
  if (k.selected && k.visible && k.selected.marker.parent) k.transform.attach(k.selected.marker)
  else k.transform.detach()
}

export function selectIkPin(pinId) {
  const prev = k.selected
  k.selected = pinId ? findEntry(pinId) : null
  if (prev && prev !== k.selected) applyLook(prev)
  if (k.selected) applyLook(k.selected)
  refreshGizmo()
  k.requestRender()
}

export function setIkMarkersVisible(visible) {
  k.visible = !!visible
  for (const rt of runtimes.values()) for (const e of rt.entries.values()) e.marker.visible = k.visible && !e.pending
  refreshGizmo()
  k.requestRender()
}

export function setIkGizmoMode(mode) {
  k.gizmoMode = mode === 'rotate' ? 'rotate' : 'translate'
  if (k.transform) k.transform.setMode(k.gizmoMode)
  k.requestRender()
}

export function consumeIkGizmoGrab() {
  const grabbed = k.gizmoGrabbed
  k.gizmoGrabbed = false
  return grabbed
}

// The pin whose marker is under the pointer (normalised device coordinates), or null.
export function pickIkMarker(ndcX, ndcY) {
  if (!k.visible || !k.camera) return null
  _ndc.set(ndcX, ndcY)
  _ray.setFromCamera(_ndc, k.camera)
  let best = null
  let bestDist = Infinity
  for (const rt of runtimes.values()) {
    for (const e of rt.entries.values()) {
      if (!e.marker.visible) continue
      e.marker.updateWorldMatrix(true, false)
      e.ball.getWorldPosition(_p)
      const radius = markerSize() * 1.6
      const hit = _ray.ray.distanceSqToPoint(_p)
      if (hit <= radius * radius) {
        const d = _p.distanceToSquared(_ray.ray.origin)
        if (d < bestDist) {
          best = e
          bestDist = d
        }
      }
    }
  }
  return best ? best.pinId : null
}

// A gizmo drag ended: store the marker's new transform (one undo step).
function commitMarkerDrag() {
  const e = k.selected
  if (!e) return
  const position = e.marker.position.toArray()
  const quaternion = e.marker.quaternion.toArray()
  editPins(e.characterId, (pins) => pins.map((p) => (p.id === e.pinId ? { ...p, position, quaternion } : p)))
}

// ---------------------------------------------------------------------------
// The solver
// ---------------------------------------------------------------------------

const _A = new THREE.Vector3()
const _B = new THREE.Vector3()
const _C = new THREE.Vector3()
const _T = new THREE.Vector3()
const _u = new THREE.Vector3()
const _bend = new THREE.Vector3()
const _dirAC = new THREE.Vector3()
const _from = new THREE.Vector3()
const _to = new THREE.Vector3()
const _Bn = new THREE.Vector3()
const _Tc = new THREE.Vector3()
const _dq = new THREE.Quaternion()
const _wq = new THREE.Quaternion()
const _pq = new THREE.Quaternion()
const _nq = new THREE.Quaternion()

// Rotate `joint` about its own origin so the world direction `from` becomes `to`.
function swing(joint, from, to) {
  if (from.lengthSq() < 1e-14 || to.lengthSq() < 1e-14) return
  _dq.setFromUnitVectors(from, to)
  joint.getWorldQuaternion(_wq)
  _nq.copy(_dq).multiply(_wq)
  if (joint.parent) joint.parent.getWorldQuaternion(_pq)
  else _pq.identity()
  joint.quaternion.copy(_pq.invert().multiply(_nq))
  joint.updateWorldMatrix(false, true)
}

// Analytic two-bone solve. root -> mid -> tip (a shoulder, elbow and wrist). `hint` is the
// preferred bend direction when the animated limb is perfectly straight.
export function solveTwoBone(root, mid, tip, target, state) {
  root.getWorldPosition(_A)
  mid.getWorldPosition(_B)
  tip.getWorldPosition(_C)
  const l1 = _A.distanceTo(_B)
  const l2 = _B.distanceTo(_C)
  if (l1 < 1e-7 || l2 < 1e-7) return

  // Which way the animated elbow/knee points: its offset from the shoulder-wrist line.
  _dirAC.copy(_C).sub(_A)
  const acLen = _dirAC.length()
  if (acLen > 1e-7) _dirAC.multiplyScalar(1 / acLen)
  _bend.copy(_B).sub(_A)
  _bend.addScaledVector(_dirAC, -_bend.dot(_dirAC))
  if (_bend.length() > l1 * 1e-3) {
    _bend.normalize()
    if (state) state.pole = (state.pole || new THREE.Vector3()).copy(_bend)
  } else if (state && state.pole) {
    _bend.copy(state.pole)
  } else if (state && state.hint) {
    _bend.copy(state.hint)
  } else {
    _bend.set(0, 0, 1)
  }

  _T.copy(target)
  _u.copy(_T).sub(_A)
  const dist = _u.length()
  if (dist < 1e-8) return
  _u.multiplyScalar(1 / dist)
  const reach = Math.min(Math.max(dist, Math.abs(l1 - l2) + 1e-5), l1 + l2 - 1e-5)
  const a = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach)
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a))

  // bend direction made perpendicular to the new reach axis
  _bend.addScaledVector(_u, -_bend.dot(_u))
  if (_bend.lengthSq() < 1e-10) {
    _bend.set(Math.abs(_u.y) < 0.9 ? 0 : 1, Math.abs(_u.y) < 0.9 ? 1 : 0, 0)
    _bend.addScaledVector(_u, -_bend.dot(_u))
  }
  _bend.normalize()

  _Bn.copy(_A).addScaledVector(_u, a).addScaledVector(_bend, h)
  _from.copy(_B).sub(_A).normalize()
  _to.copy(_Bn).sub(_A).normalize()
  swing(root, _from, _to)

  mid.getWorldPosition(_B)
  tip.getWorldPosition(_C)
  _Tc.copy(_A).addScaledVector(_u, reach)
  _from.copy(_C).sub(_B).normalize()
  _to.copy(_Tc).sub(_B).normalize()
  swing(mid, _from, _to)
}

// CCD over `joints` (nearest the tip first): swing each so the tip heads for the target.
export function solveCcd(joints, tip, target) {
  for (let iter = 0; iter < CCD_ITERATIONS; iter++) {
    for (const joint of joints) {
      tip.getWorldPosition(_C)
      joint.getWorldPosition(_A)
      _from.copy(_C).sub(_A)
      _to.copy(target).sub(_A)
      if (_from.lengthSq() < 1e-12 || _to.lengthSq() < 1e-12) continue
      swing(joint, _from.normalize(), _to.normalize())
    }
    tip.getWorldPosition(_C)
    if (_C.distanceToSquared(target) < 1e-10) break
  }
}

function chainOf(tip, length) {
  const joints = []
  let b = tip.parent
  while (b && b.isBone && joints.length < Math.min(MAX_CHAIN, Math.max(1, length | 0))) {
    joints.push(b)
    b = b.parent
  }
  return joints
}

const _tq = new THREE.Quaternion()
const _tp = new THREE.Vector3()
const _ts = new THREE.Vector3()
const _fwd = new THREE.Vector3()

const near = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) + Math.abs(a.w - b.w) < 1e-6

function solveEntry(e, rt) {
  const cfg = e.cfg
  if (!cfg.enabled || !(cfg.weight > 0) || e.pending) {
    e.base = e.out = null
    return
  }
  if (!e.tip || e.tipModel !== rt.model || e.tip.name !== cfg.boneName) {
    e.tip = findBone(rt.model, cfg.boneName)
    e.tipModel = rt.model
    e.chainKey = ''
  }
  const tip = e.tip
  if (!tip) return
  const key = `${tip.uuid}:${cfg.chainLength}`
  if (key !== e.chainKey) {
    e.chain = chainOf(tip, cfg.chainLength)
    e.chainKey = key
    e.base = e.out = null
  }
  const chain = e.chain
  if (!chain.length) return

  // Where the marker is now (it may ride on a moving object).
  e.marker.updateWorldMatrix(true, false)
  e.marker.matrixWorld.decompose(_tp, _tq, _ts)
  const avg = (Math.abs(_ts.x) + Math.abs(_ts.y) + Math.abs(_ts.z)) / 3 || 1
  if (Math.abs(avg - 1) > 1e-4 || Math.abs(e.visual.scale.x * avg - 1) > 1e-3) e.visual.scale.setScalar(1 / avg)

  const tracked = [...chain, tip]
  // The animated pose is the starting point. If nothing but this solver has touched the
  // joints since last time (the animation is paused), start again from what the animation
  // gave us rather than from our own result, so a part-weight pin does not creep to full.
  const untouched = e.out && e.out.length === tracked.length && tracked.every((j, i) => near(j.quaternion, e.out[i]))
  if (untouched) {
    tracked.forEach((j, i) => j.quaternion.copy(e.base[i]))
  } else {
    e.base = tracked.map((j) => j.quaternion.clone())
  }
  const top = chain[chain.length - 1]
  top.updateWorldMatrix(true, true)

  if (chain.length === 2) {
    if (!e.hint) e.hint = new THREE.Vector3()
    const role = (classifyBone(cfg.boneName || '') || '').split('.')[0]
    const sign = role === 'hand' ? -1 : 1 // knees bend forward, elbows back
    rt.model.root.getWorldQuaternion(_wq)
    _fwd.set(0, 0, 1).applyQuaternion(_wq)
    e.hint.copy(_fwd).multiplyScalar(sign)
    solveTwoBone(chain[1], chain[0], tip, _tp, e)
  } else {
    solveCcd(chain, tip, _tp)
  }

  const w = Math.min(1, cfg.weight)
  if (w < 1) {
    chain.forEach((j, i) => {
      _nq.copy(j.quaternion)
      j.quaternion.copy(e.base[i]).slerp(_nq, w)
    })
    top.updateWorldMatrix(true, true)
  }

  tracked[tracked.length - 1].quaternion.copy(e.base[tracked.length - 1])
  if (cfg.matchRotation) {
    // turn the tip toward the marker's orientation (blended by the weight)
    tip.updateWorldMatrix(true, false)
    tip.getWorldQuaternion(_wq)
    _nq.copy(_wq).slerp(_tq, w)
    if (tip.parent) tip.parent.getWorldQuaternion(_pq)
    else _pq.identity()
    tip.quaternion.copy(_pq.invert().multiply(_nq))
  }
  tip.updateWorldMatrix(false, true)
  e.out = tracked.map((j) => j.quaternion.clone())
}

// Called once per rendered frame, after the animation and object animation have run.
export function stepIkPins() {
  if (!runtimes.size) return
  for (const rt of runtimes.values()) {
    if (!rt.enabled || !rt.entries.size) continue
    for (const e of rt.entries.values()) solveEntry(e, rt)
  }
}

export function hasActiveIkPins() {
  for (const rt of runtimes.values()) {
    if (!rt.enabled) continue
    for (const e of rt.entries.values()) if (e.cfg.enabled && e.cfg.weight > 0) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Lock in place
//
// A one-step way to use the pins: take a bone's position AND rotation in the pose on screen and hold it there for
// the whole animation (feet that stop sliding or floating, a hand that stays on a rail). Each lock is an ordinary
// pin (marker fixed in the world, rotation matched, full strength) flagged `lock: true`, so it saves with the project,
// shows in the IK pins list, goes through undo/redo and plays back like any other pin.
// ---------------------------------------------------------------------------

export const isLockPin = (pin) => !!(pin && pin.lock)

// Fingers and toes hinge on one parent joint; everything else (feet, hands, any other bone) uses the two-bone limb.
function lockChainLength(boneName) {
  const slot = classifyBone(boneName || '') || ''
  const role = slot.split('.')[0]
  if (role === 'toe') return 1
  if (!role && /thumb|index|middle|ring|pinky|little|finger/i.test(boneName || '')) return 1
  return 2
}

// Bone names for a limb role ('foot' | 'hand') of the active character: the rig's first bone in each left/right slot.
export function limbBoneNames(role) {
  const bones = useStore.getState().modelInfo?.bones || []
  const seen = {}
  for (const b of bones) {
    const slot = classifyBone(b.name)
    if (slot && slot.split('.')[0] === role && !seen[slot]) seen[slot] = b.name
  }
  return Object.values(seen)
}

// Lock the named bones where they are now. Bones that already have a lock are re-locked to the current pose.
// One undo step. Returns { locked, relocked, missing }.
export function lockBonesInPlace(boneNames, { characterId = useStore.getState().activeCharacterId, rotation = true } = {}) {
  const result = { locked: 0, relocked: 0, missing: [] }
  const rt = runtimes.get(characterId)
  if (!rt) return { ...result, missing: [...new Set(boneNames || [])] }
  const poses = new Map()
  for (const name of new Set(boneNames || [])) {
    const bone = findBone(rt.model, name)
    if (!bone) { result.missing.push(name); continue }
    bone.updateWorldMatrix(true, false)
    bone.matrixWorld.decompose(_p, _q, _s)
    poses.set(name, { position: _p.toArray(), quaternion: _q.toArray() })
  }
  if (!poses.size) return result
  if (useStore.getState().ikEnabled === false) useStore.getState().setIkEnabled(true)
  editPins(characterId, (pins) => {
    const next = [...pins]
    for (const [name, pose] of poses) {
      const i = next.findIndex((p) => p.boneName === name)
      if (i >= 0) {
        // keep the pin's own settings, but it is now a world-space, full-strength lock at this pose
        next[i] = { ...next[i], enabled: true, weight: 1, lock: true, matchRotation: rotation, attachObjectId: null, ...pose }
        result.relocked++
      } else {
        next.push({
          id: newPinId(),
          name: `Lock · ${name}`,
          boneName: name,
          chainLength: lockChainLength(name),
          enabled: true,
          weight: 1,
          matchRotation: rotation,
          attachObjectId: null,
          lock: true,
          ...pose,
        })
        result.locked++
      }
    }
    return next
  })
  return result
}

// Remove the locks on these bones (other kinds of pin are left alone). One undo step.
export function unlockBones(boneNames, { characterId = useStore.getState().activeCharacterId } = {}) {
  const names = new Set(boneNames || [])
  const before = readPins(characterId).filter((p) => isLockPin(p) && names.has(p.boneName)).length
  if (!before) return 0
  editPins(characterId, (pins) => pins.filter((p) => !(isLockPin(p) && names.has(p.boneName))))
  return before
}

export function unlockAll({ characterId = useStore.getState().activeCharacterId } = {}) {
  const names = readPins(characterId).filter(isLockPin).map((p) => p.boneName)
  return unlockBones(names, { characterId })
}

// ---------------------------------------------------------------------------
// Baking for exports
//
// Saved clips and exported BVH are sampled offline (animation.js), without the live render loop. These let it apply the
// pins whose markers are fixed in the world (locks, and any pin not attached to a moving object) to the pose it has
// just set, exactly as the viewport would, and ask which bones that touches.
// ---------------------------------------------------------------------------

function fixedEntriesFor(model) {
  const out = []
  for (const rt of runtimes.values()) {
    if (rt.model !== model || !rt.enabled) continue
    for (const e of rt.entries.values()) {
      if (e.cfg.enabled && e.cfg.weight > 0 && (e.cfg.attachObjectId ?? null) == null) out.push([e, rt])
    }
  }
  return out
}

export function hasFixedPinsForModel(model) {
  return fixedEntriesFor(model).length > 0
}

export function applyFixedPinsForModel(model) {
  for (const [e, rt] of fixedEntriesFor(model)) solveEntry(e, rt)
}

export function fixedPinBonesForModel(model) {
  const names = new Set()
  for (const [e, rt] of fixedEntriesFor(model)) {
    const tip = findBone(rt.model, e.cfg.boneName)
    if (!tip) continue
    names.add(tip.name)
    for (const j of chainOf(tip, e.cfg.chainLength)) names.add(j.name)
  }
  return names
}
