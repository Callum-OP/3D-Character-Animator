import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  initAnimation, setAnimationModel, selectClip, clipFromTracks, scrub, play, pause,
  updateRootMotionTrack, updateAnimation, exportClipJSON,
} from '../three/animation.js'

// Regression: after "Save as clip", the position keys live in TWO places —
// the live animData.root overlay the panel edits, and a baked copy inside the
// clip's own mixer tracks. Clicking × on a position key only updated the
// overlay, so once the last key was gone the stale baked copy took over and
// playback kept following the deleted keyframes.
function buildFakeModel() {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  root.add(hips)
  const skinnedMesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const skeleton = new THREE.Skeleton([hips])
  skinnedMesh.bind(skeleton)
  root.add(skinnedMesh)
  return { root, bones: [hips], skinnedMeshes: [skinnedMesh], meshes: [], skeleton, clips: [], info: {} }
}
const Q = [0, 0, 0, 1]
const K = (time, x) => ({ time, pos: [x, 0, 0], quat: Q })
const refs = {
  requestRender() {}, setContinuousRender() {}, getObjectByUuid: () => null,
  suspendPosing() {}, resumePosing() {}, onTime() {}, onEnded() {},
}

function savedClip(id, root) {
  initAnimation(refs)
  const model = buildFakeModel()
  setAnimationModel(model, id)
  const name = clipFromTracks({ Hips: [{ time: 0, quat: Q }, { time: 2, quat: Q }] }, 2, 'My clip', root)
  selectClip(name, {}, { root })
  return { model, name }
}

describe('deleting position keys on a saved clip', () => {
  it('deleting every position key stops playback following them', () => {
    const { model } = savedClip('baked-all', [K(0, 0), K(2, 10)])
    scrub(1)
    expect(model.root.position.x).toBeCloseTo(5)

    updateRootMotionTrack([]) // what the × does once the last key is deleted
    scrub(1)
    play()
    updateAnimation(0.5)
    expect(model.root.position.x).toBeCloseTo(0) // used to be 7.5 — still on the deleted path
  })

  it('deleting one key follows only the remaining keys, and keeps the playhead', () => {
    const { model } = savedClip('baked-some', [K(0, 0), K(1, 10), K(2, 0)])
    scrub(1)
    expect(model.root.position.x).toBeCloseTo(10)

    updateRootMotionTrack([K(0, 0), K(2, 0)]) // the middle key was deleted
    scrub(1)
    expect(model.root.position.x).toBeCloseTo(0)
    play()
    updateAnimation(0.25)
    expect(model.root.position.x).toBeCloseTo(0)
  })

  it('stays paused/playing exactly as it was before the edit', () => {
    const { model } = savedClip('baked-state', [K(0, 0), K(2, 10)])
    scrub(1)
    updateRootMotionTrack([K(0, 0), K(2, 20)])
    updateAnimation(0.5) // paused: must not advance
    expect(model.root.position.x).toBeCloseTo(10)
    play()
    updateAnimation(0.5)
    expect(model.root.position.x).toBeCloseTo(15)
    pause()
  })

  it('the clip that gets saved to a file no longer contains the deleted travel', () => {
    const { name } = savedClip('baked-export', [K(0, 0), K(2, 10)])
    updateRootMotionTrack([])
    const json = JSON.stringify(exportClipJSON(name))
    expect(json).not.toContain('"name":".position"')
  })
})