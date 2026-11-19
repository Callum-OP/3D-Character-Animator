import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { retargetParsed } from '../three/bvh.js'

// A finger-like chain Hand -> F1 -> F2 -> F3, where F3 is the LAST bone (no child). A BVH writes its last joint as an
// unnamed End Site, so a rig's last deforming bone usually has nothing to aim at in the source. The retargeter used to
// leave such a bone unaligned while its parent was turned onto the source's direction, so the tip kept the rig's own
// rest direction and kinked against the rest of the chain (fingertips "bent up" on an A-pose clip).
function chain(bendDeg) {
  const hand = new THREE.Bone(); hand.name = 'Hand'
  const f1 = new THREE.Bone(); f1.name = 'F1'; f1.position.set(0.1, 0, 0)
  const f2 = new THREE.Bone(); f2.name = 'F2'; f2.position.set(0.1, 0, 0)
  const a = (bendDeg * Math.PI) / 180
  const f3 = new THREE.Bone(); f3.name = 'F3'; f3.position.set(0.1 * Math.cos(a), 0.1 * Math.sin(a), 0) // F2 -> F3 is bent in THIS rig
  f2.add(f3); f1.add(f2); hand.add(f1)
  return { hand, f1, f2, f3 }
}

function build(bendTarget) {
  const t = chain(bendTarget)
  const root = new THREE.Group(); root.add(t.hand)
  const bones = [t.hand, t.f1, t.f2, t.f3]
  const sm = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const skeleton = new THREE.Skeleton(bones); sm.bind(skeleton); root.add(sm); root.updateWorldMatrix(true, true)
  const model = { root, bones, skinnedMeshes: [sm], meshes: [], skeleton, clips: [], info: {} }
  // source: perfectly straight chain, hand dropped 45 degrees at frame 0 (an A-pose-like first frame)
  const s = chain(0)
  const drop = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (-45 * Math.PI) / 180)
  const id = new THREE.Quaternion()
  const track = (n, q) => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, [0, 1], [q.x, q.y, q.z, q.w, q.x, q.y, q.z, q.w])
  const clip = new THREE.AnimationClip('pose', 1, [track('Hand', drop), track('F1', id), track('F2', id), track('F3', id)])
  const parsed = { skeleton: { bones: [s.hand, s.f1, s.f2, s.f3] }, clip, bones: ['Hand', 'F1', 'F2', 'F3'], name: 'pose' }
  return { model, parsed, t }
}

function frame0(model, parsed) {
  const names = { Hand: 'Hand', F1: 'F1', F2: 'F2', F3: 'F3' }
  const res = retargetParsed(parsed, model, names, 'Hand', 'test')
  const mixer = new THREE.AnimationMixer(model.root)
  const action = mixer.clipAction(res.clip); action.play(); mixer.setTime(0)
  model.root.updateWorldMatrix(true, true)
}

describe('retargetParsed: the last bone of a chain follows its parent\'s alignment', () => {
  it('does not kink the last bone against its parent when the rig\'s rest direction differs from the source\'s', () => {
    const { model, parsed, t } = build(12) // this rig's last segment is bent 12 degrees at rest; the source's is straight
    const restLocal = t.f3.quaternion.clone()
    frame0(model, parsed)
    // the last bone's rotation relative to its parent must stay what it is at rest: a chain continues, it does not snap
    const angle = (t.f3.quaternion.angleTo(restLocal) * 180) / Math.PI
    expect(angle).toBeLessThan(0.5)
  })

  it('still lines the bones that DO have a child up with the source\'s directions', () => {
    const { model, parsed, t } = build(12)
    frame0(model, parsed)
    // F2 -> F3 in the rig now points the way the (straight) source chain does after the 45 degree drop
    const dir = new THREE.Vector3()
    const p2 = t.f2.getWorldPosition(new THREE.Vector3())
    const p3 = t.f3.getWorldPosition(new THREE.Vector3())
    dir.copy(p3).sub(p2).normalize()
    const want = new THREE.Vector3(Math.cos((-45 * Math.PI) / 180), Math.sin((-45 * Math.PI) / 180), 0)
    expect((dir.angleTo(want) * 180) / Math.PI).toBeLessThan(1)
  })

  it('is unchanged when the rest directions already agree', () => {
    const { model, parsed, t } = build(0)
    const restLocal = t.f3.quaternion.clone()
    frame0(model, parsed)
    expect((t.f3.quaternion.angleTo(restLocal) * 180) / Math.PI).toBeLessThan(0.5)
  })
})
