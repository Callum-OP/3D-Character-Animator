import { useEffect, useRef, useState } from 'react'
import React from 'react'
import {
  initScene,
  disposeScene,
  importModelAuto,
  setGridVisible,
  setGroundVisible,
  setBackground,
  setShadowVisible,
  setShadowMapping,
  setShadowSoftness,
  setShadowStrength,
  setPerformanceMode,
  setPerformanceBackgroundObjects,
  setPerformanceLowPoly,
  setPerformanceResolution,
  setPerformanceEffects,
  setDofSettings,
  setBlurSettings,
  applyModelMaterials,
  setLightSettings,
  setDefaultLightingEnabled,
  setEnvironmentLighting,
  setOutlineToggle,
  setViewCameraById,
  setCameraToObject,
  setActiveCharacter,
  dollyViewport,
  syncActiveDangleConfig,
  setOrbitSuspended,
  getObjectScreenPosition,
} from './scene.js'
import RadialScale from '../panels/RadialScale.jsx'
import { getSelectedUniformScale, setSelectedUniformScale, commitUniformScale, snapshotObject } from './objects.js'
import { useStore } from '../store.js'
import { SUPPORTED_EXTENSION_RE, SUPPORTED_EXTENSIONS } from './loadModel.js'
import {
  selectBones,
  setTransformSpace,
  setBonesVisible,
  setPickableBones,
  setRotationSnapDeg,
  setPosingEnabled,
  setBoneGizmoMode,
  setBoneViewMode,
  setShowAllPartHighlights,
  mirrorPose,
  symmetrisePose,
} from './posing.js'
import {
  selectMesh,
  setMeshEditEnabled,
  setMeshGizmoMode,
} from './meshedit.js'
import { setLimitsEnabled } from './limits.js'
import {
  selectObjects,
  setObjectMode,
  setObjectsEnabled,
  consumeObjectGizmoGrab,
  pickObjectId,
  pickObjectIdsInRect,
  isCharacterId,
} from './objects.js'
import { showMarquee, hideMarquee } from './marquee.js'
import { performUndo, performRedo } from './undoPriority.js'
import {
  copyCurrentEdit,
  pasteCurrentEdit,
  cutCurrentEdit,
  toggleCurrentVisibility,
} from './editClipboard.js'
import { selectCamera, setCameraGizmoMode, consumeCameraGizmoGrab, pickCameraId } from './cameras.js'
import { selectLight, consumeLightGizmoGrab } from './lights.js'
import StatsOverlay from '../panels/StatsOverlay.jsx'

// The viewport's mode switcher. 'view' is look-only (no picking at all);
// 'object' does prop/camera/light picking. Number keys jump straight to a
// mode.
const MODE_BUTTONS = [
  { value: 'view', label: 'View', title: 'Just look around — nothing is selectable (1)' },
  { value: 'object', label: 'Object', title: 'Click a prop, camera or light to select + move it (2)' },
  { value: 'bone', label: 'Pose', title: 'Select joints and bend or move them (3)' },
  { value: 'mesh', label: 'Mesh', title: 'Move, rotate or resize parts like eyes and hair (4)' },
]
const MODE_KEYS = { 1: 'view', 2: 'object', 3: 'bone', 4: 'mesh' }
const GIZMO_KEYS = { w: 'translate', e: 'rotate', r: 'scale' }

// Move / Rotate / Resize widgets, shown below the mode strip for every mode
// except View (nothing is selectable there, so nothing to transform). Which
// store field they read/write depends on the active mode — Object mode's
// gizmo, Mesh mode's gizmo, or Pose mode's (Move = IK, Rotate = FK; Resize
// doesn't apply to a bone, which has no size of its own).
const TRANSFORM_BUTTONS = [
  { value: 'translate', icon: '✥', label: 'Move', title: 'Move (W)' },
  { value: 'rotate', icon: '↻', label: 'Rotate', title: 'Rotate (E)' },
  { value: 'scale', icon: '⤢', label: 'Resize', title: 'Resize (R)' },
]

