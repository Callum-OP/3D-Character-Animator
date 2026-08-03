import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import {
  initObjects,
  addObject,
  selectObject,
  setSelectedUniformScale,
  snapshotObject,
  commitUniformScale,
  getSelectedUniformScale,
  undo,
} from '../three/objects.js'

// objects.js caps its undo stack at 100 entries (UNDO_LIMIT) so a long
// session doesn't grow the history forever. This can't be observed directly
// (the stack isn't exported), but its effect can: after more than 100
// distinct edits, undoing more than 100 times must stop having any further
// effect — the oldest edits should have fallen off the front.
describe('object undo stack is capped, not unbounded', () => {
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
    const meta = addObject({ root }, 'CapProp', 'glb', null)
    objId = meta.id
    selectObject(objId)
  })

  it('drops the oldest history once past the cap', () => {
    const EDITS = 110 // comfortably over the 100-entry UNDO_LIMIT
    setSelectedUniformScale(objId, 1)

    // Each edit i sets scale to i+2 (values 2..111), one undo step apiece.
    for (let i = 0; i < EDITS; i++) {
      const before = snapshotObject(objId)
      setSelectedUniformScale(objId, i + 2)
      commitUniformScale(objId, before)
    }
    expect(getSelectedUniformScale(objId)).toBeCloseTo(EDITS + 1)

    // Undo everything the stack can hold (comfortably more than the cap).
    for (let i = 0; i < EDITS; i++) undo()

    // If the stack were unbounded we'd be back at the very first value (1).
    // Because it's capped at 100, the oldest ~10 edits were discarded, so we
    // bottom out higher than 1 instead.
    const finalValue = getSelectedUniformScale(objId)
    expect(finalValue).toBeGreaterThan(1)

    // One more undo (well past the stack's contents) must be a safe no-op,
    // not throw or misbehave.
    expect(() => undo()).not.toThrow()
    expect(getSelectedUniformScale(objId)).toBeCloseTo(finalValue)
  })
})