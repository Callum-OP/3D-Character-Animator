import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { loadModel, disposeObject } from './loadModel.js'
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
  dirLight: null,
  ambientLight: null,

  currentModel: null, // parsed result from loadGLB (or null)

  renderScheduled: false,
  continuous: false, // when true, render every frame (for animation playback)
  animId: 0,
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

  // --- Sync initial UI toggles from the store ---
  const s = useStore.getState()
  setGridVisible(s.showGrid)
  setBackground(s.solidBackground, s.backgroundColor)

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
  state.renderer.render(state.scene, state.camera)
}

// Continuous render loop, used later for animation playback. Off by default.
export function setContinuousRender(on) {
  if (on === state.continuous) return
  state.continuous = on
  if (on) {
    const tick = () => {
      if (!state.continuous) return
      state.animId = requestAnimationFrame(tick)
      renderOnce()
    }
    state.animId = requestAnimationFrame(tick)
  } else {
    cancelAnimationFrame(state.animId)
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
  const { root } = state.currentModel
  state.scene.remove(root)
  disposeObject(root) // geometries, materials, textures
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
}

// ---------------------------------------------------------------------------
// Display toggles (called from panels via the store subscription in Viewport)
// ---------------------------------------------------------------------------

export function setGridVisible(visible) {
  if (state.gridHelper) state.gridHelper.visible = visible
  requestRender()
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
// Teardown (called when the Viewport unmounts)
// ---------------------------------------------------------------------------

export function disposeScene() {
  setContinuousRender(false)
  disposeCurrentModel()

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
