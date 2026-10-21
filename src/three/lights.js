import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { pushSceneHistory } from './sceneHistory.js'
import { getHistorySequence, getHistoryEpoch } from './undoHistory.js'
import { useStore } from '../store.js'
import { createMount, reparentKeepingWorld, registerFollower, unregisterFollower } from './attach.js'

// ---------------------------------------------------------------------------
// Scene lights
//
// Placeable lights on top of the app's built-in key light + ambient fill
// (see scene.js setLightSettings). Each is either a THREE.PointLight (a bulb: shines
// every way) or, when "Directional", a THREE.SpotLight (a cone aimed in one direction:
// torch, headlight, floodlight). Both have a RANGE — the distance at which their light
// (and their shadows) have faded to nothing — so a small bulb lights a room, not a
// street, and a floodlight reaches further. A small ghost "source" sphere (and, for a
// cone, an outline of the beam) is shown only while the light is selected; they are
// moved with the shared translate/rotate/scale TransformControls gizmo — like a prop,
// but lighting instead of geometry.
//
// Position, rotation, size, colour + intensity can be keyframed on the same
// timeline as the character/cameras (see getLightKeyValue / sampleLightTracks
// below) — key it at two times in the Animate panel and it glides between them.
// ---------------------------------------------------------------------------

let idCounter = 0
let nameCounter = 0

// A light's range is the distance (world units) at which it has faded out completely.
// Three's own falloff window makes that a smooth fade, and shadows fade out with it
// (see shadowDarkening.js). The default is a plain light bulb.
export const MIN_LIGHT_RANGE = 0.25
export const MAX_LIGHT_RANGE = 500
export const DEFAULT_LIGHT_RANGE = 7.5
export const DEFAULT_CONE_ANGLE = 45 // degrees, half-angle of the cone
export const DEFAULT_PENUMBRA = 0.35 // 0 = hard-edged beam .. 1 = fully feathered
const clampRange = (r) => Math.min(MAX_LIGHT_RANGE, Math.max(MIN_LIGHT_RANGE, Number(r) || DEFAULT_LIGHT_RANGE))
const clampAngle = (a) => Math.min(89, Math.max(3, Number(a) || DEFAULT_CONE_ANGLE))
const clampPenumbra = (p) => Math.min(1, Math.max(0, p == null || Number.isNaN(Number(p)) ? DEFAULT_PENUMBRA : Number(p)))
const rad = (deg) => (deg * Math.PI) / 180

const l = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  requestRender: () => {},
  getSceneScale: null, // () => rough model size, for default placement + bulb size
  getPlacement: null,

  transform: null,
  helper: null,
  lights: [], // { id, name, light, bulb, directional, directionLocal }
  selected: null, // selected light (THREE.PointLight | THREE.DirectionalLight) or null
  enabled: true,
  viewCamera: null, // the camera being looked THROUGH (a placed camera), or null/free camera
  gizmoGrabbed: false, // true once per interaction that actually MOVED something via the gizmo (see objectChange)
  draggingViaGizmo: false, // true between dragging-changed(true) and (false) — not by itself proof of an actual move
  onChange: null, // called after anything a rim-follow could care about changes (colour/position/type)
  dragBefore: null,
}

export function initLights(refs) {
  l.scene = refs.scene
  l.camera = refs.camera
  l.renderer = refs.renderer
  l.controls = refs.controls
  l.requestRender = refs.requestRender
  l.getSceneScale = refs.getSceneScale || (() => 1)
  l.getPlacement = refs.getPlacement || null
  l.onChange = refs.onChange || null

  const transform = new TransformControls(l.camera, l.renderer.domElement)
  transform.setMode('translate')
  transform.setSize(0.8)
  transform.addEventListener('dragging-changed', (e) => {
    l.controls.enabled = !e.value && !l.controls.locked
    l.draggingViaGizmo = e.value
    if (e.value) l.dragBefore = l.selected ? lightSnapshot(l.selected) : null
    else commitLightDrag()
  })
  transform.addEventListener('objectChange', () => {
    // Only count as "grabbed" once the gizmo has actually moved the light —
    // its handles have pick padding wider than what's drawn, so a click near
    // (not on) the gizmo can otherwise be swallowed with no resulting move.
    if (l.draggingViaGizmo) l.gizmoGrabbed = true
    updateDirectionalTargets()
    l.requestRender()
    if (l.onChange) l.onChange() // a followed light's direction may have moved
  })
  l.transform = transform

  const helper = transform.getHelper()
  excludeFromOutline(helper)
  l.scene.add(helper)
  l.helper = helper
}

// Add a point light near the model, slightly up and to the side so it doesn't
// start out coincident with the key light.
export function addLight({ recordUndo = true, data = null } = {}) {
  const id = ++idCounter
  const name = `Light ${++nameCounter}`
  const scale = Math.max(l.getSceneScale(), 0.5)

  const initialColor = data?.color || '#ffffff'
  const initialIntensity = data?.intensity ?? 2
  const range = clampRange(data?.range ?? data?.shadowReach ?? DEFAULT_LIGHT_RANGE) // shadowReach: saved by an earlier build
  const light = new THREE.PointLight(initialColor, initialIntensity, range, 2)
  light.name = name
  if (data?.position) light.position.fromArray(data.position)
  else if (l.getPlacement) light.position.copy(l.getPlacement(scale))
  else light.position.set(scale * 1.2, scale * 1.8, scale * 1.2)
  light.castShadow = data?.castShadow ?? false
  light.visible = data?.visible !== false

  const bulb = makeBulb(scale)
  light.add(bulb)

  l.scene.add(light)
  const cone = makeCone()
  light.add(cone)
  const entry = {
    id, name, light, bulb, cone, directional: false, directionLocal: null,
    range,
    angle: clampAngle(data?.angle ?? DEFAULT_CONE_ANGLE),
    penumbra: clampPenumbra(data?.penumbra),
  }
  l.lights.push(entry)
  if (data?.directional) swapLightType(id, true) // setup, not an edit: no undo step
  if (data?.quaternion) entry.light.quaternion.fromArray(data.quaternion)
  if (data?.scale) entry.light.scale.fromArray(data.scale)
  if (entry.directional) aimLight(entry, data?.direction)
  rebuildCone(entry)
  updateDirectionalTargets()
  if (data?.castShadow) applyShadowSettings(entry, true)
  l.requestRender()
  const meta = {
    id,
    name,
    color: '#' + entry.light.color.getHexString(),
    intensity: entry.light.intensity,
    castShadow: entry.light.castShadow,
    directional: entry.directional,
    visible: entry.light.visible,
    ...shapeMeta(entry),
  }
  if (recordUndo) {
    pushSceneHistory(
      () => {
        detachLightEntry(entry)
        useStore.getState().removeSceneLight(id)
      },
      () => {
        attachLightEntry(entry)
        useStore.getState().addSceneLight(meta)
      },
      () => {
        if (!l.lights.includes(entry)) disposeLightEntry(entry)
      },
    )
  }
  return meta
}

