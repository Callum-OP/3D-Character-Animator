import { useStore } from '../store.js'
import {
  setViewCameraById,
  transitionViewCameraTo,
  playAllCharacters,
  stopAllCharacters,
  startRecording,
  stopRecordingAndDownload,
  canRecordVideo,
  startGlobalClock,
} from './scene.js'
import { setForceCameraCuts } from './animation.js'
import { startObjectAnimation, stopObjectAnimation } from './objects.js'
import { selectLight } from './lights.js'

export { canRecordVideo }

// What a video (or preview) will be filmed through. Priority: camera cuts drive
// the view themselves; then whatever camera is being looked through; then a
// keyframed camera; then the only placed camera; else the current free view.
// Recording something other than the camera the user carefully placed is the
// #1 surprise — so cameras win whenever the choice is unambiguous.
export function resolveShotView(s) {
  if (s.playbackSource === 'edit' && (s.animData.cuts || []).length) {
    return { kind: 'cuts', label: 'your camera cuts' }
  }
  if (s.viewCameraId != null) {
    const cam = s.sceneCameras.find((c) => c.id === s.viewCameraId)
    return { kind: 'view', id: s.viewCameraId, label: `through ${cam?.name || 'the camera'}` }
  }
  if (s.playbackSource === 'edit') {
    const keyedName = Object.keys(s.animData.cameras || {}).find(
      (n) => (s.animData.cameras[n] || []).length && s.sceneCameras.some((c) => c.name === n),
    )
    if (keyedName) {
      const cam = s.sceneCameras.find((c) => c.name === keyedName)
      return { kind: 'auto', id: cam.id, label: `through ${cam.name} (it has keyframes)` }
    }
  }
  if (s.sceneCameras.length === 1) {
    return { kind: 'auto', id: s.sceneCameras[0].id, label: `through ${s.sceneCameras[0].name}` }
  }
  return { kind: 'free', label: 'the current view' }
}

// Move/rotate/resize gizmos (props, cameras, lights, bones, mesh parts) are
// editing UI, not part of the shot — hide whatever's selected before a
// preview/recording starts, and bring it back after so the selection isn't
// lost.
export function hideGizmosForShot() {
  const s = useStore.getState()
  const prev = {
    objectId: s.selectedObjectId,
    cameraId: s.selectedCameraId,
    lightId: s.selectedLightId,
    boneName: s.selectedBoneName,
    meshUuid: s.selectedMeshUuid,
  }
  if (prev.objectId != null) s.setSelectedObjectId(null)
  if (prev.cameraId != null) s.setSelectedCameraId(null)
  if (prev.boneName != null) s.setSelectedBoneName(null)
  if (prev.meshUuid != null) s.setSelectedMeshUuid(null)
  if (prev.lightId != null) {
    s.setSelectedLightId(null)
    selectLight(null)
  }
  return () => {
    const s2 = useStore.getState()
    if (prev.objectId != null) s2.setSelectedObjectId(prev.objectId)
    if (prev.cameraId != null) s2.setSelectedCameraId(prev.cameraId)
    if (prev.boneName != null) s2.setSelectedBoneName(prev.boneName)
    if (prev.meshUuid != null) s2.setSelectedMeshUuid(prev.meshUuid)
    if (prev.lightId != null) {
      s2.setSelectedLightId(prev.lightId)
      selectLight(prev.lightId)
    }
  }
}

function armShotView(view) {
  const prevId = useStore.getState().viewCameraId
  if (view.id != null && view.id !== prevId) {
    useStore.getState().setViewCameraId(view.id)
    setViewCameraById(view.id)
    return () => transitionViewCameraTo(prevId)
  }
  // 'cuts' and 'free' shots don't need arming — cuts glide themselves in via
  // sampleCuts once playback starts (forced on below), and 'free' never
  // leaves the current view in the first place. Still restore afterwards in
  // case cuts left the view somewhere else.
  return () => transitionViewCameraTo(prevId)
}

// Play everything animated in the scene once from the start — every loaded
// character's own selected clip/animation AND any keyed object motion —
// recording it to a .webm, or just previewing exactly what a recording would
// show. One shared code path (used by the Export panel's
// Preview/Record buttons AND the title bar's Export As > Video item) so a
// preview can never end up showing something different from what gets saved.
// onStatus(message) reports progress/errors/completion as it happens.
export function runExportShot({ record, name, onStatus }) {
  const say = onStatus || (() => {})
  const s0 = useStore.getState()
  if (s0.recording || s0.previewing) return
  stopAllCharacters() // clear any armed playback first (also restores cut-driven views)
  stopObjectAnimation() // …and put props back at rest, so object motion starts from a clean pose
  // A shot is filmed in View mode: no gizmos, no bone dots, no picking, and the
  // viewport's own toolbars step aside. The user's mode comes back afterwards.
  const prevMode = s0.mode
  if (prevMode !== 'view') useStore.getState().setMode('view')
  const restoreMode = () => {
    if (prevMode !== 'view' && useStore.getState().mode === 'view') useStore.getState().setMode(prevMode)
  }
  const restoreGizmos = hideGizmosForShot()
  const s = useStore.getState()
  const view = resolveShotView(s)
  const restoreView = armShotView(view)
  setForceCameraCuts(true)
  // Object motion reads the global Loop flag; a shot plays everything once.
  const prevLoop = s.loop
  if (prevLoop) useStore.setState({ loop: false })
  const finishShot = () => {
    stopAllCharacters()
    stopObjectAnimation()
    if (prevLoop) useStore.setState({ loop: prevLoop })
  }
  const { started: charStarted, maxDuration: charDur } = playAllCharacters({ loop: false, speed: s.speed })
  const objDur = startObjectAnimation() // 0 when no object has keyframes
  const started = charStarted + (objDur > 0 ? 1 : 0)
  const durSec = Math.max(charDur || 0, objDur)
  if (started === 0) {
    setForceCameraCuts(false)
    restoreView()
    restoreMode()
    restoreGizmos()
    if (prevLoop) useStore.setState({ loop: prevLoop })
    say(`Nothing to ${record ? 'record' : 'preview'} — pick a clip or make an animation first.`)
    return
  }
  if (record && !startRecording(30)) {
    setForceCameraCuts(false)
    restoreView()
    restoreMode()
    restoreGizmos()
    finishShot()
    say('Video recording isn’t supported in this browser — use Fullscreen and screen-record instead.')
    return
  }
  if (record) useStore.getState().setRecording(true)
  else useStore.getState().setPreviewing(true)
  startGlobalClock(true) // the All animation timeline follows the shot
  const what = [
    charStarted > 0 ? (charStarted > 1 ? `${charStarted} characters` : '1 character') : null,
    objDur > 0 ? 'object motion' : null,
  ]
    .filter(Boolean)
    .join(' + ')
  say(`${record ? 'Recording' : 'Previewing'} ${view.label}${started > 1 ? ` (${what})` : ''}…`)
  const ms = (durSec / (s.speed || 1)) * 1000 + (record ? 400 : 100)
  window.setTimeout(() => {
    finishShot()
    setForceCameraCuts(false)
    if (record) {
      stopRecordingAndDownload(name)
      useStore.getState().setRecording(false)
      say('Video saved (.webm).')
    } else {
      useStore.getState().setPreviewing(false)
      say(null)
    }
    restoreView()
    restoreMode()
    restoreGizmos()
  }, ms)
}