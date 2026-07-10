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
    set({
      modelInfo,
      loading: false,
      loadError: null,
      meshOverrides: {},
      selectedBoneName: null,
      boneFilter: '',
      // Default the deform-only filter ON for rigs that have DEF- bones (Rigify).
      deformOnly: !!(modelInfo.bones && modelInfo.bones.some((b) => b.deform)),
    }),
  clearModel: () =>
    set({
      modelInfo: null,
      loadError: null,
      meshOverrides: {},
      selectedBoneName: null,
      boneFilter: '',
    }),

  // ---- Viewport display toggles ----
  showGrid: true,
  solidBackground: false, // false = transparent (the default, for compositing)
  backgroundColor: '#202127',

  setShowGrid: (showGrid) => set({ showGrid }),
  setSolidBackground: (solidBackground) => set({ solidBackground }),
  setBackgroundColor: (backgroundColor) => set({ backgroundColor }),

  // ---- Material mode (Phase 2) ----
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

  // ---- Bone posing (Phase 3) ----
  selectedBoneName: null, // name of the bone the gizmo is attached to
  boneFilter: '', // text filter for the bone tree
  deformOnly: false, // hide non-DEF- bones (defaulted per rig on load)
  transformSpace: 'local', // gizmo rotation space: 'local' | 'world'
  showBones: true, // show the pickable bone-dot overlay + gizmo

  setSelectedBoneName: (selectedBoneName) => set({ selectedBoneName }),
  setBoneFilter: (boneFilter) => set({ boneFilter }),
  setDeformOnly: (deformOnly) => set({ deformOnly }),
  setTransformSpace: (transformSpace) => set({ transformSpace }),
  setShowBones: (showBones) => set({ showBones }),
}))
