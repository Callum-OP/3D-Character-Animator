import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import {
  initMeshEdit,
  setMeshEditModel,
  getMeshDelta,
  setMeshDelta,
  resetMesh,
  hasMeshEdits,
  undo,
  redo,
} from '../three/meshedit.js'

// Third independent undo stack in the app (objects.js and posing.js are the
// other two, both covered elsewhere) — same bug class applies: a part
// move/resize in Mesh mode needs to actually undo.
describe('mesh-part editing: undo/redo and reset', () => {
  let uuid

  beforeAll(() => {
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()
    const renderer = { domElement: document.createElement('canvas') }
    const controls = { enabled: true, locked: false }
    initMeshEdit({ scene, camera, renderer, controls, requestRender: () => {} })

    const geo = new THREE.BoxGeometry(1, 1, 1)
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial())
    mesh.name = 'Hair'
    const parent = new THREE.Group()
    parent.add(mesh)
    scene.add(parent)
    uuid = mesh.uuid

    setMeshEditModel({ meshes: [mesh] })
  })

  it('starts with no edits and a zeroed delta', () => {
    expect(hasMeshEdits()).toBe(false)
    const d = getMeshDelta(uuid)
    expect(d.offset).toEqual([0, 0, 0])
    expect(d.scale).toEqual([1, 1, 1])
  })

  it('setMeshDelta moves/scales the part and is reflected by getMeshDelta', () => {
    setMeshDelta(uuid, { offset: [0.5, 0, 0], scale: [2, 2, 2] })
    const d = getMeshDelta(uuid)
    expect(d.offset[0]).toBeCloseTo(0.5)
    expect(d.scale).toEqual([2, 2, 2])
    expect(hasMeshEdits()).toBe(true)
  })

  it('is undoable and redoable', () => {
    undo()
    expect(hasMeshEdits()).toBe(false)
    redo()
    const d = getMeshDelta(uuid)
    expect(d.scale).toEqual([2, 2, 2])
  })

  it('resetMesh returns the part to rest and is itself undoable', () => {
    resetMesh(uuid)
    expect(hasMeshEdits()).toBe(false)
    undo()
    const d = getMeshDelta(uuid)
    expect(d.scale).toEqual([2, 2, 2]) // back to the edited state from before reset
  })

  it('a no-op setMeshDelta (same values) does not create a phantom undo entry', () => {
    // Get to a clean, known state.
    resetMesh(uuid)
    expect(hasMeshEdits()).toBe(false)

    setMeshDelta(uuid, { offset: [0, 0, 0], scale: [1, 1, 1] }) // identical to rest
    expect(hasMeshEdits()).toBe(false)

    setMeshDelta(uuid, { offset: [0.2, 0, 0], scale: [1, 1, 1] }) // one real edit
    undo()
    // if the no-op above had pushed a phantom entry, this undo would land on
    // that instead of back at rest.
    expect(hasMeshEdits()).toBe(false)
  })
})