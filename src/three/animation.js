import * as THREE from 'three'
import { parseBVH, retargetParsed, buildSlotMapping, buildNameMatch, mergeNames } from './bvh.js'

// ---------------------------------------------------------------------------
// Animation (Phase 4)
//
// One AnimationMixer per model (rooted at model.root) plays either a baked glTF
// clip OR an in-app clip built from keyframe tracks. Both are bone-name-keyed, so
// the same mixer handles them and in-app data stays portable (BVH retarget later).
//
// Playback drives the bones, so it is mutually exclusive with interactive posing:
// starting playback suspends the gizmo (via refs), stopping restores the rest
// pose and resumes it. Rendering uses the scene's continuous loop while playing;
// scrubbing applies a single frame on demand.
//
// This module owns no scene refs directly — scene.js wires them in via
// initAnimation() to avoid an import cycle.
// ---------------------------------------------------------------------------

const a = {
  refs: null, // { requestRender, setContinuousRender, suspendPosing, resumePosing, onTime, onEnded }
  mixer: null,
  model: null,
  bakedClips: [], // AnimationClip[] from the file
  importedClips: [], // AnimationClip[] retargeted from imported BVH mocap
  pendingBVH: null, // parsed BVH awaiting a confirmed bone mapping
  restQuats: null, // Map<Bone, Quaternion> captured at load
  action: null, // current AnimationAction
  clip: null, // current clip (baked or built)
  editClip: null, // built in-app clip, disposed/rebuilt on demand
  editRoot: null, // character root-motion keyframes [{time,pos,quat}] (edit source only)
  rootRest: null, // character root transform at playback start (restored on stop)
}

const _qa = new THREE.Quaternion()
const _qb = new THREE.Quaternion()

export function initAnimation(refs) {
  a.refs = refs
}

// Bind to a freshly loaded model: new mixer, capture baked clips + rest pose.
export function setAnimationModel(model) {
  clearAnimationModel()
  a.model = model
  a.bakedClips = model.clips || []
  a.importedClips = []
  a.mixer = new THREE.AnimationMixer(model.root)
  a.restQuats = new Map()
  for (const b of model.bones || []) a.restQuats.set(b, b.quaternion.clone())
  // A LoopOnce clip reaching its end fires 'finished' → report a soft pause.
  a.mixer.addEventListener('finished', onFinished)
}

export function clearAnimationModel() {
  if (a.mixer) {
    a.mixer.removeEventListener('finished', onFinished)
    a.mixer.stopAllAction()
    a.mixer.uncacheRoot(a.mixer.getRoot())
    a.mixer = null
  }
  a.action = null
  a.clip = null
  a.editClip = null
  a.editRoot = null
  a.rootRest = null
  a.model = null
  a.bakedClips = []
  a.importedClips = []
  a.pendingBVH = null
  a.restQuats = null
}

// Advance the mixer (called from the scene's continuous loop) and report time.
export function updateAnimation(delta) {
  if (!a.mixer) return
  a.mixer.update(delta)
  if (a.action) {
    sampleRoot(a.action.time) // drive character world motion (edit source only)
    a.refs.onTime(a.action.time)
  }
}

// --- Source selection --------------------------------------------------------

// Load a clip by name (baked or imported mocap) as the active action, paused at
// t=0. Returns its duration (0 if not found).
export function selectClip(name, opts = {}) {
  const clip = findClip(name)
  if (!clip) return 0
  a.editRoot = null // baked/mocap clips are in-place (no root motion)
  activate(clip, opts)
  return clip.duration
}

// --- Mocap (BVH) -------------------------------------------------------------

// Step 1: parse a BVH and build the auto slot mapping for the mapping editor.
// Returns { name, sourceBones, targetBones, slots } — nothing is applied yet.
export async function beginBVHImport(file) {
  if (!a.model) throw new Error('Load a model first.')
  const parsed = await parseBVH(file)
  const targetBones = (a.model.bones || []).map((b) => b.name)
  // Full name-match (fingers, spine chains, …) kept alongside the parsed BVH;
  // the slot mapping is layered on top of it at retarget time.
  parsed.autoNames = buildNameMatch(targetBones, parsed.bones)
  a.pendingBVH = parsed
  return {
    name: parsed.name,
    sourceBones: parsed.bones,
    targetBones,
    slots: buildSlotMapping(targetBones, parsed.bones),
  }
}

