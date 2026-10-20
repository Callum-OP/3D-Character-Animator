import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import {
  initMeshEdit, registerObjectMeshes, setMeshDelta, getMeshDelta, getMeshEditsForMeshes, applyMeshEditsToMeshes,
} from '../three/meshedit.js'

const makeProp = (n = 3) => {
  const root = new THREE.Group()
  const meshes = []
  for (let i = 0; i < n; i++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    mesh.position.set(i * 2, 0, 0)
    root.add(mesh)
    meshes.push(mesh)
  }
  root.updateMatrixWorld(true)
  return { root, meshes }
}

let scene
beforeAll(() => {
  scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera()
  initMeshEdit({ scene, camera, renderer: { domElement: document.createElement('canvas') }, controls: { enabled: true, locked: false }, requestRender: () => {}, onSelect: () => {} })
})

describe('parts of a prop that were moved are saved and restored', () => {
  it('records only the moved parts, by index', () => {
    const { root, meshes } = makeProp()
    scene.add(root)
    registerObjectMeshes(101, meshes)
    expect(getMeshEditsForMeshes(meshes)).toEqual([])
    setMeshDelta(meshes[1].uuid, { offset: [0, 3, 0] })
    const edits = getMeshEditsForMeshes(meshes)
    expect(edits).toHaveLength(1)
    expect(edits[0].index).toBe(1)
  })

  it('puts the move back on freshly loaded meshes (a reloaded project)', () => {
    const a = makeProp()
    scene.add(a.root)
    registerObjectMeshes(102, a.meshes)
    setMeshDelta(a.meshes[2].uuid, { offset: [1, 2, 3], rotation: [0, 45, 0], scale: [2, 2, 2] })
    const saved = JSON.parse(JSON.stringify(getMeshEditsForMeshes(a.meshes))) // through JSON, as a project file is

    const b = makeProp()
    scene.add(b.root)
    registerObjectMeshes(103, b.meshes)
    expect(getMeshEditsForMeshes(b.meshes)).toEqual([])
    applyMeshEditsToMeshes(b.meshes, saved)
    const after = getMeshDelta(b.meshes[2].uuid)
    expect(after.offset[0]).toBeCloseTo(1)
    expect(after.offset[1]).toBeCloseTo(2)
    expect(after.offset[2]).toBeCloseTo(3)
    expect(after.rotation[1]).toBeCloseTo(45)
    expect(after.scale[0]).toBeCloseTo(2)
    // untouched parts stay put
    expect(getMeshDelta(b.meshes[0].uuid).offset).toEqual([0, 0, 0].map((v) => expect.closeTo(v, 5)))
  })

  it('ignores edits for parts that no longer exist', () => {
    const { root, meshes } = makeProp(1)
    scene.add(root)
    registerObjectMeshes(104, meshes)
    expect(() => applyMeshEditsToMeshes(meshes, [{ index: 9, position: [0, 0, 0] }])).not.toThrow()
    expect(() => applyMeshEditsToMeshes(meshes, undefined)).not.toThrow()
  })
})
