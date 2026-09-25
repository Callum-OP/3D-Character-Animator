// ---------------------------------------------------------------------------
// Project file I/O — Blender / Clip Studio Paint style.
//
// A project is a real file on disk (.3dcp — JSON with any Blob/File fields
// embedded as base64). There is no separate in-app "saved projects" list
// backed by IndexedDB anymore — that used to sit alongside a plain file
// export/import and confused people ("which one is my project actually
// in?"). Now there is exactly one concept:
//
//   Open      — pick a .3dcp file from disk and load it.
//   Save      — write back to the same file you opened/last saved to.
//   Save As…  — pick a new location on disk and remember it as "current".
//
// On top of that we keep a small "Recent Projects" list (à la Blender's
// splash screen / CSP's start menu) so the last several files you touched
// are one click away.
//
// Three environments, three ways of remembering "the file":
//   - Electron desktop build (window.animare present): native dialogs +
//     plain fs, "handle" is just the absolute file path. Paths don't expire,
//     so Recent Projects can always silently reopen them.
//   - Browsers with the File System Access API (Chrome, Edge, Opera):
//     "handle" is a real FileSystemFileHandle. NOTE this can still throw
//     "not allowed" on reopen if the page/app was reloaded — see
//     ensureReadPermission/ensureWritePermission below, which re-prompt.
//   - Everywhere else (Firefox, Safari): no handle at all, transparent
//     fallback to classic download-a-file / choose-a-file-to-upload; the
//     recent list just remembers file names for reference.
// ---------------------------------------------------------------------------

import { openDB, PROJECTS_STORE as STORE } from './localdb.js'

const FILE_EXT = '.3dcp' // "3D Character Poser" project — just JSON inside
const MIME = 'application/json'
const MAX_RECENTS = 10

function nativeBridge() {
  return typeof window !== 'undefined' && window.animare?.isElectron ? window.animare : null
}

export function hasFileSystemAccess() {
  if (nativeBridge()) return true
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function'
}

export async function requestPersistentStorage() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return false
    const already = (await navigator.storage.persisted?.()) || false
    if (already) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Recent Projects list
// Record shape: { id, name, savedAt, handle? } — handle is a
// FileSystemFileHandle when the browser supports it, otherwise omitted.
// ---------------------------------------------------------------------------

export async function listRecentProjects() {
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
    // De-dupe by handle identity where possible, otherwise by name.
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

    const latestSavedAt = all.reduce((latest, record) => Math.max(latest, record.savedAt || 0), 0)
    const savedAt = Math.max(Date.now(), latestSavedAt + 1)
    const id = existing?.id || `${savedAt}-${Math.random().toString(36).slice(2, 8)}`
    const record = { id, name, savedAt, handle: handle || existing?.handle }

    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(record)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })

    // Trim to MAX_RECENTS, oldest first out.
    const after = await listRecentProjects()
    if (after.length > MAX_RECENTS) {
      const toDrop = after.slice(MAX_RECENTS)
      for (const r of toDrop) await removeRecentProject(r.id)
    }
    return record
  } finally {
    db.close()
  }
}

async function isSameEntry(a, b) {
  try {
    if (isNativeHandle(a) || isNativeHandle(b)) return a === b
    return typeof a.isSameEntry === 'function' ? await a.isSameEntry(b) : a === b
  } catch {
    return false
  }
}

export async function removeRecentProject(id) {
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

// Re-open a recent entry. Throws if permission is denied or the file has
// moved/been deleted — callers should catch and offer to remove the entry.
export async function openRecentProject(recent) {
  if (!recent.handle) {
    throw new Error('This entry has no file handle in this browser — use "Open Project…" instead.')
  }
  const handle = recent.handle
  if (isNativeHandle(handle)) {
    // Native path — no permission dance, no stale-handle risk (see the
    // module note above). Read straight off disk.
    const text = await nativeBridge().readFile(handle)
    const record = await readProjectFile({ text: () => Promise.resolve(text) })
    const name = await nativeBridge().baseName(handle)
    await upsertRecent({ name, handle })
    return { record, handle, name }
  }
  await ensureReadPermission(handle)
  const file = await handle.getFile()
  const record = await readProjectFile(file)
  await upsertRecent({ name: file.name, handle })
  return { record, handle, name: file.name }
}

// Native (Electron) handles are plain path strings — there's no browser
// permission model to satisfy, the OS file dialog already granted access.
function isNativeHandle(handle) {
  return typeof handle === 'string'
}

async function ensureReadPermission(handle) {
  if (isNativeHandle(handle)) return
  const opts = { mode: 'read' }
  if ((await handle.queryPermission?.(opts)) === 'granted') return
  const result = await handle.requestPermission?.(opts)
  if (result !== 'granted') throw new Error('Permission to read this file was not granted.')
}

async function ensureWritePermission(handle) {
  if (isNativeHandle(handle)) return
  const opts = { mode: 'readwrite' }
  if ((await handle.queryPermission?.(opts)) === 'granted') return
  const result = await handle.requestPermission?.(opts)
  if (result !== 'granted') throw new Error('Permission to write to this file was not granted.')
}

// ---------------------------------------------------------------------------
// Blob <-> base64 embedding, so the whole record (including any model /
// prop / image files) survives a round-trip through plain JSON.
// ---------------------------------------------------------------------------

const BLOB_TAG = '__blob__'

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const CHUNK = 0x8000 // avoid call-stack blowups on large files
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToBlob(base64, type) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}

async function replaceBlobsWithBase64(value) {
  if (value instanceof Blob) {
    return { [BLOB_TAG]: true, type: value.type, name: value.name, data: await blobToBase64(value) }
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map(replaceBlobsWithBase64))
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = await replaceBlobsWithBase64(v)
    return out
  }
  return value
}

