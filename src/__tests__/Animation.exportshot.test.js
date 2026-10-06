import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initObjects } from '../three/objects.js'
import { initAnimation, setAnimationModel } from '../three/animation.js'
import { __seedCharacterForTest, clearProjectScene } from '../three/scene.js'
import { runExportShot } from '../three/exportShot.js'

const scene = new THREE.Scene()
const key = (time, x) => ({ time, position: [x, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] })

function seedCharacter(id, clipName, dur) {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'Hips'
  root.add(hips)
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  const skeleton = new THREE.Skeleton([hips])
  mesh.bind(skeleton)
  root.add(mesh)
  const clip = new THREE.AnimationClip(clipName, dur, [
    new THREE.VectorKeyframeTrack('Hips.position', [0, dur], [0, 0, 0, dur, 0, 0]),
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
  useStore.setState({ activeClipName: clipName, playbackSource: 'clip' })
}

beforeEach(() => {
  vi.useFakeTimers()
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
  useStore.setState({
    loop: false,
    speed: 1,
    recording: false,
    previewing: false,
    objectAnimData: {},
    objectAttachmentData: {},
    objectAnimDuration: 2,
    objectAnimPlaying: false,
    stopAtFirstClipEnd: false,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('preview / record plays object motion too', () => {
  it('starts object motion alongside the character and runs for the longer of the two', () => {
    seedCharacter('c1', 'A', 2) // character: 2s
    useStore.setState({ objectAnimData: { box: [key(0, 0), key(5, 5)] }, objectAnimDuration: 5 }) // object: 5s
    const status = []
    runExportShot({ record: false, name: 'shot', onStatus: (m) => status.push(m) })

    expect(useStore.getState().previewing).toBe(true)
    expect(useStore.getState().objectAnimPlaying).toBe(true)
    expect(status[0]).toMatch(/1 character \+ object motion/)

    vi.advanceTimersByTime(3000) // character's 2s is over, object's 5s isn't
    expect(useStore.getState().previewing).toBe(true)

    vi.advanceTimersByTime(2200) // past 5s (+ the preview tail)
    expect(useStore.getState().previewing).toBe(false)
    expect(useStore.getState().objectAnimPlaying).toBe(false)
  })

  it('an object-only scene is previewable (no characters needed)', () => {
    useStore.setState({ objectAnimData: { box: [key(0, 0), key(1, 1)] }, objectAnimDuration: 1 })
    runExportShot({ record: false, name: 'shot', onStatus: () => {} })
    expect(useStore.getState().previewing).toBe(true)
    expect(useStore.getState().objectAnimPlaying).toBe(true)
    vi.advanceTimersByTime(1300)
    expect(useStore.getState().previewing).toBe(false)
  })

  it('says nothing to preview when neither characters nor objects animate', () => {
    const status = []
    runExportShot({ record: false, name: 'shot', onStatus: (m) => status.push(m) })
    expect(useStore.getState().previewing).toBe(false)
    expect(status[0]).toMatch(/Nothing to preview/)
  })

  it('plays objects once even when Loop is on, then restores Loop', () => {
    useStore.setState({ loop: true, objectAnimData: { box: [key(0, 0), key(1, 1)] }, objectAnimDuration: 1 })
    runExportShot({ record: false, name: 'shot', onStatus: () => {} })
    expect(useStore.getState().loop).toBe(false) // shot plays once
    vi.advanceTimersByTime(1300)
    expect(useStore.getState().loop).toBe(true) // user's setting is back
  })

  it('stops a video preview when the shortest character clip ends if enabled', () => {
    seedCharacter('c1', 'A', 2)
    seedCharacter('c2', 'B', 4)
    useStore.setState({
      stopAtFirstClipEnd: true,
      objectAnimData: { box: [key(0, 0), key(5, 5)] },
      objectAnimDuration: 5,
    })
    runExportShot({ record: false, name: 'shot', onStatus: () => {} })

    vi.advanceTimersByTime(2100)
    expect(useStore.getState().previewing).toBe(false)
    expect(useStore.getState().objectAnimPlaying).toBe(false)
  })

  it('films in View mode (no gizmos / picking) and puts the previous mode back afterwards', () => {
    useStore.setState({ mode: 'bone', objectAnimData: { box: [key(0, 0), key(1, 1)] }, objectAnimDuration: 1 })
    runExportShot({ record: false, name: 'shot', onStatus: () => {} })
    expect(useStore.getState().mode).toBe('view')
    vi.advanceTimersByTime(1300)
    expect(useStore.getState().mode).toBe('bone')
  })

  it('also restores the mode when there is nothing to preview', () => {
    useStore.setState({ mode: 'object' })
    runExportShot({ record: false, name: 'shot', onStatus: () => {} })
    expect(useStore.getState().mode).toBe('object')
  })

  it('leaves it alone if the user was already in View mode', () => {
    useStore.setState({ mode: 'view', objectAnimData: { box: [key(0, 0), key(1, 1)] }, objectAnimDuration: 1 })
    runExportShot({ record: false, name: 'shot', onStatus: () => {} })
    vi.advanceTimersByTime(1300)
    expect(useStore.getState().mode).toBe('view')
  })

  it('does not yank the user back to an old mode if they changed it during the shot', () => {
    useStore.setState({ mode: 'bone', objectAnimData: { box: [key(0, 0), key(1, 1)] }, objectAnimDuration: 1 })
    runExportShot({ record: false, name: 'shot', onStatus: () => {} })
    useStore.getState().setMode('object') // e.g. they clicked the Object button mid-shot
    vi.advanceTimersByTime(1300)
    expect(useStore.getState().mode).toBe('object')
  })
})