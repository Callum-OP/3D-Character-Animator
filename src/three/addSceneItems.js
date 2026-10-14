import { useStore } from '../store.js'
import { addLight, selectLight } from './lights.js'
import { addCamera } from './cameras.js'

// "Add light" / "Add camera" as one action: create it, register it with the store,
// select it (so its gizmo and panel show) and switch to Object mode — what the
// Lights / Cameras panels' Add buttons do, shared with the Edit menu.
export function addLightAndSelect() {
  const meta = addLight()
  const s = useStore.getState()
  s.addSceneLight(meta)
  s.setSelectedLightId(meta.id)
  selectLight(meta.id)
  s.setMode('object')
  return meta
}

export function addCameraAndSelect() {
  const meta = addCamera()
  const s = useStore.getState()
  s.addSceneCamera(meta)
  s.setSelectedCameraId(meta.id)
  s.setMode('object')
  return meta
}
