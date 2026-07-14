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
  setViewCamera as setPosingViewCamera,
} from './posing.js'
import {
  initCameras,
  getCameraById,
  getCameraIdByName,
  setActiveCameraBody,
  getCamerasData,
  applyCamerasData,
  clearCameras,
  disposeCameras,
  setViewCamera as setCamerasViewCamera,
} from './cameras.js'
import {
  initAnimation,
  setAnimationModel,
  clearAnimationModel,
  updateAnimation,
} from './animation.js'
import {
  initMeshEdit,
  setMeshEditModel,
  clearMeshEditModel,
  updateMeshEditHelpers,
  disposeMeshEdit,
  getMeshEditsData,
  applyMeshEditsData,
  suspendMeshEdit,
  resumeMeshEdit,
  setViewCamera as setMeshEditViewCamera,
} from './meshedit.js'
import {
  initObjects,
  addObject,
  addImage,
  setObjectVisible,
  setObjectTransform,
  removeObject,
  resetObject,
  disposeObjects,
  setCharacterObject,
  clearCharacterObject,
  getObjectsData,
  applyObjectsData,
  getObjectsForSave,
  setViewCamera as setObjectsViewCamera,
} from './objects.js'
import { getPose, applyPose } from './posing.js'
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
  ground: null, // solid ground plane (toggleable)
  groundY: 0, // floor height (where the ground/shadow planes sit)
  shadow: null, // cheap blob ground shadow
  shadowReceiver: null, // plane that catches real cast shadows
  shadowOn: true, // master ground-shadow toggle
  shadowMap: false, // real shadow mapping vs blob
  dirLight: null,
  ambientLight: null,
  lightDir: new THREE.Vector3(0.3, 0.6, 0.7), // unit direction to the key light
  modelCenter: new THREE.Vector3(0, 1, 0),
  modelRadius: 1, // ~max model dimension, for light distance + shadow camera

  currentModel: null, // parsed result from loadGLB (or null)
  viewCamera: null, // placed camera the viewport looks through (null = free view)

  renderScheduled: false,
  continuous: false, // when true, render every frame (for animation playback)
  animId: 0,
  clock: null, // THREE.Clock for per-frame deltas while playing
  fps: 0, // smoothed frames-per-second while playing (for the stats readout)
  recorder: null, // MediaRecorder while capturing a video
  recordedChunks: [],
  resizeObserver: null,
}

