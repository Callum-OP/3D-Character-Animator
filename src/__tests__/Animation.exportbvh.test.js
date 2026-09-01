import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { initAnimation, setAnimationModel, selectClip, stop, exportAnimationBVH } from '../three/animation.js'

// Minimal humanoid-ish rig: Hips -> LeftUpLeg -> LeftFoot
//                                 -> RightUpLeg -> RightFoot
// A baked clip animates ONLY LeftUpLeg, rotating it over 1 second. This
// mirrors how a real imported/retargeted mocap clip (not hand-keyframed
// in-app tracks) drives the rig.
function buildFakeModel() {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  const leftUpLeg = new THREE.Bone()
  leftUpLeg.name = 'LeftUpLeg'
  const rightUpLeg = new THREE.Bone()
  rightUpLeg.name = 'RightUpLeg'
  const leftFoot = new THREE.Bone()
  leftFoot.name = 'LeftFoot'
  const rightFoot = new THREE.Bone()
  rightFoot.name = 'RightFoot'

  leftUpLeg.position.set(0.1, -0.1, 0) // left side = +X
  rightUpLeg.position.set(-0.1, -0.1, 0) // right side = -X
  leftFoot.position.set(0, -0.5, 0)
  rightFoot.position.set(0, -0.5, 0)

  hips.add(leftUpLeg)
  hips.add(rightUpLeg)
  leftUpLeg.add(leftFoot)
  rightUpLeg.add(rightFoot)
  root.add(hips)

  const bones = [hips, leftUpLeg, rightUpLeg, leftFoot, rightFoot]
  const skinnedMesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const skeleton = new THREE.Skeleton(bones)
  skinnedMesh.bind(skeleton)
  root.add(skinnedMesh)

  // Rotate the LEFT upper leg forward over the clip; right leg stays at rest.
  const rotTrack = new THREE.QuaternionKeyframeTrack(
    'LeftUpLeg.quaternion',
    [0, 1],
    [0, 0, 0, 1, -0.2955, 0, 0, 0.9553], // ~-34deg around X by the end
  )
  const clip = new THREE.AnimationClip('Walk', 1, [rotTrack])

  return { root, bones, skinnedMeshes: [skinnedMesh], meshes: [], skeleton, clips: [clip], info: {} }
}

const refs = {
  requestRender: () => {},
  suspendPosing: () => {},
  resumePosing: () => {},
  onTime: () => {},
  setContinuousRender: () => {},
}

