import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import { initPosing, setPoseModel, selectBones, getBoneFramingBounds } from '../three/posing.js'
import { getFramingTarget } from '../three/scene.js'
import { useStore } from '../store.js'

// Hips ─ Spine ─ Chest ─ Head ─┬ HeadTop (near)
//                              └ Stray (a far-away child, like a second skeleton's root)
//        └ UpLeg ─ Leg (a long single child)
function rig() {
  const mk = (name, x, y, z, parent) => { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); parent && parent.add(b); return b }
  const root = new THREE.Group()
  const hips = mk('Hips', 0, 1, 0, root)
  const spine = mk('Spine', 0, 0.2, 0, hips)
  const chest = mk('Chest', 0, 0.2, 0, spine)
  const head = mk('Head', 0, 0.2, 0, chest)
  const top = mk('HeadTop', 0, 0.2, 0, head)
  const stray = mk('Stray', 0, -1.6, 0, head)
  const up = mk('UpLeg', 0.1, -0.05, 0, hips)
  const leg = mk('Leg', 0, -0.45, 0, up)
  root.updateMatrixWorld(true)
  return { root, bones: [hips, spine, chest, head, top, stray, up, leg] }
}

describe('framing a selected joint', () => {
  beforeEach(() => {
    const scene = new THREE.Scene()
    initPosing({ scene, camera: new THREE.PerspectiveCamera(), renderer: { domElement: document.createElement('canvas') }, controls: { enabled: true, locked: false }, requestRender: () => {} })
    const r = rig()
    scene.add(r.root)
    setPoseModel({ bones: r.bones, root: r.root })
  })

  it('is null when nothing is selected', () => {
    expect(getBoneFramingBounds([])).toBeNull()
    expect(getBoneFramingBounds()).toBeNull()
  })

  it('covers the joint, the bone above it and its nearby children', () => {
    const box = getBoneFramingBounds(['Head'])
    expect(box.min.y).toBeCloseTo(1.4, 2) // Chest (the parent)
    expect(box.max.y).toBeCloseTo(1.8, 2) // HeadTop
  })

  it('ignores a stray child bone far away from the joint', () => {
    const box = getBoneFramingBounds(['Head'])
    expect(box.getSize(new THREE.Vector3()).y).toBeLessThan(0.6) // not stretched down to the stray at y≈0
  })

  it('still includes a single long child (a lower leg)', () => {
    const box = getBoneFramingBounds(['UpLeg'])
    expect(box.min.y).toBeCloseTo(0.5, 2) // Leg
  })

  it('unions several selected joints', () => {
    const box = getBoneFramingBounds(['Head', 'UpLeg'])
    expect(box.min.y).toBeCloseTo(0.5, 2)
    expect(box.max.y).toBeCloseTo(1.8, 2)
  })

  it('defaults to the current multi-selection', () => {
    selectBones(['UpLeg', 'Leg'])
    const box = getBoneFramingBounds()
    expect(box.min.y).toBeCloseTo(0.5, 2)
  })
})

describe('what "frame selected" aims at', () => {
  beforeEach(() => useStore.setState({ mode: 'object', selectedObjectId: null, selectedMeshUuid: null, selectedBoneNames: [] }))

  it('nothing selected -> nothing to frame', () => {
    expect(getFramingTarget()).toBeNull()
  })

  it('Mesh mode with a part selected frames the part', () => {
    useStore.setState({ mode: 'mesh', selectedMeshUuid: 'abc', selectedObjectId: 4 })
    expect(getFramingTarget()).toEqual({ kind: 'mesh', uuid: 'abc' })
  })

  it('Pose mode with joints selected frames the joints', () => {
    useStore.setState({ mode: 'bone', selectedBoneNames: ['Head'], selectedObjectId: 4 })
    expect(getFramingTarget()).toEqual({ kind: 'bones', names: ['Head'] })
  })

  it('falls back to the selected object, e.g. in Object mode or with no part/joint chosen', () => {
    useStore.setState({ mode: 'object', selectedObjectId: 4, selectedMeshUuid: 'abc', selectedBoneNames: ['Head'] })
    expect(getFramingTarget()).toEqual({ kind: 'object', id: 4 })
    useStore.setState({ mode: 'mesh', selectedMeshUuid: null, selectedObjectId: 4 })
    expect(getFramingTarget()).toEqual({ kind: 'object', id: 4 })
  })
})
