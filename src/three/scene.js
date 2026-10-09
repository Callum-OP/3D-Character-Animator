import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { loadModel, disposeObject } from './loadModel.js'
import { installShadowDarkening, setShadowDarkness } from './shadowDarkening.js'
import { VideoCapture, findVideoConfig, webCodecsAvailable } from './videoCapture.js'
import { computeOutputSize, videoBitrate, pickVideoFormat, MAX_VIDEO_SIDE } from './exportSize.js'
import { fitShadowExtents, needsRefit, collectFloorReceivers, probeFloor } from './shadowFit.js'
import {
  recordOriginalMaterials,
  applyMaterials,
  getTransparentMeshes,
  updateRimLightMaterials,
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
  initPostFX,
  resizePostFX,
  setDepthOfField,
  setBlurEffect,
  renderPostFX,
  disposePostFX,
} from './postfx.js'
import {
  initPosing,
  setPoseModel,
  clearPoseModel,
  updateBoneHelpers,
  disposePosing,
  suspendPosing,
  resumePosing,
  getBoneByName,
  setViewCamera as setPosingViewCamera,
  refreshPoseOverlays,
} from './posing.js'
import {
  initCameras,
  getCameraById,
  getCameraRigById,
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
  setLightDirectional,
  setLightLinks,
  getLightRimSource,
  getLightById,
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
  initDangle,
  setDangleConfig,
  stepDangleLive,
  clearDangle,
  resetDangle,
  collectDescendantBoneNames,
} from './dangle.js'
import {
  initAnimation,
  setAnimationModel,
  setActiveAnimationCharacter,
  clearAnimationModel,
  detachAnimationEntry,
  reattachAnimationEntry,
  disposeDetachedAnimationEntry,
  isAnyPlaying,
  updateAnimation,
  scrub,
  selectClip,
  selectEdit,
  getClipEditKeys,
  getClipDuration,
  getCharacterClipDuration,
  rebakeClipFromKeys,
  updateRootMotionTrack,
  play,
  pause,
  hasActiveAction,
  stop,
  getImportedClipsData,
  restoreImportedClips,
  beginBVHImport,
  applyBVHRetarget,
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
  registerObjectMeshes,
  unregisterObjectMeshes,
  setMeshVisible as setMeshVisibleInScene,
  setViewCamera as setMeshEditViewCamera,
} from './meshedit.js'
import {
  initObjects,
  addObject,
  addImage,
  copyObject,
  pasteObject,
  hasCopiedObject,
  clearCopiedObject,
  setObjectVisible,
  setObjectTransform,
  setObjectStyle,
  setObjectOutline,
  applyAllObjectStyles,
  getObjectMaterialModelById,
  setObjectCastShadow,
  removeObject,
  detachObjectSoft,
  reattachObjectSoft,
  disposeObjectEntry,
  resetObject,
  disposeObjects,
  setCharacterObject,
  setOnObjectMoveCommit,
  setOnObjectVisibilityChange,
  clearCharacterObject,
  getObjectsData,
  applyObjectsData,
  getObjectsForSave,
  getObjectMeshesById,
  attachObjectToBone,
  detachObject,
  getObjectAttachment,
  keyObjectAttachment,
  clearObjectAttachmentTrack,
  removeObjectAttachmentKey,
  detachObjectsForCharacter,
  setViewCamera as setObjectsViewCamera,
  updateAllObjectRimLight,
  getObjectRootById,
  getObjectAnimationKeyForRoot,
  getObjectRoots,
  getAllRootsForExport,
  stepObjectAnimation,
  getObjectAnimationDuration,
  stopObjectAnimation,
  startObjectAnimation,
  pauseObjectAnimation,
  isObjectAnimationPaused,
  scrubObjectAnimation,
} from './objects.js'
import { getPose, applyPose } from './posing.js'
import { useStore, captureCharacterRecord } from '../store.js'
import { clearUndoHistory, pushUndoBatch, runWithoutHistoryCapture } from './undoHistory.js'
import { pushSceneHistory } from './sceneHistory.js'

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
  pixelRatio: 1,
  scene: null,
  camera: null,
  controls: null,
  container: null,
  gridHelper: null,
  ground: null, // solid ground plane (toggleable)
  groundY: 0, // floor height (where the ground/shadow planes sit)
  shadow: null, // cheap blob ground shadow
  shadowReceiver: null, // plane that catches real cast shadows
  shadowFit: null, // { center, half } the key light's shadow camera is currently fitted to
  shadowFloorY: null, // height the shadow receiver/blob currently sits at (follows the surface under the character)
  shadowFloorProbeAt: 0,
  shadowSurfaceBelow: false, // a real receiving mesh is under the active character
  shadowOn: true, // master ground-shadow toggle
  shadowMap: false, // real shadow mapping vs blob
  dirLight: null,
  ambientLight: null,
  defaultLightingOn: true,
  lightDir: new THREE.Vector3(0.3, 0.6, 0.7), // unit direction to the key light
  pmremGenerator: null,
  envMap: null, // baked studio-room environment texture, for IBL fill lighting
  contextLost: false, // WebGL context currently lost (GPU reset/crash); rendering paused
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
  lastRenderAt: 0,
  performanceMode: false,
  performanceBackgroundObjects: false,
  performanceLowPoly: false,
  performanceResolution: 0.5,
  performanceEffects: false,
  outlineBeforePerformance: false,
  recorder: null, // MediaRecorder while capturing a video
  recordingFrameInterval: 0, // limit rendering to the export frame rate while recording
  lastRecordingFrameAt: -Infinity,
  recordedChunks: [],
  videoCapture: null, // WebCodecs MP4 capture in progress (see videoCapture.js)
  recorderStarting: false,
  recordingMeta: null, // { ext, blobType, restore } for the recording in progress
  outputOverride: null, // { width, height } while rendering at a fixed export size
  resizeObserver: null,
}

const SHADOW_MAP_SIZE = 2048
const SHADOW_MAP_SIZE_PERFORMANCE = 1024

