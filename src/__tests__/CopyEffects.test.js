import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects } from '../three/objects.js'
import { initPosing } from '../three/posing.js'
import { initMeshEdit } from '../three/meshedit.js'
import { initAnimation } from '../three/animation.js'
import { clearDangleChainsUndoable, initDangle } from '../three/dangle.js'
import { __seedCharacterForTest, getCurrentModel, reapplyAddBonesGroups, getPhysicsBoneNames } from '../three/scene.js'
import { applyPartRig, getPartRigEntries, initPartRig } from '../three/partRig.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'
import { toRanges } from '../three/regions.js'
import PartRigSection from '../panels/PartRigSection.jsx'
import {
  copyAddedBonesFromCharacter,
  copyAddedBonesFromMesh,
  copyMeshPhysicsFromCharacter,
  copyMeshPhysicsFromMesh,
  clearAddedBonesFromCharacter,
  clearAllDangleChainsAndBones,
  clearMeshPhysicsFromCharacter,
  describeBonesCopy,
  listCopySources,
  baseMeshName,
  mapTris,
  matchMeshes,
} from '../three/copyEffects.js'

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera()
const renderer = { domElement: document.createElement('canvas') }
const controls = { enabled: true, locked: false }
const requestRender = () => {}

function skin(geometry) {
  const n = geometry.getAttribute('position').count
  const w = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) w[i * 4] = 1
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4))
  return geometry
}

// Same bones and part name every time; the shape (and so the proportions / face count) is up to the test.
function makeCharacter(name, geometry) {
  const root = new THREE.Group()
  root.name = name
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  root.add(hips)
  const mesh = new THREE.SkinnedMesh(skin(geometry), new THREE.MeshStandardMaterial())
  mesh.name = 'Body'
  mesh.bind(new THREE.Skeleton([hips]))
  root.add(mesh)
  const model = {
    root, bones: [hips], meshes: [mesh], skinnedMeshes: [mesh], clips: [],
    info: { name, clipNames: [], bones: [{ name: 'Hips' }], meshes: [{ uuid: mesh.uuid, name: 'Body' }] },
  }
  model.skeleton = mesh.skeleton
  model.__poseRestQuats = new Map([[hips, hips.quaternion.clone()]])
  return model
}

const faceCount = (mesh) => mesh.geometry.index.count / 3
const topFaces = (mesh) => {
  const pos = mesh.geometry.attributes.position
  const idx = mesh.geometry.index
  const out = []
  for (let t = 0; t < faceCount(mesh); t++) {
    const y = [0, 1, 2].reduce((sum, k) => sum + pos.getY(idx.getX(t * 3 + k)), 0) / 3
    if (y > 0.01) out.push(t)
  }
  return out
}

let source
let target

// source (with a rig, swing physics and a soft cloth zone on its top half) is seeded first, so its settings are
// filed in the roster; the target is seeded last and is the active character.
function seed(targetGeometry) {
  source = makeCharacter('Source', new THREE.BoxGeometry(1, 1, 1, 2, 2, 2))
  __seedCharacterForTest('source', source, scene)
  const rigged = applyPartRig(source, source.meshes[0], topFaces(source.meshes[0]), { segments: 2 }, { label: 'Hair' })
  expect(rigged.ok).toBe(true)
  const zone = {
    id: 'z1', name: 'Hood', mode: 'soft', enabled: true, stiffness: 0.11, damping: 0.5,
    area: { kind: 'tris', tris: toRanges(topFaces(source.meshes[0])), vertexCount: source.meshes[0].geometry.index.count },
  }
  useStore.setState({
    dangleEnabled: true,
    dangleChains: [{ id: 'c1', name: 'Hair', boneNames: rigged.entry.boneNames, type: 'dangle', stiffness: 0.77, gravity: 3, damping: 0.2, groupId: rigged.entry.id }],
    meshOverrides: { [source.meshes[0].uuid]: { outline: true, shading: 'full', softZones: [zone] } },
  })
  target = makeCharacter('Target', targetGeometry)
  __seedCharacterForTest('target', target, scene)
}

beforeEach(() => {
  initObjects({ scene, camera, renderer, controls, requestRender })
  initPosing({ scene, camera, renderer, controls, requestRender })
  initMeshEdit({ scene, camera, renderer, controls, requestRender })
  initAnimation({ requestRender, setContinuousRender: () => {} })
  initDangle({ requestRender })
  initPartRig({ requestRender })
  clearUndoHistory()
  useStore.setState({
    characters: {}, characterOrder: [], activeCharacterId: null, sceneObjects: [], selectedObjectId: null,
    selectedObjectIds: [], mode: 'bone', dangleChains: [], meshOverrides: {},
  })
})
afterEach(cleanup)

