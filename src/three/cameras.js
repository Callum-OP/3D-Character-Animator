import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { pushSceneHistory } from './sceneHistory.js'
import { useStore } from '../store.js'

// ---------------------------------------------------------------------------
// Scene cameras
//
// Placeable cameras the shot can be framed and rendered through — the
// animation-app staple. Each camera is a rig Group (a PerspectiveCamera plus a
// small body visual showing where it points) that a TransformControls gizmo
// moves and rotates; its body can also be resized without changing the lens.
// New cameras spawn at the CURRENT viewport view, so
// "frame the shot, add camera" just works.
//
// Camera motion is keyframed in the store's animData (keyed by camera NAME so
// it survives save/load id churn) and sampled per frame by the animation
// engine via sampleCameraTracks(). Looking through a camera is the scene
// manager's job (setViewCamera) — this module only owns the rigs.
// ---------------------------------------------------------------------------

let idCounter = 0
let nameCounter = 0

const c = {
  scene: null,
  camera: null, // the free viewport camera (spawn template + gizmo view)
  renderer: null,
  controls: null,
  requestRender: () => {},
  getSceneScale: null, // () => rough model size, for the body visual

  transform: null,
  helper: null,
  cameras: [], // { id, name, rig, camera, body }
  selected: null, // selected rig (or null)
  enabled: true,
  gizmoMode: 'translate',
  gizmoGrabbed: false,
  dragBefore: null,
}

const _qa = new THREE.Quaternion()
const _qb = new THREE.Quaternion()
const _pickNdc = new THREE.Vector2()
const _pickRaycaster = new THREE.Raycaster()

export function initCameras(refs) {
  c.scene = refs.scene
  c.camera = refs.camera
  c.renderer = refs.renderer
  c.controls = refs.controls
  c.requestRender = refs.requestRender
  c.getSceneScale = refs.getSceneScale || (() => 1)

  const transform = new TransformControls(c.camera, c.renderer.domElement)
  transform.setMode('translate')
  transform.setSize(0.8)
  transform.addEventListener('dragging-changed', (e) => {
    c.controls.enabled = !e.value && !c.controls.locked
    if (e.value) {
      c.dragBefore = c.selected ? cameraSnapshot(c.selected) : null
      c.gizmoGrabbed = true
    } else {
      commitCameraDrag()
    }
  })
  transform.addEventListener('objectChange', () => c.requestRender())
  c.transform = transform

  const helper = transform.getHelper()
  excludeFromOutline(helper)
  c.scene.add(helper)
  c.helper = helper
}

// Add a camera at the current viewport view (position, aim and zoom copied),
// so it starts out framing exactly what the user is looking at.
export function addCamera(fov, { recordUndo = true, position, quaternion, bodyScale } = {}) {
  const id = ++idCounter
  const name = `Camera ${++nameCounter}`
  const camera = new THREE.PerspectiveCamera(fov || c.camera.fov, 1, 0.01, 1000)
  const rig = new THREE.Group()
  rig.name = name
  rig.add(camera) // camera looks down the rig's -Z
  const body = makeCameraBody(c.getSceneScale())
  rig.add(body)

  if (position) rig.position.fromArray(position)
  else rig.position.copy(c.camera.position)
  if (quaternion) rig.quaternion.fromArray(quaternion)
  else rig.quaternion.copy(c.camera.quaternion)
  if (bodyScale) body.scale.fromArray(bodyScale)

  c.scene.add(rig)
  const entry = { id, name, rig, camera, body }
  c.cameras.push(entry)
  c.requestRender()
  const meta = { id, name, fov: camera.fov }
  if (recordUndo) {
    pushSceneHistory(
      () => {
        detachCameraEntry(entry)
        useStore.getState().removeSceneCamera(id)
      },
      () => {
        attachCameraEntry(entry)
        useStore.getState().addSceneCamera(meta)
      },
      () => {
        if (!c.cameras.includes(entry)) disposeBody(entry.body)
      },
    )
  }
  return meta
}

