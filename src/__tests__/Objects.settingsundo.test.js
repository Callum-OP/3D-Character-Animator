import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects, addObject, removeObject } from '../three/objects.js'
import { setObjectStyleById, setObjectOutlineById, setObjectCastShadowById } from '../three/scene.js'
import { setPartLook } from '../three/materialHistory.js'
import { applyMaterials, recordOriginalMaterials } from '../three/materials.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

let scene
beforeAll(() => {
  scene = new THREE.Scene()
  initObjects({
    scene,
    camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: document.createElement('canvas') },
    controls: { enabled: true, locked: false },
    requestRender: () => {},
    getSceneScale: () => 2,
  })
})

beforeEach(() => {
  for (const o of [...useStore.getState().sceneObjects]) removeObject(o.id)
  clearUndoHistory()
  useStore.setState({ sceneObjects: [], meshOverrides: {}, characters: {}, activeCharacterId: 1, selectedObjectId: null, selectedObjectIds: [], mode: 'object' })
})

function makeProp() {
  const root = new THREE.Group()
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()))
  const meta = addObject({ root }, 'Box', 'glb', null)
  useStore.getState().addSceneObject(meta)
  return meta
}
const row = (id) => useStore.getState().sceneObjects.find((o) => o.id === id)

describe('object settings are undoable', () => {
  it('style', () => {
    const p = makeProp()
    setObjectStyleById(p.id, 'toon')
    expect(row(p.id).style).toBe('toon')
    performUndo(useStore.getState())
    expect(row(p.id).style).toBe('auto')
    performRedo(useStore.getState())
    expect(row(p.id).style).toBe('toon')
  })

  it('ink outline (including back to "follow the style")', () => {
    const p = makeProp()
    setObjectOutlineById(p.id, false)
    expect(row(p.id).outline).toBe(false)
    performUndo(useStore.getState())
    expect(row(p.id).outline ?? null).toBe(null)
    performRedo(useStore.getState())
    expect(row(p.id).outline).toBe(false)
  })

  it('casts shadows', () => {
    const p = makeProp()
    setObjectCastShadowById(p.id, false)
    expect(row(p.id).castShadow).toBe(false)
    performUndo(useStore.getState())
    expect(row(p.id).castShadow).not.toBe(false)
    performRedo(useStore.getState())
    expect(row(p.id).castShadow).toBe(false)
  })

  it('restoring without recording adds no history', () => {
    const p = makeProp()
    setObjectStyleById(p.id, 'toon', false)
    performUndo(useStore.getState())
    expect(row(p.id).style).toBe('toon')
  })
})

describe('per-part look settings', () => {
  it('stores transparency / outline / cast shadow per part, one undo step each', () => {
    setPartLook(['a', 'b'], { alpha: false })
    expect(useStore.getState().meshOverrides.a.alpha).toBe(false)
    expect(useStore.getState().meshOverrides.b.alpha).toBe(false)
    setPartLook(['a'], { castShadow: false })
    expect(useStore.getState().meshOverrides.a.castShadow).toBe(false)
    expect(useStore.getState().meshOverrides.b.castShadow).toBeUndefined()
    performUndo(useStore.getState())
    expect(useStore.getState().meshOverrides.a.castShadow).toBeUndefined()
    expect(useStore.getState().meshOverrides.a.alpha).toBe(false)
    performUndo(useStore.getState())
    expect(useStore.getState().meshOverrides.a).toBeUndefined()
    performRedo(useStore.getState())
    expect(useStore.getState().meshOverrides.a.alpha).toBe(false)
  })

  it('a part of a character that is not active is undone in that character', () => {
    useStore.setState({ characters: { 2: { meshOverrides: {} } } })
    setPartLook(['x'], { alpha: false }, 2)
    expect(useStore.getState().characters[2].meshOverrides.x.alpha).toBe(false)
    expect(useStore.getState().meshOverrides.x).toBeUndefined()
    performUndo(useStore.getState())
    expect(useStore.getState().characters[2].meshOverrides.x).toBeUndefined()
  })

  it('turning off one part\'s transparency leaves another part\'s alone', () => {
    const mk = (opacity) => {
      const mat = new THREE.MeshStandardMaterial({ transparent: true, opacity })
      return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat)
    }
    const a = mk(0.5)
    const b = mk(0.5)
    const model = { meshes: [a, b] }
    recordOriginalMaterials(model)
    const overrides = { [a.uuid]: { alpha: false } }
    applyMaterials(model, { mode: 'standard', overrides })
    expect(a.material.transparent).toBe(false)
    expect(b.material.transparent).toBe(true)
  })

  it('a part switched off casts no shadow, and the object switch still wins', () => {
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
    const model = { meshes: [a, b] }
    recordOriginalMaterials(model)
    applyMaterials(model, { mode: 'standard', overrides: { [a.uuid]: { castShadow: false } } })
    expect(a.castShadow).toBe(false)
    expect(b.castShadow).toBe(true)
    b.userData.objectNoCast = true
    applyMaterials(model, { mode: 'standard', overrides: {} })
    expect(a.castShadow).toBe(true)
    expect(b.castShadow).toBe(false)
  })
})
