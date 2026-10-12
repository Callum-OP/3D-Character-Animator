import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import { initMeshEdit, setMeshEditModel, setMeshEditEnabled, pickMeshUuidsInRect, selectMeshes, getSelectedMeshUuids } from '../three/meshedit.js'

// Same posed-skin hazard as Meshedit.posedpick: a SkinnedMesh's node never
// moves when a bone does, so a box-select that read the rest-pose geometry
// would look for the part where it USED to be. The part's centre has to come
// from the posed vertices.
describe('mesh mode: box-select on a posed (skinned) part', () => {
  let skinned
  beforeAll(() => {
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100)
    camera.position.set(0, 0, 10)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    const dom = document.createElement('canvas')
    dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 })
    dom.setPointerCapture = () => {}
    dom.releasePointerCapture = () => {}
    initMeshEdit({ scene, camera, renderer: { domElement: dom }, controls: { enabled: true, locked: false }, requestRender: () => {} })

    const bone = new THREE.Bone()
    const skeleton = new THREE.Skeleton([bone])
    const geo = new THREE.BoxGeometry(2, 2, 2)
    const count = geo.attributes.position.count
    const idx = []
    const wts = []
    for (let i = 0; i < count; i += 1) {
      idx.push(0, 0, 0, 0)
      wts.push(1, 0, 0, 0)
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4))
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4))
    skinned = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial())
    skinned.add(bone)
    skinned.bind(skeleton)
    scene.add(skinned)
    bone.position.set(5, 0, 0) // posed 5 units right of where it was bound
    scene.updateMatrixWorld(true)

    setMeshEditModel({ meshes: [skinned] })
    setMeshEditEnabled(true)
  })

  it('finds the part where it is posed (px x≈75), not where it was bound (px x≈50)', () => {
    expect(pickMeshUuidsInRect(65, 40, 85, 60, 100, 100)).toEqual([skinned.uuid])
    expect(pickMeshUuidsInRect(40, 40, 60, 60, 100, 100)).toEqual([])
  })

  it('selecting a posed skinned part draws its highlight without throwing', () => {
    selectMeshes([skinned.uuid])
    expect(getSelectedMeshUuids()).toEqual([skinned.uuid])
  })
})
