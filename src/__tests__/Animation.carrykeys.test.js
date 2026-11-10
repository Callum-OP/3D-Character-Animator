import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  initAnimation, setAnimationModel, selectClip, clipFromTracks, scrub, markClipKeysAdopted, overlayForClip,
} from '../three/animation.js'

// Keyed positions belong to the clip they were keyed on. Going from a clip with
// keyed positions to one without used to leave the first clip's keys layered
// on top of the second, so it moved differently than it was made. Now each clip
// plays only its own keys unless "carry keyed positions" is switched on.
function buildFakeModel() {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  root.add(hips)
  const skinnedMesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  skinnedMesh.bind(new THREE.Skeleton([hips]))
  root.add(skinnedMesh)
  return { root, bones: [hips], skinnedMeshes: [skinnedMesh], meshes: [], skeleton: root && new THREE.Skeleton([hips]), clips: [], info: {} }
}
const makeRefs = (carry) => ({
  requestRender() {}, setContinuousRender() {}, getObjectByUuid: () => null,
  suspendPosing() {}, resumePosing() {}, onTime() {}, onEnded() {},
  getCarryKeysAcrossClips: () => carry,
})
const ID = [0, 0, 0, 1]
const RK = (time, x) => ({ time, pos: [x, 0, 0], quat: ID })
const TRACKS = { Hips: [{ time: 0, quat: ID }, { time: 2, quat: ID }] }

function setup(id, carry) {
  initAnimation(makeRefs(carry))
  const model = buildFakeModel()
  setAnimationModel(model, id)
  const keyed = clipFromTracks(TRACKS, 2, 'Keyed', [RK(0, 0), RK(2, 10)])
  const plain = clipFromTracks(TRACKS, 2, 'Plain', null)
  // what the editor holds after Keyed was selected
  const editorData = { tracks: TRACKS, root: [RK(0, 0), RK(2, 10)], meshes: {}, morphs: {} }
  return { model, keyed, plain, editorData }
}

describe('keyed positions stay on their own clip', () => {
  it('a clip with no keyed positions plays as it was made, not with the previous clip\'s keys', () => {
    const { model, plain, editorData } = setup('ck-off', false)
    markClipKeysAdopted(null) // the editor's keys came from another clip
    selectClip(plain, {}, editorData)
    scrub(2)
    expect(model.root.position.x).toBeCloseTo(0)
  })

  it('a clip that owns the editor\'s keys still plays them', () => {
    const { model, keyed, editorData } = setup('ck-own', false)
    markClipKeysAdopted(keyed)
    selectClip(keyed, {}, editorData)
    scrub(2)
    expect(model.root.position.x).toBeCloseTo(10)
  })

  it('with carrying on, the keys are layered over any clip as before', () => {
    const { model, plain, editorData } = setup('ck-on', true)
    markClipKeysAdopted(null)
    selectClip(plain, {}, editorData)
    scrub(2)
    expect(model.root.position.x).toBeCloseTo(10)
  })

  it('overlayForClip drops only position keys and part/shape edits, never cameras, lights or cuts', () => {
    const { plain } = setup('ck-overlay', false)
    markClipKeysAdopted(null)
    const data = {
      tracks: TRACKS, root: [RK(0, 0), RK(2, 10)],
      meshes: { Hood: [{ time: 0 }] }, morphs: {},
      cameras: { Cam: [{ time: 0 }] }, lights: { L: [{ time: 0 }] }, cuts: [{ time: 0, camera: 'Cam' }],
    }
    const out = overlayForClip(data, plain)
    expect(out.root).toEqual([])
    expect(out.meshes).toEqual({})
    expect(out.cameras).toBe(data.cameras)
    expect(out.lights).toBe(data.lights)
    expect(out.cuts).toBe(data.cuts)
    expect(data.root).toHaveLength(2) // the editor's own data is untouched
  })
})
