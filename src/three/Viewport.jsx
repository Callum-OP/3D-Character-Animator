import { useEffect, useRef, useState } from 'react'
import {
  initScene,
  disposeScene,
  loadModelFile,
  setGridVisible,
  setBackground,
  applyModelMaterials,
  setLightSettings,
  setOutlineToggle,
} from './scene.js'
import { useStore } from '../store.js'
import { SUPPORTED_EXTENSION_RE, SUPPORTED_EXTENSIONS } from './loadModel.js'
import { selectBone, setTransformSpace, setBonesVisible, undo } from './posing.js'

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

  // Keyboard: Esc deselects, Ctrl/Cmd+Z undoes a bone edit. Ignored while typing
  // in an input (e.g. the bone filter box).
  useEffect(() => {
    function onKeyDown(e) {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'Escape') {
        useStore.getState().setSelectedBoneName(null)
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        undo()
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

  return (
    <div
      ref={containerRef}
      className={'viewport-wrap' + (dragOver ? ' dragover' : '')}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    />
  )
}
