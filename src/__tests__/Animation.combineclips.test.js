import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { initAnimation, setAnimationModel, combineClips, selectClip, scrub } from '../three/animation.js'

// Hips-only rig (hip carries all the movement, like retargeted mocap).
//  - "Walk":  hips travel (0,1,0) -> (0,1,2), facing rest heading.
//  - "Turn":  authored in its OWN space: starts at (10,1,5), facing 90° left
//             of rest, and travels 2 units along +Z from there.
// Naive concatenation made the hip snap to (10,1,5) at the seam and spin 90°.
const Y = new THREE.Vector3(0, 1, 0)
const yawQ = (deg) => new THREE.Quaternion().setFromAxisAngle(Y, (deg * Math.PI) / 180)

function buildModel() {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  hips.position.set(0, 1, 0)
  root.add(hips)
  const foot = new THREE.Bone() // rigid child 1 unit below the hips: ground = hip height - 1
  foot.name = 'LeftFoot'
  foot.position.set(0, -1, 0)
  hips.add(foot)
  const skinned = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const skeleton = new THREE.Skeleton([hips, foot])
  skinned.bind(skeleton)
  root.add(skinned)

  const q0 = yawQ(0)
  const q90 = yawQ(90)
  const walk = new THREE.AnimationClip('Walk', 1, [
    new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 1, 0, 0, 1, 2]),
    new THREE.QuaternionKeyframeTrack('Hips.quaternion', [0, 1], [q0.x, q0.y, q0.z, q0.w, q0.x, q0.y, q0.z, q0.w]),
  ])
  const turn = new THREE.AnimationClip('Turn', 1, [
    new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [10, 1, 5, 10, 1, 7]),
    new THREE.QuaternionKeyframeTrack('Hips.quaternion', [0, 1], [q90.x, q90.y, q90.z, q90.w, q90.x, q90.y, q90.z, q90.w]),
  ])
  // Travels by moving the MODEL ROOT (clip "keep movement" style), hips static.
  const rootWalk = new THREE.AnimationClip('RootWalk', 1, [
    new THREE.VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 2, 0, 0]),
    new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 1, 0, 0, 1, 0.5]),
    new THREE.QuaternionKeyframeTrack('Hips.quaternion', [0, 1], [q0.x, q0.y, q0.z, q0.w, q0.x, q0.y, q0.z, q0.w]),
  ])
  // Authored 0.1 lower than Walk (hips at 0.9), i.e. its feet are 0.1 below Walk's ground.
  const low = new THREE.AnimationClip('Low', 1, [
    new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 0.9, 0, 0, 0.9, 0]),
    new THREE.QuaternionKeyframeTrack('Hips.quaternion', [0, 1], [q0.x, q0.y, q0.z, q0.w, q0.x, q0.y, q0.z, q0.w]),
  ])
  // Walks while turning from facing 0° to 90°; each step runs along the heading it ends on.
  const arcYaw = [0, 30, 60, 90].map(yawQ)
  const sd = (d) => Math.sin((d * Math.PI) / 180)
  const cd = (d) => Math.cos((d * Math.PI) / 180)
  const arc = new THREE.AnimationClip('Arc', 1, [
    new THREE.VectorKeyframeTrack(
      'Hips.position',
      [0, 1 / 3, 2 / 3, 1],
      [0, 1, 0, sd(30), 1, cd(30), sd(30) + sd(60), 1, cd(30) + cd(60), sd(30) + sd(60) + 1, 1, cd(30) + cd(60)],
    ),
    new THREE.QuaternionKeyframeTrack(
      'Hips.quaternion',
      [0, 1 / 3, 2 / 3, 1],
      arcYaw.flatMap((q) => [q.x, q.y, q.z, q.w]),
    ),
  ])
  return { root, bones: [hips, foot], skinnedMeshes: [skinned], meshes: [], skeleton, clips: [walk, turn, rootWalk, low, arc], info: {} }
}