describe('matching and carrying faces over', () => {
  it('pairs same-named meshes in order and reports the ones with no partner', () => {
    const a = { meshes: [{ name: 'Hair' }, { name: 'Hair' }, { name: 'Coat' }, { name: '' }] }
    const b = { meshes: [{ name: 'Coat' }, { name: 'Hair' }] }
    const { pairs, missing } = matchMeshes(a, b)
    expect(pairs.map((p) => p.src.name)).toEqual(['Hair', 'Coat'])
    expect(missing).toEqual(['Hair'])
  })

  it('ignores Blender duplicate numbers so Hoodie001 matches Hoodie002 (and Hoodie001_1 matches Hoodie002_1)', () => {
    expect(['Hoodie001', 'Hoodie001_1', 'Eyeballs002_3', 'Body.001', 'HairStrands', 'Hair2', 'Shoes'].map(baseMeshName))
      .toEqual(['Hoodie', 'Hoodie_1', 'Eyeballs_3', 'Body', 'HairStrands', 'Hair2', 'Shoes'])
    const a = { meshes: [{ name: 'HairStrands' }, { name: 'Hoodie001' }, { name: 'Hoodie001_1' }, { name: 'Tshirt001' }, { name: 'Tshirt001_1' }, { name: 'Cape001' }] }
    const b = { meshes: [{ name: 'Tshirt002_1' }, { name: 'Hoodie002_1' }, { name: 'Hoodie002' }, { name: 'Tshirt002' }, { name: 'HairStrands' }] }
    const { pairs, missing } = matchMeshes(a, b)
    expect(pairs.map((p) => [p.src.name, p.tgt.name])).toEqual([
      ['HairStrands', 'HairStrands'],
      ['Hoodie001', 'Hoodie002'],
      ['Hoodie001_1', 'Hoodie002_1'],
      ['Tshirt001', 'Tshirt002'],
      ['Tshirt001_1', 'Tshirt002_1'],
    ])
    expect(missing).toEqual(['Cape001'])
  })

  it('an exact name wins over a loose one', () => {
    const a = { meshes: [{ name: 'Hoodie001' }] }
    const b = { meshes: [{ name: 'Hoodie002' }, { name: 'Hoodie001' }] }
    expect(matchMeshes(a, b).pairs[0].tgt).toBe(b.meshes[1])
  })

  it('keeps face numbers when both meshes have the same number of faces', () => {
    const a = makeCharacter('a', new THREE.BoxGeometry(1, 1, 1, 2, 2, 2)).meshes[0]
    const b = makeCharacter('b', new THREE.BoxGeometry(2, 5, 2, 2, 2, 2)).meshes[0]
    expect(mapTris(a, b, [3, 4, 9])).toEqual({ tris: [3, 4, 9], approx: false })
  })

  it('carries an area over by position when the face counts differ', () => {
    const a = makeCharacter('a', new THREE.BoxGeometry(1, 1, 1, 2, 2, 2)).meshes[0]
    const b = makeCharacter('b', new THREE.BoxGeometry(1.5, 3, 1.5, 4, 4, 4)).meshes[0]
    const { tris, approx } = mapTris(a, b, topFaces(a))
    expect(approx).toBe(true)
    expect(tris.length).toBeGreaterThan(0)
    // everything picked sits on the top half of the (taller, rounder) target, and nearly all of that half is picked
    const top = new Set(topFaces(b))
    expect(tris.every((t) => top.has(t))).toBe(true)
    expect(tris.length).toBeGreaterThan(top.size * 0.8)
  })
})

