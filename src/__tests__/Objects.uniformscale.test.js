import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import {
  initObjects,
  addObject,
  selectObject,
  getSelectedUniformScale,
  setSelectedUniformScale,
  snapshotObject,
  commitUniformScale,
  undo,
  redo,
} from '../three/objects.js'

// Exercises the radial-resize dial's data path end to end: get the current
// scale, drag-change it, commit, and confirm the change is undoable — the
// same "object resize doesn't undo" bug class applies here directly, since
// the dial commits through the same undo stack as the 3D gizmo.
describe('uniform scale (radial resize) helpers', () => {
  let objId

  beforeAll(() => {
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()
    const renderer = { domElement: document.createElement('canvas') }
    const controls = { enabled: true, locked: false }
    initObjects({ scene, camera, renderer, controls, requestRender: () => {} })

    const geo = new THREE.BoxGeometry(1, 1, 1)
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial())
    const root = new THREE.Group()
    root.add(mesh)
    const meta = addObject({ root }, 'TestProp', 'glb', null)
    objId = meta.id
    selectObject(objId)
  })

  it('reads back a default scale of 1', () => {
    expect(getSelectedUniformScale(objId)).toBeCloseTo(1)
  })

  it('applies a uniform scale live to all three axes', () => {
    setSelectedUniformScale(objId, 2)
    expect(getSelectedUniformScale(objId)).toBeCloseTo(2)
  })

  it('clamps to a small positive minimum instead of going to zero/negative', () => {
    setSelectedUniformScale(objId, -5)
    expect(getSelectedUniformScale(objId)).toBeGreaterThan(0)
  })

  it('is undoable/redoable once committed (regression for "resize doesn\'t undo")', () => {
    setSelectedUniformScale(objId, 1) // known starting point
    const before = snapshotObject(objId)
    setSelectedUniformScale(objId, 3)
    commitUniformScale(objId, before)

    expect(getSelectedUniformScale(objId)).toBeCloseTo(3)
    undo()
    expect(getSelectedUniformScale(objId)).toBeCloseTo(1)
    redo()
    expect(getSelectedUniformScale(objId)).toBeCloseTo(3)
  })
})