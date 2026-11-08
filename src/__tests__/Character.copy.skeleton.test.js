import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects } from '../three/objects.js'
import { initPosing } from '../three/posing.js'
import { initMeshEdit } from '../three/meshedit.js'
import { initAnimation } from '../three/animation.js'
import { collectDescendantBoneNames, getDangleChainsForRig, initDangle, regroupRigChainsUndoable, removeDangleChainUndoable } from '../three/dangle.js'
import { __seedCharacterForTest, getCurrentModel, setActiveCharacter } from '../three/scene.js'
import { copyCurrentEdit, pasteCurrentEdit } from '../three/editClipboard.js'
import { applyPartRig, getPartRigData, getPartRigEntries, initPartRig, removePartRig, restorePartRigs, updatePartRig } from '../three/partRig.js'
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
  initPartRig({ requestRender })
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


function makeSharedSkeletonCharacter(name) {
  const model = makeCharacter(name)
  const body = model.meshes[0]
  const geometry = new THREE.BoxGeometry()
  const count = geometry.getAttribute('position').count
  const idx = new Uint16Array(count * 4)
  const w = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) w[i * 4] = 1
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4))
  const hair = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial())
  hair.name = 'Hair'
  hair.bind(body.skeleton)
  model.root.add(hair)
  model.meshes.push(hair)
  model.skinnedMeshes.push(hair)
  model.info.meshes.push({ uuid: hair.uuid, name: 'Hair' })
  model.skeleton = body.skeleton
  return model
}

describe('copied character skeletons', () => {
  it('keeps the original skeleton untouched when bones are added to the copy', () => {
    const original = makeCharacter('Actor')
    original.skeleton = original.meshes[0].skeleton
    __seedCharacterForTest('actor', original, scene)
    useStore.setState({ mode: 'object', selectedObjectId: 'actor' })
    expect(copyCurrentEdit()).toBe('character')
    const pasted = pasteCurrentEdit()
    const duplicate = getCurrentModel()
    expect(duplicate).not.toBe(original)
    const dupSkel = duplicate.meshes[0].skeleton
    const origSkel = original.meshes[0].skeleton
    expect(dupSkel.boneInverses).not.toBe(origSkel.boneInverses)

    const tris = Array.from({ length: duplicate.meshes[0].geometry.index.count / 3 }, (_, i) => i)
    const rigged = applyPartRig(duplicate, duplicate.meshes[0], tris, { segments: 2 }, { label: 'Cape' })
    expect(rigged.ok).toBe(true)
    expect(dupSkel.bones).toHaveLength(3)
    expect(dupSkel.boneInverses).toHaveLength(3)
    expect(origSkel.bones).toHaveLength(1)
    expect(origSkel.boneInverses).toHaveLength(1)
    expect(origSkel.boneInverses.every((m) => m && m.elements.length === 16)).toBe(true)

    // the original can be rigged too, and undo of the copy's rig leaves the original alone
    const origRig = applyPartRig(original, original.meshes[0], tris, { segments: 2 }, { label: 'Hood' })
    expect(origRig.ok).toBe(true)
    expect(origSkel.boneInverses).toHaveLength(3)
    expect(dupSkel.boneInverses).toHaveLength(3)
    expect(removePartRig(duplicate, rigged.entry.id)).toBe(true)
    expect(dupSkel.boneInverses).toHaveLength(1)
    expect(origSkel.boneInverses).toHaveLength(3)
    expect(pasted.result.id).toBeTruthy()
  })
})

function makeTwoMeshCharacter(name) {
  const c = makeCharacter(name)
  const hips = c.bones[0]
  const arm = new THREE.Bone()
  arm.name = 'Arm'
  arm.position.set(1, 0, 0)
  hips.add(arm)
  const skeleton = new THREE.Skeleton([hips, arm])
  c.bones = [hips, arm]
  c.info.bones = [{ name: 'Hips' }, { name: 'Arm' }]
  const mk = (x) => {
    const geometry = new THREE.BoxGeometry()
    const n = geometry.getAttribute('position').count
    const idx = new Uint16Array(n * 4)
    const w = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) { idx[i * 4] = i % 2; w[i * 4] = 1 }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4))
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4))
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial())
    mesh.position.x = x
    c.root.add(mesh)
    return mesh
  }
  c.root.remove(c.meshes[0])
  const a = mk(0)
  const b = mk(3)
  a.name = 'A'
  b.name = 'B'
  c.root.updateMatrixWorld(true)
  a.bind(skeleton)
  b.bind(skeleton)
  c.meshes = [a, b]
  c.skinnedMeshes = [a, b]
  c.skeleton = skeleton
  c.info.meshes = [{ uuid: a.uuid, name: 'A' }, { uuid: b.uuid, name: 'B' }]
  return c
}

const vertexSnapshot = (mesh) => {
  const pos = mesh.geometry.attributes.position
  const v = new THREE.Vector3()
  const out = []
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    mesh.applyBoneTransform(i, v)
    out.push(v.x, v.y, v.z)
  }
  return out
}

