import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { listRecentProjects, removeRecentProject, openProjectFromPath } from '../three/projectStore.js'

// Desktop build: the OS launches the app with a .3dcp path (double-click /
// "Open with"); openProjectFromPath loads it through the native bridge.
describe('openProjectFromPath (desktop file association)', () => {
  beforeEach(async () => {
    for (const r of await listRecentProjects()) await removeRecentProject(r.id)
  })
  afterEach(() => {
    delete window.animare
  })

  it('reads the file via the native bridge and records it in Recent Projects', async () => {
    const filePath = 'C:\\Projects\\Scene.3dcp'
    window.animare = {
      isElectron: true,
      readFile: async (p) => {
        expect(p).toBe(filePath)
        return JSON.stringify({ name: 'Scene', foo: 'bar' })
      },
      baseName: async (p) => p.split('\\').pop(),
    }
    const { record, handle, name } = await openProjectFromPath(filePath)
    expect(record.foo).toBe('bar')
    expect(handle).toBe(filePath)
    expect(name).toBe('Scene.3dcp')
    const recents = await listRecentProjects()
    expect(recents.find((r) => r.name === 'Scene.3dcp')?.handle).toBe(filePath)
  })

  it('refuses outside the desktop app', async () => {
    await expect(openProjectFromPath('x.3dcp')).rejects.toThrow(/desktop app/)
  })
})
