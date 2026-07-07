import { useEffect, useRef, useState } from 'react'
import {
  initScene,
  disposeScene,
  loadModelFile,
  setGridVisible,
  setBackground,
} from './scene.js'
import { useStore } from '../store.js'

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
    if (!/\.(glb|gltf)$/i.test(file.name)) {
      useStore.getState().setLoadError('Unsupported file. Drop a .glb or .gltf file.')
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