export function removeLight(id) {
  const idx = l.lights.findIndex((e) => e.id === id)
  if (idx < 0) return
  const entry = l.lights[idx]
  const meta = useStore.getState().sceneLights.find((light) => light.id === id)
  detachLightEntry(entry)
  useStore.getState().removeSceneLight(id)
  pushSceneHistory(
    () => {
      attachLightEntry(entry, idx)
      if (meta) useStore.getState().addSceneLight(meta)
    },
    () => {
      detachLightEntry(entry)
      useStore.getState().removeSceneLight(id)
    },
    () => {
      if (!l.lights.includes(entry)) disposeLightEntry(entry)
    },
  )
}

function detachLightEntry(entry) {
  releaseLightAttachment(entry) // back into the scene (same world spot) before it's removed
  if (l.selected === entry.light) {
    l.transform.detach()
    l.selected = null
  }
  l.scene.remove(entry.light)
  if (entry.light.target && entry.light.target.parent) l.scene.remove(entry.light.target)
  const index = l.lights.indexOf(entry)
  if (index >= 0) l.lights.splice(index, 1)
  l.requestRender()
}

function disposeLightEntry(entry) {
  if (entry.light.target && entry.light.target.parent) entry.light.target.parent.remove(entry.light.target)
  disposeBulb(entry.bulb)
  if (entry.cone) {
    entry.cone.geometry.dispose()
    entry.cone.material.dispose()
  }
}

function attachLightEntry(entry, index = l.lights.length) {
  if (!l.lights.includes(entry)) l.lights.splice(Math.min(index, l.lights.length), 0, entry)
  l.scene.add(entry.light)
  if (entry.light.target) l.scene.add(entry.light.target)
  l.requestRender()
}

function lightSnapshot(light) {
  return {
    position: light.position.clone(),
    quaternion: light.quaternion.clone(),
    scale: light.scale.clone(),
  }
}

function applyLightSnapshot(light, snapshot) {
  light.position.copy(snapshot.position)
  light.quaternion.copy(snapshot.quaternion)
  light.scale.copy(snapshot.scale)
  updateDirectionalTargets()
  l.requestRender()
  if (l.onChange) l.onChange()
}

function sameLightSnapshot(a, b) {
  return a && b && a.position.equals(b.position) && a.quaternion.equals(b.quaternion) && a.scale.equals(b.scale)
}

function commitLightDrag() {
  const light = l.selected
  const before = l.dragBefore
  l.dragBefore = null
  if (!light || !before) return
  const after = lightSnapshot(light)
  if (sameLightSnapshot(before, after)) return
  pushSceneHistory(
    () => applyLightSnapshot(light, before),
    () => applyLightSnapshot(light, after),
  )
}
// Swap a light between Point (shines every direction, like a bulb) and Directional
// (a cone aimed one way: torch, headlight, floodlight). A new cone starts aimed at the
// scene origin; after that the ROTATE gizmo turns the beam, and the aim is saved with
// the project. Both kinds fade out at their range.
export function setLightDirectional(id, directional) {
  return recordLightEdit(id, () => swapLightType(id, directional))
}

function swapLightType(id, directional) {
  const entry = l.lights.find((e) => e.id === id)
  if (!entry) return
  directional = !!directional
  if (entry.directional === directional) return

  const old = entry.light
  const wasSelected = l.selected === old
  const scale = Math.max(l.getSceneScale(), 0.5)

  const next = directional
    ? new THREE.SpotLight(old.color.getHex(), old.intensity, entry.range, rad(entry.angle), entry.penumbra, 2)
    : new THREE.PointLight(old.color.getHex(), old.intensity, entry.range, 2)
  next.name = old.name
  next.position.copy(old.position)
  next.visible = old.visible
  if (directional) {
    next.target.position.set(0, 0, 0)
    l.scene.add(next.target)
  }

  old.remove(entry.bulb)
  next.add(entry.bulb)
  old.remove(entry.cone)
  next.add(entry.cone)
  const parent = old.parent || l.scene // stays under its mount if it's attached to an object
  parent.remove(old)
  if (old.target && old.target.parent) l.scene.remove(old.target)
  parent.add(next)

  entry.light = next
  entry.directional = directional
  entry.directionLocal = directional
    ? next.target.position.clone().sub(next.position).applyQuaternion(next.quaternion.clone().invert())
    : null
  if (directional && entry.directionLocal.lengthSq() < 1e-8) entry.directionLocal.set(0, 0, -1) // sitting on the origin: aim forward
  applyShadowSettings(entry, old.castShadow)
  rebuildCone(entry)

  if (wasSelected) {
    l.selected = next
    if (l.enabled) l.transform.attach(next)
  }
  updateDirectionalTargets()
  l.requestRender()
  if (l.onChange) l.onChange()
}

// The colour + world-space direction a rim-light "follow this light" setting
// should use. Direction always points FROM the scene toward the light,
// matching the key light's own convention (see scene.js state.lightDir) —
// for a Directional light that's position-minus-target; for a Point light,
// world origin is used as the implicit target (characters live near it).
export function getLightRimSource(id) {
  const entry = l.lights.find((e) => e.id === id)
  if (!entry) return null
  const light = entry.light
  const worldPos = new THREE.Vector3()
  light.getWorldPosition(worldPos)
  let direction
  if (entry.directional) {
    const targetPos = new THREE.Vector3()
    light.target.getWorldPosition(targetPos)
    direction = worldPos.sub(targetPos)
  } else {
    direction = worldPos
  }
  if (direction.lengthSq() < 1e-8) direction.set(0.3, 0.6, 0.7) // degenerate: light sitting at origin
  direction.normalize()
  return { color: '#' + light.color.getHexString(), direction }
}

