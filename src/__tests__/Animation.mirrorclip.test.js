import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { initAnimation, setAnimationModel, mirrorClip, selectClip, scrub } from '../three/animation.js'

// Build a minimal skinned model with a mirrored pair of arm bones (LeftArm /
// RightArm) plus a centre Spine bone, and a clip that raises the LEFT arm
// (rotates it -90° about Z) while the right arm and spine stay at rest.
// Mirroring should hand that same motion to the RIGHT arm instead, leaving
// the left arm at rest and the spine untouched (it has no counterpart).
function buildFakeModel() {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  const spine = new THREE.Bone()
  spine.name = 'Spine'
  const leftArm = new THREE.Bone()
  leftArm.name = 'LeftArm'
  const rightArm = new THREE.Bone()
  rightArm.name = 'RightArm'
  hips.add(spine)
  spine.add(leftArm)
  spine.add(rightArm)
  root.add(hips)

  const bones = [hips, spine, leftArm, rightArm]
  const skinnedMesh = new THREE.SkinnedMesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
  )
  const skeleton = new THREE.Skeleton(bones)
  skinnedMesh.bind(skeleton)
  root.add(skinnedMesh)

  // LeftArm swings from rest (identity) to a -90° rotation about Z.
  const halfQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2)
  const leftArmTrack = new THREE.QuaternionKeyframeTrack(
    'LeftArm.quaternion',
    [0, 1],
    [0, 0, 0, 1, halfQuat.x, halfQuat.y, halfQuat.z, halfQuat.w],
  )
  const clip = new THREE.AnimationClip('Wave', 1, [leftArmTrack])

  return { root, bones, skinnedMeshes: [skinnedMesh], meshes: [], skeleton, clips: [clip], info: {} }
}

// A model with a Hips bone that moves sideways in X — the retargeted-mocap
// pattern where all real translation (weight shift, foot planting) lives on
// the hip rather than any rotation.
function buildFakeModelWithHipSway() {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  hips.position.set(0, 1, 0) // bind-pose hip height
  root.add(hips)

  const bones = [hips]
  const skinnedMesh = new THREE.SkinnedMesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
  )
  const skeleton = new THREE.Skeleton(bones)
  skinnedMesh.bind(skeleton)
  root.add(skinnedMesh)

  // Hips shifts +0.2 in X (weight onto one side) while staying at the same
  // height — the kind of lateral sway that keeps a planted foot under the hip.
  const hipsTrack = new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 1, 0, 0.2, 1, 0])
  const clip = new THREE.AnimationClip('Sway', 1, [hipsTrack])

  return { root, bones, skinnedMeshes: [skinnedMesh], meshes: [], skeleton, clips: [clip], info: {} }
}

describe('mirrorClip', () => {
  it('mirrors hip sway/translation, not just rotation, so the shift lands on the opposite side', () => {
    initAnimation({
      requestRender: () => {},
      suspendPosing: () => {},
      onTime: () => {},
      setContinuousRender: () => {},
      onEnded: () => {},
    })
    const model = buildFakeModelWithHipSway()
    setAnimationModel(model, 'mirror-test-hips')

    const newName = mirrorClip('Sway', 24)
    expect(newName).toBe('Sway (mirrored)')

    const duration = selectClip(newName, { loop: false, speed: 1 }, {})
    const hips = model.bones.find((b) => b.name === 'Hips')

    scrub(duration)
    // The hip's height (Y) must be unaffected by mirroring…
    expect(hips.position.y).toBeCloseTo(1, 3)
    // …but the X sway must flip to the other side, not disappear (which is
    // what happened before: the hip stayed at its rest X, so the mirrored
    // clip's arm/leg motion no longer matched where the hip's weight was).
    expect(hips.position.x).toBeCloseTo(-0.2, 3)
  })

  it('swaps the moving side: RightArm ends up with the motion LeftArm had', () => {
    initAnimation({
      requestRender: () => {},
      suspendPosing: () => {},
      onTime: () => {},
      setContinuousRender: () => {},
      onEnded: () => {},
    })
    const model = buildFakeModel()
    setAnimationModel(model, 'mirror-test-char')

    const newName = mirrorClip('Wave', 24)
    expect(newName).toBe('Wave (mirrored)')

    // Play the mirrored clip and sample the last frame.
    const duration = selectClip(newName, { loop: false, speed: 1 }, {})
    expect(duration).toBeGreaterThan(0.9)

    // Re-fetch the model's bones directly since selectClip drives them via
    // the mixer — scrub to the end and read live quaternions.
    const mixerModule = model
    const rightArm = mixerModule.bones.find((b) => b.name === 'RightArm')
    const leftArm = mixerModule.bones.find((b) => b.name === 'LeftArm')

    // Use the animation module's own scrub to move the mixer to the end.
    scrub(duration)

    // RightArm should now carry roughly the -90°-about-Z rotation the left
    // arm originally had; LeftArm should be back at rest (identity).
    expect(Math.abs(rightArm.quaternion.w)).toBeGreaterThan(0.65)
    expect(leftArm.quaternion.w).toBeCloseTo(1, 2)
  })

  it('returns null for a clip that does not exist', () => {
    initAnimation({ requestRender: () => {} })
    const model = buildFakeModel()
    setAnimationModel(model, 'mirror-test-char-2')
    expect(mirrorClip('Nope', 24)).toBeNull()
  })
})