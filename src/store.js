import { create } from 'zustand'

// Central app state. Only serializable / UI-facing data lives here.
// The heavy Three.js objects (scene, meshes, skeleton) are deliberately kept
// OUT of the store — they live in the scene manager (src/three/scene.js) and
// are referenced by mutable module state, not React state. Putting live GPU
// objects in a reactive store would cause needless re-renders and retain memory.
export const useStore = create((set) => ({
  // ---- Loaded model info (metadata only, mirrors what's in the scene) ----
  modelInfo: null, // { name, meshCount, boneCount, clipNames: string[] }
  loading: false,
  loadError: null,

  setLoading: (loading) => set({ loading, loadError: null }),
  setLoadError: (loadError) => set({ loadError, loading: false }),
  setModelInfo: (modelInfo) =>
    set((s) => ({
      modelInfo,
      loading: false,
      loadError: null,
      meshOverrides: {},
      selectedBoneName: null,
      boneFilter: '',
      // Default the helper-bone filter ON when the rig has both primary and
      // helper bones (Rigify DEF- rigs, Mixamo _end tails, game-rig correctives).
      deformOnly: !!(
        modelInfo.bones &&
        modelInfo.bones.some((b) => b.deform) &&
        modelInfo.bones.some((b) => !b.deform)
      ),
      // Reset animation state for the new rig.
      playback: 'stopped',
      playbackSource: modelInfo.clipNames && modelInfo.clipNames.length ? 'clip' : 'edit',
      activeClipName: null,
      importedClipNames: [],
      duration: 0,
      currentTime: 0,
      animData: { tracks: {}, root: [] },
      insertTime: 0,
      // The character is a movable entry (kept first) in the objects list.
      sceneObjects: [
        { id: 'character', name: modelInfo.name, isCharacter: true, visible: true },
        ...s.sceneObjects.filter((o) => o.id !== 'character'),
      ],
    })),
  clearModel: () =>
    set((s) => ({
      modelInfo: null,
      loadError: null,
      meshOverrides: {},
      selectedBoneName: null,
      boneFilter: '',
      playback: 'stopped',
      activeClipName: null,
      importedClipNames: [],
      currentTime: 0,
      animData: { tracks: {}, root: [] },
      sceneObjects: s.sceneObjects.filter((o) => o.id !== 'character'),
      selectedObjectId: s.selectedObjectId === 'character' ? null : s.selectedObjectId,
    })),

  // ---- Viewport display toggles ----
  showGrid: true,
  solidBackground: false, // false = transparent (the default, for compositing)
  backgroundColor: '#202127',
  showShadow: true, // ground shadow on/off
  shadowMapping: false, // true = real cast shadows; false = cheap blob
  showStats: false, // FPS / memory readout overlay
  showHelp: false, // help & shortcuts overlay

  setShowGrid: (showGrid) => set({ showGrid }),
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
  poseClipboard: null, // a copied pose ({ format:'pose-v1', bones:{...} }) for paste
  // Bumped by the posing engine on every pose edit (gizmo drag, undo, reset…)
  // so the rotation sliders can re-read the selected bone's angles.
  poseVersion: 0,

  setPoseClipboard: (poseClipboard) => set({ poseClipboard }),
  setRotationSnap: (rotationSnap) => set({ rotationSnap }),
  bumpPoseVersion: () => set((s) => ({ poseVersion: s.poseVersion + 1 })),

  setSelectedBoneName: (selectedBoneName) =>
    // Selecting a bone deselects any scene object (one gizmo at a time).
    set(selectedBoneName != null ? { selectedBoneName, selectedObjectId: null } : { selectedBoneName }),
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
      selectedBoneName: null, // mutually exclusive with bone selection
    })),
  setObjectVisible: (id, visible) =>
    set((s) => ({
      sceneObjects: s.sceneObjects.map((o) => (o.id === id ? { ...o, visible } : o)),
    })),
  removeSceneObject: (id) =>
    set((s) => ({
      sceneObjects: s.sceneObjects.filter((o) => o.id !== id),
      selectedObjectId: s.selectedObjectId === id ? null : s.selectedObjectId,
    })),
  setSelectedObjectId: (id) =>
    set(id != null ? { selectedObjectId: id, selectedBoneName: null } : { selectedObjectId: id }),
  setObjectMode: (objectMode) => set({ objectMode }),

  // ---- Animation ----
  playback: 'stopped', // 'stopped' | 'playing' | 'paused'
  playbackSource: 'edit', // 'clip' (baked) | 'edit' (in-app keyframes)
  activeClipName: null, // selected clip (baked or imported)
  importedClipNames: [], // names of retargeted BVH mocap clips
  loop: true,
  speed: 1,
  duration: 0, // current source duration (seconds)
  currentTime: 0, // playhead (updated during playback)

  setPlayback: (playback) => set({ playback }),
  setPlaybackSource: (playbackSource) => set({ playbackSource }),
  setActiveClipName: (activeClipName) => set({ activeClipName }),
  addImportedClipName: (name) =>
    set((s) => ({ importedClipNames: [...s.importedClipNames, name] })),
  setLoop: (loop) => set({ loop }),
  setSpeed: (speed) => set({ speed }),
  setDuration: (duration) => set({ duration }),
  setCurrentTime: (currentTime) => set({ currentTime }),

  // In-app keyframe animation. tracks: { [boneName]: [{ time, quat:[x,y,z,w] }] }
  animFps: 24,
  animDuration: 2,
  insertTime: 0, // where "Add keyframe" inserts (seconds)
  // tracks = bone rotations; root = character world motion [{ time, pos:[3], quat:[4] }]
  animData: { tracks: {}, root: [] },

  setAnimFps: (animFps) => set({ animFps }),
  setAnimDuration: (animDuration) => set({ animDuration }),
  setInsertTime: (insertTime) => set({ insertTime }),
  setAnimData: (animData) =>
    set({ animData: { tracks: animData.tracks || {}, root: animData.root || [] } }),
  clearAnim: () => set({ animData: { tracks: {}, root: [] } }),

  // Insert/replace a character root-motion keyframe (world position + rotation).
  addRootKeyframe: (time, pos, quat) =>
    set((s) => {
      const root = (s.animData.root || []).filter((k) => k.time !== time)
      root.push({ time, pos, quat })
      root.sort((a, b) => a.time - b.time)
      return { animData: { ...s.animData, root } }
    }),
  deleteRootKeyframe: (time) =>
    set((s) => ({
      animData: { ...s.animData, root: (s.animData.root || []).filter((k) => k.time !== time) },
    })),

  // Remove every keyframe (all joints + the position) at a given time.
  deleteAllAtTime: (time) =>
    set((s) => {
      const tracks = {}
      for (const [name, keys] of Object.entries(s.animData.tracks)) {
        const kept = keys.filter((k) => Math.abs(k.time - time) > 1e-6)
        if (kept.length) tracks[name] = kept
      }
      const root = (s.animData.root || []).filter((k) => Math.abs(k.time - time) > 1e-6)
      return { animData: { tracks, root } }
    }),

  // Insert/replace a keyframe for one bone at a time.
  addKeyframe: (name, time, quat) =>
    set((s) => {
      const keys = (s.animData.tracks[name] || []).filter((k) => k.time !== time)
      keys.push({ time, quat })
      keys.sort((a, b) => a.time - b.time)
      return { animData: { tracks: { ...s.animData.tracks, [name]: keys } } }
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
      return { animData: { tracks } }
    }),

  deleteKeyframe: (name, time) =>
    set((s) => {
      const tracks = { ...s.animData.tracks }
      const keys = (tracks[name] || []).filter((k) => k.time !== time)
      if (keys.length) tracks[name] = keys
      else delete tracks[name]
      return { animData: { tracks } }
    }),
}))
