import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects } from '../three/objects.js'
import {
  initAnimation,
  setAnimationModel,
  selectClip,
  play,
  scrub,
  hasActiveAction,
  getCurrentTime,
} from '../three/animation.js'
import { __seedCharacterForTest, clearProjectScene, stopActiveCharacter, stopAllCharacters } from '../three/scene.js'

const scene = new THREE.Scene()

function makeCharacter(id) {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  root.add(hips)
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const skeleton = new THREE.Skeleton([hips])
  mesh.bind(skeleton)
  root.add(mesh)
  const clip = new THREE.AnimationClip('Walk', 2, [
    new THREE.VectorKeyframeTrack('Hips.position', [0, 2], [0, 0, 0, 2, 0, 0]),
  ])
  const parsed = {
    root,
    bones: [hips],
    skinnedMeshes: [mesh],
    meshes: [mesh],
    skeleton,
    clips: [clip],
    info: { name: id, clipNames: ['Walk'], bones: [], meshCount: 1, boneCount: 1 },
  }
  __seedCharacterForTest(id, parsed, scene)
  setAnimationModel(parsed, id)
  return parsed
}

let c
beforeEach(() => {
  initObjects({
    scene,
    camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: document.createElement('canvas') },
    controls: { enabled: true, locked: false },
    requestRender: () => {},
  })
  initAnimation({
    requestRender: () => {},
    suspendPosing: () => {},
    resumePosing: () => {},
    onTime: () => {},
    setContinuousRender: () => {},
    onEnded: () => {},
  })
  clearProjectScene()
  useStore.setState({ loop: false, speed: 1 })
  c = makeCharacter('c1')
})

describe('single Play / Stop', () => {
  it('Play does nothing until the clip is armed, which is why the panel must arm whenever nothing is armed', () => {
    expect(hasActiveAction()).toBe(false)
    expect(play()).toBe(false)
    selectClip('Walk', { loop: false, speed: 1 })
    expect(hasActiveAction()).toBe(true)
    expect(play()).toBe(true)
  })

  it('Stop returns the rig to rest and disarms the clip', () => {
    selectClip('Walk', { loop: false, speed: 1 })
    play()
    scrub(1)
    stopActiveCharacter()
    expect(hasActiveAction()).toBe(false)
    expect(getCurrentTime()).toBe(0)
    expect(c.bones[0].position.x).toBeCloseTo(0, 5)
  })

  it('Stop all does the same per character', () => {
    selectClip('Walk', { loop: false, speed: 1 })
    play()
    stopAllCharacters()
    expect(hasActiveAction()).toBe(false)
  })
})