export function removeCamera(id) {
  const idx = c.cameras.findIndex((e) => e.id === id)
  if (idx < 0) return
  const entry = c.cameras[idx]
  const store = useStore.getState()
  const meta = store.sceneCameras.find((camera) => camera.id === id)
  const viewCameraId = store.viewCameraId
  detachCameraEntry(entry)
  store.removeSceneCamera(id)
  pushSceneHistory(
    () => {
      attachCameraEntry(entry, idx)
      if (meta) {
        useStore.getState().addSceneCamera(meta)
        if (viewCameraId === id) useStore.getState().setViewCameraId(id)
      }
    },
    () => {
      detachCameraEntry(entry)
      useStore.getState().removeSceneCamera(id)
    },
    () => {
      if (!c.cameras.includes(entry)) disposeBody(entry.body)
    },
  )
}

function detachCameraEntry(entry) {
  if (c.selected === entry.rig) {
    c.transform.detach()
    c.selected = null
  }
  c.scene.remove(entry.rig)
  const index = c.cameras.indexOf(entry)
  if (index >= 0) c.cameras.splice(index, 1)
  c.requestRender()
}

function attachCameraEntry(entry, index = c.cameras.length) {
  if (!c.cameras.includes(entry)) c.cameras.splice(Math.min(index, c.cameras.length), 0, entry)
  c.scene.add(entry.rig)
  c.requestRender()
}

function cameraSnapshot(rig) {
  const entry = c.cameras.find((camera) => camera.rig === rig)
  return {
    position: rig.position.clone(),
    quaternion: rig.quaternion.clone(),
    rigScale: rig.scale.clone(),
    bodyScale: entry?.body.scale.clone(),
  }
}

function applyCameraSnapshot(rig, snapshot) {
  const entry = c.cameras.find((camera) => camera.rig === rig)
  rig.position.copy(snapshot.position)
  rig.quaternion.copy(snapshot.quaternion)
  rig.scale.copy(snapshot.rigScale)
  if (entry && snapshot.bodyScale) entry.body.scale.copy(snapshot.bodyScale)
  c.requestRender()
}

function sameCameraSnapshot(a, b) {
  return a && b && a.position.equals(b.position) && a.quaternion.equals(b.quaternion) &&
    a.rigScale.equals(b.rigScale) && (!a.bodyScale || a.bodyScale.equals(b.bodyScale))
}

function commitCameraDrag() {
  const rig = c.selected
  const before = c.dragBefore
  c.dragBefore = null
  if (!rig || !before) return
  const after = cameraSnapshot(rig)
  if (sameCameraSnapshot(before, after)) return
  pushSceneHistory(
    () => applyCameraSnapshot(rig, before),
    () => applyCameraSnapshot(rig, after),
  )
}

// Attach the gizmo to a camera rig (or null to detach).
export function selectCamera(id) {
  if (!c.transform) return
  const entry = c.cameras.find((e) => e.id === id)
  c.selected = entry ? entry.rig : null
  if (c.selected && c.enabled) c.transform.attach(cameraTransformTarget(entry))
  else c.transform.detach()
  c.requestRender()
}

export function setCamerasEnabled(enabled) {
  c.enabled = enabled
  if (!c.transform) return
  if (!enabled) c.transform.detach()
  else if (c.selected) c.transform.attach(cameraTransformTarget(c.cameras.find((e) => e.rig === c.selected)))
  c.requestRender()
}

export function setCameraGizmoMode(mode) {
  if (!c.transform) return
  c.gizmoMode = mode
  c.transform.setMode(mode) // 'translate' | 'rotate' | 'scale'
  if (c.selected && c.enabled) {
    const entry = c.cameras.find((e) => e.rig === c.selected)
    if (entry) c.transform.attach(cameraTransformTarget(entry))
  }
  c.requestRender()
}

function cameraTransformTarget(entry) {
  return c.gizmoMode === 'scale' ? entry.body : entry.rig
}