export function initScene(container) {
  if (state.renderer) return // already initialised

  state.container = container
  const width = container.clientWidth || 1
  const height = container.clientHeight || 1

  // --- Renderer ---
  // alpha:true + no scene.background => transparent output (for compositing).
  // preserveDrawingBuffer:true is required so we can read pixels for PNG export.
  // antialias:true for clean edges.
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)) // cap DPR (memory)
  renderer.setSize(width, height)
  renderer.setClearColor(0x000000, 0) // fully transparent clear
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true // used only when "realistic shadows" is on
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
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
    // Any pose edit bumps a counter so the rotation sliders re-read the bone.
    onPoseChange: () => useStore.getState().bumpPoseVersion(),
  })

  // --- Mesh editing (part gizmo + click-to-pick, active in Mesh mode) ---
  initMeshEdit({
    scene,
    camera,
    renderer,
    controls,
    requestRender,
    onSelect: (uuid) => useStore.getState().setSelectedMeshUuid(uuid),
    onChange: () => useStore.getState().bumpMeshVersion(),
  })

  // --- Animation (baked clips + in-app keyframing) ---
  state.clock = new THREE.Clock()
  initAnimation({
    requestRender,
    setContinuousRender,
    // Playback drives bones AND keyed parts, so both editors step aside.
    suspendPosing: () => {
      suspendPosing()
      suspendMeshEdit()
    },
    resumePosing: () => {
      resumePosing()
      resumeMeshEdit()
    },
    onTime: (t) => useStore.getState().setCurrentTime(t),
    onEnded: () => useStore.getState().setPlayback('paused'),
    // Camera cuts: switch the view to the cut camera (by name); a null cut
    // means "before the first cut" → show the pre-play view again. A cut
    // naming a deleted camera is ignored (the view just stays put).
    onCameraCut: (name, restViewId) => {
      const store = useStore.getState()
      if (name == null) return store.setViewCameraId(restViewId ?? null)
      const id = getCameraIdByName(name)
      if (id != null) store.setViewCameraId(id)
    },
    getViewCameraId: () => useStore.getState().viewCameraId,
    setViewCameraId: (id) => useStore.getState().setViewCameraId(id),
  })

  // --- Scene objects (props / backgrounds with a move/rotate/scale gizmo) ---
  initObjects({ scene, camera, renderer, controls, requestRender })

  // --- Placeable cameras (frame shots, look through them, keyframe them) ---
  initCameras({
    scene,
    camera,
    renderer,
    controls,
    requestRender,
    getSceneScale: () => state.modelRadius,
  })

  // --- Lights (only affect Toon/Standard modes; harmless in Unlit) ---
  const dirLight = new THREE.DirectionalLight(0xffffff, 2.0)
  dirLight.position.set(2, 4, 3)
  dirLight.castShadow = false // enabled only in "realistic shadows" mode
  // Larger map keeps shadows crisp over the wide frustum (positionLight sizes it
  // to cover props + root-motion, not just the character).
  dirLight.shadow.mapSize.set(4096, 4096)
  dirLight.shadow.bias = -0.0005
  scene.add(dirLight)
  scene.add(dirLight.target) // shadow camera aims at the model via this target
  state.dirLight = dirLight

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
  scene.add(ambientLight)
  state.ambientLight = ambientLight

  // --- Grid helper (toggleable) ---
  const gridHelper = new THREE.GridHelper(10, 20, 0x555a66, 0x33363f)
  scene.add(gridHelper)
  state.gridHelper = gridHelper

  // --- Solid ground plane (toggleable; also the floor the ragdoll lands on) ---
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(1, 64),
    new THREE.MeshStandardMaterial({ color: 0x2b2e36, roughness: 1, metalness: 0 }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.scale.set(10, 10, 1)
  ground.renderOrder = -2 // draw before the blob shadow (which skips depth writes)
  ground.receiveShadow = true
  ground.visible = false
  ground.material.userData.outlineParameters = { visible: false } // never outline it
  scene.add(ground)
  state.ground = ground

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

  // --- Real cast-shadow receiver (transparent plane that shows only shadows) ---
  const receiver = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({ opacity: 0.35 }),
  )
  receiver.rotation.x = -Math.PI / 2
  receiver.receiveShadow = true
  receiver.visible = false
  receiver.material.userData.outlineParameters = { visible: false }
  scene.add(receiver)
  state.shadowReceiver = receiver

  // --- Sync initial UI toggles from the store ---
  const s = useStore.getState()
  setGridVisible(s.showGrid)
  setGroundVisible(s.showGround)
  setBackground(s.solidBackground, s.backgroundColor)
  setLightSettings(s.lightIntensity, s.lightAzimuth, s.lightElevation)
  setOutlineEnabled(s.outlineEnabled)
  setShadowVisible(s.showShadow)
  setShadowMapping(s.shadowMapping)

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
  updateMeshEditHelpers() // keep the part-selection box hugging its mesh
  const camera = state.viewCamera || state.camera
  // Route through the outline effect. When the outline is disabled it falls
  // straight through to renderer.render, so there's no overhead when it's off.
  const effect = getOutlineEffect()
  if (effect) effect.render(state.scene, camera)
  else state.renderer.render(state.scene, camera)
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
  if (state.viewCamera) {
    state.viewCamera.aspect = width / height
    state.viewCamera.updateProjectionMatrix()
  }
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
    parsed.file = file // retain the source blob so the model can be saved to a project
    state.currentModel = parsed
    state.scene.add(parsed.root)
    parsed.root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true
        o.receiveShadow = true
      }
    })
    setCharacterObject(parsed.root, parsed.info.name) // make the character movable

    // Record the as-loaded (Standard/PBR) materials, then apply the active mode
    // + shading/outline settings. Non-destructive — originals are kept.
    recordOriginalMaterials(parsed)
    applyModelMaterials()
    setPoseModel(parsed) // capture rest pose + build the bone-dot overlay
    setMeshEditModel(parsed) // capture part rest transforms for Mesh mode
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

// ---------------------------------------------------------------------------
// Scene objects (props / backgrounds) — independent of the character model
// ---------------------------------------------------------------------------

