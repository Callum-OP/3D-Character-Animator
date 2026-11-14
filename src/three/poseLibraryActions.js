import * as THREE from 'three'
import { useStore } from '../store.js'
import {
  applyPose,
  getPose,
  getPoseBones,
  getBoneRestQuaternion,
  setBonesLive,
  beginBonesAdjust,
  endBonesAdjust,
} from './posing.js'
import { POSE_FORMAT } from './poses.js'
import { poseFromBVHText, stop as stopAnimation, exportClipJSON, importClipJSON, selectClip } from './animation.js'
import { importBVHAuto } from './scene.js'
import {
  analyseHands,
  analyticHandPose,
  captureHandPose,
  handPoseToBoneQuats,
  handPosesFromBVH,
  poseForRig,
  rigsForSide,
  isHandBone,
  migrateHandPose,
  BASIC_HANDS,
} from './handPose.js'
import { fingerInfo } from './fingers.js'
import { bodyThumb, handThumbFromBones, thumbFromParsedBVH } from './poseThumb.js'
import { loadPresetPoseText, loadPresetText } from './poseLibraryPresets.js'
import { bvhInfo } from './bvhText.js'
import { putEntry } from './poseLibraryStore.js'

// ---------------------------------------------------------------------------
// What the Pose Library does to the character: apply a saved or preset pose / hand pose / clip, and save what is on
// the character now. Kept apart from the panel so it can be tested without any React.
// ---------------------------------------------------------------------------

// ---- Hands on the active character ----------------------------------------------------------------------

let handCache = null // { first, count, rigs }

// The active character's hands (measured against its rest pose, cached until the character changes).
export function getHandRigs() {
  const bones = getPoseBones()
  if (!bones.length) return []
  if (handCache && handCache.first === bones[0] && handCache.count === bones.length) return handCache.rigs
  const rigs = analyseHands(bones, getBoneRestQuaternion)
  handCache = { first: bones[0], count: bones.length, rigs }
  return rigs
}

export function clearHandCache() {
  handCache = null
}

function requireHands(side) {
  const rigs = getHandRigs()
  if (!rigs.length) throw new Error('This character has no finger bones the library can recognise.')
  const targets = rigsForSide(rigs, side)
  if (!targets.length) {
    throw new Error(side === 'L' ? 'This character has no left hand with fingers.' : 'This character has no right hand with fingers.')
  }
  return targets
}

// Playback owns the bones while it runs, so a pose put on top of it would be overwritten next frame.
function stopPlaybackForPosing() {
  const s = useStore.getState()
  if (s.playback !== 'stopped') {
    stopAnimation()
    s.setPlayback('stopped')
    s.setCurrentTime(0)
  }
}

const sideLabel = (side) => (side === 'L' ? 'left hand' : side === 'R' ? 'right hand' : 'both hands')

// ---- Applying ------------------------------------------------------------------------------------------

// The names of every finger bone (including helper tips) on the active character.
function fingerBoneNames() {
  const names = new Set()
  for (const b of getPoseBones()) if (fingerInfo(b, isHandBone)) names.add(b.name)
  return names
}

// Put a body pose on the character. `keepHands` leaves the fingers as they are.
// Resolves with { applied, skipped, label }.
export async function applyBodyEntry(entry, { keepHands = true } = {}) {
  let bones
  if (entry.source === 'preset') {
    const text = await loadPresetPoseText(entry)
    bones = await poseFromBVHText(text, entry.name)
    if (!Object.keys(bones).length) throw new Error(`"${entry.name}" didn't match any of this character's bones.`)
  } else {
    bones = { ...entry.data.bones }
  }
  if (keepHands) {
    for (const name of fingerBoneNames()) delete bones[name]
  }
  stopPlaybackForPosing()
  const { applied, missing } = applyPose({ format: POSE_FORMAT, bones })
  return { applied, skipped: missing.length, label: entry.name }
}

// Put a hand pose on the left hand, the right hand or both. `side`: 'L' | 'R' | 'both'. `amount`: 1 = the pose as saved.
// `entry` can be a saved entry, a preset or one of the BASIC_HANDS. Resolves with { applied, label }.
export async function applyHandEntry(entry, { side = 'both', amount = 1 } = {}) {
  const targets = requireHands(side)
  const quats = {}
  if (entry.source === 'basic') {
    for (const rig of targets) Object.assign(quats, handPoseToBoneQuats(rig, analyticHandPose(rig, entry), amount))
  } else {
    let poses
    if (entry.source === 'preset') poses = await presetHandPoses(entry)
    else poses = Object.fromEntries(Object.entries(entry.data.poses || {}).map(([k, p]) => [k, migrateHandPose(p)]))
    if (!poses || (!poses.L && !poses.R)) throw new Error(`"${entry.name}" has no hand pose in it.`)
    for (const rig of targets) Object.assign(quats, handPoseToBoneQuats(rig, poseForRig(poses, rig), amount))
  }
  stopPlaybackForPosing()
  const { applied } = applyPose({ format: POSE_FORMAT, bones: quats })
  return { applied, label: entry.name }
}

