// ---------------------------------------------------------------------------
// The user's own Pose Library entries (poses, hand poses and clips they saved).
//
// Kept in IndexedDB in a database of its own, so it can never clash with the project / recent-clip store in
// localdb.js. If IndexedDB isn't available (private mode, a locked-down embed) entries live in memory for the
// session instead and `isPersistent()` says so, so the panel can warn that they will be lost - and Export library
// is there to keep them safe (itch.io can clear browser storage).
//
// An entry:
//   { id, kind: 'body' | 'hand' | 'animation', name, createdAt, thumb: { segs }, data }
//     body:      data = { bones: { boneName: [x, y, z, w] } }                      (a pose-v1 pose)
//     hand:      data = { poses: { L?: hand-v1 pose, R?: hand-v1 pose } }          (see handPose.js)
//     animation: data = { clip: <wrapped clip JSON from animation.js>, duration }
// ---------------------------------------------------------------------------

const DB_NAME = 'animare-pose-library'
const DB_VERSION = 2
const STORE = 'entries'
const THUMB_STORE = 'rendered-thumbs'
const THUMB_CACHE_VERSION = 'base-rigged-v3'
export const LIBRARY_FILE_FORMAT = 'animare-pose-library-v1'

const memory = new Map()
const memoryThumbs = new Map()
let persistent = true

export function isPersistent() {
  return persistent
}

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' })
      if (!req.result.objectStoreNames.contains(THUMB_STORE)) req.result.createObjectStore(THUMB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// Run `fn(store)` in a transaction and resolve with the request's result.
async function withStore(mode, fn, storeName = STORE) {
  const db = await open()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode)
      const req = fn(tx.objectStore(storeName))
      tx.oncomplete = () => resolve(req ? req.result : undefined)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

async function attempt(fn, fallback) {
  if (!persistent) return fallback()
  try {
    return await fn()
  } catch {
    persistent = false // from here on, keep entries in memory
    return fallback()
  }
}

export function newEntryId() {
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Every saved entry, newest first. Optionally only one kind.
export async function listEntries(kind) {
  const all = await attempt(
    () => withStore('readonly', (s) => s.getAll()),
    () => [...memory.values()],
  )
  return (all || []).filter((e) => !kind || e.kind === kind).sort((a, b) => b.createdAt - a.createdAt)
}

// Save (or overwrite) an entry; fills in id and createdAt when missing. Resolves with the stored entry.
export async function putEntry(entry) {
  const stored = { ...entry, id: entry.id || newEntryId(), createdAt: entry.createdAt || Date.now() }
  await attempt(
    () => withStore('readwrite', (s) => s.put(stored)),
    () => memory.set(stored.id, stored),
  )
  if (!persistent) memory.set(stored.id, stored)
  return stored
}

export async function deleteEntry(id) {
  memory.delete(id)
  await attempt(
    () => withStore('readwrite', (s) => s.delete(id)),
    () => undefined,
  )
  memoryThumbs.delete(id)
  try {
    await withStore('readwrite', (s) => s.delete(`${THUMB_CACHE_VERSION}:${id}`), THUMB_STORE)
  } catch {
    // The screenshot cache is disposable; library entry deletion still succeeds without it.
  }
}

export async function renameEntry(id, name) {
  const all = await listEntries()
  const entry = all.find((e) => e.id === id)
  if (!entry) return null
  return putEntry({ ...entry, name })
}

// ---- Library files (back up / move to another browser) ----------------------

export async function exportLibraryJSON() {
  return { format: LIBRARY_FILE_FORMAT, exportedAt: Date.now(), entries: await listEntries() }
}

// Add the entries of an exported library. Entries that are already here (same id) are left alone; returns how many were added.
export async function importLibraryJSON(json) {
  if (!json || json.format !== LIBRARY_FILE_FORMAT || !Array.isArray(json.entries)) {
    throw new Error('This is not a Pose Library file.')
  }
  const have = new Set((await listEntries()).map((e) => e.id))
  let added = 0
  for (const entry of json.entries) {
    if (!entry || !entry.id || !entry.kind || !entry.data || have.has(entry.id)) continue
    await putEntry(entry)
    added++
  }
  return added
}

export async function getRenderedThumb(id) {
  if (!id) return null
  try {
    const stored = await withStore('readonly', (s) => s.get(`${THUMB_CACHE_VERSION}:${id}`), THUMB_STORE)
    if (stored?.data && stored.type) return new Blob([stored.data], { type: stored.type })
    return stored || memoryThumbs.get(id) || null
  } catch {
    return memoryThumbs.get(id) || null
  }
}

function blobBuffer(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('Could not read rendered thumbnail'))
    reader.readAsArrayBuffer(blob)
  })
}

export async function putRenderedThumb(id, blob) {
  if (!id || !blob) return
  memoryThumbs.set(id, blob)
  try {
    const stored = { type: blob.type || 'image/webp', data: await blobBuffer(blob) }
    await withStore('readwrite', (s) => s.put(stored, `${THUMB_CACHE_VERSION}:${id}`), THUMB_STORE)
  } catch {
    // Keep the session copy as a fallback when storage is full or unavailable.
  }
}

// Test hook: forget everything held in memory and try IndexedDB again.
export function resetLibraryStoreForTest() {
  memory.clear()
  memoryThumbs.clear()
  persistent = true
}
