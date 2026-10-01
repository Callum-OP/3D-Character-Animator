import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import { initAnimation, setAnimationModel, selectClip, exportAnimationBVH } from '../three/animation.js'
import { importBVHAuto } from '../three/scene.js'
import { useStore } from '../store.js'

// Regression test for a real black-screen-causing bug: the title bar's
// "Import Animation… (.bvh)" used to call beginBVHImport/applyBVHRetarget
// directly and stop there. That retargets the clip fine on the Three.js
// side, but animation.js deliberately has no store dependency — ALL of the
// store bookkeeping (registering the clip name, selecting it, resetting
// playback) is the caller's job, exactly like AnimationPanel's onRetarget
// does after the same call. Skipping it left the store's importedClipNames
// empty even though the clip existed in the mixer, which meant:
//   - the imported clip didn't show up in the Animate panel's clip list
//   - getProjectData() (which reads importedClipNames from the STORE, not
//     from the mixer's own list) silently dropped it from saved projects
// importBVHAuto (in scene.js) is now the one shared place this bookkeeping
// happens — both the title bar and any future quick-import entry point
// should go through it rather than calling beginBVHImport/applyBVHRetarget
// directly. This test locks that contract in.

// Minimal humanoid-ish rig — same shape as Animation.exportbvh.test.js's
// fake model, so a real BVH round-trip (export → re-import) exercises the
// actual parse/retarget path rather than a hand-written BVH fixture.
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

  leftUpLeg.position.set(0.1, -0.1, 0)
  rightUpLeg.position.set(-0.1, -0.1, 0)
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

  const rotTrack = new THREE.QuaternionKeyframeTrack(
    'LeftUpLeg.quaternion',
    [0, 1],
    [0, 0, 0, 1, -0.2955, 0, 0, 0.9553],
  )
  const clip = new THREE.AnimationClip('Walk', 1, [rotTrack])

  return { root, bones, skinnedMeshes: [skinnedMesh], meshes: [], skeleton, clips: [clip], info: {}, bindings: [] }
}

const refs = {
  requestRender: () => {},
  suspendPosing: () => {},
  resumePosing: () => {},
  onTime: () => {},
  setContinuousRender: () => {},
}

const emptyAnimData = { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} }

describe('importBVHAuto (title bar quick BVH import)', () => {
  beforeEach(() => {
    initAnimation(refs)
  })

  it('registers the imported clip in the store, not just the mixer', async () => {
    // Source character: bake+export its 'Walk' clip to real BVH text.
    const source = buildFakeModel()
    setAnimationModel(source, 'source-char')
    selectClip('Walk')
    const bvhText = exportAnimationBVH(emptyAnimData, 30, 1, 'Walk', 'clip')
    expect(bvhText).toBeTruthy()

    // Target character: a fresh rig with the SAME bone names (as if the
    // user re-imported their own exported motion onto the active character).
    const target = buildFakeModel()
    setAnimationModel(target, 'target-char')
    useStore.setState({ importedClipNames: [], activeClipName: null, playbackSource: 'edit', duration: 0, currentTime: 5, playback: 'playing' })

    const file = new File([bvhText], 'walk.bvh', { type: 'text/plain' })
    const result = await importBVHAuto(file)

    expect(result.name).toBeTruthy()
    expect(result.total).toBeGreaterThan(0)

    const s = useStore.getState()
    // The core regression: the clip must be visible/selectable/saveable —
    // i.e. present in the store, not just retargeted in the mixer.
    expect(s.importedClipNames).toContain(result.name)
    expect(s.activeClipName).toBe(result.name)
    expect(s.playbackSource).toBe('clip')
    expect(s.playback).toBe('paused')
    expect(s.currentTime).toBe(0)
    expect(s.duration).toBeGreaterThan(0)
  })
})