function setup(id) {
  initAnimation({
    requestRender: () => {},
    suspendPosing: () => {},
    resumePosing: () => {},
    onTime: () => {},
    setContinuousRender: () => {},
    onEnded: () => {},
  })
  const model = buildModel()
  setAnimationModel(model, id)
  return model
}

function play(name, t) {
  const d = selectClip(name, { loop: false, speed: 1 }, {})
  scrub(t === undefined ? d : t)
  return d
}

const fwd = (bone) => {
  bone.updateWorldMatrix(true, false)
  return new THREE.Vector3(0, 0, 1).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()))
}

describe('combineClips', () => {
  it('continues from where the previous clip ended instead of snapping to the next clip\'s own origin', () => {
    const model = setup('combine-stitch')
    const name = combineClips(['Walk', 'Turn'], 24)
    const hips = model.bones[0]

    play(name, 1.0) // exactly the seam
    expect(hips.position.x).toBeCloseTo(0, 3)
    expect(hips.position.z).toBeCloseTo(2, 3)

    // Turn's heading is re-based to continue Walk's (so its +Z travel is
    // rotated by -90° about Y): end at (-2, 1, 2), still facing Walk's way.
    play(name)
    expect(hips.position.x).toBeCloseTo(-2, 2)
    expect(hips.position.y).toBeCloseTo(1, 3)
    expect(hips.position.z).toBeCloseTo(2, 2)
    expect(fwd(hips).x).toBeCloseTo(0, 2)
    expect(fwd(hips).z).toBeCloseTo(1, 2)
  })

  it('keeps the first clip untouched', () => {
    const model = setup('combine-first')
    const name = combineClips(['Walk', 'Turn'], 24)
    const hips = model.bones[0]
    play(name, 0.5)
    expect(hips.position.z).toBeCloseTo(1, 2)
  })

  it('"keep on the spot" removes horizontal travel but keeps height', () => {
    const model = setup('combine-inplace')
    const name = combineClips(['Walk', 'Turn'], 24, { inPlace: true })
    const hips = model.bones[0]
    for (const t of [0, 0.5, 1, 1.5, 2]) {
      play(name, t)
      expect(hips.position.x).toBeCloseTo(0, 3)
      expect(hips.position.z).toBeCloseTo(0, 3)
      expect(hips.position.y).toBeCloseTo(1, 3)
    }
  })

  it('folds a clip\'s root-object travel into the combined clip once (no double movement)', () => {
    const model = setup('combine-root')
    const name = combineClips(['RootWalk', 'Walk'], 24)
    const hips = model.bones[0]
    play(name, 1.0)
    // RootWalk: root +2 in X plus hips +0.5 in Z; combined clip has no root track.
    expect(model.root.position.x).toBeCloseTo(0, 3)
    expect(hips.position.x).toBeCloseTo(2, 2)
    expect(hips.position.z).toBeCloseTo(0.5, 2)
    // Walk then continues +2 in Z from there — nothing extra.
    play(name)
    expect(hips.position.x).toBeCloseTo(2, 2)
    expect(hips.position.z).toBeCloseTo(2.5, 2)
  })

  it('keeps feet level across the seam instead of stepping down then back up', () => {
    const model = setup('combine-ground')
    const name = combineClips(['Walk', 'Low', 'Walk'], 24)
    const hips = model.bones[0]
    for (const t of [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]) {
      play(name, t)
      expect(hips.position.y).toBeCloseTo(1, 3) // Low lifted by 0.1 to share Walk's ground
    }
  })

  it('matchGround off leaves each clip at its own height', () => {
    const model = setup('combine-ground-off')
    const name = combineClips(['Walk', 'Low'], 24, { matchGround: false })
    const hips = model.bones[0]
    play(name, 1.5)
    expect(hips.position.y).toBeCloseTo(0.9, 3)
  })

})