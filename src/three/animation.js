import * as THREE from 'three'
import { parseBVH, retargetParsed, buildSlotMapping, buildNameMatch, mergeNames } from './bvh.js'
import {
  sampleMeshTracks,
  getMeshPlaybackSnapshot,
  applyMeshPlaybackSnapshot,
} from './meshedit.js'
import {
  sampleCameraTracks,
  getCamerasPlaybackSnapshot,
  applyCamerasPlaybackSnapshot,
} from './cameras.js'

// ---------------------------------------------------------------------------
// Animation
//
// One AnimationMixer per model (rooted at model.root) plays either a baked glTF
// clip OR an in-app clip built from keyframe tracks. Both are bone-name-keyed, so
// the same mixer handles them and in-app data stays portable.
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
  editMeshes: null, // part-motion tracks { [meshIndex]: [{time,pos,quat,scale}] } (edit source only)
  editCameras: null, // camera-motion tracks { [name]: [{time,pos,quat}] } (edit source only)
  editCuts: null, // camera cuts [{time, camera: name}] (edit source only, sorted)
  rootRest: null, // character root transform at playback start (restored on stop)
  meshRest: null, // part placements at playback start (restored on stop)
  camerasRest: null, // camera placements at playback start (restored on stop)
  viewRest: null, // viewCameraId before cuts took over (restored on stop)
  hasViewRest: false,
  lastCut: undefined, // camera name of the cut currently applied (dedupes store writes)
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
  a.restPos = new Map()
  for (const b of model.bones || []) {
    a.restQuats.set(b, b.quaternion.clone())
    a.restPos.set(b, b.position.clone()) // retargeted clips animate the hip's position
  }
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
  a.editMeshes = null
  a.editCameras = null
  a.editCuts = null
  a.rootRest = null
  a.meshRest = null
  a.camerasRest = null
  a.viewRest = null
  a.hasViewRest = false
  a.lastCut = undefined
  a.model = null
  a.bakedClips = []
  a.importedClips = []
  a.pendingBVH = null
  a.restQuats = null
  a.restPos = null
}

// Advance the mixer (called from the scene's continuous loop) and report time.
export function updateAnimation(delta) {
  if (!a.mixer) return
  a.mixer.update(delta)
  if (a.action) {
    const t = a.action.time
    sampleRoot(t) // drive character world motion (edit source only)
    if (a.editMeshes) sampleMeshTracks(a.editMeshes, t) // part motion
    if (a.editCameras) sampleCameraTracks(a.editCameras, t) // camera motion
    sampleCuts(t) // hard-switch the view to the cut camera
    a.refs.onTime(t)
  }
}

// --- Source selection --------------------------------------------------------

// Load a clip by name (baked or imported mocap) as the active action, paused at
// t=0. Returns its duration (0 if not found).
export function selectClip(name, opts = {}) {
  const clip = findClip(name)
  if (!clip) return 0
  a.editRoot = null // baked/mocap clips are in-place (no root motion)
  a.editMeshes = null // …and don't drive parts, cameras or cuts
  a.editCameras = null
  a.editCuts = null
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
  restoreRest() // the retarget measures the rig's rest pose — make sure it's in it
  const { clip, matched, total } = await retargetParsed(a.pendingBVH, a.model, names, hip)
  a.importedClips.push(clip)
  a.pendingBVH = null
  a.refs.requestRender() // the retarget touched the rig; redraw the reset pose
  return { name: clip.name, matched, total }
}

export function cancelBVHImport() {
  a.pendingBVH = null
}

// Register a programmatically built clip (e.g. a baked ragdoll fall) so it
// plays like the imported ones. The name is made unique so repeated runs
// don't collide. Returns the final name (null if no model is loaded).
export function addGeneratedClip(clip) {
  if (!a.model) return null
  const base = clip.name || 'Clip'
  let name = base
  for (let n = 2; findClip(name); n++) name = `${base} ${n}`
  clip.name = name
  a.importedClips.push(clip)
  return name
}

