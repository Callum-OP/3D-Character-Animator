import { confirmDialog } from '../dialogs.js'
import { useStore } from '../store.js'
import { importProjectData } from './scene.js'
import { hasFileSystemAccess, openProjectFromDisk, openProjectFromFileObject } from './projectStore.js'
import { pickFileWithInput } from './fsAccess.js'

// "Import Project…": choose a saved project file and add its contents to the CURRENT project (see
// importProjectData in scene.js for exactly what comes across and what stays as it is). The file is not
// opened as the current project and does not go into Recent Projects.
// Returns null if the person cancelled, else { name, message, ...counts }.
export async function importProjectFromFile() {
  let opened = null
  try {
    if (hasFileSystemAccess()) {
      try {
        opened = await openProjectFromDisk({ remember: false })
      } catch (e) {
        // picker refused by the browser (e.g. embedded on itch.io): use a plain file chooser instead
        if (e?.message !== 'FILE_SYSTEM_ACCESS_UNAVAILABLE') throw e
      }
    }
    if (!opened) {
      const file = await pickFileWithInput('.3dcp,application/json')
      if (!file) return null
      opened = await openProjectFromFileObject(file, { remember: false })
    }
  } catch (e) {
    if (e?.name === 'AbortError') return null
    throw e
  }
  const { name, record } = opened
  if (!confirmDialog(`Add everything in “${name}” to this project?\n\nIts characters, objects and animations come in as they were saved. Your lighting, shadows, material look and camera view stay as they are.\n\nThis can't be undone, and it clears the undo history.`)) return null

  useStore.getState().setLoading(true)
  let result
  try {
    result = await importProjectData(record)
  } finally {
    useStore.getState().setLoading(false)
  }
  return { name, ...result, message: describeImport(name, result) }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function describeImport(name, { characters = 0, objects = 0, lights = 0 }) {
  const parts = []
  if (characters) parts.push(plural(characters, 'character'))
  if (objects) parts.push(plural(objects, 'object'))
  if (lights) parts.push(plural(lights, 'attached light'))
  return parts.length ? `Imported ${parts.join(', ')} from “${name}”.` : `“${name}” had no characters or objects to import.`
}
