import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'

// ---------------------------------------------------------------------------
// Scene lights
//
// Placeable point lights on top of the app's built-in key light + ambient fill
// (see scene.js setLightSettings). Each is a THREE.PointLight plus a small
// unlit "bulb" sphere so it's visible and selectable, moved with a translate-
// only TransformControls gizmo — like a prop, but lighting instead of geometry.
//
// Not keyframed/animated (out of scope for now) — just placed and left there,
// same as an environment light in a photo shoot.
// ---------------------------------------------------------------------------

let idCounter = 0
let nameCounter = 0

const l = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  requestRender: () => {},
  getSceneScale: null, // () => rough model size, for default placement + bulb size

  transform: null,
  helper: null,
  lights: [], // { id, name, light, bulb }
  selected: null, // selected light (THREE.PointLight) or null
  gizmoGrabbed: false,
}

export function initLights(refs) {
  l.scene = refs.scene
  l.camera = refs.camera
  l.renderer = refs.renderer
  l.controls = refs.controls
  l.requestRender = refs.requestRender
  l.getSceneScale = refs.getSceneScale || (() => 1)

  const transform = new TransformControls(l.camera, l.renderer.domElement)
  transform.setMode('translate')
  transform.setSize(0.8)
  transform.addEventListener('dragging-changed', (e) => {
    l.controls.enabled = !e.value && !l.controls.locked
    if (e.value) l.gizmoGrabbed = true
  })
  transform.addEventListener('objectChange', () => l.requestRender())
  l.transform = transform

  const helper = transform.getHelper()
  excludeFromOutline(helper)
  l.scene.add(helper)
  l.helper = helper
}

// Add a point light near the model, slightly up and to the side so it doesn't
// start out coincident with the key light.
export function addLight() {
  const id = ++idCounter
  const name = `Light ${++nameCounter}`
  const scale = Math.max(l.getSceneScale(), 0.5)

  const light = new THREE.PointLight(0xffffff, 2.0, 0, 2)
  light.name = name
  light.position.set(scale * 1.2, scale * 1.8, scale * 1.2)
  light.castShadow = false

  const bulb = makeBulb(scale, light.color)
  light.add(bulb)

  l.scene.add(light)
  l.lights.push({ id, name, light, bulb })
  l.requestRender()
  return {
    id,
    name,
    color: '#' + light.color.getHexString(),
    intensity: light.intensity,
    castShadow: light.castShadow,
  }
}

export function removeLight(id) {
  const idx = l.lights.findIndex((e) => e.id === id)
  if (idx < 0) return
  const entry = l.lights[idx]
  if (l.selected === entry.light) {
    l.transform.detach()
    l.selected = null
  }
  l.scene.remove(entry.light)
  disposeBulb(entry.bulb)
  l.lights.splice(idx, 1)
  l.requestRender()
}

// Attach the gizmo to a light (or null to detach).
export function selectLight(id) {
  if (!l.transform) return
  const entry = l.lights.find((e) => e.id === id)
  l.selected = entry ? entry.light : null
  if (l.selected) l.transform.attach(l.selected)
  else l.transform.detach()
  l.requestRender()
}

// See consumeObjectGizmoGrab() in objects.js for what this is for.
export function consumeLightGizmoGrab() {
  const grabbed = l.gizmoGrabbed
  l.gizmoGrabbed = false
  return grabbed
}

export function setLightColor(id, hex) {
  const entry = l.lights.find((e) => e.id === id)
  if (!entry) return
  entry.light.color.set(hex)
  entry.bulb.material.color.set(hex) // bulb material holds its own copy, not a live reference
  l.requestRender()
}

export function setLightIntensity(id, intensity) {
  const entry = l.lights.find((e) => e.id === id)
  if (!entry) return
  entry.light.intensity = intensity
  l.requestRender()
}

export function setLightCastShadow(id, castShadow) {
  const entry = l.lights.find((e) => e.id === id)
  if (!entry) return
  entry.light.castShadow = castShadow
  if (castShadow) {
    entry.light.shadow.mapSize.set(1024, 1024)
    entry.light.shadow.bias = -0.001
  }
  l.requestRender()
}

// --- Save / load ---------------------------------------------------------------

export function getLightsData() {
  return l.lights.map((entry) => ({
    name: entry.name,
    color: '#' + entry.light.color.getHexString(),
    intensity: entry.light.intensity,
    castShadow: entry.light.castShadow,
    position: entry.light.position.toArray(),
  }))
}

export function applyLightsData(list) {
  if (!Array.isArray(list)) return []
  const metas = []
  for (const item of list) {
    const meta = addLight()
    const entry = l.lights.find((e) => e.id === meta.id)
    if (item.name) {
      entry.name = item.name
      entry.light.name = item.name
      meta.name = item.name
      const n = /^Light (\d+)$/.exec(item.name)
      if (n) nameCounter = Math.max(nameCounter, Number(n[1]))
    }
    if (item.color) setLightColor(meta.id, item.color)
    if (item.intensity != null) setLightIntensity(meta.id, item.intensity)
    if (item.castShadow) setLightCastShadow(meta.id, true)
    if (item.position) entry.light.position.fromArray(item.position)
    metas.push({
      id: meta.id,
      name: entry.name,
      color: '#' + entry.light.color.getHexString(),
      intensity: entry.light.intensity,
      castShadow: entry.light.castShadow,
    })
  }
  l.requestRender()
  return metas
}

// Remove every light (project load starts from a clean slate).
export function clearLights() {
  if (l.transform) l.transform.detach()
  l.selected = null
  for (const entry of l.lights) {
    l.scene?.remove?.(entry.light)
    disposeBulb(entry.bulb)
  }
  l.lights = []
  l.requestRender()
}

// Swap the camera the gizmo raycasts/sizes against (view-through-camera mode).
export function setViewCamera(camera) {
  if (l.transform) l.transform.camera = camera
}

export function disposeLights() {
  clearLights()
  if (l.helper && l.scene) l.scene.remove(l.helper)
  if (l.transform) {
    l.transform.dispose()
    l.transform = null
  }
  l.helper = null
  l.scene = null
  l.camera = null
  l.renderer = null
  l.controls = null
}

// --- internals ---------------------------------------------------------------

// A small unlit sphere marking the light's position, tinted to match its
// colour at creation time (setLightColor keeps it in sync — the material
// holds its own copy of the colour, not a live reference to the light's).
function makeBulb(sceneScale, color) {
  const r = Math.max(sceneScale, 0.5) * 0.06
  const geo = new THREE.SphereGeometry(r, 12, 8)
  const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.userData.isLightBulb = true
  excludeFromOutline(mesh)
  return mesh
}

function disposeBulb(bulb) {
  bulb.geometry.dispose()
  bulb.material.dispose()
}

// Stamp every material in a subtree so the OutlineEffect skips it.
function excludeFromOutline(obj3d) {
  obj3d.traverse((obj) => {
    if (!obj.material) return
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of mats) mat.userData.outlineParameters = { visible: false }
  })
}