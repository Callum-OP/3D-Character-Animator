import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { initAnimation, setAnimationModel, selectClip, play, pause, stop, scrub, updateRootMotionTrack } from '../three/animation.js'

// Regression test for: "clicking a mesh/bone does nothing while a clip is
// PAUSED (not stopped)". play() suspends posing/mesh-edit (suspendPosing()
// also suspends mesh-edit via scene.js's wiring) so playback can drive the
// rig without fighting the gizmo. stop() correctly hands control back via
// resumePosing(), but pause() used to only flip a.action.paused = true and
// never called resumePosing() — so the "ignore clicks" flag stayed set for
// as long as the clip sat paused, even though the pose on screen was frozen
// and perfectly clickable.
function buildFakeModel() {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  root.add(hips)
  const skinnedMesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const skeleton = new THREE.Skeleton([hips])
  skinnedMesh.bind(skeleton)
  root.add(skinnedMesh)

  const rotTrack = new THREE.QuaternionKeyframeTrack(
    'Hips.quaternion',
    [0, 1],
    [0, 0, 0, 1, 0, 0.3826834, 0, 0.9238795],
  )
  const clip = new THREE.AnimationClip('Walk', 1, [rotTrack])
  return { root, bones: [hips], skinnedMeshes: [skinnedMesh], meshes: [], skeleton, clips: [clip], info: {} }
}

describe('play/pause/stop hand-off to posing + mesh-edit', () => {
  function makeRefs() {
    const calls = { suspend: 0, resume: 0 }
    return {
      refs: {
        requestRender: () => {},
        setContinuousRender: () => {},
        getObjectByUuid: () => null,
        suspendPosing: () => { calls.suspend += 1 },
        resumePosing: () => { calls.resume += 1 },
        onTime: () => {},
      },
      calls,
    }
  }

  it('play() suspends, pause() resumes (clicks should work while paused)', () => {
    const { refs, calls } = makeRefs()
    initAnimation(refs)
    setAnimationModel(buildFakeModel(), 'char-pause')
    selectClip('Walk') // arming leaves the clip paused at frame 0, so posing stays usable
    expect(calls.suspend).toBe(0)
    expect(calls.resume).toBe(1)

    play()
    expect(calls.suspend).toBe(1)

    pause()
    expect(calls.resume).toBe(2) // <- pause() hands posing back (used to stay put)

    play()
    expect(calls.suspend).toBe(2) // resuming playback re-suspends as before
  })

  it('stop() still resumes exactly as it did before', () => {
    const { refs, calls } = makeRefs()
    initAnimation(refs)
    setAnimationModel(buildFakeModel(), 'char-stop')
    selectClip('Walk')
    play()
    const beforeStop = calls.resume
    stop()
    expect(calls.resume).toBe(beforeStop + 1)
  })

  it('stop() follows the updated root track instead of a stale activation position', () => {
    const { refs } = makeRefs()
    initAnimation(refs)
    const model = buildFakeModel()
    model.root.position.set(4, 0, 0)
    setAnimationModel(model, 'char-root-stop')
    selectClip('Walk', {}, {
      root: [
        { time: 0, pos: [1, 0, 0], quat: [0, 0, 0, 1] },
        { time: 1, pos: [8, 0, 0], quat: [0, 0, 0, 1] },
      ],
    })

    scrub(1)
    expect(model.root.position.x).toBe(8)
    updateRootMotionTrack([{ time: 0, pos: [2, 0, 0], quat: [0, 0, 0, 1] }])
    scrub(1)
    expect(model.root.position.x).toBe(2)
    stop()
    expect(model.root.position.x).toBe(2)
  })

  it('keeps the original placement when rebuilding a root track after scrubbing', () => {
    const { refs } = makeRefs()
    initAnimation(refs)
    const model = buildFakeModel()
    model.root.position.set(4, 0, 0)
    setAnimationModel(model, 'char-root-rebuild')
    selectClip('Walk', {}, {
      root: [{ time: 1, pos: [8, 0, 0], quat: [0, 0, 0, 1] }],
    })
    scrub(1)
    expect(model.root.position.x).toBe(8)

    selectClip('Walk', {}, {
      root: [{ time: 1, pos: [9, 0, 0], quat: [0, 0, 0, 1] }],
    })
    scrub(0)
    expect(model.root.position.x).toBe(4)
    stop()
    expect(model.root.position.x).toBe(4)
  })

  it('applies deleted root keys immediately and does not replay them after stopping', () => {
    const { refs } = makeRefs()
    initAnimation(refs)
    const model = buildFakeModel()
    model.root.position.set(4, 0, 0)
    setAnimationModel(model, 'char-root-delete')
    selectClip('Walk', {}, {
      root: [
        { time: 0, pos: [4, 0, 0], quat: [0, 0, 0, 1] },
        { time: 1, pos: [8, 0, 0], quat: [0, 0, 0, 1] },
      ],
    })

    scrub(1)
    expect(model.root.position.x).toBe(8)
    updateRootMotionTrack([{ time: 0, pos: [4, 0, 0], quat: [0, 0, 0, 1] }])
    expect(model.root.position.x).toBe(4)

    stop()
    expect(model.root.position.x).toBe(4)
    selectClip('Walk', {}, { root: [{ time: 0, pos: [4, 0, 0], quat: [0, 0, 0, 1] }] })
    scrub(1)
    expect(model.root.position.x).toBe(4)
  })
})