// Attach the gizmo to a light (or null to detach).
export function selectLight(id) {
  if (!l.transform) return
  const entry = l.lights.find((e) => e.id === id)
  l.selected = entry ? entry.light : null
  if (l.selected && l.enabled) l.transform.attach(l.selected)
  else l.transform.detach()
  l.requestRender()
}

export function setLightsEnabled(enabled) {
  l.enabled = enabled
  if (!l.transform) return
  if (!enabled) l.transform.detach()
  else if (l.selected) l.transform.attach(l.selected)
  l.requestRender()
}

export function setLightGizmoMode(mode) {
  if (!l.transform) return
  l.transform.setMode(mode)
  l.requestRender()
}

export function getLightTransform(id) {
  const light = getLightById(id)
  return light
    ? { position: light.position.toArray(), quaternion: light.quaternion.toArray(), scale: light.scale.toArray() }
    : null
}

export function setLightTransform(id, transform) {
  const light = getLightById(id)
  if (!light || !transform) return
  const before = lightSnapshot(light)
  if (transform.position) light.position.fromArray(transform.position)
  if (transform.quaternion) light.quaternion.fromArray(transform.quaternion)
  if (transform.scale) light.scale.fromArray(transform.scale)
  const after = lightSnapshot(light)
  updateDirectionalTargets()
  l.requestRender()
  if (l.onChange) l.onChange()
  if (!sameLightSnapshot(before, after)) {
    pushSceneHistory(
      () => applyLightSnapshot(light, before),
      () => applyLightSnapshot(light, after),
    )
  }
}

export function getLightClipboardData(id) {
  const entry = l.lights.find((light) => light.id === id)
  if (!entry) return null
  return {
    color: '#' + entry.light.color.getHexString(),
    intensity: entry.light.intensity,
    castShadow: entry.light.castShadow,
    directional: entry.directional,
    visible: entry.light.visible,
    ...shapeMeta(entry),
    direction: entry.directionLocal ? entry.directionLocal.toArray() : undefined,
    position: entry.light.position.toArray(),
    quaternion: entry.light.quaternion.toArray(),
    scale: entry.light.scale.toArray(),
  }
}

export function pasteLight(data) {
  return data ? addLight({ data }) : null
}

export function setLightVisible(id, visible, recordHistory = true) {
  const entry = l.lights.find((light) => light.id === id)
  if (!entry) return
  const before = entry.light.visible
  const after = !!visible
  entry.light.visible = after
  useStore.getState().setSceneLightVisible(id, after)
  l.requestRender()
  if (recordHistory && before !== after) {
    pushSceneHistory(
      () => setLightVisible(id, before, false),
      () => setLightVisible(id, after, false),
    )
  }
}

export function snapshotLightTransform(id) {
  const entry = l.lights.find((light) => light.id === id)
  return entry ? lightSnapshot(entry.light) : null
}

export function setLightUniformScale(id, value) {
  const light = getLightById(id)
  if (!light) return
  light.scale.setScalar(Math.max(0.01, value))
  updateDirectionalTargets()
  l.requestRender()
}

export function commitLightTransform(id, before) {
  const light = getLightById(id)
  if (!light || !before) return
  const after = lightSnapshot(light)
  if (sameLightSnapshot(before, after)) return
  pushSceneHistory(
    () => applyLightSnapshot(light, before),
    () => applyLightSnapshot(light, after),
  )
}

export function getLightById(id) {
  return l.lights.find((entry) => entry.id === id)?.light || null
}

const _lightPickNdc = new THREE.Vector2()
const _lightRaycaster = new THREE.Raycaster()
// Click-to-select a light. Done in SCREEN space — the nearest visible light whose
// position is within LIGHT_PICK_PX pixels of the click — rather than by raycasting
// a sphere, so the click target is a small fixed size however big the light's
// source is, and can't block clicks on anything near it.
const LIGHT_PICK_PX = 14
const _lightProj = new THREE.Vector3()
export function pickLightId(ndcX, ndcY) {
  if (!l.camera || !l.lights.length) return null
  l.scene.updateMatrixWorld(true)
  const rect = l.renderer?.domElement?.getBoundingClientRect?.()
  const w = rect && rect.width ? rect.width : 800
  const h = rect && rect.height ? rect.height : 600
  let best = null
  let bestDist = LIGHT_PICK_PX
  for (const entry of l.lights) {
    if (!entry.light.visible) continue
    entry.light.getWorldPosition(_lightProj).project(l.camera)
    if (_lightProj.z > 1) continue // behind the camera
    const dx = ((_lightProj.x - ndcX) * w) / 2
    const dy = ((_lightProj.y - ndcY) * h) / 2
    const dist = Math.hypot(dx, dy)
    if (dist <= bestDist) {
      best = entry
      bestDist = dist
    }
  }
  return best ? best.id : null
}

// Per-frame: show the ghost source sphere on the selected light (and only while
// editing — not when looking through a placed camera), and let the source size
// soften that light's shadows. A bigger source blurs the shadow edge more
// (shadow.radius is the PCF sample spread, 1 = the normal crisp edge), which is
// the visible effect of a larger emitter. Scale 1 = unchanged from before.
export function updateLightSources() {
  // A cone's aim target must follow its light EVERY frame: a light attached to an object turns
  // with it (rotate, animate, parent moves) without ever touching the light itself, so refreshing
  // the target only on light edits left the beam pointing the old way.
  updateDirectionalTargets()
  const freeView = !l.viewCamera || l.viewCamera === l.camera
  for (const entry of l.lights) {
    entry.bulb.visible = !!(l.enabled && freeView && l.selected === entry.light && entry.light.visible)
    const sc = entry.light.scale
    const size = (sc.x + sc.y + sc.z) / 3
    // The beam outline: only for a selected cone, aimed along its saved direction, and
    // counter-scaled so resizing the light (its source size) does not stretch the cone.
    const showCone = entry.bulb.visible && entry.directional && !!entry.directionLocal
    entry.cone.visible = showCone
    if (showCone) {
      _coneDir.copy(entry.directionLocal).normalize()
      entry.cone.quaternion.setFromUnitVectors(_coneForward, _coneDir)
      entry.cone.scale.setScalar(1 / Math.max(size, 1e-3))
      entry.cone.material.color.copy(entry.light.color)
    }
    const radius = Math.min(10, Math.max(1, 1 + 3 * (size - 1)))
    if (entry.light.shadow && entry.light.shadow.radius !== radius) entry.light.shadow.radius = radius
  }
}

