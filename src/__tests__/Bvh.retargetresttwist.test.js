import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { retargetParsed } from '../three/bvh.js'

// Build a simple 3-bone leg chain: Hips -> UpLeg -> Foot, either with a
// "clean" rest orientation (identity local quaternion, BVH-style) or with a
// constant baked-in rest TWIST on UpLeg (Mixamo-style — the exact situation
// this app's own BVH exporter has to produce, since BVH's OFFSET field can't
// carry rotation and a rig with non-standard joint axes has no other place
// to put that twist).
function buildLeg({ twistDeg = 0 } = {}) {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  const upLeg = new THREE.Bone()
  upLeg.name = 'UpLeg'
  upLeg.position.set(0, -0.1, 0)
  if (twistDeg) {
    upLeg.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (twistDeg * Math.PI) / 180)
  }
  const foot = new THREE.Bone()
  foot.name = 'Foot'
  foot.position.set(0, -0.5, 0)
  upLeg.add(foot)
  hips.add(upLeg)
  root.add(hips)

  const bones = [hips, upLeg, foot]
  const skinnedMesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const skeleton = new THREE.Skeleton(bones)
  skinnedMesh.bind(skeleton)
  root.add(skinnedMesh)
  root.updateWorldMatrix(true, true)

  return { root, bones, skinnedMeshes: [skinnedMesh], meshes: [], skeleton, clips: [], info: {} }
}

// Build a fake "parsed BVH" source: a Hips/UpLeg/Foot chain (matching
// BVHLoader's real construction convention — bones start at identity
// rotation, offsets only) with a quaternion track on UpLeg lifting the leg
// forward, optionally starting from a twisted first frame (simulating a BVH
// round-tripped through a rig with non-standard joint axes, i.e. exactly
// what this app's own exporter produces).
function buildParsedSource({ frame0TwistDeg = 0, liftDeg = 30 }) {
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  const upLeg = new THREE.Bone()
  upLeg.name = 'UpLeg'
  upLeg.position.set(0, -0.1, 0)
  const foot = new THREE.Bone()
  foot.name = 'Foot'
  foot.position.set(0, -0.5, 0)
  upLeg.add(foot)
  hips.add(upLeg)

  const q0 = new THREE.Quaternion()
  const twist0 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (frame0TwistDeg * Math.PI) / 180)
  const lift = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (-liftDeg * Math.PI) / 180)
  const q1 = twist0.clone().multiply(lift) // twist baseline still present at frame 1 too, plus the lift

  const times = [0, 1]
  const values = [q0.x, q0.y, q0.z, q0.w, ...(frame0TwistDeg ? [twist0.x, twist0.y, twist0.z, twist0.w] : [q0.x, q0.y, q0.z, q0.w])]
  const upLegValues = frame0TwistDeg
    ? [twist0.x, twist0.y, twist0.z, twist0.w, q1.x, q1.y, q1.z, q1.w]
    : [q0.x, q0.y, q0.z, q0.w, lift.x, lift.y, lift.z, lift.w]

  const hipsTrack = new THREE.QuaternionKeyframeTrack('Hips.quaternion', times, [q0.x, q0.y, q0.z, q0.w, q0.x, q0.y, q0.z, q0.w])
  const upLegTrack = new THREE.QuaternionKeyframeTrack('UpLeg.quaternion', times, upLegValues)
  const clip = new THREE.AnimationClip('Mocap', 1, [hipsTrack, upLegTrack])

  return { skeleton: { bones: [hips, upLeg, foot] }, clip, bones: ['Hips', 'UpLeg', 'Foot'], name: 'Mocap' }
}

function retargetedQuat(model, names, hip, parsed, frameTime) {
  const res = retargetParsed(parsed, model, names, hip, 'test')
  const mixer = new THREE.AnimationMixer(model.root)
  const action = mixer.clipAction(res.clip)
  action.loop = THREE.LoopOnce
  action.clampWhenFinished = true
  action.play()

  const upLeg = model.bones.find((b) => b.name === 'UpLeg')
  mixer.setTime(frameTime)
  model.root.updateWorldMatrix(true, true)
  return { quat: upLeg.quaternion.clone(), matched: res.matched }
}

