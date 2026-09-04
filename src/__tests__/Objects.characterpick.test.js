import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  initObjects,
  setCharacterObject,
  pickObjectId,
  selectObject,
  setObjectsEnabled,
  isObjectGizmoAttached,
} from '../three/objects.js'

// Regression tests for two Object-mode bugs:
//  1) Clicking the character itself did nothing — pickObjectId() only ever
//     raycast o.objects (props/images), deliberately skipping characterRoots
//     (a leftover from when characters were only posed via Bone mode).
//  2) The Move/Rotate/Resize gizmo stayed attached/visible after switching
//     away from Object mode until the next click in the new mode, because
//     nothing ever told TransformControls to detach on a mode change.

function makeRefs() {
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  const dom = document.createElement('canvas')
  dom.setPointerCapture = () => {}
  dom.releasePointerCapture = () => {}
  const renderer = { domElement: dom }
  const controls = { enabled: true, locked: false }
  return { scene, camera, renderer, controls, requestRender: () => {} }
}

describe('Object mode: clicking the character selects it', () => {
  it('pickObjectId() hits a registered character root, not just props', () => {
    const refs = makeRefs()
    initObjects(refs)

    const charRoot = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 2),
      new THREE.MeshStandardMaterial(),
    )
    refs.scene.add(charRoot)
    charRoot.updateMatrixWorld(true)
    setCharacterObject('char-1', charRoot, 'TestChar')

    // Camera looks down -Z at the origin; the 2x2x2 box sits there too, so
    // dead-centre NDC (0, 0) must hit it.
    const id = pickObjectId(0, 0)
    expect(id).toBe('char-1')
  })
})

describe('Object mode: gizmo does not linger after switching modes', () => {
  it('setObjectsEnabled(false) detaches the gizmo even though something stays selected', () => {
    const refs = makeRefs()
    initObjects(refs)

    const charRoot = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
    refs.scene.add(charRoot)
    setCharacterObject('char-2', charRoot, 'TestChar2')

    selectObject('char-2')
    expect(isObjectGizmoAttached()).toBe(true)

    // Leaving Object mode (e.g. switching to View/Pose/Mesh) must detach the
    // gizmo right away, not leave it on screen until the next click.
    setObjectsEnabled(false)
    expect(isObjectGizmoAttached()).toBe(false)

    // Re-entering Object mode should bring the gizmo back to the same
    // selection without needing to click again.
    setObjectsEnabled(true)
    expect(isObjectGizmoAttached()).toBe(true)
  })
})