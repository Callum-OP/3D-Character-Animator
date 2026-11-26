import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { bvhInfo, bvhSingleFrame } from '../three/bvhText.js'
import {
  listEntries, putEntry, deleteEntry, renameEntry, exportLibraryJSON, importLibraryJSON, resetLibraryStoreForTest, LIBRARY_FILE_FORMAT,
  getRenderedThumb, putRenderedThumb,
} from '../three/poseLibraryStore.js'
import { listPresets } from '../three/poseLibraryPresets.js'
import { normalizeSegments, parsedBVHResolver, representativeClipTime } from '../three/poseThumb.js'
import { frameRenderedPoseThumb } from '../three/renderedPoseThumb.js'
import { makeHandBVH } from './helpers/syntheticHand.js'

afterEach(async () => {
  for (const e of await listEntries()) await deleteEntry(e.id)
  resetLibraryStoreForTest()
})

describe('bvh text helpers', () => {
  const text = makeHandBVH({ frames: 4 })
  it('reads frame count and duration from the header', () => {
    const info = bvhInfo(text)
    expect(info.frames).toBe(4)
    expect(info.duration).toBeCloseTo(4 * 0.033333, 4)
  })
  it('cuts a file down to one frame', () => {
    const one = bvhSingleFrame(text, 2)
    expect(bvhInfo(one).frames).toBe(1)
    expect(one.split('\n').filter((l) => /^[-0-9]/.test(l.trim())).length).toBe(1)
    expect(one).toContain('HIERARCHY')
  })
  it('keeps the chosen frame, clamped into range', () => {
    const lines = text.split('\n')
    const i = lines.findIndex((l) => l.startsWith('Frame Time'))
    lines.splice(i + 1, 4, '1 0 0 0 0 0', '2 0 0 0 0 0', '3 0 0 0 0 0', '4 0 0 0 0 0')
    const t = lines.join('\n')
    expect(bvhSingleFrame(t, 1)).toContain('2 0 0 0 0 0')
    expect(bvhSingleFrame(t, 99)).toContain('4 0 0 0 0 0')
  })
})

describe('library storage', () => {
  const body = { kind: 'body', name: 'Wave', thumb: { segs: [] }, data: { bones: { Hips: [0, 0, 0, 1] } } }
  it('saves, lists newest first, renames and deletes', async () => {
    const a = await putEntry({ ...body, createdAt: 1 })
    const b = await putEntry({ ...body, name: 'Bow', createdAt: 2 })
    expect((await listEntries()).map((e) => e.name)).toEqual(['Bow', 'Wave'])
    await renameEntry(a.id, 'Hello')
    expect((await listEntries('body')).map((e) => e.name)).toContain('Hello')
    await deleteEntry(b.id)
    expect(await listEntries()).toHaveLength(1)
  })
  it('filters by kind', async () => {
    await putEntry(body)
    await putEntry({ kind: 'hand', name: 'Fist', data: { poses: {} } })
    expect(await listEntries('hand')).toHaveLength(1)
  })
  it('exports and imports a library without duplicating entries', async () => {
    await putEntry(body)
    const json = await exportLibraryJSON()
    expect(json.format).toBe(LIBRARY_FILE_FORMAT)
    expect(await importLibraryJSON(json)).toBe(0)
    for (const e of await listEntries()) await deleteEntry(e.id)
    expect(await importLibraryJSON(json)).toBe(1)
  })
  it('refuses a file that is not a library', async () => {
    await expect(importLibraryJSON({ nope: true })).rejects.toThrow(/not a Pose Library/)
  })
  it('stores rendered screenshots outside exported library data', async () => {
    await putRenderedThumb('pose-1', new Blob(['image'], { type: 'image/webp' }))
    const screenshot = await getRenderedThumb('pose-1')
    expect(screenshot.type).toBe('image/webp')
    expect(screenshot.size).toBe(5)
    const json = await exportLibraryJSON()
    expect(json.entries.every((entry) => !entry.renderedThumb)).toBe(true)
    await deleteEntry('pose-1')
    expect(await getRenderedThumb('pose-1')).toBeNull()
  })
})

describe('presets and thumbnails', () => {
  it.each(['body', 'animation'])('fits the posed character mesh in %s card images', (kind) => {
    const root = new THREE.Group()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.25, 0, 0, 0.25, 0, 0, 0, 2, 0], 3))
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4))
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4))
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
    const hips = new THREE.Bone()
    const head = new THREE.Bone()
    head.position.y = 1.4
    hips.add(head)
    mesh.add(hips)
    root.add(mesh)
    mesh.bind(new THREE.Skeleton([hips, head]))
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100)

    for (const angle of [0, -Math.PI / 2]) {
      hips.rotation.z = angle
      frameRenderedPoseThumb({ root, camera }, { kind })
      camera.updateMatrixWorld()
      for (let i = 0; i < 3; i++) {
        const point = mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).project(camera)
        expect(Math.abs(point.x)).toBeLessThan(0.9)
        expect(Math.abs(point.y)).toBeLessThan(0.9)
      }
    }
  })

  it('lists presets (none ship by default) without crashing', () => {
    expect(Array.isArray(listPresets('body'))).toBe(true)
  })
  it('scales segments into the 0..100 box keeping their shape', () => {
    const { segs } = normalizeSegments([[0, 0, 2, 0], [0, 0, 0, 1]])
    const xs = segs.flatMap((s) => [s[0], s[2]])
    const ys = segs.flatMap((s) => [s[1], s[3]])
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2 * (Math.max(...ys) - Math.min(...ys)), 0)
    expect(Math.max(...xs, ...ys)).toBeLessThanOrEqual(100)
    expect(Math.min(...xs, ...ys)).toBeGreaterThanOrEqual(0)
  })
  it('uses a noticeable pose instead of frame zero for animation thumbnails', () => {
    const clip = new THREE.AnimationClip('Wave', 2, [
      new THREE.QuaternionKeyframeTrack(
        'Spine.quaternion',
        [0, 1, 2],
        [0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 0, 0, 0, 1],
      ),
    ])
    expect(representativeClipTime(clip)).toBeCloseTo(1)
  })
  it('resolves BVH track UUIDs back to source bone names', () => {
    const resolve = parsedBVHResolver({ skeleton: { bones: [{ uuid: 'abc-123', name: 'mixamorigSpine' }] } })
    expect(resolve('abc-123')).toBe('mixamorigSpine')
    expect(resolve('Spine')).toBe('Spine')
  })
})