describe('copy added bones', () => {
  it('duplicates a copied rig with its real physics chain and undoes both together', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    copyAddedBonesFromCharacter('source')
    const model = getCurrentModel()
    const mesh = model.meshes[0]
    const original = getPartRigEntries(model)[0]
    render(React.createElement(PartRigSection, {
      meshUuid: mesh.uuid,
      meshUuids: [mesh.uuid],
      resolveMesh: (uuid) => model.meshes.find((item) => item.uuid === uuid),
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    const rigs = getPartRigEntries(model)
    const chains = useStore.getState().dangleChains
    expect(rigs).toHaveLength(2)
    expect(chains).toHaveLength(2)
    expect(chains[0].groupId).toBe(original.id)
    expect(chains[1]).toMatchObject({ groupId: rigs[1].id, stiffness: 0.77, gravity: 3, damping: 0.2 })
    expect(chains[1].boneNames).toEqual(rigs[1].boneNames)
    act(() => performUndo(useStore.getState()))
    expect(getPartRigEntries(model)).toHaveLength(1)
    expect(useStore.getState().dangleChains).toHaveLength(1)
    act(() => performRedo(useStore.getState()))
    expect(getPartRigEntries(model)).toHaveLength(2)
    expect(useStore.getState().dangleChains).toHaveLength(2)
  })

  it('clears added bones and their dangle chains together, in one undo step', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    copyAddedBonesFromCharacter('source')
    const removed = clearAddedBonesFromCharacter()
    expect(removed).toEqual(['Hair'])
    expect(getPartRigEntries(getCurrentModel())).toHaveLength(0)
    expect(useStore.getState().dangleChains).toHaveLength(0)

    performUndo(useStore.getState())
    expect(getPartRigEntries(getCurrentModel())).toHaveLength(1)
    expect(useStore.getState().dangleChains).toHaveLength(1)
  })

  it('rebuilds the rig and its swing physics on a character of different proportions, in one undo step', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    expect(listCopySources()).toMatchObject([{ id: 'source', name: 'Source', rigs: 1, physicsParts: 1 }])
    const result = copyAddedBonesFromCharacter('source')
    expect(result.copied).toHaveLength(1)
    expect(result.approx).toBe(false)
    const entry = getPartRigEntries(getCurrentModel())[0]
    expect(entry.label).toBe('Hair')
    expect(entry.boneNames.length).toBeGreaterThan(0)
    const chains = useStore.getState().dangleChains
    expect(chains).toHaveLength(1)
    expect(chains[0]).toMatchObject({ stiffness: 0.77, gravity: 3, damping: 0.2, groupId: entry.id })
    // the chain follows the NEW bones, not the source's
    expect(chains[0].boneNames.every((n) => entry.boneNames.includes(n))).toBe(true)

    performUndo(useStore.getState())
    expect(getPartRigEntries(getCurrentModel())).toHaveLength(0)
    expect(useStore.getState().dangleChains).toHaveLength(0)
    performRedo(useStore.getState())
    expect(getPartRigEntries(getCurrentModel())).toHaveLength(1)
    expect(useStore.getState().dangleChains).toHaveLength(1)
  })

  it('works across a different mesh layout, flagged as approximate', () => {
    seed(new THREE.BoxGeometry(1.5, 3, 1.5, 4, 4, 4))
    const result = copyAddedBonesFromCharacter('source')
    expect(result.copied).toHaveLength(1)
    expect(result.approx).toBe(true)
  })

  it('does not copy the same rig twice', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    copyAddedBonesFromCharacter('source')
    const again = copyAddedBonesFromCharacter('source')
    expect(again.copied).toHaveLength(0)
    expect(again.skipped[0].reason).toMatch(/already has/)
    expect(getPartRigEntries(getCurrentModel())).toHaveLength(1)
  })

  it('copies from one mesh to another', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    const result = copyAddedBonesFromMesh('source', source.meshes[0], target.meshes[0])
    expect(result.copied).toHaveLength(1)
    expect(getPartRigEntries(getCurrentModel())).toHaveLength(1)
  })
})

describe('characters whose parts carry different Blender numbers', () => {
  it('copies added bones and mesh physics between Hoodie001 and Hoodie002', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    source.meshes[0].name = 'Hoodie001'
    target.meshes[0].name = 'Hoodie002'
    const bones = copyAddedBonesFromCharacter('source')
    expect(bones.matched).toBe(1)
    expect(bones.copied).toHaveLength(1)
    const physics = copyMeshPhysicsFromCharacter('source')
    expect(physics.copied).toBe(1)
  })

  it('copies two rigs that share a name on the same part (the second is not mistaken for a duplicate)', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    const faces = topFaces(source.meshes[0])
    const second = applyPartRig(source, source.meshes[0], faces.slice(0, 6), { segments: 2 }, { label: 'Hair' })
    expect(second.ok).toBe(true)
    const result = copyAddedBonesFromCharacter('source')
    expect(result.copied).toHaveLength(2)
    expect(getPartRigEntries(getCurrentModel())).toHaveLength(2)
  })

  it('says so when no part names line up at all', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    source.meshes[0].name = 'Cape'
    const bones = copyAddedBonesFromCharacter('source')
    expect(bones.copied).toHaveLength(0)
    expect(describeBonesCopy(bones)).toMatch(/No parts with matching names/)
  })
})

