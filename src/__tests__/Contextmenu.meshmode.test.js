import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = {
  visible: vi.fn(), visibleMany: vi.fn(), frame: vi.fn(), reset: vi.fn(), resetMany: vi.fn(),
  extract: vi.fn(async () => ({ ok: true, message: 'Extracted it.' })),
  merge: vi.fn(async () => ({ ok: true, message: 'Merged them.' })),
}
vi.mock('../three/scene.js', async (importOriginal) => ({
  ...(await importOriginal()),
  setMeshVisibleByUuid: (...a) => calls.visible(...a),
  setMeshesVisibleByUuids: (...a) => calls.visibleMany(...a),
  setCameraToMesh: (...a) => calls.frame(...a),
  extractPartsToObject: (...a) => calls.extract(...a),
  mergeObjectsToOne: (...a) => calls.merge(...a),
}))
vi.mock('../three/meshedit.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resetMesh: (...a) => calls.reset(...a),
  resetMeshes: (...a) => calls.resetMany(...a),
}))

import { resolveContextTarget, selectContextTarget, getContextMenuItems, runContextMenuAction } from '../three/contextMenu.js'
import { useStore } from '../store.js'

const labels = (items) => items.filter((i) => !i.separator).map((i) => i.label)

beforeEach(() => {
  Object.values(calls).forEach((f) => f.mockClear())
  useStore.setState({
    mode: 'mesh', meshOverrides: {}, selectedMeshUuid: null, selectedMeshUuids: [],
    sceneObjects: [], selectedObjectId: null, selectedObjectIds: [],
  })
})

describe('right-click in Mesh mode', () => {
  it('targets the part under the cursor, or the whole multi-selection when it is in it', () => {
    const api = { pickMeshUuid: () => 'b' }
    expect(resolveContextTarget(0, 0, { mode: 'mesh', selectedMeshUuids: [] }, api)).toEqual({ kind: 'meshes', uuids: ['b'] })
    expect(resolveContextTarget(0, 0, { mode: 'mesh', selectedMeshUuids: ['a', 'b'] }, api)).toEqual({ kind: 'meshes', uuids: ['a', 'b'] })
    expect(resolveContextTarget(0, 0, { mode: 'mesh', selectedMeshUuids: ['a', 'c'] }, api)).toEqual({ kind: 'meshes', uuids: ['b'] })
    expect(resolveContextTarget(0, 0, { mode: 'mesh', selectedMeshUuids: [] }, { pickMeshUuid: () => null })).toEqual({ kind: 'empty' })
  })

  it('selects the right-clicked part (but keeps a multi-selection it belongs to)', () => {
    selectContextTarget({ kind: 'meshes', uuids: ['b'] })
    expect(useStore.getState().selectedMeshUuid).toBe('b')
    useStore.setState({ selectedMeshUuid: 'a', selectedMeshUuids: ['a', 'b'] })
    selectContextTarget({ kind: 'meshes', uuids: ['a', 'b'] })
    expect(useStore.getState().selectedMeshUuids).toEqual(['a', 'b'])
  })

  it('offers copy, paste, hide, the part look switches, reset, frame and the make-an-object options', () => {
    const items = getContextMenuItems({ kind: 'meshes', uuids: ['a'] })
    expect(labels(items)).toEqual(['Copy', 'Paste', 'Hide', 'Ink outline', 'Casts shadows', 'Reset part', 'Frame in viewport', 'Extract to object', 'Copy to object'])
  })

  it('the part switches (ink outline, casts shadows) change just that part, and undo', async () => {
    const { performUndo } = await import('../three/undoPriority.js')
    runContextMenuAction('cast', { kind: 'meshes', uuids: ['a'] })
    expect(useStore.getState().meshOverrides.a.castShadow).toBe(false)
    runContextMenuAction('outline', { kind: 'meshes', uuids: ['a', 'b'] })
    expect(useStore.getState().meshOverrides.b.outline).toBe(false)
    performUndo(useStore.getState())
    expect(useStore.getState().meshOverrides.b?.outline).not.toBe(false)
    expect(useStore.getState().meshOverrides.a.castShadow).toBe(false)
  })

  it('says Show for a hidden part, and speaks for the whole group when several are selected', () => {
    useStore.setState({ meshOverrides: { a: { visible: false } } })
    expect(labels(getContextMenuItems({ kind: 'meshes', uuids: ['a'] }))).toContain('Show')
    const many = labels(getContextMenuItems({ kind: 'meshes', uuids: ['a', 'b', 'c'] }))
    expect(many).toContain('Reset 3 parts')
    expect(many).not.toContain('Frame in viewport')
  })

  it('Hide / Show, Reset and Frame act on the chosen parts', () => {
    const one = { kind: 'meshes', uuids: ['a'] }
    runContextMenuAction('visibility', one) // it is showing, so this hides it
    expect(calls.visible).toHaveBeenCalledWith('a', false)
    runContextMenuAction('reset', one)
    expect(calls.reset).toHaveBeenCalledWith('a')
    runContextMenuAction('frame', one)
    expect(calls.frame).toHaveBeenCalledWith('a')
    const many = { kind: 'meshes', uuids: ['a', 'b'] }
    runContextMenuAction('visibility', many)
    expect(calls.visibleMany).toHaveBeenCalledWith(['a', 'b'], false)
    useStore.setState({ meshOverrides: { a: { visible: false } } })
    runContextMenuAction('visibility', one) // hidden now, so this shows it
    expect(calls.visible).toHaveBeenLastCalledWith('a', true)
    runContextMenuAction('reset', many)
    expect(calls.resetMany).toHaveBeenCalledWith(['a', 'b'])
  })

  it('Extract hides the originals, Copy to object leaves them, and the result is announced', async () => {
    await runContextMenuAction('extract', { kind: 'meshes', uuids: ['a', 'b'] })
    expect(calls.extract).toHaveBeenLastCalledWith(['a', 'b'], { removeOriginals: true })
    await runContextMenuAction('copyOut', { kind: 'meshes', uuids: ['a'] })
    expect(calls.extract).toHaveBeenLastCalledWith(['a'], { removeOriginals: false })
    expect(useStore.getState().loadNotice).toBe('Extracted it.')
  })
})

describe('merging from the viewport menu', () => {
  const models = [
    { id: 1, name: 'Wheel', kind: 'model', visible: true },
    { id: 2, name: 'Body', kind: 'model', visible: true },
  ]
  it('is offered for two or more models, and runs the merge', async () => {
    useStore.setState({ mode: 'object', sceneObjects: models })
    const items = getContextMenuItems({ kind: 'objects', ids: [1, 2] })
    expect(labels(items)).toContain('Merge 2 objects into one')
    await runContextMenuAction('merge', { kind: 'objects', ids: [1, 2] })
    expect(calls.merge).toHaveBeenCalledWith([1, 2])
    expect(useStore.getState().loadNotice).toBe('Merged them.')
  })
  it('is not offered for one object, a character, or an image', () => {
    useStore.setState({ mode: 'object', sceneObjects: [...models, { id: 3, name: 'Hero', kind: 'model', isCharacter: true }, { id: 4, name: 'Pic', kind: 'image' }] })
    expect(labels(getContextMenuItems({ kind: 'objects', ids: [1] }))).not.toContain('Merge 1 objects into one')
    expect(labels(getContextMenuItems({ kind: 'objects', ids: [1, 3] })).some((l) => /Merge/.test(l))).toBe(false)
    expect(labels(getContextMenuItems({ kind: 'objects', ids: [1, 4] })).some((l) => /Merge/.test(l))).toBe(false)
  })
})
