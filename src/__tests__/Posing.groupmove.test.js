import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import {
  initPosing,
  setPoseModel,
  selectBone,
  selectBones,
  setBoneGizmoMode,
  getBoneGizmoMode,
  getBoneGizmoForTest,
  getSelectedBoneNames,
  simulateGroupMoveForTest,
  simulateGroupRotateForTest,
  undo,
} from '../three/posing.js'

// A torso with two arms, each three bones long — generic names, so the rig
// counts as "loose" and every bone gets a chain of ancestors to swing.
//   Hips ─ Spine ─┬ L1 ─ L2 ─ L3
//                 └ R1 ─ R2 ─ R3
function makeRig() {
  const mk = (name, x, y) => {
    const b = new THREE.Bone()
    b.name = name
    b.position.set(x, y, 0)
    return b
  }
  const hips = mk('Hips', 0, 1, 0)
  const spine = mk('Spine', 0, 0.5)
  hips.add(spine)
  const left = [mk('L1', 0.3, 0.3), mk('L2', 0.4, 0), mk('L3', 0.4, 0)]
  const right = [mk('R1', -0.3, 0.3), mk('R2', -0.4, 0), mk('R3', -0.4, 0)]
  spine.add(left[0], right[0])
  left[0].add(left[1])
  left[1].add(left[2])
  right[0].add(right[1])
  right[1].add(right[2])
  hips.updateMatrixWorld(true)
  return { root: hips, bones: [hips, spine, ...left, ...right], byName: (n) => [hips, spine, ...left, ...right].find((b) => b.name === n) }
}

const worldPos = (b) => b.getWorldPosition(new THREE.Vector3())

describe('Pose mode: moving several bones at once', () => {
  let rig
  beforeEach(() => {
    const scene = new THREE.Scene()
    initPosing({
      scene,
      camera: new THREE.PerspectiveCamera(),
      renderer: { domElement: document.createElement('canvas') },
      controls: { enabled: true, locked: false },
      requestRender: () => {},
    })
    rig = makeRig()
    scene.add(rig.root)
    setPoseModel({ bones: rig.bones, root: rig.root })
    selectBone(null)
    setBoneGizmoMode('rotate')
  })

  it('Move can be chosen with several bones selected — it no longer snaps back to Rotate', () => {
    selectBones(['L3', 'R3'])
    expect(getSelectedBoneNames().sort()).toEqual(['L3', 'R3'])
    setBoneGizmoMode('translate')
    expect(getBoneGizmoMode()).toBe('translate')
    setBoneGizmoMode('rotate')
    expect(getBoneGizmoMode()).toBe('rotate')
    setBoneGizmoMode('translate')
    expect(getBoneGizmoMode()).toBe('translate')
  })

  it('dragging the Move widget moves every selected bone by the same offset', () => {
    selectBones(['L3', 'R3'])
    setBoneGizmoMode('translate')
    const l0 = worldPos(rig.byName('L3'))
    const r0 = worldPos(rig.byName('R3'))
    const offset = new THREE.Vector3(0, 0.25, 0)
    simulateGroupMoveForTest(offset)
    const l1 = worldPos(rig.byName('L3'))
    const r1 = worldPos(rig.byName('R3'))
    // Both hands rise together (within IK tolerance — limits and reach apply).
    expect(l1.y - l0.y).toBeGreaterThan(0.15)
    expect(r1.y - r0.y).toBeGreaterThan(0.15)
    expect(Math.abs(l1.y - l0.y - (r1.y - r0.y))).toBeLessThan(0.08) // moved by about the same amount
  })

  it('a group Move is one undo step that puts every bone back', () => {
    selectBones(['L3', 'R3'])
    setBoneGizmoMode('translate')
    const before = rig.bones.map((b) => b.quaternion.clone())
    simulateGroupMoveForTest(new THREE.Vector3(0, 0.25, 0))
    expect(rig.bones.some((b, i) => !b.quaternion.equals(before[i]))).toBe(true)
    undo()
    rig.bones.forEach((b, i) => expect(b.quaternion.angleTo(before[i])).toBeLessThan(1e-6))
  })

  it('Rotate still works on the same group, and you can switch between the two mid-selection', () => {
    selectBones(['L3', 'R3'])
    setBoneGizmoMode('translate')
    simulateGroupMoveForTest(new THREE.Vector3(0, 0.2, 0))
    setBoneGizmoMode('rotate')
    const l3 = rig.byName('L3')
    const q0 = l3.quaternion.clone()
    simulateGroupRotateForTest(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.4))
    expect(l3.quaternion.angleTo(q0)).toBeGreaterThan(0.1)
    setBoneGizmoMode('translate')
    expect(getBoneGizmoMode()).toBe('translate')
  })

  it('moving the group with nothing to swing (just the hips) changes nothing and does not throw', () => {
    selectBones(['Hips', 'Spine'])
    setBoneGizmoMode('translate')
    expect(() => simulateGroupMoveForTest(new THREE.Vector3(0.3, 0, 0))).not.toThrow()
  })

  it('the Move / Rotate choice carries between a group and a single bone', () => {
    setBoneGizmoMode('translate')
    selectBones(['L3', 'R3'])
    expect(getBoneGizmoMode()).toBe('translate')
    selectBone('L3')
    expect(getBoneGizmoMode()).toBe('translate')
    selectBones(['L3', 'R3'])
    setBoneGizmoMode('rotate')
    selectBone('R3')
    expect(getBoneGizmoMode()).toBe('rotate')
  })

  it('the combined tool puts Move (IK) and Rotate on one bone: Move drives the IK target, Rotate the bone', () => {
    setBoneGizmoMode('combined')
    expect(getBoneGizmoMode()).toBe('combined')
    selectBone('L3')
    const gizmo = getBoneGizmoForTest()
    expect(gizmo.mode).toBe('combined')
    expect(gizmo._parts.rotate.object).toBe(rig.byName('L3'))
    expect(gizmo._parts.translate.object).toBeTruthy()
    expect(gizmo._parts.translate.object).not.toBe(rig.byName('L3'))
    expect(gizmo._parts.scale.object).toBeUndefined() // bones have no Resize
    // the IK target waits on the bone
    expect(worldPos(gizmo._parts.translate.object).distanceTo(worldPos(rig.byName('L3')))).toBeLessThan(1e-6)
  })

  it('combined with several bones selected: both layers share the group pivot, and a rotate drag rotates them', () => {
    setBoneGizmoMode('combined')
    selectBones(['L3', 'R3'])
    const gizmo = getBoneGizmoForTest()
    expect(gizmo._parts.translate.object).toBe(gizmo._parts.rotate.object)
    expect(getBoneGizmoMode()).toBe('combined')
    const before = rig.byName('L3').quaternion.clone()
    simulateGroupRotateForTest(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.4))
    expect(rig.byName('L3').quaternion.angleTo(before)).toBeGreaterThan(0.01)
  })
})
