import { useStore } from '../store.js'
import { getCameraClipboardData, pasteCamera } from './cameras.js'
import { getLightClipboardData, pasteLight } from './lights.js'

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
  if (clipboard.type === 'camera') {
    store.addSceneCamera(meta)
    store.setMode('object')
  } else {
    store.addSceneLight(meta)
    store.setMode('object')
  }
  return { type: clipboard.type, result: meta }
}
