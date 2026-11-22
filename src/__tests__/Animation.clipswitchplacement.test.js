import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  initAnimation, setAnimationModel, selectClip, clipFromTracks, scrub, stop, markClipKeysAdopted,
} from '../three/animation.js'

// Regression: Stop shows where a keyed-position clip starts, and the next clip used that spot as the
// character's "home". So a clip without its own position keys was drawn wherever the previous clip
// began — and going back to the same clip put the character somewhere else.
function buildFakeModel() {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  root.add(hips)
  const skinned = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const skeleton = new THREE.Skeleton([hips])
  skinned.bind(skeleton)
  root.add(skinned)
  return { root, bones: [hips], skinnedMeshes: [skinned], meshes: [], skeleton, clips: [], info: {} }
}
const Q = [0, 0, 0, 1]
const K = (time, x) => ({ time, pos: [x, 0, 0], quat: Q })
const refs = {
  requestRender() {}, setContinuousRender() {}, getObjectByUuid: () => null,
  suspendPosing() {}, resumePosing() {}, onTime() {}, onEnded() {},
}
const tracks = { Hips: [{ time: 0, quat: Q }, { time: 2, quat: Q }] }
const keysA = [K(0, 3), K(2, 10)]

// What the Animate panel does when you pick a clip.
function pick(name, keys) {
  stop()
  markClipKeysAdopted(keys ? name : null)
  selectClip(name, {}, { root: keys || [] })
}

function setup(id) {
  initAnimation(refs)
  const model = buildFakeModel()
  setAnimationModel(model, id)
  const A = clipFromTracks(tracks, 2, 'A', keysA) // has its own position keys
  const B = clipFromTracks(tracks, 2, 'B', []) // plain clip, no position keys
  model.root.position.set(5, 0, 0) // where the person put the character
  return { model, A, B }
}

describe('switching clips keeps the character where it was placed', () => {
  it('a clip with no keys stays at the placement, whatever clip came before', () => {
    const { model, A, B } = setup('place-1')
    pick(B)
    expect(model.root.position.x).toBeCloseTo(5)
    pick(A, keysA)
    expect(model.root.position.x).toBeCloseTo(3) // its own keyed start
    pick(B)
    expect(model.root.position.x).toBeCloseTo(5) // used to be 3
    scrub(1)
    expect(model.root.position.x).toBeCloseTo(5)
  })

  it('going back and forth always gives the same place in each clip', () => {
    const { model, A, B } = setup('place-2')
    const seen = []
    for (const [n, k] of [[A, keysA], [B], [A, keysA], [B], [A, keysA], [B]]) {
      pick(n, k)
      seen.push(model.root.position.x)
    }
    expect(seen).toEqual([3, 5, 3, 5, 3, 5].map((v) => expect.closeTo(v)))
  })

  it('Stop still shows where the keyed clip starts, and Stop then a plain clip returns home', () => {
    const { model, A, B } = setup('place-3')
    pick(A, keysA)
    stop()
    expect(model.root.position.x).toBeCloseTo(3)
    pick(B)
    expect(model.root.position.x).toBeCloseTo(5)
    stop()
    expect(model.root.position.x).toBeCloseTo(5)
  })

  it('moving the character after Stop becomes its new placement', () => {
    const { model, A, B } = setup('place-4')
    pick(A, keysA)
    stop()
    model.root.position.set(8, 0, 0) // dragged by the person
    pick(B)
    expect(model.root.position.x).toBeCloseTo(8)
    pick(A, keysA)
    pick(B)
    expect(model.root.position.x).toBeCloseTo(8)
  })
})
