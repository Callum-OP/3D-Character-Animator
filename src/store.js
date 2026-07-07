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
  setModelInfo: (modelInfo) => set({ modelInfo, loading: false, loadError: null }),
  clearModel: () => set({ modelInfo: null, loadError: null }),

  // ---- Viewport display toggles ----
  showGrid: true,
  solidBackground: false, // false = transparent (the default, for compositing)
  backgroundColor: '#202127',

  setShowGrid: (showGrid) => set({ showGrid }),
  setSolidBackground: (solidBackground) => set({ solidBackground }),
  setBackgroundColor: (backgroundColor) => set({ backgroundColor }),
}))
