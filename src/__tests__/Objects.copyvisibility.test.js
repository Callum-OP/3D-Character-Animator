import { beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  addObject,
  getObjectRootById,
  initObjects,
  setCharacterObject,
  setObjectVisible,
} from '../three/objects.js'
import { useStore } from '../store.js'
import { copyCurrentEdit, pasteCurrentEdit, toggleCurrentVisibility } from '../three/editClipboard.js'
import { performUndo, performRedo } from '../three/undoPriority.js'

describe('object clipboard and visibility history', () => {
  let objectId
  let sourceRoot

  beforeAll(() => {
    const scene = new THREE.Scene()
    initObjects({
      scene,
      camera: new THREE.PerspectiveCamera(),
      renderer: { domElement: document.createElement('canvas') },
      controls: { enabled: true, locked: false },
      requestRender: () => {},
    })
    sourceRoot = new THREE.Group()
    sourceRoot.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()))
    objectId = addObject({ root: sourceRoot }, 'TestProp', 'glb', null).id
  })

  it('copies and pastes an independent object with an offset', () => {
    useStore.setState({
      mode: 'object',
      selectedObjectId: objectId,
      sceneObjects: [{ id: objectId, name: 'TestProp', visible: true }],
    })
    expect(copyCurrentEdit()).toBe('object')
    const pasted = pasteCurrentEdit().result
    const pastedRoot = getObjectRootById(pasted.id)
    const sourceMesh = sourceRoot.children[0]
    const pastedMesh = pastedRoot.children[0]
    expect(pasted.name).toBe('TestProp Copy')
    expect(pastedRoot.position.x).toBeCloseTo(0.25)
    expect(pastedMesh.geometry).not.toBe(sourceMesh.geometry)
    expect(pastedMesh.material).not.toBe(sourceMesh.material)
  })

  it('undoes and redoes object visibility', () => {
    setObjectVisible(objectId, false)
    expect(getObjectRootById(objectId).visible).toBe(false)
    performUndo(useStore.getState())
    expect(getObjectRootById(objectId).visible).toBe(true)
    performRedo(useStore.getState())
    expect(getObjectRootById(objectId).visible).toBe(false)
  })

  it('H toggles visibility for props and characters in Object mode', () => {
    const characterRoot = new THREE.Group()
    setCharacterObject('character-test', characterRoot, 'Character')
    useStore.setState({
      mode: 'object',
      selectedObjectId: 'character-test',
      sceneObjects: [{ id: 'character-test', name: 'Character', isCharacter: true, visible: true }],
    })
    expect(toggleCurrentVisibility().visible).toBe(false)
    expect(characterRoot.visible).toBe(false)
    performUndo(useStore.getState())
    expect(characterRoot.visible).toBe(true)

    useStore.setState({
      mode: 'object',
      selectedObjectId: objectId,
      sceneObjects: [{ id: objectId, name: 'TestProp', visible: true }],
    })
    expect(toggleCurrentVisibility().visible).toBe(false)
    expect(getObjectRootById(objectId).visible).toBe(false)
  })
})