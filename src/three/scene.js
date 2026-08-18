import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
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
  initLights,
  addLight,
  removeLight,
  selectLight,
  setLightColor,
  setLightIntensity,
  setLightCastShadow,
  getLightsData,
  applyLightsData,
  clearLights,
  disposeLights,
  setViewCamera as setLightsViewCamera,
} from './lights.js'
import {
  initClothMod,
  disposeClothMod,
  clearAllCloth,
  clearClothForMeshes,
  stepClothLive,
  isClothEnabled,
  refreshClothForStyleChange,
  followIdleClothPose,
} from './clothmod.js'
import {
  initAnimation,
  setAnimationModel,
  setActiveAnimationCharacter,
  clearAnimationModel,
  isAnyPlaying,
  updateAnimation,
  scrub,
  selectClip,
  selectEdit,
  play,
  stop,
  getImportedClipsData,
  restoreImportedClips,
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
  setObjectStyle,
  setObjectOutline,
  applyAllObjectStyles,
  setObjectCastShadow,
  removeObject,
  resetObject,
  disposeObjects,
  setCharacterObject,
  setOnObjectMoveCommit,
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
  pmremGenerator: null,
  envMap: null, // baked studio-room environment texture, for IBL fill lighting
  envLightingOn: false,
  modelCenter: new THREE.Vector3(0, 1, 0),
  modelRadius: 1, // ~max model dimension, for light distance + shadow camera

  currentModel: null, // parsed result for the ACTIVE character (or null) — same object as characters.get(activeCharacterId)
  characters: new Map(), // id -> parsed model result, for every loaded character (active + inactive)
  activeCharacterId: null,
  viewCamera: null, // placed camera the viewport looks through (null = free view)
  transitionCamera: null, // scratch PerspectiveCamera used while gliding between views
  camTransition: null, // { elapsed, duration, fromPos, fromQuat, fromFov, toPos, toQuat, toFov, finalId } while gliding

  renderScheduled: false,
  continuous: false, // when true, render every frame (for animation playback)
  continuousReasons: new Set(), // who's asking for a continuous loop right now ('anim', 'cloth', …)
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
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    })
  } catch (err) {
    const message =
      err?.message || 'This browser environment cannot create a WebGL context.'
    useStore.getState().setLoadError(
      `Unable to start the 3D viewport. ${message}`,
    )
    return
  }

  if (!renderer?.domElement) {
    useStore.getState().setLoadError(
      'Unable to start the 3D viewport. The browser did not create a rendering canvas.',
    )
    return
  }
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

  // --- Environment (studio) lighting ---
  // A soft, neutral studio-room environment map baked once via PMREM, used as
  // image-based fill lighting — the same idea as Blender's "Material Preview"
  // viewport shading, which lights the scene with a generic studio HDRI so
  // nothing ever looks unlit/flat even before any lights are placed. It only
  // affects materials that read scene.environment (Standard mode); Toon/Unlit
  // are untouched. Off by default so it never changes an existing project's
  // look — see setEnvironmentLighting.
  const pmremGenerator = new THREE.PMREMGenerator(renderer)
  state.pmremGenerator = pmremGenerator
  state.envMap = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture

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
    getObjectByUuid: (uuid) => state.currentModel?.root?.getObjectByProperty?.('uuid', uuid) || null,
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
    // Camera cuts: glide the view to the cut camera (by name); a null cut
    // means "before the first cut" → glide back to the pre-play view. A cut
    // naming a deleted camera is ignored (the view just stays put).
    onCameraCut: (name, restViewId) => {
      const targetId = name == null ? restViewId ?? null : getCameraIdByName(name)
      if (name != null && targetId == null) return // cut names a deleted camera — ignore
      transitionViewCameraTo(targetId)
    },
    getFollowCameraCuts: () => useStore.getState().followCameraCuts,
    getViewCameraId: () => useStore.getState().viewCameraId,
    setViewCameraId: (id) => useStore.getState().setViewCameraId(id),
    transitionViewCameraId: (id) => transitionViewCameraTo(id),
  })

  // --- Scene objects (props / backgrounds with a move/rotate/scale gizmo) ---
  initObjects({ scene, camera, renderer, controls, requestRender })
  // "Auto-save movement": when the toggle is on and the object being dragged
  // is the active character, drop a root-motion keyframe at the playhead —
  // makes a mocap/borrowed clip "your own" without a separate manual step.
  setOnObjectMoveCommit((root) => {
    const st = useStore.getState()
    if (!st.autoKeyMovement) return
    if (!state.currentModel || root !== state.currentModel.root) return
    const fps = st.animFps || 24
    const raw = st.currentTime || 0
    const t = Math.round(raw * fps) / fps
    st.addRootKeyframe(t, root.position.toArray(), root.quaternion.toArray(), st.rippleRootEdit)
  })

  // --- Placeable cameras (frame shots, look through them, keyframe them) ---
  initCameras({
    scene,
    camera,
    renderer,
    controls,
    requestRender,
    getSceneScale: () => state.modelRadius,
  })

  // --- Placeable point lights (add and move light sources around the scene) ---
  initLights({
    scene,
    camera,
    renderer,
    controls,
    requestRender,
    getSceneScale: () => state.modelRadius,
  })

  // --- Cloth modifier (drape a selected mesh against the rest of the character) ---
  initClothMod({
    scene,
    camera,
    renderer,
    controls,
    requestRender,
    // Cloth playback shares the same continuous loop as animation playback
    // (see setContinuousRender's reason-counting below) instead of running
    // its own separate requestAnimationFrame — one loop, one clock, no risk
    // of the two stepping out of sync or fighting over on/off state.
    setContinuousRender: (on) => setContinuousRender(on, 'cloth'),
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
  setEnvironmentLighting(s.envLightingEnabled, s.envLightingIntensity)
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
  followIdleClothPose() // keep enabled-but-not-draping cloth tracking the body/gizmo, not frozen
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
// `reason` lets more than one system (animation playback, live cloth) ask for
// the loop without turning it off under each other's feet — the loop only
// actually stops once nobody has an active reason left.
export function setContinuousRender(on, reason = 'anim') {
  if (on) state.continuousReasons.add(reason)
  else state.continuousReasons.delete(reason)
  const shouldRun = state.continuousReasons.size > 0
  if (shouldRun === state.continuous) return
  state.continuous = shouldRun
  if (shouldRun) {
    if (state.clock) state.clock.getDelta() // reset delta so the first frame isn't a big jump
    const tick = () => {
      if (!state.continuous) return
      state.animId = requestAnimationFrame(tick)
      const delta = state.clock ? state.clock.getDelta() : 0
      // Smoothed FPS for the stats readout (only meaningful while playing).
      if (delta > 0) state.fps = state.fps * 0.9 + (1 / delta) * 0.1
      // Guarded: a thrown error in any one step (mixer, cloth playback, the
      // render call itself…) used to silently kill this frame's draw call —
      // since the next rAF was already scheduled above, playback LOOKED like
      // it was still running (time kept advancing) while the screen just
      // never updated again. Catch here so one bad frame logs a warning and
      // gets skipped instead of freezing everything after it.
      try {
        updateAnimation(delta) // advance the mixer before drawing
        stepClothLive(delta) // step any LIVE cloth sims, following the current pose
        updateCamTransition(delta) // glide any in-progress camera cut
        renderOnce()
      } catch (err) {
        console.error('Render tick failed, skipping this frame:', err)
      }
    }
    state.animId = requestAnimationFrame(tick)
  } else {
    cancelAnimationFrame(state.animId)
    state.fps = 0
    requestRender()
  }
}

// Move the playhead.
export function scrubTimeline(t) {
  scrub(t)
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

let characterIdCounter = 0

// Load a model file as the ACTIVE character.
//   addNew=false (default): replaces the active character in place (legacy
//     single-character behaviour — used by "load a different character").
//   addNew=true: keeps every existing character in the scene and adds this
//     one alongside them as a new, separately-posable character.
export async function loadModelFile(file, { addNew = false } = {}) {
  const store = useStore.getState()
  store.setLoading(true)
  try {
    const parsed = await loadModel(file)
    parsed.file = file // retain the source blob so the model can be saved to a project

    let id
    if (addNew && state.currentModel) {
      id = `char_${++characterIdCounter}`
      // Space new arrivals out along X so they don't spawn stacked on top of
      // one another; the user can reposition freely afterwards.
      parsed.root.position.x += state.characters.size * 1.5
    } else {
      // Replacing the active character (or this is the very first load).
      id = state.activeCharacterId || 'character'
      disposeCharacter(id) // free the previous occupant of this slot FIRST
    }

    state.scene.add(parsed.root)
    parsed.root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true
        o.receiveShadow = true
      }
    })
    state.characters.set(id, parsed)
    setCharacterObject(id, parsed.root, parsed.info.name) // make the character movable

    // Record the as-loaded (Standard/PBR) materials, then apply the active mode
    // + shading/outline settings. Non-destructive — originals are kept.
    recordOriginalMaterials(parsed)
    applyModelMaterials()

    if (addNew && state.currentModel) {
      useStore.getState().addCharacter(id, parsed.info)
    } else {
      useStore.getState().setModelInfo(parsed.info)
    }
    setActiveCharacter(id, parsed, { frame: true, isNewLoad: true })

    requestRender()
    return parsed
  } catch (err) {
    store.setLoadError(err.message || String(err))
    throw err
  }
}

