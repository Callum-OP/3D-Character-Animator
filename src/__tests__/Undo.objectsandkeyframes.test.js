import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects, addObject } from '../three/objects.js'
import { removeObjectById, copyObjectById, pasteCopiedObject, clearProjectScene } from '../three/scene.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

let scene

function addProp(name = 'Prop') {
  const geo = new THREE.BoxGeometry(1, 1, 1)
  const root = new THREE.Group()
  root.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()))
  const meta = addObject({ root }, name, 'glb', null)
  useStore.getState().addSceneObject(meta)
  return { meta, root, geo }
}

const ctx = () => ({ selectedObjectId: null, mode: 'bone' })
const undo = () => performUndo(ctx())
const redo = () => performRedo(ctx())
const props = () => useStore.getState().sceneObjects.filter((o) => !o.isCharacter)

beforeAll(() => {
  scene = new THREE.Scene()
  initObjects({
    scene,
    camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: document.createElement('canvas') },
    controls: { enabled: true, locked: false },
    requestRender: () => {},
  })
})

beforeEach(() => {
  clearProjectScene()
  clearUndoHistory()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('undo/redo of deleting objects', () => {
  it('brings a deleted object back at the same list position, then removes it again on redo', () => {
    const a = addProp('A')
    const b = addProp('B')
    const c = addProp('C')

    removeObjectById(b.meta.id)
    expect(props().map((o) => o.name)).toEqual(['A', 'C'])
    expect(scene.children).not.toContain(b.root)

    undo()
    expect(props().map((o) => o.name)).toEqual(['A', 'B', 'C'])
    expect(scene.children).toContain(b.root)
    expect(useStore.getState().selectedObjectId).toBe(b.meta.id)

    redo()
    expect(props().map((o) => o.name)).toEqual(['A', 'C'])
    expect(scene.children).not.toContain(b.root)
    expect(a.root.parent).toBe(scene)
    expect(c.root.parent).toBe(scene)
  })

  it('keeps the geometry alive while the delete can still be undone, and frees it once it cannot', () => {
    const p = addProp('Doomed')
    const disposed = vi.fn()
    p.geo.addEventListener('dispose', disposed)

    removeObjectById(p.meta.id)
    expect(disposed).not.toHaveBeenCalled() // still undoable

    clearUndoHistory() // e.g. New Project / history overwritten
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('restores the object\'s motion keys along with it', () => {
    const p = addProp('Animated')
    const key = p.meta.animationKey
    useStore.getState().addObjectTransformKeyframe(key, 0, {
      position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
    })
    clearUndoHistory() // the key itself isn't what's under test here

    removeObjectById(p.meta.id)
    expect(useStore.getState().objectAnimData[key]).toBeUndefined()
    undo()
    expect(useStore.getState().objectAnimData[key]).toHaveLength(1)
  })
})

describe('undo/redo of adding objects', () => {
  it('undoes and redoes a pasted copy', () => {
    const src = addProp('Source')
    copyObjectById(src.meta.id)
    const copy = pasteCopiedObject()
    expect(props()).toHaveLength(2)

    undo()
    expect(props().map((o) => o.name)).toEqual(['Source'])

    redo()
    expect(props()).toHaveLength(2)
    expect(props().some((o) => o.id === copy.id)).toBe(true)
  })
})

describe('undo/redo of keyframes', () => {
  const quat = [0, 0, 0, 1]
  const tracks = () => useStore.getState().animData.tracks

  it('undoes and redoes adding and deleting a joint key', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    useStore.getState().addKeyframe('Hips', 0.5, quat)
    expect(tracks().Hips).toHaveLength(1)

    vi.setSystemTime(5_000) // a separate gesture, not coalesced
    useStore.getState().deleteKeyframe('Hips', 0.5)
    expect(tracks().Hips).toBeUndefined()

    undo() // un-delete
    expect(tracks().Hips).toHaveLength(1)
    undo() // un-add
    expect(tracks().Hips).toBeUndefined()

    redo()
    expect(tracks().Hips).toHaveLength(1)
    redo()
    expect(tracks().Hips).toBeUndefined()
  })

  it('merges a rapid burst of edits into one undo step', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    useStore.getState().addKeyframe('Hips', 0.5, quat)
    vi.setSystemTime(1_100)
    useStore.getState().addKeyframe('Hips', 1, quat)
    expect(tracks().Hips).toHaveLength(2)

    undo()
    expect(tracks().Hips).toBeUndefined()
  })

  it('undoes object motion keys', () => {
    const p = addProp('Mover')
    clearUndoHistory()
    const key = p.meta.animationKey
    useStore.getState().addObjectTransformKeyframe(key, 0, {
      position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
    })
    expect(useStore.getState().objectAnimData[key]).toHaveLength(1)
    undo()
    expect(useStore.getState().objectAnimData[key]).toBeUndefined()
    redo()
    expect(useStore.getState().objectAnimData[key]).toHaveLength(1)
  })

  it('interleaves with object add/delete in the order they happened', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const src = addProp('Source')
    copyObjectById(src.meta.id)
    clearUndoHistory()
    vi.setSystemTime(2_000)
    const copy = pasteCopiedObject() // recorded add
    vi.setSystemTime(5_000)
    useStore.getState().addKeyframe('Hips', 0.5, quat)

    undo() // newest first: the key
    expect(tracks().Hips).toBeUndefined()
    expect(props()).toHaveLength(2)
    undo() // then the add
    expect(props().map((o) => o.name)).toEqual(['Source'])
    expect(scene.children.some((c) => c.uuid === copy.id)).toBe(false)
    redo() // add comes back first
    expect(props()).toHaveLength(2)
    redo() // then the key
    expect(tracks().Hips).toHaveLength(1)
  })

  it('is not recorded when the active character changes', () => {
    useStore.getState().addCharacter('c1', { name: 'One', clipNames: [], bones: [] })
    clearUndoHistory()
    useStore.getState().addCharacter('c2', { name: 'Two', clipNames: [], bones: [] })
    undo() // nothing to undo — must not wipe or resurrect a timeline
    expect(useStore.getState().characterOrder).toEqual(['c1', 'c2'])
  })
})