// Load a file and add it as a movable scene object (does NOT replace the
// character). Selects it so the gizmo is ready. Errors propagate to the caller.
export async function addObjectFile(file) {
  const parsed = await loadModel(file)
  const meta = addObject(parsed, parsed.info.name, parsed.info.format, file)
  useStore.getState().addSceneObject(meta) // sets selectedObjectId = meta.id
  requestRender()
  return meta
}

// Load an image file and add it as a movable reference plane. Like addObjectFile
// it does NOT replace the character and selects the new plane so the gizmo is
// ready. Errors propagate to the caller.
export async function addImageFile(file) {
  const { texture, aspect } = await loadImageTexture(file)
  const name = file.name.replace(/\.[^.]+$/, '')
  const meta = addImage(texture, name, aspect, file)
  useStore.getState().addSceneObject({ ...meta, kind: 'image' })
  requestRender()
  return meta
}

// Decode an image File into a THREE.Texture (+ its width/height aspect ratio).
function loadImageTexture(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    new THREE.TextureLoader().load(
      url,
      (texture) => {
        URL.revokeObjectURL(url)
        texture.colorSpace = THREE.SRGBColorSpace // treat the image as sRGB
        const img = texture.image
        const aspect = img && img.height ? img.width / img.height : 1
        resolve({ texture, aspect })
      },
      undefined,
      () => {
        URL.revokeObjectURL(url)
        reject(new Error('Could not read that image file.'))
      },
    )
  })
}

export function removeObjectById(id) {
  removeObject(id)
  useStore.getState().removeSceneObject(id)
  requestRender()
}

// Show/hide a prop, image, or the character (updates the scene + the store).
export function setObjectVisibleById(id, visible) {
  setObjectVisible(id, visible)
  useStore.getState().setObjectVisible(id, visible)
}

export function resetObjectById(id) {
  resetObject(id)
}

// ---------------------------------------------------------------------------
// View-through-camera: render the viewport from a placed camera
// ---------------------------------------------------------------------------

// Switch the viewport to look through a placed camera (or null = free view).
// Orbit is locked while inside a camera (the camera is moved with its gizmo or
// keyframes, not by orbiting); every gizmo/picker is retargeted to the active
// camera so interaction still works in the camera view.
export function setViewCameraById(id) {
  const cam = id != null ? getCameraById(id) : null
  state.viewCamera = cam
  setActiveCameraBody(cam ? id : null) // hide the body of the camera we're inside
  if (cam && state.container) {
    cam.aspect = (state.container.clientWidth || 1) / (state.container.clientHeight || 1)
    cam.updateProjectionMatrix()
  }
  state.controls.locked = !!cam
  state.controls.enabled = !cam
  const active = cam || state.camera
  setPosingViewCamera(active)
  setMeshEditViewCamera(active)
  setObjectsViewCamera(active)
  setCamerasViewCamera(active)
  requestRender()
}

// Current character root transform (for "keyframe position" root motion).
export function getCharacterRootTransform() {
  if (!state.currentModel) return null
  const r = state.currentModel.root
  return { pos: r.position.toArray(), quat: r.quaternion.toArray() }
}

// ---------------------------------------------------------------------------
// Export: PNG, video recording, fullscreen
// ---------------------------------------------------------------------------

function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Render the current frame at `scale`× the viewport resolution and save a PNG.
// Transparent background is preserved (alpha), so it drops into 2D art.
export function exportPNG(scale = 2, name = 'render') {
  if (!state.renderer || !state.container) return
  const w = state.container.clientWidth || 1
  const h = state.container.clientHeight || 1
  state.renderer.setSize(w * scale, h * scale, false) // false: keep CSS size, bigger buffer
  renderOnce()
  state.renderer.domElement.toBlob((blob) => {
    if (blob) downloadBlob(blob, `${name}_${timestamp()}.png`)
    state.renderer.setSize(w, h, false) // restore
    requestRender()
  }, 'image/png')
}

// True if the browser can record the canvas to a video.
export function canRecordVideo() {
  return typeof MediaRecorder !== 'undefined' && !!state.renderer?.domElement?.captureStream
}

// Start recording the live canvas to a webm video. Returns false if unsupported.
export function startRecording(fps = 30) {
  if (!canRecordVideo()) return false
  const stream = state.renderer.domElement.captureStream(fps)
  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || ''
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  state.recordedChunks = []
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) state.recordedChunks.push(e.data)
  }
  recorder.start()
  state.recorder = recorder
  return true
}

