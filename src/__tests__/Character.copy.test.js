import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects } from '../three/objects.js'
import { initPosing } from '../three/posing.js'
import { initMeshEdit } from '../three/meshedit.js'
import { initAnimation } from '../three/animation.js'
import { initDangle } from '../three/dangle.js'
import { __seedCharacterForTest } from '../three/scene.js'
import { copyCurrentEdit, pasteCurrentEdit } from '../three/editClipboard.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera()
const renderer = { domElement: document.createElement('canvas') }
const controls = { enabled: true, locked: false }
const requestRender = () => {}

function makeCharacter(name) {
  const root = new THREE.Group()
  root.name = name
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  root.add(hips)
  const geometry = new THREE.BoxGeometry()
  const vertexCount = geometry.getAttribute('position').count
  const skinIndices = new Uint16Array(vertexCount * 4)
  const skinWeights = new Float32Array(vertexCount * 4)
  for (let i = 0; i < vertexCount; i++) skinWeights[i * 4] = 1
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4))
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial())
  mesh.bind(new THREE.Skeleton([hips]))
  root.add(mesh)
  return {
    root,
    bones: [hips],
    meshes: [mesh],
    skinnedMeshes: [mesh],
    clips: [],
    info: {
      name,
      clipNames: [],
      bones: [{ name: 'Hips' }],
      meshes: [{ uuid: mesh.uuid, name: 'Body' }],
    },
  }
}

beforeEach(() => {
  initObjects({ scene, camera, renderer, controls, requestRender })
  initPosing({ scene, camera, renderer, controls, requestRender })
  initMeshEdit({ scene, camera, renderer, controls, requestRender })
  initAnimation({ requestRender, setContinuousRender: () => {} })
  initDangle({ requestRender })
  clearUndoHistory()
  useStore.setState({
    characters: {},
    characterOrder: [],
    activeCharacterId: null,
    sceneObjects: [],
    selectedObjectId: null,
    selectedObjectIds: [],
    mode: 'bone',
  })
})

describe('character clipboard', () => {
  it('copies and pastes an independent character with undo and redo', () => {
    const original = makeCharacter('Actor')
    __seedCharacterForTest('actor', original, scene)
    useStore.setState({
      mode: 'object',
      selectedObjectId: 'actor',
      meshOverrides: { [original.meshes[0].uuid]: { visible: false } },
      animData: {
        tracks: { Hips: [{ time: 0, quat: [0, 0, 0, 1] }] },
        root: [],
        meshes: {},
        cameras: {},
        cuts: [],
        morphs: {},
        lights: {},
      },
    })

    expect(copyCurrentEdit()).toBe('character')
    const pasted = pasteCurrentEdit()
    expect(pasted).toMatchObject({ type: 'character', result: { name: 'Actor Copy' } })
    expect(useStore.getState().characterOrder).toHaveLength(2)
    expect(useStore.getState().activeCharacterId).toBe(pasted.result.id)

    const duplicate = scene.children.find((child) => child.name === 'Actor Copy')
    expect(duplicate).toBeDefined()
    expect(duplicate).not.toBe(original.root)
    expect(duplicate.children[0]).not.toBe(original.bones[0])
    const duplicateMeshes = []
    duplicate.traverse((child) => { if (child.isMesh) duplicateMeshes.push(child) })
    const modelMeshes = duplicateMeshes.filter((mesh) => !mesh.name.startsWith('(part overlay: '))
    const duplicateMesh = modelMeshes.find((mesh) => mesh.isSkinnedMesh)
    expect(modelMeshes).toHaveLength(1)
    expect(duplicateMesh.geometry).not.toBe(original.meshes[0].geometry)
    expect(duplicateMesh.material).not.toBe(original.meshes[0].material)
    expect(duplicateMesh.skeleton.bones[0]).not.toBe(original.bones[0])
    expect(duplicateMesh.skeleton.bones[0]).toBe(duplicate.children[0])
    expect(useStore.getState().meshOverrides[duplicateMesh.uuid]).toEqual({ visible: false })
    expect(duplicateMesh.visible).toBe(false)
    expect(useStore.getState().animData.tracks.Hips).toEqual([{ time: 0, quat: [0, 0, 0, 1] }])

    performUndo(useStore.getState())
    expect(useStore.getState().characterOrder).toEqual(['actor'])
    performRedo(useStore.getState())
    expect(useStore.getState().characterOrder).toHaveLength(2)
    expect(useStore.getState().activeCharacterId).toBe(pasted.result.id)
  })
})