const _coneForward = new THREE.Vector3(0, 0, -1)
const _coneDir = new THREE.Vector3()

function updateDirectionalTargets() {
  for (const entry of l.lights) {
    if (!entry.directional || !entry.directionLocal) continue
    entry.light.updateMatrixWorld(true)
    entry.light.getWorldPosition(entry.light.target.position)
    entry.light.target.position.add(
      entry.directionLocal.clone().applyQuaternion(entry.light.getWorldQuaternion(new THREE.Quaternion())),
    )
    entry.light.target.updateMatrixWorld()
  }
}

// See consumeObjectGizmoGrab() in objects.js for what this is for.
export function consumeLightGizmoGrab() {
  const grabbed = l.gizmoGrabbed
  l.gizmoGrabbed = false
  return grabbed
}

// --- Undo / redo for a light's settings ----------------------------------------------
//
// Colour, brightness, shadows, type (point / cone), range, cone angle + softness, preset: each
// public setter below records one undo step (the snapshot before and after). Dragging a slider
// fires many edits, so consecutive edits to the same light merge into one step. Nested calls
// (a preset calling the other setters, loading a project, an undo itself) are never recorded.
const LIGHT_COALESCE_MS = 800
let lightHistoryDepth = 0
let lastLightEdit = null

function lightProps(entry) {
  return {
    color: '#' + entry.light.color.getHexString(),
    intensity: entry.light.intensity,
    castShadow: !!entry.light.castShadow,
    directional: !!entry.directional,
    range: entry.range,
    angle: entry.angle,
    penumbra: entry.penumbra,
    direction: entry.directionLocal ? entry.directionLocal.toArray() : null,
  }
}

const sameLightProps = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function restoreLightProps(id, props) {
  const entry = l.lights.find((e) => e.id === id)
  if (!entry) return
  lightHistoryDepth++
  try {
    setLightDirectional(id, props.directional)
    if (props.directional && props.direction) entry.directionLocal = new THREE.Vector3().fromArray(props.direction)
    entry.light.color.set(props.color)
    entry.light.intensity = props.intensity
    entry.angle = props.angle
    entry.penumbra = props.penumbra
    if (entry.directional) {
      entry.light.angle = rad(entry.angle)
      entry.light.penumbra = entry.penumbra
    }
    entry.range = props.range
    entry.light.distance = props.range
    applyShadowSettings(entry, props.castShadow)
    rebuildCone(entry)
  } finally {
    lightHistoryDepth--
  }
  useStore.getState().patchSceneLight(id, {
    color: props.color,
    intensity: props.intensity,
    castShadow: props.castShadow,
    directional: props.directional,
    range: props.range,
    angle: props.angle,
    penumbra: props.penumbra,
  })
  l.requestRender()
  if (l.onChange) l.onChange()
}

function recordLightEdit(id, fn) {
  const entry = l.lights.find((e) => e.id === id)
  if (!entry || lightHistoryDepth > 0) return fn()
  const before = lightProps(entry)
  lightHistoryDepth++
  let result
  try {
    result = fn()
  } finally {
    lightHistoryDepth--
  }
  const after = lightProps(entry)
  if (sameLightProps(before, after)) return result
  const now = Date.now()
  if (lastLightEdit && lastLightEdit.id === id && lastLightEdit.epoch === getHistoryEpoch() && lastLightEdit.seq === getHistorySequence() && now - lastLightEdit.time < LIGHT_COALESCE_MS) {
    lastLightEdit.after = after
    lastLightEdit.time = now
    return result
  }
  const rec = { id, before, after, time: now, seq: 0, epoch: getHistoryEpoch() }
  pushSceneHistory(
    () => restoreLightProps(id, rec.before),
    () => restoreLightProps(id, rec.after),
  )
  rec.seq = getHistorySequence()
  lastLightEdit = rec
  return result
}

export function setLightColor(id, hex) {
  recordLightEdit(id, () => {
    const entry = l.lights.find((e) => e.id === id)
    if (!entry) return
    entry.light.color.set(hex)
    l.requestRender()
    if (l.onChange) l.onChange()
  })
}

export function setLightIntensity(id, intensity) {
  recordLightEdit(id, () => {
    const entry = l.lights.find((e) => e.id === id)
    if (!entry) return
    entry.light.intensity = intensity
    l.requestRender()
  })
}

export function setLightCastShadow(id, castShadow) {
  recordLightEdit(id, () => {
    const entry = l.lights.find((e) => e.id === id)
    if (!entry) return
    applyShadowSettings(entry, castShadow)
    l.requestRender()
  })
}

// Shared by setLightCastShadow and setLightDirectional (a type swap needs to
// re-apply shadow settings on the new light object). Directional lights need
// an explicit orthographic shadow-camera frustum sized to the scene — the
// three.js default is a tiny 5-unit box that clips most characters.
// Shadow-map resolution for placed lights (follows the Shadow quality setting; see
// setPlacedLightShadowSize). Point lights render six faces, so this stays well below
// the key light's resolution.
let placedShadowSize = 1024

export function setPlacedLightShadowSize(size) {
  const next = Math.max(256, Math.round(size) || 1024)
  if (next === placedShadowSize) return
  placedShadowSize = next
  for (const entry of l.lights) {
    const shadow = entry.light.shadow
    if (!shadow || shadow.mapSize.x === next) continue
    shadow.mapSize.set(next, next)
    if (shadow.map) {
      shadow.map.dispose()
      shadow.map = null
    }
  }
  if (l.requestRender) l.requestRender()
}

