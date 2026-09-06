// ---------------------------------------------------------------------------
// One shared IndexedDB database for every "recently used file" list the app
// keeps (projects, clips, …). Kept in one module so there's a single place
// that owns the DB version and upgrade logic — two modules independently
// calling indexedDB.open(DB_NAME, ownVersion) is a recipe for one of them
// silently losing its object store, since only the highest version number
// requested actually runs an upgrade.
// ---------------------------------------------------------------------------

export const DB_NAME = 'pose-studio'
export const VERSION = 3

export const PROJECTS_STORE = 'recentProjects'
export const CLIPS_STORE = 'recentClips'

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // Older "save into the browser" slots — both replaced by real files on
      // disk plus a recent-files list.
      if (db.objectStoreNames.contains('projects')) db.deleteObjectStore('projects')
      if (db.objectStoreNames.contains('clipLibrary')) db.deleteObjectStore('clipLibrary')

      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(CLIPS_STORE)) {
        db.createObjectStore(CLIPS_STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}