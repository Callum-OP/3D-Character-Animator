import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import {
  initDangle,
  setDangleConfig,
  clearDangle,
  editDangle,
  setDangleEnabledUndoable,
  addDangleChainUndoable,
  removeDangleChainUndoable,
  updateDangleChainUndoable,
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
