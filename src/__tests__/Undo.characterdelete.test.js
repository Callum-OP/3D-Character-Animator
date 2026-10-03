import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects } from '../three/objects.js'
import {
  __seedCharacterForTest,
  removeObjectById,
  removeCharacter,
  clearProjectScene,
} from '../three/scene.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

const scene = new THREE.Scene()
const ctx = () => ({ selectedObjectId: null, mode: 'bone' })
const undo = () => performUndo(ctx())
const redo = () => performRedo(ctx())

function makeParsed(name) {
  const geo = new THREE.BoxGeometry(1, 1, 1)
  const root = new THREE.Group()
  root.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()))
  return { geo, root, meshes: [], bones: [], info: { name, clipNames: [], bones: [], meshCount: 1, boneCount: 0 } }
}

function seed(id, name) {
  const parsed = makeParsed(name)
  __seedCharacterForTest(id, parsed, scene)
  return parsed
}

const chars = () => useStore.getState().sceneObjects.filter((o) => o.isCharacter).map((o) => o.id)

beforeEach(() => {
  initObjects({
    scene,
    camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: document.createElement('canvas') },
    controls: { enabled: true, locked: false },
    requestRender: () => {},
  })
  clearProjectScene()
  clearUndoHistory()
})

describe('deleting a character is undoable', () => {
  it('removes it everywhere, then Undo brings it back and Redo removes it again', () => {
    const a = seed('c1', 'One')
    const b = seed('c2', 'Two')
    useStore.getState().setSelectedObjectId?.('c2')

    removeObjectById('c2') // the x in the Scene / Objects panel
    let s = useStore.getState()
    expect(chars()).toEqual(['c1'])
    expect(s.characterOrder).toEqual(['c1'])
    expect(s.activeCharacterId).toBe('c1')
    expect(scene.children).not.toContain(b.root)

    undo()
    s = useStore.getState()
    expect(chars().sort()).toEqual(['c1', 'c2'])
    expect(s.characterOrder).toEqual(['c1', 'c2'])
    expect(s.activeCharacterId).toBe('c2')
    expect(s.selectedObjectId).toBe('c2')
    expect(scene.children).toContain(b.root)
    expect(scene.children).toContain(a.root)

    redo()
    s = useStore.getState()
    expect(chars()).toEqual(['c1'])
    expect(scene.children).not.toContain(b.root)
  })

  it('restores the character\'s own keyframes and name, and the roster order', () => {
    seed('c1', 'One')
    seed('c2', 'Two')
    useStore.getState().setActiveCharacterId('c1')
    useStore.getState().addKeyframe('Hips', 0.5, [0, 0, 0, 1])
    clearUndoHistory()

    removeCharacter('c1')
    expect(useStore.getState().characterOrder).toEqual(['c2'])
    expect(useStore.getState().animData.tracks.Hips).toBeUndefined()

    undo()
    const s = useStore.getState()
    expect(s.characterOrder).toEqual(['c1', 'c2'])
    expect(s.activeCharacterId).toBe('c1')
    expect(s.modelInfo.name).toBe('One')
    expect(s.animData.tracks.Hips).toHaveLength(1)
  })

  it('works for the only character too (leaves no ghost, restores fully)', () => {
    const only = seed('solo', 'Solo')
    removeCharacter('solo')
    let s = useStore.getState()
    expect(s.modelInfo).toBeNull()
    expect(chars()).toEqual([])
    expect(s.activeCharacterId).toBeNull()

    undo()
    s = useStore.getState()
    expect(chars()).toEqual(['solo'])
    expect(s.modelInfo.name).toBe('Solo')
    expect(scene.children).toContain(only.root)
  })

  it('keeps geometry alive while undoable and frees it once the delete drops out of history', () => {
    seed('c1', 'One')
    const doomed = seed('c2', 'Two')
    const disposed = vi.fn()
    doomed.geo.addEventListener('dispose', disposed)

    removeCharacter('c2')
    expect(disposed).not.toHaveBeenCalled()

    clearUndoHistory()
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('a hard remove (no history) frees it immediately and leaves nothing to undo', () => {
    seed('c1', 'One')
    const gone = seed('c2', 'Two')
    const disposed = vi.fn()
    gone.geo.addEventListener('dispose', disposed)

    removeCharacter('c2', false)
    expect(disposed).toHaveBeenCalled()
    undo()
    expect(chars()).toEqual(['c1'])
  })
})
