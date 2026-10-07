import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  listRecentClips,
  openClipFromFileObject,
  openRecentClip,
  removeRecentClip,
  saveClipAs,
} from '../three/clipLibrary.js'
import { openDB, DB_NAME, PROJECTS_STORE, CLIPS_STORE } from '../three/localdb.js'
import { POSE_FORMAT, poseToJSON, readPoseFile, validatePose } from '../three/poses.js'

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = resolve
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error(`Database deletion was blocked: ${name}`))
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  delete window.animare
  delete window.showOpenFilePicker
  delete window.showSaveFilePicker
  await deleteDatabase(DB_NAME)
})

describe('pose files', () => {
  it('serializes each bone local quaternion using the documented pose format', () => {
    const shoulder = new THREE.Bone()
    shoulder.name = 'Shoulder'
    shoulder.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 3)
    const hip = new THREE.Bone()
    hip.name = 'Hip'

    const result = poseToJSON([shoulder, hip])

    expect(result.format).toBe(POSE_FORMAT)
    expect(result.bones.Shoulder).toHaveLength(4)
    expect(new THREE.Quaternion(...result.bones.Shoulder).angleTo(shoulder.quaternion)).toBeCloseTo(0)
    expect(result.bones.Hip).toEqual([0, 0, 0, 1])
    expect(() => validatePose(result)).not.toThrow()
  })

  it.each([
    [null, /pose-v1/],
    [{ format: 'other', bones: {} }, /pose-v1/],
    [{ format: POSE_FORMAT, bones: null }, /pose-v1/],
    [{ format: POSE_FORMAT, bones: [] }, /pose-v1/],
  ])('rejects invalid pose documents %#', (document, message) => {
    expect(() => validatePose(document)).toThrow(message)
  })

  it('parses pose JSON from a file and reports malformed JSON', async () => {
    const valid = new File([JSON.stringify({ format: POSE_FORMAT, bones: { Root: [0, 0, 0, 1] } })], 'pose.pose.json')
    expect(await readPoseFile(valid)).toEqual({ format: POSE_FORMAT, bones: { Root: [0, 0, 0, 1] } })

    const invalid = new File(['{'], 'broken.pose.json')
    await expect(readPoseFile(invalid)).rejects.toThrow()
  })
})

describe('shared IndexedDB setup', () => {
  it('creates the projects and clips stores together at the shared database version', async () => {
    const db = await openDB()
    expect(db.version).toBe(3)
    expect(db.objectStoreNames.contains(PROJECTS_STORE)).toBe(true)
    expect(db.objectStoreNames.contains(CLIPS_STORE)).toBe(true)
    db.close()
  })

  it('migrates legacy stores out while retaining both current recent-file stores', async () => {
    const old = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('projects', { keyPath: 'id' })
        request.result.createObjectStore('clipLibrary', { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    old.close()

    const migrated = await openDB()
    expect(migrated.objectStoreNames.contains('projects')).toBe(false)
    expect(migrated.objectStoreNames.contains('clipLibrary')).toBe(false)
    expect(migrated.objectStoreNames.contains(PROJECTS_STORE)).toBe(true)
    expect(migrated.objectStoreNames.contains(CLIPS_STORE)).toBe(true)
    migrated.close()
  })
})

describe('clip file workflow', () => {
  it('opens a clip file, records it in recents, and removes only the requested recent entry', async () => {
    const clip = { clip: { name: 'Walk' }, meshTracks: {} }
    const opened = await openClipFromFileObject(new File([JSON.stringify(clip)], 'Walk.3dclip'))
    expect(opened).toMatchObject({ json: clip, name: 'Walk.3dclip', handle: null })
    const [recent] = await listRecentClips()
    expect(recent.name).toBe('Walk.3dclip')

    await removeRecentClip(recent.id)
    expect(await listRecentClips()).toEqual([])
  })

  it('rejects corrupt clip files with a format-specific message', async () => {
    await expect(openClipFromFileObject(new File(['not json'], 'broken.3dclip')))
      .rejects.toThrow(/not a valid clip/)
    expect(await listRecentClips()).toEqual([])
  })

  it('writes a sanitized filename and JSON content through the desktop file bridge', async () => {
    const filePath = 'C:\\Clips\\.._Walk_Cycle.3dclip'
    const bridge = {
      isElectron: true,
      pickSaveFile: vi.fn().mockResolvedValue(filePath),
      writeFile: vi.fn().mockResolvedValue(undefined),
      baseName: vi.fn().mockResolvedValue('.._Walk_Cycle.3dclip'),
    }
    window.animare = bridge
    const json = { clip: { name: 'Walk' } }

    const saved = await saveClipAs(json, '../Walk:Cycle')

    expect(bridge.pickSaveFile).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: '.._Walk_Cycle.3dclip' }))
    expect(saved).toMatchObject({ handle: filePath, name: '.._Walk_Cycle.3dclip' })
    expect(bridge.writeFile).toHaveBeenCalledWith(filePath, JSON.stringify(json))
    expect((await listRecentClips()).map((recent) => recent.name)).toEqual(['.._Walk_Cycle.3dclip'])
  })

  it('does not reopen a recent clip when read permission is denied', async () => {
    const handle = {
      queryPermission: vi.fn().mockResolvedValue('denied'),
      requestPermission: vi.fn().mockResolvedValue('denied'),
    }
    await expect(openRecentClip({ id: 'clip', name: 'Walk.3dclip', handle }))
      .rejects.toThrow(/Permission to read/)
  })
})
