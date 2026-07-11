// ---------------------------------------------------------------------------
// BVH mocap import + retargeting (Phase 4 future-work)
//
import * as THREE from 'three'

// A BVH carries its own skeleton (hierarchy + motion) that rarely matches the
// character's rig. We RETARGET the motion onto the character.
//
// We do REST-RELATIVE retargeting: for each mapped bone we take the mocap bone's
// world-space rotation *relative to its own rest* and apply that same delta on
// top of the character bone's rest orientation. This keeps the character in its
// own T-pose and just adds the motion — unlike copying absolute orientation
// (three's SkeletonUtils), which snaps limbs to the mocap skeleton's axes and
// makes them point the wrong way (e.g. straight up).
//
// The hard part is the bone-name map. Different pipelines share no substrings
// (Mixamo "LeftForeArm", CMU "LeftElbow", Rigify "DEF-forearm.L"), so plain
// string matching fails. Instead we classify every bone into a canonical
// HUMANOID SLOT (by keyword + side) and join the two skeletons on those slots.
// The user can then fix any slot by hand before retargeting.
//
// BVHLoader + SkeletonUtils are code-split (dynamic import); they only load when
// the user imports mocap.
// ---------------------------------------------------------------------------

// Canonical humanoid slots, in a sensible display order. Keys with .L/.R are the
// sided limbs.
export const HUMANOID_SLOTS = [
  { key: 'hips', label: 'Hips' },
  { key: 'spine', label: 'Spine' },
  { key: 'chest', label: 'Chest' },
  { key: 'neck', label: 'Neck' },
  { key: 'head', label: 'Head' },
  { key: 'shoulder.L', label: 'Shoulder L' },
  { key: 'upperArm.L', label: 'Upper arm L' },
  { key: 'lowerArm.L', label: 'Forearm L' },
  { key: 'hand.L', label: 'Hand L' },
  { key: 'shoulder.R', label: 'Shoulder R' },
  { key: 'upperArm.R', label: 'Upper arm R' },
  { key: 'lowerArm.R', label: 'Forearm R' },
  { key: 'hand.R', label: 'Hand R' },
  { key: 'upperLeg.L', label: 'Thigh L' },
  { key: 'lowerLeg.L', label: 'Shin L' },
  { key: 'foot.L', label: 'Foot L' },
  { key: 'toe.L', label: 'Toe L' },
  { key: 'upperLeg.R', label: 'Thigh R' },
  { key: 'lowerLeg.R', label: 'Shin R' },
  { key: 'foot.R', label: 'Foot R' },
  { key: 'toe.R', label: 'Toe R' },
]

// Detect which body side a bone name refers to ('L' | 'R' | '').
function detectSide(n) {
  if (/right/.test(n)) return 'R'
  if (/left/.test(n)) return 'L'
  // .r / _r / -r / space r  (as a delimited token), and leading "r." etc.
  if (/[._\- ]r([._\- 0-9]|$)/.test(n) || /(^|[^a-z])r[._\-]/.test(n)) return 'R'
  if (/[._\- ]l([._\- 0-9]|$)/.test(n) || /(^|[^a-z])l[._\-]/.test(n)) return 'L'
  return ''
}

// Classify a bone name into a canonical slot key, or null if it isn't a core
// humanoid bone (fingers, twist bones, props, etc. are skipped). Order matters:
// more specific keywords are tested before generic ones.
export function classifyBone(rawName) {
  const n = rawName.toLowerCase()
  const side = detectSide(n)
  const sided = (base) => (side ? `${base}.${side}` : null) // needs a side to place

  // Skip fingers / twist / helper bones outright.
  if (/thumb|index|middle|ring|pinky|finger|twist|palm|metacarpal/.test(n)) return null

  // Legs & feet (before generic torso).
  if (/toe|toebase|ball/.test(n)) return sided('toe')
  if (/foot|ankle/.test(n)) return sided('foot')
  if (/upleg|upperleg|upper_leg|thigh/.test(n)) return sided('upperLeg')
  // A SIDED "hip" (LeftHip/RightHip) is the thigh in many BVH rigs — only the
  // unsided Hips/pelvis is the root (handled far below).
  if (side && /hip/.test(n)) return sided('upperLeg')
  if (/lowerleg|lower_leg|shin|calf|knee/.test(n)) return sided('lowerLeg')
  if (/leg/.test(n)) return sided('lowerLeg') // plain "leg" (e.g. Mixamo LeftLeg = shin)

  // Arms & hands.
  if (/forearm|lowerarm|lower_arm|elbow/.test(n)) return sided('lowerArm')
  if (/shoulder|clavicle|collar/.test(n)) return sided('shoulder')
  if (/hand|wrist/.test(n)) return sided('hand')
  if (/arm/.test(n)) return sided('upperArm') // after forearm/shoulder handled

  // Torso / head (usually unsided).
  if (/head/.test(n)) return 'head'
  if (/neck/.test(n)) return 'neck'
  if (/chest|upperchest|spine2|spine02|spine1|spine01/.test(n)) return 'chest'
  if (/spine|torso|abdomen/.test(n)) return 'spine'
  if (/hip|pelvis|root/.test(n)) return 'hips'

  return null
}