// Sample a clip at one time into a pose map { boneName: [x,y,z,w] } (for "apply
// frame as pose"). Leaves the rig at rest afterwards.
export function sampleClipToPose(name, time) {
  const clip = findClip(name)
  if (!clip || !a.model) return null
  const mixer = new THREE.AnimationMixer(a.model.root)
  const act = mixer.clipAction(clip)
  act.loop = THREE.LoopOnce
  act.clampWhenFinished = true
  act.play()
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
  const act = mixer.clipAction(clip)
  act.loop = THREE.LoopOnce
  act.clampWhenFinished = true
  act.play()

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

// Build the in-app clip from the full keyframe data (bone tracks + root motion
// + part motion + camera motion), and make it the active action. Bone tracks go
// through the mixer; the rest are sampled manually each frame. Returns the
// duration.
export function selectEdit(animData, duration, opts = {}) {
  // Drop the previous in-app clip's cached action so rebuilds don't accumulate.
  if (a.editClip && a.mixer) a.mixer.uncacheClip(a.editClip)
  const clip = buildEditClip(animData.tracks || {}, duration)
  a.editClip = clip
  const rootKeys = animData.root
  a.editRoot = rootKeys && rootKeys.length ? [...rootKeys].sort((x, y) => x.time - y.time) : null
  a.editMeshes = hasKeys(animData.meshes) ? sortTracks(animData.meshes) : null
  a.editCameras = hasKeys(animData.cameras) ? sortTracks(animData.cameras) : null
  const cuts = animData.cuts
  a.editCuts = cuts && cuts.length ? [...cuts].sort((x, y) => x.time - y.time) : null
  // Remember where the driven parts/cameras sit now, so Stop puts them back.
  a.meshRest = a.editMeshes ? getMeshPlaybackSnapshot() : null
  a.camerasRest = a.editCameras ? getCamerasPlaybackSnapshot() : null
  // Remember which camera (if any) the user was looking through before the
  // cuts take over, so Stop returns to their view.
  if (a.editCuts && !a.hasViewRest) {
    a.viewRest = a.refs.getViewCameraId ? a.refs.getViewCameraId() : null
    a.hasViewRest = true
    a.lastCut = undefined
  }
  activate(clip, opts)
  return clip.duration
}

// Apply the camera cut in effect at time t: the view switches to the camera of
// the latest cut at or before t; before the first cut it shows the pre-play
// view. Only pushes a change when the target actually differs.
function sampleCuts(t) {
  if (!a.editCuts || !a.refs.onCameraCut) return
  let cut = null
  for (const k of a.editCuts) {
    if (k.time <= t + 1e-6) cut = k
    else break
  }
  const target = cut ? cut.camera : null // null = the pre-play view
  if (target === a.lastCut) return
  a.lastCut = target
  a.refs.onCameraCut(target, a.viewRest)
}

function hasKeys(tracks) {
  return tracks && Object.values(tracks).some((keys) => keys && keys.length)
}

function sortTracks(tracks) {
  const out = {}
  for (const [key, keys] of Object.entries(tracks)) {
    if (keys && keys.length) out[key] = [...keys].sort((x, y) => x.time - y.time)
  }
  return out
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
  applyMeshPlaybackSnapshot(a.meshRest)
  a.meshRest = null
  applyCamerasPlaybackSnapshot(a.camerasRest)
  a.camerasRest = null
  if (a.hasViewRest) {
    if (a.refs.setViewCameraId) a.refs.setViewCameraId(a.viewRest)
    a.viewRest = null
    a.hasViewRest = false
    a.lastCut = undefined
  }
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
  if (a.editMeshes) sampleMeshTracks(a.editMeshes, a.action.time)
  if (a.editCameras) sampleCameraTracks(a.editCameras, a.action.time)
  sampleCuts(a.action.time)
  a.refs.requestRender()
}

// --- BVH export --------------------------------------------------------------

const RAD2DEG = 180 / Math.PI
const _e = new THREE.Euler()
const _wp = new THREE.Vector3()

function fmtNum(n) {
  return (Math.abs(n) < 1e-6 ? 0 : n).toFixed(4)
}

// Interpolate the character root-motion keys at time t onto an object3D.
function applyRootAt(keys, t, obj) {
  if (t <= keys[0].time) return applyRootKey(obj, keys[0])
  if (t >= keys[keys.length - 1].time) return applyRootKey(obj, keys[keys.length - 1])
  let i = 0
  while (i < keys.length - 1 && keys[i + 1].time < t) i++
  const k0 = keys[i]
  const k1 = keys[i + 1]
  const span = k1.time - k0.time
  const f = span > 0 ? (t - k0.time) / span : 0
  obj.position.set(
    k0.pos[0] + (k1.pos[0] - k0.pos[0]) * f,
    k0.pos[1] + (k1.pos[1] - k0.pos[1]) * f,
    k0.pos[2] + (k1.pos[2] - k0.pos[2]) * f,
  )
  _qa.fromArray(k0.quat)
  _qb.fromArray(k1.quat)
  obj.quaternion.slerpQuaternions(_qa, _qb, f)
}

// Export the in-app animation (bone rotations + character root motion) as BVH
// text. Rotations use 'ZXY' Euler order to match our BVHLoader's channel order,
// so re-importing round-trips. Single-root skeletons only; the root joint's
// position channels carry the character's world motion.
export function exportAnimationBVH(animData, fps, duration) {
  if (!a.model || !a.model.bones || a.model.bones.length === 0) return null
  const bones = a.model.bones
  const boneSet = new Set(bones)
  const childrenOf = new Map(bones.map((b) => [b, []]))
  const roots = []
  for (const b of bones) {
    if (b.parent && boneSet.has(b.parent)) childrenOf.get(b.parent).push(b)
    else roots.push(b)
  }
  if (roots.length === 0) return null
  const rootBone = roots[0]
  const isRoot = (b) => b === rootBone

  // --- sample the animation frame by frame ---
  const clip = buildEditClip(animData.tracks, duration)
  const mixer = new THREE.AnimationMixer(a.model.root)
  const bvhAction = mixer.clipAction(clip)
  bvhAction.loop = THREE.LoopOnce // don't wrap when sampling the final frame
  bvhAction.clampWhenFinished = true
  bvhAction.play()
  const rootKeys = (animData.root || []).slice().sort((x, y) => x.time - y.time)
  const savedPos = a.model.root.position.clone()
  const savedQuat = a.model.root.quaternion.clone()

  const numFrames = Math.max(2, Math.round(duration * fps) + 1)
  const frameTime = duration / (numFrames - 1)
  const frames = []
  for (let f = 0; f < numFrames; f++) {
    const t = f * frameTime
    mixer.setTime(t)
    if (rootKeys.length) applyRootAt(rootKeys, t, a.model.root)
    a.model.root.updateWorldMatrix(true, true)
    const rot = new Map()
    for (const b of bones) {
      _e.setFromQuaternion(b.quaternion, 'ZXY')
      rot.set(b, [_e.z * RAD2DEG, _e.x * RAD2DEG, _e.y * RAD2DEG])
    }
    rootBone.getWorldPosition(_wp)
    frames.push({ rot, rootPos: [_wp.x, _wp.y, _wp.z] })
  }
  mixer.stopAllAction()
  mixer.uncacheClip(clip)
  restoreRest()
  a.model.root.position.copy(savedPos)
  a.model.root.quaternion.copy(savedQuat)
  a.model.root.updateWorldMatrix(true, true)

  // --- write HIERARCHY (rest offsets), collecting the channel order ---
  const order = []
  let out = 'HIERARCHY\n'
  const write = (bone, depth) => {
    const pad = '\t'.repeat(depth)
    out += `${pad}${isRoot(bone) ? 'ROOT' : 'JOINT'} ${bone.name || 'bone'}\n${pad}{\n`
    const off = isRoot(bone) ? [0, 0, 0] : bone.position.toArray()
    out += `${pad}\tOFFSET ${fmtNum(off[0])} ${fmtNum(off[1])} ${fmtNum(off[2])}\n`
    out += isRoot(bone)
      ? `${pad}\tCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\n`
      : `${pad}\tCHANNELS 3 Zrotation Xrotation Yrotation\n`
    order.push(bone)
    const kids = childrenOf.get(bone)
    if (kids.length === 0) {
      const L = bone.position.length() || 0.1
      out += `${pad}\tEnd Site\n${pad}\t{\n${pad}\t\tOFFSET 0 ${fmtNum(L)} 0\n${pad}\t}\n`
    } else {
      for (const k of kids) write(k, depth + 1)
    }
    out += `${pad}}\n`
  }
  write(rootBone, 0)

  // --- write MOTION (channel values per frame, in the same order) ---
  out += `MOTION\nFrames: ${numFrames}\nFrame Time: ${frameTime.toFixed(6)}\n`
  for (const fr of frames) {
    const parts = []
    for (const b of order) {
      if (isRoot(b)) parts.push(fmtNum(fr.rootPos[0]), fmtNum(fr.rootPos[1]), fmtNum(fr.rootPos[2]))
      const r = fr.rot.get(b)
      parts.push(fmtNum(r[0]), fmtNum(r[1]), fmtNum(r[2]))
    }
    out += parts.join(' ') + '\n'
  }
  return out
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
  if (a.restPos) for (const [bone, p] of a.restPos) bone.position.copy(p)
}

function onFinished() {
  if (a.action) a.action.paused = true
  a.refs.setContinuousRender(false)
  a.refs.onEnded()
  a.refs.requestRender()
}
