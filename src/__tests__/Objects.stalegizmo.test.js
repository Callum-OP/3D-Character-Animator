import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  initObjects,
  setCharacterObject,
  clearCharacterObject,
  selectObject,
  selectObjects,
  setObjectsEnabled,
  resyncObjectGizmo,
  isObjectGizmoAttached,
  __getObjectGizmoForTest,
} from '../three/objects.js'

// The Move/Rotate/Resize gizmo must only ever drive something that still exists. After a character is removed
// (deleted, or wiped by opening another project) it used to be possible for the handles to stay drawn where that
// character stood while dragging them did nothing.

function setup() {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 10)
  const dom = document.createElement('canvas')
  dom.setPointerCapture = () => {}
  dom.releasePointerCapture = () => {}
  initObjects({ scene, camera, renderer: { domElement: dom }, controls: { enabled: true, locked: false }, requestRender: () => {} })
  const add = (id, x) => {
    const root = new THREE.Group()
    root.position.x = x
    scene.add(root)
    setCharacterObject(id, root, id)
    return root
  }
  return { scene, add }
}

describe('object gizmo never outlives what it drives', () => {
  it('a group gizmo is released when its characters are removed', () => {
    const { scene, add } = setup()
    const a = add('a', -3)
    const b = add('b', 5)
    setObjectsEnabled(true)
    selectObjects(['a', 'b'])
    const gizmo = __getObjectGizmoForTest()
    expect(gizmo.object).toBeTruthy() // attached to the group pivot at their centre

    scene.remove(a); clearCharacterObject('a')
    scene.remove(b); clearCharacterObject('b')
    expect(isObjectGizmoAttached()).toBe(false)
  })

  it('removing one of two grouped characters leaves the gizmo on the survivor, not the old centre', () => {
    const { scene, add } = setup()
    const a = add('a', -3)
    const b = add('b', 5)
    setObjectsEnabled(true)
    selectObjects(['a', 'b'])
    scene.remove(a); clearCharacterObject('a')
    const gizmo = __getObjectGizmoForTest()
    expect(gizmo.object).toBe(b)
  })

  it('resync drops a selected root that was taken out of the scene without being unregistered', () => {
    const { scene, add } = setup()
    const a = add('a', 2)
    setObjectsEnabled(true)
    selectObject('a')
    expect(__getObjectGizmoForTest().object).toBe(a)
    scene.remove(a)
    resyncObjectGizmo()
    expect(isObjectGizmoAttached()).toBe(false)
  })

  it('switching into Object mode attaches the live selection and switching out detaches', () => {
    const { add } = setup()
    const a = add('a', 2)
    setObjectsEnabled(false)
    selectObject('a')
    expect(isObjectGizmoAttached()).toBe(false)
    setObjectsEnabled(true)
    expect(__getObjectGizmoForTest().object).toBe(a)
    setObjectsEnabled(false)
    expect(isObjectGizmoAttached()).toBe(false)
  })
})
