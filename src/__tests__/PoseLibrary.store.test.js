import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { bvhInfo, bvhSingleFrame } from '../three/bvhText.js'
import {
  listEntries, putEntry, deleteEntry, renameEntry, exportLibraryJSON, importLibraryJSON, resetLibraryStoreForTest, LIBRARY_FILE_FORMAT,
} from '../three/poseLibraryStore.js'
import { listPresets } from '../three/poseLibraryPresets.js'
import { normalizeSegments } from '../three/poseThumb.js'
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
})

describe('presets and thumbnails', () => {
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
})

