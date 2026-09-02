// ---------------------------------------------------------------------------
// Project store (IndexedDB)
//
// A "project" bundles everything needed to recreate a session: the character
// model, props and reference images (as their original FILE BLOBS, not just
// transforms), the pose/keyframe sequence, and the style settings. localStorage
// can't hold multi-megabyte model files, so we use IndexedDB — its structured
// clone happily stores Blob/File objects directly.
//
// One object store keyed by project name (saving the same name overwrites).
// ---------------------------------------------------------------------------

const DB_NAME = 'pose-studio'
const STORE = 'projects'
const VERSION = 1

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

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'name' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// Insert or overwrite a project record ({ name, savedAt, ...payload }).
export async function saveProject(record) {
  const db = await openDB()
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(record)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

// Fetch the full record (including blobs) for one project, or null.
export async function loadProjectRecord(name) {
  const db = await openDB()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(name)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

// Lightweight listing for the UI: name + savedAt only, newest first.
export async function listProjects() {
  const db = await openDB()
  try {
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).getAll()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    })
    return all
      .map((r) => ({ name: r.name, savedAt: r.savedAt || 0 }))
      .sort((a, b) => b.savedAt - a.savedAt)
  } finally {
    db.close()
  }
}

export async function deleteProject(name) {
  const db = await openDB()
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(name)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Export / import to a real file on disk.
//
// Format: JSON, with every Blob/File in the record replaced by a base64
// string (recursively, so it doesn't matter where in the record a blob
// lives — character model files, prop/image blobs, etc all get caught).
// ---------------------------------------------------------------------------

const FILE_EXT = '.3dcp' // "3D Character Poser" project — just JSON inside
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

// Save a project record (as produced by getProjectData(), plus name/savedAt)
// straight to a downloaded file, bypassing IndexedDB entirely.
export async function exportProjectToFile(record) {
  const portable = await replaceBlobsWithBase64(record)
  const json = JSON.stringify(portable)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const safeName = (record.name || 'project').replace(/[\\/:*?"<>|]/g, '_')
  const a = document.createElement('a')
  a.href = url
  a.download = `${safeName}${FILE_EXT}`
  a.click()
  URL.revokeObjectURL(url)
}

// Read a .3dcp file back into a project record ready for applyProjectData().
export async function importProjectFromFile(file) {
  const text = await file.text()
  let portable
  try {
    portable = JSON.parse(text)
  } catch {
    throw new Error('That file is not a valid project export.')
  }
  return restoreBlobsFromBase64(portable)
}