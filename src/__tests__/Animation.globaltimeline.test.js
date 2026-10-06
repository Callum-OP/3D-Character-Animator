import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects } from '../three/objects.js'
import { initAnimation, setAnimationModel } from '../three/animation.js'
import {
  __seedCharacterForTest,
  clearProjectScene,
  getAllTimelineDuration,
  scrubAllTimeline,
  stopAllCharacters,
} from '../three/scene.js'

const scene = new THREE.Scene()

// One bone ("Hips") that slides along +X; `speed` units per second over `dur` seconds.
function makeCharacter(id, clipName, dur, speed) {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  root.add(hips)
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const skeleton = new THREE.Skeleton([hips])
  mesh.bind(skeleton)
  root.add(mesh)
  const clip = new THREE.AnimationClip(clipName, dur, [
    new THREE.VectorKeyframeTrack('Hips.position', [0, dur], [0, 0, 0, dur * speed, 0, 0]),
  ])
  const parsed = {
    root,
    bones: [hips],
    skinnedMeshes: [mesh],
    meshes: [],
    skeleton,
    clips: [clip],
    info: { name: id, clipNames: [clipName], bones: [], meshCount: 1, boneCount: 1 },
  }
  __seedCharacterForTest(id, parsed, scene)
  setAnimationModel(parsed, id)
  return parsed
}

let c1
let c2

beforeEach(() => {
  const refs = {
    requestRender: () => {},
    suspendPosing: () => {},
    resumePosing: () => {},
    onTime: () => {},
    setContinuousRender: () => {},
    onEnded: () => {},
  }
  initObjects({
    scene,
    camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: document.createElement('canvas') },
    controls: { enabled: true, locked: false },
    requestRender: () => {},
  })
  initAnimation(refs)
  clearProjectScene()
  useStore.setState({ loop: false, speed: 1, objectAnimData: {}, objectAnimDuration: 2, globalTime: 0 })
  c1 = makeCharacter('c1', 'A', 2, 1) // 2s, 1 unit/s
  c2 = makeCharacter('c2', 'B', 4, 2) // 4s, 2 units/s (active character after seeding)
  // c1 became a stored (inactive) character when c2 was added.
  useStore.setState((s) => ({
    activeClipName: 'B',
    playbackSource: 'clip',
    characters: { ...s.characters, c1: { ...s.characters.c1, activeClipName: 'A', playbackSource: 'clip' } },
  }))
})

describe('all-animation timeline', () => {
  it('is as long as the longest character clip, or the object motion if that is longer', () => {
    expect(getAllTimelineDuration()).toBeCloseTo(4, 5)
    useStore.setState({
      objectAnimData: { box: [{ time: 0, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }] },
      objectAnimDuration: 6,
    })
    expect(getAllTimelineDuration()).toBeCloseTo(6, 5)
  })

  it('scrubbing puts every character at the same time on its own clip, paused', () => {
    scrubAllTimeline(1)
    expect(c1.bones[0].position.x).toBeCloseTo(1, 3) // A: 1 unit/s
    expect(c2.bones[0].position.x).toBeCloseTo(2, 3) // B: 2 units/s
    const s = useStore.getState()
    expect(s.globalTime).toBeCloseTo(1, 5)
    expect(s.playback).toBe('paused')
  })

  it('a shorter clip holds its last pose past its end (loop off) or wraps (loop on)', () => {
    scrubAllTimeline(3)
    expect(c1.bones[0].position.x).toBeCloseTo(2, 3) // A ended at 2s, holds
    expect(c2.bones[0].position.x).toBeCloseTo(6, 3)
    useStore.setState({ loop: true })
    scrubAllTimeline(3)
    expect(c1.bones[0].position.x).toBeCloseTo(1, 3) // 3s wraps to 1s of A
    expect(c2.bones[0].position.x).toBeCloseTo(6, 3)
  })

  it('also drives object motion to the same time and leaves it paused', () => {
    useStore.setState({
      objectAnimData: { box: [{ time: 0, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, { time: 3, position: [3, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }] },
      objectAnimDuration: 3,
    })
    scrubAllTimeline(2)
    const s = useStore.getState()
    expect(s.objectAnimTime).toBeCloseTo(2, 5)
    expect(s.objectAnimPlaying).toBe(false)
  })

  it('Stop all returns the shared playhead to 0', () => {
    scrubAllTimeline(2)
    stopAllCharacters()
    expect(useStore.getState().globalTime).toBe(0)
  })
})