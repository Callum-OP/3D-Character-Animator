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