describe('copy mesh physics', () => {
  it('clears mesh physics across the character and restores it with undo', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    copyMeshPhysicsFromCharacter('source')

    const result = clearMeshPhysicsFromCharacter()
    expect(result.removed).toBe(1)
    expect(useStore.getState().meshOverrides[target.meshes[0].uuid]?.softZones || []).toHaveLength(0)

    performUndo(useStore.getState())
    expect(useStore.getState().meshOverrides[target.meshes[0].uuid].softZones).toHaveLength(1)
  })

  it('copies zones with a fresh id and the matching area, once, as one undo step', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    const result = copyMeshPhysicsFromCharacter('source')
    expect(result).toMatchObject({ copied: 1, parts: 1 })
    const zones = useStore.getState().meshOverrides[target.meshes[0].uuid].softZones
    expect(zones).toHaveLength(1)
    expect(zones[0]).toMatchObject({ name: 'Hood', stiffness: 0.11, damping: 0.5 })
    expect(zones[0].id).not.toBe('z1')
    expect(zones[0].area.vertexCount).toBe(target.meshes[0].geometry.index.count)

    expect(copyMeshPhysicsFromCharacter('source').copied).toBe(0) // already there
    performUndo(useStore.getState())
    expect(useStore.getState().meshOverrides[target.meshes[0].uuid]?.softZones || []).toHaveLength(0)
  })

  it('maps the area by position when the meshes differ, and mesh-to-mesh works the same way', () => {
    seed(new THREE.BoxGeometry(1.5, 3, 1.5, 4, 4, 4))
    const result = copyMeshPhysicsFromMesh('source', source.meshes[0], target.meshes[0])
    expect(result.approx).toBe(true)
    const zone = useStore.getState().meshOverrides[target.meshes[0].uuid].softZones[0]
    expect(zone.area.kind).toBe('tris')
    expect(zone.area.vertexCount).toBe(target.meshes[0].geometry.index.count)
  })
})

describe('clear dangle chains', () => {
  it('also removes the added bones the chains swing, in one undo step', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    copyAddedBonesFromCharacter('source')
    clearAllDangleChainsAndBones()
    expect(getPartRigEntries(getCurrentModel())).toHaveLength(0)
    expect(useStore.getState().dangleChains).toHaveLength(0)

    performUndo(useStore.getState())
    expect(getPartRigEntries(getCurrentModel())).toHaveLength(1)
    expect(useStore.getState().dangleChains).toHaveLength(1)
  })

  it('clears every chain in one undo step', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    const chain = { id: 'target-chain', name: 'Hair', boneNames: ['Hips'], type: 'dangle' }
    useStore.setState({ dangleChains: [chain] })

    clearDangleChainsUndoable()
    expect(useStore.getState().dangleChains).toEqual([])

    performUndo(useStore.getState())
    expect(useStore.getState().dangleChains).toEqual([chain])
  })
})

