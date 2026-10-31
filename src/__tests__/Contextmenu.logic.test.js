import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  copyCurrentEdit: vi.fn(() => 'object'),
  pasteCurrentEdit: vi.fn(() => ({ type: 'object' })),
  canPasteCurrentEdit: vi.fn(() => true),
  removeObjectById: vi.fn(),
  setObjectVisibleById: vi.fn(),
  applyModelMaterials: vi.fn(),
  removeLight: vi.fn(),
  setLightVisible: vi.fn(),
  removeCamera: vi.fn(),
  setObjectCastShadowById: vi.fn(),
  setObjectRimImmuneById: vi.fn(),
}))
vi.mock('../three/editClipboard.js', () => ({
  copyCurrentEdit: m.copyCurrentEdit,
  pasteCurrentEdit: m.pasteCurrentEdit,
  canPasteCurrentEdit: m.canPasteCurrentEdit,
}))
vi.mock('../three/scene.js', async (importOriginal) => ({
  ...(await importOriginal()),
  removeObjectById: m.removeObjectById,
  setObjectVisibleById: m.setObjectVisibleById,
  applyModelMaterials: m.applyModelMaterials,
  setObjectCastShadowById: m.setObjectCastShadowById,
  setObjectRimImmuneById: m.setObjectRimImmuneById,
}))
vi.mock('../three/lights.js', async (importOriginal) => ({ ...(await importOriginal()), removeLight: m.removeLight, setLightVisible: m.setLightVisible }))
vi.mock('../three/cameras.js', async (importOriginal) => ({ ...(await importOriginal()), removeCamera: m.removeCamera }))

import { createRightClickGesture, resolveContextTarget, selectContextTarget, getContextMenuItems, runContextMenuAction } from '../three/contextMenu.js'
import { useStore } from '../store.js'

const st = () => useStore.getState()
const ev = (button, x, y) => ({ button, clientX: x, clientY: y })

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockClear())
  m.canPasteCurrentEdit.mockReturnValue(true)
  useStore.setState({
    mode: 'object',
    sceneObjects: [
      { id: 1, name: 'Hero', isCharacter: true, visible: true },
      { id: 2, name: 'Crate', visible: true },
      { id: 3, name: 'Barrel', visible: false },
    ],
    sceneLights: [{ id: 10, name: 'Light 1', visible: true }, { id: 11, name: 'Light 2', visible: false }],
    sceneCameras: [{ id: 20, name: 'Cam' }],
    selectedObjectId: null, selectedObjectIds: [], selectedCameraId: null, selectedLightId: null,
    activeCharacterId: 1,
    rimFollowLightId: null,
  })
})

