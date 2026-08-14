import { create } from 'zustand'

// Linear-interpolate a character root-motion track's position at time `t`,
// as it stood BEFORE the edit being applied — used by addRootKeyframe's
// ripple mode to work out how far the character actually moved so it can
// carry that same delta onto every later keyframe. Returns null when there's
// nothing to interpolate against yet.
function sampleRootPosAt(keys, t) {
  if (!keys || !keys.length) return null
  const sorted = [...keys].sort((a, b) => a.time - b.time)
  if (t <= sorted[0].time) return sorted[0].pos
  const last = sorted[sorted.length - 1]
  if (t >= last.time) return last.pos
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (t >= a.time && t <= b.time) {
      const f = (b.time - a.time) > 0 ? (t - a.time) / (b.time - a.time) : 0
      return [0, 1, 2].map((i) => a.pos[i] + (b.pos[i] - a.pos[i]) * f)
    }
  }
  return last.pos
}

// Central app state. Only serializable / UI-facing data lives here.
// The heavy Three.js objects (scene, meshes, skeleton) are deliberately kept
// OUT of the store — they live in the scene manager (src/three/scene.js) and
// are referenced by mutable module state, not React state. Putting live GPU
// objects in a reactive store would cause needless re-renders and retain memory.
// ---------------------------------------------------------------------------
// Multi-character support
//
// Only these fields are per-character. Everything else in the store (view
// toggles, material mode, scene objects/cameras/lights, etc.) is shared
// across the whole scene. The ACTIVE character's fields are kept "flattened"
// at the top level of the store (unchanged shape from before), so existing
// panels/scene code that reads e.g. store.modelInfo or store.selectedBoneName
// keep working untouched — they transparently read/write the active
// character. Switching the active character snapshots the flat fields into
// `characters[id]` and loads the newly-active character's fields back out.
// ---------------------------------------------------------------------------
const CHARACTER_FIELDS = [
  'modelInfo',
  'meshOverrides',
  'selectedBoneName',
  'selectedMeshUuid',
  'boneFilter',
  'deformOnly',
  'playback',
  'playbackSource',
  'activeClipName',
  'importedClipNames',
  'duration',
  'currentTime',
  'animData',
  'insertTime',
  'poseClipboard',
]

function snapshotCharacterFields(s) {
  const snap = {}
  for (const k of CHARACTER_FIELDS) snap[k] = s[k]
  return snap
}

function defaultCharacterFields(modelInfo) {
  return {
    modelInfo,
    meshOverrides: {},
    selectedBoneName: null,
    selectedMeshUuid: null,
    boneFilter: '',
    deformOnly: !!(
      modelInfo &&
      modelInfo.bones &&
      modelInfo.bones.some((b) => b.deform) &&
      modelInfo.bones.some((b) => !b.deform)
    ),
    playback: 'stopped',
    playbackSource: modelInfo && modelInfo.clipNames && modelInfo.clipNames.length ? 'clip' : 'edit',
    activeClipName: null,
    importedClipNames: [],
    duration: 0,
    currentTime: 0,
    animData: { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {} },
    insertTime: 0,
    poseClipboard: null,
  }
}

