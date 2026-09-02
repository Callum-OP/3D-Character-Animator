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
import {
  sampleLightTracks,
  getLightsPlaybackSnapshot,
  applyLightsPlaybackSnapshot,
} from './lights.js'

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

// ---------------------------------------------------------------------------
// Multi-character playback
//
// Each loaded character gets its OWN entry (mixer, current action/clip, edit-
// source tracks, rest snapshots, …) in `perChar`, keyed by character id. Only
// ONE character is "active" at a time for EDITING purposes (scrubbing,
// selecting a clip, importing BVH, baking, …) — that's `activeId`, and it's
// what AnimationPanel.jsx's controls operate on. But playback is NOT limited
// to the active character: updateAnimation() advances every loaded
// character's mixer each frame, so several characters can each play their own
// clip at once. The `a` object below is a thin Proxy so the ~700 lines of
// existing clip/BVH/baking logic further down (which all read/write `a.xxx`)
// don't need touching — they transparently see "whichever character is
// currently active", exactly as before.
// ---------------------------------------------------------------------------
function newEntry(model) {
  return {
    model,
    mixer: null,
    bakedClips: model.clips || [],
    importedClips: [],
    pendingBVH: null,
    restQuats: null,
    restPos: null,
    action: null,
    clip: null,
    editClip: null,
    editRoot: null,
    editMeshes: null,
    editCameras: null,
    editLights: null,
    editCuts: null,
    editMorphs: null,
    rootRest: null,
    meshRest: null,
    morphRest: null,
    camerasRest: null,
    lightsRest: null,
    viewRest: null,
    hasViewRest: false,
    lastCut: undefined,
  }
}

const perChar = new Map() // id -> entry (same shape the old singleton `a` had)
let activeId = null // which character AnimationPanel.jsx is currently editing
let globalRefs = null // shared across all characters — renderer/store callbacks don't change per-character
// Normal Play in the Animate panel only follows camera cuts/keys when the
// user opts in (see store.followCameraCuts) — otherwise a work-in-progress
// clip wouldn't keep yanking the view around while posing. Recording/
// previewing a shot in Export always wants the cuts, though, so it forces
// them on for the duration of that playback regardless of the toggle.
let forceCameraCuts = false
export function setForceCameraCuts(on) {
  forceCameraCuts = !!on
}

const a = new Proxy(
  {},
  {
    get(_, prop) {
      if (prop === 'refs') return globalRefs
      const entry = perChar.get(activeId)
      return entry ? entry[prop] : undefined
    },
    set(_, prop, value) {
      if (prop === 'refs') {
        globalRefs = value
        return true
      }
      const entry = perChar.get(activeId)
      if (entry) entry[prop] = value
      return true
    },
  },
)

const _qa = new THREE.Quaternion()
const _qb = new THREE.Quaternion()

export function initAnimation(refs) {
  globalRefs = refs
}

// Bind a freshly loaded model to `id`: new entry, new mixer, capture baked
// clips + rest pose. Becomes the active (edited) character.
export function setAnimationModel(model, id) {
  disposeEntry(id) // in case this id already had one (e.g. reloading in place)
  const entry = newEntry(model)
  entry.mixer = new THREE.AnimationMixer(model.root)
  entry.restQuats = new Map()
  entry.restPos = new Map()
  for (const b of model.bones || []) {
    entry.restQuats.set(b, b.quaternion.clone())
    entry.restPos.set(b, b.position.clone()) // retargeted clips animate the hip's position
  }
  // A LoopOnce clip reaching its end fires 'finished' → report a soft pause.
  entry.mixer.addEventListener('finished', () => onFinished(id))
  perChar.set(id, entry)
  activeId = id
}

// Switch which ALREADY-loaded character AnimationPanel.jsx edits/scrubs.
// Does not touch that character's (or anyone else's) mixer/action — whatever
// is playing keeps playing exactly as it was.
export function setActiveAnimationCharacter(id) {
  activeId = id
}

function disposeEntry(id) {
  const entry = perChar.get(id)
  if (!entry) return
  if (entry.mixer) {
    entry.mixer.stopAllAction()
    entry.mixer.uncacheRoot(entry.mixer.getRoot())
  }
  perChar.delete(id)
  if (activeId === id) activeId = null
}

function anyPlaying() {
  for (const entry of perChar.values()) {
    if (entry.action && !entry.action.paused) return true
  }
  return false
}

// Dispose one character's animation state (called when that character is
// removed/replaced). Defaults to the active character so existing call sites
// that pass no id keep working.
export function clearAnimationModel(id = activeId) {
  disposeEntry(id)
}

// Whether ANY loaded character (active or backgrounded) currently has a
// playing action — lets scene.js know it's safe to stop the render loop.
export function isAnyPlaying() {
  return anyPlaying()
}

