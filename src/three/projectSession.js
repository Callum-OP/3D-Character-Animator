import { useStore } from '../store.js'
import { getProjectData } from './scene.js'
import { saveProjectToHandle, saveProjectAs } from './projectStore.js'

// "Save" exactly as the File menu does it: write back to the file the project was opened from /
// last saved to, or ask where to put it the first time. Used by the close-the-app prompt.
// Throws (name 'AbortError') if the person cancels the save dialog.
export async function saveCurrentProject() {
  const store = useStore.getState()
  const current = store.currentProject
  const data = getProjectData()
  let result
  if (current && current.handle) {
    result = await saveProjectToHandle(current.handle, { name: current.name, ...data })
    store.setCurrentProject((c) => ({ ...c, name: result.name }))
  } else {
    result = await saveProjectAs({ name: (current && current.name) || 'Untitled', ...data }, current && current.name)
    store.setCurrentProject({ name: result.name, handle: result.handle })
  }
  store.setLastProjectSave({ name: result.name, savedAt: result.savedAt })
  return result
}