describe('exportAnimationBVH', () => {
  it('exports the WHOLE active clip, not just a single frozen pose', () => {
    initAnimation(refs)
    const model = buildFakeModel()
    setAnimationModel(model, 'test-char')

    // Activate the baked clip exactly like the Animate panel's "Play a clip"
    // does — this is the normal case for imported/retargeted mocap, which
    // never touches animData.tracks at all.
    selectClip('Walk')

    const emptyAnimData = { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} }
    const text = exportAnimationBVH(emptyAnimData, 24, 2 /* deliberately wrong/stale duration */, 'Walk', 'clip')

    expect(text).toBeTruthy()
    const framesMatch = text.match(/Frames:\s*(\d+)/)
    expect(framesMatch).toBeTruthy()
    const numFrames = Number(framesMatch[1])
    // The clip is 1s @ 24fps -> ~25 frames, NOT 2 frames and not derived from
    // the stale "2" duration argument that used to control everything.
    expect(numFrames).toBeGreaterThan(20)

    const motionLines = text
      .split('MOTION\n')[1]
      .split('\n')
      .filter((l) => l.trim().length)
      .slice(2) // drop "Frames:" / "Frame Time:" lines
    expect(motionLines.length).toBe(numFrames)

    // The pose must actually change across frames (a real animation, not a
    // single pose repeated for every frame).
    const first = motionLines[0]
    const last = motionLines[motionLines.length - 1]
    expect(first).not.toBe(last)
  })

  it('keeps left/right leg motion on the correct side (no swap)', () => {
    initAnimation(refs)
    const model = buildFakeModel()
    setAnimationModel(model, 'test-char-2')
    selectClip('Walk')

    const emptyAnimData = { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} }
    const text = exportAnimationBVH(emptyAnimData, 24, 1, 'Walk', 'clip')
    expect(text).toBeTruthy()

    // Parse out the joint order from the HIERARCHY block the same way a BVH
    // reader would: root, then each JOINT in depth-first order.
    const jointOrder = [...text.matchAll(/(?:ROOT|JOINT)\s+(\S+)/g)].map((m) => m[1])
    expect(jointOrder).toEqual(['Hips', 'LeftUpLeg', 'LeftFoot', 'RightUpLeg', 'RightFoot'])

    const motionLines = text
      .split('MOTION\n')[1]
      .split('\n')
      .filter((l) => l.trim().length)
      .slice(2)
    const lastFrame = motionLines[motionLines.length - 1].trim().split(/\s+/).map(Number)

    // Channel layout: Hips has 6 (pos+rot), every other joint has 3 (rot only).
    // Offsets: Hips=[0..5], LeftUpLeg=[6..8], LeftFoot=[9..11],
    // RightUpLeg=[12..14], RightFoot=[15..17].
    const leftUpLegRot = lastFrame.slice(6, 9)
    const rightUpLegRot = lastFrame.slice(12, 15)

    // LeftUpLeg was animated (should have picked up real rotation)…
    const leftMag = Math.hypot(...leftUpLegRot)
    // …RightUpLeg was never touched by the clip, so it should stay at rest.
    const rightMag = Math.hypot(...rightUpLegRot)

    expect(leftMag).toBeGreaterThan(5) // degrees — clearly rotated
    expect(rightMag).toBeLessThan(1e-3) // effectively zero — untouched
  })

  it('keeps the character upright when the skeleton sits under a corrective wrapper rotation', () => {
    // Mirrors a common export pipeline: an "Armature" node above Hips carries
    // a fixed rotation (e.g. converting the source app's Z-up to Y-up) that
    // is NOT itself a Bone, so it's outside a.model.bones — but it still
    // affects Hips' true world orientation.
    const root = new THREE.Group()
    const armature = new THREE.Object3D()
    armature.name = 'Armature'
    armature.rotation.x = -Math.PI / 2 // the corrective tilt
    const hips = new THREE.Bone()
    hips.name = 'Hips'
    const spine = new THREE.Bone()
    spine.name = 'Spine'
    hips.add(spine)
    armature.add(hips)
    root.add(armature)

    const bones = [hips, spine]
    const skinnedMesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
    const skeleton = new THREE.Skeleton(bones)
    skinnedMesh.bind(skeleton)
    root.add(skinnedMesh)

    const rotTrack = new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])
    const clip = new THREE.AnimationClip('Idle', 1, [rotTrack])
    const model = { root, bones, skinnedMeshes: [skinnedMesh], meshes: [], skeleton, clips: [clip], info: {} }

    initAnimation(refs)
    setAnimationModel(model, 'test-char-3')
    selectClip('Idle')

    const emptyAnimData = { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} }
    const text = exportAnimationBVH(emptyAnimData, 24, 1, 'Idle', 'clip')
    expect(text).toBeTruthy()

    const motionLines = text
      .split('MOTION\n')[1]
      .split('\n')
      .filter((l) => l.trim().length)
      .slice(2)
    const frame0 = motionLines[0].trim().split(/\s+/).map(Number)
    // Hips channels: Xpos Ypos Zpos Zrot Xrot Yrot (indices 0..5).
    const hipsRot = frame0.slice(3, 6)
    const mag = Math.hypot(...hipsRot)
    // The wrapper's -90° tilt must show up on the ROOT joint's own rotation —
    // if it's dropped (the bug), this comes out ~0 and the character exports
    // lying flat instead of standing.
    expect(mag).toBeGreaterThan(80)
  })

  it('keeps a mirrored (negative-scale) limb from twisting backward on export', async () => {
    // Some rigs mirror one side of the body by putting a negative scale on
    // that side's chain instead of authoring a true mirrored bone orientation.
    // BVH has no scale channels, so naively reading bone.position/.quaternion
    // (which are only meaningful together with that scale) comes out
    // twisted/backward once the scale is silently dropped.
    const root = new THREE.Group()
    const hips = new THREE.Bone()
    hips.name = 'Hips'
    const rightUpLeg = new THREE.Bone()
    rightUpLeg.name = 'RightUpLeg'
    rightUpLeg.scale.set(-1, 1, 1) // mirrored side
    rightUpLeg.position.set(-0.1, -0.1, 0)
    const rightFoot = new THREE.Bone()
    rightFoot.name = 'RightFoot'
    rightFoot.position.set(0, -0.5, 0)
    rightUpLeg.add(rightFoot)
    hips.add(rightUpLeg)
    root.add(hips)

    const bones = [hips, rightUpLeg, rightFoot]
    const skinnedMesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
    const skeleton = new THREE.Skeleton(bones)
    skinnedMesh.bind(skeleton)
    root.add(skinnedMesh)

    // Lift the leg forward by rotating around the mirrored bone's local X.
    const rotTrack = new THREE.QuaternionKeyframeTrack(
      'RightUpLeg.quaternion',
      [0, 1],
      [0, 0, 0, 1, -0.2955, 0, 0, 0.9553],
    )
    const clip = new THREE.AnimationClip('Kick', 1, [rotTrack])
    const model = { root, bones, skinnedMeshes: [skinnedMesh], meshes: [], skeleton, clips: [clip], info: {} }

    initAnimation(refs)
    setAnimationModel(model, 'test-char-4')
    selectClip('Kick')

    // Ground truth: where does RightFoot actually end up in the world?
    const expectedFootWorld = new THREE.Vector3()
    root.updateWorldMatrix(true, true)
    hips.updateWorldMatrix(true, true)
    rightUpLeg.quaternion.set(0, -0.2955, 0, 0.9553)
    root.updateWorldMatrix(true, true)
    rightFoot.getWorldPosition(expectedFootWorld)
    rightUpLeg.quaternion.set(0, 0, 0, 1) // reset

    const emptyAnimData = { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} }
    const text = exportAnimationBVH(emptyAnimData, 24, 1, 'Kick', 'clip')
    expect(text).toBeTruthy()

    // Reimport and check RightFoot actually lands where it really is, not
    // mirrored/flipped to the opposite direction.
    const { BVHLoader } = await import('three/examples/jsm/loaders/BVHLoader.js')
    const result = new BVHLoader().parse(text)
    const reMixer = new THREE.AnimationMixer(result.skeleton.bones[0])
    const reAction = reMixer.clipAction(result.clip)
    reAction.play()
    reMixer.update(result.clip.duration)
    result.skeleton.bones[0].updateWorldMatrix(true, true)
    const reFoot = result.skeleton.bones.find((b) => b.name === 'RightFoot')
    const gotFootWorld = new THREE.Vector3()
    reFoot.getWorldPosition(gotFootWorld)

    expect(gotFootWorld.distanceTo(expectedFootWorld)).toBeLessThan(0.01)
  })

  it('still exports the full clip after playback has stopped (not just a frozen frame)', () => {
    // Reproduces the real-world sequence: select a clip (arms it), maybe
    // preview it, then press Stop — which clears a.action/a.clip and resets
    // the rig to rest — and only THEN click Export. Exporting must still
    // find and sample the WHOLE named clip, not silently fall back to a
    // single repeated pose derived from the (empty) in-app track data.
    initAnimation(refs)
    const model = buildFakeModel()
    setAnimationModel(model, 'test-char-5')
    selectClip('Walk')
    stop() // clears a.action / a.clip and restores rest — this is the bug trigger

    const emptyAnimData = { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} }
    // Note: still passing the clip's NAME + 'clip' source, exactly as the
    // Export panel does from store.activeClipName/store.playbackSource —
    // those persist across Stop even though the live action doesn't.
    const text = exportAnimationBVH(emptyAnimData, 24, 2, 'Walk', 'clip')
    expect(text).toBeTruthy()

    const motionLines = text
      .split('MOTION\n')[1]
      .split('\n')
      .filter((l) => l.trim().length)
      .slice(2)
    // 1s clip @ 24fps, NOT the stale default duration of 2s.
    expect(motionLines.length).toBeGreaterThan(20)
    expect(motionLines.length).toBeLessThan(30)
    expect(new Set(motionLines).size).toBeGreaterThan(1) // not all identical
  })
})