// Stop recording and download the webm.
export function stopRecordingAndDownload(name = 'animation') {
  const recorder = state.recorder
  if (!recorder) return
  recorder.onstop = () => {
    const blob = new Blob(state.recordedChunks, { type: 'video/webm' })
    downloadBlob(blob, `${name}_${timestamp()}.webm`)
    state.recordedChunks = []
  }
  recorder.stop()
  state.recorder = null
}

// Enter fullscreen on the viewport (Esc exits — browser default).
export function enterFullscreen() {
  const el = state.container && state.container.parentElement
  if (el && el.requestFullscreen) el.requestFullscreen()
}

// ---------------------------------------------------------------------------
// Scene save / load (layout: character + object transforms + current pose)
// ---------------------------------------------------------------------------

// Capture the placement of the character and every prop, plus the current pose.
// NOTE: this stores TRANSFORMS, not geometry — reload the same files, then Load
// scene to restore where everything sat.
export function getSceneData() {
  const data = { format: 'scene-v1', objects: getObjectsData(), cameras: getCamerasData() }
  if (state.currentModel) {
    const root = state.currentModel.root
    data.character = {
      name: state.currentModel.info.name,
      position: root.position.toArray(),
      quaternion: root.quaternion.toArray(),
      scale: root.scale.toArray(),
      pose: getPose(),
      meshEdits: getMeshEditsData(),
    }
  }
  return data
}

// Apply a saved scene layout to what's currently loaded (matched by name).
export function applySceneData(json) {
  if (!json || json.format !== 'scene-v1') {
    throw new Error('Not a valid scene file (expected format "scene-v1").')
  }
  if (json.character && state.currentModel) {
    const root = state.currentModel.root
    const c = json.character
    if (c.position) root.position.fromArray(c.position)
    if (c.quaternion) root.quaternion.fromArray(c.quaternion)
    if (c.scale) root.scale.fromArray(c.scale)
    if (c.pose) {
      try {
        applyPose(c.pose)
      } catch {
        /* pose from a different rig — skip */
      }
    }
    applyMeshEditsData(c.meshEdits)
  }
  applyObjectsData(json.objects)
  if (Array.isArray(json.cameras)) {
    clearCameras()
    const metas = applyCamerasData(json.cameras)
    useStore.setState({ sceneCameras: metas, selectedCameraId: null, viewCameraId: null })
  }
  requestRender()
}

// ---------------------------------------------------------------------------
// Full project save / load (model + props + images + pose seq + style settings)
//
// Unlike the transforms-only scene file above, this captures the actual source
// FILE BLOBS so a whole session can be restored. The record is stored in
// IndexedDB by ProjectPanel; here we only build and apply the data.
// ---------------------------------------------------------------------------

// The style settings we persist (a subset of the store that isn't derivable).
function collectSettings() {
  const s = useStore.getState()
  const settings = {
    materialMode: s.materialMode,
    toonSteps: s.toonSteps,
    lightIntensity: s.lightIntensity,
    lightAzimuth: s.lightAzimuth,
    lightElevation: s.lightElevation,
    outlineEnabled: s.outlineEnabled,
    outlineWidth: s.outlineWidth,
    softenEnabled: s.softenEnabled,
    softenAmount: s.softenAmount,
    showGrid: s.showGrid,
    showGround: s.showGround,
    limbLimits: s.limbLimits,
    solidBackground: s.solidBackground,
    backgroundColor: s.backgroundColor,
    showShadow: s.showShadow,
    shadowMapping: s.shadowMapping,
    animFps: s.animFps,
    animDuration: s.animDuration,
  }
  // Per-mesh overrides are keyed by mesh uuid, but uuids are regenerated every
  // time the same file is reloaded. Remap to the mesh's INDEX so it survives a
  // save→reload round-trip (index order is stable for the same file).
  const meshes = (state.currentModel && state.currentModel.info.meshes) || []
  const uuidToIndex = new Map(meshes.map((m, i) => [m.uuid, i]))
  const byIndex = {}
  for (const [uuid, ov] of Object.entries(s.meshOverrides)) {
    const idx = uuidToIndex.get(uuid)
    if (idx != null) byIndex[idx] = ov
  }
  settings.meshOverridesByIndex = byIndex
  return settings
}

