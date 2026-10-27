import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects, addObject, removeObject, getObjectsForSave } from '../three/objects.js'
import { recordOriginalMaterials, applyMaterials, syncMeshMaterialFlags, updateRimLightMaterials } from '../three/materials.js'
import { stripAppMaterialData } from '../three/materialUserData.js'
import { setObjectRimImmuneById, copyObjectById, pasteCopiedObject, countBumpMappedMaterials } from '../three/scene.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

const rim = (soft = 0.8, hard = 0.6) => ({
  color: '#ffffff', direction: new THREE.Vector3(0.3, 0.6, 0.7), sideOnly: false,
  soft: { enabled: true, intensity: soft, width: 0.5 }, hard: { enabled: true, intensity: hard, width: 0.3 },
})

function toonModel() {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x884422 }))
  const model = { meshes: [mesh] }
  recordOriginalMaterials(model)
  return { model, mesh }
}
const u = (mesh) => mesh.material.userData

describe('ignore rim lighting — materials', () => {
  it('a normal object gets the rim light; an ignoring one gets none, and it can be switched back', () => {
    const { model, mesh } = toonModel()
    applyMaterials(model, { mode: 'toon', rimLight: rim() })
    expect(u(mesh).rimSoftIntensity).toBe(0.8)
    expect(u(mesh).rimHardIntensity).toBe(0.6)

    mesh.userData.rimImmune = true
    syncMeshMaterialFlags([mesh])
    expect(u(mesh).rimSoftIntensity).toBe(0)
    expect(u(mesh).rimHardIntensity).toBe(0)

    delete mesh.userData.rimImmune
    syncMeshMaterialFlags([mesh])
    expect(u(mesh).rimSoftIntensity).toBe(0.8) // exactly what was asked for before
    expect(u(mesh).rimHardIntensity).toBe(0.6)
  })

  it('updates the live shader values too, so nothing recompiles', () => {
    const { model, mesh } = toonModel()
    applyMaterials(model, { mode: 'toon', rimLight: rim() })
    const live = { rimSoftIntensity: { value: 0.8 }, rimHardIntensity: { value: 0.6 } }
    u(mesh).rimUniforms = { ...u(mesh).rimUniforms, ...live }
    mesh.userData.rimImmune = true
    syncMeshMaterialFlags([mesh])
    expect(live.rimSoftIntensity.value).toBe(0)
    expect(live.rimHardIntensity.value).toBe(0)
  })

  it('stays ignored when the style is re-applied or a followed light moves', () => {
    const { model, mesh } = toonModel()
    mesh.userData.rimImmune = true
    applyMaterials(model, { mode: 'toon', rimLight: rim() })
    expect(u(mesh).rimSoftIntensity).toBe(0)
    updateRimLightMaterials(model, rim(0.9, 0.9))
    expect(u(mesh).rimSoftIntensity).toBe(0)
    expect(u(mesh).rimHardIntensity).toBe(0)
    delete mesh.userData.rimImmune
    applyMaterials(model, { mode: 'toon', rimLight: rim(0.9, 0.9) })
    expect(u(mesh).rimSoftIntensity).toBe(0.9)
  })

  it('works in Soft Anime too, and leaves other objects alone', () => {
    const a = toonModel()
    const b = toonModel()
    a.mesh.userData.rimImmune = true
    applyMaterials(a.model, { mode: 'soft', rimLight: rim() })
    applyMaterials(b.model, { mode: 'soft', rimLight: rim() })
    expect(u(a.mesh).rimSoftIntensity).toBe(0)
    expect(u(b.mesh).rimSoftIntensity).toBe(0.8)
  })

  it('the app\'s own material flags never leak into clones or exports', () => {
    const m = new THREE.MeshStandardMaterial()
    m.userData = { rimImmune: true, rimSoftRequested: 1, rimHardRequested: 1, texLookUniforms: { tlA: {} }, keep: 'me' }
    stripAppMaterialData(m)
    expect(m.userData).toEqual({ keep: 'me' })
  })
})

describe('ignore rim lighting — the object', () => {
  let scene
  beforeAll(() => {
    scene = new THREE.Scene()
    initObjects({
      scene, camera: new THREE.PerspectiveCamera(), renderer: { domElement: document.createElement('canvas') },
      controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 2,
    })
  })
  beforeEach(() => {
    for (const o of [...useStore.getState().sceneObjects]) removeObject(o.id)
    clearUndoHistory()
    useStore.setState({ sceneObjects: [], selectedObjectId: null, selectedObjectIds: [], meshOverrides: {} })
  })
  function prop(name, file = null) {
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()))
    const meta = addObject({ root }, name, 'glb', file)
    useStore.getState().addSceneObject(meta)
    return { id: meta.id, root }
  }
  const row = (id) => useStore.getState().sceneObjects.find((o) => o.id === id)

  it('sets the flag on the object and in the list, and undo / redo move it', () => {
    const p = prop('Rock')
    setObjectRimImmuneById(p.id, true)
    expect(row(p.id).rimImmune).toBe(true)
    let flagged = false
    p.root.traverse((o) => { if (o.isMesh && o.userData.rimImmune) flagged = true })
    expect(flagged).toBe(true)

    performUndo(useStore.getState())
    expect(row(p.id).rimImmune).toBe(false)
    performRedo(useStore.getState())
    expect(row(p.id).rimImmune).toBe(true)
  })

  it('is saved with the project', () => {
    const a = prop('A', new File(['x'], 'a.glb'))
    const b = prop('B', new File(['x'], 'b.glb'))
    setObjectRimImmuneById(a.id, true)
    const saved = getObjectsForSave()
    expect(saved.find((r) => r.name === 'A').rimImmune).toBe(true)
    expect(saved.find((r) => r.name === 'B').rimImmune).toBeUndefined()
  })

  it('a copy keeps it, and the list shows it', () => {
    const a = prop('A')
    setObjectRimImmuneById(a.id, true)
    copyObjectById(a.id)
    const pasted = pasteCopiedObject()
    expect(row(pasted.id).rimImmune).toBe(true)
  })
})

describe('counting the bump maps in the scene (what Flatten has to act on)', () => {
  let scene
  beforeAll(() => {
    scene = new THREE.Scene()
    initObjects({
      scene, camera: new THREE.PerspectiveCamera(), renderer: { domElement: document.createElement('canvas') },
      controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 2,
    })
  })
  beforeEach(() => {
    for (const o of [...useStore.getState().sceneObjects]) removeObject(o.id)
    useStore.setState({ sceneObjects: [] })
  })
  function add(name, materialProps) {
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(materialProps)))
    const meta = addObject({ root }, name, 'glb', null)
    useStore.getState().addSceneObject(meta)
  }
  it('is zero when no model has a normal or bump map, and counts the ones that do', () => {
    expect(countBumpMappedMaterials()).toBe(0)
    add('Plain', { color: 0xff0000 })
    expect(countBumpMappedMaterials()).toBe(0)
    add('Bumpy', { normalMap: new THREE.Texture() })
    expect(countBumpMappedMaterials()).toBe(1)
    add('Bumpier', { bumpMap: new THREE.Texture() })
    expect(countBumpMappedMaterials()).toBe(2)
  })
})
