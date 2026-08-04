// A small persistent library of saved animation clips, kept in localStorage
// so clips survive a page reload or swapping models — unlike the in-memory
// clip registry in animation.js, which is lost the moment the model changes.
//
// Entries are keyed by clip name and store the THREE.AnimationClip.toJSON()
// payload from exportClipJSON(). Clips can be a few hundred KB each; this is
// fine for a handful of saved clips but isn't meant to scale to a huge
// library — if that becomes a problem, swap the storage backend for
// IndexedDB without changing this module's exported API.

const KEY = 'clipLibrary:v1'

function readAll() {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(entries) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries))
    return true
  } catch (err) {
    // Most likely quota exceeded (localStorage is ~5-10MB).
    console.warn('Could not save clip library:', err)
    return false
  }
}

// List saved clips, newest first: [{ name, savedAt }]
export function listSavedClips() {
  return readAll()
    .map(({ name, savedAt }) => ({ name, savedAt }))
    .sort((a, b) => b.savedAt - a.savedAt)
}

// Save (or overwrite) a clip's JSON under `name`. Returns true on success.
export function saveClipToLibrary(name, json) {
  const entries = readAll().filter((e) => e.name !== name)
  entries.push({ name, savedAt: Date.now(), json })
  return writeAll(entries)
}

// Fetch one saved clip's JSON payload, or null if not present.
export function loadClipFromLibrary(name) {
  const entry = readAll().find((e) => e.name === name)
  return entry ? entry.json : null
}

export function deleteSavedClip(name) {
  writeAll(readAll().filter((e) => e.name !== name))
}