import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { initObjects, addObject, selectObject, selectObjects, getObjectRoots, disposeObjects, snapshotObject } from '../three/objects.js'

// objects.js drives group move/rotate/resize (selectObjects -> pivot ->
// applyPivotDelta) with: delta = pivot.matrix * inverse(pivotStartMatrix),
// then each object's new matrix = delta * thatObject'sStartMatrix. That's
// plain linear algebra and doesn't need a real TransformControls drag (which
// needs a WebGL canvas) to verify — these tests check the math directly,
// plus that selectObjects()/undo() behave sanely at the public-API level.

function makeBoxRoot() {
  const geo = new THREE.BoxGeometry(1, 1, 1)
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial())
  const root = new THREE.Group()
  root.add(mesh)
  return root
}

describe('group delta math (pivot drag -> per-object transform)', () => {
  it('a pure translation of the pivot translates every object by the same offset', () => {
    const startA = new THREE.Matrix4().compose(
      new THREE.Vector3(1, 0, 0),
      new THREE.Quaternion(),
      new THREE.Vector3(1, 1, 1),
    )
    const startB = new THREE.Matrix4().compose(
      new THREE.Vector3(-2, 0, 3),
      new THREE.Quaternion(),
      new THREE.Vector3(1, 1, 1),
    )
    const pivotStart = new THREE.Matrix4().compose(
      new THREE.Vector3(-0.5, 0, 1.5), // centroid of A and B
      new THREE.Quaternion(),
      new THREE.Vector3(1, 1, 1),
    )
    const pivotNow = pivotStart.clone().multiply(new THREE.Matrix4().makeTranslation(5, 2, -1))

    const delta = pivotNow.clone().multiply(pivotStart.clone().invert())
    const newA = delta.clone().multiply(startA)
    const newB = delta.clone().multiply(startB)

    const posA = new THREE.Vector3().setFromMatrixPosition(newA)
    const posB = new THREE.Vector3().setFromMatrixPosition(newB)

    expect(posA.x).toBeCloseTo(1 + 5)
    expect(posA.y).toBeCloseTo(0 + 2)
    expect(posA.z).toBeCloseTo(0 - 1)
    expect(posB.x).toBeCloseTo(-2 + 5)
    expect(posB.y).toBeCloseTo(0 + 2)
    expect(posB.z).toBeCloseTo(3 - 1)

    // Relative offset between the two objects must be unchanged by a pure
    // group translation.
    const relBefore = startB.clone().multiply(startA.clone().invert())
    const relAfter = newB.clone().multiply(newA.clone().invert())
    expect(new THREE.Vector3().setFromMatrixPosition(relAfter).distanceTo(new THREE.Vector3().setFromMatrixPosition(relBefore))).toBeCloseTo(0)
  })

  it('rotating the pivot spins objects around the group centroid, not their own origins', () => {
    const startA = new THREE.Matrix4().compose(new THREE.Vector3(1, 0, 0), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1))
    const pivotStart = new THREE.Matrix4().compose(new THREE.Vector3(0, 0, 0), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1))
    const quarterTurnY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    const pivotNow = new THREE.Matrix4().compose(new THREE.Vector3(0, 0, 0), quarterTurnY, new THREE.Vector3(1, 1, 1))

    const delta = pivotNow.clone().multiply(pivotStart.clone().invert())
    const newA = delta.clone().multiply(startA)
    const posA = new THREE.Vector3().setFromMatrixPosition(newA)

    // A 90° turn around Y takes (1,0,0) to roughly (0,0,-1) — i.e. it orbits
    // the pivot rather than spinning in place.
    expect(posA.x).toBeCloseTo(0, 5)
    expect(posA.z).toBeCloseTo(-1, 5)
  })
})

describe('selectObjects public API', () => {
  let idA, idB

  function setup() {
    disposeObjects()
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()
    const renderer = { domElement: document.createElement('canvas') }
    const controls = { enabled: true, locked: false }
    initObjects({ scene, camera, renderer, controls, requestRender: () => {} })
    idA = addObject({ root: makeBoxRoot() }, 'A', 'glb', null).id
    idB = addObject({ root: makeBoxRoot() }, 'B', 'glb', null).id
  }

  it('does not throw for 0, 1, or several ids, including duplicates and unknown ids', () => {
    setup()
    expect(() => selectObjects([])).not.toThrow()
    expect(() => selectObjects([idA])).not.toThrow()
    expect(() => selectObjects([idA, idB])).not.toThrow()
    expect(() => selectObjects([idA, idA, idB])).not.toThrow()
    expect(() => selectObjects([idA, 999999])).not.toThrow()
    expect(() => selectObjects(null)).not.toThrow()
  })

  it('falling back from multi to single selection still leaves a normal, working single selection', () => {
    setup()
    selectObjects([idA, idB])
    selectObject(idA)
    expect(() => snapshotObject(idA)).not.toThrow()
    expect(snapshotObject(idA)).not.toBeNull()
  })

  it('getObjectRoots reports one Object3D per added prop', () => {
    setup()
    expect(getObjectRoots().length).toBe(2)
  })
})