// First bone that falls into each slot, keyed by slot. When several bones match
// a slot (common on Rigify: control + mechanism + deform bones all say "arm"),
// prefer the deform bone — it's the one that actually skins the mesh.
function firstBySlot(names) {
  const out = {}
  for (const name of names) {
    const key = classifyBone(name)
    if (!key) continue
    if (!out[key]) out[key] = name
    else if (/^def-/i.test(name) && !/^def-/i.test(out[key])) out[key] = name
  }
  return out
}

// Build the initial slot mapping (auto-guess) between a target rig and a mocap
// skeleton: [{ key, label, target, source }].
export function buildSlotMapping(targetNames, sourceNames) {
  const t = firstBySlot(targetNames)
  const s = firstBySlot(sourceNames)
  return HUMANOID_SLOTS.map((slot) => ({
    key: slot.key,
    label: slot.label,
    target: t[slot.key] || '',
    source: s[slot.key] || '',
  }))
}

// Normalize a bone name for direct matching across conventions: drop case, the
// DEF-/mixamorig prefixes, separators, and a trailing "bb" marker (this rig's
// "_bb_" suffix). So "spine2_bb_" ~ "Spine2", "lefthandindex1_bb_" ~
// "LeftHandIndex1", "mixamorig:LeftArm" ~ "leftarm".
function normBoneName(n) {
  return n
    .toLowerCase()
    .replace(/^mixamorig:?/, '')
    .replace(/^def-/, '')
    .replace(/[ _.:-]/g, '')
    .replace(/bb$/, '')
}

// Direct name match across the whole skeleton (exact, then normalized). Catches
// every bone when the two rigs share a naming scheme — including fingers and
// multi-bone spine chains the 21 canonical slots can't represent.
export function buildNameMatch(targetBones, sourceBones) {
  const byNorm = new Map()
  for (const sb of sourceBones) {
    const k = normBoneName(sb)
    if (!byNorm.has(k)) byNorm.set(k, sb)
  }
  const names = {}
  for (const tb of targetBones) {
    if (sourceBones.includes(tb)) {
      names[tb] = tb
      continue
    }
    const m = byNorm.get(normBoneName(tb))
    if (m) names[tb] = m
  }
  return names
}

// Merge the auto name-match with the (possibly hand-edited) slot mapping into
// retargetClip's { names, hip }. Slots win for the core bones they cover: a
// filled slot sets/overrides the mapping; a slot whose mocap side was cleared
// removes it (so you can explicitly un-map a core bone).
export function mergeNames(autoNames, slots) {
  const names = { ...(autoNames || {}) }
  let hip = null
  for (const s of slots) {
    if (s.target && s.source) {
      names[s.target] = s.source
      if (s.key === 'hips') hip = s.source
    } else if (s.target && !s.source) {
      delete names[s.target]
    }
  }
  return { names, hip }
}

// Parse a BVH File into { skeleton, clip, bones, name }. No retargeting yet — the
// UI shows the mapping editor first.
export async function parseBVH(file) {
  const { BVHLoader } = await import('three/examples/jsm/loaders/BVHLoader.js')
  const text = await file.text()
  const result = new BVHLoader().parse(text)
  if (!result || !result.clip || !result.skeleton) {
    throw new Error('Could not parse this BVH file.')
  }
  return {
    skeleton: result.skeleton,
    clip: result.clip,
    bones: result.skeleton.bones.map((b) => b.name),
    name: file.name.replace(/\.bvh$/i, ''),
  }
}

