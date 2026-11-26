import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as THREE from 'three'

const preview = vi.hoisted(() => ({ root: null, render: null }))

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    WebGLRenderer: class {
      constructor() { this.domElement = document.createElement('canvas') }
      setPixelRatio() {}
      setClearColor() {}
      setSize() {}
      render(...args) { preview.render(...args) }
      dispose() {}
    },
  }
})

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    load(_url, onLoad) { queueMicrotask(() => onLoad({ scene: preview.root })) }
  },
}))

vi.mock('../three/poseLibraryActions.js', () => ({
  applyBodyEntry: vi.fn(),
  applyHandEntry: vi.fn(),
  applyAnimationEntry: vi.fn(),
  saveCurrentBodyPose: vi.fn(),
  saveCurrentHandPose: vi.fn(),
  saveClipToLibrary: vi.fn(),
  backfillAnimationThumb: vi.fn(async (entry) => entry),
  BASIC_HANDS: [],
}))
vi.mock('../three/poseLibraryPresets.js', () => ({
  listPresets: () => [],
  presetThumb: async () => ({ segs: [] }),
}))

const PoseLibrary = (await import('../panels/PoseLibrary.jsx')).default
const store = await import('../three/poseLibraryStore.js')
const { useStore } = await import('../store.js')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Pose Library animation preview', () => {
  it('keeps the head above the highest bone in view, including after resizing', async () => {
    const root = new THREE.Group()
    const hips = new THREE.Bone()
    const head = new THREE.Bone()
    head.position.y = 1.65
    hips.add(head)
    root.add(hips)
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2, 0.5), new THREE.MeshBasicMaterial())
    mesh.position.y = 1
    root.add(mesh)
    preview.root = root
    preview.render = vi.fn()

    let width = 300
    let resize
    let frame
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 200 }))
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => { frame = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { resize = callback }
      observe() {}
      disconnect() {}
    })

    useStore.setState({ poseLibraryTab: 'body', modelInfo: { name: 'x' }, qualityPreset: 'standard' })
    render(<PoseLibrary />)
    await waitFor(() => expect(screen.queryByText('Loading example model…')).toBeNull())

    const assertHeadVisible = () => {
      const camera = preview.render.mock.calls.at(-1)?.[1]
      expect(camera).toBeDefined()
      camera.updateMatrixWorld()
      const top = new THREE.Vector3(0, 2, 0).project(camera)
      expect(top.y).toBeLessThan(0.95)
      expect(top.y).toBeGreaterThan(-1)
    }

    act(() => frame())
    assertHeadVisible()
    width = 200
    act(() => { resize(); frame() })
    assertHeadVisible()
    const camera = preview.render.mock.calls.at(-1)[1]
    expect((camera.right - camera.left) / (camera.top - camera.bottom)).toBeCloseTo(1)
  })

  it('plays a hovered clip, holds its representative pose, and replays on hover', async () => {
    const root = new THREE.Group()
    const bone = new THREE.Bone()
    bone.name = 'Hips'
    root.add(bone)
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial()))
    preview.root = root
    preview.render = vi.fn()

    let callback
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', vi.fn((next) => { callback = next; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })

    const end = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
    const clip = new THREE.AnimationClip('Wave', 1, [
      new THREE.QuaternionKeyframeTrack('Hips.quaternion', [0, 1], [0, 0, 0, 1, ...end.toArray()]),
    ])
    const entry = await store.putEntry({ kind: 'animation', name: 'Preview wave', data: { clip: THREE.AnimationClip.toJSON(clip) } })
    useStore.setState({ poseLibraryTab: 'animation', modelInfo: { name: 'x' }, qualityPreset: 'standard' })
    render(<PoseLibrary />)
    const card = (await screen.findByTitle('Apply “Preview wave”')).closest('.pl-card')
    await act(async () => { fireEvent.mouseEnter(card) })

    now = 500
    act(() => callback())
    expect(bone.quaternion.angleTo(end)).toBeCloseTo(Math.PI / 4)
    expect(preview.render).toHaveBeenCalled()

    now = 1100
    act(() => callback())
    expect(bone.quaternion.angleTo(end)).toBeCloseTo(0)

    await act(async () => { fireEvent.mouseEnter(card) })
    expect(bone.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(0)
    now = 1600
    act(() => callback())
    expect(bone.quaternion.angleTo(end)).toBeCloseTo(Math.PI / 4)
    await store.deleteEntry(entry.id)
  })
})