export const useStore = create((set) => ({
  // ---- Multi-character registry ----
  // characters: { [id]: { ...CHARACTER_FIELDS } } — snapshot for every
  // character that ISN'T currently active. The active one's copy of these
  // fields lives at the top level (see CHARACTER_FIELDS above).
  characters: {},
  characterOrder: [], // display order of character ids
  activeCharacterId: null,

  // Register a newly-loaded model as a brand-new character. Does not touch
  // any existing character. Becomes the active character.
  addCharacter: (id, modelInfo) =>
    set((s) => {
      const characters = { ...s.characters }
      if (s.activeCharacterId) characters[s.activeCharacterId] = snapshotCharacterFields(s)
      const fields = defaultCharacterFields(modelInfo)
      return {
        loading: false,
        loadError: null,
        characters,
        characterOrder: [...s.characterOrder, id],
        activeCharacterId: id,
        ...fields,
        sceneObjects: [
          { id, name: modelInfo.name, isCharacter: true, characterId: id, visible: true },
          ...s.sceneObjects,
        ],
      }
    }),

  // Switch which character's pose/anim/mesh-edit state is "live" at the top
  // level. Scene code should follow this up by re-pointing the posing/
  // animation/mesh-edit engines at that character's Three.js objects.
  setActiveCharacterId: (id) =>
    set((s) => {
      if (id === s.activeCharacterId) return {}
      const characters = { ...s.characters }
      if (s.activeCharacterId) characters[s.activeCharacterId] = snapshotCharacterFields(s)
      const next = id != null ? characters[id] || defaultCharacterFields(null) : defaultCharacterFields(null)
      return {
        characters,
        activeCharacterId: id,
        ...next,
        selectedObjectId: null,
        selectedCameraId: null,
        selectedLightId: null,
      }
    }),

  // Remove a character entirely (call after disposing its Three.js objects).
  removeCharacter: (id) =>
    set((s) => {
      const characters = { ...s.characters }
      delete characters[id]
      const characterOrder = s.characterOrder.filter((cid) => cid !== id)
      const wasActive = s.activeCharacterId === id
      const nextActiveId = wasActive ? characterOrder[0] || null : s.activeCharacterId
      const nextFields = wasActive
        ? nextActiveId
          ? characters[nextActiveId] || defaultCharacterFields(null)
          : defaultCharacterFields(null)
        : {}
      return {
        characters,
        characterOrder,
        activeCharacterId: nextActiveId,
        sceneObjects: s.sceneObjects.filter((o) => o.id !== id),
        selectedObjectId: s.selectedObjectId === id ? null : s.selectedObjectId,
        ...nextFields,
      }
    }),


  // ---- Interaction mode ----
  // 'view'  — navigate only: no gizmos, no picking.
  // 'bone'  — pose the skeleton (bone dots + rotate gizmo).
  // 'mesh'  — move/rotate/scale individual parts (eyes, hair…) of the character.
  // Selections are remembered across mode switches; only the active mode's
  // gizmo and picking are live.
  mode: 'bone',
  setMode: (mode) => set({ mode }),

  // ---- Loaded model info (metadata only, mirrors what's in the scene) ----
  modelInfo: null, // { name, meshCount, boneCount, clipNames: string[] }
  loading: false,
  loadError: null,

  setLoading: (loading) => set({ loading, loadError: null }),
  setLoadError: (loadError) => set({ loadError, loading: false }),
  // Replaces the ACTIVE character's data in place (legacy single-character
  // load path, still used when re-loading over the currently active
  // character rather than adding a new one alongside it).
  setModelInfo: (modelInfo) =>
    set((s) => {
      const id = s.activeCharacterId || 'character'
      const fields = defaultCharacterFields(modelInfo)
      return {
        loading: false,
        loadError: null,
        ...fields,
        characters: { ...s.characters, [id]: fields },
        characterOrder: s.characterOrder.includes(id) ? s.characterOrder : [...s.characterOrder, id],
        activeCharacterId: id,
        // The character is a movable entry (kept first) in the objects list.
        sceneObjects: [
          { id, name: modelInfo.name, isCharacter: true, characterId: id, visible: true },
          ...s.sceneObjects.filter((o) => o.id !== id),
        ],
      }
    }),
  clearModel: () =>
    set((s) => {
      const id = s.activeCharacterId || 'character'
      const characters = { ...s.characters }
      delete characters[id]
      const characterOrder = s.characterOrder.filter((cid) => cid !== id)
      const nextActiveId = characterOrder[0] || null
      const nextFields = nextActiveId ? characters[nextActiveId] || defaultCharacterFields(null) : defaultCharacterFields(null)
      return {
        loadError: null,
        ...nextFields,
        characters,
        characterOrder,
        activeCharacterId: nextActiveId,
        sceneObjects: s.sceneObjects.filter((o) => o.id !== id),
        selectedObjectId: s.selectedObjectId === id ? null : s.selectedObjectId,
      }
    }),

  // ---- Viewport display toggles ----
  showGrid: true,
  showGround: false, // solid ground plane
  solidBackground: false, // false = transparent (the default, for compositing)
  backgroundColor: '#202127',
  showShadow: true, // ground shadow on/off
  shadowMapping: false, // true = real cast shadows; false = cheap blob
  showStats: false, // FPS / memory readout overlay
  showHelp: false, // help & shortcuts overlay

  setShowGrid: (showGrid) => set({ showGrid }),
  setShowGround: (showGround) => set({ showGround }),
  setSolidBackground: (solidBackground) => set({ solidBackground }),
  setBackgroundColor: (backgroundColor) => set({ backgroundColor }),
  setShowShadow: (showShadow) => set({ showShadow }),
  setShadowMapping: (shadowMapping) => set({ shadowMapping }),
  setShowStats: (showStats) => set({ showStats }),
  setShowHelp: (showHelp) => set({ showHelp }),
  toggleHelp: () => set((s) => ({ showHelp: !s.showHelp })),

  // ---- Export ----
  exportScale: 2, // PNG resolution multiplier (1× / 2× / 4×)
  recording: false, // true while capturing a video

  setExportScale: (exportScale) => set({ exportScale }),
  setRecording: (recording) => set({ recording }),

  // ---- Material mode ----
  // 'unlit' is the default: raw base colour, no lighting — matches Blender's
  // flat colours exactly and side-steps FBX lighting artifacts.
  materialMode: 'unlit', // 'unlit' | 'toon' | 'standard'
  toonSteps: 3, // number of shadow bands in toon mode

  setMaterialMode: (materialMode) => set({ materialMode }),
  setToonSteps: (toonSteps) => set({ toonSteps }),

  // ---- Key light (affects Toon/Standard modes only; ignored by Unlit) ----
  lightIntensity: 2.0,
  lightAzimuth: 35, // degrees around the model (0 = front, +ve = to the right)
  lightElevation: 45, // degrees above the horizon

  setLightIntensity: (lightIntensity) => set({ lightIntensity }),
  setLightAzimuth: (lightAzimuth) => set({ lightAzimuth }),
  setLightElevation: (lightElevation) => set({ lightElevation }),

  // ---- Environment (studio HDRI-style) fill lighting — Standard mode only,
  // like Blender's Material Preview viewport shading. Off by default so it
  // never changes an existing project's look until turned on. ----
  envLightingEnabled: false,
  envLightingIntensity: 1.0,

  setEnvLightingEnabled: (envLightingEnabled) => set({ envLightingEnabled }),
  setEnvLightingIntensity: (envLightingIntensity) => set({ envLightingIntensity }),

  // ---- Outline (inverted-hull, works in every material mode) ----
  outlineEnabled: false,
  outlineWidth: 0.003, // screen-space thickness; starts very thin

  setOutlineEnabled: (outlineEnabled) => set({ outlineEnabled }),
  setOutlineWidth: (outlineWidth) => set({ outlineWidth }),

  // ---- Shading softening ----
  // Global: lifts toon shadows (flatter) and thins the outline everywhere.
  softenEnabled: false,
  softenAmount: 0.4, // 0..1

  setSoftenEnabled: (softenEnabled) => set({ softenEnabled }),
  setSoftenAmount: (softenAmount) => set({ softenAmount }),

  // Per-mesh overrides, keyed by mesh uuid: { outline: bool, shading: mode }.
  // Absent entry => defaults (outline on, 'full' shading). Cleared on load.
  // Used to e.g. drop the outline and flatten shading on a face mesh.
  meshOverrides: {},

  setMeshOutline: (uuid, outline) =>
    set((s) => ({
      meshOverrides: {
        ...s.meshOverrides,
        [uuid]: { shading: 'full', ...s.meshOverrides[uuid], outline },
      },
    })),
  setMeshShading: (uuid, shading) =>
    set((s) => ({
      meshOverrides: {
        ...s.meshOverrides,
        [uuid]: { outline: true, ...s.meshOverrides[uuid], shading },
      },
    })),
  setMeshVisible: (uuid, visible) =>
    set((s) => ({
      meshOverrides: {
        ...s.meshOverrides,
        [uuid]: { outline: true, shading: 'full', ...s.meshOverrides[uuid], visible },
      },
    })),

  // ---- Bone posing ----
  selectedBoneName: null, // name of the bone the gizmo is attached to
  boneFilter: '', // text filter for the bone tree
  deformOnly: false, // hide helper bones (_end/twist/vol/DEF- rule; set per rig on load)
  transformSpace: 'local', // gizmo rotation space: 'local' | 'world'
  showBones: true, // show the pickable bone-dot overlay + gizmo
  rotationSnap: false, // rotate in 15° steps (hold Shift for the opposite)
  limbLimits: true, // keep new poses (and the ragdoll) inside natural joint ranges
  poseClipboard: null, // a copied pose ({ format:'pose-v1', bones:{...} }) for paste
  // Bumped by the posing engine on every pose edit (gizmo drag, undo, reset…)
  // so the rotation sliders can re-read the selected bone's angles.
  poseVersion: 0,

  setPoseClipboard: (poseClipboard) => set({ poseClipboard }),
  setRotationSnap: (rotationSnap) => set({ rotationSnap }),
  setLimbLimits: (limbLimits) => set({ limbLimits }),
  bumpPoseVersion: () => set((s) => ({ poseVersion: s.poseVersion + 1 })),

  setSelectedBoneName: (selectedBoneName) =>
    // Selecting a bone deselects any scene object/camera/light (one gizmo at a time).
    set(
      selectedBoneName != null
        ? { selectedBoneName, selectedObjectId: null, selectedCameraId: null, selectedLightId: null }
        : { selectedBoneName },
    ),

  // ---- Mesh editing (Mesh mode) ----
  selectedMeshUuid: null, // uuid of the part the mesh gizmo is attached to
  meshGizmoMode: 'translate', // 'translate' | 'rotate' | 'scale'
  // When on, dragging a shape key also drives same-named shape keys on other
  // meshes of this character that sit close by (e.g. teeth/eyes/eyebrows
  // exported as separate meshes from the face). Off = only the selected mesh.
  linkedShapeKeys: true,
  // Bumped by the mesh-edit engine on every edit (gizmo drag, undo, reset…)
  // so the transform fields can re-read the selected part's values.
  meshVersion: 0,

  setSelectedMeshUuid: (selectedMeshUuid) => set({ selectedMeshUuid }),
  setMeshGizmoMode: (meshGizmoMode) => set({ meshGizmoMode }),
  setLinkedShapeKeys: (linkedShapeKeys) => set({ linkedShapeKeys }),
  bumpMeshVersion: () => set((s) => ({ meshVersion: s.meshVersion + 1 })),

  setBoneFilter: (boneFilter) => set({ boneFilter }),
  setDeformOnly: (deformOnly) => set({ deformOnly }),
  setTransformSpace: (transformSpace) => set({ transformSpace }),
  setShowBones: (showBones) => set({ showBones }),

  // ---- Scene objects (props / backgrounds) ----
  sceneObjects: [], // [{ id, name, format }] — independent of the character
  selectedObjectId: null,
  objectMode: 'translate', // gizmo mode: 'translate' | 'rotate' | 'scale'

  addSceneObject: (obj) =>
    set((s) => ({
      sceneObjects: [...s.sceneObjects, { visible: true, ...obj }],
      selectedObjectId: obj.id,
      selectedBoneName: null, // mutually exclusive with bone/camera/light selection
      selectedCameraId: null,
      selectedLightId: null,
    })),
  setObjectVisible: (id, visible) =>
    set((s) => ({
      sceneObjects: s.sceneObjects.map((o) => (o.id === id ? { ...o, visible } : o)),
    })),
  setObjectLit: (id, lit) =>
    set((s) => ({
      sceneObjects: s.sceneObjects.map((o) => (o.id === id ? { ...o, lit } : o)),
    })),
  setObjectCastShadow: (id, castShadow) =>
    set((s) => ({
      sceneObjects: s.sceneObjects.map((o) => (o.id === id ? { ...o, castShadow } : o)),
    })),
  removeSceneObject: (id) =>
    set((s) => ({
      sceneObjects: s.sceneObjects.filter((o) => o.id !== id),
      selectedObjectId: s.selectedObjectId === id ? null : s.selectedObjectId,
    })),
  setSelectedObjectId: (id) =>
    set(
      id != null
        ? { selectedObjectId: id, selectedBoneName: null, selectedCameraId: null, selectedLightId: null }
        : { selectedObjectId: id },
    ),
  setObjectMode: (objectMode) => set({ objectMode }),

  // ---- Scene cameras ----
  sceneCameras: [], // [{ id, name, fov }] — placeable cameras, independent of the model
  selectedCameraId: null, // camera the gizmo is attached to
  cameraGizmoMode: 'translate', // 'translate' | 'rotate'
  viewCameraId: null, // camera the viewport looks through (null = free view)

  addSceneCamera: (cam) =>
    set((s) => ({
      sceneCameras: [...s.sceneCameras, cam],
      selectedCameraId: cam.id,
      selectedObjectId: null, // one gizmo at a time
      selectedBoneName: null,
      selectedLightId: null,
    })),
  removeSceneCamera: (id) =>
    set((s) => ({
      sceneCameras: s.sceneCameras.filter((cam) => cam.id !== id),
      selectedCameraId: s.selectedCameraId === id ? null : s.selectedCameraId,
      viewCameraId: s.viewCameraId === id ? null : s.viewCameraId,
    })),
  setSceneCameras: (sceneCameras) => set({ sceneCameras }),
  setSelectedCameraId: (id) =>
    set(
      id != null
        ? { selectedCameraId: id, selectedObjectId: null, selectedBoneName: null, selectedLightId: null }
        : { selectedCameraId: id },
    ),
  setCameraGizmoMode: (cameraGizmoMode) => set({ cameraGizmoMode }),
  setCameraFov: (id, fov) =>
    set((s) => ({
      sceneCameras: s.sceneCameras.map((cam) => (cam.id === id ? { ...cam, fov } : cam)),
    })),
  setViewCameraId: (viewCameraId) => set({ viewCameraId }),

  // ---- Scene lights ----
  sceneLights: [], // [{ id, name, color, intensity, castShadow }] — placeable lights
  selectedLightId: null, // light the gizmo is attached to

  addSceneLight: (light) =>
    set((s) => ({
      sceneLights: [...s.sceneLights, light],
      selectedLightId: light.id,
      selectedObjectId: null, // one gizmo at a time
      selectedCameraId: null,
      selectedBoneName: null,
    })),
  removeSceneLight: (id) =>
    set((s) => ({
      sceneLights: s.sceneLights.filter((lt) => lt.id !== id),
      selectedLightId: s.selectedLightId === id ? null : s.selectedLightId,
    })),
  setSceneLights: (sceneLights) => set({ sceneLights }),
  setSelectedLightId: (id) =>
    set(
      id != null
        ? { selectedLightId: id, selectedObjectId: null, selectedCameraId: null, selectedBoneName: null }
        : { selectedLightId: id },
    ),
  setLightColor: (id, color) =>
    set((s) => ({
      sceneLights: s.sceneLights.map((lt) => (lt.id === id ? { ...lt, color } : lt)),
    })),
  // Renamed from setLightIntensity: that name collided with the key-light
  // intensity setter above (single arg, global) and was silently shadowing
  // it, so the key-light slider in MaterialPanel was calling this per-prop
  // setter instead — wrong signature, no effect.
  setPropLightIntensity: (id, intensity) =>
    set((s) => ({
      sceneLights: s.sceneLights.map((lt) => (lt.id === id ? { ...lt, intensity } : lt)),
    })),
  setLightCastShadow: (id, castShadow) =>
    set((s) => ({
      sceneLights: s.sceneLights.map((lt) => (lt.id === id ? { ...lt, castShadow } : lt)),
    })),

  // ---- Animation ----
  playback: 'stopped', // 'stopped' | 'playing' | 'paused'
  // Camera cuts/keys move the VIEW itself, which is disorienting while you're
  // mid-edit on a normal Play. Off by default — Export's Preview/Record
  // buttons apply them regardless of this toggle, since that's the point of
  // a recorded shot.
  followCameraCuts: false,
  setFollowCameraCuts: (followCameraCuts) => set({ followCameraCuts }),
  playbackSource: 'edit', // 'clip' (baked) | 'edit' (in-app keyframes)
  activeClipName: null, // selected clip (baked or imported)
  importedClipNames: [], // names of retargeted BVH mocap clips
  loop: true,
  speed: 1,
  // When true, editing a root (character world-placement) keyframe shifts
  // every LATER keyframe by the same delta — so nudging where a walk clip
  // is at frame 20 carries every step after it along, instead of leaving
  // them planted where they were.
  rippleRootEdit: false,
  // When true, dragging the character with the move gizmo while building a
  // "Make your own" clip automatically records a root keyframe at the
  // playhead — no need to remember to press "Keyframe position" afterwards.
  autoKeyMovement: false,
  duration: 0, // current source duration (seconds)
  currentTime: 0, // playhead (updated during playback)

  setPlayback: (playback) => set({ playback }),
  setPlaybackSource: (playbackSource) => set({ playbackSource }),
  setActiveClipName: (activeClipName) => set({ activeClipName }),
  addImportedClipName: (name) =>
    set((s) => ({ importedClipNames: [...s.importedClipNames, name] })),
  renameImportedClipName: (oldName, newName) =>
    set((s) => ({
      importedClipNames: s.importedClipNames.map((n) => (n === oldName ? newName : n)),
    })),
  setLoop: (loop) => set({ loop }),
  setSpeed: (speed) => set({ speed }),
  setRippleRootEdit: (rippleRootEdit) => set({ rippleRootEdit }),
  setAutoKeyMovement: (autoKeyMovement) => set({ autoKeyMovement }),
  setDuration: (duration) => set({ duration }),
  setCurrentTime: (currentTime) => set({ currentTime }),

  // In-app keyframe animation. tracks: { [boneName]: [{ time, quat:[x,y,z,w] }] }
  animFps: 24,
  animDuration: 2,
  insertTime: 0, // where "Add keyframe" inserts (seconds)
  // tracks = bone rotations; root = character world motion [{ time, pos:[3], quat:[4] }];
  // meshes = part motion keyed by mesh INDEX [{ time, pos:[3], quat:[4], scale:[3] }];
  // cameras = camera motion keyed by camera NAME [{ time, pos:[3], quat:[4] }];
  // cuts = camera switches [{ time, camera: name }] — the view hard-cuts to that
  // camera from that time on during playback (one cut per time)
  animData: { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [] },

  setAnimFps: (animFps) => set({ animFps }),
  setAnimDuration: (animDuration) => set({ animDuration }),
  setInsertTime: (insertTime) => set({ insertTime }),
  setAnimData: (animData) =>
    set({
      animData: {
        tracks: animData.tracks || {},
        root: animData.root || [],
        meshes: animData.meshes || {},
        cameras: animData.cameras || {},
        cuts: animData.cuts || [],
        morphs: animData.morphs || {},
      },
    }),
  clearAnim: () =>
    set({ animData: { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {} } }),

  // Insert/replace a camera cut: from this time on, the view is this camera.
  addCameraCut: (time, camera) =>
    set((s) => {
      const cuts = (s.animData.cuts || []).filter((k) => k.time !== time)
      cuts.push({ time, camera })
      cuts.sort((a, b) => a.time - b.time)
      return { animData: { ...s.animData, cuts } }
    }),
  deleteCameraCut: (time) =>
    set((s) => ({
      animData: {
        ...s.animData,
        cuts: (s.animData.cuts || []).filter((k) => Math.abs(k.time - time) > 1e-6),
      },
    })),

  // Insert/replace a part keyframe (full local position + rotation + scale).
  addMeshKeyframe: (index, time, key) =>
    set((s) => {
      const meshes = { ...(s.animData.meshes || {}) }
      const keys = (meshes[index] || []).filter((k) => k.time !== time)
      keys.push({ time, ...key })
      keys.sort((a, b) => a.time - b.time)
      meshes[index] = keys
      return { animData: { ...s.animData, meshes } }
    }),

  // Insert/replace a camera keyframe (world position + rotation), by camera name.
  addCameraKeyframe: (name, time, key) =>
    set((s) => {
      const cameras = { ...(s.animData.cameras || {}) }
      const keys = (cameras[name] || []).filter((k) => k.time !== time)
      keys.push({ time, ...key })
      keys.sort((a, b) => a.time - b.time)
      cameras[name] = keys
      return { animData: { ...s.animData, cameras } }
    }),

  // Insert/replace a character root-motion keyframe (world position + rotation).
  // When `rippleAfter` is true (the "ripple edit" toggle), every existing
  // keyframe strictly after `time` is shifted by the same position delta as
  // this edit — e.g. dragging the character further along mid-clip carries
  // every later step forward with it instead of leaving them behind, so the
  // rest of the walk still lines up with the new position.
  addRootKeyframe: (time, pos, quat, rippleAfter = false) =>
    set((s) => {
      const existing = s.animData.root || []
      let root = existing.filter((k) => k.time !== time)
      if (rippleAfter) {
        const before = sampleRootPosAt(existing, time)
        if (before) {
          const dx = pos[0] - before[0]
          const dy = pos[1] - before[1]
          const dz = pos[2] - before[2]
          if (dx || dy || dz) {
            root = root.map((k) =>
              k.time > time
                ? { ...k, pos: [k.pos[0] + dx, k.pos[1] + dy, k.pos[2] + dz] }
                : k,
            )
          }
        }
      }
      root.push({ time, pos, quat })
      root.sort((a, b) => a.time - b.time)
      return { animData: { ...s.animData, root } }
    }),
  deleteRootKeyframe: (time) =>
    set((s) => ({
      animData: { ...s.animData, root: (s.animData.root || []).filter((k) => k.time !== time) },
    })),

  // Remove every keyframe (joints, position, parts, cameras) at a given time.
  deleteAllAtTime: (time) =>
    set((s) => {
      const near = (k) => Math.abs(k.time - time) <= 1e-6
      const tracks = {}
      for (const [name, keys] of Object.entries(s.animData.tracks)) {
        const kept = keys.filter((k) => !near(k))
        if (kept.length) tracks[name] = kept
      }
      const root = (s.animData.root || []).filter((k) => !near(k))
      const meshes = {}
      for (const [idx, keys] of Object.entries(s.animData.meshes || {})) {
        const kept = keys.filter((k) => !near(k))
        if (kept.length) meshes[idx] = kept
      }
      const cameras = {}
      for (const [name, keys] of Object.entries(s.animData.cameras || {})) {
        const kept = keys.filter((k) => !near(k))
        if (kept.length) cameras[name] = kept
      }
      const cuts = (s.animData.cuts || []).filter((k) => !near(k))
      const morphs = {}
      for (const [meshIndex, byName] of Object.entries(s.animData.morphs || {})) {
        const kept = {}
        for (const [morphName, keys] of Object.entries(byName || {})) {
          const next = (keys || []).filter((k) => !near(k))
          if (next.length) kept[morphName] = next
        }
        if (Object.keys(kept).length) morphs[meshIndex] = kept
      }
      return { animData: { tracks, root, meshes, cameras, cuts, morphs } }
    }),

  // Insert/replace a keyframe for one bone at a time.
  addKeyframe: (name, time, quat) =>
    set((s) => {
      const keys = (s.animData.tracks[name] || []).filter((k) => k.time !== time)
      keys.push({ time, quat })
      keys.sort((a, b) => a.time - b.time)
      return { animData: { ...s.animData, tracks: { ...s.animData.tracks, [name]: keys } } }
    }),

  // Key several bones at the same time (for "key all posed bones").
  addKeyframesAtTime: (list, time) =>
    set((s) => {
      const tracks = { ...s.animData.tracks }
      for (const { name, quat } of list) {
        const keys = (tracks[name] || []).filter((k) => k.time !== time)
        keys.push({ time, quat })
        keys.sort((a, b) => a.time - b.time)
        tracks[name] = keys
      }
      return { animData: { ...s.animData, tracks } }
    }),

  deleteKeyframe: (name, time) =>
    set((s) => {
      const tracks = { ...s.animData.tracks }
      const keys = (tracks[name] || []).filter((k) => k.time !== time)
      if (keys.length) tracks[name] = keys
      else delete tracks[name]
      return { animData: { ...s.animData, tracks } }
    }),

  // Morphs: { [meshIndex]: { [morphName]: [{ time, value }] } }
  // Keyed by the mesh's stable index (not mesh.uuid — uuids are regenerated
  // every time the model file is reloaded, which would silently orphan
  // saved shape-key tracks after a save/reload round trip).
  addMorphKeyframe: (meshIndex, morphName, time, value) =>
    set((s) => {
      const existingMorphs = { ...(s.animData.morphs || {}) }
      const meshMorphs = { ...(existingMorphs[meshIndex] || {}) }
      const keys = (meshMorphs[morphName] || []).filter((k) => k.time !== time)
      keys.push({ time, value })
      keys.sort((a, b) => a.time - b.time)
      meshMorphs[morphName] = keys
      existingMorphs[meshIndex] = meshMorphs
      return { animData: { ...s.animData, morphs: existingMorphs } }
    }),

  // Insert N blank frames at `atTime`: every keyframe (joints, root, parts,
  // cameras, cuts, morphs) at or after that time is pushed later by
  // frames/fps seconds, leaving a hold/gap in the timeline. animDuration is
  // extended if the shift pushes past the current end. Operates on the
  // active character's animData only (each character has its own timeline).
  insertBlankFrames: (atTime, frames) =>
    set((s) => {
      const delta = frames / (s.animFps || 24)
      if (!(delta > 0)) return {}
      const cutoff = atTime - 1e-6
      const shift = (k) => (k.time > cutoff ? { ...k, time: k.time + delta } : k)

      const tracks = {}
      for (const [name, keys] of Object.entries(s.animData.tracks || {})) {
        tracks[name] = keys.map(shift)
      }
      const root = (s.animData.root || []).map(shift)
      const meshes = {}
      for (const [idx, keys] of Object.entries(s.animData.meshes || {})) {
        meshes[idx] = keys.map(shift)
      }
      const cameras = {}
      for (const [name, keys] of Object.entries(s.animData.cameras || {})) {
        cameras[name] = keys.map(shift)
      }
      const cuts = (s.animData.cuts || []).map(shift)
      const morphs = {}
      for (const [meshIndex, byName] of Object.entries(s.animData.morphs || {})) {
        const next = {}
        for (const [morphName, keys] of Object.entries(byName || {})) {
          next[morphName] = keys.map(shift)
        }
        morphs[meshIndex] = next
      }

      let maxTime = s.animDuration
      for (const keys of Object.values(tracks)) for (const k of keys) maxTime = Math.max(maxTime, k.time)
      for (const k of root) maxTime = Math.max(maxTime, k.time)
      for (const keys of Object.values(meshes)) for (const k of keys) maxTime = Math.max(maxTime, k.time)
      for (const keys of Object.values(cameras)) for (const k of keys) maxTime = Math.max(maxTime, k.time)
      for (const k of cuts) maxTime = Math.max(maxTime, k.time)

      return {
        animData: { tracks, root, meshes, cameras, cuts, morphs },
        animDuration: Math.max(s.animDuration, maxTime),
      }
    }),

  deleteMorphKeyframe: (meshIndex, morphName, time) =>
    set((s) => {
      const existingMorphs = { ...(s.animData.morphs || {}) }
      const meshMorphs = { ...(existingMorphs[meshIndex] || {}) }
      const keys = (meshMorphs[morphName] || []).filter((k) => k.time !== time)
      if (keys.length) meshMorphs[morphName] = keys
      else delete meshMorphs[morphName]
      if (Object.keys(meshMorphs).length) existingMorphs[meshIndex] = meshMorphs
      else delete existingMorphs[meshIndex]
      return { animData: { ...s.animData, morphs: existingMorphs } }
    }),
}))