describe('replace existing effects', () => {
  it('deletes the target\'s own rigs and swing physics first, so it ends up identical to the source, in one undo step', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    const own = applyPartRig(target, target.meshes[0], topFaces(target.meshes[0]), { segments: 2 }, { label: 'Cape' })
    expect(own.ok).toBe(true)
    useStore.setState({
      dangleEnabled: true,
      dangleChains: [{ id: 'own', name: 'Cape', boneNames: own.entry.boneNames, type: 'dangle', stiffness: 0.5, gravity: 1, damping: 0.4, groupId: own.entry.id }],
    })

    const result = copyAddedBonesFromCharacter('source', { replace: true })
    expect(result.removed).toEqual(['Cape'])
    expect(result.copied).toHaveLength(1)
    const entries = getPartRigEntries(getCurrentModel())
    expect(entries.map((e) => e.label)).toEqual(['Hair'])
    const chains = useStore.getState().dangleChains
    expect(chains).toHaveLength(1)
    expect(chains[0]).toMatchObject({ stiffness: 0.77, gravity: 3, damping: 0.2 })
    expect(describeBonesCopy(result)).toMatch(/Removed 1 existing rig \(Cape\)/)

    performUndo(useStore.getState())
    expect(getPartRigEntries(getCurrentModel()).map((e) => e.label)).toEqual(['Cape'])
    expect(useStore.getState().dangleChains.map((c) => c.id)).toEqual(['own'])
  })

  it('without replace, existing rigs are kept (the old behaviour)', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    applyPartRig(target, target.meshes[0], topFaces(target.meshes[0]), { segments: 2 }, { label: 'Cape' })
    const result = copyAddedBonesFromCharacter('source')
    expect(result.removed).toEqual([])
    expect(getPartRigEntries(getCurrentModel()).map((e) => e.label).sort()).toEqual(['Cape', 'Hair'])
  })

  it('replaces mesh physics: the target\'s own zones go, the source\'s come in, and it undoes together', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    const uuid = target.meshes[0].uuid
    useStore.setState((st) => ({
      meshOverrides: { ...st.meshOverrides, [uuid]: { softZones: [{ id: 'mine', name: 'Sleeve', mode: 'soft', enabled: true, stiffness: 0.9, damping: 0.1, area: { kind: 'all' } }] } },
    }))
    const result = copyMeshPhysicsFromCharacter('source', { replace: true })
    expect(result).toMatchObject({ copied: 1, removed: 1 })
    const zones = useStore.getState().meshOverrides[uuid].softZones
    expect(zones.map((z) => z.name)).toEqual(['Hood'])

    performUndo(useStore.getState())
    expect(useStore.getState().meshOverrides[uuid].softZones.map((z) => z.name)).toEqual(['Sleeve'])
  })

  it('still clears the target when none of the source\'s parts match it', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    target.meshes[0].name = 'Other'
    const uuid = target.meshes[0].uuid
    useStore.setState((st) => ({
      meshOverrides: { ...st.meshOverrides, [uuid]: { softZones: [{ id: 'mine', name: 'Sleeve', mode: 'soft', enabled: true, stiffness: 0.9, damping: 0.1, area: { kind: 'all' } }] } },
    }))
    const result = copyMeshPhysicsFromCharacter('source', { replace: true })
    expect(result.removed).toBe(1)
    expect(useStore.getState().meshOverrides[uuid]?.softZones || []).toHaveLength(0)
  })

  it('mesh-to-mesh replace only touches that part', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    const own = applyPartRig(target, target.meshes[0], topFaces(target.meshes[0]), { segments: 2 }, { label: 'Cape' })
    expect(own.ok).toBe(true)
    const result = copyAddedBonesFromMesh('source', source.meshes[0], target.meshes[0], { replace: true })
    expect(result.removed).toEqual(['Cape'])
    expect(getPartRigEntries(getCurrentModel()).map((e) => e.label)).toEqual(['Hair'])
  })
})

describe('reset bone physics (reapply Add bones groups)', () => {
  it('rebuilds each group from its own settings and keeps its dangle chains attached, in one undo step', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    const own = applyPartRig(target, target.meshes[0], topFaces(target.meshes[0]), { segments: 2 }, { label: 'Cape' })
    expect(own.ok).toBe(true)
    useStore.setState({
      dangleEnabled: true,
      dangleChains: [{ id: 'own', name: 'Cape', boneNames: own.entry.boneNames, type: 'dangle', stiffness: 0.5, gravity: 1, damping: 0.4, groupId: own.entry.id, groupName: 'Cape' }],
    })

    const result = reapplyAddBonesGroups()
    expect(result).toEqual({ updated: 1, chainsOnly: 0 })
    const entries = getPartRigEntries(getCurrentModel())
    expect(entries).toHaveLength(1)
    expect(entries[0].label).toBe('Cape')
    const chains = useStore.getState().dangleChains
    expect(chains).toHaveLength(1)
    expect(chains[0].boneNames).toEqual(entries[0].boneNames)
    expect(chains[0].stiffness).toBe(0.5)
    expect(chains[0].groupId).toBe(entries[0].id)

    performUndo(useStore.getState())
    expect(getPartRigEntries(getCurrentModel())).toHaveLength(1)
  })

  it('does nothing when there are no groups', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    expect(reapplyAddBonesGroups()).toEqual({ updated: 0, chainsOnly: 0 })
  })
})

describe('physics bone names (for hiding dangle & cloth bones)', () => {
  it('covers Add bones group bones even with no dangle chain, plus every chain\'s bones', () => {
    seed(new THREE.BoxGeometry(2, 5, 2, 2, 2, 2))
    const own = applyPartRig(target, target.meshes[0], topFaces(target.meshes[0]), { segments: 2 }, { label: 'Cape' })
    expect(own.ok).toBe(true)
    const names = getPhysicsBoneNames([{ id: 'c', type: 'cloth', boneNames: ['SomeClothBone'] }])
    own.entry.boneNames.forEach((n) => expect(names.has(n)).toBe(true))
    expect(names.has('SomeClothBone')).toBe(true)
  })
})