// Retarget a parsed BVH onto the model using a confirmed name map. Returns
// { clip, matched, total }; the clip has plain `Bone.quaternion` tracks (plays on
// the model.root mixer), rotation-only (in-place, no root motion).
export function retargetParsed(parsed, model, names, hip, clipName) {
  const target = model.skinnedMeshes && model.skinnedMeshes[0]
  if (!target) throw new Error('This model has no skinned mesh to retarget mocap onto.')
  if (Object.keys(names).length === 0) {
    throw new Error('No bones are mapped — map at least the hips and a few limbs.')
  }

  const srcBones = parsed.skeleton.bones
  const srcByName = new Map(srcBones.map((b) => [b.name, b]))
  const tgtBones = target.skeleton.bones

  // Source rotation tracks (BVH shares one time array across channels).
  const srcTracks = []
  for (const tr of parsed.clip.tracks) {
    const m = /^(.+)\.quaternion$/.exec(tr.name)
    if (m && srcByName.has(m[1])) srcTracks.push({ bone: srcByName.get(m[1]), values: tr.values })
  }
  if (srcTracks.length === 0) throw new Error('This BVH has no rotation data.')
  const times = parsed.clip.tracks.find((t) => /\.quaternion$/.test(t.name)).times
  const numFrames = times.length

  // --- Rest world orientations ---
  // Source rest = the BVH skeleton before any motion.
  srcBones[0].updateWorldMatrix(false, true)
  const restSrcW = new Map()
  for (const b of srcBones) restSrcW.set(b, b.getWorldQuaternion(new THREE.Quaternion()))

  // Target rest = the character's bind (T-)pose.
  target.skeleton.pose()
  model.root.updateMatrixWorld(true)
  const restTgtW = new Map()
  const restTgtL = new Map()
  const parentRestW = new Map()
  for (const b of tgtBones) {
    restTgtW.set(b, b.getWorldQuaternion(new THREE.Quaternion()))
    restTgtL.set(b, b.quaternion.clone())
    parentRestW.set(b, b.parent ? b.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion())
  }

  // Process parents before children so a bone's parent world is already known.
  const depthOf = (b) => {
    let d = 0
    let n = b.parent
    while (n) {
      d++
      n = n.parent
    }
    return d
  }
  const order = [...tgtBones].sort((a, b) => depthOf(a) - depthOf(b))
  const mapped = tgtBones.filter((b) => names[b.name] && srcByName.has(names[b.name]))
  const out = new Map()
  for (const b of mapped) out.set(b, new Float32Array(numFrames * 4))

  const D = new THREE.Quaternion()
  const desired = new THREE.Quaternion()
  const scratch = new THREE.Quaternion()
  const curSrcW = new THREE.Quaternion()
  const computedW = new Map()

  for (let i = 0; i < numFrames; i++) {
    // Pose the source skeleton at this frame.
    for (const { bone, values } of srcTracks) {
      const o = i * 4
      bone.quaternion.set(values[o], values[o + 1], values[o + 2], values[o + 3])
    }
    srcBones[0].updateWorldMatrix(false, true)

    computedW.clear()
    for (const b of order) {
      const parentW = (b.parent && computedW.get(b.parent)) || parentRestW.get(b)
      let localQ
      const srcBone = srcByName.get(names[b.name])
      if (srcBone) {
        srcBone.getWorldQuaternion(curSrcW)
        // delta = curSrc * restSrc⁻¹  (world-space rotation since the mocap rest)
        D.copy(restSrcW.get(srcBone)).invert().premultiply(curSrcW)
        // desiredWorld = delta * restTargetWorld  (add the motion to the T-pose)
        desired.copy(D).multiply(restTgtW.get(b))
        // localRotation = parentWorld⁻¹ * desiredWorld
        localQ = scratch.copy(parentW).invert().multiply(desired).clone()
      } else {
        localQ = restTgtL.get(b) // unmapped bones hold their rest pose
      }
      computedW.set(b, new THREE.Quaternion().copy(parentW).multiply(localQ))

      const arr = out.get(b)
      if (arr) {
        const o = i * 4
        let { x, y, z, w } = localQ
        // Keep quaternions in the same hemisphere as the previous frame so the
        // mixer's slerp doesn't take the long way round (avoids popping).
        if (i > 0 && x * arr[o - 4] + y * arr[o - 3] + z * arr[o - 2] + w * arr[o - 1] < 0) {
          x = -x
          y = -y
          z = -z
          w = -w
        }
        arr[o] = x
        arr[o + 1] = y
        arr[o + 2] = z
        arr[o + 3] = w
      }
    }
  }

  // Leave the character back in its rest pose.
  for (const b of tgtBones) b.quaternion.copy(restTgtL.get(b))
  model.root.updateMatrixWorld(true)

  const outTimes = Array.from(times)
  const tracks = []
  for (const [b, values] of out) {
    tracks.push(new THREE.QuaternionKeyframeTrack(b.name + '.quaternion', outTimes, Array.from(values)))
  }
  const clip = new THREE.AnimationClip(clipName || parsed.name, times[numFrames - 1], tracks)
  return { clip, matched: mapped.length, total: tgtBones.length }
}