// Advance every loaded character's mixer (called from the scene's continuous
// loop) so several characters can each play their own clip simultaneously.
// Mesh-part tracks, camera tracks/cuts, and the UI time readout are scoped to
// whichever character is ACTIVE — those depend on other modules' own
// active-character-only state (meshedit's part gizmo, the shared viewport
// camera), so only one character's clip can drive them at a time.
export function updateAnimation(delta) {
  const uiActiveId = activeId
  for (const [id, entry] of perChar) {
    if (!entry.mixer) continue
    activeId = id // let the helpers below (which read through the `a` proxy) see this entry
    entry.mixer.update(delta)
    if (entry.action) {
      const t = entry.action.time
      sampleRoot(t) // per-model root motion — safe for every character
      if (entry.editMorphs) sampleMorphTracks(entry.editMorphs, t) // per-model morphs — safe for every character
      if (id === uiActiveId) {
        if (entry.editMeshes) sampleMeshTracks(entry.editMeshes, t)
        if (entry.editCameras) sampleCameraTracks(entry.editCameras, t)
        if (entry.editLights) sampleLightTracks(entry.editLights, t)
        sampleCuts(t)
        globalRefs.onTime(t)
      }
    }
  }
  activeId = uiActiveId
}

// --- Source selection --------------------------------------------------------

// Load a clip by name (baked or imported mocap) as the active action, paused at
// t=0. Returns its duration (0 if not found).
// `animData` is optional — pass it (as scene.js's playAllCharacters and this
// panel's playback buttons do) to keep this character's root-motion
// keyframes, driven parts/morphs, and camera cuts/keys live ON TOP OF a
// baked/generated clip (ragdoll bake, BVH import, …) driving its joints.
// Callers that don't pass it (rare — a couple of internal previews) fall
// back to the clip alone, in-place, with no overlay tracks.
export function selectClip(name, opts = {}, animData = null) {
  const clip = findClip(name)
  if (!clip) return 0
  setupOverlayTracks(animData)
  activate(clip, opts)
  return clip.duration
}

// --- Mocap (BVH) -------------------------------------------------------------