function restoreBlobsFromBase64(value) {
  if (value && typeof value === 'object' && value[BLOB_TAG]) {
    const blob = base64ToBlob(value.data, value.type)
    return value.name ? new File([blob], value.name, { type: value.type }) : blob
  }
  if (Array.isArray(value)) {
    return value.map(restoreBlobsFromBase64)
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = restoreBlobsFromBase64(v)
    return out
  }
  return value
}

function safeFileName(name) {
  let clean = (name || 'project').replace(/[\\/:*?"<>|]/g, '_')
  // Strip a trailing .3dcp (case-insensitive) so callers who pass a name
  // that already ends in FILE_EXT don't end up with "name.3dcp.3dcp".
  if (clean.toLowerCase().endsWith(FILE_EXT)) {
    clean = clean.slice(0, clean.length - FILE_EXT.length)
  }
  return clean
}

async function readProjectFile(file) {
  const text = await file.text()
  let portable
  try {
    portable = JSON.parse(text)
  } catch {
    throw new Error('That file is not a valid project (' + FILE_EXT + ').')
  }
  return restoreBlobsFromBase64(portable)
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

// Returns { record, handle, name } — handle is null on browsers without the
// File System Access API (Firefox/Safari), in which case "Save" later on
// will have to fall back to Save As (there's no disk handle to write back to).
export async function openProjectFromDisk() {
  const native = nativeBridge()
  if (native) {
    const filePath = await native.pickOpenFile({
      filters: [{ name: '3D Character Animator project', extensions: [FILE_EXT.slice(1)] }],
    })
    if (!filePath) {
      const err = new Error('Open cancelled.')
      err.name = 'AbortError'
      throw err
    }
    const text = await native.readFile(filePath)
    const record = await readProjectFile({ text: () => Promise.resolve(text) })
    const name = await native.baseName(filePath)
    await upsertRecent({ name, handle: filePath })
    return { record, handle: filePath, name }
  }

  if (hasFileSystemAccess()) {
    const [handle] = await window.showOpenFilePicker({
      id: 'character-animator-project',
      types: [{ description: '3D Character Animator project', accept: { [MIME]: [FILE_EXT] } }],
      excludeAcceptAllOption: false,
      multiple: false,
    })
    const file = await handle.getFile()
    const record = await readProjectFile(file)
    await upsertRecent({ name: file.name, handle })
    return { record, handle, name: file.name }
  }

  // Fallback: plain <input type="file">, driven by the caller (it owns the
  // hidden input element and calls openProjectFromFileObject with the file).
  throw new Error('FILE_SYSTEM_ACCESS_UNAVAILABLE')
}

// Fallback path for browsers without the picker API: caller supplies the
// File it got from a normal <input type="file">.
export async function openProjectFromFileObject(file) {
  const record = await readProjectFile(file)
  await upsertRecent({ name: file.name, handle: null })
  return { record, handle: null, name: file.name }
}

// ---------------------------------------------------------------------------
// Save / Save As
// ---------------------------------------------------------------------------

async function writeToHandle(handle, record) {
  const portable = await replaceBlobsWithBase64(record)
  const json = JSON.stringify(portable)
  if (isNativeHandle(handle)) {
    await nativeBridge().writeFile(handle, json)
    return
  }
  await ensureWritePermission(handle)
  const writable = await handle.createWritable()
  await writable.write(json)
  await writable.close()
}

// Save straight back to a known handle (no dialog) — this is "Save" once a
// project already has a file on disk, exactly like Ctrl+S in Blender/CSP.
export async function saveProjectToHandle(handle, record) {
  await writeToHandle(handle, record)
  if (isNativeHandle(handle)) {
    const name = await nativeBridge().baseName(handle)
    await upsertRecent({ name, handle })
    return { handle, name }
  }
  const file = await handle.getFile().catch(() => null)
  await upsertRecent({ name: file?.name || record.name || 'project', handle })
  return { handle, name: file?.name || record.name }
}

// "Save As…" — always shows a picker for a new (or different) location.
export async function saveProjectAs(record, suggestedName) {
  const native = nativeBridge()
  if (native) {
    const suggested = `${safeFileName(suggestedName || record.name)}${FILE_EXT}`
    const filePath = await native.pickSaveFile({
      suggestedName: suggested,
      filters: [{ name: '3D Character Animator project', extensions: [FILE_EXT.slice(1)] }],
    })
    if (!filePath) {
      const err = new Error('Save cancelled.')
      err.name = 'AbortError'
      throw err
    }
    await writeToHandle(filePath, record)
    const name = await native.baseName(filePath)
    await upsertRecent({ name, handle: filePath })
    return { handle: filePath, name }
  }

  if (hasFileSystemAccess()) {
    const handle = await window.showSaveFilePicker({
      id: 'character-animator-project',
      suggestedName: `${safeFileName(suggestedName || record.name)}${FILE_EXT}`,
      types: [{ description: '3D Character Animator project', accept: { [MIME]: [FILE_EXT] } }],
    })
    await writeToHandle(handle, record)
    await upsertRecent({ name: handle.name, handle })
    return { handle, name: handle.name }
  }

  // Fallback: classic forced download. There's no handle to remember, so
  // future "Save" presses in this session will need Save As again — the
  // browser gives us no way to write back to a chosen spot on disk.
  const portable = await replaceBlobsWithBase64(record)
  const json = JSON.stringify(portable)
  const blob = new Blob([json], { type: MIME })
  const url = URL.createObjectURL(blob)
  const name = `${safeFileName(suggestedName || record.name)}${FILE_EXT}`
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
  await upsertRecent({ name, handle: null })
  return { handle: null, name }
}