export function initScene(container) {
  installShadowDarkening() // before any material compiles
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
  // High-DPI displays multiply every lit fragment and shadow sample. Keep the
  // viewport crisp without letting a 4K phone/laptop panel dominate the GPU.
  state.pixelRatio = Math.min(window.devicePixelRatio, 1.5)
  renderer.setPixelRatio(state.pixelRatio) // cap DPR (memory)
  renderer.setSize(width, height)
  renderer.setClearColor(0x000000, 0) // fully transparent clear
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = false // enabled only when real shadows are on
  renderer.shadowMap.type = THREE.PCFShadowMap
  container.appendChild(renderer.domElement)
  state.renderer = renderer

  // Wrap the renderer for the (optional) inverted-hull outline pass.
  initOutline(renderer)

  // Optional camera effects: depth of field + uniform blur.
  initPostFX(renderer)
  resizePostFX(width, height, state.pixelRatio)

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

  // --- WebGL context loss ---
  // The GPU process can reset under heavy load (or be restarted after a driver
  // crash). preventDefault() on 'webglcontextlost' tells the browser we want the
  // context back; three.js re-creates its GL state and re-uploads geometry and
  // textures itself on restore. The one thing it can't rebuild is the baked
  // environment map (render-target contents are gone), so that is re-baked here.
  const canvas = renderer.domElement
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    state.contextLost = true
  })
  canvas.addEventListener('webglcontextrestored', () => {
    state.contextLost = false
    try {
      const oldMap = state.envMap
      state.pmremGenerator?.dispose()
      state.pmremGenerator = new THREE.PMREMGenerator(renderer)
      state.envMap = state.pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture
      if (state.scene && state.scene.environment === oldMap) state.scene.environment = state.envMap
    } catch (err) {
      console.warn('Could not rebuild the environment map after context restore', err)
    }
    requestRender()
  })

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
  // Zoom is handled entirely by our own wheel listener + dollyViewport below
  // (shared with the on-screen +/- buttons), rather than OrbitControls' own
  // wheel handling — this keeps wheel/trackpad and the buttons feeling
  // identical, and sidesteps input setups where OrbitControls' built-in
  // 'wheel' listener doesn't behave as expected.
  controls.enableZoom = false
  controls.addEventListener('start', () => {
    state.viewDragBefore = snapshotViewportView()
    // Orbiting is fragment-bound with lit materials and the outline pass. A
    // temporary lower DPR keeps interaction responsive; the final frame is
    // rendered at the normal quality as soon as the drag ends.
    if (!state.outputOverride && state.pixelRatio > 1.25) renderer.setPixelRatio(1.25)
  })
  controls.addEventListener('end', () => {
    renderer.setPixelRatio(getPerformancePixelRatio())
    commitViewportView(state.viewDragBefore)
    state.viewDragBefore = null
    requestRender()
  })
  controls.addEventListener('change', requestRender)
  controls.update()
  state.controls = controls

  // --- Wheel / trackpad zoom ---
  // Proportional to scroll distance so it feels continuous (a light trackpad
  // scroll nudges the camera slightly, a hard mouse-wheel flick moves it a
  // lot) rather than the fixed per-click step the on-screen buttons use.
  // deltaMode varies by device/browser: 0 = pixels (most trackpads/precision
  // mice), 1 = lines (many mouse wheels), 2 = pages (rare) — normalise all of
  // them to an approximate pixel distance before scaling.
  const onWheel = (e) => {
    e.preventDefault()
    let pixelDelta = e.deltaY
    if (e.deltaMode === 1) pixelDelta *= 18
    else if (e.deltaMode === 2) pixelDelta *= window.innerHeight
    dollyViewport(-pixelDelta, { smooth: true })  // was: dollyViewport(pixelDelta, { smooth: true })
  }
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false })
  state.disposeWheel = () => renderer.domElement.removeEventListener('wheel', onWheel)

  // --- Bone posing (gizmo + pickable bone dots) ---
  initPosing({
    scene,
    camera,
    renderer,
    controls,
    requestRender,
    // Report viewport picks up to the store; the Viewport effect then drives
    // the actual gizmo attach via selectBone (single source of truth).
    onSelect: (name, additive) => useStore.getState().toggleBoneSelection(name, additive),
    // Box/marquee-select (Ctrl/Cmd-drag) — see posing.js's onPointerUp.
    onSelectMany: (names, additive) => useStore.getState().setBoneSelection(names, additive),
    // Any pose edit bumps a counter so the rotation sliders re-read the bone.
    onPoseChange: () => useStore.getState().bumpPoseVersion(),
    // Clicking a body-part region (Parts view) can auto-switch the gizmo to
    // Move (IK) — keep the toolbar toggle in sync when that happens.
    onGizmoModeChange: (mode) => useStore.getState().setBoneGizmoMode(mode),
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
    onVisibilityChange: (uuid, visible) => useStore.getState().setMeshVisible(uuid, visible),
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
  initObjects({
    scene,
    camera,
    renderer,
    controls,
    requestRender,
    setContinuousRender: (on) => setContinuousRender(on, 'object-animation'),
    resolveBone: (boneName, characterId, characterName) => {
      const model = [...state.characters.values()].find((candidate) => candidate.info.name === characterName) ||
        state.characters.get(characterId) ||
        state.currentModel
      return model?.bones?.find((bone) => bone.name === boneName) || null
    },
  })
  setOnObjectVisibilityChange((id, visible) => useStore.getState().setObjectVisible(id, visible))
  // "Auto-save movement": when the toggle is on and the object being dragged
  // is the active character, drop a root-motion keyframe at the playhead —
  // makes a mocap/borrowed clip "your own" without a separate manual step.
  setOnObjectMoveCommit((root) => {
    const st = useStore.getState()
    const fps = st.animFps || 24
    const animationKey = getObjectAnimationKeyForRoot(root)
    if (animationKey && st.objectAutoKeyMovement) {
      const raw = st.objectAnimTime || 0
      const t = Math.round(raw * fps) / fps
      st.addObjectTransformKeyframe(animationKey, t, {
        position: root.position.toArray(),
        quaternion: root.quaternion.toArray(),
        scale: root.scale.toArray(),
      })
      return
    }
    if (
      !st.autoKeyMovement ||
      !state.currentModel ||
      root !== state.currentModel.root
    ) return
    const raw = st.currentTime || 0
    const t = Math.round(raw * fps) / fps
    st.addRootKeyframe(t, root.position.toArray(), root.quaternion.toArray(), st.rippleRootEdit)
    updateRootMotionTrack(useStore.getState().animData.root)
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
    getPlacement: (sceneScale) => {
      const direction = camera.getWorldDirection(new THREE.Vector3())
      const distanceToTarget = camera.position.distanceTo(controls.target)
      const distance = Math.max(sceneScale * 0.5, Math.min(sceneScale * 3, distanceToTarget * 0.65))
      return camera.position.clone().add(direction.multiplyScalar(distance))
    },
    onChange: updateFollowedRimLight,
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

  // --- Dangle bones (gravity/physics on selected bones — hair, accessories) ---
  initDangle({ requestRender: () => requestRender() })

  // --- Lights (only affect Toon/Standard modes; harmless in Unlit) ---
  const dirLight = new THREE.DirectionalLight(0xffffff, 2.0)
  dirLight.position.set(2, 4, 3)
  dirLight.castShadow = false // enabled only in "realistic shadows" mode
  // 2048² keeps contact shadows crisp (512² made them soft, blocky and faint).
  // applyShadowMode drops this to 1024² in performance mode.
  dirLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
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
  setDefaultLightingEnabled(s.defaultLightingEnabled)
  setEnvironmentLighting(s.envLightingEnabled, s.envLightingIntensity)
  setOutlineEnabled(s.outlineEnabled)
  setShadowVisible(s.showShadow)
  setShadowMapping(s.shadowMapping)
  setShadowSoftness(s.shadowSoftness)
  setShadowStrength(s.shadowStrength)
  setDepthOfField(s.dofEnabled, s.dofFocusDistance, s.dofAperture, s.dofMaxBlur)
  setBlurEffect(s.blurEnabled, s.blurAmount)

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

// Manual zoom fallback (on-screen +/- buttons).
export function dollyViewport(direction, { smooth = false } = {}) {
  const { camera, controls } = state
  if (!camera || !controls) return
  const offset = camera.position.clone().sub(controls.target)
  const distance = offset.length()
  if (distance < 1e-6) return
  beginDollyHistory()
  const factor = smooth
    ? Math.pow(0.9985, direction) // ~0.15% per pixel of scroll, smooth and continuous
    : direction < 0
      ? 0.85
      : 1 / 0.85
  const minDistance = controls.minDistance ?? 0
  const maxDistance = controls.maxDistance ?? Infinity
  const nextDistance = Math.min(maxDistance, Math.max(minDistance, distance * factor))
  offset.multiplyScalar(nextDistance / distance)
  camera.position.copy(controls.target).add(offset)
  controls.update()
  requestRender()
}

function snapshotViewportView() {
  if (!state.camera || !state.controls) return null
  return {
    position: state.camera.position.clone(),
    quaternion: state.camera.quaternion.clone(),
    target: state.controls.target.clone(),
    zoom: state.camera.zoom,
  }
}

function applyViewportView(snapshot) {
  if (!snapshot || !state.camera || !state.controls) return
  state.camera.position.copy(snapshot.position)
  state.camera.quaternion.copy(snapshot.quaternion)
  state.camera.zoom = snapshot.zoom
  state.camera.updateProjectionMatrix()
  state.controls.target.copy(snapshot.target)
  state.controls.update()
  requestRender()
}

function sameViewportView(a, b) {
  return !!a && !!b && a.position.equals(b.position) && a.quaternion.equals(b.quaternion) &&
    a.target.equals(b.target) && a.zoom === b.zoom
}

function commitViewportView(before, after = snapshotViewportView()) {
  if (!sameViewportView(before, after)) return
  pushSceneHistory(
    () => applyViewportView(before),
    () => applyViewportView(after),
  )
}

function beginDollyHistory() {
  if (state.dollyUndoTimer) clearTimeout(state.dollyUndoTimer)
  if (!state.dollyUndoBefore) state.dollyUndoBefore = snapshotViewportView()
  state.dollyUndoTimer = setTimeout(() => {
    commitViewportView(state.dollyUndoBefore)
    state.dollyUndoBefore = null
    state.dollyUndoTimer = null
  }, 220)
}

function commitFramingChange(frame) {
  const before = snapshotViewportView()
  frame()
  commitViewportView(before)
}

function renderOnce() {
  if (!state.renderer || state.contextLost) return
  const now = typeof performance !== 'undefined' ? performance.now() : 0
  if (state.lastRenderAt > 0 && now > state.lastRenderAt) {
    const frameRate = 1000 / (now - state.lastRenderAt)
    state.fps = state.fps ? state.fps * 0.9 + frameRate * 0.1 : frameRate
  }
  state.lastRenderAt = now
  followIdleClothPose() // keep enabled-but-not-draping cloth tracking the body/gizmo, not frozen
  updateBoneHelpers() // park bone dots on their (possibly just-moved) bones
  updateMeshEditHelpers() // keep the part-selection box hugging its mesh
  const camera = state.viewCamera || state.camera
  if (camera === state.camera) updateFreeCameraClipping()
  const restoreCulling = applyRenderCulling(camera)
  try {
    // Route through the outline effect. When the outline is disabled it falls
    // straight through to renderer.render, so there's no overhead when it's off.
    const effect = getOutlineEffect()
    const drawScene = () => {
      if (effect) effect.render(state.scene, camera)
      else state.renderer.render(state.scene, camera)
    }
    // Camera effects (DOF/blur) render the scene into an offscreen target and
    // blur it; when both are off this is a no-op and we draw straight to screen.
    const usedPostFX = renderPostFX(camera, drawScene)
    if (!usedPostFX) drawScene()
    // Same task as the draw, so the canvas still holds this frame.
    if (state.videoCapture) state.videoCapture.onFrame(now)
  } finally {
    restoreCulling()
  }
}

// Hide whole prop/character roots from the color pass when they are outside
// the current view — unless they could still throw a shadow into it.
//
// IMPORTANT: a shadow caster must stay on the default layer and visible. three's
// shadow pass tests each object's layers against the MAIN camera's layers (not
// the shadow camera's), so parking an off-screen caster on a "shadow-only" layer
// the main camera ignores silently removes it from the shadow map — which is
// what made props and characters near the edge of view stop casting shadows.
// Off-screen meshes are still frustum-culled per mesh in the colour pass, so
// leaving them visible costs very little.
//
// Same pass also gathers the casters' bounds so the key light's shadow camera
// can be fitted to the whole scene (see updateShadowFit).
function applyRenderCulling(camera) {
  if (!camera || !state.scene) return () => {}

  const viewFrustum = makeCameraFrustum(camera)
  const shadowCamera = state.dirLight?.shadow?.camera
  let anotherShadowLight = false
  state.scene.traverse((obj) => {
    if (obj.isLight && obj.castShadow && obj !== state.dirLight) anotherShadowLight = true
  })
  const shadowEnabled = state.shadowMap && (state.dirLight?.castShadow || anotherShadowLight)
  const shadowFrustum = shadowEnabled && shadowCamera ? makeCameraFrustum(shadowCamera) : null
  const objectRoots = getObjectRoots()
  const objectRootSet = new Set(objectRoots)
  const roots = new Set([...state.characters.values()].map((model) => model.root))
  for (const root of objectRoots) roots.add(root)
  const changed = []
  const casterSpheres = []
  const maxCasterRadius = Math.max(state.modelRadius * 10, 20)

  for (const root of roots) {
    if (!root || !root.visible) continue
    root.updateMatrixWorld(true)
    const sphere = new THREE.Sphere()
    new THREE.Box3().setFromObject(root).getBoundingSphere(sphere)
    const inView = viewFrustum.intersectsSphere(sphere)
    const distantBackground = state.performanceMode && state.performanceBackgroundObjects &&
      objectRootSet.has(root) && camera.position.distanceTo(sphere.center) > Math.max(6, state.modelRadius * 4)

    let castsShadow = false
    if (shadowEnabled && !distantBackground) {
      root.traverse((obj) => {
        if (obj.isMesh && obj.castShadow) castsShadow = true
      })
      if (castsShadow && sphere.radius > 0 && sphere.radius <= maxCasterRadius) casterSpheres.push(sphere)
    }
    if (inView && !distantBackground) continue

    // Out of view: keep it only if it can still shadow something in view.
    // Other light types may use cube or point-light shadow cameras, so their
    // exact projected receiver region is not available here; keeping these
    // casters is conservative.
    const keepForShadow = !distantBackground && castsShadow && (
      shadowFrustum?.intersectsSphere(sphere) || anotherShadowLight
    )
    if (keepForShadow) continue
    changed.push({ root, visible: root.visible })
    root.visible = false
  }

  if (shadowEnabled) {
    updateShadowFit(casterSpheres)
    updateShadowFloor()
  }

  return () => {
    for (const previous of changed) previous.root.visible = previous.visible
  }
}

// Refit the key light's shadow camera to every caster in the scene, so props
// and characters that were added or moved after the first model loaded are
// still inside the shadow map. Re-fits only on a meaningful change.
function updateShadowFit(casterSpheres) {
  const next = fitShadowExtents(casterSpheres, {
    minHalf: Math.max(state.modelRadius * 3, 1),
    maxHalf: Math.max(state.modelRadius * 20, 10),
  })
  if (!next || !needsRefit(state.shadowFit, next)) return
  state.shadowFit = next
  positionLight()
}

// Keep the shadow receiver (and blob) on the surface under the active
// character rather than at the height the model happened to load at — saved
// projects restore the character's transform AFTER load, so a character
// standing on a raised map used to cast its shadow onto a plane far below it.
// The invisible shadow-catching plane is only a stand-in floor for scenes with
// nothing to land shadows on. It is an endless flat sheet, so wherever a real
// surface exists (a map, a platform, the ground disc) it must stay hidden —
// otherwise its shadows hang in mid-air past the edge of that surface, or show
// through walls and across other levels. Real meshes receive shadows themselves.
function syncShadowReceiverVisibility() {
  if (!state.shadowReceiver) return
  const realOn = !(state.performanceMode && state.performanceEffects) && state.shadowOn && state.shadowMap
  state.shadowReceiver.visible = !!realOn && !state.shadowSurfaceBelow && !state.ground?.visible
}

function updateShadowFloor() {
  const now = typeof performance !== 'undefined' ? performance.now() : 0
  if (now - state.shadowFloorProbeAt < 150) return
  state.shadowFloorProbeAt = now
  const model = state.currentModel
  if (!model?.root) return
  const roots = getObjectRoots()
  const feet = new THREE.Vector3()
  model.root.getWorldPosition(feet)
  // The receiver is a big plane, but it must still be under the character if
  // they walk (or are dragged) far from where the model loaded.
  if (state.shadowReceiver) state.shadowReceiver.position.set(feet.x, state.shadowReceiver.position.y, feet.z)
  let floorY = state.groundY
  let surfaceBelow = false
  if (roots.length) {
    const probe = probeFloor(collectFloorReceivers(roots), feet, {
      startAbove: Math.max(state.modelRadius * 0.25, 0.1),
      fallback: state.groundY,
    })
    floorY = probe.y
    surfaceBelow = probe.hit
  }
  if (surfaceBelow !== state.shadowSurfaceBelow) {
    state.shadowSurfaceBelow = surfaceBelow
    syncShadowReceiverVisibility()
  }
  if (state.shadowFloorY !== null && Math.abs(floorY - state.shadowFloorY) < 1e-4) return
  state.shadowFloorY = floorY
  const lift = state.modelRadius * 0.001
  if (state.shadowReceiver) state.shadowReceiver.position.y = floorY + lift
  if (state.shadow) state.shadow.position.y = floorY + lift * 2
}

function makeCameraFrustum(camera) {
  camera.updateMatrixWorld(true)
  const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  return new THREE.Frustum().setFromProjectionMatrix(matrix)
}

function updateFreeCameraClipping() {
  if (!state.camera || !state.controls) return
  const distance = state.camera.position.distanceTo(state.controls.target)
  const radius = Math.max(state.modelRadius, 0.5)
  const near = Math.max(0.01, radius * 0.001)
  const far = Math.max(distance + radius * 8, radius * 20)
  if (state.camera.near === near && state.camera.far === far) return
  state.camera.near = near
  state.camera.far = far
  state.camera.updateProjectionMatrix()
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
    // Playback is already the busiest path: keep animation responsive on
    // high-DPI displays and restore the full viewport ratio when idle.
    state.renderer?.setPixelRatio(getPerformancePixelRatio())
    if (state.clock) state.clock.getDelta() // reset delta so the first frame isn't a big jump
    const tick = () => {
      if (!state.continuous) return
      state.animId = requestAnimationFrame(tick)
      const now = performance.now()
      if (
        state.recordingFrameInterval &&
        now - state.lastRecordingFrameAt < state.recordingFrameInterval - 2 // half a refresh of slack, or 30 fps on a 60 Hz screen keeps landing on 50 ms
      ) return
      if (state.recordingFrameInterval) state.lastRecordingFrameAt = now
      const delta = state.clock ? state.clock.getDelta() : 0
      const speed = Number(useStore.getState().speed) || 1
      const animationDelta =
        globalClock && !globalClockLoop && globalClockDuration > 0
          ? Math.min(delta, Math.max(0, globalClockDuration - useStore.getState().globalTime) / speed)
          : delta
      // Smoothed FPS for the stats readout (only meaningful while playing).
      if (delta > 0) state.fps = state.fps * 0.9 + (1 / delta) * 0.1
      // Guarded: a thrown error in any one step (mixer, cloth playback, the
      // render call itself…) used to silently kill this frame's draw call —
      // since the next rAF was already scheduled above, playback LOOKED like
      // it was still running (time kept advancing) while the screen just
      // never updated again. Catch here so one bad frame logs a warning and
      // gets skipped instead of freezing everything after it.
      try {
        updateAnimation(animationDelta) // advance the mixer before drawing
        stepObjectAnimation(animationDelta, globalClock ? globalClockLoop : undefined)
        advanceGlobalClock(animationDelta)
        stepClothLive(animationDelta) // step any LIVE cloth sims, following the current pose
        stepDangleLive(animationDelta) // swing any dangle (hair/accessory) bones under gravity
        updateCamTransition(animationDelta) // glide any in-progress camera cut
        renderOnce()
      } catch (err) {
        console.error('Render tick failed, skipping this frame:', err)
      }
    }
    state.animId = requestAnimationFrame(tick)
  } else {
    cancelAnimationFrame(state.animId)
    state.renderer?.setPixelRatio(getPerformancePixelRatio())
    state.fps = 0
    requestRender()
  }
}

// Move the playhead.
export function scrubTimeline(t) {
  scrub(t)
}

// After keyframes change behind the engine's back (undo/redo), re-bake the
// active character's keyframe-edit playback so the viewport and timeline agree.
// Leaves playback paused at the same time; does nothing when stopped (rest pose).
export function refreshEditPlayback() {
  const s = useStore.getState()
  if (!state.activeCharacterId || s.playback === 'stopped') return
  const t = s.currentTime
  if (s.playbackSource === 'clip') {
    // A saved clip that remembers its keys: rebuild it from the restored keys.
    const keys = s.activeClipName ? getClipEditKeys(s.activeClipName) : null
    if (!keys) return
    const ok = rebakeClipFromKeys(s.activeClipName, {
      tracks: s.animData.tracks,
      root: s.animData.root,
      duration: keys.duration,
    })
    if (!ok) return
    updateRootMotionTrack(s.animData.root)
    s.setPlayback('paused')
    scrub(Math.min(t, keys.duration))
    requestRender()
    return
  }
  if (s.playbackSource !== 'edit') return
  const d = selectEdit(s.animData, s.animDuration, { loop: s.loop, speed: s.speed })
  s.setDuration(d)
  s.setPlayback('paused')
  scrub(Math.min(t, d))
  requestRender()
}

function handleResize() {
  const { container, renderer, camera } = state
  if (!container || !renderer) return
  // While exporting at a fixed size the canvas keeps that size (and the
  // viewport just letterboxes it); the window can still be resized freely.
  const override = state.outputOverride
  const width = override ? override.width : container.clientWidth || 1
  const height = override ? override.height : container.clientHeight || 1
  if (override) {
    renderer.setPixelRatio(1)
    renderer.setSize(width, height, false)
  } else {
    renderer.setSize(width, height)
  }
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  if (state.viewCamera) {
    state.viewCamera.aspect = width / height
    state.viewCamera.updateProjectionMatrix()
  }
  resizePostFX(width, height, override ? 1 : state.pixelRatio)
  requestRender()
}

// Aspect ratio the scene is currently being drawn at (the viewport, or the fixed
// export size while recording / saving an image).
function getViewAspect() {
  if (state.outputOverride) return state.outputOverride.width / state.outputOverride.height
  return (state.container?.clientWidth || 1) / (state.container?.clientHeight || 1)
}

// ---------------------------------------------------------------------------
// Model loading / disposal
// ---------------------------------------------------------------------------

let characterIdCounter = 0
let characterClipboard = null

// Load a model file as the ACTIVE character.
//   addNew=false (default): replaces the active character in place (legacy
//     single-character behaviour — used by "load a different character").
//   addNew=true: keeps every existing character in the scene and adds this
//     one alongside them as a new, separately-posable character.
export async function loadModelFile(file, { addNew = false } = {}) {
  const store = useStore.getState()
  const shouldFrameInitialCharacter = state.characters.size === 0 && store.sceneObjects.length === 0
  const isAddition = !state.currentModel || (addNew && !!state.currentModel)
  const previousCharacterState = isAddition ? captureCharacterUndoContext(store) : null
  store.setLoading(true)
  try {
    const parsed = await loadModel(file, { autoDecimate: store.autoDecimate })
    parsed.file = file // retain the source blob so the model can be saved to a project
    prepareModelTextures(parsed)

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
    // Only the first character establishes the initial viewport. Adding or
    // replacing another character must leave the user's current view alone.
    setActiveCharacter(id, parsed, { frame: shouldFrameInitialCharacter, isNewLoad: true })
    if (isAddition) recordCharacterAdded(id, previousCharacterState)

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

// Push the ACTIVE character's dangle-chain settings (store's dangleEnabled /
// dangleChains) into the physics engine. Called from a Viewport effect
// whenever either changes — toggling the master switch, adding/removing a
// chain, or dragging a stiffness/gravity/damping slider.
export function syncActiveDangleConfig(enabled, chains) {
  if (!state.activeCharacterId || !state.currentModel) return
  setDangleConfig(state.activeCharacterId, state.currentModel, enabled, chains)
}

// Snap the active character's dangle bones back onto its current pose,
// killing any in-flight swing — used right after creating a chain (so it
// doesn't lurch in from wherever its bones happened to be) and by a panel
// "reset" action.
export function resetActiveDangle(chainId) {
  if (!state.activeCharacterId) return
  resetDangle(state.activeCharacterId, chainId)
  requestRender()
}

// Bone name + every bone hanging off it in the ACTIVE character's skeleton —
// the "add this bone and its whole dangling tail" convenience the Pose
// panel's dangle section uses so picking one hair/ponytail root bone sweeps
// up the rest of the strand automatically.
export function collectActiveDangleDescendants(boneName) {
  if (!state.currentModel) return [boneName]
  return collectDescendantBoneNames(state.currentModel, boneName)
}

// Suspend/resume orbiting for the duration of a Ctrl/Cmd-drag box-select in
// Object mode (see Viewport.jsx) — mirrors how a TransformControls drag
// already disables orbit while it's in progress.
export function setOrbitSuspended(suspended) {
  if (!state.controls) return
  state.controls.enabled = !suspended && !state.controls.locked
}

// Start every loaded character playing whatever clip/edit-source IT currently
// has selected (each character remembers its own activeClipName/playbackSource/
// animData — see the store's per-character fields). Characters with nothing
// selected are left alone. `loop`/`speed` default to the shared transport
// settings but can be overridden (e.g. a recorded shot always plays once,
// regardless of the loop toggle). Returns { started, maxDuration } —
// maxDuration is the longest of the clips just armed (seconds), 0 if none.
export function playAllCharacters({ loop, speed, stopAtFirstClipEnd = false } = {}) {
  const store = useStore.getState()
  const opts = { loop: stopAtFirstClipEnd ? false : (loop ?? store.loop), speed: speed ?? store.speed }
  const uiActiveId = state.activeCharacterId
  let started = 0
  let maxDuration = 0
  let minDuration = Infinity
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
      minDuration = Math.min(minDuration, durSec)
    }
  }
  setActiveAnimationCharacter(uiActiveId) // restore whichever character the UI is focused on
  if (started > 0) {
    useStore.setState({ playback: 'playing' })
    requestRender()
  }
  return { started, maxDuration, minDuration: started ? minDuration : 0 }
}

// --- All-animation timeline ---------------------------------------------------
// One shared playhead over every loaded character AND every keyed object, so
// the whole scene can be scrubbed / played / paused together. Each character
// keeps its own clip and each object its own track; this just drives them all
// from a single time (a shorter clip holds its last pose, or loops when Loop
// is on, exactly as it would under Play all).
let globalClock = false // true while Play all is running, advancing globalTime
let globalClockDuration = 0

function hasKeys(v) {
  if (Array.isArray(v)) return v.length > 0
  if (v && typeof v === 'object') return Object.values(v).some(hasKeys)
  return false
}

function objectKeysExist(store) {
  return Object.values(store.objectAnimData || {}).some((keys) => keys && keys.length) ||
    Object.values(store.objectAttachmentData || {}).some((track) => track?.keys?.length)
}

function standaloneCameraLightKeysExist(store) {
  return !(store.characterOrder || []).length &&
    (Object.values(store.animData?.cameras || {}).some((keys) => keys?.length) ||
      Object.values(store.animData?.lights || {}).some((keys) => keys?.length))
}

// Length of the whole scene's animation in seconds: the longest of every
// character's selected clip / keyframe edit and the object-motion duration.
// Read-only (never switches the active character), so safe to call in render.
export function getAllTimelineDuration({ stopAtFirstClipEnd = false } = {}) {
  const store = useStore.getState()
  const uiActiveId = state.activeCharacterId
  let max = 0
  const characterDurations = []
  for (const id of store.characterOrder) {
    if (!state.characters.has(id)) continue
    const c = id === uiActiveId ? store : store.characters[id]
    if (!c) continue
    let d = 0
    if (c.playbackSource === 'edit') d = hasKeys(c.animData) ? store.animDuration : 0
    else if (c.activeClipName) d = getCharacterClipDuration(id, c.activeClipName)
    if (d > 0) {
      characterDurations.push(d)
      if (d > max) max = d
    }
  }
  if (stopAtFirstClipEnd && characterDurations.length) {
    max = Math.min(...characterDurations)
    return max
  }
  if (objectKeysExist(store) || standaloneCameraLightKeysExist(store)) {
    max = Math.max(max, getObjectAnimationDuration(store))
  }
  return max
}

// Put every character and object at time `t` and leave them paused there
// (Play all then carries on from this point).
export function scrubAllTimeline(t) {
  const store = useStore.getState()
  const opts = { loop: store.loop, speed: store.speed }
  const total = getAllTimelineDuration()
  const time = Math.max(0, Math.min(Number(t) || 0, total))
  const wrap = (dur) => (store.loop && dur > 0 && time > dur ? time % dur : time)
  const uiActiveId = state.activeCharacterId
  let any = false
  let uiTime = null
  for (const id of store.characterOrder) {
    if (!state.characters.has(id)) continue
    const c = id === uiActiveId ? store : store.characters[id]
    if (!c) continue
    setActiveAnimationCharacter(id)
    if (!hasActiveAction()) {
      let durSec = 0
      if (c.playbackSource === 'edit') durSec = hasKeys(c.animData) ? selectEdit(c.animData, store.animDuration, opts) : 0
      else if (c.activeClipName) durSec = selectClip(c.activeClipName, opts, c.animData)
      if (!(durSec > 0)) continue
    }
    pause()
    const at = wrap(getClipDuration())
    scrub(at)
    any = true
    if (id === uiActiveId) uiTime = at
  }
  setActiveAnimationCharacter(uiActiveId)
  if (objectKeysExist(store) || standaloneCameraLightKeysExist(store)) {
    if (store.objectAnimPlaying) pauseObjectAnimation()
    else if (!isObjectAnimationPaused()) {
      startObjectAnimation() // takes the rest snapshot Stop restores to…
      pauseObjectAnimation() // …then holds at the scrub time instead of running
    }
    scrubObjectAnimation(wrap(getObjectAnimationDuration(store)))
  }
  globalClock = false
  globalClockDuration = total
  const patch = { globalTime: time }
  if (any) patch.playback = 'paused'
  if (uiTime !== null) patch.currentTime = uiTime
  useStore.setState(patch)
  requestRender()
}

// Called by the Play-all / resume buttons once everything has been started, to
// make the shared playhead follow along. `fromStart` restarts it at 0.
export function startGlobalClock(fromStart, options = {}) {
  const store = useStore.getState()
  const stopAtFirstClipEnd = options.stopAtFirstClipEnd ?? store.stopAtFirstClipEnd
  globalClockDuration = options.duration ?? getAllTimelineDuration({ stopAtFirstClipEnd })
  globalClockLoop = options.loop ?? (store.loop && !stopAtFirstClipEnd)
  const cur = store.globalTime
  if (fromStart || (globalClockDuration > 0 && cur >= globalClockDuration)) useStore.setState({ globalTime: 0 })
  globalClock = true
}

let globalClockLoop = true

export function pauseGlobalClock() {
  globalClock = false
}

function advanceGlobalClock(delta) {
  if (!globalClock) return
  const s = useStore.getState()
  let t = s.globalTime + Math.max(0, delta) * (Number(s.speed) || 1)
  const d = globalClockDuration
  if (d > 0 && t >= d) {
    if (globalClockLoop) t %= d
    else {
      t = d
      globalClock = false
    }
  }
  useStore.setState({ globalTime: t })
  if (!globalClock && d > 0 && t >= d) {
    pauseAllCharacters()
    pauseObjectAnimation()
  }
}

// Freeze every loaded character mid-clip (keeps each one's place, unlike stop).
export function pauseAllCharacters() {
  globalClock = false
  const store = useStore.getState()
  const uiActiveId = state.activeCharacterId
  for (const id of store.characterOrder) {
    if (!state.characters.has(id)) continue
    setActiveAnimationCharacter(id)
    pause()
  }
  setActiveAnimationCharacter(uiActiveId)
  useStore.setState({ playback: 'paused' })
  requestRender()
}

// Continue every paused character from where it was frozen. Returns how many
// had something armed to resume (0 means nothing was paused — start fresh).
export function resumeAllCharacters() {
  const store = useStore.getState()
  const uiActiveId = state.activeCharacterId
  let resumed = 0
  for (const id of store.characterOrder) {
    if (!state.characters.has(id)) continue
    setActiveAnimationCharacter(id)
    if (!hasActiveAction()) continue
    play()
    resumed++
  }
  setActiveAnimationCharacter(uiActiveId)
  if (resumed > 0) {
    useStore.setState({ playback: 'playing' })
    requestRender()
  }
  return resumed
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
  globalClock = false
  useStore.setState({ playback: 'stopped', currentTime: 0, globalTime: 0 })
}


// and drop it from the registry). If it was the active one, another loaded
// character (if any) becomes active.
// Test seam: register an already-parsed model as a loaded character without a
// WebGL context or file load (loadModelFile needs both). Mirrors the registry
// part of loadModelFile; not used by the app.
export function __seedCharacterForTest(id, parsed, threeScene, { recordHistory = false } = {}) {
  const previousState = recordHistory ? captureCharacterUndoContext(useStore.getState()) : null
  if (!state.scene) state.scene = threeScene
  state.scene.add(parsed.root)
  state.characters.set(id, parsed)
  setCharacterObject(id, parsed.root, parsed.info.name)
  useStore.getState().addCharacter(id, parsed.info)
  state.activeCharacterId = id
  state.currentModel = parsed
  if (recordHistory) recordCharacterAdded(id, previousState)
}

export function removeCharacter(id, recordHistory = true) {
  if (!recordHistory) {
    removeCharacterForGood(id)
    return
  }
  if (!state.characters.has(id)) return
  const batch = makeCharacterDeleteBatch(id)
  if (!removeCharacterPresence(batch)) return
  pushUndoBatch('object', batch)
}

export function copyCharacterById(id) {
  const source = state.characters.get(id)
  const record = captureCharacterRecord(useStore.getState(), id)
  if (!source || !record) return false
  const model = cloneCharacterModel(source)
  const fields = structuredClone(record.fields)
  fields.meshOverrides = remapMeshOverrides(fields.meshOverrides, source, model)
  const importedClips = getImportedClipsData(id)
  clearCopiedObject()
  clearCopiedCharacterData()
  characterClipboard = {
    model,
    fields,
    importedClips,
  }
  return true
}

export function pasteCopiedCharacter() {
  if (!characterClipboard || !state.scene) return null
  const previousState = captureCharacterUndoContext(useStore.getState())
  const model = cloneCharacterModel(characterClipboard.model)
  const id = `char_${++characterIdCounter}`
  model.info = { ...model.info, name: `${model.info.name} Copy` }
  model.root.name = model.info.name
  model.root.position.x += 0.25

  state.scene.add(model.root)
  state.characters.set(id, model)
  setCharacterObject(id, model.root, model.info.name)
  recordOriginalMaterials(model)
  useStore.getState().addCharacter(id, model.info)
  useStore.setState((store) => ({
    sceneObjects: store.sceneObjects.map((entry) =>
      entry.id === id ? { ...entry, visible: model.root.visible } : entry,
    ),
  }))
  setActiveCharacter(id, model, { isNewLoad: true })
  restoreImportedClips(id, characterClipboard.importedClips)

  const fields = structuredClone(characterClipboard.fields)
  fields.meshOverrides = remapMeshOverrides(fields.meshOverrides, characterClipboard.model, model)
  useStore.setState({
    ...fields,
    modelInfo: model.info,
    selectedBoneName: null,
    selectedBoneNames: [],
    selectedMeshUuid: null,
    poseClipboard: null,
    playback: 'stopped',
    currentTime: 0,
  })
  setDangleConfig(id, model, fields.dangleEnabled, fields.dangleChains)
  applyModelMaterials()
  recordCharacterAdded(id, previousState)
  requestRender()
  return { id, name: model.info.name, isCharacter: true }
}

function remapMeshOverrides(overrides, source, target) {
  const result = {}
  for (let i = 0; i < (source.meshes || []).length; i++) {
    const sourceMesh = source.meshes[i]
    const targetMesh = target.meshes[i]
    const override = overrides?.[sourceMesh.uuid]
    if (targetMesh && override) result[targetMesh.uuid] = override
  }
  return result
}

export function hasCopiedCharacterData() {
  return !!characterClipboard
}

export function clearCopiedCharacterData() {
  if (!characterClipboard) return
  disposeObject(characterClipboard.model.root)
  characterClipboard = null
}

function cloneCharacterModel(source) {
  const root = cloneSkeleton(source.root)
  const sourceNodes = []
  const clonedNodes = []
  source.root.traverse((node) => sourceNodes.push(node))
  root.traverse((node) => clonedNodes.push(node))
  const nodeMap = new Map(sourceNodes.map((node, index) => [node, clonedNodes[index]]))
  const overlays = []
  root.traverse((node) => {
    if (node.isSkinnedMesh && node.name.startsWith('(part overlay: ')) overlays.push(node)
  })
  for (const overlay of overlays) overlay.parent?.remove(overlay)
  const textureCopies = new Map()

  const cloneMaterial = (material) => {
    if (!material) return material
    const copy = material.clone()
    for (const key of Object.keys(copy)) {
      const texture = copy[key]
      if (!texture?.isTexture) continue
      if (!textureCopies.has(texture)) textureCopies.set(texture, texture.clone())
      copy[key] = textureCopies.get(texture)
    }
    return copy
  }
  const cloneMaterialValue = (material) =>
    Array.isArray(material) ? material.map(cloneMaterial) : cloneMaterial(material)

  const meshes = (source.meshes || []).map((mesh) => {
    const cloned = nodeMap.get(mesh)
    if (mesh.geometry) cloned.geometry = mesh.geometry.clone()
    const original = source.materials?.originals?.get(mesh) || mesh.material
    cloned.material = cloneMaterialValue(original)
    return cloned
  })
  const bones = (source.bones || []).map((bone) => nodeMap.get(bone))
  const skinnedMeshes = (source.skinnedMeshes || []).map((mesh) => nodeMap.get(mesh))
  const infoMeshes = meshes.map((mesh, index) => ({
    ...(source.info?.meshes?.[index] || {}),
    uuid: mesh.uuid,
  }))
  const info = { ...source.info, meshes: infoMeshes }
  return {
    ...source,
    root,
    meshes,
    bones,
    skinnedMeshes,
    skeleton: skinnedMeshes.find((mesh) => mesh.skeleton)?.skeleton || null,
    materials: null,
    info,
  }
}

function captureCharacterUndoContext(store) {
  return {
    activeCharacterId: state.activeCharacterId,
    mode: store.mode,
    selectedObjectId: store.selectedObjectId,
    selectedObjectIds: [...(store.selectedObjectIds || [])],
    selectedCameraId: store.selectedCameraId,
    selectedLightId: store.selectedLightId,
  }
}

function recordCharacterAdded(id, previousState) {
  pushUndoBatch('object', makeCharacterAddBatch(id, previousState))
}

function makeCharacterAddBatch(id, previousState) {
  const batch = {
    entries: [],
    kind: 'add-character',
    id,
    rec: null,
    prevMode: null,
    run(direction) {
      if (direction === 'undo') {
        if (!removeCharacterPresence(batch)) return
        if (previousState?.activeCharacterId && state.characters.has(previousState.activeCharacterId)) {
          setActiveCharacter(previousState.activeCharacterId)
        }
        if (previousState) {
          useStore.setState({
            mode: previousState.mode,
            selectedObjectId: previousState.selectedObjectId,
            selectedObjectIds: previousState.selectedObjectIds,
            selectedCameraId: previousState.selectedCameraId,
            selectedLightId: previousState.selectedLightId,
          })
        }
      } else {
        restoreCharacterPresence(batch)
      }
    },
    discard() {
      discardDetachedCharacter(batch)
    },
  }
  return batch
}

// Permanent removal (no undo step): frees everything immediately.
function removeCharacterForGood(id) {
  disposeCharacter(id)
  useStore.getState().removeCharacter(id)
  afterCharacterRemoved(id)
}

// Shared tail of every removal: pick a new active character if the removed one
// was active, and fall back to Object mode when only props remain.
function afterCharacterRemoved(id) {
  const remaining = [...state.characters.keys()]
  if (state.activeCharacterId === id) {
    state.activeCharacterId = null
    state.currentModel = null
    if (remaining.length) setActiveCharacter(remaining[0])
  }
  const store = useStore.getState()
  if (remaining.length === 0 && store.sceneObjects.some((object) => !object.isCharacter)) store.setMode('object')
  requestRender()
}

// --- Undoable character delete ------------------------------------------------
// Deleting detaches the character from the scene and every engine (animation,
// cloth, dangle, posing, mesh-edit) but keeps its model, mixer (with any
// imported mocap clips), materials and per-character state alive, so Undo can
// put it back exactly as it was — pose, mesh edits, keyframes and all. The
// resources are only freed (discard) once the delete can no longer be undone.
// Not restored: cloth simulation (re-enable it on the garment) and props that
// were glued to its bones (they stay in the scene as free props).
function detachCharacterSoft(id) {
  const model = state.characters.get(id)
  if (!model) return null
  const store = useStore.getState()
  const record = {
    id,
    model,
    storeRecord: captureCharacterRecord(store, id),
    animEntry: null,
  }
  if (state.activeCharacterId === id) {
    clearPoseModel()
    clearMeshEditModel()
  }
  record.animEntry = detachAnimationEntry(id)
  if (!isAnyPlaying()) setContinuousRender(false)
  clearClothForMeshes(model.meshes, { restoreVisible: true })
  clearDangle(id)
  const detachedIds = detachObjectsForCharacter(id)
  for (const objId of detachedIds) useStore.getState().setObjectAttachment(objId, null)
  clearCharacterObject(id)
  state.scene.remove(model.root)
  state.characters.delete(id)
  if (state.currentModel === model) state.currentModel = null
  return record
}

function removeCharacterPresence(batch) {
  const rec = detachCharacterSoft(batch.id)
  if (!rec) return false
  batch.rec = rec
  batch.prevMode = useStore.getState().mode
  runWithoutHistoryCapture(() => {
    useStore.getState().removeCharacter(batch.id)
  })
  afterCharacterRemoved(batch.id)
  return true
}

function restoreCharacterPresence(batch) {
  const rec = batch.rec
  if (!rec || !rec.storeRecord) return false
  const { id, model } = rec
  state.scene.add(model.root)
  state.characters.set(id, model)
  setCharacterObject(id, model.root, model.info.name)
  reattachAnimationEntry(id, rec.animEntry)
  runWithoutHistoryCapture(() => {
    useStore.getState().restoreCharacter(rec.storeRecord)
  })
  setActiveCharacter(id, model) // re-point posing / mesh-edit / animation at it
  const fields = rec.storeRecord.fields
  setDangleConfig(id, model, fields.dangleEnabled, fields.dangleChains)
  applyModelMaterials() // re-apply the current Look settings
  // Deleting the last character forced Object mode; put the old mode back.
  if (batch.prevMode && useStore.getState().mode !== batch.prevMode) useStore.getState().setMode(batch.prevMode)
  batch.rec = null
  requestRender()
  return true
}

function makeCharacterDeleteBatch(id) {
  const batch = {
    entries: [], // presence steps carry no transform snapshots
    kind: 'delete-character',
    id,
    rec: null, // set while the character is detached (deleted)
    prevMode: null,
    run(direction) {
      if (direction === 'undo') restoreCharacterPresence(batch)
      else removeCharacterPresence(batch)
    },
    // Dropped from history while detached -> nothing can bring it back; free it.
    discard() {
      discardDetachedCharacter(batch)
    },
  }
  return batch
}

function discardDetachedCharacter(batch) {
  const rec = batch.rec
  if (!rec) return
  batch.rec = null
  disposeDetachedAnimationEntry(rec.animEntry)
  restoreOriginalMaterials(rec.model)
  disposeGeneratedMaterials(rec.model)
  disposeObject(rec.model.root)
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
  clearDangle(id) // only THIS character's dangle chains
  // Props riding this character's bones -> back into the scene, not disposed
  // along with the skeleton (disposeObject below would otherwise free their
  // geometry too, since a bone's children are part of its subtree).
  const detachedIds = detachObjectsForCharacter(id)
  for (const objId of detachedIds) useStore.getState().setObjectAttachment(objId, null)
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
export async function addObjectFile(file, { animationKey } = {}) {
  const shouldFrameInitialObject = state.characters.size === 0 && useStore.getState().sceneObjects.length === 0
  const parsed = await loadModel(file)
  const meta = addObject(parsed, parsed.info.name, parsed.info.format, file, animationKey)
  registerObjectMeshes(meta.id, parsed.meshes) // makes its parts pickable/editable in Mesh mode
  useStore.getState().addSceneObject(meta) // sets selectedObjectId = meta.id
  if (state.characters.size === 0) useStore.getState().setMode('object')
  applyModelMaterials() // pick up the current Look settings immediately
  recordObjectAdded(meta.id)
  if (shouldFrameInitialObject) setCameraToObject(meta.id)
  requestRender()
  return meta
}

// Import a model file (.glb/.gltf/.fbx) without the caller having to say
// whether it's a character or a prop: parse it once just to check for a
// skeleton, dispose that throwaway parse immediately (nothing from it is
// added to the scene — this is purely a probe, so it must not leak), then
// hand the file to whichever *real*, already-tested path fits — loadModelFile
// (as a brand-new character, never replacing the active one) if it's rigged,
// addObjectFile (a static prop) if it isn't. Used by the title bar's unified
// "Import Model…", so a person never has to know or care which panel a given
// file "belongs" to.
// Import a BVH file straight onto the active character, using the
// retarget's own best-guess bone mapping — no manual mapping-review step
// (for that, use the Animate panel's own Import BVH, which shows the
// mapping editor before applying). This does exactly the same store
// bookkeeping AnimationPanel's onRetarget does right after
// applyBVHRetarget (registering the clip name, selecting it, resetting
// playback to paused at t=0) — that bookkeeping is NOT part of
// applyBVHRetarget itself (animation.js deliberately has no store
// dependency), so a caller that skips it produces a clip that's retargeted
// in memory but invisible to the Animate panel's clip list and, because
// getProjectData saves importedClipNames from the store rather than the
// mixer's own list, silently missing from "importedClipNames" on save
// even though the underlying keyframe data (importedClips) is still there.
// This one shared function is what both the title bar and any future
// "quick BVH import" entry point should call, so that bookkeeping can't be
// forgotten again — see Titlebar.bvhimport.test.js.
export async function importBVHAuto(file) {
  const guess = await beginBVHImport(file)
  const { name, matched, total } = await applyBVHRetarget(guess.slots)
  const s = useStore.getState()
  s.addImportedClipName(name)
  s.setPlaybackSource('clip')
  s.setActiveClipName(name)
  const duration = selectClip(name, { loop: s.loop, speed: s.speed }, s.animData)
  s.setDuration(duration)
  s.setCurrentTime(0)
  s.setPlayback('paused')
  return { name, matched, total }
}

export async function importModelAuto(file) {
  useStore.getState().setLoading(true)
  try {
    const probe = await loadModel(file, { autoDecimate: false })
    const isRigged = !!(probe.info?.bones?.length)
    disposeObject(probe.root)
    if (isRigged) {
      const parsed = await loadModelFile(file, { addNew: true })
      return { kind: 'character', name: parsed.info.name }
    }
    const meta = await addObjectFile(file)
    return { kind: 'object', name: meta.name }
  } catch (error) {
    if (useStore.getState().loading) useStore.getState().setLoadError(error.message || String(error))
    throw error
  } finally {
    if (useStore.getState().loading) useStore.getState().setLoading(false)
  }
}

// Load an image file and add it as a movable reference plane. Like addObjectFile
// it does NOT replace the character and selects the new plane so the gizmo is
// ready. Errors propagate to the caller.
export async function addImageFile(file, { animationKey } = {}) {
  const shouldFrameInitialObject = state.characters.size === 0 && useStore.getState().sceneObjects.length === 0
  const { texture, aspect } = await loadImageTexture(file)
  const name = file.name.replace(/\.[^.]+$/, '')
  const meta = addImage(texture, name, aspect, file, animationKey)
  useStore.getState().addSceneObject({ ...meta, kind: 'image' })
  recordObjectAdded(meta.id)
  if (shouldFrameInitialObject) setCameraToObject(meta.id)
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

// --- Undoable add / delete of props & images ---------------------------------
// One "presence" step per add or delete, living in the object undo history.
// Delete = soft-detach (resources kept alive for Undo); the batch frees them in
// discard() once it can no longer be undone/redone back into the scene.
function removePresence(batch) {
  const store = useStore.getState()
  const index = store.sceneObjects.findIndex((o) => o.id === batch.id)
  const meta = index >= 0 ? store.sceneObjects[index] : null
  const rec = detachObjectSoft(batch.id)
  if (!rec) return false
  batch.rec = rec
  batch.meta = meta
  batch.index = index
  batch.track = store.objectAnimData?.[rec.entry.animationKey] || null
  // The keyframe recorder must not log the track removal as its own step.
  runWithoutHistoryCapture(() => {
    unregisterObjectMeshes(batch.id) // drop its parts from Mesh mode
    useStore.getState().removeSceneObject(batch.id)
    useStore.getState().removeObjectAnimationTrack(rec.entry.animationKey)
  })
  requestRender()
  return true
}

function restorePresence(batch) {
  const rec = batch.rec
  if (!rec) return false
  reattachObjectSoft(rec)
  const { entry } = rec
  runWithoutHistoryCapture(() => {
    const store = useStore.getState()
    if (batch.meta) {
      const sceneObjects = [...store.sceneObjects]
      sceneObjects.splice(Math.min(Math.max(batch.index, 0), sceneObjects.length), 0, batch.meta)
      useStore.setState({
        sceneObjects,
        selectedObjectId: entry.id,
        selectedObjectIds: [entry.id],
        selectedBoneName: null,
        selectedBoneNames: [],
        selectedCameraId: null,
        selectedLightId: null,
      })
    }
    if (rec.wasAttached) useStore.getState().setObjectAttachment(entry.id, null)
    if (batch.track) {
      useStore.setState((s) => ({ objectAnimData: { ...s.objectAnimData, [entry.animationKey]: batch.track } }))
    }
  })
  if (entry.meshes?.length) registerObjectMeshes(entry.id, entry.meshes)
  batch.rec = null
  requestRender()
  return true
}

function pushPresenceBatch(kind, id) {
  const batch = {
    entries: [], // presence steps carry no transform snapshots
    kind, // 'add' | 'delete'
    id,
    rec: null, // set while the object is detached (removed)
    meta: null,
    index: -1,
    track: null,
    // Undo of a delete / redo of an add puts the object back; the other two take it out.
    run(direction) {
      const putBack = (kind === 'delete') === (direction === 'undo')
      if (putBack) restorePresence(batch)
      else removePresence(batch)
    },
    // Dropped from history while detached -> nothing can bring it back; free it.
    discard() {
      if (batch.rec) {
        disposeObjectEntry(batch.rec.entry)
        batch.rec = null
      }
    },
  }
  return batch
}

// Log that a prop/image was just added (undo removes it, redo brings it back).
function recordObjectAdded(id) {
  pushUndoBatch('object', pushPresenceBatch('add', id))
}

export function removeObjectById(id, recordHistory = true) {
  const target = useStore.getState().sceneObjects.find((o) => o.id === id)
  if (target?.isCharacter) {
    removeCharacter(id, recordHistory) // characters live in their own registry
    return
  }
  if (!recordHistory) {
    // Permanent removal (scene teardown): free everything now, no undo step.
    unregisterObjectMeshes(id) // drop its parts from Mesh mode before the geometry is disposed
    removeObject(id)
    useStore.getState().removeSceneObject(id)
    requestRender()
    return
  }
  const meta = target
  if (!meta) return
  const batch = pushPresenceBatch('delete', id)
  if (!removePresence(batch)) return
  pushUndoBatch('object', batch)
}

// Show/hide a prop, image, or the character (updates the scene + the store).
export function setObjectVisibleById(id, visible, recordHistory = true) {
  setObjectVisible(id, visible, recordHistory)
  useStore.getState().setObjectVisible(id, visible)
}

export function setMeshVisibleByUuid(uuid, visible) {
  setMeshVisibleInScene(uuid, visible)
  useStore.getState().setMeshVisible(uuid, visible)
}

export function copyObjectById(id) {
  const copied = copyObject(id)
  if (copied) clearCopiedCharacterData()
  return copied
}

export function pasteCopiedObject() {
  const meta = pasteObject()
  if (!meta) return null
  useStore.getState().addSceneObject(meta)
  registerObjectMeshes(meta.id, getObjectMeshesById(meta.id))
  recordObjectAdded(meta.id)
  return meta
}

export function hasCopiedObjectData() {
  return hasCopiedObject()
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
// Bone attachment (props parented to a character bone, e.g. a sword in a hand)
// ---------------------------------------------------------------------------

// Attach a prop to a bone by name on the currently active character (updates
// the scene + the store). Passing boneName=null/'' detaches it back into the
// scene at its current world position.
export function setObjectAttachmentById(id, boneName) {
  clearObjectAttachmentTrack(id)
  if (!boneName) {
    detachObject(id)
    useStore.getState().setObjectAttachment(id, null)
    requestRender()
    return
  }
  const bone = getBoneByName(boneName)
  if (!bone) return
  attachObjectToBone(id, bone, boneName, state.activeCharacterId)
  useStore.getState().setObjectAttachment(id, boneName)
  requestRender()
}

export function keyObjectAttachmentById(id, boneName, time) {
  const characterId = boneName ? state.activeCharacterId : null
  const characterName = boneName ? state.currentModel?.info.name : null
  return keyObjectAttachment(id, boneName, time, characterId, characterName, (name, idForBone, nameForBone) => {
    const model = [...state.characters.values()].find((candidate) => candidate.info.name === nameForBone) ||
      state.characters.get(idForBone) ||
      state.currentModel
    return model?.bones?.find((bone) => bone.name === name) || null
  })
}

export function clearObjectAttachmentTimeline(id) {
  clearObjectAttachmentTrack(id)
}

export function removeObjectAttachmentKeyById(id, time) {
  return removeObjectAttachmentKey(id, time)
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
  // A hard set always wins over a glide that's still in flight. Without this a
  // leftover glide (the previous shot's restore, or a camera cut) keeps running
  // and, when it finishes, writes its OLD destination back into the store —
  // yanking the view off the camera mid-recording.
  state.camTransition = null
  state.viewCamera = cam
  setActiveCameraBody(!!cam) // hide every camera body while looking through one
  if (cam && state.container) {
    cam.aspect = getViewAspect()
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
  tc.aspect = getViewAspect()
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
    // If the store already held this id the store write above is a no-op and
    // the Viewport effect never fires, which would leave the view stuck on the
    // scratch glide camera (frozen, no longer following the real camera's
    // keyframes). Landing on the real camera directly is idempotent.
    setViewCameraById(tr.finalId)
  }
}

// Finish any in-flight camera glide immediately, landing exactly on its
// destination. Used before a preview/recording starts so the shot is framed
// from the settled view instead of a half-finished glide.
export function settleCameraTransition() {
  const tr = state.camTransition
  if (!tr) return false
  state.camTransition = null
  useStore.getState().setViewCameraId(tr.finalId)
  setViewCameraById(tr.finalId)
  return true
}

export function isCameraTransitionActive() {
  return !!state.camTransition
}

// Test seams: drive the camera glide without a WebGL render loop.
export function __setViewCameraRefsForTest(camera, controls = null) {
  state.camera = camera
  state.controls = controls
  state.container = state.container || { clientWidth: 100, clientHeight: 100 }
}
export function __setRendererForTest(renderer, container) {
  state.renderer = renderer
  state.container = container
}
export function __applyOutputSizeForTest(width, height) {
  return applyOutputSize(width, height)
}
export function __tickCameraTransitionForTest(delta) {
  updateCamTransition(delta)
}
export function __getViewCameraForTest() {
  return state.viewCamera
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

// Export every visible character and prop combined into a single .glb/.gltf
// file, each one baked at its current saved position/rotation/scale. Props
// riding a bone (attachObjectToBone) are flattened onto that world transform
// too, so the exported file is a plain static layout — a "photo" of the
// scene's arrangement, not a rig or an animation (use "Export animation
// (.bvh)" for that). GLTFExporter and SkeletonUtils are dynamically imported
// since this is a rarely-used, moderately heavy code path.
//
// NOTE: three.js does not ship an FBX exporter (only FBXLoader, for reading
// .fbx in), so there is no in-app "Save as .fbx". The .glb this produces can
// be opened in Blender and re-exported as .fbx in a couple of clicks if an
// .fbx is specifically needed.
// poseMode: 'current' (default) exports the pose on screen; 'rest' exports every
// character in its un-posed rest pose (on the export copy only — the live
// character is never touched). See exportPose.js.
export async function exportSceneModel(format = 'glb', name = 'scene', poseMode = 'current') {
  const items = getAllRootsForExport()
  if (!items.length) {
    return { ok: false, message: 'Nothing to export — load a character or add an object first.' }
  }
  try {
    const [{ GLTFExporter }, { cloneForExport }] = await Promise.all([
      import('three/examples/jsm/exporters/GLTFExporter.js'),
      import('./exportPose.js'),
    ])

    // Fresh, transform-less parent: every child below gets its WORLD matrix
    // baked into its local transform, so nesting (e.g. a prop parented under
    // a character's bone) collapses into one flat, self-contained group.
    const exportGroup = new THREE.Group()
    exportGroup.name = 'Scene'
    for (const { root, name: objName } of items) {
      root.updateWorldMatrix(true, false)
      // Preserves SkinnedMesh <-> skeleton/bone bindings, keeps the model's
      // original inverse-bind data, and (poseMode 'rest') un-poses the copy.
      const model = [...state.characters.values()].find((c) => c.root === root)
      const dup = cloneForExport(root, { pose: poseMode, restQuats: model?.__poseRestQuats || null })
      dup.name = objName || dup.name
      root.matrixWorld.decompose(dup.position, dup.quaternion, dup.scale)
      exportGroup.add(dup)
    }

    const binary = format !== 'gltf'
    const exporter = new GLTFExporter()
    const result = await new Promise((resolve, reject) => {
      exporter.parse(exportGroup, resolve, reject, { binary, onlyVisible: true })
    })

    const blob = binary
      ? new Blob([result], { type: 'model/gltf-binary' })
      : new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })
    const ext = binary ? 'glb' : 'gltf'
    downloadBlob(blob, `${name}_${timestamp()}.${ext}`)
    return {
      ok: true,
      message: `Exported ${items.length} object${items.length === 1 ? '' : 's'} as .${ext}.`,
    }
  } catch (err) {
    return { ok: false, message: 'Export failed: ' + (err && err.message ? err.message : String(err)) }
  }
}

// Largest canvas side the GPU will give us (texture + viewport limits).
function getMaxOutputSide() {
  try {
    const gl = state.renderer.getContext()
    const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS)
    const tex = state.renderer.capabilities.maxTextureSize || 4096
    return Math.max(256, Math.min(tex, dims?.[0] || tex, dims?.[1] || tex))
  } catch {
    return 4096
  }
}

// What a save/record would produce right now, for the Export panel's caption.
export function previewOutputSize(kind) {
  const s = useStore.getState()
  const w = state.container?.clientWidth || 1
  const h = state.container?.clientHeight || 1
  const isVideo = kind === 'video'
  const resolution = isVideo ? s.exportVideoResolution : s.exportImageResolution
  if (resolution === 'viewport' && s.exportAspect === 'viewport') {
    const ratio = isVideo ? state.pixelRatio : (s.exportScale || 1) * state.pixelRatio
    return { width: Math.floor(w * ratio), height: Math.floor(h * ratio), clamped: false, requested: null }
  }
  return computeOutputSize({
    resolution,
    aspect: s.exportAspect,
    viewportW: w * (resolution === 'viewport' ? (isVideo ? state.pixelRatio : (s.exportScale || 1) * state.pixelRatio) : 1),
    viewportH: h * (resolution === 'viewport' ? (isVideo ? state.pixelRatio : (s.exportScale || 1) * state.pixelRatio) : 1),
    maxSide: isVideo ? Math.min(getMaxOutputSide(), MAX_VIDEO_SIDE) : getMaxOutputSide(),
    evenSizes: isVideo,
  })
}

// Render at an exact pixel size (device pixel ratio 1) until the returned
// restore function is called. Cameras are re-aspected to match; the on-screen
// canvas is letterboxed so it never looks stretched.
function applyOutputSize(width, height) {
  const renderer = state.renderer
  const canvas = renderer.domElement
  state.outputOverride = { width, height }
  canvas.style.objectFit = 'contain'
  handleResize()
  return () => {
    state.outputOverride = null
    canvas.style.objectFit = ''
    renderer.setPixelRatio(getPerformancePixelRatio())
    handleResize()
  }
}

// Save the current frame as a PNG. Size comes from the Export panel: either the
// viewport × `scale` (legacy "1×/2×/4×"), or a fixed preset like 1080p / 4K / 8K
// in the chosen aspect (clamped to what the GPU supports). Transparent
// background is preserved (alpha), so it drops into 2D art. Returns the pixel
// size actually written, or null if nothing could be exported.
export function exportPNG(scale = 2, name = 'render') {
  if (!state.renderer || !state.container || state.outputOverride) return null
  const s = useStore.getState()
  const w = state.container.clientWidth || 1
  const h = state.container.clientHeight || 1
  const fixed = s.exportImageResolution !== 'viewport' || s.exportAspect !== 'viewport'
  const size = fixed
    ? computeOutputSize({
        resolution: s.exportImageResolution,
        aspect: s.exportAspect,
        viewportW: w * (s.exportImageResolution === 'viewport' ? scale : 1),
        viewportH: h * (s.exportImageResolution === 'viewport' ? scale : 1),
        maxSide: getMaxOutputSide(),
        evenSizes: false,
      })
    : null
  let restore
  if (size) {
    restore = applyOutputSize(size.width, size.height)
  } else {
    state.renderer.setSize(w * scale, h * scale, false) // false: keep CSS size, bigger buffer
    restore = () => {
      state.renderer.setSize(w, h, false)
      requestRender()
    }
  }
  renderOnce()
  const out = { width: state.renderer.domElement.width, height: state.renderer.domElement.height, clamped: !!size?.clamped }
  state.renderer.domElement.toBlob((blob) => {
    if (blob) downloadBlob(blob, `${name}_${timestamp()}.png`)
    restore()
    requestRender()
  }, 'image/png')
  return out
}

// True if the browser can record the canvas to a video.
export function canRecordVideo() {
  if (webCodecsAvailable()) return true
  return typeof MediaRecorder !== 'undefined' && !!state.renderer?.domElement?.captureStream
}

// Briefly match a shot PREVIEW to the recording's shape (not its pixel count)
// so framing is what the video will show. No-op when the shape follows the viewport.
export function beginPreviewFraming() {
  const s = useStore.getState()
  if (!state.renderer || state.outputOverride || s.exportAspect === 'viewport') return () => {}
  const size = computeOutputSize({
    resolution: '720p',
    aspect: s.exportAspect,
    viewportW: 1,
    viewportH: 1,
    maxSide: getMaxOutputSide(),
  })
  return applyOutputSize(size.width, size.height)
}

// Start recording the live canvas using the Export panel's video settings
// (resolution, aspect, frame rate, quality, container). Resolves to details of
// what is being recorded, or null if unsupported / it could not start.
//
// Both MP4 (H.264) and WebM (VP9/VP8) are encoded with WebCodecs + a muxer, so
// every frame carries an explicit timestamp and the file has a real duration
// and seek index. MediaRecorder (wall-clock timestamps, no duration, ends up
// truncated or frozen when the encoder stalls) is only the last resort for
// browsers without WebCodecs. The encoder is warmed up here, before playback
// starts, so the opening frames aren't lost to encoder start-up.
// Call beginRecordingClock() the moment playback starts.
export async function startRecording() {
  if (state.recorder || state.videoCapture || state.recorderStarting || state.outputOverride) return null
  const s = useStore.getState()
  const wantMp4 = s.exportVideoFormat === 'mp4'
  const canWebCodecs = webCodecsAvailable()
  if (!canWebCodecs && !canRecordVideo()) return null
  state.recorderStarting = true
  try {
    const fps = [24, 30, 60].includes(s.exportVideoFps) ? s.exportVideoFps : 30
    const size = previewOutputSize('video')
    const fixed = s.exportVideoResolution !== 'viewport' || s.exportAspect !== 'viewport'
    const restore = fixed ? applyOutputSize(size.width, size.height) : () => {}
    renderOnce() // give the stream a correctly-sized first frame
    const canvas = state.renderer.domElement
    const width = canvas.width - (canvas.width % 2) // encoders need even sizes
    const height = canvas.height - (canvas.height % 2)
    const bitrate = videoBitrate({ width, height, fps, quality: s.exportVideoQuality })
    const info = { width, height, fps, bitrate, clamped: size.clamped, fellBack: false, ext: 'webm' }

    if (canWebCodecs) {
      // Requested container first; if the browser can't encode it, the other one
      // (MP4 → WebM) before giving up on WebCodecs altogether.
      const order = wantMp4 ? ['mp4', 'webm'] : ['webm']
      for (const container of order) {
        try {
          const config = await findVideoConfig(container, { width, height, fps, bitrate })
          if (!config) continue
          // Literal specifiers: Vite can only bundle (and chunk) a dynamic import it can read.
          const muxerLib = container === 'mp4' ? await import('mp4-muxer') : await import('webm-muxer')
          const capture = new VideoCapture({
            canvas,
            width,
            height,
            fps,
            config,
            container,
            Muxer: muxerLib.Muxer,
            ArrayBufferTarget: muxerLib.ArrayBufferTarget,
            manualStart: true, // timestamps start when playback does (beginRecordingClock)
          })
          state.videoCapture = capture
          state.recordingFrameInterval = 1000 / fps
          state.lastRecordingFrameAt = -Infinity
          state.recordingMeta = { ext: container, blobType: capture.mime, restore }
          await capture.warmUp(() => renderOnce()) // pay the encoder's start-up cost now
          if (capture.error) throw capture.error
          return { ...info, ext: container, fellBack: wantMp4 && container !== 'mp4' }
        } catch (err) {
          console.warn(`WebCodecs ${container} recording failed, trying the next option:`, err)
          state.videoCapture?.cancel()
          state.videoCapture = null
          state.recordingMeta = null
        }
      }
    }

    // MediaRecorder path (WebM, or MP4 unavailable → WebM).
    if (!canRecordVideo()) {
      restore()
      return null
    }
    const format = pickVideoFormat('webm', (t) => MediaRecorder.isTypeSupported(t))
    let recorder = null
    let stream = null
    try {
      stream = canvas.captureStream(fps)
      const attempts = [
        { mimeType: format.mimeType || undefined, videoBitsPerSecond: bitrate },
        { mimeType: format.mimeType || undefined },
        undefined,
      ]
      for (const options of attempts) {
        try {
          recorder = new MediaRecorder(stream, options)
          break
        } catch {
          recorder = null
        }
      }
      if (!recorder) throw new Error('MediaRecorder could not be created')
    } catch {
      stream?.getTracks().forEach((track) => track.stop())
      restore()
      return null
    }
    state.recordedChunks = []
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) state.recordedChunks.push(e.data)
    }
    try {
      recorder.start(1000) // flush a chunk every second so long recordings don't sit in one buffer
    } catch {
      stream.getTracks().forEach((track) => track.stop())
      restore()
      return null
    }
    state.recorder = recorder
    state.recordingFrameInterval = 1000 / fps
    state.lastRecordingFrameAt = -Infinity
    state.recordingMeta = { ext: 'webm', blobType: format.blobType, restore, startedAt: performance.now() } // startedAt re-anchored by beginRecordingClock()
    return { ...info, ext: 'webm', fellBack: wantMp4 }
  } finally {
    state.recorderStarting = false
  }
}

// Playback has just started: frame timestamps are measured from this moment.
export function beginRecordingClock() {
  const now = performance.now()
  state.videoCapture?.begin(now)
  if (state.recordingMeta && state.recorder) state.recordingMeta.startedAt = now
}

// Stop recording and download the video. Resolves { ok, error? } once the file
// has been written (MP4 needs a moment to flush the encoder).
export async function stopRecordingAndDownload(name = 'animation') {
  const meta = state.recordingMeta || { ext: 'webm', blobType: 'video/webm', restore: () => {} }
  const capture = state.videoCapture
  if (capture) {
    state.videoCapture = null
    state.recordingMeta = null
    state.recordingFrameInterval = 0
    state.lastRecordingFrameAt = -Infinity
    capture.stopCapturing(typeof performance !== 'undefined' ? performance.now() : 0) // last frame, at recording size
    meta.restore()
    requestRender()
    try {
      const blob = await capture.finish()
      downloadBlob(blob, `${name}_${timestamp()}.${capture.ext}`)
      return { ok: true, dropped: capture.dropped }
    } catch (error) {
      return { ok: false, error }
    }
  }
  const recorder = state.recorder
  if (!recorder) return { ok: false }
  return new Promise((resolve) => {
    const stoppedAt = performance.now()
    recorder.onstop = async () => {
      let blob = new Blob(state.recordedChunks, { type: meta.blobType })
      state.recordedChunks = []
      meta.restore()
      requestRender()
      if (meta.ext === 'webm' && meta.startedAt != null) {
        // MediaRecorder writes WebM with no duration, so players show no scrub
        // bar. Writing the duration into the header fixes that. (Never fails:
        // on anything unexpected it hands back the original file.)
        try {
          const { default: fixWebmDuration } = await import('fix-webm-duration')
          blob = await fixWebmDuration(blob, Math.max(1, Math.round(stoppedAt - meta.startedAt)), { logger: false })
        } catch {
          // keep the unpatched file
        }
      }
      downloadBlob(blob, `${name}_${timestamp()}.${meta.ext}`)
      resolve({ ok: true })
    }
    state.recorder = null
    state.recordingMeta = null
    state.recordingFrameInterval = 0
    state.lastRecordingFrameAt = -Infinity
    recorder.stop()
  })
}

// Enter fullscreen on the viewport (Esc exits — browser default).
export function enterFullscreen() {
  // The itch.io embed owns fullscreen and may reject the app's request while
  // trying to lock orientation.
  if (window.self !== window.top) return
  const el = state.container && state.container.parentElement
  if (!el || !el.requestFullscreen) return
  // Fullscreen and orientation locking are optional and can be rejected by
  // embedded browsers such as itch.io's game frame.
  el.requestFullscreen().catch(() => {})
}

// ---------------------------------------------------------------------------
// Scene save / load (layout: character + object transforms + current pose)
// ---------------------------------------------------------------------------

// Capture where the orbit camera is currently looking from — position, orbit
// target and FOV — so a save can restore the exact view instead of leaving it
// wherever it happened to be (e.g. framed for a since-resized character).
// Zoom done via OrbitControls scroll is a dolly (camera moves along its view
// direction), so `position` alone already captures it; no separate zoom field
// needed.
export function getViewportCameraData() {
  if (!state.camera || !state.controls) return null
  return {
    position: state.camera.position.toArray(),
    target: state.controls.target.toArray(),
    fov: state.camera.fov,
  }
}

// Restore a previously captured viewport camera. Called AFTER models/objects
// are loaded (which auto-frame the camera to fit) so this has the final say —
// otherwise a saved "zoomed in on tiny character" view would get overwritten
// by the auto-frame's own guess.
export function applyViewportCameraData(data) {
  if (!data || !state.camera || !state.controls) return
  if (Array.isArray(data.position)) state.camera.position.fromArray(data.position)
  if (Array.isArray(data.target)) state.controls.target.fromArray(data.target)
  if (typeof data.fov === 'number') state.camera.fov = data.fov
  state.camera.updateProjectionMatrix()
  state.controls.update()
  requestRender()
}

// Capture the placement of the character and every prop, plus the current pose.
// NOTE: this stores TRANSFORMS, not geometry — reload the same files, then Load
// scene to restore where everything sat.
export function getSceneData() {
  const data = {
    format: 'scene-v1',
    objects: getObjectsData(),
    cameras: getCamerasData(),
    lights: getLightsData(),
    viewportCamera: getViewportCameraData(),
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
  applyObjectsData(json.objects, getBoneByName)
  // Sync the store's per-object attachment flag (drives the panel's dropdown)
  // now that objects.js has resolved/applied whatever attachment was saved.
  {
    const st = useStore.getState()
    for (const so of st.sceneObjects) {
      const att = getObjectAttachment(so.id)
      st.setObjectAttachment(so.id, att ? att.boneName : null)
    }
  }
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
  if (json.viewportCamera) applyViewportCameraData(json.viewportCamera)
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
    colorGrading: s.colorGrading,
    ambientOcclusionStrength: s.ambientOcclusionStrength,
    backlightColor: s.backlightColor,
    backlightFalloff: s.backlightFalloff,
    lightLinks: s.lightLinks,
    rimLightColor: s.rimLightColor,
    rimSideOnly: s.rimSideOnly,
    rimSoftEnabled: s.rimSoftEnabled,
    rimSoftIntensity: s.rimSoftIntensity,
    rimSoftWidth: s.rimSoftWidth,
    rimHardEnabled: s.rimHardEnabled,
    rimHardIntensity: s.rimHardIntensity,
    rimHardWidth: s.rimHardWidth,
    rimFollowLight: s.rimFollowLight,
    // Save the light's position in the list, not its runtime id — ids aren't
    // stable across a reload (see the restore-side comment near applyLightsData).
    rimFollowLightIndex: (() => {
      const idx = s.sceneLights.findIndex((lt) => lt.id === s.rimFollowLightId)
      return idx < 0 ? null : idx
    })(),
    lightIntensity: s.lightIntensity,
    lightAzimuth: s.lightAzimuth,
    lightElevation: s.lightElevation,
    defaultLightingEnabled: s.defaultLightingEnabled,
    envLightingEnabled: s.envLightingEnabled,
    envLightingIntensity: s.envLightingIntensity,
    outlineEnabled: s.outlineEnabled,
    outlineWidth: s.outlineWidth,
    outlineColor: s.outlineColor,
    outlineOpacity: s.outlineOpacity,
    softenEnabled: s.softenEnabled,
    softenAmount: s.softenAmount,
    showGrid: s.showGrid,
    showGround: s.showGround,
    limbLimits: s.limbLimits,
    solidBackground: s.solidBackground,
    backgroundColor: s.backgroundColor,
    showShadow: s.showShadow,
    shadowMapping: s.shadowMapping,
    shadowSoftness: s.shadowSoftness,
    shadowStrength: s.shadowStrength,
    shadowDefaultsVersion: 2, // projects saved before this carry the faint 0.15 defaults
    performanceMode: s.performanceMode,
    performanceBackgroundObjects: s.performanceBackgroundObjects,
    performanceLowPoly: s.performanceLowPoly,
    performanceResolution: s.performanceResolution,
    performanceEffects: s.performanceEffects,
    autoDecimate: s.autoDecimate,
    animFps: s.animFps,
    animDuration: s.animDuration,
    boneViewMode: s.boneViewMode, // 'bones' or 'parts' — which Pose overlay was showing
    stopAtFirstClipEnd: s.stopAtFirstClipEnd, // Play all / preview / export end when the first clip ends
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
      dangleEnabled: live.dangleEnabled,
      dangleChains: live.dangleChains,
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
    objects: getObjectsForSave(s.meshOverrides),
    objectAnimData: s.objectAnimData,
    objectAttachmentData: s.objectAttachmentData,
    objectAnimDuration: s.objectAnimDuration,
    cameras: getCamerasData(),
    lights: getLightsData(),
    // The orbit view itself (position/target/fov) — restored last in
    // applyProjectData, after character loads have done their own
    // auto-framing, so a project reloads looking exactly like it did when
    // saved instead of re-framed for whatever size the character loaded at.
    viewportCamera: getViewportCameraData(),
  }
}

// Tear down everything currently in the scene — every character, every prop/
// image, every camera and light — back to a blank session. Shared by
// applyProjectData's "load a project" reset and the sidebar's "Clear" button
// (New Project), so there's exactly one place that has to remember every
// piece of state a full reset needs to touch.
export function clearProjectScene() {
  const store = useStore.getState()
  stopObjectAnimation()
  store.clearObjectAnimation()
  store.setObjectAnimDuration(2)
  for (const id of store.sceneObjects.filter((o) => !o.isCharacter).map((o) => o.id)) {
    removeObjectById(id, false)
  }
  setViewCameraById(null)
  clearCameras()
  useStore.setState({ sceneCameras: [], selectedCameraId: null, viewCameraId: null })
  clearLights()
  useStore.setState({ sceneLights: [], selectedLightId: null })
  disposeCurrentModel()
  // A blank project starts with a blank undo history too.
  clearUndoHistory()
  useStore.setState({ stopAtFirstClipEnd: false }) // per-project setting
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
  clearProjectScene()


  // 2. Load every saved character. Older (project-v1) saves have a single
  // `record.character` instead of a `record.characters` array — normalise.
  const characterRecords = record.format === 'project-v1'
    ? (record.character ? [record.character] : [])
    : record.characters || []

  // The import policy must be in place before the saved model blobs are
  // parsed; the rest of the saved settings can safely be restored afterward.
  if (record.settings?.autoDecimate !== undefined) {
    useStore.setState({ autoDecimate: record.settings.autoDecimate })
  }
  if (record.settings?.performanceMode !== undefined) {
    useStore.setState({ performanceMode: record.settings.performanceMode })
  }
  if (record.settings?.performanceBackgroundObjects !== undefined) {
    useStore.setState({ performanceBackgroundObjects: record.settings.performanceBackgroundObjects })
  }
  if (record.settings?.performanceLowPoly !== undefined) {
    useStore.setState({ performanceLowPoly: record.settings.performanceLowPoly })
  }
  if (record.settings?.performanceResolution !== undefined) {
    useStore.setState({ performanceResolution: record.settings.performanceResolution })
  }
  if (record.settings?.performanceEffects !== undefined) {
    useStore.setState({ performanceEffects: record.settings.performanceEffects })
  }

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
      dangleEnabled: c.dangleEnabled ?? true,
      dangleChains: c.dangleChains || [],
    })
    setDangleConfig(id, model, c.dangleEnabled ?? true, c.dangleChains || [])
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
  // Projects saved while the shadow defaults were 0.15/0.15 stored those values
  // even though the user never chose them — keep the current settings instead.
  const oldShadowDefaults = st.shadowDefaultsVersion == null
  for (const k of [
    'materialMode', 'toonSteps', 'colorGrading',
    'ambientOcclusionStrength', 'backlightColor', 'backlightFalloff', 'lightLinks',
    'rimLightColor', 'rimSideOnly',
    'rimSoftEnabled', 'rimSoftIntensity', 'rimSoftWidth',
    'rimHardEnabled', 'rimHardIntensity', 'rimHardWidth',
    'lightIntensity', 'lightAzimuth', 'lightElevation', 'defaultLightingEnabled',
    'envLightingEnabled', 'envLightingIntensity',
    'outlineEnabled', 'outlineWidth', 'outlineColor', 'outlineOpacity', 'softenEnabled', 'softenAmount',
    'showGrid', 'showGround', 'limbLimits', 'solidBackground', 'backgroundColor', 'showShadow', 'shadowMapping',
    'shadowSoftness', 'shadowStrength', 'autoDecimate',
    'animFps', 'animDuration', 'boneViewMode',
  ]) {
    if (oldShadowDefaults && (k === 'shadowStrength' || k === 'shadowSoftness') && st[k] === 0.15) continue
    if (st[k] !== undefined) patch[k] = st[k]
  }
  // Per-project: a save from before this existed (or a project that never
  // turned it on) opens with it OFF, rather than inheriting the last project's.
  patch.stopAtFirstClipEnd = st.stopAtFirstClipEnd === true
  useStore.setState(patch) // Viewport effects push these into the scene reactively
  // Apply saved shared style settings immediately to every loaded character;
  // the active-character UI effect alone would leave inactive models behind.
  applyModelMaterials()

  // 4. Re-add props/images in order, restoring transform + visibility.
  for (const obj of record.objects || []) {
    if (!obj.blob) continue
    const file = new File([obj.blob], obj.fileName)
    const meta = obj.kind === 'image'
      ? await addImageFile(file, { animationKey: obj.animationKey })
      : await addObjectFile(file, { animationKey: obj.animationKey })
    // Re-attach to its bone (if any) BEFORE applying the saved transform —
    // attaching reparents-and-preserves-current-world-position, which we
    // then immediately overwrite with the saved (already bone-local) TRS.
    if (obj.attachedBoneName) setObjectAttachmentById(meta.id, obj.attachedBoneName)
    setObjectTransform(meta.id, obj.transform)
    setObjectVisibleById(meta.id, obj.visible !== false, false)
    // Restore this prop's per-part (mesh) overrides — saved keyed by mesh
    // INDEX (see objectMeshOverridesByIndex in objects.js), remapped here
    // onto whatever fresh uuids this load just gave its meshes.
    if (obj.meshOverridesByIndex) {
      const meshes = getObjectMeshesById(meta.id)
      const patch = {}
      for (const [idx, ov] of Object.entries(obj.meshOverridesByIndex)) {
        const mesh = meshes[Number(idx)]
        if (mesh) patch[mesh.uuid] = ov
      }
      if (Object.keys(patch).length) {
        useStore.setState((s2) => ({ meshOverrides: { ...s2.meshOverrides, ...patch } }))
      }
    }
    if (obj.kind !== 'image') {
      // 'lit' is the old (pre-styles) save field: false meant "flat/unlit".
      // Map it onto the new style system so older project files still work.
      const style = obj.style || (obj.lit === false ? 'unlit' : 'auto')
      if (style !== 'auto') setObjectStyleById(meta.id, style)
      if (obj.outline) setObjectOutlineById(meta.id, true)
      if (obj.castShadow === false) setObjectCastShadowById(meta.id, false)
    }
  }

  const objectAnimData = record.objectAnimData || {}
  const objectAttachmentData = record.objectAttachmentData || {}
  const latestObjectKeyTime = [
    ...Object.values(objectAnimData).map((keys) => keys?.[keys.length - 1]?.time || 0),
    ...Object.values(objectAttachmentData).map((track) => track?.keys?.[track.keys.length - 1]?.time || 0),
  ].reduce((latest, time) => Math.max(latest, time), 0)
  useStore.setState({
    objectAnimData,
    objectAttachmentData,
    objectAnimDuration: Math.max(Number(record.objectAnimDuration) || 2, latestObjectKeyTime),
    objectAnimTime: 0,
    objectAnimPlaying: false,
  })

  // 4b. Recreate the placed cameras (procedural — no blobs involved).
  if (Array.isArray(record.cameras) && record.cameras.length) {
    const metas = applyCamerasData(record.cameras)
    useStore.setState({ sceneCameras: metas, selectedCameraId: null, viewCameraId: null })
  }

  // 4c. Recreate the placed lights (procedural — no blobs involved).
  if (Array.isArray(record.lights) && record.lights.length) {
    const metas = applyLightsData(record.lights)
    useStore.setState({ sceneLights: metas, selectedLightId: null })
    // Light ids aren't stable across a save/load (each restore mints new
    // ones) — st.rimFollowLightIndex is the saved light's position in the
    // list instead, remapped to whatever id it got this time.
    if (st.rimFollowLight && st.rimFollowLightIndex != null && metas[st.rimFollowLightIndex]) {
      useStore.setState({ rimFollowLight: true, rimFollowLightId: metas[st.rimFollowLightIndex].id })
      applyModelMaterials()
    }
  }

  // 5. (animData is already restored per-character inside the load loop
  // above — see step 2 — so there's nothing left to do here.)

  // 6. Restore the saved view LAST — loadModelFile auto-frames the camera to
  // fit whatever just loaded, so doing this any earlier would get clobbered.
  // Falls back to whatever auto-frame already did if the project predates
  // this field (older saves simply won't have `viewportCamera`).
  if (record.viewportCamera) applyViewportCameraData(record.viewportCamera)

  // 7. Re-sync the Body Parts overlay now that pose, mesh edits and materials
  // have all finished being restored — see refreshPoseOverlays for why this
  // needs to happen after everything else, not just once inside the load
  // loop above.
  refreshPoseOverlays()

  // The freshly loaded project starts with a clean undo history — the add/key
  // steps recorded while rebuilding it aren't things a person did.
  clearUndoHistory()

  requestRender()
}

