import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as THREE from 'three'
import RadialScale from '../panels/RadialScale.jsx'
import ViewPanel from '../panels/ViewPanel.jsx'
import { useStore, migrateAppSettings } from '../store.js'
import { addObject, disposeObjects, getSelectedUniformScale, initObjects, redo, selectObject, setObjectMode, undo } from '../three/objects.js'
import { disposeMeshEdit, getMeshDelta, initMeshEdit, selectMeshes, setMeshEditEnabled, setMeshEditModel, setMeshGizmoMode, undo as undoMesh, redo as redoMesh } from '../three/meshedit.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useStore.getState().setTransformOuterRing('resize')
})

describe('outer resize integration', () => {
  it('resizes an object through canvas pointer events and records one undo step', () => {
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
    camera.position.set(0, 0, 5)
    camera.updateMatrixWorld(true)
    const canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 800 })
    canvas.setPointerCapture = () => {}
    canvas.releasePointerCapture = () => {}
    initObjects({ scene, camera, renderer: { domElement: canvas }, controls: { enabled: true }, requestRender: () => {} })
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))
    const { id } = addObject({ root }, 'Ring test', 'glb', null)
    selectObject(id)
    setObjectMode('scale')
    scene.updateMatrixWorld(true)

    const radius = 0.75 * 0.9 * 5 * 1.9 * Math.tan(Math.PI * 25 / 180) / 4
    const point = (x) => {
      const ndc = new THREE.Vector3(x, 0, 0).project(camera)
      return { clientX: (ndc.x + 1) * 400, clientY: (1 - ndc.y) * 400, pointerId: 1 }
    }
    fireEvent.pointerMove(canvas, { ...point(radius), button: -1 })
    fireEvent.pointerDown(canvas, { ...point(radius), button: 0 })
    fireEvent.pointerMove(canvas, { ...point(radius * 1.5), button: -1 })
    fireEvent.pointerUp(canvas, { ...point(radius * 1.5), button: 0 })
    expect(getSelectedUniformScale(id)).toBeCloseTo(1.5)
    undo()
    expect(getSelectedUniformScale(id)).toBeCloseTo(1)
    redo()
    expect(getSelectedUniformScale(id)).toBeCloseTo(1.5)
    disposeObjects()
  })

  it('refreshes the radial readout when another control changes the live scale', () => {
    vi.useFakeTimers()
    let value = 1
    const getValue = () => value
    const { container } = render(<RadialScale value={1} getValue={getValue} onChange={(v) => { value = v }} />)
    expect(screen.getByText('1.00×')).toBeTruthy()
    value = 2.5
    act(() => vi.advanceTimersByTime(20))
    expect(screen.getByText('2.50×')).toBeTruthy()
    const dial = container.querySelector('.radial-scale-dial')
    dial.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 })
    dial.setPointerCapture = () => {}
    dial.releasePointerCapture = () => {}
    fireEvent.pointerDown(dial, { clientX: 100, clientY: 50, pointerId: 1 })
    fireEvent.pointerMove(dial, { clientX: 50, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(dial, { clientX: 50, clientY: 100, pointerId: 1 })
    expect(value).toBeCloseTo(2.5 * Math.pow(2, 0.25))
  })

  it('resizes multiple mesh parts through the combined ring and undoes them together', () => {
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
    camera.position.set(0, 0, 5)
    camera.updateMatrixWorld(true)
    const canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 800 })
    canvas.setPointerCapture = () => {}
    canvas.releasePointerCapture = () => {}
    initMeshEdit({ scene, camera, renderer: { domElement: canvas }, controls: { enabled: true }, requestRender: () => {}, onSelect: () => {} })
    const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    a.position.x = -1
    b.position.x = 1
    scene.add(a, b)
    setMeshEditModel({ meshes: [a, b] })
    setMeshEditEnabled(true)
    selectMeshes([a.uuid, b.uuid])
    setMeshGizmoMode('combined')
    scene.updateMatrixWorld(true)
    const radius = 0.75 * 0.9 * 0.85 * 1.15 * 5 * 1.9 * Math.tan(Math.PI * 25 / 180) / 4
    const point = (x) => {
      const ndc = new THREE.Vector3(x, 0, 0).project(camera)
      return { clientX: (ndc.x + 1) * 400, clientY: (1 - ndc.y) * 400, pointerId: 1 }
    }
    fireEvent.pointerMove(canvas, { ...point(radius), button: -1 })
    fireEvent.pointerDown(canvas, { ...point(radius), button: 0 })
    fireEvent.pointerMove(canvas, { ...point(radius * 1.5), button: -1 })
    fireEvent.pointerUp(canvas, { ...point(radius * 1.5), button: 0 })
    expect(getMeshDelta(a.uuid).scale[0]).toBeCloseTo(1.5)
    expect(getMeshDelta(b.uuid).scale[0]).toBeCloseTo(1.5)
    undoMesh()
    expect(getMeshDelta(a.uuid).scale[0]).toBeCloseTo(1)
    expect(getMeshDelta(b.uuid).scale[0]).toBeCloseTo(1)
    redoMesh()
    expect(getMeshDelta(a.uuid).scale[0]).toBeCloseTo(1.5)
    expect(getMeshDelta(b.uuid).scale[0]).toBeCloseTo(1.5)
    disposeMeshEdit()
  })

  it('exposes and persists the transform circle choice as an app preference', () => {
    render(<ViewPanel />)
    const select = screen.getByLabelText('Transform outer circle')
    expect(select.value).toBe('resize')
    fireEvent.change(select, { target: { value: 'rotate' } })
    expect(useStore.getState().transformOuterRing).toBe('rotate')
    expect(JSON.parse(localStorage.getItem('3d-animator-app-settings')).transformOuterRing).toBe('rotate')
    expect(migrateAppSettings({ transformOuterRing: 'invalid' }).transformOuterRing).toBe('resize')
    expect(migrateAppSettings({}).transformOuterRing).toBeUndefined()
  })
})