// Make `id` the character that posing / mesh-edit / the transform gizmo
// operate on. Every OTHER loaded character stays in the scene exactly as
// posed AND KEEPS PLAYING its own animation/cloth in the background — only
// posing/mesh-edit are single-character-at-a-time by nature (there's one
// gizmo). `isNewLoad` is set by loadModelFile for a character's very first
// activation, which is when a fresh animation mixer needs to be created.
export function setActiveCharacter(id, parsedArg, { frame = false, isNewLoad = false } = {}) {
  const parsed = parsedArg || state.characters.get(id)
  if (!parsed) return
  if (state.activeCharacterId && state.activeCharacterId !== id) {
    clearPoseModel()
    clearMeshEditModel()
    // NOTE: animation and cloth are intentionally left running. Animation's
    // mixer keeps advancing every loaded character each frame regardless of
    // which one is active (see animation.js's updateAnimation), and cloth is
    // keyed per-mesh — so switching who you're EDITING doesn't interrupt
    // anyone else's playback or drape.
  }
  state.currentModel = parsed
  state.activeCharacterId = id
  setPoseModel(parsed) // capture rest pose + build the bone-dot overlay
  setMeshEditModel(parsed) // capture part rest transforms for Mesh mode
  if (isNewLoad) {
    setAnimationModel(parsed, id) // brand-new character: fresh mixer + baked clips
  } else {
    setActiveAnimationCharacter(id) // already loaded: just refocus editing, keep playing
  }
  useStore.getState().setActiveCharacterId(id)
  if (frame) frameCameraToObject(parsed.root)
  requestRender()
}