// Step 2: retarget the pending BVH using the (possibly hand-edited) slot mapping
// and add the resulting clip to the playable list. Returns { name, matched, total }.
export async function applyBVHRetarget(slots) {
  if (!a.pendingBVH) throw new Error('No BVH is being imported.')
  const { names, hip } = mergeNames(a.pendingBVH.autoNames, slots)
  const { clip, matched, total } = await retargetParsed(a.pendingBVH, a.model, names, hip)
  a.importedClips.push(clip)
  a.pendingBVH = null
  a.refs.requestRender() // the retarget touched the rig; redraw the reset pose
  return { name: clip.name, matched, total }
}

export function cancelBVHImport() {
  a.pendingBVH = null
}

// Sample a clip at one time into a pose map { boneName: [x,y,z,w] } (for "apply
// frame as pose"). Leaves the rig at rest afterwards.
export function sampleClipToPose(name, time) {
  const clip = findClip(name)
  if (!clip || !a.model) return null
  const mixer = new THREE.AnimationMixer(a.model.root)
  mixer.clipAction(clip).play()
  mixer.setTime(Math.max(0, Math.min(time, clip.duration)))
  const out = {}
  for (const b of a.model.bones) {
    const q = b.quaternion
    out[b.name] = [q.x, q.y, q.z, q.w]
  }
  mixer.stopAllAction()
  mixer.uncacheClip(clip)
  restoreRest()
  a.refs.requestRender()
  return out
}

// Bake a clip into editable in-app keyframe tracks at the given fps. Static bones
// (unchanged across the clip) are pruned. Returns { tracks, duration }.
export function bakeClipToTracks(name, fps, duration) {
  const clip = findClip(name)
  if (!clip || !a.model) return null
  const dur = duration || clip.duration
  const frames = Math.max(2, Math.round(dur * fps) + 1)
  const mixer = new THREE.AnimationMixer(a.model.root)
  mixer.clipAction(clip).play()

  const tracks = {}
  for (const b of a.model.bones) tracks[b.name] = []
  for (let f = 0; f < frames; f++) {
    const t = (f / (frames - 1)) * dur
    mixer.setTime(t)
    for (const b of a.model.bones) {
      const q = b.quaternion
      tracks[b.name].push({ time: t, quat: [q.x, q.y, q.z, q.w] })
    }
  }
  mixer.stopAllAction()
  mixer.uncacheClip(clip)
  restoreRest()
  a.refs.requestRender()

  // Drop tracks whose rotation never changes (keeps the keyframe data small).
  for (const boneName of Object.keys(tracks)) {
    const keys = tracks[boneName]
    const first = keys[0].quat
    const moves = keys.some((k) => !quatClose(k.quat, first))
    if (!moves) delete tracks[boneName]
  }
  return { tracks, duration: dur }
}

// Build the in-app clip from keyframe tracks + optional root motion, and make it
// the active action. tracks: { [boneName]: [{time, quat}] }; rootKeys:
// [{time, pos, quat}] for the character's world motion. Returns the duration.
export function selectEdit(tracks, rootKeys, duration, opts = {}) {
  // Drop the previous in-app clip's cached action so rebuilds don't accumulate.
  if (a.editClip && a.mixer) a.mixer.uncacheClip(a.editClip)
  const clip = buildEditClip(tracks, duration)
  a.editClip = clip
  a.editRoot = rootKeys && rootKeys.length ? [...rootKeys].sort((x, y) => x.time - y.time) : null
  activate(clip, opts)
  return clip.duration
}

// --- Transport ---------------------------------------------------------------

export function play() {
  if (!a.action) return
  a.refs.suspendPosing()
  a.action.paused = false
  a.refs.setContinuousRender(true)
}

export function pause() {
  if (!a.action) return
  a.action.paused = true
  a.refs.setContinuousRender(false)
  a.refs.requestRender()
}

// Stop playback, return the rig to its rest pose + pre-play placement, and hand
// control back to posing.
export function stop() {
  if (a.mixer) a.mixer.stopAllAction()
  a.action = null
  a.clip = null
  a.refs.setContinuousRender(false)
  restoreRest()
  restoreRootRest()
  a.refs.resumePosing()
  a.refs.onTime(0)
  a.refs.requestRender()
}

