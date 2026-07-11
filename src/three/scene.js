import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { loadModel, disposeObject } from './loadModel.js'
import {
  recordOriginalMaterials,
  applyMaterials,
  restoreOriginalMaterials,
  disposeGeneratedMaterials,
} from './materials.js'
import {
  initOutline,
  getOutlineEffect,
  setOutlineEnabled,
  applyOutlineParams,
  disposeOutline,
} from './outline.js'
import {
  initPosing,
  setPoseModel,
  clearPoseModel,
  updateBoneHelpers,
  disposePosing,
  suspendPosing,
  resumePosing,
} from './posing.js'
import {
  initAnimation,
  setAnimationModel,
  clearAnimationModel,
  updateAnimation,
} from './animation.js'
import { useStore } from '../store.js'

// ---------------------------------------------------------------------------
// Scene manager (module singleton)
//
// Holds all the live Three.js objects. It is intentionally NOT React state:
// the viewport owns a single long-lived WebGL context, and panels talk to it
// through these functions rather than through props.
//
// Rendering is ON DEMAND. We do not run a requestAnimationFrame loop when idle.
// A frame is drawn only when something visibly changed: the camera moved, a
// model loaded, or a toggle flipped. `requestRender()` coalesces multiple
// change events in a single tick into one draw. A continuous loop mode exists
// for later phases (animation playback) but stays off by default.
// ---------------------------------------------------------------------------

const state = {
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  container: null,
  gridHelper: null,
  shadow: null, // cheap blob ground shadow (Phase 6)
  dirLight: null,
  ambientLight: null,

  currentModel: null, // parsed result from loadGLB (or null)

  renderScheduled: false,
  continuous: false, // when true, render every frame (for animation playback)
  animId: 0,
  clock: null, // THREE.Clock for per-frame deltas while playing
  fps: 0, // smoothed frames-per-second while playing (for the stats readout)
  resizeObserver: null,
}

export function initScene(container) {
  if (state.renderer) return // already initialised

  state.container = container
  const width = container.clientWidth || 1
  const height = container.clientHeight || 1

  // --- Renderer ---
  // alpha:true + no scene.background => transparent output (for compositing).
  // preserveDrawingBuffer:true is required so we can read pixels for PNG export
  // in Phase 5. antialias:true for clean edges.
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)) // cap DPR (memory)
  renderer.setSize(width, height)
  renderer.setClearColor(0x000000, 0) // fully transparent clear
  renderer.outputColorSpace = THREE.SRGBColorSpace
  container.appendChild(renderer.domElement)
  state.renderer = renderer

  // Wrap the renderer for the (optional) inverted-hull outline pass.
  initOutline(renderer)

  // --- Scene ---
  const scene = new THREE.Scene()
  // No scene.background => transparent by default. Toggled on via setBackground.
  state.scene = scene

  // --- Camera ---
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 1000)
  camera.position.set(0, 1.5, 3)
  state.camera = camera

  // --- Controls ---
  // enableDamping is OFF so on-demand rendering stays trivial: each pointer move
  // fires 'change' once and a single frame is drawn. Damping would need a loop
  // to settle. (Revisit if the motion feels too stiff.)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = false
  controls.target.set(0, 1, 0)
  controls.addEventListener('change', requestRender)
  controls.update()
  state.controls = controls

  // --- Bone posing (gizmo + pickable bone dots) ---
  initPosing({
    scene,
    camera,
    renderer,
    controls,
    requestRender,
    // Report viewport picks up to the store; the Viewport effect then drives
    // the actual gizmo attach via selectBone (single source of truth).
    onSelect: (name) => useStore.getState().setSelectedBoneName(name),
  })

  // --- Animation (baked clips + in-app keyframing) ---
  state.clock = new THREE.Clock()
  initAnimation({
    requestRender,
    setContinuousRender,
    suspendPosing,
    resumePosing,
    onTime: (t) => useStore.getState().setCurrentTime(t),
    onEnded: () => useStore.getState().setPlayback('paused'),
  })

  // --- Lights (only affect Toon/Standard modes in Phase 2; harmless in Unlit) ---
  const dirLight = new THREE.DirectionalLight(0xffffff, 2.0)
  dirLight.position.set(2, 4, 3)
  scene.add(dirLight)
  state.dirLight = dirLight

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
  scene.add(ambientLight)
  state.ambientLight = ambientLight

  // --- Grid helper (toggleable) ---
  const gridHelper = new THREE.GridHelper(10, 20, 0x555a66, 0x33363f)
  scene.add(gridHelper)
  state.gridHelper = gridHelper

  // --- Blob ground shadow (cheap: a soft radial sprite, not shadow mapping) ---
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: makeShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.6,
    }),
  )
  shadow.rotation.x = -Math.PI / 2 // lay flat on the ground
  shadow.renderOrder = -1 // draw before the model
  shadow.material.userData.outlineParameters = { visible: false } // never outline it
  scene.add(shadow)
  state.shadow = shadow

  // --- Sync initial UI toggles from the store ---
  const s = useStore.getState()
  setGridVisible(s.showGrid)
  setBackground(s.solidBackground, s.backgroundColor)
  setLightSettings(s.lightIntensity, s.lightAzimuth, s.lightElevation)
  setOutlineEnabled(s.outlineEnabled)
  setShadowVisible(s.showShadow)

  // --- Resize handling ---
  const resizeObserver = new ResizeObserver(() => handleResize())
  resizeObserver.observe(container)
  state.resizeObserver = resizeObserver

  requestRender()
}

