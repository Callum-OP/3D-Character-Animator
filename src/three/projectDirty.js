import { useStore } from '../store.js'
import { getHistorySequence, getHistoryEpoch } from './undoHistory.js'
import { askAboutUnsavedWork } from './unsavedPrompt.js'

const WATCHED = [
  'sceneObjects', 'sceneLights', 'sceneCameras', 'characterOrder',
  'animData', 'objectAnimData', 'objectAttachmentData', 'objectAnimDuration', 'meshOverrides',
  'materialMode', 'toonSteps', 'colorGrading', 'materialLook', 'ambientOcclusionStrength', 'backlightColor', 'backlightFalloff',
  'lightLinks', 'rimLightColor', 'rimSideOnly', 'rimSoftEnabled', 'rimSoftIntensity', 'rimSoftWidth',
  'rimHardEnabled', 'rimHardIntensity', 'rimHardWidth', 'rimFollowLight', 'rimFollowLightId',
  'lightIntensity', 'lightAzimuth', 'lightElevation', 'defaultLightingEnabled', 'envLightingEnabled', 'envLightingIntensity',
  'outlineEnabled', 'outlineWidth', 'outlineColor', 'outlineOpacity', 'softenEnabled', 'softenAmount',
  'showGrid', 'showGround', 'limbLimits', 'solidBackground', 'backgroundColor', 'shadows', 'night',
  'performanceMode', 'performanceBackgroundObjects', 'performanceLowPoly', 'performanceResolution', 'performanceEffects',
  'autoDecimate', 'animFps', 'animDuration', 'boneViewMode', 'stopAtFirstClipEnd',
]

let dirty = false
let revision = 0
let savedSequence = getHistorySequence()
let savedEpoch = getHistoryEpoch()
let settleTimer = null

// Optimized watcher using a Set for O(1) lookup if needed, 
// or selective subscriptions if performance becomes a bottleneck.
useStore.subscribe((state, previous) => {
  for (let i = 0; i < WATCHED.length; i++) {
    const key = WATCHED[i]
    if (state[key] !== previous[key]) {
      dirty = true
      revision++
      return
    }
  }
})

export function projectSaveRevision() {
  clearTimeout(settleTimer)
  return { revision, sequence: getHistorySequence(), epoch: getHistoryEpoch() }
}

export function markProjectCleanIfUnchanged(saved) {
  if (revision === saved.revision && getHistorySequence() === saved.sequence && getHistoryEpoch() === saved.epoch) {
    markProjectClean()
  }
}

export function markProjectSaveFailed() {
  clearTimeout(settleTimer)
  dirty = true
  revision++
}

export function markProjectClean() {
  dirty = false
  savedSequence = getHistorySequence()
  savedEpoch = getHistoryEpoch()
}

export function markProjectCleanAfterLoad(settleMs = 600) {
  markProjectClean()
  clearTimeout(settleTimer)
  settleTimer = setTimeout(markProjectClean, settleMs)
}

export function isProjectDirty() {
  return dirty || getHistorySequence() !== savedSequence || getHistoryEpoch() !== savedEpoch
}

export async function confirmDiscardUnsaved(verb = 'continue') {
  if (!isProjectDirty()) return true
  return askAboutUnsavedWork(verb)
}