function footLiftAngle(model, names, hip, parsed, frameTime) {
  const res = retargetParsed(parsed, model, names, hip, 'test')
  const mixer = new THREE.AnimationMixer(model.root)
  const action = mixer.clipAction(res.clip)
  action.loop = THREE.LoopOnce
  action.clampWhenFinished = true
  action.play()

  const upLeg = model.bones.find((b) => b.name === 'UpLeg')
  mixer.setTime(0)
  model.root.updateWorldMatrix(true, true)
  const restX = new THREE.Euler().setFromQuaternion(upLeg.quaternion, 'XYZ').x

  mixer.setTime(frameTime)
  model.root.updateWorldMatrix(true, true)
  const liftedX = new THREE.Euler().setFromQuaternion(upLeg.quaternion, 'XYZ').x

  return { deltaXDeg: ((liftedX - restX) * 180) / Math.PI, matched: res.matched }
}

describe('retargetParsed rest-reference handling', () => {
  it('retargets a clean (untwisted) mocap source correctly — regression check', () => {
    const model = buildLeg({ twistDeg: 0 })
    const parsed = buildParsedSource({ frame0TwistDeg: 0, liftDeg: 30 })
    const names = { UpLeg: 'UpLeg', Hips: 'Hips', Foot: 'Foot' }
    const { deltaXDeg, matched } = footLiftAngle(model, names, 'Hips', parsed, 1)
    expect(matched).toBeGreaterThan(0)
    // Expect roughly a 30° lift, not something wildly off.
    expect(Math.abs(Math.abs(deltaXDeg) - 30)).toBeLessThan(5)
  })

  it('does not double-count a baked-in rest twist from a Mixamo-style BVH source', () => {
    // The target ALSO has a baked twist on UpLeg (its own rig quirk) —
    // mirroring the real scenario: retargeting our own exported BVH (which
    // necessarily bakes the same kind of twist to round-trip faithfully)
    // back onto the same/similar rig. Real motion (a 30° lift) IS present
    // this time, on top of the 160° baseline twist.
    const model = buildLeg({ twistDeg: 160 })
    const targetRestQuat = model.bones.find((b) => b.name === 'UpLeg').quaternion.clone()
    const parsed = buildParsedSource({ frame0TwistDeg: 160, liftDeg: 30 })
    const names = { UpLeg: 'UpLeg', Hips: 'Hips', Foot: 'Foot' }
    const { quat, matched } = retargetedQuat(model, names, 'Hips', parsed, 1)
    expect(matched).toBeGreaterThan(0)
    // The retargeted pose should be "target's own rest, plus a real ~30°
    // lift" — not that plus an extra ~160° (or ~320°) of double-counted
    // twist on top.
    const errorDeg = (targetRestQuat.angleTo(quat) * 180) / Math.PI
    expect(Math.abs(errorDeg - 30)).toBeLessThan(10)
  })

  it('reports ~zero motion for a static (non-animated) twisted rig — isolates double-counting cleanly', () => {
    // No real motion at all: frame 0 and frame 1 are IDENTICAL (both just
    // the 160° rest twist, no lift). A correct retargeter must leave the
    // target's UpLeg at its OWN rest orientation, un-added-to — a
    // frame-to-frame DELTA won't catch a bug here (a constant bias present
    // at every frame cancels out of any delta by construction), so this
    // checks the ABSOLUTE orientation against the target's real rest quat
    // instead.
    const model = buildLeg({ twistDeg: 160 })
    const targetRestQuat = model.bones.find((b) => b.name === 'UpLeg').quaternion.clone()
    const parsed = buildParsedSource({ frame0TwistDeg: 160, liftDeg: 0 })
    const names = { UpLeg: 'UpLeg', Hips: 'Hips', Foot: 'Foot' }
    const { quat, matched } = retargetedQuat(model, names, 'Hips', parsed, 1)
    expect(matched).toBeGreaterThan(0)
    const errorDeg = (targetRestQuat.angleTo(quat) * 180) / Math.PI
    expect(errorDeg).toBeLessThan(2)
  })
})