import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { initAnimation, setAnimationModel, bakeClipToTracks } from '../three/animation.js'

// Build a minimal skinned model: root -> Hips (root bone) -> Spine, with a
// clip that both rotates Spine and translates Hips forward over 1s (a stand-in
// for a mocap walk clip). Mirrors the shape loadModel.js produces.
function buildFakeModel() {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  const spine = new THREE.Bone()
  spine.name = 'Spine'
  hips.add(spine)
  root.add(hips)

  const bones = [hips, spine]
  const skinnedMesh = new THREE.SkinnedMesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
  )
  const skeleton = new THREE.Skeleton(bones)
  skinnedMesh.bind(skeleton)
  root.add(skinnedMesh)

  const posTrack = new THREE.VectorKeyframeTrack(
    'Hips.position',
    [0, 1],
    [0, 0, 0, 0, 0, 5], // moves 5 units along Z over the clip
  )
  const rotTrack = new THREE.QuaternionKeyframeTrack(
    'Spine.quaternion',
    [0, 1],
    [0, 0, 0, 1, 0, 0.3826834, 0, 0.9238795],
  )
  const clip = new THREE.AnimationClip('Walk', 1, [posTrack, rotTrack])

  return { root, bones, skinnedMeshes: [skinnedMesh], meshes: [], skeleton, clips: [clip], info: {} }
}

// Same as above, but the bone that actually carries the position track is
// NOT the topmost bone in the hierarchy — an extra non-moving "Armature"
// bone sits above Hips. Reproduces rigs where the old parent-based heuristic
// picked the wrong (non-moving) bone and captured no travel at all.
function buildFakeModelWithWrapperBone() {
  const root = new THREE.Group()
  const armature = new THREE.Bone()
  armature.name = 'Armature'
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  const spine = new THREE.Bone()
  spine.name = 'Spine'
  armature.add(hips)
  hips.add(spine)
  root.add(armature)

  const bones = [armature, hips, spine]
  const skinnedMesh = new THREE.SkinnedMesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
  )
  const skeleton = new THREE.Skeleton(bones)
  skinnedMesh.bind(skeleton)
  root.add(skinnedMesh)

  const posTrack = new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 0, 0, 0, 0, 5])
  const rotTrack = new THREE.QuaternionKeyframeTrack(
    'Spine.quaternion',
    [0, 1],
    [0, 0, 0, 1, 0, 0.3826834, 0, 0.9238795],
  )
  const clip = new THREE.AnimationClip('Walk', 1, [posTrack, rotTrack])

  return { root, bones, skinnedMeshes: [skinnedMesh], meshes: [], skeleton, clips: [clip], info: {} }
}

describe('bakeClipToTracks preserveMotion', () => {
  it('captures the hip/root world travel as root keys when preserveMotion is on', () => {
    initAnimation({ requestRender: () => {} })
    const model = buildFakeModel()
    setAnimationModel(model, 'test-char')

    const res = bakeClipToTracks('Walk', 24, 1, true)
    expect(res).toBeTruthy()
    expect(res.root).toBeTruthy()
    expect(res.root.length).toBeGreaterThan(1)

    const first = res.root[0]
    const last = res.root[res.root.length - 1]
    const travelled = last.pos[2] - first.pos[2]
    expect(travelled).toBeGreaterThan(4) // should be ~5
  })

  it('without preserveMotion, no root keys are produced', () => {
    const model = buildFakeModel()
    setAnimationModel(model, 'test-char-2')

    const res = bakeClipToTracks('Walk', 24, 1, false)
    expect(res.root == null || res.root.length === 0).toBe(true)
  })

  it('still finds the moving bone when it sits under a non-moving wrapper bone', () => {
    initAnimation({ requestRender: () => {} })
    const model = buildFakeModelWithWrapperBone()
    setAnimationModel(model, 'test-char-3')

    const res = bakeClipToTracks('Walk', 24, 1, true)
    expect(res.root).toBeTruthy()
    const first = res.root[0]
    const last = res.root[res.root.length - 1]
    const travelled = last.pos[2] - first.pos[2]
    expect(travelled).toBeGreaterThan(4)
  })
})