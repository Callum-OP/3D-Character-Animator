import { useEffect, useRef, useState } from 'react'
import {
  initScene,
  disposeScene,
  loadModelFile,
  setGridVisible,
  setBackground,
  setShadowVisible,
  setShadowMapping,
  applyModelMaterials,
  setLightSettings,
  setOutlineToggle,
  setViewCameraById,
} from './scene.js'
import { useStore } from '../store.js'
import { SUPPORTED_EXTENSION_RE, SUPPORTED_EXTENSIONS } from './loadModel.js'
import {
  selectBone,
  setTransformSpace,
  setBonesVisible,
  setPickableBones,
  setRotationSnapDeg,
  setPosingEnabled,
  undo,
  redo,
} from './posing.js'
import {
  selectMesh,
  setMeshEditEnabled,
  setMeshGizmoMode,
  undo as undoMeshEdit,
  redo as redoMeshEdit,
} from './meshedit.js'
import { selectObject, setObjectMode } from './objects.js'
import { selectCamera, setCameraGizmoMode } from './cameras.js'
import StatsOverlay from '../panels/StatsOverlay.jsx'

// The viewport's mode switcher. Number keys jump straight to a mode.
const MODE_BUTTONS = [
  { value: 'view', label: 'View', title: 'Just look around — no gizmos (1)' },
  { value: 'bone', label: 'Pose', title: 'Select joints and bend them (2)' },
  { value: 'mesh', label: 'Mesh', title: 'Move, rotate or resize parts like eyes and hair (3)' },
]
const MODE_KEYS = { 1: 'view', 2: 'bone', 3: 'mesh' }
const GIZMO_KEYS = { w: 'translate', e: 'rotate', r: 'scale' }

