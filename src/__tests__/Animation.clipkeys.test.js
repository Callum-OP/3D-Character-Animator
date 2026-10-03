import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  initAnimation, setAnimationModel, selectClip, clipFromTracks, scrub, play, updateAnimation,
  exportClipJSON, importClipJSON, getClipEditKeys, rebakeClipFromKeys, markClipKeysAdopted,
} from '../three/animation.js'

// Regression: after "Save as clip" the poses are baked into the clip, so
// deleting the last keyed position (which also drops its pose key) only changed
// the editing data — the clip kept playing/holding the deleted pose. A saved
// clip now remembers its keys, and edits rebuild the clip from them.
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
const refs = {
  requestRender() {}, setContinuousRender() {}, getObjectByUuid: () => null,
  suspendPosing() {}, resumePosing() {}, onTime() {}, onEnded() {},
}
const ID = [0, 0, 0, 1]
const TURN = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] // 90° about Y
const RK = (time, x, quat = ID) => ({ time, pos: [x, 0, 0], quat })

function keys() {
  return {
    tracks: { Hips: [{ time: 0, quat: ID }, { time: 2, quat: TURN }] },
    root: [RK(0, 0), RK(2, 10)],
  }
}

function setup(id) {
  initAnimation(refs)
  const model = buildFakeModel()
  setAnimationModel(model, id)
  const k = keys()
  const name = clipFromTracks(k.tracks, 2, 'My clip', k.root)
  selectClip(name, {}, { root: k.root })
  return { model, name, hips: model.bones[0] }
}

describe('saved clips remember their keyframes', () => {
  it('stores the keys on the clip', () => {
    const { name } = setup('ck-store')
    const stored = getClipEditKeys(name)
    expect(stored.duration).toBe(2)
    expect(stored.tracks.Hips).toHaveLength(2)
    expect(stored.root).toHaveLength(2)
  })

  it('deleting the last keyed position (and its pose) changes the clip pose', () => {
    const { name, hips, model } = setup('ck-delete')
    markClipKeysAdopted(name)
    scrub(2)
    expect(hips.quaternion.y).toBeCloseTo(Math.sin(Math.PI / 4)) // the turned pose
    expect(model.root.position.x).toBeCloseTo(10)

    // What the × does: the position key AND its pose key at t=2 are removed.
    const ok = rebakeClipFromKeys(name, {
      tracks: { Hips: [{ time: 0, quat: ID }] },
      root: [RK(0, 0)],
      duration: 2,
    })
    expect(ok).toBe(true)
    scrub(2)
    expect(hips.quaternion.y).toBeCloseTo(0) // used to stay turned
    expect(model.root.position.x).toBeCloseTo(0)
    expect(getClipEditKeys(name).tracks.Hips).toHaveLength(1)
  })

  it('keeps the playhead, pause state and duration across a rebuild', () => {
    const { name, hips } = setup('ck-state')
    markClipKeysAdopted(name)
    scrub(1)
    rebakeClipFromKeys(name, { ...keys(), duration: 2 })
    updateAnimation(0.5) // paused: must not advance
    expect(hips.quaternion.y).toBeCloseTo(Math.sin(Math.PI / 8)) // halfway to the turn at t=1
    play()
    updateAnimation(0.5)
    expect(hips.quaternion.y).toBeCloseTo(Math.sin(Math.PI / 4) * 0.75 + 0.0, 1) // moved on from t=1
  })

  it('refuses to rebuild a clip whose keys the editor is not showing', () => {
    const { name, hips } = setup('ck-guard')
    markClipKeysAdopted(null)
    expect(rebakeClipFromKeys(name, { tracks: {}, root: [], duration: 2 })).toBe(false)
    scrub(2)
    expect(hips.quaternion.y).toBeCloseTo(Math.sin(Math.PI / 4)) // untouched
  })

  it('survives Save Clip As / Open Clip', () => {
    const { name } = setup('ck-roundtrip')
    const json = JSON.parse(JSON.stringify(exportClipJSON(name)))
    expect(json.editKeys.tracks.Hips).toHaveLength(2)

    const reopened = importClipJSON(json)
    const stored = getClipEditKeys(reopened)
    expect(stored.tracks.Hips).toHaveLength(2)
    expect(stored.root).toHaveLength(2)

    // ...and the reopened clip can be edited the same way.
    markClipKeysAdopted(reopened)
    selectClip(reopened, {}, { root: stored.root })
    expect(rebakeClipFromKeys(reopened, { tracks: { Hips: [{ time: 0, quat: ID }] }, root: [], duration: 2 })).toBe(true)
    scrub(2)
    expect(getClipEditKeys(reopened).tracks.Hips).toHaveLength(1)
  })
})