// Build a complete, serializable-to-IndexedDB project record.
export function getProjectData() {
  const s = useStore.getState()
  let character = null
  if (state.currentModel && state.currentModel.file) {
    const root = state.currentModel.root
    character = {
      fileName: state.currentModel.file.name,
      blob: state.currentModel.file,
      transform: {
        position: root.position.toArray(),
        quaternion: root.quaternion.toArray(),
        scale: root.scale.toArray(),
      },
      pose: getPose(),
      meshEdits: getMeshEditsData(),
    }
  }
  return {
    format: 'project-v1',
    settings: collectSettings(),
    character,
    objects: getObjectsForSave(),
    cameras: getCamerasData(),
    animData: s.animData,
  }
}

// Restore a project record: tear down the current session, then rebuild the
// character, props/images, style settings and pose sequence from the saved
// blobs. Async — models are re-parsed from their blobs.
export async function applyProjectData(record) {
  if (!record || record.format !== 'project-v1') {
    throw new Error('Not a valid saved project.')
  }
  const store = useStore.getState()

  // 1. Clear the current props/images, cameras and the character.
  for (const id of store.sceneObjects.filter((o) => !o.isCharacter).map((o) => o.id)) {
    removeObjectById(id)
  }
  setViewCameraById(null)
  clearCameras()
  useStore.setState({ sceneCameras: [], selectedCameraId: null, viewCameraId: null })
  disposeCurrentModel()

  // 2. Load the character (this resets much of the store via setModelInfo).
  if (record.character && record.character.blob) {
    const c = record.character
    await loadModelFile(new File([c.blob], c.fileName))
    const root = state.currentModel.root
    if (c.transform) {
      root.position.fromArray(c.transform.position)
      root.quaternion.fromArray(c.transform.quaternion)
      root.scale.fromArray(c.transform.scale)
    }
    if (c.pose) {
      try {
        applyPose(c.pose)
      } catch {
        /* pose from a different rig — skip */
      }
    }
    applyMeshEditsData(c.meshEdits)
  }

  // 3. Apply saved settings (AFTER the load, which would otherwise reset them).
  const st = record.settings || {}
  const meshes = (state.currentModel && state.currentModel.info.meshes) || []
  const meshOverrides = {}
  for (const [idx, ov] of Object.entries(st.meshOverridesByIndex || {})) {
    const m = meshes[Number(idx)]
    if (m) meshOverrides[m.uuid] = ov
  }
  const patch = { meshOverrides }
  for (const k of [
    'materialMode', 'toonSteps', 'lightIntensity', 'lightAzimuth', 'lightElevation',
    'outlineEnabled', 'outlineWidth', 'softenEnabled', 'softenAmount',
    'showGrid', 'showGround', 'limbLimits', 'solidBackground', 'backgroundColor', 'showShadow', 'shadowMapping',
    'animFps', 'animDuration',
  ]) {
    if (st[k] !== undefined) patch[k] = st[k]
  }
  useStore.setState(patch) // Viewport effects push these into the scene reactively

  // 4. Re-add props/images in order, restoring transform + visibility.
  for (const obj of record.objects || []) {
    if (!obj.blob) continue
    const file = new File([obj.blob], obj.fileName)
    const meta = obj.kind === 'image' ? await addImageFile(file) : await addObjectFile(file)
    setObjectTransform(meta.id, obj.transform)
    setObjectVisibleById(meta.id, obj.visible !== false)
  }

  // 4b. Recreate the placed cameras (procedural — no blobs involved).
  if (Array.isArray(record.cameras) && record.cameras.length) {
    const metas = applyCamerasData(record.cameras)
    useStore.setState({ sceneCameras: metas, selectedCameraId: null, viewCameraId: null })
  }

  // 5. Restore the pose / keyframe sequence.
  useStore.getState().setAnimData(record.animData || { tracks: {}, root: [] })

  requestRender()
}