// Dispose EVERY loaded character (full reset — used by the "clear" button and
// full scene teardown). To remove a single character instead, use removeCharacter().
export function disposeCurrentModel() {
  for (const id of [...state.characters.keys()]) disposeCharacter(id)
  state.activeCharacterId = null
  state.currentModel = null
  useStore.getState().clearAllCharacters()
  if (useStore.getState().sceneObjects.some((object) => !object.isCharacter)) useStore.getState().setMode('object')
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
  // A newly framed model starts from the default fit; the next shadow pass
  // refits to every caster and re-probes the floor under the character.
  state.shadowFit = null
  state.shadowFloorY = null
  state.shadowFloorProbeAt = 0

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
// shadows across the character and nearby props without wasting map texels on
// empty space. `r` ~ the model's max dimension.
function positionLight() {
  const dl = state.dirLight
  if (!dl) return
  const r = state.modelRadius
  // Until a shadow pass has fitted the camera to the scene's casters, cover
  // ±3× the model size around the model; afterwards use the fitted extents.
  const center = state.shadowFit?.center || state.modelCenter
  const half = state.shadowFit?.half ?? Math.max(r * 3, 1)
  const depth = Math.max(r * 5, half * 1.8) // sphere of casters must fit between near and far
  const dist = Math.max(10, r * 6, half * 2) // high & far so the frustum sits above the scene
  dl.position.copy(center).addScaledVector(state.lightDir, dist)
  dl.target.position.copy(center)
  dl.target.updateMatrixWorld()

  const cam = dl.shadow.camera
  cam.left = -half
  cam.right = half
  cam.top = half
  cam.bottom = -half
  cam.near = Math.max(0.01, dist - depth)
  cam.far = dist + depth
  cam.updateProjectionMatrix()
  // Scale-aware normal bias: a couple of shadow-map texels in world units keeps
  // acne away without peter-panning, however far the frustum was stretched.
  const texel = (half * 2) / (dl.shadow.mapSize.x || SHADOW_MAP_SIZE)
  dl.shadow.normalBias = Math.max(texel * 2, r * 0.004)
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
  syncShadowReceiverVisibility()
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

function getPerformancePixelRatio() {
  if (state.outputOverride) return 1 // exact export pixels, no device-ratio scaling
  return state.performanceLowPoly
    ? Math.min(state.pixelRatio, state.performanceResolution)
    : state.pixelRatio
}

function applyPerformanceSettings() {
  if (state.renderer) state.renderer.setPixelRatio(getPerformancePixelRatio())
  applyShadowMode()
  requestRender()
}

export function setPerformanceMode(on) {
  state.performanceMode = !!on
}

export function setPerformanceBackgroundObjects(on) {
  state.performanceBackgroundObjects = !!on
  requestRender()
}

export function setPerformanceLowPoly(on) {
  state.performanceLowPoly = !!on
  if (state.renderer) state.renderer.setPixelRatio(getPerformancePixelRatio())
  requestRender()
}

export function setPerformanceResolution(resolution) {
  state.performanceResolution = Math.min(1, Math.max(0.25, Number(resolution) || 0.5))
  if (state.renderer) state.renderer.setPixelRatio(getPerformancePixelRatio())
  requestRender()
}

export function setPerformanceEffects(on) {
  const enabled = !!on
  const outline = getOutlineEffect()
  if (outline && enabled && state.performanceMode) {
    state.outlineBeforePerformance = outline.enabled
    outline.enabled = false
  } else if (outline && !enabled && state.performanceMode) {
    outline.enabled = state.outlineBeforePerformance
  }
  state.performanceEffects = enabled
  applyPerformanceSettings()
}

// Blur amount for the real cast shadow's edge, 0 (crisp/hard) – 1 (very soft).
// Maps onto the light's shadow.radius (PCF sample spread) and blurSamples (how
// many taps go into that spread) — more samples keeps a wide blur from looking
// noisy/banded.
export function setShadowSoftness(softness) {
  state.shadowSoftness = softness
  const dl = state.dirLight
  if (dl) {
    dl.shadow.radius = Math.min(8, softness * 12)
    dl.shadow.blurSamples = Math.round(8 + softness * 16)
  }
  requestRender()
}

// Darkness of the real cast shadow, 0 (barely visible) – 1 (solid black).
export function setShadowStrength(strength) {
  state.shadowStrength = strength
  if (state.shadowReceiver) state.shadowReceiver.material.opacity = strength
  updateShadowDarkness()
  requestRender()
}

// ---------------------------------------------------------------------------
// Camera effects: Depth of Field + uniform Blur (see three/postfx.js)
// ---------------------------------------------------------------------------

// focusDistance/maxBlurPx are in world units / pixels; aperture (0..1) sets how
// quickly out-of-focus areas ramp up to the max blur.
export function setDofSettings(enabled, focusDistance, aperture, maxBlurPx) {
  setDepthOfField(enabled, focusDistance, aperture, maxBlurPx)
  requestRender()
}

// blurPx is a flat screen-space blur radius in pixels, independent of depth.
export function setBlurSettings(enabled, blurPx) {
  setBlurEffect(enabled, blurPx)
  requestRender()
}

// The blob and the real cast-shadow are mutually exclusive: blob when shadows are
// on but shadow-mapping is off; real shadows when both are on.
// Strength of the per-pixel darkening on real surfaces (see shadowDarkening.js).
// Only active while real shadow-map shadows are on.
function updateShadowDarkness() {
  const realOn = !(state.performanceMode && state.performanceEffects) && state.shadowOn && state.shadowMap
  setShadowDarkness(realOn ? state.shadowStrength : 0)
  requestRender()
}

function applyShadowMode() {
  const blobOn = state.shadowOn && !state.shadowMap
  const realOn = !(state.performanceMode && state.performanceEffects) && state.shadowOn && state.shadowMap
  if (state.renderer) state.renderer.shadowMap.enabled = realOn
  if (state.shadow) state.shadow.visible = blobOn
  syncShadowReceiverVisibility()
  updateShadowDarkness()
  if (state.dirLight) {
    state.dirLight.castShadow = realOn
    // Resolution follows performance mode. A changed size needs a fresh map.
    const size = state.performanceMode ? SHADOW_MAP_SIZE_PERFORMANCE : SHADOW_MAP_SIZE
    const shadow = state.dirLight.shadow
    if (shadow.mapSize.x !== size) {
      shadow.mapSize.set(size, size)
      if (shadow.map) {
        shadow.map.dispose()
        shadow.map = null
      }
      positionLight() // normal bias depends on texel size
    }
  }
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
    fps: state.fps > 0 ? Math.round(state.fps) : 0,
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

// Re-apply materials + outline to every loaded character from the shared scene
// settings. Each character keeps its own mesh overrides, but material style is
// global across the scene. This is the single entry point for any
// material/shading/outline-width change.
// uuids of the meshes of a scene object (character or model prop) that were
// loaded with transparency / alpha textures — empty when there's nothing for the
// "Transparency" switch to do, which is when the panel hides it.
export function getTransparentMeshUuidsForObject(object) {
  if (!object) return []
  const model = object.isCharacter ? state.characters.get(object.id) : getObjectMaterialModelById(object.id)
  return getTransparentMeshes(model).map((mesh) => mesh.uuid)
}

export function applyModelMaterials() {
  const s = useStore.getState()
  applyCharacterLightLinks(s)
  const soften = s.softenEnabled ? s.softenAmount : 0
  // Rim colour/direction normally come from the manual picker + key light —
  // but if "follow a scene light" is on and that light still exists, use its
  // actual colour + direction instead, so a placed rim/fill light drives the
  // shading directly.
  const rimLight = getCurrentRimLight(s)
  // Props/backgrounds follow the same style pipeline regardless of whether a
  // character is loaded yet — 'auto' ones track this change live, pinned
  // ones just pick up the shared toon/soften/rim/outline settings while
  // keeping their own mode.
  applyAllObjectStyles({
    mode: s.materialMode,
    toonSteps: s.toonSteps,
    soften,
    colorGrading: s.colorGrading,
    ambientOcclusionStrength: s.ambientOcclusionStrength,
    backlightColor: s.backlightColor,
    backlightFalloff: s.backlightFalloff,
    shadowStrength: s.shadowStrength,
    rimLight,
    outlineWidth: s.outlineWidth,
    outlineColor: s.outlineColor,
    outlineOpacity: s.outlineOpacity,
    overrides: s.meshOverrides, // per-part visibility (H key / eye icon) — same map the character uses
    transparencyDefault: false, // alpha textures are opaque unless switched on (Scene objects → Transparency)
  })
  const materialOptions = {
    mode: s.materialMode,
    toonSteps: s.toonSteps,
    soften,
    colorGrading: s.colorGrading,
    ambientOcclusionStrength: s.ambientOcclusionStrength,
    backlightColor: s.backlightColor,
    backlightFalloff: s.backlightFalloff,
    shadowStrength: s.shadowStrength,
    rimLight,
    transparencyDefault: false,
  }
  for (const [id, model] of state.characters) {
    const character = id === s.activeCharacterId ? s : s.characters[id]
    applyMaterials(model, { ...materialOptions, overrides: character?.meshOverrides || {} })
    applyOutlineParams(
      model,
      s.outlineWidth,
      soften,
      character?.meshOverrides || {},
      s.outlineColor,
      s.outlineOpacity,
    )
  }
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
  for (const model of state.characters.values()) {
    for (const mesh of model.meshes) {
      if (isClothEnabled(mesh.uuid)) mesh.visible = false
    }
  }
  requestRender()
}

function getCurrentRimLight(s) {
  let rimColor = s.rimLightColor
  let rimDir = state.lightDir
  if (s.rimFollowLight && s.rimFollowLightId != null) {
    const source = getLightRimSource(s.rimFollowLightId)
    if (source) {
      rimColor = source.color
      rimDir = source.direction
    }
  }
  return {
    color: rimColor,
    direction: rimDir,
    sideOnly: s.rimSideOnly,
    soft: { enabled: s.rimSoftEnabled, intensity: s.rimSoftIntensity, width: s.rimSoftWidth },
    hard: { enabled: s.rimHardEnabled, intensity: s.rimHardIntensity, width: s.rimHardWidth },
  }
}

function updateFollowedRimLight() {
  const s = useStore.getState()
  if (!s.rimFollowLight || s.rimFollowLightId == null) return
  const rimLight = getCurrentRimLight(s)
  if (state.currentModel) updateRimLightMaterials(state.currentModel, rimLight)
  updateAllObjectRimLight(rimLight)
}

// Toggle the outline pass on/off (width/visibility come from applyModelMaterials).
export function setOutlineToggle(enabled) {
  setOutlineEnabled(state.performanceMode && state.performanceEffects ? false : enabled)
  requestRender()
}

// Toggle the built-in key + ambient light off entirely, e.g. to light the
// scene only with placed lights (Lights panel) and/or the studio environment
// map. Uses .visible rather than zeroing intensity so it also stops
// contributing to the shadow-mapped key light's cast shadow.
export function setDefaultLightingEnabled(enabled) {
  state.defaultLightingOn = !!enabled
  if (state.dirLight) state.dirLight.visible = state.defaultLightingOn
  if (state.ambientLight) state.ambientLight.visible = state.defaultLightingOn
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
  // in sync whenever the key light moves. Updating its uniforms directly is
  // important here: rebuilding every character, prop, outline and cloth proxy
  // on every slider tick makes light adjustment needlessly expensive.
  updateLightDrivenMaterials()
  requestRender()
}

// Update only shader state that depends on the key-light direction. The actual
// Three.js light and shadow camera are updated by setLightSettings above; all
// other material state is unchanged during a light drag.
function updateLightDrivenMaterials() {
  const s = useStore.getState()
  const rimLight = getCurrentRimLight(s)
  for (const model of state.characters.values()) {
    updateRimLightMaterials(model, rimLight)
  }
  updateAllObjectRimLight(rimLight)
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
  if (state.dollyUndoTimer) clearTimeout(state.dollyUndoTimer)
  state.dollyUndoTimer = null
  state.dollyUndoBefore = null
  state.viewDragBefore = null
  setContinuousRender(false)
  disposeCurrentModel()
  disposeObjects()
  disposeCameras()
  disposeLights()
  disposeClothMod()
  disposePosing()
  disposeMeshEdit()
  disposeOutline()
  disposePostFX()

  if (state.resizeObserver) {
    state.resizeObserver.disconnect()
    state.resizeObserver = null
  }
  if (state.disposeWheel) {
    state.disposeWheel()
    state.disposeWheel = null
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

function prepareModelTextures(model) {
  if (!state.renderer) return
  const anisotropy = Math.min(4, state.renderer.capabilities.getMaxAnisotropy())
  const seen = new Set()
  for (const mesh of model.meshes) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      if (!material) continue
      for (const value of Object.values(material)) {
        if (value?.isTexture && !seen.has(value)) {
          value.anisotropy = anisotropy
          value.needsUpdate = true
          seen.add(value)
        }
      }
    }
  }
}

function applyCharacterLightLinks(s) {
  const ids = s.characterOrder || []
  for (const [index, id] of ids.entries()) {
    const model = state.characters.get(id)
    if (!model?.root) continue
    model.root.layers.enable(0)
    if (index + 1 < 32) model.root.layers.enable(index + 1)
  }
  if (state.camera) {
    state.camera.layers.enable(0)
    ids.forEach((_, index) => {
      if (index + 1 < 32) state.camera.layers.enable(index + 1)
    })
  }
  setLightLinks(s.lightLinks || {}, ids)
}

// Explicitly frame a prop or character without changing selection or its
// transform. Normal loading deliberately never calls this after the initial
// scene subject has established the viewport.
// Where an object's centre currently sits on screen, in CSS pixels relative to
// the viewport canvas (null if it can't be projected or is behind the camera).
// Lets React overlays — like the on-canvas resize dial — follow an object.
export function getObjectScreenPosition(id) {
  const object = getObjectRootById(id)
  if (!object || !state.camera || !state.renderer) return null
  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) return null
  const centre = box.getCenter(new THREE.Vector3()).project(state.camera)
  if (centre.z > 1) return null
  const el = state.renderer.domElement
  const w = el.clientWidth
  const h = el.clientHeight
  return { x: ((centre.x + 1) / 2) * w, y: ((1 - centre.y) / 2) * h, width: w, height: h }
}

export function setCameraToObject(id) {
  const object = getObjectRootById(id)
  if (!object) return
  commitFramingChange(() => frameCameraToObject(object))
}

export function setCameraToTarget(kind, id) {
  const target = kind === 'camera'
    ? getCameraRigById(id)
    : kind === 'light'
      ? getLightById(id)
      : getObjectRootById(id)
  if (!target) return
  commitFramingChange(() => frameCameraToObject(target))
}