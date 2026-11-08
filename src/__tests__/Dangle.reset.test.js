import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initAnimation, setAnimationModel, selectClip, play, updateAnimation } from '../three/animation.js'
import {
  initDangle,
  setDangleConfig,
  resetDanglePose,
  stepDangleLive,
  clearDangle,
  addDangleChainUndoable,
  rebuildRigChainsUndoable,
  setDangleEnabledUndoable,
} from '../three/dangle.js'
import { performUndo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

const state = () => useStore.getState()

describe('looping animation tells the scene when it wraps', () => {
  function model() {
    const root = new THREE.Group()
    const hips = new THREE.Bone()
    hips.name = 'Hips'
    root.add(hips)
    const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
    mesh.bind(new THREE.Skeleton([hips]))
    root.add(mesh)
    const track = new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 0, 0, 0, 0, 1])
    return { root, bones: [hips], skinnedMeshes: [mesh], meshes: [], skeleton: mesh.skeleton, clips: [new THREE.AnimationClip('Walk', 1, [track])], info: {} }
  }
  function setup(loop) {
    const onLoop = vi.fn()
    initAnimation({
      requestRender() {}, setContinuousRender() {}, suspendPosing() {}, resumePosing() {},
      onTime() {}, onEnded() {}, onCameraCut() {}, getObjectByUuid: () => null, onLoop,
    })
    setAnimationModel(model(), 5)
    selectClip('Walk', { loop })
    play()
    return onLoop
  }

  it('reports each wrap of a looping clip once, after the frame has been applied', () => {
    const onLoop = setup(true)
    updateAnimation(0.9)
    expect(onLoop).not.toHaveBeenCalled()
    updateAnimation(0.2)
    expect(onLoop).toHaveBeenCalledTimes(1)
    expect(onLoop).toHaveBeenCalledWith(5)
    updateAnimation(0.2)
    expect(onLoop).toHaveBeenCalledTimes(1)
    updateAnimation(0.9)
    expect(onLoop).toHaveBeenCalledTimes(2)
  })

  it('does not report anything for a clip that is not looping', () => {
    const onLoop = setup(false)
    updateAnimation(0.9)
    updateAnimation(0.5)
    expect(onLoop).not.toHaveBeenCalled()
  })
})

describe('Reset dangle poses rebuilds the Add bones chains', () => {
  const rigs = [
    { id: 'rig_a', label: 'Cape', boneNames: ['Cape_1', 'Cape_2', 'Cape_3'], rootBoneNames: ['Cape_1'] },
    { id: 'rig_b', label: 'Shorts', boneNames: ['Shorts_1', 'Shorts_2'], rootBoneNames: ['Shorts_1'] },
  ]
  const descend = (root) => (root === 'Cape_1' ? ['Cape_1', 'Cape_2', 'Cape_3'] : ['Shorts_1', 'Shorts_2'])

  beforeEach(() => {
    clearUndoHistory()
    clearDangle(1)
    initDangle({ requestRender: () => {} })
    useStore.setState({ activeCharacterId: 1, characters: {}, dangleEnabled: true, dangleChains: [] })
  })

  it('drops custom settings and stale bones, keeps groups, leaves hand-made chains alone, and undoes', () => {
    addDangleChainUndoable('Cape', ['Cape_1'], 'cloth', { id: 'rig_a', name: 'Cape' }) // stale bone list, custom type
    addDangleChainUndoable('Shorts', ['Shorts_1', 'Shorts_2'], 'dangle', { id: 'rig_b', name: 'Shorts' })
    addDangleChainUndoable('Tail', ['tail1', 'tail2'])
    const [cape, shorts, tail] = state().dangleChains
    expect(rebuildRigChainsUndoable(rigs, descend)).toBe(2)
    const after = state().dangleChains
    expect(after).toHaveLength(3)
    expect(after[0]).toMatchObject({ name: 'Cape', boneNames: ['Cape_1', 'Cape_2', 'Cape_3'], type: 'dangle', stiffness: 0.15, groupId: 'rig_a', groupName: 'Cape' })
    expect(after[0].id).not.toBe(cape.id)
    expect(after[1]).toMatchObject({ groupId: 'rig_b', boneNames: ['Shorts_1', 'Shorts_2'] })
    expect(after[2]).toEqual(tail)
    performUndo(state())
    expect(state().dangleChains.map((c) => c.id)).toEqual([cape.id, shorts.id, tail.id])
  })

  it('skips rigs that have no chains and does nothing when no rig has any', () => {
    addDangleChainUndoable('Tail', ['tail1'])
    expect(rebuildRigChainsUndoable(rigs, descend)).toBe(0)
    expect(state().dangleChains).toHaveLength(1)
  })

  it('dangle physics can be switched off and on, and undone', () => {
    setDangleEnabledUndoable(false)
    expect(state().dangleEnabled).toBe(false)
    performUndo(state())
    expect(state().dangleEnabled).toBe(true)
  })
})

describe('snapping dangle bones when the clip loops', () => {
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
      b.name = `h${i}`
      b.position.set(0, -0.1, 0)
      parent.add(b)
      parent = b
      bones.push(b)
    }
    root.updateMatrixWorld(true)
    return { root, bones, meshes: [], hips }
  }
  const tipDrop = (snap) => {
    clearDangle(9)
    initDangle({ requestRender: () => {} })
    const r = rig()
    setDangleConfig(9, r, true, [{ id: 'h', name: 'h', boneNames: ['h0', 'h1', 'h2', 'h3'], stiffness: 0.05, gravity: 1, damping: 0.9 }])
    const step = () => { r.root.updateMatrixWorld(true); stepDangleLive(1 / 60) }
    r.hips.rotation.z = Math.PI // last frame of the clip: upside down, hair hanging "up" in the pose
    for (let i = 0; i < 90; i++) step()
    r.hips.rotation.z = 0 // the loop: first frame is upright again
    r.root.updateMatrixWorld(true)
    if (snap) resetDanglePose(9)
    step()
    const tip = r.bones[4].getWorldPosition(new THREE.Vector3())
    return tip.y // upright and relaxed the tip hangs about 0.6 below the hips (y ~ 0.6)
  }
  it('starts the next loop hanging properly instead of flying up from the last frame', () => {
    expect(tipDrop(true)).toBeLessThan(0.7)
    expect(tipDrop(false)).toBeGreaterThan(tipDrop(true))
  })
})
