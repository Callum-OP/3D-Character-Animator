import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects, addObject, removeObject } from '../three/objects.js'
import { refreshSoftCloth, applyModelMaterials } from '../three/scene.js'
import { makeSoftZone, getSoftEntry, isSoftClothMesh, disposeSoftCloth, stepSoftCloth, initSoftCloth } from '../three/softcloth.js'

const setMeshSoftZonesFor = (uuid, zones) => useStore.getState().setMeshSoftZones(uuid, zones)

let scene

beforeAll(() => {
  scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera()
  const canvas = document.createElement('canvas')
  initObjects({ scene, camera, renderer: { domElement: canvas }, controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 2 })
  initSoftCloth({ requestRender: () => {} })
})

beforeEach(() => {
  disposeSoftCloth()
  for (const o of [...useStore.getState().sceneObjects]) removeObject(o.id)
  useStore.setState({ sceneObjects: [], meshOverrides: {}, characters: {}, activeCharacterId: 1 })
})

function makeProp() {
  const root = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1.2, 5, 6), new THREE.MeshStandardMaterial())
  root.add(mesh)
  const meta = addObject({ root }, 'Banner', 'glb', null)
  useStore.getState().addSceneObject(meta)
  return { meta, mesh, root }
}

describe('soft cloth on a part of a scene object', () => {
  it('builds from the saved zones, and goes away when they are removed', () => {
    const { mesh } = makeProp()
    setMeshSoftZonesFor(mesh.uuid, [makeSoftZone('soft', { kind: 'all' }, 'hem')])
    refreshSoftCloth()
    expect(isSoftClothMesh(mesh)).toBe(true)
    setMeshSoftZonesFor(mesh.uuid, [])
    refreshSoftCloth()
    expect(isSoftClothMesh(mesh)).toBe(false)
  })

  it('applying the materials again (any Look change) keeps it running and never leaves a mid-swing copy behind', () => {
    const { mesh, root } = makeProp()
    setMeshSoftZonesFor(mesh.uuid, [{ ...makeSoftZone('soft', { kind: 'all' }, 'hem'), range: 0.3, lockTop: 0.2 }])
    refreshSoftCloth()
    for (let f = 0; f < 20; f++) {
      root.position.x = Math.sin(f * 0.5) * 0.5
      root.updateMatrixWorld(true)
      stepSoftCloth(1 / 60)
    }
    const entry = getSoftEntry(mesh)
    expect(entry.live).toBe(true)
    applyModelMaterials()
    expect(isSoftClothMesh(mesh)).toBe(true)
    // the part is back to the clean pose until the next frame
    expect(Array.from(mesh.geometry.getAttribute('position').array)).toEqual(Array.from(entry.rest))
  })

  it('removing the object puts everything away', () => {
    const { meta, mesh } = makeProp()
    setMeshSoftZonesFor(mesh.uuid, [makeSoftZone('soft', { kind: 'all' })])
    refreshSoftCloth()
    expect(isSoftClothMesh(mesh)).toBe(true)
    removeObject(meta.id)
    useStore.setState({ sceneObjects: [] })
    refreshSoftCloth()
    expect(isSoftClothMesh(mesh)).toBe(false)
  })

  it('the zones are plain data, so they save with the project and load back', () => {
    const zones = [makeSoftZone('soft', { kind: 'tris', tris: [[0, 3], [10, 12]], vertexCount: 21 }, 'hood'), makeSoftZone('swing', { kind: 'all' }, 'zip')]
    const round = JSON.parse(JSON.stringify({ softZones: zones }))
    expect(round.softZones).toEqual(zones)
  })
})