// Start every loaded character playing whatever clip/edit-source IT currently
// has selected (each character remembers its own activeClipName/playbackSource/
// animData — see the store's per-character fields). Characters with nothing
// selected are left alone. `loop`/`speed` default to the shared transport
// settings but can be overridden (e.g. a recorded shot always plays once,
// regardless of the loop toggle). Returns { started, maxDuration } —
// maxDuration is the longest of the clips just armed (seconds), 0 if none.
export function playAllCharacters({ loop, speed } = {}) {
  const store = useStore.getState()
  const opts = { loop: loop ?? store.loop, speed: speed ?? store.speed }
  const uiActiveId = state.activeCharacterId
  let started = 0
  let maxDuration = 0
  for (const id of store.characterOrder) {
    if (!state.characters.has(id)) continue
    const c = id === uiActiveId ? store : store.characters[id]
    if (!c) continue
    setActiveAnimationCharacter(id) // point the animation module's `a` proxy at this character
    let durSec = 0
    if (c.playbackSource === 'edit') {
      durSec = selectEdit(c.animData, store.animDuration, opts)
    } else if (c.activeClipName) {
      durSec = selectClip(c.activeClipName, opts, c.animData)
    }
    if (durSec > 0) {
      play()
      started++
      maxDuration = Math.max(maxDuration, durSec)
    }
  }
  setActiveAnimationCharacter(uiActiveId) // restore whichever character the UI is focused on
  if (started > 0) {
    useStore.setState({ playback: 'playing' })
    requestRender()
  }
  return { started, maxDuration }
}

