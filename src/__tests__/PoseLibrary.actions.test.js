import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { makeHandRig } from './helpers/syntheticHand.js'

// The actions run against a real synthetic character; only the pieces that need the live scene are stubbed.
const h = { rigR: null, rigL: null, bones: [], rest: new Map(), undo: [], before: null }

vi.mock('../three/posing.js', () => ({
  getPoseBones: () => h.bones,
  getBoneRestQuaternion: (b) => h.rest.get(b)?.clone() ?? null,
  getPose: () => ({ format: 'pose-v1', bones: Object.fromEntries(h.bones.map((b) => [b.name, [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]])) }),
  applyPose: (json) => {
    let applied = 0
    const missing = []
    for (const [name, q] of Object.entries(json.bones)) {
      const bone = h.bones.find((b) => b.name === name)
      if (!bone) { missing.push(name); continue }
      bone.quaternion.set(...q); applied++
    }
    h.undo.push('apply')
    return { applied, missing }
  },
  setBonesLive: (map) => { for (const [n, q] of Object.entries(map)) h.bones.find((b) => b.name === n)?.quaternion.set(...q) },
  beginBonesAdjust: (names) => { h.before = names },
  endBonesAdjust: () => { h.undo.push('slider'); return 1 },
}))
vi.mock('../three/scene.js', () => ({ importBVHAuto: vi.fn() }))
vi.mock('../three/animation.js', () => ({
  poseFromBVHText: vi.fn(), stop: vi.fn(), exportClipJSON: vi.fn(), importClipJSON: vi.fn(), selectClip: vi.fn(),
}))

const actions = await import('../three/poseLibraryActions.js')
const { useStore } = await import('../store.js')
const bone = (name) => h.bones.find((b) => b.name === name)
const angle = (name) => h.rest.get(bone(name)).angleTo(bone(name).quaternion)

beforeEach(() => {
  h.rigR = makeHandRig({ side: 'R', seed: 3, names: 'mixamo' })
  h.rigL = makeHandRig({ side: 'L', seed: 4, names: 'mixamo' })
  // one character with both hands: reuse the right rig's bones plus the left hand chain under its spine
  const left = h.rigL.hand.parent
  const spine = h.rigR.hips.children[0]
  spine.add(left)
  left.position.set(0.3, 0.2, 0)
  h.rigR.hips.updateWorldMatrix(false, true)
  h.bones = h.rigR.bones.concat(h.rigL.bones.filter((b) => b.name !== 'mixamorig:Hips' && b.name !== 'mixamorig:Spine'))
  h.rest = new Map(h.bones.map((b) => [b, b.quaternion.clone()]))
  h.undo = []
  actions.clearHandCache()
  useStore.setState({ playback: 'stopped' })
})

describe('hand poses', () => {
  const fist = actions.BASIC_HANDS.find((b) => b.id === 'fist')
  it('a basic fist on the right hand leaves the left hand alone', async () => {
    await actions.applyHandEntry({ ...fist, source: 'basic' }, { side: 'R' })
    expect(angle('mixamorig:RightHandIndex1')).toBeGreaterThan(0.5)
    expect(angle('mixamorig:LeftHandIndex1')).toBe(0)
  })
  it('both hands get it, and strength scales it', async () => {
    await actions.applyHandEntry({ ...fist, source: 'basic' }, { side: 'both', amount: 0.5 })
    const half = angle('mixamorig:RightHandIndex2')
    expect(angle('mixamorig:LeftHandIndex2')).toBeCloseTo(half, 5)
    await actions.applyHandEntry({ ...fist, source: 'basic' }, { side: 'both', amount: 1 })
    expect(angle('mixamorig:RightHandIndex2')).toBeGreaterThan(half * 1.5)
  })
  it('a saved right hand goes onto the left hand too', async () => {
    await actions.applyHandEntry({ ...fist, source: 'basic' }, { side: 'R' })
    const saved = await actions.saveCurrentHandPose('R', 'Tight')
    expect(saved.name).toBe('Tight')
    expect(saved.thumb.segs.length).toBeGreaterThan(5)
    await actions.applyHandEntry({ ...saved, source: 'mine' }, { side: 'L' })
    expect(angle('mixamorig:LeftHandMiddle1')).toBeCloseTo(angle('mixamorig:RightHandMiddle1'), 4)
  })
  it('says so when the character has no fingers', async () => {
    h.bones = h.bones.filter((b) => !/Hand\w+\d/.test(b.name)); actions.clearHandCache()
    await expect(actions.applyHandEntry({ ...fist, source: 'basic' })).rejects.toThrow(/no finger bones/)
  })
})