// The 3D viewport: owns the canvas container and the scene lifecycle, and
// handles drag-and-drop of model files onto itself.
export default function Viewport() {
  const containerRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  // Create the scene once on mount, tear it down on unmount.
  useEffect(() => {
    const container = containerRef.current
    initScene(container)
    return () => disposeScene()
  }, [])

  // Push relevant store changes into the (non-reactive) scene manager.
  const showGrid = useStore((s) => s.showGrid)
  const solidBackground = useStore((s) => s.solidBackground)
  const backgroundColor = useStore((s) => s.backgroundColor)

  useEffect(() => {
    setGridVisible(showGrid)
  }, [showGrid])

  useEffect(() => {
    setBackground(solidBackground, backgroundColor)
  }, [solidBackground, backgroundColor])

  const showShadow = useStore((s) => s.showShadow)
  const shadowMapping = useStore((s) => s.shadowMapping)
  useEffect(() => {
    setShadowVisible(showShadow)
  }, [showShadow])
  useEffect(() => {
    setShadowMapping(shadowMapping)
  }, [shadowMapping])

  // All material/shading/outline-width state funnels through applyModelMaterials.
  const materialMode = useStore((s) => s.materialMode)
  const toonSteps = useStore((s) => s.toonSteps)
  const softenEnabled = useStore((s) => s.softenEnabled)
  const softenAmount = useStore((s) => s.softenAmount)
  const meshOverrides = useStore((s) => s.meshOverrides)
  const outlineWidth = useStore((s) => s.outlineWidth)

  useEffect(() => {
    applyModelMaterials()
  }, [materialMode, toonSteps, softenEnabled, softenAmount, meshOverrides, outlineWidth])

  const lightIntensity = useStore((s) => s.lightIntensity)
  const lightAzimuth = useStore((s) => s.lightAzimuth)
  const lightElevation = useStore((s) => s.lightElevation)

  useEffect(() => {
    setLightSettings(lightIntensity, lightAzimuth, lightElevation)
  }, [lightIntensity, lightAzimuth, lightElevation])

  const outlineEnabled = useStore((s) => s.outlineEnabled)

  useEffect(() => {
    setOutlineToggle(outlineEnabled)
  }, [outlineEnabled])

  // --- Interaction mode: only the active mode's gizmo + picking are live ---
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)

  useEffect(() => {
    setPosingEnabled(mode === 'bone')
    setMeshEditEnabled(mode === 'mesh')
  }, [mode])

  // --- Mesh editing: push selection / gizmo mode into the mesh-edit manager ---
  const selectedMeshUuid = useStore((s) => s.selectedMeshUuid)
  const meshGizmoMode = useStore((s) => s.meshGizmoMode)

  useEffect(() => {
    selectMesh(selectedMeshUuid)
  }, [selectedMeshUuid])

  useEffect(() => {
    setMeshGizmoMode(meshGizmoMode)
  }, [meshGizmoMode])

  // --- Bone posing: push selection / gizmo space / overlay visibility ---
  const selectedBoneName = useStore((s) => s.selectedBoneName)
  const transformSpace = useStore((s) => s.transformSpace)
  const showBones = useStore((s) => s.showBones)

  useEffect(() => {
    selectBone(selectedBoneName)
  }, [selectedBoneName])

  useEffect(() => {
    setTransformSpace(transformSpace)
  }, [transformSpace])

  useEffect(() => {
    setBonesVisible(showBones)
  }, [showBones])

  const rotationSnap = useStore((s) => s.rotationSnap)
  useEffect(() => {
    setRotationSnapDeg(rotationSnap ? 15 : null)
  }, [rotationSnap])

  // "Hide helper bones" trims the dot overlay + picking to the primary bones.
  // (modelInfo is also a dep so a freshly loaded rig gets its filter applied.)
  const deformOnly = useStore((s) => s.deformOnly)
  const modelInfo = useStore((s) => s.modelInfo)
  useEffect(() => {
    const bones = modelInfo?.bones || []
    setPickableBones(
      deformOnly ? bones.filter((b) => b.deform).map((b) => b.name) : null,
    )
  }, [deformOnly, modelInfo])

  // --- Scene objects: push selection / gizmo mode into the objects manager ---
  const selectedObjectId = useStore((s) => s.selectedObjectId)
  const objectMode = useStore((s) => s.objectMode)

  useEffect(() => {
    selectObject(selectedObjectId)
  }, [selectedObjectId])

  useEffect(() => {
    setObjectMode(objectMode)
  }, [objectMode])

  // --- Cameras: push selection / gizmo mode / view-through into the managers ---
  const selectedCameraId = useStore((s) => s.selectedCameraId)
  const cameraGizmoMode = useStore((s) => s.cameraGizmoMode)
  const viewCameraId = useStore((s) => s.viewCameraId)
  const sceneCameras = useStore((s) => s.sceneCameras)
  const viewCameraName = sceneCameras.find((cam) => cam.id === viewCameraId)?.name

  useEffect(() => {
    selectCamera(selectedCameraId)
  }, [selectedCameraId])

  useEffect(() => {
    setCameraGizmoMode(cameraGizmoMode)
  }, [cameraGizmoMode])

  useEffect(() => {
    setViewCameraById(viewCameraId)
  }, [viewCameraId])

  // Keyboard: 1/2/3 switch mode, W/E/R pick the Mesh-mode gizmo tool, Esc
  // deselects, Ctrl/Cmd+Z undoes an edit in the active mode, Ctrl/Cmd+Shift+Z
  // or Ctrl/Cmd+Y redoes it. Ignored while typing in an input.
  useEffect(() => {
    function onKeyDown(e) {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const s = useStore.getState()
      const plainKey = !e.ctrlKey && !e.metaKey && !e.altKey
      if (e.key === '?') {
        s.toggleHelp()
      } else if (e.key === 'Escape') {
        if (s.showHelp) s.setShowHelp(false)
        else if (s.viewCameraId != null) s.setViewCameraId(null) // leave the camera view
        else if (s.mode === 'mesh') s.setSelectedMeshUuid(null)
        else s.setSelectedBoneName(null)
      } else if (plainKey && e.key === '0') {
        // Toggle looking through a camera (the selected one, else the first).
        if (s.viewCameraId != null) s.setViewCameraId(null)
        else {
          const cam = s.sceneCameras.find((x) => x.id === s.selectedCameraId) || s.sceneCameras[0]
          if (cam) s.setViewCameraId(cam.id)
        }
      } else if (plainKey && MODE_KEYS[e.key]) {
        s.setMode(MODE_KEYS[e.key])
      } else if (plainKey && s.mode === 'mesh' && GIZMO_KEYS[e.key.toLowerCase()]) {
        s.setMeshGizmoMode(GIZMO_KEYS[e.key.toLowerCase()])
      } else if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === 'y' || e.key === 'Y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))
      ) {
        e.preventDefault()
        if (s.mode === 'mesh') redoMeshEdit()
        else redo()
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (s.mode === 'mesh') undoMeshEdit()
        else undo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // --- Drag & drop ---
  function onDragOver(e) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dragOver) setDragOver(true)
  }

  function onDragLeave(e) {
    // Only clear when the pointer actually leaves the container, not a child.
    if (e.currentTarget.contains(e.relatedTarget)) return
    setDragOver(false)
  }

  function onDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files && e.dataTransfer.files[0]
    if (!file) return
    if (!SUPPORTED_EXTENSION_RE.test(file.name)) {
      const list = SUPPORTED_EXTENSIONS.map((e) => '.' + e).join(', ')
      useStore.getState().setLoadError('Unsupported file. Drop a ' + list + ' file.')
      return
    }
    loadModelFile(file).catch(() => {}) // error is surfaced via the store
  }

  const loading = useStore((s) => s.loading)
  const showStats = useStore((s) => s.showStats)

  return (
    <div
      className={'viewport-wrap' + (dragOver ? ' dragover' : '')}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Three.js appends its canvas into this inner host; React-managed overlays
          live as siblings so React never fights the imperatively-added canvas. */}
      <div ref={containerRef} className="viewport-canvas-host" />

      {modelInfo && (
        <div className="mode-toolbar seg" title="What clicking and dragging does in the view">
          {MODE_BUTTONS.map((b) => (
            <button
              key={b.value}
              className={'seg-btn' + (mode === b.value ? ' active' : '')}
              title={b.title}
              onClick={() => setMode(b.value)}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      {viewCameraId != null && (
        <button
          className="camera-view-banner"
          title="Back to the free view (Esc or 0)"
          onClick={() => useStore.getState().setViewCameraId(null)}
        >
          🎥 {viewCameraName || 'Camera'} — click or press Esc to exit
        </button>
      )}

      {!modelInfo && !loading && (
        <div className="viewport-empty">
          <div className="ve-icon">⬚</div>
          <div className="ve-title">Drop a character here</div>
          <div className="ve-sub">
            …or use the <b>Load</b> button in the sidebar.
            <br />
            Works with <b>.glb</b>, <b>.gltf</b> and <b>.fbx</b> files.
          </div>
          <div className="ve-hint">Press ? any time for help</div>
        </div>
      )}

      {showStats && <StatsOverlay />}
    </div>
  )
}