// Coalesced single-frame render. Multiple calls in one tick => one draw.
export function requestRender() {
  if (state.continuous || state.renderScheduled || !state.renderer) return
  state.renderScheduled = true
  requestAnimationFrame(() => {
    state.renderScheduled = false
    renderOnce()
  })
}

function renderOnce() {
  if (!state.renderer) return
  updateBoneHelpers() // park bone dots on their (possibly just-moved) bones
  // Route through the outline effect. When the outline is disabled it falls
  // straight through to renderer.render, so there's no overhead when it's off.
  const effect = getOutlineEffect()
  if (effect) effect.render(state.scene, state.camera)
  else state.renderer.render(state.scene, state.camera)
}

// Continuous render loop, used later for animation playback. Off by default.
export function setContinuousRender(on) {
  if (on === state.continuous) return
  state.continuous = on
  if (on) {
    if (state.clock) state.clock.getDelta() // reset delta so the first frame isn't a big jump
    const tick = () => {
      if (!state.continuous) return
      state.animId = requestAnimationFrame(tick)
      const delta = state.clock ? state.clock.getDelta() : 0
      // Smoothed FPS for the stats readout (only meaningful while playing).
      if (delta > 0) state.fps = state.fps * 0.9 + (1 / delta) * 0.1
      updateAnimation(delta) // advance the mixer before drawing
      renderOnce()
    }
    state.animId = requestAnimationFrame(tick)
  } else {
    cancelAnimationFrame(state.animId)
    state.fps = 0
    requestRender()
  }
}

function handleResize() {
  const { container, renderer, camera } = state
  if (!container || !renderer) return
  const width = container.clientWidth || 1
  const height = container.clientHeight || 1
  renderer.setSize(width, height)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  requestRender()
}

// ---------------------------------------------------------------------------
// Model loading / disposal
// ---------------------------------------------------------------------------

export async function loadModelFile(file) {
  const store = useStore.getState()
  store.setLoading(true)
  try {
    const parsed = await loadModel(file)
    disposeCurrentModel() // free the previous model FIRST (memory hygiene)
    state.currentModel = parsed
    state.scene.add(parsed.root)

    // Record the as-loaded (Standard/PBR) materials, then apply the active mode
    // + shading/outline settings. Non-destructive — originals are kept.
    recordOriginalMaterials(parsed)
    applyModelMaterials()
    setPoseModel(parsed) // capture rest pose + build the bone-dot overlay
    setAnimationModel(parsed) // new mixer + baked clips

    frameCameraToObject(parsed.root)
    store.setModelInfo(parsed.info)
    requestRender()
    return parsed
  } catch (err) {
    store.setLoadError(err.message || String(err))
    throw err
  }
}

export function disposeCurrentModel() {
  if (!state.currentModel) return
  const model = state.currentModel
  setContinuousRender(false) // stop any playback before tearing the model down
  clearAnimationModel() // dispose the mixer
  clearPoseModel() // detach gizmo + remove bone overlay before the graph goes away
  // Put the real materials back so the deep-dispose walk frees them (and their
  // textures) rather than a generated shell that only borrows those textures...
  restoreOriginalMaterials(model)
  disposeGeneratedMaterials(model) // ...then free the generated Basic/Toon shells.
  state.scene.remove(model.root)
  disposeObject(model.root) // geometries, materials, textures
  state.currentModel = null
  useStore.getState().clearModel()
}

// Frame the camera so the whole model fits comfortably in view, and point the
// orbit target at its centre.
function frameCameraToObject(object) {
  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) return

  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())

  const maxDim = Math.max(size.x, size.y, size.z)
  const fov = (state.camera.fov * Math.PI) / 180
  // Distance so the largest dimension fits the vertical FOV, with padding.
  let dist = (maxDim / 2 / Math.tan(fov / 2)) * 1.4
  dist = Math.max(dist, 0.1)

  // Place the camera off to the front-side at a pleasant 3/4 angle.
  const dir = new THREE.Vector3(0.5, 0.35, 1).normalize()
  state.camera.position.copy(center.clone().add(dir.multiplyScalar(dist)))

  // Adjust clipping planes to the model's scale so it never gets clipped.
  state.camera.near = Math.max(dist / 1000, 0.001)
  state.camera.far = dist * 100
  state.camera.updateProjectionMatrix()

  state.controls.target.copy(center)
  state.controls.update()

  placeShadowUnder(box)
}