describe('body poses', () => {
  it('apply a saved pose but keep the fingers when asked', async () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 0, 0))
    const bones = { 'mixamorig:Spine': [q.x, q.y, q.z, q.w], 'mixamorig:RightHandIndex1': [q.x, q.y, q.z, q.w] }
    await actions.applyBodyEntry({ source: 'mine', name: 'Lean', data: { bones } }, { keepHands: true })
    expect(angle('mixamorig:Spine')).toBeGreaterThan(0.4)
    expect(angle('mixamorig:RightHandIndex1')).toBe(0)
    await actions.applyBodyEntry({ source: 'mine', name: 'Lean', data: { bones } }, { keepHands: false })
    expect(angle('mixamorig:RightHandIndex1')).toBeGreaterThan(0.4)
  })
  it('stops playback first so the pose is not overwritten', async () => {
    const { stop } = await import('../three/animation.js')
    useStore.setState({ playback: 'playing' })
    await actions.applyBodyEntry({ source: 'mine', name: 'x', data: { bones: {} } })
    expect(stop).toHaveBeenCalled()
    expect(useStore.getState().playback).toBe('stopped')
  })
  it('saves the current pose with a thumbnail', async () => {
    const e = await actions.saveCurrentBodyPose('Idle')
    expect(e.kind).toBe('body')
    expect(Object.keys(e.data.bones)).toContain('mixamorig:Hips')
    expect(e.thumb.segs.length).toBeGreaterThan(3)
  })
})

describe('sliders', () => {
  it('a drag is live and lands as one undo entry', () => {
    actions.beginHandAdjust('both')
    expect(h.before.length).toBe(30)
    actions.setHandCurl('both', { thumb: 1, index: 1, middle: 1, ring: 1, pinky: 1 }, 0)
    actions.setHandCurl('both', { thumb: 0.5, index: 0.5, middle: 0.5, ring: 0.5, pinky: 0.5 }, 0)
    expect(h.undo).toEqual([])
    actions.endHandAdjust()
    expect(h.undo).toEqual(['slider'])
    expect(angle('mixamorig:LeftHandRing2')).toBeGreaterThan(0.2)
  })
})

describe('animations', () => {
  it('a saved clip is added, armed and its keyframes requested', async () => {
    const anim = await import('../three/animation.js')
    anim.importClipJSON.mockReturnValue('Walk')
    anim.selectClip.mockReturnValue(2.5)
    const r = await actions.applyAnimationEntry({ source: 'mine', name: 'Walk', data: { clip: {} } })
    expect(r.name).toBe('Walk')
    const s = useStore.getState()
    expect(s.activeClipName).toBe('Walk')
    expect(s.playback).toBe('paused')
    expect(s.adoptClipRequest).toBe('Walk')
  })
  it('a preset is imported as a BVH with a name that does not clash', async () => {
    const scene = await import('../three/scene.js')
    scene.importBVHAuto.mockResolvedValue({ name: 'Run (2)' })
    useStore.setState({ importedClipNames: ['Run'] })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => 'HIERARCHY' })
    const r = await actions.applyAnimationEntry({ source: 'preset', id: 'preset:animation/run.bvh', name: 'Run', url: '/x.bvh' })
    expect(scene.importBVHAuto.mock.calls[0][0].name).toBe('Run (2).bvh')
    expect(r.name).toBe('Run (2)')
  })
})
