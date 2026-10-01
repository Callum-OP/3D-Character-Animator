import { useStore } from '../store.js'
import {
  copyObjectById,
  pasteCopiedObject,
  hasCopiedObjectData,
  setMeshVisibleByUuid,
  setObjectVisibleById,
} from './scene.js'
import { applyPose, getPose, resetPose } from './posing.js'
import { getMeshDelta, setMeshDelta } from './meshedit.js'

let meshClipboard = null

export function copyCurrentEdit(state = useStore.getState()) {
  if (state.mode === 'bone' && state.modelInfo) {
    state.setPoseClipboard(getPose())
    return 'pose'
  }
  if (state.mode === 'object' && state.selectedObjectId != null) {
    return copyObjectById(state.selectedObjectId) ? 'object' : null
  }
  if (state.mode === 'mesh' && state.selectedMeshUuid) {
    meshClipboard = getMeshDelta(state.selectedMeshUuid)
    return meshClipboard ? 'mesh' : null
  }
  return null
}

export function pasteCurrentEdit(state = useStore.getState()) {
  if (state.mode === 'bone' && state.poseClipboard) {
    return { type: 'pose', result: applyPose(state.poseClipboard) }
  }
  if (state.mode === 'object') {
    const result = pasteCopiedObject()
    return result ? { type: 'object', result } : null
  }
  if (state.mode === 'mesh' && state.selectedMeshUuid && meshClipboard) {
    setMeshDelta(state.selectedMeshUuid, meshClipboard)
    return { type: 'mesh' }
  }
  return null
}

export function cutCurrentEdit(state = useStore.getState()) {
  if (state.mode !== 'bone' || !state.modelInfo) return null
  state.setPoseClipboard(getPose())
  resetPose()
  return 'pose'
}

export function toggleCurrentVisibility(state = useStore.getState()) {
  if (state.mode === 'mesh' && state.selectedMeshUuid) {
    const hidden = state.meshOverrides[state.selectedMeshUuid]?.visible === false
    setMeshVisibleByUuid(state.selectedMeshUuid, hidden)
    return { type: 'mesh', visible: hidden }
  }
  if (state.mode === 'object' && state.selectedObjectId != null) {
    const object = state.sceneObjects.find((entry) => entry.id === state.selectedObjectId)
    if (!object) return null
    const visible = object.visible === false
    setObjectVisibleById(object.id, visible)
    return { type: 'object', visible }
  }
  return null
}

export function canCopyCurrentEdit(state = useStore.getState()) {
  if (state.mode === 'bone') return !!state.modelInfo
  if (state.mode === 'object') {
    const selected = state.sceneObjects.find((entry) => entry.id === state.selectedObjectId)
    return !!selected && !selected.isCharacter
  }
  if (state.mode === 'mesh') return !!state.selectedMeshUuid
  return false
}

export function canPasteCurrentEdit(state = useStore.getState()) {
  if (state.mode === 'bone') return !!state.poseClipboard
  if (state.mode === 'object') return hasObjectClipboard()
  if (state.mode === 'mesh') return !!meshClipboard
  return false
}

function hasObjectClipboard() {
  return hasCopiedObjectData()
}