// Find a placed camera by its visible body in the free viewport.
export function pickCameraId(ndcX, ndcY) {
  if (!c.camera || !c.cameras.length) return null
  _pickNdc.set(ndcX, ndcY)
  _pickRaycaster.setFromCamera(_pickNdc, c.camera)
  const bodies = c.cameras.filter((entry) => entry.body.visible).map((entry) => entry.body)
  const hit = _pickRaycaster.intersectObjects(bodies, true)[0]
  if (!hit) return null
  const entry = c.cameras.find((candidate) => candidate.body === hit.object || candidate.body.getObjectById(hit.object.id))
  return entry ? entry.id : null
}

// See consumeObjectGizmoGrab() in objects.js for what this is for.
export function consumeCameraGizmoGrab() {
  const grabbed = c.gizmoGrabbed
  c.gizmoGrabbed = false
  return grabbed
}

export function setCameraFov(id, fov) {
  const entry = c.cameras.find((e) => e.id === id)
  if (!entry) return
  entry.camera.fov = fov
  entry.camera.updateProjectionMatrix()
  c.requestRender()
}

// Re-align a camera to the current viewport view (re-frame the shot).
export function snapCameraToView(id) {
  const entry = c.cameras.find((e) => e.id === id)
  if (!entry) return
  const before = cameraSnapshot(entry.rig)
  entry.rig.position.copy(c.camera.position)
  entry.rig.quaternion.copy(c.camera.quaternion)
  const after = cameraSnapshot(entry.rig)
  if (!sameCameraSnapshot(before, after)) {
    pushSceneHistory(
      () => applyCameraSnapshot(entry.rig, before),
      () => applyCameraSnapshot(entry.rig, after),
    )
  }
  c.requestRender()
}

// The live PerspectiveCamera for an id (the scene manager renders through it).
export function getCameraById(id) {
  const entry = c.cameras.find((e) => e.id === id)
  return entry ? entry.camera : null
}

export function getCameraRigById(id) {
  return c.cameras.find((e) => e.id === id)?.rig || null
}

export function getCameraTransform(id) {
  const entry = c.cameras.find((camera) => camera.id === id)
  return entry
    ? {
        position: entry.rig.position.toArray(),
        quaternion: entry.rig.quaternion.toArray(),
        scale: entry.body.scale.toArray(),
      }
    : null
}

export function setCameraTransform(id, transform) {
  const entry = c.cameras.find((camera) => camera.id === id)
  if (!entry || !transform) return
  const before = cameraSnapshot(entry.rig)
  if (transform.position) entry.rig.position.fromArray(transform.position)
  if (transform.quaternion) entry.rig.quaternion.fromArray(transform.quaternion)
  if (transform.scale) entry.body.scale.fromArray(transform.scale)
  const after = cameraSnapshot(entry.rig)
  c.requestRender()
  if (!sameCameraSnapshot(before, after)) {
    pushSceneHistory(
      () => applyCameraSnapshot(entry.rig, before),
      () => applyCameraSnapshot(entry.rig, after),
    )
  }
}

export function getCameraClipboardData(id) {
  const entry = c.cameras.find((camera) => camera.id === id)
  if (!entry) return null
  return {
    fov: entry.camera.fov,
    position: entry.rig.position.toArray(),
    quaternion: entry.rig.quaternion.toArray(),
    bodyScale: entry.body.scale.toArray(),
  }
}

export function pasteCamera(data) {
  if (!data) return null
  return addCamera(data.fov, {
    position: data.position,
    quaternion: data.quaternion,
    bodyScale: data.bodyScale,
  })
}

export function snapshotCameraTransform(id) {
  const entry = c.cameras.find((camera) => camera.id === id)
  return entry ? cameraSnapshot(entry.rig) : null
}

export function setCameraUniformScale(id, value) {
  const entry = c.cameras.find((camera) => camera.id === id)
  if (!entry) return
  const scale = Math.max(0.01, value)
  entry.body.scale.setScalar(scale)
  c.requestRender()
}