// Step 1: parse a BVH and build the auto slot mapping for the mapping editor.
// Returns { name, sourceBones, targetBones, slots } — nothing is applied yet.
export async function beginBVHImport(file) {
  if (!a.model) throw new Error('Load a model first.')
  const parsed = await parseBVH(file)
  const targetBoneObjs = a.model.bones || []
  const targetBones = targetBoneObjs.map((b) => b.name)
  // Full name-match (fingers, spine chains, …) kept alongside the parsed BVH;
  // the slot mapping is layered on top of it at retarget time.
  parsed.autoNames = buildNameMatch(targetBones, parsed.bones)
  a.pendingBVH = parsed
  return {
    name: parsed.name,
    sourceBones: parsed.bones,
    targetBones,
    slots: buildSlotMapping(targetBones, parsed.bones, targetBoneObjs, parsed.skeleton.bones),
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

// Rename an imported/generated clip (combined, trimmed, imported, ragdoll,
// etc). Clips baked into the model file itself can't be renamed — returns
// null in that case. Returns the final, deduped name on success.
export function renameClip(name, newName) {
  const clip = a.importedClips.find((c) => c.name === name)
  if (!clip) return null
  const base = (newName || '').trim() || 'Clip'
  if (base === name) return name
  let final = base
  for (let n = 2; findClip(final); n++) final = `${base} ${n}`
  clip.name = final
  return final
}

// Serialize a clip (baked or imported) to a plain JSON object, for downloading
// or stashing in the persistent clip library. Returns null if not found.
export function exportClipJSON(name) {
  const clip = findClip(name)
  if (!clip) return null
  return clip.toJSON()
}

// Every IMPORTED/GENERATED clip (BVH imports, ragdoll bakes, combined/trimmed
// clips, …) for character `id`, serialized to plain JSON. Baked-in clips
// aren't included — they're re-extracted from the model file itself on load.
// Used by scene.js's getProjectData so this work survives a project save.
export function getImportedClipsData(id) {
  const entry = perChar.get(id)
  if (!entry || !entry.importedClips.length) return []
  return entry.importedClips.map((c) => c.toJSON())
}

// Restore previously-exported imported clips onto character `id` (call after
// setAnimationModel has created its entry, i.e. after the model has loaded).
export function restoreImportedClips(id, clipsJSON) {
  const entry = perChar.get(id)
  if (!entry || !clipsJSON || !clipsJSON.length) return
  for (const json of clipsJSON) {
    try {
      entry.importedClips.push(THREE.AnimationClip.parse(json))
    } catch {
      /* a clip that fails to parse is skipped rather than aborting the load */
    }
  }
}

// Parse a previously-exported clip and register it as playable, same as any
// other imported clip. Returns the final (deduped) name, or null with no model.
export function importClipJSON(json) {
  if (!a.model) return null
  const clip = THREE.AnimationClip.parse(json)
  return addGeneratedClip(clip)
}

// Concatenate several clips end-to-end into one new playable clip (e.g. "walk"
// then "wave"), sampled at `fps`. Order follows `names`. Returns the new
// clip's name, or null.
export function combineClips(names, fps) {
  if (!a.model || names.length < 2) return null
  const tracks = {}
  for (const b of a.model.bones) tracks[b.name] = []
  let offset = 0
  let any = false
  for (const name of names) {
    const clip = findClip(name)
    if (!clip) continue
    const res = sampleClipRange(clip, fps, 0, clip.duration, false)
    if (!res) continue
    any = true
    for (const boneName of Object.keys(tracks)) {
      const keys = res.tracks[boneName]
      if (!keys || !keys.length) continue
      for (const k of keys) tracks[boneName].push({ time: k.time + offset, quat: k.quat, pos: k.pos })
    }
    offset += res.duration
  }
  if (!any) return null
  for (const boneName of Object.keys(tracks)) {
    const keys = tracks[boneName]
    if (!keys.length) {
      delete tracks[boneName]
      continue
    }
    const first = keys[0]
    const rotates = keys.some((k) => !quatClose(k.quat, first.quat))
    const translates = keys.some((k) => !posClose(k.pos, first.pos))
    if (!rotates && !translates) delete tracks[boneName]
  }
  const combined = buildEditClip(tracks, offset, {})
  combined.name = names.join(' + ')
  return addGeneratedClip(combined)
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
// `preserveMotion` (the "Keep original movement" toggle in Make your own):
// when true, the skeleton root/hip's world-space travel over the clip is
// captured alongside the bone rotations and returned as `root` keys, so a
// walk clip baked to editable tracks still carries the character forward
// instead of walking on the spot (bone tracks alone only ever held rotation).
export function bakeClipToTracks(name, fps, duration, preserveMotion = false) {
  const clip = findClip(name)
  if (!clip || !a.model) return null
  return sampleClipRange(clip, fps, 0, duration || clip.duration, true, { preserveMotion })
}

// Find the bone that actually CARRIES root motion in this clip: the one with
// a `<name>.position` track. This is the authoritative signal — far more
// reliable than guessing from skeleton hierarchy, since some rigs nest the
// moving hip under an extra Armature/Root wrapper bone, or the "obvious" top
// bone in the hierarchy simply isn't the one the exporter chose to animate.
// Falls back to the old hierarchy heuristic (topmost bone) if no track has a
// position channel, so it degrades gracefully rather than finding nothing.
function findMovingRootBone(clip, bones) {
  if (!bones || !bones.length) return null
  const byName = new Map(bones.map((b) => [b.name, b]))
  if (clip) {
    for (const tr of clip.tracks) {
      if (!/\.position(\[|$)/.test(tr.name)) continue
      const parsed = THREE.PropertyBinding.parseTrackName(tr.name)
      const b = byName.get(parsed.nodeName)
      if (b) return b
    }
  }
  return findSkeletonRootBone(bones)
}

// Find the skeleton's root bone: the one whose parent isn't itself a bone in
// this skeleton. Same heuristic used for BVH export's ROOT joint. Used as a
// fallback when the clip has no explicit position track to go by.
function findSkeletonRootBone(bones) {
  if (!bones || !bones.length) return null
  const boneSet = new Set(bones)
  for (const b of bones) {
    if (!b.parent || !boneSet.has(b.parent)) return b
  }
  return bones[0]
}

// Cut a clip down to [startTime, endTime] (seconds, clamped to the clip's
// length) and register the result as a brand-new playable clip — the
// original is left untouched. Returns the new clip's name, or null.
export function trimClip(name, fps, startTime, endTime) {
  const clip = findClip(name)
  if (!clip || !a.model) return null
  const res = sampleClipRange(clip, fps, startTime, endTime)
  if (!res) return null
  const trimmed = buildEditClip(res.tracks, res.duration, {})
  trimmed.name = `${name} (trimmed)`
  return addGeneratedClip(trimmed)
}

// Flip an entire clip left ↔ right, frame by frame, and register the result
// as a brand-new playable clip — the original is untouched. Each bone takes
// its mirrored counterpart's rest-relative rotation at every sampled frame
// (found by the usual L/R naming conventions; see mirrorBoneName), reflected
// across the character's centre plane. Bones with no counterpart (spine,
// head…) mirror in place. Same maths as posing.js's single-frame mirrorPose,
// just applied across the whole timeline.
//
// Position is mirrored too, not just rotation: retargeted/mocap clips
// usually put all of the character's actual movement — forward travel,
// hip sway, the vertical bob that keeps a foot looking planted — on the
// hip's local POSITION rather than its rotation (see restPos). Skipping that
// left the hip sitting at its rest position throughout, so a mirrored walk
// no longer matched its own foot rotations: weight looked shifted onto the
// wrong side and feet floated or sank into the ground. Each bone's
// rest-relative position offset is reflected across the same plane as
// rotation (negate local X, keep Y/Z), so hip sway and bob carry over
// correctly onto the swapped side.
export function mirrorClip(name, fps) {
  const clip = findClip(name)
  if (!clip || !a.model || !a.restQuats || !a.restPos) return null
  // prune=false: keep every bone's full per-frame data, sampled at the same
  // time steps, so tracks line up index-for-index across bones below.
  const res = sampleClipRange(clip, fps, 0, clip.duration, false)
  if (!res) return null

  const boneNames = new Set(a.model.bones.map((b) => b.name))
  const boneByName = new Map(a.model.bones.map((b) => [b.name, b]))
  const mirrored = {}

  for (const bone of a.model.bones) {
    const destName = bone.name
    const restQuatDst = a.restQuats.get(bone)
    const restPosDst = a.restPos.get(bone)
    if (!restQuatDst || !restPosDst) continue
    const counterpart = mirrorBoneName(destName, boneNames)
    const srcName = counterpart || destName
    const srcBone = boneByName.get(srcName)
    const restQuatSrc = srcBone ? a.restQuats.get(srcBone) : null
    const restPosSrc = srcBone ? a.restPos.get(srcBone) : null
    const srcKeys = res.tracks[srcName]
    if (!restQuatSrc || !restPosSrc || !srcKeys || !srcKeys.length) continue
    const destKeys = res.tracks[destName]
    const restQuatSrcInv = restQuatSrc.clone().invert()
    const out = []
    for (let i = 0; i < srcKeys.length; i++) {
      const k = srcKeys[i]
      const time = destKeys && destKeys[i] ? destKeys[i].time : k.time

      _qa.fromArray(k.quat)
      // Rest-relative rotation of the source side…
      const delta = restQuatSrcInv.clone().multiply(_qa)
      // …reflected across the YZ plane: axis x flips, so (x,y,z,w) → (x,-y,-z,w).
      delta.set(delta.x, -delta.y, -delta.z, delta.w)
      const after = restQuatDst.clone().multiply(delta)

      // Same reflection, applied to the rest-relative POSITION offset (if
      // this bone carries one — most don't, so this is a no-op for them:
      // dx/dy/dz all stay 0 and pos ends up equal to restPosDst).
      const dx = k.pos[0] - restPosSrc.x
      const dy = k.pos[1] - restPosSrc.y
      const dz = k.pos[2] - restPosSrc.z
      const pos = [restPosDst.x - dx, restPosDst.y + dy, restPosDst.z + dz]

      out.push({ time, quat: [after.x, after.y, after.z, after.w], pos })
    }
    mirrored[destName] = out
  }

  // Drop tracks whose rotation AND position never change, same as
  // sampleClipRange's own pruning — keeps the mirrored clip's keyframe data
  // small.
  for (const boneName of Object.keys(mirrored)) {
    const keys = mirrored[boneName]
    if (!keys.length) {
      delete mirrored[boneName]
      continue
    }
    const first = keys[0]
    const rotates = keys.some((k) => !quatClose(k.quat, first.quat))
    const translates = keys.some((k) => !posClose(k.pos, first.pos))
    if (!rotates && !translates) delete mirrored[boneName]
  }

  const mirroredClip = buildEditClip(mirrored, res.duration, {})
  mirroredClip.name = `${name} (mirrored)`
  return addGeneratedClip(mirroredClip)
}

// Turn the current in-app keyframe tracks (bone rotations only — root
// motion, props, cameras, and morphs aren't part of a mixer clip and stay
// keyframe-only) into a new playable clip. This is what lets a "Make your
// own" creation show up anywhere clips do: the clip list, Save/Export, Trim,
// Combine. Returns the final clip name, or null.
export function clipFromTracks(tracks, duration, name) {
  if (!a.model) return null
  const clip = buildEditClip(tracks, duration, {})
  clip.name = name || 'My clip'
  return addGeneratedClip(clip)
}

// Shared sampler behind bakeClipToTracks/trimClip: plays `clip` on a scratch
// mixer and records each bone's rotation every frame across [start, end],
// re-timed so the result starts at 0. Static bones are pruned.
//
// opts.preserveMotion additionally tracks the skeleton root/hip's WORLD
// travel across the span and returns it as `root` — character-placement
// keyframes in the same shape as animData.root — expressed as a delta from
// frame 0 added on top of wherever the character is currently placed. That
// way the captured movement layers on top of the character's existing
// position rather than snapping it to the hip's raw world coordinates, and
// (since bone tracks here never carry position, only rotation) nothing ends
// up double-applying the motion.
function sampleClipRange(clip, fps, startTime, endTime, prune = true, opts = {}) {
  const dur = clip.duration
  const start = Math.max(0, Math.min(startTime, dur))
  const end = Math.max(start, Math.min(endTime, dur))
  const span = end - start
  const frames = Math.max(2, Math.round(span * fps) + 1)
  const mixer = new THREE.AnimationMixer(a.model.root)
  const act = mixer.clipAction(clip)
  act.loop = THREE.LoopOnce
  act.clampWhenFinished = true
  act.play()

  const rootBone = opts.preserveMotion ? findMovingRootBone(clip, a.model.bones) : null
  const basePos = a.model.root.position.clone()
  const baseQuat = a.model.root.quaternion.clone()
  let startWorld = null
  const rootKeys = rootBone ? [] : null

  const tracks = {}
  for (const b of a.model.bones) tracks[b.name] = []
  for (let f = 0; f < frames; f++) {
    const t = start + (span > 0 ? (f / (frames - 1)) * span : 0)
    mixer.setTime(t)
    for (const b of a.model.bones) {
      const q = b.quaternion
      const bp = b.position
      // Most bones only rotate, but retargeted/mocap clips typically animate
      // the hip's (or another root-like bone's) POSITION too — capture it
      // alongside rotation so nothing that keeps feet planted gets lost when
      // this range is rebuilt into a new clip (trim/combine/mirror).
      tracks[b.name].push({ time: t - start, quat: [q.x, q.y, q.z, q.w], pos: [bp.x, bp.y, bp.z] })
    }
    if (rootBone) {
      a.model.root.updateWorldMatrix(true, true)
      rootBone.getWorldPosition(_wp)
      if (!startWorld) startWorld = _wp.clone()
      rootKeys.push({
        time: t - start,
        pos: [
          basePos.x + (_wp.x - startWorld.x),
          basePos.y + (_wp.y - startWorld.y),
          basePos.z + (_wp.z - startWorld.z),
        ],
        quat: [baseQuat.x, baseQuat.y, baseQuat.z, baseQuat.w],
      })
    }
  }
  mixer.stopAllAction()
  mixer.uncacheClip(clip)
  restoreRest()
  a.refs.requestRender()

  // Drop tracks whose rotation never changes (keeps the keyframe data small).
  // Skipped when this segment will be concatenated with others (prune=false):
  // a bone that's static here but posed in a later segment must still hold a
  // key through this whole span, or the combined clip snaps to the other
  // segment's pose retroactively.
  if (prune) {
    for (const boneName of Object.keys(tracks)) {
      const keys = tracks[boneName]
      const first = keys[0]
      const rotates = keys.some((k) => !quatClose(k.quat, first.quat))
      const translates = keys.some((k) => !posClose(k.pos, first.pos))
      if (!rotates && !translates) delete tracks[boneName]
    }
  }
  return { tracks, duration: span, root: rootKeys }
}

// Build the in-app clip from the full keyframe data (bone tracks + root motion
// + part motion + camera motion), and make it the active action. Bone tracks go
// through the mixer; the rest are sampled manually each frame. Returns the
// duration.
// Set up the "overlay" timelines from `animData` — root motion (character
// position), driven parts/props (meshes), morph targets, and the camera
// keyframe/cut timeline — regardless of whether the CHARACTER's own JOINT
// motion is driven by the in-app edit clip or a baked/generated one (ragdoll
// bake, BVH import, …). These sit on top of the body animation rather than
// being tied to its playback source, so e.g. a ragdoll fall can still walk
// into frame first via a root-motion keyframe, or be filmed through keyed/
// cut cameras. Shared by selectEdit and selectClip.
function setupOverlayTracks(animData) {
  const rootKeys = animData && animData.root
  a.editRoot = rootKeys && rootKeys.length ? [...rootKeys].sort((x, y) => x.time - y.time) : null
  a.editMeshes = animData && hasKeys(animData.meshes) ? sortTracks(animData.meshes) : null
  a.editMorphs = animData && hasMorphKeys(animData.morphs) ? sortMorphTracks(animData.morphs) : null
  a.editCameras = animData && hasKeys(animData.cameras) ? sortTracks(animData.cameras) : null
  a.editLights = animData && hasKeys(animData.lights) ? sortTracks(animData.lights) : null
  const cuts = animData && animData.cuts
  a.editCuts = cuts && cuts.length ? [...cuts].sort((x, y) => x.time - y.time) : null

  // Remember where the driven parts/morphs/cameras sit now, so Stop puts
  // them back.
  a.meshRest = a.editMeshes ? getMeshPlaybackSnapshot() : null
  a.morphRest = a.editMorphs ? getMorphPlaybackSnapshot(a.editMorphs) : null
  a.camerasRest = a.editCameras ? getCamerasPlaybackSnapshot() : null
  a.lightsRest = a.editLights ? getLightsPlaybackSnapshot() : null
  // Remember which camera (if any) the user was looking through before the
  // cuts take over, so Stop returns to their view.
  if (a.editCuts && !a.hasViewRest) {
    a.viewRest = a.refs.getViewCameraId ? a.refs.getViewCameraId() : null
    a.hasViewRest = true
    a.lastCut = undefined
  }
}

export function selectEdit(animData, duration, opts = {}) {
  // Drop the previous in-app clip's cached action so rebuilds don't accumulate.
  if (a.editClip && a.mixer) a.mixer.uncacheClip(a.editClip)
  const clip = buildEditClip(animData.tracks || {}, duration, animData.morphs || {})
  a.editClip = clip
  setupOverlayTracks(animData)
  activate(clip, opts)
  return clip.duration
}

// Apply the camera cut in effect at time t: the view switches to the camera of
// the latest cut at or before t; before the first cut it shows the pre-play
// view. Only pushes a change when the target actually differs. Skipped during
// normal Play unless the user has opted in (store.followCameraCuts) or the
// Export panel has forced cuts on for a recording/preview.
function sampleCuts(t) {
  if (!a.editCuts || !a.refs.onCameraCut) return
  const follow = forceCameraCuts || !a.refs.getFollowCameraCuts || a.refs.getFollowCameraCuts()
  if (!follow) return
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

function hasMorphKeys(tracks) {
  return tracks && Object.values(tracks).some((byName) => byName && Object.values(byName).some((keys) => keys && keys.length))
}

function sortTracks(tracks) {
  const out = {}
  for (const [key, keys] of Object.entries(tracks)) {
    if (keys && keys.length) out[key] = [...keys].sort((x, y) => x.time - y.time)
  }
  return out
}

function sortMorphTracks(tracks) {
  const out = {}
  for (const [meshIndex, byName] of Object.entries(tracks || {})) {
    const sortedByName = {}
    for (const [morphName, keys] of Object.entries(byName || {})) {
      if (keys && keys.length) sortedByName[morphName] = [...keys].sort((x, y) => x.time - y.time)
    }
    if (Object.keys(sortedByName).length) out[meshIndex] = sortedByName
  }
  return out
}

function sampleMorphTracks(tracks, t) {
  if (!tracks) return
  for (const [meshIndex, byName] of Object.entries(tracks)) {
    const mesh = a.model?.meshes?.[Number(meshIndex)]
    if (!mesh?.morphTargetDictionary || !mesh.morphTargetInfluences) continue
    for (const [morphName, keys] of Object.entries(byName)) {
      if (!keys || keys.length === 0) continue
      const index = mesh.morphTargetDictionary[morphName]
      if (index == null) continue
      applyMorphKey(mesh, index, keys, t)
    }
    // NOTE: do not call mesh.updateMorphTargets() here — in three.js that
    // rebuilds morphTargetInfluences/morphTargetDictionary from scratch
    // (all-zero), which would wipe out the values just set above. The
    // renderer picks up in-place array mutations on its own.
  }
}

function applyMorphKey(mesh, index, keys, t) {
  if (!mesh.morphTargetInfluences) return
  if (t <= keys[0].time) {
    mesh.morphTargetInfluences[index] = keys[0].value
    return
  }
  const last = keys[keys.length - 1]
  if (t >= last.time) {
    mesh.morphTargetInfluences[index] = last.value
    return
  }
  let i = 0
  while (i < keys.length - 1 && keys[i + 1].time < t) i++
  const k0 = keys[i]
  const k1 = keys[i + 1]
  const span = k1.time - k0.time
  const f = span > 0 ? (t - k0.time) / span : 0
  mesh.morphTargetInfluences[index] = k0.value + (k1.value - k0.value) * f
}

function getMorphPlaybackSnapshot(tracks) {
  if (!tracks) return null
  const snap = []
  for (const [meshIndex, byName] of Object.entries(tracks)) {
    const mesh = a.model?.meshes?.[Number(meshIndex)]
    if (!mesh?.morphTargetDictionary || !mesh.morphTargetInfluences) continue
    const values = {}
    for (const [morphName] of Object.entries(byName)) {
      const index = mesh.morphTargetDictionary[morphName]
      if (index == null) continue
      values[morphName] = mesh.morphTargetInfluences[index]
    }
    if (Object.keys(values).length) snap.push({ mesh, values })
  }
  return snap.length ? snap : null
}

function applyMorphPlaybackSnapshot(snap) {
  if (!snap) return
  for (const entry of snap) {
    const mesh = entry.mesh
    if (!mesh?.morphTargetDictionary || !mesh.morphTargetInfluences) continue
    for (const [morphName, value] of Object.entries(entry.values)) {
      const index = mesh.morphTargetDictionary[morphName]
      if (index == null) continue
      mesh.morphTargetInfluences[index] = value
    }
    // (see note in sampleMorphTracks — no updateMorphTargets() call here either)
  }
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
  if (!anyPlaying()) a.refs.setContinuousRender(false)
  a.refs.requestRender()
}

// Stop playback, return the rig to its rest pose + pre-play placement, and hand
// control back to posing.
export function stop() {
  if (a.mixer) a.mixer.stopAllAction()
  a.action = null
  a.clip = null
  if (!anyPlaying()) a.refs.setContinuousRender(false)
  restoreRest()
  restoreRootRest()
  applyMeshPlaybackSnapshot(a.meshRest)
  a.meshRest = null
  applyMorphPlaybackSnapshot(a.morphRest)
  a.morphRest = null
  applyCamerasPlaybackSnapshot(a.camerasRest)
  a.camerasRest = null
  applyLightsPlaybackSnapshot(a.lightsRest)
  a.lightsRest = null
  if (a.hasViewRest) {
    // Glide back to the pre-play view instead of snapping — cuts got here
    // smoothly, so leaving them the same way keeps Stop from looking like a
    // jump-cut of its own.
    if (a.refs.transitionViewCameraId) a.refs.transitionViewCameraId(a.viewRest)
    else if (a.refs.setViewCameraId) a.refs.setViewCameraId(a.viewRest)
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
// Current clip's length in seconds (0 if nothing's loaded) — used by the cloth
// modifier to know how far to bake a physics timeline across.
export function getClipDuration() {
  return a.clip ? a.clip.duration : 0
}

// Current playhead time in seconds.
export function getCurrentTime() {
  return a.action ? a.action.time : 0
}

export function scrub(t) {
  if (!a.action || !a.clip) return
  a.action.time = Math.max(0, Math.min(t, a.clip.duration))
  a.mixer.update(0) // apply bindings at the new time without advancing
  sampleRoot(a.action.time)
  if (a.editMeshes) sampleMeshTracks(a.editMeshes, a.action.time)
  if (a.editMorphs) sampleMorphTracks(a.editMorphs, a.action.time)
  if (a.editCameras) sampleCameraTracks(a.editCameras, a.action.time)
  if (a.editLights) sampleLightTracks(a.editLights, a.action.time)
  sampleCuts(a.action.time)
  a.refs.requestRender()
}

// --- BVH export --------------------------------------------------------------

const RAD2DEG = 180 / Math.PI
const _e = new THREE.Euler()
const _wp = new THREE.Vector3()
const _wq = new THREE.Quaternion()
const _pwq = new THREE.Quaternion()
const _bp = new THREE.Vector3()
const _pp = new THREE.Vector3()
const _pq = new THREE.Quaternion()

function fmtNum(n) {
  return (Math.abs(n) < 1e-6 ? 0 : n).toFixed(4)
}

// A bone's world-space rotation with any scale/reflection in its ancestor
// chain divided back out (Object3D.getWorldQuaternion decomposes matrixWorld,
// which — unlike reading .quaternion directly — resolves a negatively-scaled
// ("mirrored") parent into a proper rotation instead of silently ignoring the
// flip). BVH has no scale channels at all, so this is the only representation
// that can come out the other side undistorted.
function getWorldQuat(bone) {
  return bone.getWorldQuaternion(_wq2)
}
const _wq2 = new THREE.Quaternion()

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

// Export the SELECTED animation (bone rotations + character root motion) as
// BVH text — whichever clip is chosen in the Animate panel's "Play a clip"
// dropdown (baked, imported/retargeted mocap, ragdoll bake, combined/trimmed
// clip, …), or the in-app hand-keyframed timeline when that's what's active.
//
// This looks the clip up BY NAME (store.activeClipName / store.playbackSource)
// rather than relying on whatever's currently armed on the live mixer
// (a.action/a.clip). Those get cleared by stop() the moment playback stops —
// pressing Stop, a preview finishing, navigating away and back — so a naive
// "sample whatever's currently playing" check very often finds nothing by the
// time someone actually clicks Export, and silently falls back to sampling
// animData.tracks (empty for a baked/imported clip) for the app's default
// timeline length. That produces a file whose every single frame is
// identical — a real single pose repeated N times, not a frozen mid-clip
// frame — which is exactly the original "only exports a pose" bug, just
// reintroduced by an export-time state check instead of a wrong data source.
// Looking the clip up by name sidesteps play state entirely: whatever's
// SELECTED gets exported, whether it's playing, paused, or stopped.
//
// Rotations use 'ZXY' Euler order to match our BVHLoader's channel order, so
// re-importing round-trips. Single-root skeletons only; the root joint's
// position channels carry the character's world motion.
export function exportAnimationBVH(animData, fps, duration, clipName, playbackSource) {
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

  // Resolve the real clip object by name (works regardless of whether it's
  // currently playing, paused, or stopped) — only fall back to building a
  // disposable clip from animData.tracks for genuine in-app hand-keyframing
  // with no baked/imported clip involved at all.
  const namedClip = playbackSource === 'clip' && clipName ? findClip(clipName) : null
  const totalDuration = namedClip ? namedClip.duration : duration
  if (!totalDuration || totalDuration <= 0) return null

  // --- sample the animation frame by frame, on a throwaway mixer so this
  // never disturbs whatever the live a.mixer/a.action are doing ---
  const clip = namedClip || buildEditClip(animData.tracks, duration)
  const mixer = new THREE.AnimationMixer(a.model.root)
  const bvhAction = mixer.clipAction(clip)
  bvhAction.loop = THREE.LoopOnce // don't wrap when sampling the final frame
  bvhAction.clampWhenFinished = true
  bvhAction.play()

  const rootKeys = (animData.root || []).slice().sort((x, y) => x.time - y.time)
  const savedPos = a.model.root.position.clone()
  const savedQuat = a.model.root.quaternion.clone()

  const numFrames = Math.max(2, Math.round(totalDuration * fps) + 1)
  const frameTime = totalDuration / (numFrames - 1)
  const frames = []
  for (let f = 0; f < numFrames; f++) {
    const t = f * frameTime
    mixer.setTime(t)
    if (rootKeys.length) applyRootAt(rootKeys, t, a.model.root)
    a.model.root.updateWorldMatrix(true, true)
    const rot = new Map()
    for (const b of bones) {
      // Rotation is taken relative to the bone's WORLD orientation (not its
      // raw local quaternion) — see the note above write(): this is what
      // makes the root joint's facing correct when the model has a wrapper
      // node above the skeleton (a common "Armature" node carrying a Z-up ->
      // Y-up correction, or similar), and what keeps any bone whose parent
      // chain includes a mirrored/negatively-scaled node (a common way rigs
      // build a symmetric left/right pair) from coming out twisted — BVH has
      // no scale channels, so the only faithful thing to export is each
      // bone's rotation relative to its parent's actual WORLD orientation.
      _wq.copy(getWorldQuat(b))
      if (!isRoot(b)) {
        _pwq.copy(getWorldQuat(b.parent)).invert()
        _wq.premultiply(_pwq)
      }
      _e.setFromQuaternion(_wq, 'ZXY')
      rot.set(b, [_e.z * RAD2DEG, _e.x * RAD2DEG, _e.y * RAD2DEG])
    }
    rootBone.getWorldPosition(_wp)
    frames.push({ rot, rootPos: [_wp.x, _wp.y, _wp.z] })
  }

  // --- put everything back exactly how it was before export ---
  mixer.stopAllAction()
  mixer.uncacheClip(clip)
  restoreRest()
  a.model.root.position.copy(savedPos)
  a.model.root.quaternion.copy(savedQuat)
  a.model.root.updateWorldMatrix(true, true)

  // Rest OFFSETS, one per non-root bone: the bone's rest position relative to
  // its parent, expressed in the parent's UN-SCALED rotated frame (world-space
  // delta, un-rotated by the parent's world orientation) rather than read
  // straight off bone.position. Plain bone.position is defined in the
  // parent's own (possibly scaled/mirrored) local space, so if a rig mirrors
  // one side via a negative scale anywhere above a bone — a common cheap way
  // to build a symmetric left/right pair — that bone's offset comes out
  // mirrored to the wrong side once BVH (which has no scale channels at all)
  // drops the scale. Computing it from world positions sidesteps that.
  const restOffsets = new Map()
  for (const b of bones) {
    if (isRoot(b)) {
      restOffsets.set(b, new THREE.Vector3())
      continue
    }
    b.getWorldPosition(_bp)
    b.parent.getWorldPosition(_pp)
    getWorldQuat(b.parent)
    _pq.copy(_wq2).invert()
    restOffsets.set(b, _bp.clone().sub(_pp).applyQuaternion(_pq))
  }

  // --- write HIERARCHY (rest offsets), collecting the channel order ---
  const order = []
  let out = 'HIERARCHY\n'
  const write = (bone, depth) => {
    const pad = '\t'.repeat(depth)
    out += `${pad}${isRoot(bone) ? 'ROOT' : 'JOINT'} ${bone.name || 'bone'}\n${pad}{\n`
    const off = restOffsets.get(bone)
    out += `${pad}\tOFFSET ${fmtNum(off.x)} ${fmtNum(off.y)} ${fmtNum(off.z)}\n`
    out += isRoot(bone)
      ? `${pad}\tCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\n`
      : `${pad}\tCHANNELS 3 Zrotation Xrotation Yrotation\n`
    order.push(bone)
    const kids = childrenOf.get(bone)
    if (kids.length === 0) {
      const L = off.length() || 0.1
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

// Find a bone's opposite-side counterpart by the common L/R naming schemes
// (Left/Right words, .L/.R, _l/_r, l_/r_ affixes). Returns a name present in
// `names`, or null for centre bones. Mirrors posing.js's own mirrorBoneName —
// duplicated here (rather than imported) so this module doesn't depend on
// whichever model posing.js currently has bound, since clip mirroring can run
// on any loaded character, active-for-posing or not.
const MIRROR_SIDE_PATTERNS = [
  [/Left/g, 'Right'],
  [/Right/g, 'Left'],
  [/left/g, 'right'],
  [/right/g, 'left'],
  [/LEFT/g, 'RIGHT'],
  [/RIGHT/g, 'LEFT'],
  [/([._-])L($|[._-])/g, '$1R$2'],
  [/([._-])R($|[._-])/g, '$1L$2'],
  [/([._-])l($|[._-])/g, '$1r$2'],
  [/([._-])r($|[._-])/g, '$1l$2'],
  [/^L([._-])/, 'R$1'],
  [/^R([._-])/, 'L$1'],
  [/^l([._-])/, 'r$1'],
  [/^r([._-])/, 'l$1'],
]

function mirrorBoneName(name, names) {
  for (const [re, sub] of MIRROR_SIDE_PATTERNS) {
    re.lastIndex = 0
    const swapped = name.replace(re, sub)
    if (swapped !== name && names.has(swapped)) return swapped
  }
  return null
}

function quatClose(x, y) {
  return (
    Math.abs(x[0] - y[0]) < 1e-4 &&
    Math.abs(x[1] - y[1]) < 1e-4 &&
    Math.abs(x[2] - y[2]) < 1e-4 &&
    Math.abs(x[3] - y[3]) < 1e-4
  )
}

function posClose(x, y) {
  if (!x || !y) return true
  return Math.abs(x[0] - y[0]) < 1e-5 && Math.abs(x[1] - y[1]) < 1e-5 && Math.abs(x[2] - y[2]) < 1e-5
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

function buildEditClip(tracks, duration, morphs = {}) {
  const kfTracks = []
  for (const [name, keys] of Object.entries(tracks)) {
    if (!keys || keys.length === 0) continue
    const sorted = [...keys].sort((x, y) => x.time - y.time)
    const times = sorted.map((k) => k.time)
    const values = []
    for (const k of sorted) values.push(k.quat[0], k.quat[1], k.quat[2], k.quat[3])
    kfTracks.push(new THREE.QuaternionKeyframeTrack(name + '.quaternion', times, values))

    // Most bones only rotate, so a position track would just be redundant,
    // unchanging keyframes at the bind pose — skip it. Bones that actually
    // translate (the hip on a retargeted/mocap clip, mainly — see restPos)
    // get one too, or their contribution to foot placement/ground contact
    // would silently vanish when this clip is rebuilt from sampled data.
    const first = sorted[0].pos
    const translates = first && sorted.some((k) => !posClose(k.pos, first))
    if (translates) {
      const posValues = []
      for (const k of sorted) posValues.push(k.pos[0], k.pos[1], k.pos[2])
      kfTracks.push(new THREE.VectorKeyframeTrack(name + '.position', times, posValues))
    }
  }
  for (const [meshIndex, byName] of Object.entries(morphs)) {
    const mesh = a.model?.meshes?.[Number(meshIndex)]
    if (!mesh?.morphTargetDictionary) continue
    for (const [morphName, keys] of Object.entries(byName)) {
      if (!keys?.length) continue
      const index = mesh.morphTargetDictionary[morphName]
      if (index == null) continue
      const sorted = [...keys].sort((x, y) => x.time - y.time)
      kfTracks.push(
        new THREE.NumberKeyframeTrack(
          `${mesh.uuid}.morphTargetInfluences[${index}]`,
          sorted.map((k) => k.time),
          sorted.map((k) => k.value)
        )
      )
    }
  }
  return new THREE.AnimationClip('in-app', duration, kfTracks)
}

function restoreRest() {
  if (!a.restQuats) return
  for (const [bone, q] of a.restQuats) bone.quaternion.copy(q)
  if (a.restPos) for (const [bone, p] of a.restPos) bone.position.copy(p)
}

function onFinished(id) {
  const entry = perChar.get(id)
  if (!entry) return
  if (entry.action) entry.action.paused = true
  if (id === activeId) globalRefs.onEnded() // only the edited character's UI needs telling
  if (!anyPlaying()) {
    globalRefs.setContinuousRender(false)
    globalRefs.requestRender()
  }
}