// Stop every loaded character's playback (used by the Stop-all button and
// before a preview/recording pass, so a shot always starts from a clean rest).
export function stopAllCharacters() {
  const store = useStore.getState()
  const uiActiveId = state.activeCharacterId
  for (const id of store.characterOrder) {
    if (!state.characters.has(id)) continue
    setActiveAnimationCharacter(id)
    stop()
  }
  setActiveAnimationCharacter(uiActiveId)
  useStore.setState({ playback: 'stopped', currentTime: 0 })
}


// and drop it from the registry). If it was the active one, another loaded
// character (if any) becomes active.
export function removeCharacter(id) {
  disposeCharacter(id)
  useStore.getState().removeCharacter(id)
  const remaining = [...state.characters.keys()]
  if (state.activeCharacterId === id) {
    state.activeCharacterId = null
    state.currentModel = null
    if (remaining.length) setActiveCharacter(remaining[0])
  }
  requestRender()
}

// Free one character's Three.js graph without touching any other loaded
// character. Internal helper for both replace-in-place loads and removeCharacter.
function disposeCharacter(id) {
  const model = state.characters.get(id)
  if (!model) return
  if (state.activeCharacterId === id) {
    clearPoseModel()
    clearMeshEditModel()
  }
  clearAnimationModel(id) // only THIS character's mixer/action
  if (!isAnyPlaying()) setContinuousRender(false)
  clearClothForMeshes(model.meshes) // only THIS character's cloth, others keep simulating
  clearCharacterObject(id)
  restoreOriginalMaterials(model)
  disposeGeneratedMaterials(model)
  state.scene.remove(model.root)
  disposeObject(model.root)
  state.characters.delete(id)
  if (state.currentModel === model) state.currentModel = null
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
  applyModelMaterials() // pick up the current Look settings immediately
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

// Style/outline a prop (updates the scene + the store). 'auto' matches the
// character's current Look; an explicit mode pins the prop regardless.
export function setObjectStyleById(id, style) {
  setObjectStyle(id, style)
  useStore.getState().setObjectStyle(id, style)
}

export function setObjectOutlineById(id, outline) {
  setObjectOutline(id, outline)
  useStore.getState().setObjectOutline(id, outline)
}

// Toggle whether a prop casts shadows (updates the scene + the store).
export function setObjectCastShadowById(id, castShadow) {
  setObjectCastShadow(id, castShadow)
  useStore.getState().setObjectCastShadow(id, castShadow)
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
  setActiveCameraBody(!!cam) // hide every camera body while looking through one
  if (cam && state.container) {
    cam.aspect = (state.container.clientWidth || 1) / (state.container.clientHeight || 1)
    cam.updateProjectionMatrix()
  }
  if (state.controls) {
    state.controls.locked = !!cam
    state.controls.enabled = !cam
  }
  const active = cam || state.camera
  setPosingViewCamera(active)
  setMeshEditViewCamera(active)
  setObjectsViewCamera(active)
  setCamerasViewCamera(active)
  setLightsViewCamera(active)
  requestRender()
}

// Glide the viewport from whatever it's currently looking through to camera
// `id` (or null = free view) over `duration` seconds, instead of hard-cutting.
// Drives a scratch camera each frame (see updateCamTransition) and swaps in
// the real target camera once the glide finishes.
const _wPos = new THREE.Vector3()
const _wQuat = new THREE.Quaternion()

// A placed camera (from getCameraById) is a child of its rig Group — the rig
// carries the actual position/rotation (including any "Key camera" motion),
// while the camera itself sits at local identity. Reading .position/
// .quaternion straight off it is always ~origin/identity, regardless of
// where it visually is — that's what was sending the glide to the floor.
// This always resolves the true WORLD transform, for a rig-parented camera
// or a parentless one (the free camera) alike.
function worldTransformOf(cam) {
  cam.getWorldPosition(_wPos)
  cam.getWorldQuaternion(_wQuat)
  return { pos: _wPos.clone(), quat: _wQuat.clone() }
}

export function transitionViewCameraTo(id, duration = 0.6) {
  const targetCam = id != null ? getCameraById(id) : state.camera
  if (!targetCam) return setViewCameraById(id)
  const fromCam = state.viewCamera || state.camera
  if (fromCam === targetCam) return // already there

  const from = worldTransformOf(fromCam)
  const to = worldTransformOf(targetCam)

  if (!state.transitionCamera) state.transitionCamera = state.camera.clone()
  const tc = state.transitionCamera
  tc.position.copy(from.pos)
  tc.quaternion.copy(from.quat)
  tc.fov = fromCam.fov
  tc.near = targetCam.near
  tc.far = targetCam.far
  tc.aspect = (state.container?.clientWidth || 1) / (state.container?.clientHeight || 1)
  tc.updateProjectionMatrix()

  state.viewCamera = tc
  setActiveCameraBody(true) // hide every camera body while gliding between shots
  if (state.controls) {
    state.controls.locked = true
    state.controls.enabled = false
  }
  const active = tc
  setPosingViewCamera(active)
  setMeshEditViewCamera(active)
  setObjectsViewCamera(active)
  setCamerasViewCamera(active)
  setLightsViewCamera(active)

  state.camTransition = {
    elapsed: 0,
    duration: Math.max(0.05, duration),
    fromPos: from.pos,
    fromQuat: from.quat,
    fromFov: fromCam.fov,
    toPos: to.pos,
    toQuat: to.quat,
    toFov: targetCam.fov,
    finalId: id,
  }
  requestRender()
}

const _tPos = new THREE.Vector3()
const _tQuat = new THREE.Quaternion()

// Advance an in-progress camera glide by `delta` seconds. Called every frame
// from the continuous render loop; a no-op when nothing is transitioning.
// Re-samples the target's WORLD transform every frame (not just at the
// start) — if the target is itself mid-keyframe-motion (a "Key camera" rig
// still animating, or another cut's rig that's driven by a track), gliding
// toward a moving target instead of a stale snapshot keeps this correct.
function updateCamTransition(delta) {
  const tr = state.camTransition
  if (!tr) return
  tr.elapsed += delta
  const f = Math.min(1, tr.elapsed / tr.duration)
  const eased = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2 // ease-in-out
  const targetCam = tr.finalId != null ? getCameraById(tr.finalId) : state.camera
  if (targetCam) {
    const to = worldTransformOf(targetCam)
    tr.toPos.copy(to.pos)
    tr.toQuat.copy(to.quat)
    tr.toFov = targetCam.fov
  }
  _tPos.lerpVectors(tr.fromPos, tr.toPos, eased)
  _tQuat.slerpQuaternions(tr.fromQuat, tr.toQuat, eased)
  const tc = state.transitionCamera
  tc.position.copy(_tPos)
  tc.quaternion.copy(_tQuat)
  tc.fov = tr.fromFov + (tr.toFov - tr.fromFov) * eased
  tc.updateProjectionMatrix()
  if (f >= 1) {
    state.camTransition = null
    if (state.controls) {
      state.controls.locked = state.viewCamera != null && state.viewCamera !== tc
      state.controls.enabled = state.viewCamera == null
    }
    // Land on the real camera object (not the scratch clone) exactly on
    // target, and sync the store so the Cameras panel's "current view"
    // indicator matches — going through the store here (rather than calling
    // setViewCameraById directly) means Viewport's viewCameraId effect does
    // the swap, so there's exactly one place that ever hard-sets the camera.
    useStore.getState().setViewCameraId(tr.finalId)
  }
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
  const data = {
    format: 'scene-v1',
    objects: getObjectsData(),
    cameras: getCamerasData(),
    lights: getLightsData(),
  }
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
  if (Array.isArray(json.lights)) {
    clearLights()
    const metas = applyLightsData(json.lights)
    useStore.setState({ sceneLights: metas, selectedLightId: null })
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
// Deliberately excludes anything per-character (mesh overrides, pose, anim) —
// those live inside each entry of the `characters` array instead.
function collectSettings() {
  const s = useStore.getState()
  return {
    materialMode: s.materialMode,
    toonSteps: s.toonSteps,
    rimLightEnabled: s.rimLightEnabled,
    rimLightIntensity: s.rimLightIntensity,
    rimLightColor: s.rimLightColor,
    lightIntensity: s.lightIntensity,
    lightAzimuth: s.lightAzimuth,
    lightElevation: s.lightElevation,
    envLightingEnabled: s.envLightingEnabled,
    envLightingIntensity: s.envLightingIntensity,
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
}

// Per-mesh overrides are keyed by mesh uuid, but uuids are regenerated every
// time the same file is reloaded. Remap to the mesh's INDEX so it survives a
// save→reload round-trip (index order is stable for the same file).
function meshOverridesByIndexFor(model, overridesByUuid) {
  const meshes = (model && model.info.meshes) || []
  const uuidToIndex = new Map(meshes.map((mesh, i) => [mesh.uuid, i]))
  const byIndex = {}
  for (const [uuid, ov] of Object.entries(overridesByUuid || {})) {
    const idx = uuidToIndex.get(uuid)
    if (idx != null) byIndex[idx] = ov
  }
  return byIndex
}

function meshOverridesFromIndex(model, byIndex) {
  const meshes = (model && model.info.meshes) || []
  const out = {}
  for (const [idx, ov] of Object.entries(byIndex || {})) {
    const mesh = meshes[Number(idx)]
    if (mesh) out[mesh.uuid] = ov
  }
  return out
}

// Build a complete, serializable-to-IndexedDB project record. Captures EVERY
// loaded character (not just the active one) — for whichever one isn't
// currently active, we briefly make it active to read its pose/mesh-edit/
// animation state through the normal capture path, then switch back. That
// happens synchronously within this function, so nothing visibly changes.
export function getProjectData() {
  const s = useStore.getState()
  const originalActiveId = state.activeCharacterId
  const characters = []

  for (const id of s.characterOrder) {
    const model = state.characters.get(id)
    if (!model || !model.file) continue

    if (id !== state.activeCharacterId) setActiveCharacter(id)
    const live = useStore.getState()

    characters.push({
      id,
      fileName: model.file.name,
      blob: model.file,
      transform: {
        position: model.root.position.toArray(),
        quaternion: model.root.quaternion.toArray(),
        scale: model.root.scale.toArray(),
      },
      pose: getPose(),
      meshEdits: getMeshEditsData(),
      meshOverridesByIndex: meshOverridesByIndexFor(model, live.meshOverrides),
      animData: live.animData,
      // BVH imports, ragdoll bakes, combined/trimmed clips — anything NOT
      // baked into the model file itself, so it isn't lost on reload.
      importedClips: getImportedClipsData(id),
      importedClipNames: live.importedClipNames,
      activeClipName: live.activeClipName,
      playbackSource: live.playbackSource,
      isActive: id === originalActiveId,
    })
  }

  if (originalActiveId && originalActiveId !== state.activeCharacterId) {
    setActiveCharacter(originalActiveId)
  }

  return {
    format: 'project-v2',
    settings: collectSettings(),
    characters,
    objects: getObjectsForSave(),
    cameras: getCamerasData(),
    lights: getLightsData(),
  }
}

// Restore a project record: tear down the current session, then rebuild every
// character, props/images, style settings and pose sequence from the saved
// blobs. Async — models are re-parsed from their blobs.
export async function applyProjectData(record) {
  if (!record || (record.format !== 'project-v1' && record.format !== 'project-v2')) {
    throw new Error('Not a valid saved project.')
  }
  const store = useStore.getState()

  // 1. Clear the current props/images, cameras and every character.
  for (const id of store.sceneObjects.filter((o) => !o.isCharacter).map((o) => o.id)) {
    removeObjectById(id)
  }
  setViewCameraById(null)
  clearCameras()
  useStore.setState({ sceneCameras: [], selectedCameraId: null, viewCameraId: null })
  clearLights()
  useStore.setState({ sceneLights: [], selectedLightId: null })
  disposeCurrentModel()

  // 2. Load every saved character. Older (project-v1) saves have a single
  // `record.character` instead of a `record.characters` array — normalise.
  const characterRecords = record.format === 'project-v1'
    ? (record.character ? [record.character] : [])
    : record.characters || []

  let activeIdToRestore = null
  for (let i = 0; i < characterRecords.length; i++) {
    const c = characterRecords[i]
    if (!c.blob) continue
    // The first character replaces the (already-empty) active slot; every
    // subsequent one is added alongside it as its own character.
    await loadModelFile(new File([c.blob], c.fileName), { addNew: i > 0 })
    const id = state.activeCharacterId // whatever we just loaded is now active
    const model = state.characters.get(id)

    if (c.transform) {
      model.root.position.fromArray(c.transform.position)
      model.root.quaternion.fromArray(c.transform.quaternion)
      model.root.scale.fromArray(c.transform.scale)
    }
    if (c.pose) {
      try {
        applyPose(c.pose)
      } catch {
        /* pose from a different rig — skip */
      }
    }
    applyMeshEditsData(c.meshEdits)
    if (c.meshOverridesByIndex) {
      useStore.setState({ meshOverrides: meshOverridesFromIndex(model, c.meshOverridesByIndex) })
    }
    // project-v1 saves (from before multi-character support) may have kept
    // the keyframe data at the top level (record.animData) instead of on
    // the character record itself — fall back to that so genuinely old save
    // files don't lose their animation, without touching the normal (v2,
    // per-character) path above.
    if (c.animData) useStore.setState({ animData: c.animData })
    else if (record.format === 'project-v1' && record.animData) {
      useStore.setState({ animData: record.animData })
    }
    // Restore any imported/generated clips (BVH, ragdoll bakes, combined/
    // trimmed) — these live on the model's mixer entry, not in animData, so
    // they need their own restore step — then bring back which clip/tab was
    // selected so the panel looks exactly like it did when saved.
    restoreImportedClips(id, c.importedClips)
    useStore.setState({
      importedClipNames: c.importedClipNames || (c.importedClips || []).map((j) => j.name),
      activeClipName: c.activeClipName ?? null,
      playbackSource: c.playbackSource || 'edit',
    })
    if (c.isActive || (record.format === 'project-v1' && i === 0)) activeIdToRestore = id
  }
  if (activeIdToRestore) setActiveCharacter(activeIdToRestore)

  // 3. Apply saved settings (AFTER the loads, which would otherwise reset them).
  const st = record.settings || {}
  // Legacy project-v1 saves kept mesh overrides at the top level of settings —
  // they already landed on the single character above via c.meshOverridesByIndex
  // in the branch above only for v2; handle the v1 shape here too.
  if (record.format === 'project-v1' && st.meshOverridesByIndex && state.currentModel) {
    useStore.setState({
      meshOverrides: meshOverridesFromIndex(state.currentModel, st.meshOverridesByIndex),
    })
  }
  const patch = {}
  for (const k of [
    'materialMode', 'toonSteps', 'rimLightEnabled', 'rimLightIntensity', 'rimLightColor',
    'lightIntensity', 'lightAzimuth', 'lightElevation',
    'envLightingEnabled', 'envLightingIntensity',
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
    if (obj.kind !== 'image') {
      // 'lit' is the old (pre-styles) save field: false meant "flat/unlit".
      // Map it onto the new style system so older project files still work.
      const style = obj.style || (obj.lit === false ? 'unlit' : 'auto')
      if (style !== 'auto') setObjectStyleById(meta.id, style)
      if (obj.outline) setObjectOutlineById(meta.id, true)
      if (obj.castShadow === false) setObjectCastShadowById(meta.id, false)
    }
  }

  // 4b. Recreate the placed cameras (procedural — no blobs involved).
  if (Array.isArray(record.cameras) && record.cameras.length) {
    const metas = applyCamerasData(record.cameras)
    useStore.setState({ sceneCameras: metas, selectedCameraId: null, viewCameraId: null })
  }

  // 4c. Recreate the placed lights (procedural — no blobs involved).
  if (Array.isArray(record.lights) && record.lights.length) {
    const metas = applyLightsData(record.lights)
    useStore.setState({ sceneLights: metas, selectedLightId: null })
  }

  // 5. (animData is already restored per-character inside the load loop
  // above — see step 2 — so there's nothing left to do here.)

  requestRender()
}

// Dispose EVERY loaded character (full reset — used by the "clear" button and
// full scene teardown). To remove a single character instead, use removeCharacter().
export function disposeCurrentModel() {
  for (const id of [...state.characters.keys()]) disposeCharacter(id)
  state.activeCharacterId = null
  useStore.getState().clearModel()
  useStore.setState({ characters: {}, characterOrder: [], activeCharacterId: null })
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
  const s = useStore.getState()
  const soften = s.softenEnabled ? s.softenAmount : 0
  const rimLight = {
    enabled: s.rimLightEnabled,
    intensity: s.rimLightIntensity,
    color: s.rimLightColor,
    direction: state.lightDir,
  }
  // Props/backgrounds follow the same style pipeline regardless of whether a
  // character is loaded yet — 'auto' ones track this change live, pinned
  // ones just pick up the shared toon/soften/rim/outline settings while
  // keeping their own mode.
  applyAllObjectStyles({
    mode: s.materialMode,
    toonSteps: s.toonSteps,
    soften,
    rimLight,
    outlineWidth: s.outlineWidth,
  })
  if (!state.currentModel) return
  applyMaterials(state.currentModel, {
    mode: s.materialMode,
    toonSteps: s.toonSteps,
    soften,
    overrides: s.meshOverrides,
    rimLight,
  })
  // Cloth proxies live outside the model's own scene graph (see clothmod.js),
  // so applyMaterials' traversal never touches them — just rebuild any
  // active drapes so their proxy material picks up the new style.
  refreshClothForStyleChange()
  // applyMaterials sets mesh.visible from the stored per-mesh override for
  // every mesh, with no idea that cloth has its own hidden real-mesh +
  // visible-proxy setup going on. Toggling visibility off/on for a cloth mesh
  // re-ran this and stomped the real mesh back to visible=true — leaving it
  // stacked right on top of its own still-visible draped proxy, which reads
  // as the mesh having been duplicated. Re-assert the hide here.
  for (const mesh of state.currentModel.meshes) {
    if (isClothEnabled(mesh.uuid)) mesh.visible = false
  }
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
  // Rim light (Cartoon/Soft Anime) is gated by this same direction, so keep it
  // in sync whenever the key light moves — cheap, no material rebuild.
  applyModelMaterials()
  requestRender()
}

// Toggle the baked studio-room environment map used as image-based fill
// light (Blender "Material Preview"-style HDRI). `intensity` scales it via
// Scene.environmentIntensity — the key/ambient lights above are unaffected,
// so this only adds soft all-round fill + reflections on top of them.
export function setEnvironmentLighting(enabled, intensity = 1) {
  if (!state.scene) return
  state.envLightingOn = !!enabled
  state.scene.environment = enabled ? state.envMap : null
  state.scene.environmentIntensity = intensity
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
  disposeLights()
  disposeClothMod()
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
  if (state.envMap) {
    state.envMap.dispose()
    state.envMap = null
  }
  if (state.pmremGenerator) {
    state.pmremGenerator.dispose()
    state.pmremGenerator = null
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