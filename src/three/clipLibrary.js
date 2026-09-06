// ---------------------------------------------------------------------------
// Clip file I/O — same idea as projectStore.js, applied to a single clip.
//
// This used to be three separate, overlapping ideas: a "save to my library"
// button that squirrelled the clip away in localStorage, a completely
// separate "export clip" button that downloaded a .clip.json file, and a
// third "import clip file" button to read one back. Three buttons for what
// is really one action — put this clip somewhere I can get it back — and no
// obvious way to know which of "library" or "file" a given saved clip
// actually lived in.
//
// Now there's one concept, matching the project file flow next to it:
//
//   Open Clip…     — pick a clip file from disk and bring it into the app.
//   Save Clip As…  — write the current clip out to a file on disk.
//
// A small Recent Clips list (backed by IndexedDB, storing real
// FileSystemFileHandles where the browser supports them) keeps the last
// several clips one click away, exactly like Recent Projects.
// ---------------------------------------------------------------------------

import { openDB, CLIPS_STORE as STORE } from './localdb.js'

const FILE_EXT = '.3dclip' // just THREE.AnimationClip.toJSON() inside
const MIME = 'application/json'
const MAX_RECENTS = 10

export function hasFileSystemAccess() {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function'
}

// ---------------------------------------------------------------------------
// Recent Clips list — { id, name, savedAt, handle? }
// ---------------------------------------------------------------------------

export async function listRecentClips() {
  const db = await openDB()
  try {
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).getAll()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    })
    return all.sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_RECENTS)
  } finally {
    db.close()
  }
}

async function upsertRecent({ name, handle }) {
  const db = await openDB()
  try {
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).getAll()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    })
    let existing = null
    for (const r of all) {
      if (handle && r.handle && (await isSameEntry(r.handle, handle))) {
        existing = r
        break
      }
    }
    if (!existing && !handle) existing = all.find((r) => r.name === name && !r.handle)

    const id = existing?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const record = { id, name, savedAt: Date.now(), handle: handle || existing?.handle }

    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(record)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })

    const after = await listRecentClips()
    if (after.length > MAX_RECENTS) {
      const toDrop = after.slice(MAX_RECENTS)
      for (const r of toDrop) await removeRecentClip(r.id)
    }
    return record
  } finally {
    db.close()
  }
}

async function isSameEntry(a, b) {
  try {
    return typeof a.isSameEntry === 'function' ? await a.isSameEntry(b) : a === b
  } catch {
    return false
  }
}

export async function removeRecentClip(id) {
  const db = await openDB()
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(id)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

async function ensureReadPermission(handle) {
  const opts = { mode: 'read' }
  if ((await handle.queryPermission?.(opts)) === 'granted') return
  const result = await handle.requestPermission?.(opts)
  if (result !== 'granted') throw new Error('Permission to read this file was not granted.')
}

async function ensureWritePermission(handle) {
  const opts = { mode: 'readwrite' }
  if ((await handle.queryPermission?.(opts)) === 'granted') return
  const result = await handle.requestPermission?.(opts)
  if (result !== 'granted') throw new Error('Permission to write to this file was not granted.')
}

function safeFileName(name) {
  return (name || 'clip').replace(/[\\/:*?"<>|]/g, '_')
}

async function readClipFile(file) {
  const text = await file.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('That file is not a valid clip (' + FILE_EXT + ').')
  }
}

// Re-open a recent entry. Throws if permission is denied or the file has
// moved/been deleted — callers should catch and offer to remove the entry.
export async function openRecentClip(recent) {
  if (!recent.handle) {
    throw new Error('This entry has no file handle in this browser — use "Open Clip…" instead.')
  }
  const handle = recent.handle
  await ensureReadPermission(handle)
  const file = await handle.getFile()
  const json = await readClipFile(file)
  await upsertRecent({ name: file.name, handle })
  return { json, handle, name: file.name }
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export async function openClipFromDisk() {
  if (hasFileSystemAccess()) {
    const [handle] = await window.showOpenFilePicker({
      id: 'character-animator-clip',
      types: [{ description: 'Animation clip', accept: { [MIME]: [FILE_EXT, '.json'] } }],
      excludeAcceptAllOption: false,
      multiple: false,
    })
    const file = await handle.getFile()
    const json = await readClipFile(file)
    await upsertRecent({ name: file.name, handle })
    return { json, handle, name: file.name }
  }
  throw new Error('FILE_SYSTEM_ACCESS_UNAVAILABLE')
}

// Fallback path for browsers without the picker API: caller supplies the
// File it got from a normal <input type="file">.
export async function openClipFromFileObject(file) {
  const json = await readClipFile(file)
  await upsertRecent({ name: file.name, handle: null })
  return { json, handle: null, name: file.name }
}

// ---------------------------------------------------------------------------
// Save As — a clip is short-lived enough (you make it, tweak it, move on)
// that there's no real "Save back to the same file" step worth having; every
// save is "put a copy of this clip somewhere", so it's Save As only.
// ---------------------------------------------------------------------------

export async function saveClipAs(json, suggestedName) {
  const name = safeFileName(suggestedName || json?.name || 'clip')
  if (hasFileSystemAccess()) {
    const handle = await window.showSaveFilePicker({
      id: 'character-animator-clip',
      suggestedName: `${name}${FILE_EXT}`,
      types: [{ description: 'Animation clip', accept: { [MIME]: [FILE_EXT] } }],
    })
    await ensureWritePermission(handle)
    const writable = await handle.createWritable()
    await writable.write(JSON.stringify(json))
    await writable.close()
    await upsertRecent({ name: handle.name, handle })
    return { handle, name: handle.name }
  }

  // Fallback: forced download, no handle to remember.
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: MIME })
  const url = URL.createObjectURL(blob)
  const fileName = `${name}${FILE_EXT}`
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
  await upsertRecent({ name: fileName, handle: null })
  return { handle: null, name: fileName }
}