function applyShadowSettings(entry, castShadow) {
  const light = entry.light
  light.castShadow = castShadow
  if (!castShadow) return
  light.shadow.mapSize.set(placedShadowSize, placedShadowSize)
  light.shadow.bias = -0.001
  // The shadow camera's far plane follows the light's range (three does that itself while
  // `distance` is set), and the shaders fade the shadow out with it. A small near plane keeps
  // tiny lights (an indicator LED) from clipping the things right beside them.
  light.shadow.camera.near = 0.05
  light.shadow.camera.updateProjectionMatrix()
}

// --- Range, cone and presets ---------------------------------------------------

export function getLightShape(id) {
  const entry = l.lights.find((e) => e.id === id)
  return entry ? shapeMeta(entry) : null
}

function shapeMeta(entry) {
  return { range: entry.range, angle: entry.angle, penumbra: entry.penumbra }
}

// The distance at which this light (and its shadows) has faded out completely.
export function setLightRange(id, range) {
  recordLightEdit(id, () => {
    const entry = l.lights.find((e) => e.id === id)
    if (!entry) return
    entry.range = clampRange(range)
    entry.light.distance = entry.range
    rebuildCone(entry)
    l.requestRender()
  })
}

// Beam width (half-angle, degrees) and edge softness of a Directional (cone) light.
export function setLightCone(id, { angle, penumbra } = {}) {
  recordLightEdit(id, () => {
    const entry = l.lights.find((e) => e.id === id)
    if (!entry) return
    if (angle != null) entry.angle = clampAngle(angle)
    if (penumbra != null) entry.penumbra = clampPenumbra(penumbra)
    if (entry.directional) {
      entry.light.angle = rad(entry.angle)
      entry.light.penumbra = entry.penumbra
    }
    rebuildCone(entry)
    l.requestRender()
  })
}

// Intensity is candela, so a light's reach scales with the square of its range: presets are
// written as "how bright at this range" using this helper so a floodlight actually lights up
// the distance it claims to.
const bright = (range, k = 1) => Math.round(2 * k * (range / DEFAULT_LIGHT_RANGE) ** 2 * 100) / 100

export const LIGHT_PRESETS = [
  { id: 'glow', label: 'Soft glow', hint: 'A small short-range glow, e.g. a tail light or lit panel (no shadows)', directional: false, color: '#ffffff', range: 3, intensity: bright(3, 0.9), castShadow: false },
  { id: 'window', label: 'Window light', hint: 'Soft wide beam pouring out of a window or screen', directional: true, color: '#ffe2a8', range: 14, intensity: bright(14, 0.9), angle: 75, penumbra: 0.7, castShadow: true },
  { id: 'bulb', label: 'Light bulb', hint: 'Warm household bulb', directional: false, color: '#fff1d6', range: 7.5, intensity: 2, castShadow: true },
  { id: 'lamp', label: 'Desk lamp', hint: 'Warm cone pointing down at a table', directional: true, color: '#ffe6bd', range: 9, intensity: bright(9, 1.2), angle: 55, penumbra: 0.5, castShadow: true },
  { id: 'candle', label: 'Candle', hint: 'Tiny warm glow', directional: false, color: '#ffb25a', range: 3, intensity: bright(3, 0.9), castShadow: true },
  { id: 'fire', label: 'Campfire', hint: 'Big warm orange glow', directional: false, color: '#ff8a3c', range: 11, intensity: bright(11, 1.3), castShadow: true },
  { id: 'street', label: 'Street lamp', hint: 'Sodium-yellow pool of light', directional: false, color: '#ffd69a', range: 22, intensity: bright(22, 1), castShadow: true },
  { id: 'flood', label: 'Floodlight', hint: 'Wide, bright, long-reaching cone', directional: true, color: '#f4f7ff', range: 40, intensity: bright(40, 1), angle: 62, penumbra: 0.25, castShadow: true },
  { id: 'taillight', label: 'Car tail light', hint: 'Red glow shining out the back; no shadows', directional: true, color: '#ff2a2a', range: 10, intensity: bright(10, 0.8), angle: 60, penumbra: 0.7, castShadow: false },
  { id: 'indicator', label: 'Indicator', hint: 'Amber turn signal glow; no shadows', directional: true, color: '#ffa31a', range: 6, intensity: bright(6, 0.8), angle: 70, penumbra: 0.7, castShadow: false },
  { id: 'headlight', label: 'Car headlight', hint: 'Narrower beam, soft edge; add two', directional: true, color: '#fffbea', range: 35, intensity: bright(35, 1), angle: 24, penumbra: 0.45, castShadow: true },
  { id: 'spot', label: 'Stage spotlight', hint: 'Tight, crisp beam', directional: true, color: '#ffffff', range: 50, intensity: bright(50, 1), angle: 14, penumbra: 0.15, castShadow: true },
  { id: 'torch', label: 'Torch', hint: 'Handheld flashlight', directional: true, color: '#fff5dc', range: 15, intensity: bright(15, 1), angle: 20, penumbra: 0.35, castShadow: true },
  { id: 'neon', label: 'Neon sign', hint: 'Coloured glow, no shadows', directional: false, color: '#ff3bd4', range: 5, intensity: bright(5, 1), castShadow: false },
  { id: 'screen', label: 'Screen glow', hint: 'Laptop / TV / monitor spill', directional: false, color: '#9fc4ff', range: 2.5, intensity: bright(2.5, 0.8), castShadow: false },
  { id: 'led', label: 'Status LED', hint: 'Smoke alarm, power light: tiny and faint, no shadows', directional: false, color: '#ff3a3a', range: 0.6, intensity: 0.02, castShadow: false },
]

// The settings a brand-new light of this preset starts with, in the shape addLight({ data }) takes
// — so adding "from a preset" is ONE undo step instead of an add followed by an edit.
export function lightDataForPreset(presetId) {
  const p = LIGHT_PRESETS.find((x) => x.id === presetId)
  if (!p) return null
  return {
    color: p.color,
    intensity: p.intensity,
    range: p.range,
    angle: p.angle,
    penumbra: p.penumbra,
    directional: p.directional,
    castShadow: p.castShadow,
  }
}

