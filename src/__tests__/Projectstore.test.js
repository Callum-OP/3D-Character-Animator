import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  listRecentProjects,
  removeRecentProject,
  openRecentProject,
  openProjectFromFileObject,
  saveProjectAs,
} from '../three/projectStore.js'

// projectStore.js now backs the "Project" panel's Open / Save / Save As
// flow: a project lives as a real file on disk, and this module just keeps
// a small "recent files" list (plus, on supporting browsers, the file
// handles themselves) in IndexedDB. There is no more in-browser "saved
// projects" slot to save/load/delete by name — this test suite covers the
// recents list and the file round-trip instead.
describe('projectStore recents list (IndexedDB)', () => {
  beforeEach(async () => {
    for (const r of await listRecentProjects()) await removeRecentProject(r.id)
  })

  it('adds an entry to the recent list after opening a file (no handle in jsdom)', async () => {
    const file = new File([JSON.stringify({ name: 'Alpha', foo: 'bar' })], 'Alpha.3dcp', {
      type: 'application/json',
    })
    const { record, name } = await openProjectFromFileObject(file)
    expect(record.foo).toBe('bar')
    expect(name).toBe('Alpha.3dcp')

    const recents = await listRecentProjects()
    expect(recents.map((r) => r.name)).toContain('Alpha.3dcp')
  })

  it('round-trips a nested blob-like field through open/save-as JSON encoding', async () => {
    const file = new File(['hello'], 'model.glb', { type: 'model/gltf-binary' })
    const original = { name: 'Beta', savedAt: 100, modelBlob: file, foo: 'bar' }

    // saveProjectAs() falls back to a forced download when there's no File
    // System Access API (as in jsdom) — that still exercises the base64
    // blob-embedding path, it just can't be read back without a handle, so
    // we only assert it doesn't throw and does register a recent entry.
    await expect(saveProjectAs(original, 'Beta')).resolves.toMatchObject({ handle: null })

    const recents = await listRecentProjects()
    expect(recents.some((r) => r.name.startsWith('Beta'))).toBe(true)
  })

  it('lists recents newest-first', async () => {
    const mk = (name) => new File([JSON.stringify({ name })], name, { type: 'application/json' })
    await openProjectFromFileObject(mk('Oldest.3dcp'))
    await openProjectFromFileObject(mk('Newest.3dcp'))

    const names = (await listRecentProjects()).map((r) => r.name)
    expect(names[0]).toBe('Newest.3dcp')
    expect(names).toContain('Oldest.3dcp')
  })

  it('removeRecentProject removes exactly the targeted entry', async () => {
    const mk = (name) => new File([JSON.stringify({ name })], name, { type: 'application/json' })
    await openProjectFromFileObject(mk('KeepMe.3dcp'))
    await openProjectFromFileObject(mk('DeleteMe.3dcp'))

    const toDelete = (await listRecentProjects()).find((r) => r.name === 'DeleteMe.3dcp')
    await removeRecentProject(toDelete.id)

    const names = (await listRecentProjects()).map((r) => r.name)
    expect(names).toEqual(['KeepMe.3dcp'])
  })

  it('removing an id that does not exist is a harmless no-op', async () => {
    await expect(removeRecentProject('never-existed')).resolves.not.toThrow()
  })

  it('openRecentProject rejects entries with no stored file handle', async () => {
    const mk = (name) => new File([JSON.stringify({ name })], name, { type: 'application/json' })
    await openProjectFromFileObject(mk('NoHandle.3dcp'))
    const recent = (await listRecentProjects()).find((r) => r.name === 'NoHandle.3dcp')

    await expect(openRecentProject(recent)).rejects.toThrow(/Open Project/)
  })
})