import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects, addObject, selectObjects, setObjectsEnabled, __getObjectGizmoForTest } from '../three/objects.js'

const st = () => useStore.getState()

describe('importing an object while in Mesh mode', () => {
  beforeEach(() => {
    useStore.setState({
      mode: 'mesh',
      sceneObjects: [],
      selectedObjectId: null,
      selectedObjectIds: [],
      selectedMeshUuid: 'part-7',
      selectedMeshUuids: ['part-7', 'part-8'],
      selectedBoneName: null,
      selectedBoneNames: [],
    })
  })

  it('drops the previously selected part (whose gizmo would otherwise stay on screen)', () => {
    st().addSceneObject({ id: 11, name: 'Cars' })
    expect(st().selectedMeshUuid).toBeNull()
    expect(st().selectedMeshUuids).toEqual([])
    expect(st().selectedObjectId).toBe(11)
  })

  it('leaves Mesh mode so the new object\'s own gizmo is the one shown', () => {
    st().addSceneObject({ id: 11, name: 'Cars' })
    expect(st().mode).toBe('object')
  })

  it.each(['bone', 'object', 'view'])('does not change the mode when it is %s', (mode) => {
    useStore.setState({ mode })
    st().addSceneObject({ id: 12, name: 'Crate' })
    expect(st().mode).toBe(mode)
  })
})

describe('the Object-mode gizmo follows a newly selected object', () => {
  it('after a second import it sits on the NEW object, even though the first was moved', () => {
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000)
    initObjects({ scene, camera, renderer: { domElement: document.createElement('canvas') }, controls: { enabled: true, locked: false }, requestRender: () => {} })
    setObjectsEnabled(true)
    const make = (name) => {
      const root = new THREE.Group()
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
      root.add(mesh)
      return { root, meshes: [mesh], bones: [], skinnedMeshes: [], clips: [], info: { name } }
    }
    const a = addObject(make('A'), 'A', 'glb', null)
    selectObjects([a.id])
    const gizmo = __getObjectGizmoForTest()
    const rootA = gizmo.object
    rootA.position.set(40, 0, 0)

    const b = addObject(make('B'), 'B', 'glb', null)
    selectObjects([b.id]) // what the viewport does when the store selects the new object
    expect(gizmo.object).not.toBe(rootA)
    expect(gizmo.object.position.toArray()).toEqual([0, 0, 0])
    expect(gizmo.object.children).toHaveLength(1)
  })
})

describe('adding an image to the scene', () => {
  it('returns its description (this used to throw: it returned a variable that did not exist)', async () => {
    const { addImage } = await import('../three/objects.js')
    const scene = new THREE.Scene()
    initObjects({ scene, camera: new THREE.PerspectiveCamera(), renderer: { domElement: document.createElement('canvas') }, controls: { enabled: true, locked: false }, requestRender: () => {} })
    const meta = addImage(new THREE.Texture(), 'Poster', 1.5, null)
    expect(meta).toMatchObject({ name: 'Poster', format: 'image', kind: 'image' })
    expect(typeof meta.id).toBe('number')
    expect(typeof meta.animationKey).toBe('string')
  })
})
