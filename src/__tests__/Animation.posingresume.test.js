import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import { initAnimation, setAnimationModel, selectEdit, play, pause, stop, scrub, updateAnimation } from '../three/animation.js'

// Posing (the bone gizmo / part editor) must only be suspended while something is
// actually PLAYING. Arming a timeline leaves it paused, and the panel then just
// flags the UI "paused" — so activate() has to hand posing back itself, or the
// ability to edit poses vanishes after keying a position, New animation, etc.
function buildFakeModel() {
  const root = new THREE.Group()
  const hips = new THREE.Bone(); hips.name = 'Hips'; root.add(hips)
  const sm = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const skeleton = new THREE.Skeleton([hips]); sm.bind(skeleton); root.add(sm)
  return { root, bones: [hips], skinnedMeshes: [sm], meshes: [], skeleton, clips: [], info: {} }
}
const Q = [0, 0, 0, 1]
const data = () => ({
  tracks: { Hips: [{ time: 0, quat: Q }, { time: 1, quat: Q }] },
  root: [{ time: 0, pos: [0, 0, 0], quat: Q }, { time: 1, pos: [4, 0, 0], quat: Q }],
  meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {},
})
let suspended
let n = 0
beforeEach(() => {
  suspended = false
  initAnimation({
    requestRender() {}, setContinuousRender() {}, getObjectByUuid: () => null,
    suspendPosing() { suspended = true }, resumePosing() { suspended = false },
    onTime() {}, onEnded() {},
  })
  setAnimationModel(buildFakeModel(), 'posing-' + n++)
})

describe('posing is only suspended while playing', () => {
  it('stays editable after arming a timeline (New animation / keying a position / scrubbing from Stop)', () => {
    selectEdit(data(), 1, {})
    expect(suspended).toBe(false)
    scrub(0.5)
    expect(suspended).toBe(false)
  })

  it('suspends on play, resumes on pause and stop', () => {
    selectEdit(data(), 1, {})
    play(); expect(suspended).toBe(true)
    pause(); expect(suspended).toBe(false)
    play(); expect(suspended).toBe(true)
    stop(); expect(suspended).toBe(false)
  })

  it('stays editable after re-arming from a paused timeline (e.g. keying again)', () => {
    selectEdit(data(), 1, {})
    play(); pause()
    selectEdit(data(), 1, {}) // refreshCharacterAtTime after keying
    expect(suspended).toBe(false)
  })

  it('hands posing back when a non-looping clip plays to its end', () => {
    selectEdit(data(), 1, { loop: false })
    play(); expect(suspended).toBe(true)
    updateAnimation(2) // runs past the end → mixer 'finished'
    expect(suspended).toBe(false)
  })
})
