import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import {
  initDangle,
  setDangleConfig,
  clearDangle,
  stepDangleLive,
  addDangleChainUndoable,
  getDangleChainsForRig,
  groupDangleChainsByRig,
  regroupRigChainsUndoable,
  updateDangleChainsUndoable,
} from '../three/dangle.js'
import { performUndo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

const state = () => useStore.getState()

describe('Add bones groups keep their own chains', () => {
  // Two separate rigs that were both created with the default label "Cape" (one of them is really the shorts).
  const capeRig = { id: 'rig_a', label: 'Cape', boneNames: ['Cape_1', 'Cape_2'], rootBoneNames: ['Cape_1'] }
  const shortsRig = { id: 'rig_b', label: 'Cape', boneNames: ['Cape_3', 'Cape_4'], rootBoneNames: ['Cape_3'] }
  const chains = [
    { id: 'c1', name: 'Cape', boneNames: ['Cape_1', 'Cape_2'], groupId: 'rig_a', groupName: 'Cape' },
    { id: 'c2', name: 'Cape', boneNames: ['Cape_3', 'Cape_4'], groupId: 'rig_b', groupName: 'Cape' },
  ]

  it('only takes the chains of the rig being renamed, even when both rigs share a name', () => {
    expect(getDangleChainsForRig(chains, shortsRig, [capeRig, shortsRig]).map((c) => c.id)).toEqual(['c2'])
    expect(getDangleChainsForRig(chains, capeRig, [capeRig, shortsRig]).map((c) => c.id)).toEqual(['c1'])
  })

  it('does not guess by name for untagged chains when another rig could own that name', () => {
    const loose = [{ id: 'x', name: 'Cape 1', boneNames: ['stale'] }]
    expect(getDangleChainsForRig(loose, shortsRig, [capeRig, shortsRig])).toEqual([])
    expect(groupDangleChainsByRig(loose, [capeRig, shortsRig])).toEqual([{ id: 'x', chains: [loose[0]] }])
  })

  it('shows each rig as its own group', () => {
    const sections = groupDangleChainsByRig(chains, [capeRig, shortsRig])
    expect(sections.map((s) => [s.groupId, s.chains.map((c) => c.id)])).toEqual([['rig_a', ['c1']], ['rig_b', ['c2']]])
  })
})

describe('renaming a rig regroups and retargets only its chains', () => {
  beforeEach(() => {
    clearUndoHistory()
    useStore.setState({ activeCharacterId: 1, characters: {}, dangleEnabled: true, dangleChains: [] })
  })

  it('renames the group, the chain and its bones, leaves the other rig alone, and undoes', () => {
    addDangleChainUndoable('Cape 1', ['Cape_1', 'Cape_2'], 'dangle', { id: 'rig_a', name: 'Cape' })
    addDangleChainUndoable('Cape 2', ['Cape_3', 'Cape_4'], 'dangle', { id: 'rig_b', name: 'Cape' })
    const [a, b] = state().dangleChains
    const oldRig = { id: 'rig_b', label: 'Cape', boneNames: ['Cape_3', 'Cape_4'], rootBoneNames: ['Cape_3'] }
    const newRig = { id: 'rig_b', label: 'Shorts', boneNames: ['Shorts_1', 'Shorts_2'], rootBoneNames: ['Shorts_1'] }
    regroupRigChainsUndoable([b.id], { id: 'rig_b', name: 'Shorts' }, oldRig, newRig, () => [])
    const after = state().dangleChains
    expect(after[0]).toEqual(a)
    expect(after[1]).toMatchObject({ name: 'Shorts 2', boneNames: ['Shorts_1', 'Shorts_2'], groupId: 'rig_b', groupName: 'Shorts' })
    performUndo(state())
    expect(state().dangleChains[1]).toMatchObject({ name: 'Cape 2', boneNames: ['Cape_3', 'Cape_4'], groupName: 'Cape' })
  })

  it('rebuilds chains from the new root bones when the bone count changed', () => {
    addDangleChainUndoable('Cape', ['Cape_1', 'Cape_2'], 'dangle', { id: 'rig_a', name: 'Cape' })
    const id = state().dangleChains[0].id
    const oldRig = { id: 'rig_a', label: 'Cape', boneNames: ['Cape_1', 'Cape_2'], rootBoneNames: ['Cape_1'] }
    const newRig = { id: 'rig_a', label: 'Cape', boneNames: ['Cape_1', 'Cape_2', 'Cape_3'], rootBoneNames: ['Cape_1'] }
    regroupRigChainsUndoable([id], { id: 'rig_a', name: 'Cape' }, oldRig, newRig, (root) => [root, 'Cape_2', 'Cape_3'])
    expect(state().dangleChains[0].boneNames).toEqual(['Cape_1', 'Cape_2', 'Cape_3'])
  })

  it('updates several chains in one undo step', () => {
    addDangleChainUndoable('A', ['a1'], 'dangle', { id: 'g', name: 'G' })
    addDangleChainUndoable('B', ['b1'], 'dangle', { id: 'g', name: 'G' })
    const ids = state().dangleChains.map((c) => c.id)
    updateDangleChainsUndoable(ids, { stiffness: 0.9, bounce: 2 })
    expect(state().dangleChains.map((c) => [c.stiffness, c.bounce])).toEqual([[0.9, 2], [0.9, 2]])
    performUndo(state())
    expect(state().dangleChains.map((c) => c.stiffness)).toEqual([0.15, 0.15])
  })
})

describe('extra dangle feel settings', () => {
  function rig() {
    const root = new THREE.Group()
    const hips = new THREE.Bone()
    hips.name = 'hips'
    hips.position.set(0, 1, 0)
    root.add(hips)
    const bones = [hips]
    let parent = hips
    for (let i = 0; i < 4; i++) {
      const b = new THREE.Bone()
      b.name = `c${i}`
      b.position.set(0, -0.1, 0)
      parent.add(b)
      parent = b
      bones.push(b)
    }
    root.updateMatrixWorld(true)
    return { root, bones, meshes: [], hips }
  }
  const run = (extra, frames = 40) => {
    clearDangle(7)
    initDangle({ requestRender: () => {} })
    const r = rig()
    setDangleConfig(7, r, true, [{ id: 'k', name: 'k', boneNames: ['c0', 'c1', 'c2', 'c3'], stiffness: 0.1, gravity: 1, damping: 0.4, ...extra }])
    for (let f = 0; f < frames; f++) {
      r.hips.position.x = Math.sin(f / 5) * 0.4
      r.hips.rotation.z = Math.sin(f / 5) * 0.5
      r.root.updateMatrixWorld(true)
      stepDangleLive(1 / 60)
    }
    return r
  }
  const swing = (r) => Math.max(...r.bones.slice(1).map((b) => b.quaternion.angleTo(new THREE.Quaternion())))

  it('swing limit caps how far a bone can turn', () => {
    const free = swing(run({}))
    const limited = swing(run({ swingLimit: 10 }))
    expect(free).toBeGreaterThan(THREE.MathUtils.degToRad(10) * 1.5)
    expect(limited).toBeLessThanOrEqual(THREE.MathUtils.degToRad(10) + 0.02 + 0.5 * 0) // local turn stays near the limit
  })

  it('rigid top keeps the top bone on the pose', () => {
    const r = run({ holdTop: 0.8 })
    expect(r.bones[1].quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(0.02)
  })

  it('body reaction makes it trail behind a body that moves sideways', () => {
    const lag = (extra) => {
      clearDangle(7)
      initDangle({ requestRender: () => {} })
      const r = rig()
      setDangleConfig(7, r, true, [{ id: 'k', name: 'k', boneNames: ['c0', 'c1', 'c2', 'c3'], stiffness: 0.1, gravity: 0, damping: 0.4, ...extra }])
      let worst = 0
      for (let f = 0; f < 40; f++) {
        r.hips.position.x = f * 0.03 // steady sideways travel, no turning
        r.root.updateMatrixWorld(true)
        stepDangleLive(1 / 60)
        r.root.updateMatrixWorld(true)
        const tip = r.bones[4].getWorldPosition(new THREE.Vector3())
        worst = Math.max(worst, Math.abs(tip.x - r.hips.position.x))
      }
      return worst
    }
    expect(lag({ reaction: 0 })).toBeLessThan(0.01)
    expect(lag({ reaction: 1 })).toBeGreaterThan(0.05)
  })

  it('defaults leave the old behaviour unchanged', () => {
    const a = run({})
    const b = run({ bounce: 1, reaction: 0, swingLimit: 180, holdTop: 0 })
    a.bones.forEach((bone, i) => expect(bone.quaternion.angleTo(b.bones[i].quaternion)).toBeLessThan(1e-9))
  })
})
