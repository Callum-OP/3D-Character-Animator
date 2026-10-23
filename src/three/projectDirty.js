import { useStore } from '../store.js'
import { getHistorySequence, getHistoryEpoch } from './undoHistory.js'

// Has the project changed since it was last saved (or opened / started fresh)? Used to decide
// whether closing the app should ask about saving.
//
// Two signals, either one means "yes":
//  - the undo history moved: every edit made to the scene (and every undo / redo) is a step in it;
//  - something the project file stores changed in the store but isn't an undo step — keyframes,
//    the scene's lists, per-part overrides and the look / lighting / shadow settings.
// It errs on the side of asking: an unneeded prompt costs a click, a missed one costs work.

// What a saved project stores that the undo history doesn't always see (see collectSettings
// and getProjectData in scene.js).
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
let savedSequence = getHistorySequence()
let savedEpoch = getHistoryEpoch()
let settleTimer = null

// Watch the store from the moment this module loads.
useStore.subscribe((state, previous) => {
  if (dirty) return
  for (const key of WATCHED) {
    if (state[key] !== previous[key]) {
      dirty = true
      return
    }
  }
})

// Call when the project matches what is on disk: just saved, just opened, or a fresh start.
export function markProjectClean() {
  dirty = false
  savedSequence = getHistorySequence()
  savedEpoch = getHistoryEpoch()
}

// A load leaves the app settling for a moment (effects pushing the loaded settings into the
// scene touch the store); mark clean again once that has passed so it doesn't count as an edit.
export function markProjectCleanAfterLoad(settleMs = 600) {
  markProjectClean()
  clearTimeout(settleTimer)
  settleTimer = setTimeout(markProjectClean, settleMs)
}

export function isProjectDirty() {
  return dirty || getHistorySequence() !== savedSequence || getHistoryEpoch() !== savedEpoch
}