// Make light `id` the given preset (type, colour, brightness, range, cone, shadows). Returns
// the light's new store entry (without id/name) so the panel can mirror it.
export function applyLightPreset(id, presetId) {
  return recordLightEdit(id, () => applyLightPresetNow(id, presetId))
}

function applyLightPresetNow(id, presetId) {
  const entry = l.lights.find((e) => e.id === id)
  const preset = LIGHT_PRESETS.find((p) => p.id === presetId)
  if (!entry || !preset) return null
  setLightDirectional(id, preset.directional)
  entry.light.color.set(preset.color)
  entry.light.intensity = preset.intensity
  if (preset.angle != null) entry.angle = clampAngle(preset.angle)
  if (preset.penumbra != null) entry.penumbra = clampPenumbra(preset.penumbra)
  setLightCone(id, {})
  setLightRange(id, preset.range)
  applyShadowSettings(entry, preset.castShadow)
  l.requestRender()
  if (l.onChange) l.onChange()
  return {
    color: '#' + entry.light.color.getHexString(),
    intensity: entry.light.intensity,
    castShadow: entry.light.castShadow,
    directional: entry.directional,
    ...shapeMeta(entry),
  }
}

// --- Aiming a cone ---------------------------------------------------------------------
//
// Yaw / pitch are WORLD angles of where the beam points: yaw 0-360 degrees around the vertical
// axis (0 = toward +Z, 90 = toward +X), pitch -90..90 (positive = up). They are read from the
// beam's current world direction, so for a light attached to a car they follow the car as it
// turns; setting them converts back into the light's own frame.
const deg = (r) => (r * 180) / Math.PI

export function getLightAim(id) {
  const entry = l.lights.find((e) => e.id === id)
  if (!entry || !entry.directional || !entry.directionLocal) return null
  entry.light.updateMatrixWorld(true)
  const d = entry.directionLocal.clone().normalize().applyQuaternion(entry.light.getWorldQuaternion(new THREE.Quaternion()))
  let yaw = deg(Math.atan2(d.x, d.z))
  if (yaw < 0) yaw += 360
  if (Math.abs(d.x) < 1e-6 && Math.abs(d.z) < 1e-6) yaw = 0 // straight up / down: yaw means nothing
  return { yaw, pitch: deg(Math.asin(Math.min(1, Math.max(-1, d.y)))) }
}

export function directionFromAim(yawDeg, pitchDeg) {
  const cp = Math.cos(rad(pitchDeg))
  return new THREE.Vector3(Math.sin(rad(yawDeg)) * cp, Math.sin(rad(pitchDeg)), Math.cos(rad(yawDeg)) * cp)
}

export function setLightAim(id, { yaw, pitch } = {}) {
  recordLightEdit(id, () => {
    const entry = l.lights.find((e) => e.id === id)
    const cur = getLightAim(id)
    if (!entry || !cur) return
    const world = directionFromAim(yaw != null ? yaw : cur.yaw, Math.min(90, Math.max(-90, pitch != null ? pitch : cur.pitch)))
    entry.light.updateMatrixWorld(true)
    entry.directionLocal = world.applyQuaternion(entry.light.getWorldQuaternion(new THREE.Quaternion()).invert())
    entry.aimSaved = true
    updateDirectionalTargets()
    l.requestRender()
  })
}

// Turn the beam the opposite way.
export function flipLightAim(id) {
  recordLightEdit(id, () => {
    const entry = l.lights.find((e) => e.id === id)
    if (!entry || !entry.directional || !entry.directionLocal) return
    entry.directionLocal = entry.directionLocal.clone().negate()
    entry.aimSaved = true
    updateDirectionalTargets()
    l.requestRender()
  })
}

// Aim a cone: restore a saved direction (in the light's own frame), or - for a light
// that has never been aimed - point it at the scene origin from where it stands.
function aimLight(entry, saved) {
  if (Array.isArray(saved) && saved.length === 3) {
    entry.directionLocal = new THREE.Vector3().fromArray(saved)
    entry.aimSaved = true
  } else {
    entry.directionLocal = new THREE.Vector3()
      .sub(entry.light.position)
      .applyQuaternion(entry.light.quaternion.clone().invert())
  }
  if (entry.directionLocal.lengthSq() < 1e-8) entry.directionLocal.set(0, 0, -1)
}

// --- Keyframing ----------------------------------------------------------------

// A light's current transform + colour/intensity, for keyframing.
export function getLightKeyValue(id) {
  const entry = l.lights.find((e) => e.id === id)
  if (!entry) return null
  return {
    name: entry.name,
    pos: entry.light.position.toArray(),
    quat: entry.light.quaternion.toArray(),
    scale: entry.light.scale.toArray(),
    visible: entry.light.visible,
    color: '#' + entry.light.color.getHexString(),
    intensity: entry.light.intensity,
  }
}

// Snapshot every light's placement/colour/intensity before playback drives
// them, so Stop puts them back where the user parked them.
export function getLightsPlaybackSnapshot() {
  return l.lights.map((entry) => ({
    entry,
    pos: entry.light.position.clone(),
    quat: entry.light.quaternion.clone(),
    scale: entry.light.scale.clone(),
    color: entry.light.color.clone(),
    intensity: entry.light.intensity,
  }))
}

export function applyLightsPlaybackSnapshot(snap) {
  if (!snap) return
  for (const s of snap) {
    s.entry.light.position.copy(s.pos)
    if (s.quat) s.entry.light.quaternion.copy(s.quat)
    if (s.scale) s.entry.light.scale.copy(s.scale)
    s.entry.light.color.copy(s.color)
    s.entry.light.intensity = s.intensity
  }
  updateDirectionalTargets()
  if (snap.length && l.onChange) l.onChange()
}