async function presetHandPoses(entry) {
  const { BVHLoader } = await import('three/examples/jsm/loaders/BVHLoader.js')
  const text = await loadPresetPoseText(entry)
  const result = new BVHLoader().parse(text)
  return handPosesFromBVH({ skeleton: result.skeleton, clip: result.clip })
}

// Put an animation on the character as a new clip, paused on its first frame. Resolves with { name }.
export async function applyAnimationEntry(entry) {
  const s = useStore.getState()
  if (entry.source === 'preset') {
    const text = await loadPresetText(entry)
    let base = entry.name
    let n = 2
    while (s.importedClipNames.includes(base)) base = `${entry.name} (${n++})`
    const { name } = await importBVHAuto(new File([text], `${base}.bvh`))
    return { name, label: entry.name }
  }
  const name = importClipJSON(entry.data.clip)
  if (!name) throw new Error('Load a model first.')
  s.addImportedClipName(name)
  s.setPlaybackSource('clip')
  s.setActiveClipName(name)
  const d = selectClip(name, { loop: s.loop, speed: s.speed }, useStore.getState().animData)
  s.setDuration(d)
  s.setCurrentTime(0)
  s.setPlayback('paused')
  s.requestAdoptClipKeys(name) // the Animate panel loads the clip's remembered keyframes when it can
  return { name, label: entry.name }
}

// ---- Hand sliders (live) ------------------------------------------------------------------------------

// Names of the finger bones a slider drag on `side` will move - hand this to beginHandAdjust().
export function handBoneNames(side = 'both') {
  const out = []
  for (const rig of requireHands(side)) for (const chain of Object.values(rig.fingers)) for (const b of chain) out.push(b.name)
  return out
}

export function beginHandAdjust(side) {
  stopPlaybackForPosing()
  beginBonesAdjust(handBoneNames(side))
}

// Show the hand(s) curled by `curl` ({ thumb, index, middle, ring, pinky }, each 0..1) and fanned by `spread` (0..1),
// straight from rest. No undo entry until endHandAdjust().
export function setHandCurl(side, curl, spread = 0) {
  const quats = {}
  for (const rig of requireHands(side)) Object.assign(quats, handPoseToBoneQuats(rig, analyticHandPose(rig, { curl, spread })))
  setBonesLive(quats)
}

export function endHandAdjust() {
  return endBonesAdjust()
}

// ---- Saving --------------------------------------------------------------------------------------------

function cleanName(name, fallback) {
  const n = String(name || '').trim()
  return n || fallback
}

// Save the character's current pose. Resolves with the stored entry.
export async function saveCurrentBodyPose(name) {
  const pose = getPose()
  if (!Object.keys(pose.bones).length) throw new Error('Load a character first.')
  const bones = getPoseBones()
  bones[0]?.updateWorldMatrix(true, true)
  return putEntry({
    kind: 'body',
    name: cleanName(name, 'My pose'),
    thumb: bodyThumb(bones),
    data: { bones: pose.bones },
  })
}

// Save the current left or right hand. Resolves with the stored entry.
export async function saveCurrentHandPose(side, name) {
  const rig = getHandRigs().find((r) => r.side === side)
  if (!rig) throw new Error(side === 'L' ? 'This character has no left hand with fingers.' : 'This character has no right hand with fingers.')
  const pose = captureHandPose(rig)
  getPoseBones()[0]?.updateWorldMatrix(true, true)
  return putEntry({
    kind: 'hand',
    name: cleanName(name, side === 'L' ? 'My left hand' : 'My right hand'),
    thumb: handThumbFromBones(getPoseBones(), getBoneRestQuaternion, side),
    data: { poses: { [side]: pose } },
  })
}

// Save the clip with this name (it must be one of the character's clips). Resolves with the stored entry.
export async function saveClipToLibrary(clipName, name) {
  const json = exportClipJSON(clipName)
  if (!json) throw new Error('Pick a clip first.')
  return putEntry({
    kind: 'animation',
    name: cleanName(name, clipName),
    thumb: { segs: [], duration: json.clip?.duration },
    data: { clip: json },
  })
}

export { BASIC_HANDS, sideLabel }
