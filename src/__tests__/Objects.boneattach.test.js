import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import {
  initObjects,
  addObject,
  selectObject,
  selectObjects,
  attachObjectToBone,
  detachObject,
  getObjectAttachment,
  detachObjectsForCharacter,
  removeObject,
  disposeObjects,
} from '../three/objects.js'

// Attaching a prop to a bone reparents its root under the live Bone Object3D
// so it rides along with posing/animation for free. These tests check the
// reparenting + world-transform-preserving math, and that props are never
// silently destroyed or orphaned when the character they're riding goes away.

function makeBoxRoot() {
  const geo = new THREE.BoxGeometry(1, 1, 1)
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial())
  const root = new THREE.Group()
  root.add(mesh)
  return root
}

describe('bone attachment', () => {
  let scene, bone, id

  beforeEach(() => {
    disposeObjects()
    scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()
    const renderer = { domElement: document.createElement('canvas') }
    const controls = { enabled: true, locked: false }
    initObjects({ scene, camera, renderer, controls, requestRender: () => {} })

    bone = new THREE.Bone()
    bone.name = 'RightHand'
    bone.position.set(2, 3, -1)
    bone.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    scene.add(bone)

    id = addObject({ root: makeBoxRoot() }, 'Sword', 'glb', null).id
  })

  it('reports no attachment before attaching', () => {
    expect(getObjectAttachment(id)).toBeNull()
  })

  it('reparents the prop under the bone and reports the attachment', () => {
    attachObjectToBone(id, bone, 'RightHand', 'char_1')
    expect(getObjectAttachment(id)).toEqual({ boneName: 'RightHand', characterId: 'char_1' })
  })

  it('preserves world position/rotation across attach (no visual jump)', () => {
    scene.updateMatrixWorld(true)
    attachObjectToBone(id, bone, 'RightHand')
    const prop = bone.children[0]
    prop.updateMatrixWorld(true)
    const worldPos = new THREE.Vector3().setFromMatrixPosition(prop.matrixWorld)
    // It started at the world origin (its default position) before attaching,
    // so it should still read as being at the world origin afterwards, even
    // though the bone itself is offset and rotated.
    expect(worldPos.x).toBeCloseTo(0, 5)
    expect(worldPos.y).toBeCloseTo(0, 5)
    expect(worldPos.z).toBeCloseTo(0, 5)
  })

  it('detach puts the prop back in the scene at the same world position', () => {
    attachObjectToBone(id, bone, 'RightHand')
    expect(bone.children.length).toBe(1)
    detachObject(id)
    expect(getObjectAttachment(id)).toBeNull()
    expect(bone.children.length).toBe(0)
    const prop = scene.children.find((c) => c.isGroup)
    expect(prop).toBeTruthy()
    prop.updateMatrixWorld(true)
    const worldPos = new THREE.Vector3().setFromMatrixPosition(prop.matrixWorld)
    expect(worldPos.x).toBeCloseTo(0, 5)
    expect(worldPos.y).toBeCloseTo(0, 5)
    expect(worldPos.z).toBeCloseTo(0, 5)
  })

  it('detachObjectsForCharacter only detaches props riding that character', () => {
    const otherId = addObject({ root: makeBoxRoot() }, 'Hat', 'glb', null).id
    attachObjectToBone(id, bone, 'RightHand', 'char_1')
    attachObjectToBone(otherId, bone, 'RightHand', 'char_2')

    const detached = detachObjectsForCharacter('char_1')
    expect(detached).toEqual([id])
    expect(getObjectAttachment(id)).toBeNull()
    expect(getObjectAttachment(otherId)).toEqual({ boneName: 'RightHand', characterId: 'char_2' })
  })

  it('removing an attached prop does not throw and does not touch the bone', () => {
    attachObjectToBone(id, bone, 'RightHand')
    expect(() => removeObject(id)).not.toThrow()
    expect(bone.children.length).toBe(0)
  })

  it('gizmo selection survives attach/detach without throwing', () => {
    selectObject(id)
    attachObjectToBone(id, bone, 'RightHand')
    expect(() => detachObject(id)).not.toThrow()
  })

  it('attached props are excluded from multi-select group transforms', () => {
    const otherId = addObject({ root: makeBoxRoot() }, 'Hat', 'glb', null).id
    attachObjectToBone(id, bone, 'RightHand')
    expect(() => selectObjects([id, otherId])).not.toThrow()
  })
})