export function setLoop(loop) {
  if (!a.action) return
  a.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
  a.action.clampWhenFinished = !loop
}

export function setSpeed(speed) {
  if (a.action) a.action.timeScale = speed
}

// Jump to an absolute time and apply that single frame (works paused or stopped).
export function scrub(t) {
  if (!a.action || !a.clip) return
  a.action.time = Math.max(0, Math.min(t, a.clip.duration))
  a.mixer.update(0) // apply bindings at the new time without advancing
  sampleRoot(a.action.time)
  a.refs.requestRender()
}

// --- internals ---------------------------------------------------------------

function findClip(name) {
  return a.bakedClips.find((c) => c.name === name) || a.importedClips.find((c) => c.name === name)
}

function quatClose(x, y) {
  return (
    Math.abs(x[0] - y[0]) < 1e-4 &&
    Math.abs(x[1] - y[1]) < 1e-4 &&
    Math.abs(x[2] - y[2]) < 1e-4 &&
    Math.abs(x[3] - y[3]) < 1e-4
  )
}

// Sample the character root-motion keyframes at time t and drive model.root.
function sampleRoot(t) {
  const keys = a.editRoot
  if (!keys || keys.length === 0 || !a.model) return
  const root = a.model.root
  if (t <= keys[0].time) return applyRootKey(root, keys[0])
  if (t >= keys[keys.length - 1].time) return applyRootKey(root, keys[keys.length - 1])
  let i = 0
  while (i < keys.length - 1 && keys[i + 1].time < t) i++
  const k0 = keys[i]
  const k1 = keys[i + 1]
  const span = k1.time - k0.time
  const f = span > 0 ? (t - k0.time) / span : 0
  root.position.set(
    k0.pos[0] + (k1.pos[0] - k0.pos[0]) * f,
    k0.pos[1] + (k1.pos[1] - k0.pos[1]) * f,
    k0.pos[2] + (k1.pos[2] - k0.pos[2]) * f,
  )
  _qa.fromArray(k0.quat)
  _qb.fromArray(k1.quat)
  root.quaternion.slerpQuaternions(_qa, _qb, f)
}

function applyRootKey(root, k) {
  root.position.fromArray(k.pos)
  root.quaternion.fromArray(k.quat)
}

function restoreRootRest() {
  if (a.rootRest && a.model) {
    a.model.root.position.fromArray(a.rootRest.pos)
    a.model.root.quaternion.fromArray(a.rootRest.quat)
  }
  a.rootRest = null
}

function activate(clip, opts) {
  if (!a.mixer) return
  a.mixer.stopAllAction()
  a.clip = clip
  // Remember where the character is placed now, so Stop returns it there.
  if (a.model) {
    a.rootRest = { pos: a.model.root.position.toArray(), quat: a.model.root.quaternion.toArray() }
  }
  const action = a.mixer.clipAction(clip)
  action.reset()
  action.setLoop(opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
  action.clampWhenFinished = !opts.loop
  action.timeScale = opts.speed ?? 1
  action.paused = true
  action.play() // activate so the mixer evaluates it (stays put while paused)
  a.action = action
  a.refs.suspendPosing() // a source is armed; posing steps aside
  a.mixer.update(0) // show frame 0
  a.refs.onTime(0)
  a.refs.requestRender()
}

function buildEditClip(tracks, duration) {
  const kfTracks = []
  for (const [name, keys] of Object.entries(tracks)) {
    if (!keys || keys.length === 0) continue
    const sorted = [...keys].sort((x, y) => x.time - y.time)
    const times = sorted.map((k) => k.time)
    const values = []
    for (const k of sorted) values.push(k.quat[0], k.quat[1], k.quat[2], k.quat[3])
    kfTracks.push(new THREE.QuaternionKeyframeTrack(name + '.quaternion', times, values))
  }
  return new THREE.AnimationClip('in-app', duration, kfTracks)
}

function restoreRest() {
  if (!a.restQuats) return
  for (const [bone, q] of a.restQuats) bone.quaternion.copy(q)
}

function onFinished() {
  if (a.action) a.action.paused = true
  a.refs.setContinuousRender(false)
  a.refs.onEnded()
  a.refs.requestRender()
}