export function commitCameraTransform(id, before) {
  const entry = c.cameras.find((camera) => camera.id === id)
  if (!entry || !before) return
  const after = cameraSnapshot(entry.rig)
  if (sameCameraSnapshot(before, after)) return
  pushSceneHistory(
    () => applyCameraSnapshot(entry.rig, before),
    () => applyCameraSnapshot(entry.rig, after),
  )
}

// Resolve a camera's id from its name (camera cuts are stored by name).
export function getCameraIdByName(name) {
  const entry = c.cameras.find((e) => e.name === name)
  return entry ? entry.id : null
}

// Whenever the viewport is looking through (or gliding toward) any camera,
// hide every camera body — not just the one you're inside — so no OTHER
// camera rig that happens to be in frame shows up in the shot either.
// Bodies only reappear in the free view, where they're an editing aid.
export function setActiveCameraBody(insideCamera) {
  for (const entry of c.cameras) entry.body.visible = !insideCamera
  c.requestRender()
}

// A camera's current placement for keyframing.
export function getCameraKeyValue(id) {
  const entry = c.cameras.find((e) => e.id === id)
  if (!entry) return null
  return {
    name: entry.name,
    pos: entry.rig.position.toArray(),
    quat: entry.rig.quaternion.toArray(),
    scale: entry.body.scale.toArray(),
  }
}

// --- Playback ----------------------------------------------------------------

// Snapshot every rig's placement before playback drives them, so Stop puts
// the cameras back where the user parked them.
export function getCamerasPlaybackSnapshot() {
  return c.cameras.map((entry) => ({
    rig: entry.rig,
    body: entry.body,
    pos: entry.rig.position.clone(),
    quat: entry.rig.quaternion.clone(),
    scale: entry.body.scale.clone(),
  }))
}

export function applyCamerasPlaybackSnapshot(snap) {
  if (!snap) return
  for (const s of snap) {
    s.rig.position.copy(s.pos)
    s.rig.quaternion.copy(s.quat)
    if (s.scale) s.body.scale.copy(s.scale)
  }
}

// Drive the camera rigs and visible bodies from keyframe tracks at time t.
// Tracks: { [cameraName]: [{ time, pos:[3], quat:[4], scale:[3]? }] }.
export function sampleCameraTracks(tracks, t) {
  if (!tracks) return
  for (const [name, keys] of Object.entries(tracks)) {
    if (!keys || keys.length === 0) continue
    const entry = c.cameras.find((e) => e.name === name)
    if (!entry) continue
    sampleTRQ(keys, t, entry)
  }
}

// Interpolate {time,pos,quat} keys at t onto an Object3D (lerp + slerp).
function sampleTRQ(keys, t, entry) {
  if (t <= keys[0].time) return applyKey(entry, keys[0])
  const last = keys[keys.length - 1]
  if (t >= last.time) return applyKey(entry, last)
  let i = 0
  while (i < keys.length - 1 && keys[i + 1].time < t) i++
  const k0 = keys[i]
  const k1 = keys[i + 1]
  const span = k1.time - k0.time
  const f = span > 0 ? (t - k0.time) / span : 0
  entry.rig.position.set(
    k0.pos[0] + (k1.pos[0] - k0.pos[0]) * f,
    k0.pos[1] + (k1.pos[1] - k0.pos[1]) * f,
    k0.pos[2] + (k1.pos[2] - k0.pos[2]) * f,
  )
  _qa.fromArray(k0.quat)
  _qb.fromArray(k1.quat)
  entry.rig.quaternion.slerpQuaternions(_qa, _qb, f)
  if (k0.scale && k1.scale) {
    entry.body.scale.set(
      k0.scale[0] + (k1.scale[0] - k0.scale[0]) * f,
      k0.scale[1] + (k1.scale[1] - k0.scale[1]) * f,
      k0.scale[2] + (k1.scale[2] - k0.scale[2]) * f,
    )
  }
}