// Drive the lights from keyframe tracks at time t.
// Tracks: { [lightName]: [{ time, pos:[3], quat:[4]?, scale:[3]?, color, intensity }] }.
export function sampleLightTracks(tracks, t) {
  if (!tracks) return
  let any = false
  for (const [name, keys] of Object.entries(tracks)) {
    if (!keys || keys.length === 0) continue
    const entry = l.lights.find((e) => e.name === name)
    if (!entry) continue
    sampleLightKeys(entry, keys, t)
    any = true
  }
  if (any) updateDirectionalTargets()
  // A light driving the rim light (see getLightRimSource) needs the shader's
  // colour/direction uniforms refreshed as it moves during playback — cheap
  // (just uniform writes), so just do it every time something moved.
  if (any && l.onChange) l.onChange()
}

const _c0 = new THREE.Color()
const _c1 = new THREE.Color()

function sampleLightKeys(entry, keys, t) {
  const apply = (k) => {
    entry.light.position.fromArray(k.pos)
    if (k.quat) entry.light.quaternion.fromArray(k.quat)
    if (k.scale) entry.light.scale.fromArray(k.scale)
    entry.light.color.set(k.color)
    entry.light.intensity = k.intensity
  }
  if (t <= keys[0].time) return apply(keys[0])
  const last = keys[keys.length - 1]
  if (t >= last.time) return apply(last)
  let i = 0
  while (i < keys.length - 1 && keys[i + 1].time < t) i++
  const k0 = keys[i]
  const k1 = keys[i + 1]
  const span = k1.time - k0.time
  const f = span > 0 ? (t - k0.time) / span : 0
  entry.light.position.set(
    k0.pos[0] + (k1.pos[0] - k0.pos[0]) * f,
    k0.pos[1] + (k1.pos[1] - k0.pos[1]) * f,
    k0.pos[2] + (k1.pos[2] - k0.pos[2]) * f,
  )
  if (k0.quat && k1.quat) {
    entry.light.quaternion.fromArray(k0.quat).slerp(new THREE.Quaternion(...k1.quat), f)
  }
  if (k0.scale && k1.scale) {
    entry.light.scale.set(
      k0.scale[0] + (k1.scale[0] - k0.scale[0]) * f,
      k0.scale[1] + (k1.scale[1] - k0.scale[1]) * f,
      k0.scale[2] + (k1.scale[2] - k0.scale[2]) * f,
    )
  }
  _c0.set(k0.color)
  _c1.set(k1.color)
  entry.light.color.copy(_c0).lerp(_c1, f)
  entry.light.intensity = k0.intensity + (k1.intensity - k0.intensity) * f
}

// --- Save / load ---------------------------------------------------------------

export function getLightsData() {
  return l.lights.map((entry) => ({
    name: entry.name,
    color: '#' + entry.light.color.getHexString(),
    intensity: entry.light.intensity,
    castShadow: entry.light.castShadow,
    directional: entry.directional,
    visible: entry.light.visible,
    ...shapeMeta(entry),
    // the beam's aim, in the light's own frame, so a rotated cone reloads pointing the same way
    direction: entry.directional && entry.directionLocal ? entry.directionLocal.toArray() : undefined,
    position: entry.light.position.toArray(),
    quaternion: entry.light.quaternion.toArray(),
    scale: entry.light.scale.toArray(),
    // Which object it's attached to, as an index into the scene's object list
    // (ids aren't stable across a reload). position/quaternion above are then
    // relative to that object.
    attachedObjectIndex: attachedObjectIndexOf(entry.attach?.objectId),
  }))
}

export function attachedObjectIndexOf(objectId) {
  if (objectId == null) return null
  const idx = useStore.getState().sceneObjects.findIndex((o) => o.id === objectId)
  return idx < 0 ? null : idx
}

export function applyLightsData(list) {
  if (!Array.isArray(list)) return []
  const metas = []
  for (const item of list) {
    const meta = addLight({ recordUndo: false })
    const entry = l.lights.find((e) => e.id === meta.id)
    if (item.name) {
      entry.name = item.name
      entry.light.name = item.name
      meta.name = item.name
      const n = /^Light (\d+)$/.exec(item.name)
      if (n) nameCounter = Math.max(nameCounter, Number(n[1]))
    }
    if (item.color) entry.light.color.set(item.color) // loading, not editing: no undo steps
    if (item.intensity != null) entry.light.intensity = item.intensity
    // range / cone first (shadowReach: the name an earlier build saved the range under)
    entry.range = clampRange(item.range ?? item.shadowReach ?? DEFAULT_LIGHT_RANGE)
    entry.light.distance = entry.range
    if (item.angle != null) entry.angle = clampAngle(item.angle)
    if (item.penumbra != null) entry.penumbra = clampPenumbra(item.penumbra)
    if (item.directional) swapLightType(meta.id, true) // loading, not editing: no undo steps
    if (item.castShadow) applyShadowSettings(entry, true)
    if (item.position) entry.light.position.fromArray(item.position)
    if (item.quaternion) entry.light.quaternion.fromArray(item.quaternion)
    if (item.scale) entry.light.scale.fromArray(item.scale)
    if (item.visible != null) entry.light.visible = item.visible !== false
    if (entry.directional) aimLight(entry, item.direction)
    rebuildCone(entry)
    metas.push({
      id: meta.id,
      name: entry.name,
      color: '#' + entry.light.color.getHexString(),
      intensity: entry.light.intensity,
      castShadow: entry.light.castShadow,
      directional: entry.directional,
      visible: entry.light.visible,
      ...shapeMeta(entry),
    })
  }
  updateDirectionalTargets()
  l.requestRender()
  return metas
}

// Remove every light (project load starts from a clean slate).
export function clearLights() {
  if (l.transform) l.transform.detach()
  l.selected = null
  for (const entry of l.lights) {
    releaseLightAttachment(entry)
    l.scene?.remove?.(entry.light)
    if (entry.light.target && entry.light.target.parent) l.scene?.remove?.(entry.light.target)
    disposeLightEntry(entry)
  }
  l.lights = []
  l.requestRender()
}

// Swap the camera the gizmo raycasts/sizes against (view-through-camera mode).
export function setViewCamera(camera) {
  l.viewCamera = camera
  if (l.transform) l.transform.camera = camera || l.camera // never leave the gizmo without a camera
}

export function disposeLights() {
  clearLights()
  if (l.helper && l.scene) l.scene.remove(l.helper)
  if (l.transform) {
    l.transform.dispose()
    l.transform = null
  }
  l.helper = null
  l.dragBefore = null
  l.scene = null
  l.camera = null
  l.renderer = null
  l.controls = null
  l.getPlacement = null
}

