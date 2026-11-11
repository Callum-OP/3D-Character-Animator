import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveProjectToHandle, describeUnreadableProject, hasPendingSaves, waitForPendingSaves } from '../three/projectStore.js'
import { indexedDB } from 'fake-indexeddb'
import { isProjectDirty, markProjectClean } from '../three/projectDirty.js'
import { useStore } from '../store.js'

function fakeHandle({ keep = 1, onWrite } = {}) {
  let content = ''
  let active = 0
  const handle = {
    maxActive: 0,
    queryPermission: async () => 'granted',
    createWritable: async () => ({
      write: async (text) => {
        active++
        handle.maxActive = Math.max(handle.maxActive, active)
        await new Promise((r) => setTimeout(r, 5))
        content = text.slice(0, Math.floor(text.length * keep))
        onWrite?.(text)
      },
      close: async () => {
        active--
      },
    }),
    getFile: async () => ({ name: 'p.3dcp', size: new Blob([content]).size }),
  }
  return handle
}

afterEach(() => {
  delete globalThis.indexedDB
})

describe('saving guards', () => {
  it('refuses to call a short write "saved"', async () => {
    const handle = fakeHandle({ keep: 0.5 })
    await expect(saveProjectToHandle(handle, { name: 'p', format: 'project-v2', filler: 'x'.repeat(2000) })).rejects.toThrow(/not saved completely/)
  })

  it('runs saves to the same file one after another, never two at once', async () => {
    const handle = fakeHandle()
    const record = { name: 'p', format: 'project-v2' }
    const results = await Promise.allSettled([saveProjectToHandle(handle, record), saveProjectToHandle(handle, record), saveProjectToHandle(handle, record)])
    expect(handle.maxActive).toBe(1)
    expect(results.every((r) => r.status === 'fulfilled' || /indexedDB|IDB|open/i.test(String(r.reason)))).toBe(true)
    await waitForPendingSaves()
    expect(hasPendingSaves()).toBe(false)
  })

  it('tracks a save while it is being written', async () => {
    const handle = fakeHandle()
    const saving = saveProjectToHandle(handle, { name: 'p', format: 'project-v2' }).catch(() => {})
    expect(hasPendingSaves()).toBe(true)
    await saving
    await waitForPendingSaves()
    expect(hasPendingSaves()).toBe(false)
  })

  it('keeps edits made during a successful save dirty', async () => {
    globalThis.indexedDB = indexedDB
    markProjectClean()
    const handle = fakeHandle({ onWrite: () => useStore.setState({ sceneLights: [{ id: 912 }] }) })
    await saveProjectToHandle(handle, { name: 'p', format: 'project-v2' })
    expect(isProjectDirty()).toBe(true)
  })

  it('marks a failed save dirty even if the project was clean', async () => {
    markProjectClean()
    const handle = fakeHandle({ keep: 0.5 })
    await expect(saveProjectToHandle(handle, { name: 'p', filler: 'x'.repeat(100) })).rejects.toThrow()
    expect(isProjectDirty()).toBe(true)
  })

  it('names a cut-off project file instead of calling it invalid', () => {
    const cut = '{"name":"x","objects":[{"blob":{"data":"AAAA'
    expect(describeUnreadableProject(cut)).toMatch(/incomplete.*save was cut off/)
    expect(describeUnreadableProject('not a project at all')).toMatch(/not a valid project/)
    expect(describeUnreadableProject('')).toMatch(/not a valid project/)
  })
})