function applyKey(entry, k) {
  entry.rig.position.fromArray(k.pos)
  entry.rig.quaternion.fromArray(k.quat)
  if (k.scale) entry.body.scale.fromArray(k.scale)
}

// --- Save / load ---------------------------------------------------------------

// Everything needed to recreate the cameras (procedural — no file blobs).
export function getCamerasData() {
  return c.cameras.map((entry) => ({
    name: entry.name,
    fov: entry.camera.fov,
    position: entry.rig.position.toArray(),
    quaternion: entry.rig.quaternion.toArray(),
    scale: entry.body.scale.toArray(),
  }))
}

// Recreate cameras from saved data. Returns UI metadata for the store.
// Restores each camera's saved NAME (and bumps the name counter past it) so
// keyframe tracks keyed by name reconnect.
export function applyCamerasData(list) {
  if (!Array.isArray(list)) return []
  const metas = []
  for (const item of list) {
    const meta = addCamera(item.fov, { recordUndo: false })
    const entry = c.cameras.find((e) => e.id === meta.id)
    if (item.name) {
      entry.name = item.name
      entry.rig.name = item.name
      meta.name = item.name
      const n = /^Camera (\d+)$/.exec(item.name)
      if (n) nameCounter = Math.max(nameCounter, Number(n[1]))
    }
    if (item.position) entry.rig.position.fromArray(item.position)
    if (item.quaternion) entry.rig.quaternion.fromArray(item.quaternion)
    if (item.scale) entry.body.scale.fromArray(item.scale)
    metas.push(meta)
  }
  c.requestRender()
  return metas
}

// Remove every camera (project load starts from a clean slate).
export function clearCameras() {
  if (c.transform) c.transform.detach()
  c.selected = null
  for (const entry of c.cameras) {
    c.scene?.remove?.(entry.rig)
    disposeBody(entry.body)
  }
  c.cameras = []
  c.dragBefore = null
  c.requestRender()
}

// Swap the camera the gizmo raycasts/sizes against (view-through-camera mode).
export function setViewCamera(camera) {
  if (c.transform) c.transform.camera = camera
}

export function disposeCameras() {
  clearCameras()
  if (c.helper && c.scene) c.scene.remove(c.helper)
  if (c.transform) {
    c.transform.dispose()
    c.transform = null
  }
  c.helper = null
  c.scene = null
  c.camera = null
  c.renderer = null
  c.controls = null
}

// --- internals ---------------------------------------------------------------

// A compact camera body: box + a lens hood opening toward -Z (the view
// direction) + a fin on top marking "up". Sized to the loaded model so it
// stays visible in both metre-scale glTF and centimetre-scale FBX scenes.
function makeCameraBody(sceneScale) {
  const s = Math.max(sceneScale || 1, 0.5) * 0.12
  const group = new THREE.Group()
  const mat = new THREE.MeshBasicMaterial({ color: 0x3a3f4e })
  const accent = new THREE.MeshBasicMaterial({ color: 0x4f8cff })

  const box = new THREE.Mesh(new THREE.BoxGeometry(s * 1.4, s, s * 1.8), mat)
  group.add(box)

  const hood = new THREE.Mesh(new THREE.ConeGeometry(s * 0.7, s * 1.1, 4, 1, true), accent)
  hood.rotation.x = Math.PI / 2 // open the cone toward -Z
  hood.rotation.y = Math.PI / 4 // square hood, edges axis-aligned
  hood.position.z = -s * 1.4
  group.add(hood)

  const fin = new THREE.Mesh(new THREE.BoxGeometry(s * 0.25, s * 0.6, s * 0.8), accent)
  fin.position.y = s * 0.8
  group.add(fin)

  excludeFromOutline(group)
  return group
}

function disposeBody(body) {
  body.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose()
    if (obj.material) obj.material.dispose()
  })
}

// Stamp every material in a subtree so the OutlineEffect skips it.
function excludeFromOutline(obj3d) {
  obj3d.traverse((obj) => {
    if (!obj.material) return
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of mats) mat.userData.outlineParameters = { visible: false }
  })
}