// --- attaching to an object ---------------------------------------------------

// Parent a light under `root` (a prop's or character's root Object3D) so it
// follows that object. By default the light stays exactly where it is in the
// world; `keepLocal` is for project load, where the saved position/rotation are
// ALREADY relative to the object. Attaching to another object just re-parents.
export function attachLightToRoot(id, root, objectId, { keepLocal = false } = {}) {
  const entry = l.lights.find((e) => e.id === id)
  if (!entry || !root) return false
  if (entry.attach) releaseLightAttachment(entry, { silent: true })
  const mount = createMount()
  root.add(mount)
  if (keepLocal) mount.add(entry.light)
  else reparentKeepingWorld(entry.light, mount)
  if (keepLocal && entry.directional && !entry.aimSaved) {
    // An older project didn't store the aim: re-aim the cone at the scene origin from wherever
    // it now is IN THE WORLD, same as an unattached one.
    l.scene.updateMatrixWorld(true)
    const wp = entry.light.getWorldPosition(new THREE.Vector3())
    const wq = entry.light.getWorldQuaternion(new THREE.Quaternion())
    entry.directionLocal = new THREE.Vector3().sub(wp).applyQuaternion(wq.invert())
  }
  const follower = { mount, release: () => releaseLightAttachment(entry) }
  registerFollower(follower)
  entry.attach = { mount, objectId, follower }
  useStore.getState().setLightAttachment(id, objectId)
  updateDirectionalTargets()
  l.requestRender()
  if (l.onChange) l.onChange()
  return true
}

export function detachLightFromObject(id) {
  const entry = l.lights.find((e) => e.id === id)
  if (entry) releaseLightAttachment(entry)
}

// Put an attached light back into the scene at its current world position.
function releaseLightAttachment(entry, { silent = false } = {}) {
  const a = entry.attach
  if (!a) return
  entry.attach = null
  unregisterFollower(a.follower)
  if (l.scene) reparentKeepingWorld(entry.light, l.scene)
  if (a.mount.parent) a.mount.parent.remove(a.mount)
  if (silent) return
  useStore.getState().setLightAttachment(entry.id, null)
  updateDirectionalTargets()
  l.requestRender?.()
  if (l.onChange) l.onChange()
}

// --- internals ---------------------------------------------------------------

// The light's SOURCE SIZE, drawn as a ghost sphere. A light's `scale` is the size
// of its emitter: at scale 1 the sphere has radius SOURCE_BASE * scene size, and
// resizing the light resizes the sphere (and softens its shadows — see
// updateLightSources). It only exists on screen while the light is selected, so
// it never shows in the preview or an exported video, and it isn't raycastable:
// clicking a light is done in screen space (pickLightId), so a big source can
// never block clicks on what's behind it.
const SOURCE_BASE = 0.05
const SOURCE_OPACITY = 0.4

function makeBulb(sceneScale) {
  const r = Math.max(sceneScale, 0.5) * SOURCE_BASE
  const geo = new THREE.SphereGeometry(r, 24, 16)
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: SOURCE_OPACITY,
    depthWrite: false,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.userData.isLightBulb = true
  mesh.visible = false
  mesh.raycast = () => {} // never a click target for anything
  excludeFromOutline(mesh)
  return mesh
}

function disposeBulb(bulb) {
  bulb.geometry.dispose()
  bulb.material.dispose()
}

// The beam outline shown while a cone light is selected: the edge of the cone, plus an inner
// ring where the soft edge (penumbra) begins. Local -Z is "forward"; updateLightSources
// turns it to the light's aim. Rebuilt whenever range / angle / softness change.
function makeCone() {
  const cone = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false }),
  )
  cone.userData.isLightCone = true
  cone.visible = false
  cone.frustumCulled = false
  cone.raycast = () => {} // never a click target
  excludeFromOutline(cone)
  return cone
}

const CONE_SEGMENTS = 32
export function coneVertices(length, angleDeg, penumbra) {
  const pts = []
  const ring = (radius) => {
    for (let i = 0; i < CONE_SEGMENTS; i++) {
      const a0 = (i / CONE_SEGMENTS) * Math.PI * 2
      const a1 = ((i + 1) / CONE_SEGMENTS) * Math.PI * 2
      pts.push(Math.cos(a0) * radius, Math.sin(a0) * radius, -length, Math.cos(a1) * radius, Math.sin(a1) * radius, -length)
    }
  }
  const outer = length * Math.tan(rad(angleDeg))
  ring(outer)
  const inner = length * Math.tan(rad(angleDeg * (1 - penumbra)))
  if (penumbra > 0.02 && inner > 1e-4) ring(inner)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2
    pts.push(0, 0, 0, Math.cos(a) * outer, Math.sin(a) * outer, -length)
  }
  return pts
}

function rebuildCone(entry) {
  if (!entry.cone) return
  // Drawn as long as the beam reaches, but never longer than a few characters' height.
  const length = Math.min(entry.range, Math.max(l.getSceneScale(), 0.5) * 4)
  entry.cone.geometry.dispose()
  entry.cone.geometry = new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute(coneVertices(length, entry.angle, entry.penumbra), 3),
  )
}

// Stamp every material in a subtree so the OutlineEffect skips it.
function excludeFromOutline(obj3d) {
  obj3d.traverse((obj) => {
    if (!obj.material) return
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of mats) mat.userData.outlineParameters = { visible: false }
  })
}

// Restrict placed lights to character layers. Layer 0 remains the global
// channel; character layers start at 1 so existing lights stay compatible.
export function setLightLinks(links = {}, characterOrder = []) {
  const layerByCharacter = new Map(characterOrder.map((id, index) => [id, index + 1]))
  for (const entry of l.lights) {
    const ids = links[entry.id]
    entry.light.layers.disableAll()
    if (!ids || ids.length === 0) {
      entry.light.layers.enable(0)
      continue
    }
    for (const id of ids) {
      const layer = layerByCharacter.get(id)
      if (layer != null && layer < 32) entry.light.layers.enable(layer)
    }
  }
  l.requestRender()
}