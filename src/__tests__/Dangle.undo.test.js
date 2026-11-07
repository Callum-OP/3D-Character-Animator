import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import {
  initDangle,
  setDangleConfig,
  clearDangle,
  editDangle,
  setDangleEnabledUndoable,
  setAllDangleCollisionsUndoable,
  addDangleChainUndoable,
  groupDangleChainsUndoable,
  removeDangleChainUndoable,
  updateDangleChainUndoable,
  groupDangleChainsByRig,
  stepDangleLive,
} from '../three/dangle.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

function makeModel() {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'hips'
  const a = new THREE.Bone()
  a.name = 'tail1'
  a.position.set(0, 0.2, 0)
  const b = new THREE.Bone()
  b.name = 'tail2'
  b.position.set(0, 0.2, 0)
  hips.add(a)
  a.add(b)
  root.add(hips)
  root.updateMatrixWorld(true)
  return { root, bones: [hips, a, b] }
}

const state = () => useStore.getState()
let model

beforeEach(() => {
  clearUndoHistory()
  clearDangle(1)
  clearDangle(2)
  initDangle({ requestRender: () => {} })
  model = makeModel()
  useStore.setState({ activeCharacterId: 1, characters: {}, dangleEnabled: true, dangleChains: [] })
  setDangleConfig(1, model, true, [])
})