describe('right-click gesture: opens on a click, not on a drag', () => {
  it('a still right-click opens the menu at the pointer', () => {
    const onOpen = vi.fn()
    const g = createRightClickGesture({ onOpen })
    g.pointerDown(ev(2, 100, 100))
    g.pointerUp(ev(2, 100, 100))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen.mock.calls[0][0]).toMatchObject({ clientX: 100, clientY: 100 })
  })

  it('a few pixels of jitter still counts as a click', () => {
    const onOpen = vi.fn()
    const g = createRightClickGesture({ onOpen })
    g.pointerDown(ev(2, 100, 100))
    g.pointerMove(ev(2, 102, 101))
    g.pointerUp(ev(2, 102, 101))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('a right-drag (panning the view) does NOT open it', () => {
    const onOpen = vi.fn()
    const g = createRightClickGesture({ onOpen })
    g.pointerDown(ev(2, 100, 100))
    g.pointerMove(ev(2, 160, 120))
    g.pointerUp(ev(2, 160, 120))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('dragging away and back to the start still counts as a drag', () => {
    const onOpen = vi.fn()
    const g = createRightClickGesture({ onOpen })
    g.pointerDown(ev(2, 100, 100))
    g.pointerMove(ev(2, 200, 100))
    g.pointerMove(ev(2, 100, 100))
    g.pointerUp(ev(2, 100, 100))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('left and middle buttons never open it', () => {
    const onOpen = vi.fn()
    const g = createRightClickGesture({ onOpen })
    for (const b of [0, 1]) {
      g.pointerDown(ev(b, 5, 5))
      g.pointerUp(ev(b, 5, 5))
    }
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('a cancelled gesture, or a stray release, does nothing', () => {
    const onOpen = vi.fn()
    const g = createRightClickGesture({ onOpen })
    g.pointerDown(ev(2, 5, 5))
    g.cancel()
    g.pointerUp(ev(2, 5, 5))
    g.pointerUp(ev(2, 5, 5))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('does not leak a drag into the next click', () => {
    const onOpen = vi.fn()
    const g = createRightClickGesture({ onOpen })
    g.pointerDown(ev(2, 0, 0))
    g.pointerMove(ev(2, 90, 0))
    g.pointerUp(ev(2, 90, 0))
    g.pointerDown(ev(2, 50, 50))
    g.pointerUp(ev(2, 50, 50))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('resolveContextTarget', () => {
  const api = (over = {}) => ({
    pickCameraId: () => null,
    pickLightId: () => null,
    pickObjectId: () => null,
    isCharacterId: (id) => id === 1 || id === 5,
    setActiveCharacter: vi.fn(),
    ...over,
  })

  it('finds nothing → empty', () => {
    expect(resolveContextTarget(0, 0, st(), api())).toEqual({ kind: 'empty' })
  })

  it('a camera or light marker wins over an object behind it', () => {
    expect(resolveContextTarget(0, 0, st(), api({ pickCameraId: () => 20, pickLightId: () => 10, pickObjectId: () => 2 }))).toEqual({ kind: 'camera', id: 20 })
    expect(resolveContextTarget(0, 0, st(), api({ pickLightId: () => 10, pickObjectId: () => 2 }))).toEqual({ kind: 'light', id: 10 })
  })

  it('an object → that object', () => {
    expect(resolveContextTarget(0, 0, st(), api({ pickObjectId: () => 2 }))).toEqual({ kind: 'objects', ids: [2] })
  })

  it('a character that is not active becomes active; the active one is left alone', () => {
    const a = api({ pickObjectId: () => 5 })
    resolveContextTarget(0, 0, st(), a)
    expect(a.setActiveCharacter).toHaveBeenCalledWith(5)
    const b = api({ pickObjectId: () => 1 })
    resolveContextTarget(0, 0, st(), b)
    expect(b.setActiveCharacter).not.toHaveBeenCalled()
  })

  it('right-clicking part of a multi-selection targets the whole selection', () => {
    useStore.setState({ selectedObjectIds: [2, 3], selectedObjectId: 3 })
    expect(resolveContextTarget(0, 0, st(), api({ pickObjectId: () => 2 }))).toEqual({ kind: 'objects', ids: [2, 3] })
  })

  it('right-clicking something OUTSIDE the multi-selection targets just that thing', () => {
    useStore.setState({ selectedObjectIds: [2, 3], selectedObjectId: 3 })
    expect(resolveContextTarget(0, 0, st(), api({ pickObjectId: () => 1 }))).toEqual({ kind: 'objects', ids: [1] })
  })
})

describe('selectContextTarget', () => {
  it('selects the right-clicked object (and drops other kinds of selection)', () => {
    useStore.setState({ selectedLightId: 10 })
    selectContextTarget({ kind: 'objects', ids: [2] })
    expect(st().selectedObjectId).toBe(2)
    expect(st().selectedLightId).toBeNull()
  })

  it('keeps a multi-selection as it is', () => {
    useStore.setState({ selectedObjectIds: [2, 3], selectedObjectId: 3 })
    selectContextTarget({ kind: 'objects', ids: [2, 3] })
    expect(st().selectedObjectIds).toEqual([2, 3])
  })

  it('selects a camera / light', () => {
    selectContextTarget({ kind: 'camera', id: 20 })
    expect(st().selectedCameraId).toBe(20)
    selectContextTarget({ kind: 'light', id: 10 })
    expect(st().selectedLightId).toBe(10)
    expect(st().selectedCameraId).toBeNull()
  })

  it('empty space leaves the selection alone', () => {
    useStore.setState({ selectedObjectIds: [2], selectedObjectId: 2 })
    selectContextTarget({ kind: 'empty' })
    expect(st().selectedObjectIds).toEqual([2])
  })
})

describe('getContextMenuItems', () => {
  const ids = (items) => items.filter((i) => !i.separator && i.id).map((i) => i.id)

  it('an object offers Copy, Paste, Hide and Delete', () => {
    const items = getContextMenuItems({ kind: 'objects', ids: [2] }, st())
    expect(ids(items)).toEqual(['copy', 'paste', 'visibility', 'delete'])
    expect(items.find((i) => i.id === 'visibility').label).toBe('Hide')
    expect(items.find((i) => i.id === 'delete').danger).toBe(true)
  })

  it('an object also offers its Look & shadow switches, same as the Objects panel menu', () => {
    const items = getContextMenuItems({ kind: 'objects', ids: [2] }, st())
    const fly = items.find((i) => i.label === 'Look & shadow')
    expect(fly).toBeTruthy()
    const childIds = fly.children.filter((i) => i.id).map((i) => i.id)
    expect(childIds).toEqual(expect.arrayContaining(['receive', 'rim', 'night']))
  })

  it('running one of those switches acts on the right-clicked object', () => {
    useStore.setState({
      sceneObjects: [{ id: 5, name: 'Lamp post', kind: 'model', visible: true, castShadow: true, rimImmune: false }],
    })
    runContextMenuAction('cast', { kind: 'objects', ids: [5] }, st())
    expect(m.setObjectCastShadowById).toHaveBeenCalledWith(5, false)
    runContextMenuAction('rim', { kind: 'objects', ids: [5] }, st())
    expect(m.setObjectRimImmuneById).toHaveBeenCalledWith(5, true)
  })

  it('a hidden object offers Show instead of Hide', () => {
    expect(getContextMenuItems({ kind: 'objects', ids: [3] }, st()).find((i) => i.id === 'visibility').label).toBe('Show')
    expect(getContextMenuItems({ kind: 'light', id: 11 }, st()).find((i) => i.id === 'visibility').label).toBe('Show')
  })

  it('Paste is greyed out when there is nothing to paste', () => {
    m.canPasteCurrentEdit.mockReturnValue(false)
    expect(getContextMenuItems({ kind: 'objects', ids: [2] }, st()).find((i) => i.id === 'paste').disabled).toBe(true)
  })

  it('a camera has no Hide (cameras have no visibility to toggle)', () => {
    expect(ids(getContextMenuItems({ kind: 'camera', id: 20 }, st()))).toEqual(['copy', 'paste', 'delete'])
  })

  it('a multi-selection says how many it will delete', () => {
    expect(getContextMenuItems({ kind: 'objects', ids: [2, 3] }, st()).find((i) => i.id === 'delete').label).toBe('Delete 2 objects')
  })

  it('empty space: only Paste, and no menu at all when there is nothing to paste', () => {
    expect(ids(getContextMenuItems({ kind: 'empty' }, st()))).toEqual(['paste'])
    m.canPasteCurrentEdit.mockReturnValue(false)
    expect(getContextMenuItems({ kind: 'empty' }, st())).toEqual([])
  })
})

describe('runContextMenuAction', () => {
  it('Copy and Paste go through the same clipboard the keyboard shortcuts use', () => {
    runContextMenuAction('copy', { kind: 'objects', ids: [2] })
    expect(m.copyCurrentEdit).toHaveBeenCalledTimes(1)
    runContextMenuAction('paste', { kind: 'empty' })
    expect(m.pasteCurrentEdit).toHaveBeenCalledTimes(1)
  })

  it('Hide hides every selected object; Show brings a hidden one back', () => {
    runContextMenuAction('visibility', { kind: 'objects', ids: [2, 3] })
    // first object (2) is visible → the whole selection goes hidden
    expect(m.setObjectVisibleById.mock.calls).toEqual([[2, false], [3, false]])
    m.setObjectVisibleById.mockClear()
    runContextMenuAction('visibility', { kind: 'objects', ids: [3] })
    expect(m.setObjectVisibleById).toHaveBeenCalledWith(3, true)
  })

  it('Hide / Show on a light', () => {
    runContextMenuAction('visibility', { kind: 'light', id: 10 })
    expect(m.setLightVisible).toHaveBeenCalledWith(10, false)
    runContextMenuAction('visibility', { kind: 'light', id: 11 })
    expect(m.setLightVisible).toHaveBeenCalledWith(11, true)
  })

  it('Delete removes each selected object, a camera, or a light', () => {
    runContextMenuAction('delete', { kind: 'objects', ids: [2, 3] })
    expect(m.removeObjectById.mock.calls).toEqual([[2], [3]])
    runContextMenuAction('delete', { kind: 'camera', id: 20 })
    expect(m.removeCamera).toHaveBeenCalledWith(20)
    runContextMenuAction('delete', { kind: 'light', id: 10 })
    expect(m.removeLight).toHaveBeenCalledWith(10)
  })

  it('deleting the light that drives the rim light switches that off, like the Lights panel does', () => {
    useStore.setState({ rimFollowLightId: 10, rimFollowLight: true })
    runContextMenuAction('delete', { kind: 'light', id: 10 })
    expect(st().rimFollowLight).toBe(false)
    expect(st().rimFollowLightId).toBeNull()
    expect(m.applyModelMaterials).toHaveBeenCalled()
  })

  it('actions on empty space (other than Paste) do nothing', () => {
    expect(runContextMenuAction('delete', { kind: 'empty' })).toBeNull()
    expect(m.removeObjectById).not.toHaveBeenCalled()
  })
})