// Park the blob shadow on the ground under the model, sized to its footprint.
function placeShadowUnder(box) {
  if (!state.shadow) return
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const footprint = Math.max(size.x, size.z) * 1.6
  state.shadow.scale.set(footprint, footprint, 1)
  state.shadow.position.set(center.x, box.min.y + footprint * 0.001, center.z)
}

// ---------------------------------------------------------------------------
// Display toggles (called from panels via the store subscription in Viewport)
// ---------------------------------------------------------------------------

export function setGridVisible(visible) {
  if (state.gridHelper) state.gridHelper.visible = visible
  requestRender()
}

export function setShadowVisible(visible) {
  if (state.shadow) state.shadow.visible = visible
  requestRender()
}

// A soft radial gradient used as the blob-shadow texture (opaque centre → clear
// edge). Generated once on a small canvas — no external asset.
function makeShadowTexture() {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(0,0,0,0.55)')
  g.addColorStop(0.6, 'rgba(0,0,0,0.25)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

// Live renderer stats for the (optional) corner readout. Proves the low-overhead
// claim: triangle/draw counts, GPU resource counts, JS heap, and playback FPS.
export function getStats() {
  if (!state.renderer) return null
  const info = state.renderer.info
  const mem = typeof performance !== 'undefined' && performance.memory
  return {
    fps: state.continuous ? Math.round(state.fps) : null,
    triangles: info.render.triangles,
    calls: info.render.calls,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
  }
}

export function setBackground(solid, color) {
  if (!state.scene) return
  if (solid) {
    state.scene.background = new THREE.Color(color)
  } else {
    state.scene.background = null // transparent
  }
  requestRender()
}

// ---------------------------------------------------------------------------
// Material mode + lighting (Phase 2)
// ---------------------------------------------------------------------------

// Re-apply materials + outline to the loaded model from the current store state.
// This is the single entry point for any material/shading/outline-width change
// (mode, toon steps, soften, per-mesh overrides). No-op if nothing is loaded.
export function applyModelMaterials() {
  if (!state.currentModel) return
  const s = useStore.getState()
  const soften = s.softenEnabled ? s.softenAmount : 0
  applyMaterials(state.currentModel, {
    mode: s.materialMode,
    toonSteps: s.toonSteps,
    soften,
    overrides: s.meshOverrides,
  })
  // Materials may have been swapped; re-stamp outline params onto the live ones.
  applyOutlineParams(state.currentModel, s.outlineWidth, soften, s.meshOverrides)
  requestRender()
}

// Toggle the outline pass on/off (width/visibility come from applyModelMaterials).
export function setOutlineToggle(enabled) {
  setOutlineEnabled(enabled)
  requestRender()
}

// Position + brighten the key directional light from spherical angles. Azimuth
// sweeps around the vertical axis (0 = straight in front, +ve = to the right),
// elevation lifts it above the horizon. Radius is arbitrary — only direction
// matters for a DirectionalLight.
export function setLightSettings(intensity, azimuthDeg, elevationDeg) {
  if (!state.dirLight) return
  state.dirLight.intensity = intensity

  const az = (azimuthDeg * Math.PI) / 180
  const el = (elevationDeg * Math.PI) / 180
  const r = 5
  state.dirLight.position.set(
    r * Math.cos(el) * Math.sin(az),
    r * Math.sin(el),
    r * Math.cos(el) * Math.cos(az),
  )
  requestRender()
}

// ---------------------------------------------------------------------------
// Teardown (called when the Viewport unmounts)
// ---------------------------------------------------------------------------

export function disposeScene() {
  setContinuousRender(false)
  disposeCurrentModel()
  disposePosing()
  disposeOutline()

  if (state.resizeObserver) {
    state.resizeObserver.disconnect()
    state.resizeObserver = null
  }
  if (state.controls) {
    state.controls.removeEventListener('change', requestRender)
    state.controls.dispose()
    state.controls = null
  }
  if (state.gridHelper) {
    state.gridHelper.geometry.dispose()
    state.gridHelper.material.dispose()
    state.gridHelper = null
  }
  if (state.shadow) {
    state.shadow.geometry.dispose()
    if (state.shadow.material.map) state.shadow.material.map.dispose()
    state.shadow.material.dispose()
    state.shadow = null
  }
  if (state.renderer) {
    state.renderer.dispose()
    state.renderer.forceContextLoss()
    if (state.renderer.domElement && state.renderer.domElement.parentNode) {
      state.renderer.domElement.parentNode.removeChild(state.renderer.domElement)
    }
    state.renderer = null
  }
  state.scene = null
  state.camera = null
  state.container = null
}

// Expose current model reference for panels that need live objects later.
export function getCurrentModel() {
  return state.currentModel
}
