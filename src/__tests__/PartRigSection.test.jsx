import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import * as THREE from 'three'

const h = vi.hoisted(() => ({ picker: null, model: { root: null, __rigAdds: [] }, entries: [], applied: [], physics: [] }))

vi.mock('../three/meshedit.js', async (importOriginal) => ({
  ...(await importOriginal()),
  setFacePickHandler: (fn) => { h.picker = fn },
}))
vi.mock('../three/scene.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentModel: () => h.model,
}))
vi.mock('../three/partRig.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isRigCapable: () => true,
  getPartRigEntries: () => h.entries,
  getPartRigDependents: () => [],
  trisFromClick: (_mesh, hit) => [hit.faceIndex, hit.faceIndex + 1], // a click selects its face and the next one
  planForMeshes: () => ({ ok: true, bones: [{}], pieces: [{ parentBone: 0 }] }),
  setPartRigHighlight: () => {},
  setPartRigPreview: () => {},
  clearPartRigFeedback: () => {},
  applyPartRig: (...args) => {
    h.applied.push(args)
    return { ok: true, entry: { id: 'rig_new', label: args[4].label, boneNames: ['n1'], rootBoneNames: ['n1'] } }
  },
}))
vi.mock('../three/dangle.js', async (importOriginal) => ({
  ...(await importOriginal()),
  addDangleChainUndoable: (...args) => { h.physics.push(args) },
  collectDescendantBoneNames: () => ['n1'],
}))

import { useStore } from '../store.js'
import PartRigSection from '../panels/PartRigSection.jsx'
import { getPartRigDraft, resetPartRigDraft } from '../three/partRigDraft.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

let mesh
const click = (faceIndex) => act(() => h.picker({ uuid: mesh.uuid, faceIndex, point: new THREE.Vector3() }))
const undo = () => act(() => performUndo(useStore.getState()))
const redo = () => act(() => performRedo(useStore.getState()))
const faces = () => getPartRigDraft()[mesh.uuid] || []

function mount() {
  return render(<PartRigSection meshUuid={mesh.uuid} meshUuids={[mesh.uuid]} resolveMesh={(uuid) => (uuid === mesh.uuid ? mesh : null)} />)
}

beforeEach(() => {
  mesh = new THREE.Object3D()
  mesh.skeleton = { bones: [{ name: 'Spine' }] }
  h.model.root = new THREE.Object3D()
  h.entries = [{
    id: 'rig_hair', label: 'Hair', boneNames: ['h1', 'h2'], rootBoneNames: ['h1'], meshIndices: [0], parentNames: ['Spine'],
    options: { segments: 4, columns: 1, direction: 'shape', stick: 0.1 }, tris: [], trisByMesh: [[]],
    result: { meshes: [{ mesh }] },
  }]
  h.model.__rigAdds = h.entries
  h.applied.length = 0
  h.physics.length = 0
  h.picker = null
  clearUndoHistory()
  resetPartRigDraft()
  useStore.setState({
    modelInfo: { bones: [] },
    dangleChains: [{ id: 'd1', name: 'Hair', boneNames: ['h1', 'h2'], type: 'dangle', stiffness: 0.9, gravity: 2.5, damping: 0.3, groupId: 'rig_hair', groupName: 'Hair' }],
  })
})
afterEach(cleanup)

const startPicking = () => fireEvent.click(screen.getByRole('button', { name: 'Pick faces' }))

describe('Add bones: picked area and undo / redo', () => {
  it('every change to the picked area is an undo step, and redo brings it back', () => {
    mount()
    startPicking()
    click(10)
    click(30)
    expect(faces()).toEqual([10, 11, 30, 31])
    undo()
    expect(faces()).toEqual([10, 11])
    undo()
    expect(faces()).toEqual([])
    redo()
    redo()
    expect(faces()).toEqual([10, 11, 30, 31])
  })

  it('Clear is undoable too', () => {
    mount()
    startPicking()
    click(10)
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(faces()).toEqual([])
    undo()
    expect(faces()).toEqual([10, 11])
  })

  it('clicking an already selected area removes it, clicking again adds it back; no remove toggle', () => {
    mount()
    startPicking()
    expect(screen.queryByText(/Remove from selection/)).toBeNull()
    click(10)
    click(30)
    click(10) // same area again
    expect(faces()).toEqual([30, 31])
    click(10)
    expect(faces()).toEqual([30, 31, 10, 11])
    undo()
    expect(faces()).toEqual([30, 31])
  })
})

describe('Add bones: Duplicate', () => {
  it('starts a new rig with the same settings, builds nothing, and keeps the original', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    expect(h.applied).toHaveLength(0)
    expect(faces()).toEqual([])
    click(50) // picking is already on
    expect(faces()).toEqual([50, 51])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add bones' }).disabled).toBe(false))
    expect(screen.getByLabelText('Name for the new bones').value).toBe('Hair_2')
    fireEvent.click(screen.getByRole('button', { name: 'Add bones' }))
    expect(h.applied).toHaveLength(1)
    const [, , selections, opts, extra] = h.applied[0]
    expect(selections[0].tris).toEqual([50, 51])
    expect(opts.segments).toBe(4)
    expect(extra.label).toBe('Hair_2')
    // the swing physics of the new rig start from the original's settings
    expect(h.physics).toHaveLength(1)
    const copied = h.physics[0][4]
    expect(copied).toMatchObject({ stiffness: 0.9, gravity: 2.5, damping: 0.3 })
    expect(copied.id).toBeUndefined()
    expect(copied.boneNames).toBeUndefined()
  })
})