describe('dangle edits are undo steps', () => {
  it('groups existing untagged chains by the Add Bones rig bones they use', () => {
    const chains = [
      { id: 'cape-1', name: 'Cape 1', boneNames: ['Cape_root', 'Cape_1'] },
      { id: 'tail', name: 'Tail', boneNames: ['tail1', 'tail2'] },
      { id: 'cape-2', name: 'Cape 2', boneNames: ['Cape_side', 'Cape_tip'] },
      { id: 'cape-tagged', name: 'Cape 3', groupId: 'rig-cape', groupName: 'Old cape name', boneNames: [] },
    ]
    const rigs = [{ id: 'rig-cape', label: 'Cape (edited)', boneNames: ['Cape_root', 'Cape_1', 'Cape_side', 'Cape_tip'] }]
    expect(groupDangleChainsByRig(chains, rigs)).toEqual([
      { id: 'rig-cape', groupId: 'rig-cape', name: 'Cape (edited)', chains: [chains[0], chains[2], chains[3]] },
      { id: 'tail', chains: [chains[1]] },
    ])
  })

  it('adding and removing a chain', () => {
    addDangleChainUndoable('tail', ['tail1', 'tail2'])
    expect(state().dangleChains).toHaveLength(1)
    const id = state().dangleChains[0].id
    removeDangleChainUndoable(id)
    expect(state().dangleChains).toHaveLength(0)
    performUndo(state())
    expect(state().dangleChains.map((c) => c.id)).toEqual([id])
    performUndo(state())
    expect(state().dangleChains).toHaveLength(0)
    performRedo(state())
    expect(state().dangleChains).toHaveLength(1)
  })

  it('creates a rigged-cloth chain with its own starting settings', () => {
    addDangleChainUndoable('cape', ['cape1', 'cape2'], 'cloth')
    expect(state().dangleChains[0]).toMatchObject({
      type: 'cloth',
      stiffness: 0.4,
      gravity: 0.35,
      damping: 0.55,
      collideWithBones: false,
      collideWithMesh: false,
    })
    performUndo(state())
    expect(state().dangleChains).toHaveLength(0)
    performRedo(state())
    expect(state().dangleChains[0].type).toBe('cloth')
  })

  it('keeps Add Bones chains in their source rig group through undo and redo', () => {
    const group = { id: 'rig_cape', name: 'Cape' }
    addDangleChainUndoable('Cape 1', ['cape1'], 'dangle', group)
    addDangleChainUndoable('Cape 2', ['cape2'], 'dangle', group)
    expect(state().dangleChains.map((chain) => [chain.groupId, chain.groupName])).toEqual([
      ['rig_cape', 'Cape'],
      ['rig_cape', 'Cape'],
    ])
    performUndo(state())
    performUndo(state())
    expect(state().dangleChains).toHaveLength(0)
    performRedo(state())
    performRedo(state())
    expect(state().dangleChains.map((chain) => chain.groupId)).toEqual(['rig_cape', 'rig_cape'])
  })

  it('associates pre-existing rig chains with the rig when it is edited', () => {
    addDangleChainUndoable('Cape 1', ['Cape_1', 'Cape_2'])
    addDangleChainUndoable('Tail', ['tail1', 'tail2'])
    const rigBones = new Set(['Cape_1', 'Cape_2'])
    const chainIds = state().dangleChains
      .filter((chain) => chain.boneNames.some((name) => rigBones.has(name)))
      .map((chain) => chain.id)
    groupDangleChainsUndoable(chainIds, { id: 'rig-cape', name: 'Renamed cape' })
    const sections = groupDangleChainsByRig(state().dangleChains, [{ id: 'rig-cape', label: 'Renamed cape', boneNames: ['NewCape_1'] }])
    expect(sections[0]).toMatchObject({ groupId: 'rig-cape', name: 'Renamed cape', chains: [{ name: 'Cape 1' }] })
    expect(sections).toHaveLength(2)
    performUndo(state())
    expect(state().dangleChains[0].groupId).toBeUndefined()
    performRedo(state())
    expect(state().dangleChains[0].groupId).toBe('rig-cape')
  })

  it('mesh collision deflects a bone chain while leaving collision disabled by default', () => {
    function makeMeshCollisionModel() {
      const root = new THREE.Group()
      const hips = new THREE.Bone()
      hips.name = 'hips'
      const tail = new THREE.Bone()
      tail.name = 'tail'
      tail.position.set(-0.1, 0, 0)
      const tip = new THREE.Bone()
      tip.name = 'tip'
      tip.position.set(0.2, 0.2, 0)
      hips.add(tail)
      tail.add(tip)
      root.add(hips)
      const barrier = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
      )
      barrier.rotation.y = -Math.PI / 2
      root.add(barrier)
      root.updateMatrixWorld(true)
      return { root, bones: [hips, tail, tip], meshes: [barrier], tail }
    }

    const plain = makeMeshCollisionModel()
    const colliding = makeMeshCollisionModel()
    setDangleConfig(1, plain, true, [{ id: 'plain', boneNames: ['tail', 'tip'], stiffness: 0.15, gravity: 1, damping: 0.8 }])
    setDangleConfig(2, colliding, true, [{
      id: 'mesh',
      boneNames: ['tail', 'tip'],
      stiffness: 0.15,
      gravity: 1,
      damping: 0.8,
      collideWithMesh: true,
    }])

    stepDangleLive(1 / 60)

    expect(plain.tail.quaternion.angleTo(colliding.tail.quaternion)).toBeGreaterThan(0.01)
  })

  it('other-bone collision deflects a chain when enabled', () => {
    const plain = makeModel()
    const colliding = makeModel()
    const obstacleBase = new THREE.Bone()
    obstacleBase.name = 'obstacleBase'
    obstacleBase.position.set(0.01, 0.35, 0)
    const obstacle = new THREE.Bone()
    obstacle.name = 'obstacle'
    obstacle.position.set(0, 0.1, 0)
    obstacleBase.add(obstacle)
    colliding.root.add(obstacleBase)
    colliding.root.updateMatrixWorld(true)
    colliding.bones.push(obstacleBase, obstacle)

    const chain = { id: 'tail', boneNames: ['tail1', 'tail2'], stiffness: 0.15, gravity: 1, damping: 0.8 }
    setDangleConfig(1, plain, true, [chain])
    setDangleConfig(2, colliding, true, [{ ...chain, collideWithBones: true }])

    stepDangleLive(1 / 60)

    const plainTail = plain.bones.find((bone) => bone.name === 'tail1')
    const collidingTail = colliding.bones.find((bone) => bone.name === 'tail1')
    expect(plainTail.quaternion.angleTo(collidingTail.quaternion)).toBeGreaterThan(0.01)
  })

  it('a slider drag is one step; an edit straight after an undo is not lost', () => {
    addDangleChainUndoable('tail', ['tail1', 'tail2'])
    const id = state().dangleChains[0].id
    for (const v of [0.3, 0.4, 0.5]) updateDangleChainUndoable(id, { stiffness: v })
    expect(state().dangleChains[0].stiffness).toBe(0.5)
    performUndo(state())
    expect(state().dangleChains[0].stiffness).toBe(0.15) // the whole drag
    updateDangleChainUndoable(id, { stiffness: 0.9 })
    expect(state().dangleChains[0].stiffness).toBe(0.9)
    performUndo(state())
    expect(state().dangleChains[0].stiffness).toBe(0.15)
    performRedo(state())
    expect(state().dangleChains[0].stiffness).toBe(0.9)
  })

  it('different settings are different steps', () => {
    addDangleChainUndoable('tail', ['tail1', 'tail2'])
    const id = state().dangleChains[0].id
    updateDangleChainUndoable(id, { gravity: 2 })
    updateDangleChainUndoable(id, { damping: 0.2 })
    performUndo(state())
    expect(state().dangleChains[0].damping).toBe(0.8)
    expect(state().dangleChains[0].gravity).toBe(2)
    performUndo(state())
    expect(state().dangleChains[0].gravity).toBe(1)
  })

  it('the master switch', () => {
    setDangleEnabledUndoable(false)
    expect(state().dangleEnabled).toBe(false)
    performUndo(state())
    expect(state().dangleEnabled).toBe(true)
    performRedo(state())
    expect(state().dangleEnabled).toBe(false)
    setDangleEnabledUndoable(false) // already off: nothing recorded
    performUndo(state())
    expect(state().dangleEnabled).toBe(true)
  })

  it('toggles all three collision settings on every chain as one undo step', () => {
    addDangleChainUndoable('tail', ['tail1', 'tail2'])
    addDangleChainUndoable('hair', ['tail1'])
    updateDangleChainUndoable(state().dangleChains[0].id, { collideWithMesh: true })

    setAllDangleCollisionsUndoable(true)
    expect(state().dangleChains).toEqual([
      expect.objectContaining({ collideWithBones: true, collideWithMesh: true, collideWithSelf: true }),
      expect.objectContaining({ collideWithBones: true, collideWithMesh: true, collideWithSelf: true }),
    ])
    performUndo(state())
    expect(state().dangleChains[0]).toMatchObject({
      collideWithBones: false,
      collideWithMesh: true,
      collideWithSelf: false,
    })
    expect(state().dangleChains[1]).toMatchObject({
      collideWithBones: false,
      collideWithMesh: false,
      collideWithSelf: false,
    })

    setAllDangleCollisionsUndoable(true)
    performUndo(state())
    setAllDangleCollisionsUndoable(false)
    expect(state().dangleChains.every((chain) =>
      chain.collideWithBones === false && chain.collideWithMesh === false && chain.collideWithSelf === false,
    )).toBe(true)
  })

  it('a character that is not the active one is edited and undone in its own settings', () => {
    addDangleChainUndoable('tail', ['tail1', 'tail2'])
    const chains = state().dangleChains
    // switch to a second character: the first one's settings move to the roster
    useStore.setState({
      activeCharacterId: 2,
      dangleChains: [],
      dangleEnabled: true,
      characters: { 1: { dangleChains: chains, dangleEnabled: true } },
    })
    editDangle(1, (d) => ({ ...d, chains: d.chains.map((c) => ({ ...c, gravity: 3 })) }), { discrete: true })
    expect(state().characters[1].dangleChains[0].gravity).toBe(3)
    expect(state().dangleChains).toEqual([]) // the active character was not touched
    performUndo(state())
    expect(state().characters[1].dangleChains[0].gravity).toBe(1)
    expect(state().dangleChains).toEqual([])
  })
})
