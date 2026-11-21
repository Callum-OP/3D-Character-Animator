import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import { useStore } from '../store.js'
import { initObjects } from '../three/objects.js'
import { initIk, setIkConfig, clearIk, lockBonesInPlace, applyFixedPinsForModel, fixedPinBonesForModel, hasFixedPinsForModel } from '../three/ikpins.js'
import { initAnimation, setAnimationModel, selectClip, scrub, exportAnimationBVH, exportClipJSON, setPinBaker } from '../three/animation.js'

const CHAR = 1
let scene, model

// Hips -> UpLeg -> Leg -> Foot, plus a Clip that sways/dips the hips and tips the foot: without a lock the foot moves a lot.
function buildModel() {
  const root = new THREE.Group()
  const mk = (name, x, y, z, parent) => { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); parent.add(b); return b }
  const hips = mk('Hips', 0, 1, 0, root)
  const up = mk('LeftUpLeg', 0, 0, 0, hips)
  const low = mk('LeftLeg', 0, -0.5, 0, up)
  const foot = mk('LeftFoot', 0, -0.5, 0, low)
  const bones = [hips, up, low, foot]
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  mesh.bind(new THREE.Skeleton(bones))
  root.add(mesh)
  const times = [0, 0.5, 1]
  const hipPos = [0, 0.94, 0, 0.06, 0.9, 0, -0.05, 0.92, 0]
  const knee = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5)
  const thigh = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.25)
  const tip = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a)
  const clip = new THREE.AnimationClip('Dance', 1, [
    new THREE.VectorKeyframeTrack('Hips.position', times, hipPos),
    new THREE.QuaternionKeyframeTrack('LeftUpLeg.quaternion', [0, 1], [...thigh.toArray(), ...thigh.toArray()]),
    new THREE.QuaternionKeyframeTrack('LeftLeg.quaternion', [0, 1], [...knee.toArray(), ...knee.toArray()]),
    new THREE.QuaternionKeyframeTrack('LeftFoot.quaternion', times, [...tip(0).toArray(), ...tip(0.5).toArray(), ...tip(-0.4).toArray()]),
  ])
  return { root, bones, skinnedMeshes: [mesh], meshes: [], skeleton: mesh.skeleton, clips: [clip], info: {} }
}

const refs = { requestRender: () => {}, suspendPosing: () => {}, resumePosing: () => {}, onTime: () => {}, setContinuousRender: () => {} }
const emptyAnim = { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} }
const spread = (pts) => { const d = (i) => pts.map((p) => p[i]); return Math.max(...[0, 1, 2].map((i) => Math.max(...d(i)) - Math.min(...d(i)))) }

beforeAll(() => {
  scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.updateMatrixWorld(true)
  const canvas = document.createElement('canvas')
  const r = { scene, camera, renderer: { domElement: canvas }, controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 2 }
  initObjects(r)
  initIk(r)
  initAnimation(refs)
  model = buildModel()
  scene.add(model.root)
  setAnimationModel(model, 'test-char')
  setPinBaker({ apply: applyFixedPinsForModel, bones: fixedPinBonesForModel, any: hasFixedPinsForModel })
  useStore.setState({ activeCharacterId: CHAR, characters: {}, ikPins: [], ikEnabled: true, sceneObjects: [], modelInfo: { bones: model.bones.map((b) => ({ name: b.name })) } })
  setIkConfig(CHAR, model, true, [])
})

function bvhFootPositions(text) {
  const { skeleton, clip } = new BVHLoader().parse(text)
  const by = Object.fromEntries(skeleton.bones.map((b) => [b.name, b]))
  const tr = Object.fromEntries(clip.tracks.map((t) => [t.name, t]))
  const n = tr['Hips.position'].times.length
  const out = []
  for (let k = 0; k < n; k++) {
    for (const b of skeleton.bones) { const t = tr[`${b.name}.quaternion`]; if (t) b.quaternion.fromArray(t.values, k * 4) }
    by.Hips.position.fromArray(tr['Hips.position'].values, k * 3)
    by.Hips.updateWorldMatrix(false, true)
    out.push(by.LeftFoot.getWorldPosition(new THREE.Vector3()).toArray())
  }
  return out
}

describe('locks are baked into exports', () => {
  it('exported BVH has the locked foot standing still; without the lock the foot moves', () => {
    selectClip('Dance')
    scrub(0)
    const free = bvhFootPositions(exportAnimationBVH(emptyAnim, 10, 1, 'Dance', 'clip'))
    expect(spread(free)).toBeGreaterThan(0.05)

    scrub(0)
    lockBonesInPlace(['LeftFoot'], { characterId: CHAR })
    const locked = bvhFootPositions(exportAnimationBVH(emptyAnim, 10, 1, 'Dance', 'clip'))
    expect(spread(locked)).toBeLessThan(0.012)
  })

  it('a saved clip carries the lock: played back with the pins off, the foot still does not move', () => {
    const json = exportClipJSON('Dance', { fps: 20 })
    const baked = THREE.AnimationClip.parse(json.clip)
    // the original clip is untouched in the library
    const orig = exportClipJSON('Dance', { fps: 20 })
    expect(orig.clip.tracks.length).toBe(json.clip.tracks.length)

    // evaluate the saved clip on the rig with the pins switched OFF
    setIkConfig(CHAR, model, false, useStore.getState().ikPins)
    const mixer = new THREE.AnimationMixer(model.root)
    const act = mixer.clipAction(baked)
    act.play()
    const pts = []
    for (let i = 0; i <= 10; i++) {
      mixer.setTime(i / 10)
      model.root.updateMatrixWorld(true)
      pts.push(model.bones[3].getWorldPosition(new THREE.Vector3()).toArray())
    }
    mixer.stopAllAction()
    setIkConfig(CHAR, model, true, useStore.getState().ikPins)
    expect(spread(pts)).toBeLessThan(0.012)
  })

  it('does nothing to clips or exports when there are no locks', () => {
    clearIk(CHAR)
    useStore.setState({ ikPins: [] })
    setIkConfig(CHAR, model, true, [])
    const json = exportClipJSON('Dance')
    const plain = THREE.AnimationClip.parse(json.clip)
    expect(plain.tracks.map((t) => t.name).sort()).toEqual(model.clips[0].tracks.map((t) => t.name).sort())
    expect(plain.tracks.find((t) => t.name === 'LeftFoot.quaternion').times.length).toBe(3) // not re-sampled
  })
})