describe('copied character with several meshes on one skeleton', () => {
  it('keeps one shared skeleton, so rigging and removing bones never moves other meshes', () => {
    const original = makeTwoMeshCharacter('Actor')
    __seedCharacterForTest('actor', original, scene)
    useStore.setState({ mode: 'object', selectedObjectId: 'actor' })
    expect(copyCurrentEdit()).toBe('character')
    pasteCurrentEdit()
    const dup = getCurrentModel()
    const [a, b] = dup.meshes
    expect(a.skeleton).toBe(b.skeleton)
    expect(a.skeleton).not.toBe(original.meshes[0].skeleton)
    expect(a.skeleton.boneInverses).not.toBe(original.meshes[0].skeleton.boneInverses)

    dup.root.updateMatrixWorld(true)
    const bBefore = vertexSnapshot(b)
    const aBefore = vertexSnapshot(a)
    const tris = Array.from({ length: a.geometry.index.count / 3 }, (_, i) => i)
    const rig = applyPartRig(dup, a, tris, { segments: 2 }, { label: 'Cape' })
    expect(rig.ok).toBe(true)
    dup.root.updateMatrixWorld(true)
    expect(a.skeleton.bones).toHaveLength(4)
    expect(b.skeleton.bones).toHaveLength(4)
    expect(vertexSnapshot(a)).toEqual(aBefore.map((v, i) => expect.closeTo(v, 4)))
    expect(vertexSnapshot(b)).toEqual(bBefore.map((v) => expect.closeTo(v, 4)))

    expect(removePartRig(dup, rig.entry.id)).toBe(true)
    dup.root.updateMatrixWorld(true)
    expect(a.skeleton.bones).toHaveLength(2)
    expect(b.skeleton.bones).toHaveLength(2)
    expect(vertexSnapshot(a)).toEqual(aBefore.map((v) => expect.closeTo(v, 4)))
    expect(vertexSnapshot(b)).toEqual(bBefore.map((v) => expect.closeTo(v, 4)))
    expect(original.meshes[0].skeleton.bones).toHaveLength(2)
  })

  it('copies a character that already has added bones with the skeleton still shared', () => {
    const original = makeTwoMeshCharacter('Actor')
    __seedCharacterForTest('actor', original, scene)
    const tris = Array.from({ length: original.meshes[0].geometry.index.count / 3 }, (_, i) => i)
    const rig = applyPartRig(original, original.meshes[0], tris, { segments: 2 }, { label: 'Cape' })
    expect(rig.ok).toBe(true)
    useStore.setState({ mode: 'object', selectedObjectId: 'actor' })
    expect(copyCurrentEdit()).toBe('character')
    pasteCurrentEdit()
    const dup = getCurrentModel()
    const [a, b] = dup.meshes
    expect(a.skeleton).toBe(b.skeleton)
    dup.root.updateMatrixWorld(true)
    const bBefore = vertexSnapshot(b)
    const entry = getPartRigEntries(dup)[0]
    expect(entry.result.skeletons).toEqual([a.skeleton])
    expect(removePartRig(dup, entry.id)).toBe(true)
    dup.root.updateMatrixWorld(true)
    expect(a.skeleton.bones).toHaveLength(2)
    expect(b.skeleton.bones).toHaveLength(2)
    expect(vertexSnapshot(b)).toEqual(bBefore.map((v) => expect.closeTo(v, 4)))
    expect(original.meshes[0].skeleton.bones).toHaveLength(4)
  })

  it('keeps meshes that share a skeleton sharing it in the copy, so rigs reach every mesh', () => {
    const original = makeSharedSkeletonCharacter('Actor')
    __seedCharacterForTest('actor', original, scene)
    const tris = Array.from({ length: original.meshes[0].geometry.index.count / 3 }, (_, i) => i)
    const first = applyPartRig(original, original.meshes[1], tris, { segments: 2 }, { label: 'Hair' })
    expect(first.ok).toBe(true)
    useStore.setState({ mode: 'object', selectedObjectId: 'actor' })
    expect(copyCurrentEdit()).toBe('character')
    pasteCurrentEdit()
    const duplicate = getCurrentModel()
    const [body, hair] = duplicate.meshes
    expect(body.skeleton).toBe(hair.skeleton)
    expect(body.skeleton).not.toBe(original.meshes[0].skeleton)
    expect(body.skeleton.bones).toHaveLength(3)
    expect(body.skeleton.boneInverses).toHaveLength(3)
    expect(getPartRigEntries(duplicate)[0].result.skeletons).toEqual([body.skeleton])

    const snapshot = (m) => Array.from(m.geometry.attributes.skinIndex.array)
    const bodyBefore = snapshot(body)
    const second = applyPartRig(duplicate, body, tris, { segments: 2 }, { label: 'Cape' })
    expect(second.ok).toBe(true)
    expect(body.skeleton.bones).toHaveLength(5)
    expect(removePartRig(duplicate, getPartRigEntries(duplicate)[0].id)).toBe(true)
    expect(body.skeleton.bones).toHaveLength(3)
    expect(body.skeleton.boneInverses).toHaveLength(3)
    const max = (m) => Math.max(...m.geometry.attributes.skinIndex.array)
    expect(max(body)).toBeLessThan(body.skeleton.bones.length)
    expect(max(hair)).toBeLessThan(hair.skeleton.bones.length)
    expect(removePartRig(duplicate, getPartRigEntries(duplicate)[0].id)).toBe(true)
    expect(snapshot(body)).toEqual(bodyBefore)
    expect(original.meshes[0].skeleton.bones).toHaveLength(3)
  })
})