export function disposeCurrentModel() {
  if (!state.currentModel) return
  const model = state.currentModel
  setContinuousRender(false) // stop any playback before tearing the model down
  clearCharacterObject() // unregister the movable-character entry
  clearAnimationModel() // dispose the mixer
  clearPoseModel() // detach gizmo + remove bone overlay before the graph goes away
  clearMeshEditModel() // detach the part gizmo + drop mesh references
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

// Park the ground shadows under the model and size the shadow camera. Scale-aware
// so it works for both metre-scale glTF and centimetre-scale FBX.
function placeShadowUnder(box) {
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)
  state.modelCenter.copy(center)
  state.modelRadius = Math.max(maxDim, 0.5)
  state.groundY = box.min.y

  if (state.ground) {
    const r = maxDim * 6
    state.ground.scale.set(r, r, 1)
    // A hair below the shadow planes so they never z-fight with it.
    state.ground.position.set(center.x, box.min.y - maxDim * 0.002, center.z)
  }
  if (state.shadow) {
    // Much smaller now — just the contact footprint under the feet.
    const footprint = Math.max(size.x, size.z) * 0.7
    state.shadow.scale.set(footprint, footprint, 1)
    state.shadow.position.set(center.x, box.min.y + maxDim * 0.001, center.z)
  }
  if (state.shadowReceiver) {
    const r = maxDim * 6
    state.shadowReceiver.scale.set(r, r, 1)
    state.shadowReceiver.position.set(center.x, box.min.y, center.z)
  }
  positionLight()
}

// Position the key light along its direction, high and far enough out to cast
// shadows across a generous area — not just the character's bounding box, so
// props and root-motion movement stay shadowed. `r` ~ the model's max dimension.
function positionLight() {
  const dl = state.dirLight
  if (!dl) return
  const r = state.modelRadius
  const dist = Math.max(10, r * 6) // high & far so the frustum sits above the scene
  dl.position.copy(state.modelCenter).addScaledVector(state.lightDir, dist)
  dl.target.position.copy(state.modelCenter)
  dl.target.updateMatrixWorld()

  const cam = dl.shadow.camera
  const half = Math.max(r * 4, 1) // cover ±4× the model size around the centre
  cam.left = -half
  cam.right = half
  cam.top = half
  cam.bottom = -half
  cam.near = Math.max(0.01, dist - r * 5)
  cam.far = dist + r * 5
  cam.updateProjectionMatrix()
  // Scale-aware normal bias: bigger frustum = bigger texels, so offset along the
  // surface normal in world units to avoid acne without peter-panning.
  dl.shadow.normalBias = r * 0.02
}

// ---------------------------------------------------------------------------
// Display toggles (called from panels via the store subscription in Viewport)
// ---------------------------------------------------------------------------

export function setGridVisible(visible) {
  if (state.gridHelper) state.gridHelper.visible = visible
  requestRender()
}

export function setGroundVisible(visible) {
  if (state.ground) state.ground.visible = visible
  requestRender()
}

// The floor height (world Y) that the ground/shadow planes sit at — the surface
// a ragdolling character falls onto.
export function getGroundY() {
  return state.groundY
}

export function setShadowVisible(visible) {
  state.shadowOn = visible
  applyShadowMode()
}

export function setShadowMapping(on) {
  state.shadowMap = on
  applyShadowMode()
}

// The blob and the real cast-shadow are mutually exclusive: blob when shadows are
// on but shadow-mapping is off; real shadows when both are on.
function applyShadowMode() {
  const blobOn = state.shadowOn && !state.shadowMap
  const realOn = state.shadowOn && state.shadowMap
  if (state.shadow) state.shadow.visible = blobOn
  if (state.shadowReceiver) state.shadowReceiver.visible = realOn
  if (state.dirLight) state.dirLight.castShadow = realOn
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
// Material mode + lighting
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
  state.lightDir.set(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az),
  )
  positionLight() // reposition the light + shadow camera along the new direction
  requestRender()
}

// ---------------------------------------------------------------------------
// Teardown (called when the Viewport unmounts)
// ---------------------------------------------------------------------------

export function disposeScene() {
  setContinuousRender(false)
  disposeCurrentModel()
  disposeObjects()
  disposeCameras()
  disposePosing()
  disposeMeshEdit()
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
  if (state.ground) {
    state.ground.geometry.dispose()
    state.ground.material.dispose()
    state.ground = null
  }
  if (state.shadow) {
    state.shadow.geometry.dispose()
    if (state.shadow.material.map) state.shadow.material.map.dispose()
    state.shadow.material.dispose()
    state.shadow = null
  }
  if (state.shadowReceiver) {
    state.shadowReceiver.geometry.dispose()
    state.shadowReceiver.material.dispose()
    state.shadowReceiver = null
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
