import { useStore } from '../store.js'
import { getCameraClipboardData, pasteCamera, attachCameraToRoot } from './cameras.js'
import { getLightClipboardData, pasteLight, attachLightToRoot } from './lights.js'
import { getObjectRootById } from './objects.js'

let clipboard = null

export function copySceneItem(type, id) {
  const data = type === 'camera'
    ? getCameraClipboardData(id)
    : type === 'light'
      ? getLightClipboardData(id)
      : null
  if (!data) return null
  clipboard = { type, data }
  useStore.getState().setSceneClipboardType(type)
  return type
}

export function hasSceneClipboard(type) {
  const activeType = useStore.getState().sceneClipboardType
  return !!clipboard && activeType === clipboard.type && (!type || activeType === type)
}

export function pasteSceneItem(type) {
  if (!clipboard || (type && clipboard.type !== type)) return null
  const meta = clipboard.type === 'camera'
    ? pasteCamera(clipboard.data)
    : pasteLight(clipboard.data)
  if (!meta) return null
  const store = useStore.getState()
  // A copy is placed exactly where the original is (in the world, however the original was
  // attached) and, if the original rides on an object that is still there, rides on it too.
  const hostId = clipboard.data.attachedObjectId
  const host = hostId != null ? getObjectRootById(hostId) : null
  if (clipboard.type === 'camera') {
    store.addSceneCamera(meta)
    store.setMode('object')
    if (host) attachCameraToRoot(meta.id, host, hostId)
  } else {
    store.addSceneLight(meta)
    store.setMode('object')
    if (host) attachLightToRoot(meta.id, host, hostId)
  }
  return { type: clipboard.type, result: meta }
}