// Catches render-time crashes (e.g. while a project switch is mid-flight)
// so one bad frame shows a recoverable error screen instead of taking the
// whole app down to a blank white page.
class ViewportErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('Viewport error boundary caught an exception:', error, errorInfo)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="viewport-crash">
          <h3>3D viewer hit an error</h3>
          <p>{this.state.error?.message || 'A rendering error occurred while loading or switching the scene.'}</p>
          <button className="btn" onClick={this.handleReset}>Reset viewport</button>
        </div>
      )
    }
    return this.props.children
  }
}

// The 3D viewport: owns the canvas container and the scene lifecycle, and
// handles drag-and-drop of model files onto itself.
// Precise resize dial that floats at the top-right of the selected object's
// resize gizmo, in the 3D view itself. Same uniform-scale API (and single undo
// step per drag) as the Objects panel's dial; it follows the object on screen.
function ViewportScaleDial({ id }) {
  const ref = useRef(null)
  const beforeRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const [value, setValue] = useState(() => getSelectedUniformScale(id))

  useEffect(() => {
    let raf = 0
    const SIZE = 84
    const tick = () => {
      const el = ref.current
      const pos = getObjectScreenPosition(id)
      if (el) {
        if (!pos) el.style.visibility = 'hidden'
        else {
          // Up and to the right of the gizmo centre, kept fully inside the view.
          const x = Math.min(Math.max(pos.x + 70, 8), pos.width - SIZE - 8)
          const y = Math.min(Math.max(pos.y - 70 - SIZE / 2, 8), pos.height - SIZE - 8)
          el.style.visibility = 'visible'
          el.style.transform = `translate(${x}px, ${y}px)`
        }
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [id])

  return (
    <div ref={ref} className="viewport-scale-dial" aria-label="Precise resize dial">
      <RadialScale
        compact
        value={dragging ? value : getSelectedUniformScale(id)}
        getValue={() => getSelectedUniformScale(id)}
        label="Precise resize"
        onDragStart={(v) => {
          beforeRef.current = snapshotObject(id)
          setValue(v)
          setDragging(true)
        }}
        onChange={(v) => {
          setValue(v)
          setSelectedUniformScale(id, v)
        }}
        onCommit={() => {
          commitUniformScale(id, beforeRef.current)
          beforeRef.current = null
          setDragging(false)
        }}
      />
    </div>
  )
}

function Viewport() {
  const containerRef = useRef(null)
  const emptyModelInputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  const [symmetriseOpen, setSymmetriseOpen] = useState(false)

  // Create the scene once on mount, tear it down on unmount.
  useEffect(() => {
    const container = containerRef.current
    initScene(container)

    // Handle WebGL context loss gracefully — without this Chromium shows its
    // own "Aw, Snap" style crash surface and the app never recovers on its
    // own; 'webglcontextlost' lets us keep the tab alive, and rebuilding the
    // scene on 'webglcontextrestored' gets rendering going again once the GPU
    // process comes back (see also main.cjs's child-process-gone/GPU logging
    // and render-process-gone recovery, which handle the renderer-level case).
    const canvas = container.querySelector('canvas')
    const handleContextLost = (e) => {
      e.preventDefault()
      console.warn('WebGL context lost — waiting for restore before rebuilding the scene.')
    }
    const handleContextRestored = () => {
      try {
        disposeScene()
        initScene(container)
      } catch (err) {
        console.error('Failed to rebuild the scene after WebGL context restore:', err)
      }
    }
    if (canvas) {
      canvas.addEventListener('webglcontextlost', handleContextLost, false)
      canvas.addEventListener('webglcontextrestored', handleContextRestored, false)
    }

    return () => {
      if (canvas) {
        canvas.removeEventListener('webglcontextlost', handleContextLost)
        canvas.removeEventListener('webglcontextrestored', handleContextRestored)
      }
      disposeScene()
    }
  }, [])

  // Push relevant store changes into the (non-reactive) scene manager.
  const showGrid = useStore((s) => s.showGrid)
  const showGround = useStore((s) => s.showGround)
  const solidBackground = useStore((s) => s.solidBackground)
  const backgroundColor = useStore((s) => s.backgroundColor)

  useEffect(() => {
    setGridVisible(showGrid)
  }, [showGrid])

  useEffect(() => {
    setGroundVisible(showGround)
  }, [showGround])

  useEffect(() => {
    setBackground(solidBackground, backgroundColor)
  }, [solidBackground, backgroundColor])

  const showShadow = useStore((s) => s.showShadow)
  const shadowMapping = useStore((s) => s.shadowMapping)
  const shadowSoftness = useStore((s) => s.shadowSoftness)
  const shadowStrength = useStore((s) => s.shadowStrength)
  const performanceMode = useStore((s) => s.performanceMode)
  const performanceBackgroundObjects = useStore((s) => s.performanceBackgroundObjects)
  const performanceLowPoly = useStore((s) => s.performanceLowPoly)
  const performanceResolution = useStore((s) => s.performanceResolution)
  const performanceEffects = useStore((s) => s.performanceEffects)
  useEffect(() => {
    setShadowVisible(showShadow)
  }, [showShadow])
  useEffect(() => {
    setShadowMapping(shadowMapping)
  }, [shadowMapping])
  useEffect(() => {
    setShadowSoftness(shadowSoftness)
  }, [shadowSoftness])
  useEffect(() => {
    setShadowStrength(shadowStrength)
  }, [shadowStrength])
  useEffect(() => {
    setPerformanceMode(performanceMode)
  }, [performanceMode])
  useEffect(() => {
    setPerformanceBackgroundObjects(performanceBackgroundObjects)
  }, [performanceBackgroundObjects])
  useEffect(() => {
    setPerformanceLowPoly(performanceLowPoly)
  }, [performanceLowPoly])
  useEffect(() => {
    setPerformanceResolution(performanceResolution)
  }, [performanceResolution])
  useEffect(() => {
    setPerformanceEffects(performanceEffects)
  }, [performanceEffects])

  const dofEnabled = useStore((s) => s.dofEnabled)
  const dofFocusDistance = useStore((s) => s.dofFocusDistance)
  const dofAperture = useStore((s) => s.dofAperture)
  const dofMaxBlur = useStore((s) => s.dofMaxBlur)
  const blurEnabled = useStore((s) => s.blurEnabled)
  const blurAmount = useStore((s) => s.blurAmount)
  useEffect(() => {
    setDofSettings(dofEnabled, dofFocusDistance, dofAperture, dofMaxBlur)
  }, [dofEnabled, dofFocusDistance, dofAperture, dofMaxBlur])
  useEffect(() => {
    setBlurSettings(blurEnabled, blurAmount)
  }, [blurEnabled, blurAmount])

  // All material/shading/outline-width state funnels through applyModelMaterials.
  const materialMode = useStore((s) => s.materialMode)
  const toonSteps = useStore((s) => s.toonSteps)
  const colorGrading = useStore((s) => s.colorGrading)
  const ambientOcclusionStrength = useStore((s) => s.ambientOcclusionStrength)
  const backlightColor = useStore((s) => s.backlightColor)
  const backlightFalloff = useStore((s) => s.backlightFalloff)
  const lightLinks = useStore((s) => s.lightLinks)
  const characterOrder = useStore((s) => s.characterOrder)
  const softenEnabled = useStore((s) => s.softenEnabled)
  const softenAmount = useStore((s) => s.softenAmount)
  const meshOverrides = useStore((s) => s.meshOverrides)
  const outlineWidth = useStore((s) => s.outlineWidth)
  const outlineColor = useStore((s) => s.outlineColor)
  const outlineOpacity = useStore((s) => s.outlineOpacity)
  const rimLightColor = useStore((s) => s.rimLightColor)
  const rimSideOnly = useStore((s) => s.rimSideOnly)
  const rimSoftEnabled = useStore((s) => s.rimSoftEnabled)
  const rimSoftIntensity = useStore((s) => s.rimSoftIntensity)
  const rimSoftWidth = useStore((s) => s.rimSoftWidth)
  const rimHardEnabled = useStore((s) => s.rimHardEnabled)
  const rimHardIntensity = useStore((s) => s.rimHardIntensity)
  const rimHardWidth = useStore((s) => s.rimHardWidth)

  useEffect(() => {
    applyModelMaterials()
  }, [
    materialMode,
    toonSteps,
    colorGrading,
    ambientOcclusionStrength,
    backlightColor,
    backlightFalloff,
    lightLinks,
    characterOrder,
    softenEnabled,
    softenAmount,
    meshOverrides,
    outlineWidth,
    outlineColor,
    outlineOpacity,
    rimLightColor,
    rimSideOnly,
    rimSoftEnabled,
    rimSoftIntensity,
    rimSoftWidth,
    rimHardEnabled,
    rimHardIntensity,
    rimHardWidth,
  ])

  const lightIntensity = useStore((s) => s.lightIntensity)
  const lightAzimuth = useStore((s) => s.lightAzimuth)
  const lightElevation = useStore((s) => s.lightElevation)

  useEffect(() => {
    setLightSettings(lightIntensity, lightAzimuth, lightElevation)
  }, [lightIntensity, lightAzimuth, lightElevation])

  const defaultLightingEnabled = useStore((s) => s.defaultLightingEnabled)
  useEffect(() => {
    setDefaultLightingEnabled(defaultLightingEnabled)
  }, [defaultLightingEnabled])

  const envLightingEnabled = useStore((s) => s.envLightingEnabled)
  const envLightingIntensity = useStore((s) => s.envLightingIntensity)

  useEffect(() => {
    setEnvironmentLighting(envLightingEnabled, envLightingIntensity)
  }, [envLightingEnabled, envLightingIntensity])

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
    setObjectsEnabled(mode === 'object')
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
  // selectedBoneNames can hold several names (shift/ctrl-click) — selectBones()
  // attaches the gizmo to all of them via a shared rotate pivot when there's
  // more than one, or behaves like a plain single-select otherwise.
  const selectedBoneNames = useStore((s) => s.selectedBoneNames)
  const transformSpace = useStore((s) => s.transformSpace)
  const showBones = useStore((s) => s.showBones)

  useEffect(() => {
    selectBones(selectedBoneNames)
  }, [selectedBoneNames])

  useEffect(() => {
    setTransformSpace(transformSpace)
  }, [transformSpace])

  const boneGizmoMode = useStore((s) => s.boneGizmoMode)
  useEffect(() => {
    setBoneGizmoMode(boneGizmoMode)
  }, [boneGizmoMode])

  useEffect(() => {
    setBonesVisible(showBones)
  }, [showBones])

  const boneViewMode = useStore((s) => s.boneViewMode)
  useEffect(() => {
    setBoneViewMode(boneViewMode)
  }, [boneViewMode])

  const showAllPartHighlights = useStore((s) => s.showAllPartHighlights)
  useEffect(() => {
    setShowAllPartHighlights(showAllPartHighlights)
  }, [showAllPartHighlights])

  const rotationSnap = useStore((s) => s.rotationSnap)
  useEffect(() => {
    setRotationSnapDeg(rotationSnap ? 15 : null)
  }, [rotationSnap])

  const limbLimits = useStore((s) => s.limbLimits)
  useEffect(() => {
    setLimitsEnabled(limbLimits)
  }, [limbLimits])



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

  // --- Dangle bones: push the active character's chains/settings into the
  // physics engine whenever the master toggle or any chain (add/remove/
  // slider edit) changes. modelInfo is also a dep so switching to a
  // different loaded character re-syncs against ITS chains instead of
  // silently keeping the previous character's.
  const dangleEnabled = useStore((s) => s.dangleEnabled)
  const dangleChains = useStore((s) => s.dangleChains)
  useEffect(() => {
    syncActiveDangleConfig(dangleEnabled, dangleChains)
  }, [dangleEnabled, dangleChains, modelInfo])

  // --- Scene objects: push selection / gizmo mode into the objects manager ---
  // selectedObjectIds can hold several ids (shift/ctrl-click in the panel) —
  // selectObjects() attaches the gizmo to all of them via a shared pivot when
  // there's more than one, or behaves like a plain single-select otherwise.
  const selectedObjectIds = useStore((s) => s.selectedObjectIds)
  const objectMode = useStore((s) => s.objectMode)

  useEffect(() => {
    selectObjects(selectedObjectIds)
  }, [selectedObjectIds])

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

  // --- Click empty space to deselect the active object/camera/light ---
  // A prop/camera/light's move/rotate/resize gizmo stays up until you pick
  // something else, hide the panel, or hit Esc — clicking past it (on the
  // model, the ground, or open air) now clears it too, same as most 3D apps.
  // Distinguished from an actual gizmo drag (which shouldn't deselect) via
  // each manager's consume*GizmoGrab(), and from an orbit-drag via a small
  // pointer-movement threshold so spinning the camera never deselects.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let down = null
    let marquee = null // { x0, y0 } screen (client) coords while Ctrl/Cmd-dragging a box-select

    function onPointerDown(e) {
      down = { x: e.clientX, y: e.clientY }
      const s = useStore.getState()
      if (e.button === 0 && (e.ctrlKey || e.metaKey || e.shiftKey) && s.mode === 'object' && s.viewCameraId == null) {
        marquee = { x0: e.clientX, y0: e.clientY }
        setOrbitSuspended(true)
      }
    }

    function onPointerMoveMarquee(e) {
      if (!marquee) return
      const rect = el.getBoundingClientRect()
      showMarquee(el, marquee.x0 - rect.left, marquee.y0 - rect.top, e.clientX - rect.left, e.clientY - rect.top)
    }

    function onPointerUp(e) {
      const start = down
      down = null

      if (marquee) {
        const { x0, y0 } = marquee
        marquee = null
        hideMarquee()
        setOrbitSuspended(false)
        // Same metric/threshold the plain-click check below uses (dx²+dy² >
        // 25, i.e. ~5px) — kept identical so a shaky click can't accidentally
        // read as a tiny box-select one way and a plain click the other.
        const mdx = e.clientX - x0
        const mdy = e.clientY - y0
        if (mdx * mdx + mdy * mdy > 25) {
          const rect = el.getBoundingClientRect()
          const ids = pickObjectIdsInRect(x0 - rect.left, y0 - rect.top, e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height)
          useStore.getState().setObjectSelection(ids, e.shiftKey)
          return
        }
        // Too small to count as a drag — fall through to the normal
        // (Ctrl-held, so additive) click handling below.
      }

      // Always consume the gizmo-grab flags so a real drag never leaks into
      // the next, unrelated click.
      const grabbed = consumeObjectGizmoGrab() || consumeCameraGizmoGrab() || consumeLightGizmoGrab()
      if (!start || e.button !== 0 || grabbed) return
      const dx = e.clientX - start.x
      const dy = e.clientY - start.y
      if (dx * dx + dy * dy > 25) return // moved too far — an orbit drag, not a click

      const s = useStore.getState()

      // Clicking any loaded character — in ANY mode, not just Object mode —
      // makes it the active character (the one posing/mesh-edit/the gizmo
      // operate on), mirroring the "activate" button next to it in the
      // character roster. This only fires when the click lands on a
      // character that ISN'T already active; clicking the already-active
      // character falls through to that mode's normal picking behaviour
      // (bone-pick, mesh-pick, object-select, etc) exactly as before.
      // Skipped while looking through a scene camera, same as object-mode
      // picking below.
      if (s.viewCameraId == null) {
        const rect = el.getBoundingClientRect()
        const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1
        const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1
        const cameraHitId = s.mode === 'object' ? pickCameraId(ndcX, ndcY) : null
        const hitId = pickObjectId(ndcX, ndcY)

        if (cameraHitId != null) {
          s.setSelectedCameraId(cameraHitId)
          return
        }

        if (hitId != null && isCharacterId(hitId) && hitId !== s.activeCharacterId) {
          setActiveCharacter(hitId)
          // In Object mode, also select it as an object so the move/rotate/
          // resize gizmo attaches to it right away, same as clicking any
          // other object there.
          if (s.mode === 'object') {
            if (e.shiftKey || e.ctrlKey || e.metaKey) s.toggleObjectSelection(hitId, true)
            else s.setSelectedObjectId(hitId)
          }
          return
        }

        // Object mode: clicking a prop/image selects it directly — gizmo and
        // all — without needing to find it in the Objects panel first.
        // Shift/Ctrl-click adds it to the current selection, same as the panel.
        // (Plain 'view' mode intentionally falls through to here and does
        // nothing — it's look-only, no picking.)
        if (s.mode === 'object' && hitId != null) {
          if (e.shiftKey || e.ctrlKey || e.metaKey) s.toggleObjectSelection(hitId, true)
          else s.setSelectedObjectId(hitId)
          return
        }
      }

      if (s.selectedObjectId != null) s.setSelectedObjectId(null)
      if (s.selectedCameraId != null) s.setSelectedCameraId(null)
      if (s.selectedLightId != null) {
        s.setSelectedLightId(null)
        selectLight(null) // Lights panel drives its own gizmo attach, not a store effect
      }
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointermove', onPointerMoveMarquee)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointermove', onPointerMoveMarquee)
    }
  }, [])

  // Keyboard: 1/2/3 switch mode, W/E/R pick the Mesh-mode gizmo tool, Esc
  // deselects, Ctrl/Cmd+Z undoes an edit — a selected prop/image/camera/light
  // always undoes its own move/rotate/resize first (it's independent of
  // mode), otherwise Mesh/Bone mode undo their own edit.
  // Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redoes it. Ignored while typing in an input.
  useEffect(() => {
    function onKeyDown(e) {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return
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
      } else if (plainKey && s.mode === 'object' && GIZMO_KEYS[e.key.toLowerCase()]) {
        s.setObjectMode(GIZMO_KEYS[e.key.toLowerCase()])
      } else if (plainKey && e.key.toLowerCase() === 'h') {
        toggleCurrentVisibility(s)
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        if (copyCurrentEdit(s)) e.preventDefault()
      } else if ((e.ctrlKey || e.metaKey) && ['v', 'V', 'p', 'P'].includes(e.key)) {
        if (pasteCurrentEdit(s)) e.preventDefault()
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
        if (cutCurrentEdit(s)) e.preventDefault()
      } else if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === 'y' || e.key === 'Y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))
      ) {
        e.preventDefault()
        performRedo(s)
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        performUndo(s)
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
    importModelAuto(file).catch(() => {}) // error is surfaced via the store
  }

  const loading = useStore((s) => s.loading)
  const loadError = useStore((s) => s.loadError)
  const showStats = useStore((s) => s.showStats)
  // Preview / Record film the viewport, so the on-canvas toolbars step aside.
  const shotActive = useStore((s) => s.recording || s.previewing)
  const sceneObjects = useStore((s) => s.sceneObjects)
  const selectedObjectId = useStore((s) => s.selectedObjectId)
  const hasCharacter = Boolean(modelInfo)
  const hasSceneContent = hasCharacter || sceneObjects.length > 0
  const modeButtons = hasCharacter ? MODE_BUTTONS : MODE_BUTTONS.filter((b) => b.value === 'view' || b.value === 'object' || b.value === 'mesh')

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

      {hasSceneContent && !shotActive && (
        <div className="mode-toolbar seg" title="What clicking and dragging does in the view">
          {modeButtons.map((b) => (
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

      {hasCharacter && mode === 'bone' && (
        <div className="pose-toolbar" aria-label="Whole pose actions">
          <button
            className="pose-toolbar-btn"
            title="Swap the character's left and right pose, including arms and legs"
            onClick={() => mirrorPose()}
          >
            Mirror
          </button>
          <button
            className="pose-toolbar-btn"
            title="Make the whole character symmetrical, including centre bones like the chest"
            onClick={() => setSymmetriseOpen((open) => !open)}
          >
            Symmetrise
          </button>
          {symmetriseOpen && (
            <div className="symmetrise-menu" role="menu" aria-label="Symmetrise options">
              <button onClick={() => { symmetrisePose('left'); setSymmetriseOpen(false) }}>Copy from left</button>
              <button onClick={() => { symmetrisePose('right'); setSymmetriseOpen(false) }}>Copy from right</button>
              <button onClick={() => { symmetrisePose('average'); setSymmetriseOpen(false) }}>Meet in middle</button>
            </div>
          )}
        </div>
      )}

      {(modelInfo || selectedCameraId != null || selectedObjectIds.length > 0) && mode !== 'view' && (
        <div className="transform-widget-strip" title="What dragging the gizmo does">
          {TRANSFORM_BUTTONS.map((b) => {
            // Bone mode has Move (IK: drag the joint, its ancestor chain
            // follows within its reach and limb limits) and Rotate (FK) —
            // but no Resize, since a bone has no size of its own.
            const isBone = mode === 'bone'
            const isCamera = mode === 'object' && selectedCameraId != null
            const disabled = (isBone || isCamera) && b.value === 'scale'
            const activeValue = isBone
              ? boneGizmoMode
              : mode === 'mesh'
                ? meshGizmoMode
                : isCamera
                  ? cameraGizmoMode
                  : objectMode
            const active = activeValue === b.value
            return (
              <button
                key={b.value}
                className={'transform-widget-btn' + (active ? ' active' : '') + (disabled ? ' disabled' : '')}
                title={disabled ? b.title + ' — not available for bones (no size of their own)' : b.title}
                aria-label={b.label}
                disabled={disabled}
                onClick={() => {
                  if (disabled) return
                  // Go through the store actions (not the imported
                  // setMeshGizmoMode from meshedit.js, which is the
                  // imperative three.js setter) so the panels and this
                  // widget stay in sync.
                  if (mode === 'bone') useStore.getState().setBoneGizmoMode(b.value)
                  else if (mode === 'mesh') useStore.getState().setMeshGizmoMode(b.value)
                  else if (isCamera) useStore.getState().setCameraGizmoMode(b.value)
                  else if (mode === 'object') useStore.getState().setObjectMode(b.value)
                }}
              >
                <span className="transform-widget-icon">{b.icon}</span>
              </button>
            )
          })}
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

      {!hasSceneContent && !loading && (
        <div className="viewport-empty">
          <div className="ve-kicker">3D Viewer</div>
          <div className="ve-title">{loadError ? 'Unable to load this model' : 'Bring an object into the scene'}</div>
          <div className="ve-sub">
            {loadError ? (
              <span>{loadError}</span>
            ) : (
              <>Choose any 3D model or drop it anywhere in the viewer. Rigged models are added as characters.</>
            )}
          </div>
          <button
            className="btn ve-load-btn"
            onClick={() => emptyModelInputRef.current?.click()}
            disabled={loading}
          >
            {loading ? 'Loading model…' : '＋ Load object'}
          </button>
          <input
            ref={emptyModelInputRef}
            className="visually-hidden"
            type="file"
            accept=".glb,.gltf,.fbx,model/gltf-binary,model/gltf+json"
            aria-label="Choose a 3D model file"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) importModelAuto(file).catch(() => {})
            }}
          />
          {!loadError && <div className="ve-formats">GLB · glTF · FBX <span>·</span> Press ? for help</div>}
        </div>
      )}

      {mode === 'object' && objectMode === 'scale' && selectedObjectId != null && selectedObjectIds.length <= 1 && (
        <ViewportScaleDial key={selectedObjectId} id={selectedObjectId} />
      )}

      {hasSceneContent && !shotActive && (
        <div className="zoom-toolbar" aria-label="Viewport camera controls">
          <button
            className="zoom-toolbar-btn"
            title={selectedObjectId != null ? 'Frame selected object and orbit around it' : 'Select an object to frame it'}
            aria-label="Frame selected object"
            disabled={selectedObjectId == null}
            onClick={() => setCameraToObject(selectedObjectId)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
              <path d="M4 7h3l1.5-2h7L17 7h3v12H4z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
              <circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="1.7" />
              <path d="M12 8v2m0 6v2m-5-5h2m6 0h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
          <button className="zoom-toolbar-btn" title="Zoom in" aria-label="Zoom in" onClick={() => dollyViewport(-1)}>
            +
          </button>
          <button className="zoom-toolbar-btn" title="Zoom out" aria-label="Zoom out" onClick={() => dollyViewport(1)}>
            −
          </button>
        </div>
      )}

      {showStats && !shotActive && <StatsOverlay />}
    </div>
  )
}

export default function ExportedViewport(props) {
  return (
    <ViewportErrorBoundary>
      <Viewport {...props} />
    </ViewportErrorBoundary>
  )
}