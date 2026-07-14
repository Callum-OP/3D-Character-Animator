// ---------------------------------------------------------------------------
// BVH mocap import + retargeting (Phase 4 future-work)
//
import * as THREE from 'three'

// A BVH carries its own skeleton (hierarchy + motion) that rarely matches the
// character's rig. We RETARGET the motion onto the character.
//
// We do REST-RELATIVE retargeting: for each mapped bone we take the mocap bone's
// world-space rotation *relative to its own rest* and apply that same delta on
// top of the character bone's rest orientation (plus a rest-direction alignment
// so A-pose rigs follow T-pose mocap; see retargetParsed). This just adds the
// motion — unlike copying absolute orientation (three's SkeletonUtils), which
// snaps limbs to the mocap skeleton's axes and makes them point the wrong way.
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
// humanoid bone (fingers, twist/volume correctives, facial bones, sockets etc.
// are skipped). Order matters: more specific keywords are tested before generic
// ones. Keyword tests run on a separator-collapsed copy so "upper_arm_l",
// "UpperArm.L" and "upperarm_l_015" all read the same.
export function classifyBone(rawName) {
  const n = rawName.toLowerCase()
  const c = n.replace(/[ _.:-]/g, '') // collapsed for keyword tests
  const side = detectSide(n)
  const sided = (base) => (side ? `${base}.${side}` : null) // needs a side to place

  // Skip fingers / twist / helper bones outright.
  if (/thumb|index|middle|ring|pinky|finger|twist|palm|metacarpal/.test(n)) return null
  // Facial bones ("eye_ball" must not read as a toe), correctives, attachments.
  if (/eye|jaw|tongue|teeth|breast|cheek|brow|lip|nose|hair/.test(n)) return null
  if (/(^|_)vol(ume)?(_|$)|cloth|socket|weapon|(^|_)ik(_|$)|_end(_\d+)*$/.test(n)) return null

  // Legs & feet (before generic torso).
  if (/toe|toebase|ball/.test(c)) return sided('toe')
  if (/foot|ankle/.test(c)) return sided('foot')
  if (/upleg|upperleg|thigh/.test(c)) return sided('upperLeg')
  // A SIDED "hip" (LeftHip/RightHip) is the thigh in many BVH rigs — only the
  // unsided Hips/pelvis is the root (handled far below).
  if (side && /hip/.test(c)) return sided('upperLeg')
  if (/lowerleg|shin|calf|knee/.test(c)) return sided('lowerLeg')
  if (/leg/.test(c)) return sided('lowerLeg') // plain "leg" (e.g. Mixamo LeftLeg = shin)

  // Arms & hands.
  if (/forearm|lowerarm|elbow/.test(c)) return sided('lowerArm')
  if (/shoulder|clavicle|collar/.test(c)) return sided('shoulder')
  if (/hand|wrist/.test(c)) return sided('hand')
  if (/arm/.test(c)) return sided('upperArm') // after forearm/shoulder handled

  // Torso / head (usually unsided).
  if (/head/.test(c)) return 'head'
  if (/neck/.test(c)) return 'neck'
  if (/chest|upperchest/.test(c)) return 'chest'
  if (/spine|torso|abdomen/.test(c)) return 'spine'
  if (/hip|pelvis|root/.test(c)) return 'hips'

  return null
}

// How good a match a bone name is for a slot. Rigify DEF- (deform) bones beat
// everything; a real pelvis ("hips"/"pelvis") beats a root-ish fallback like
// "_rootJoint" or "root" — those sit at the ground/armature origin, and hip
// mocap applied there swings the whole body around the wrong pivot.
function slotQuality(key, name) {
  const def = /^def-/i.test(name) ? 2 : 0
  if (key === 'hips') return def + (/hip|pelvis/i.test(name) ? 2 : 1)
  return def + 2
}

// Best bone per slot, keyed by slot. Multi-bone spine chains are resolved by
// hierarchy order: the first spine bone fills 'spine' and (when the rig has no
// explicit chest bone) the last one fills 'chest' — Mixamo's Spine/Spine1/Spine2
// and game rigs' spine_01..spine_05 both land sensibly.
function firstBySlot(names) {
  const out = {}
  const quality = {}
  const spines = []
  for (const name of names) {
    const key = classifyBone(name)
    if (!key) continue
    if (key === 'spine') spines.push(name)
    const q = slotQuality(key, name)
    if (!(key in out) || q > quality[key]) {
      out[key] = name
      quality[key] = q
    }
  }
  const defSpines = spines.filter((s) => /^def-/i.test(s))
  const chain = defSpines.length ? defSpines : spines
  if (chain.length) {
    out.spine = chain[0] // names arrive parent-first, so [0] is the lowest
    if (!out.chest && chain.length > 1) out.chest = chain[chain.length - 1]
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

// Sketchfab's FBX→glTF pipeline appends "_0NN" uniquifying suffixes to every
// bone ("mixamorig:LeftArm_09"); strip them so those rigs still name-match.
function stripUniqueSuffix(n) {
  return n.replace(/_0\d+$/, '')
}

// Direct name match across the whole skeleton (exact, then normalized, then
// normalized with the Sketchfab suffix stripped). Catches every bone when the
// two rigs share a naming scheme — including fingers and multi-bone spine
// chains the 21 canonical slots can't represent.
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
    const m = byNorm.get(normBoneName(tb)) || byNorm.get(normBoneName(stripUniqueSuffix(tb)))
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
// { clip, matched, total }; the clip has plain `Bone.quaternion` tracks plus a
// `.position` track on the hip bone carrying the mocap's root translation
// (scaled to the character's hip height), and plays on the model.root mixer.
//
// On top of the rest-relative delta, each mapped bone gets a REST ALIGNMENT:
// the world rotation that swings its rest bone direction onto the source's
// rest bone direction. That way an A-pose character correctly follows T-pose
// mocap (without it, the A-pose arm droop is baked into every frame). A yaw
// correction from the hip's first frame keeps the character facing where its
// rest pose faces, even when the mocap data faces sideways.
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
  // Source position tracks (usually just the root) — they carry the mocap's
  // world travel, which becomes the target hip's translation.
  const srcPosTracks = []
  for (const tr of parsed.clip.tracks) {
    const m = /^(.+)\.position$/.exec(tr.name)
    if (m && srcByName.has(m[1])) srcPosTracks.push({ bone: srcByName.get(m[1]), values: tr.values })
  }
  const times = parsed.clip.tracks.find((t) => /\.quaternion$/.test(t.name)).times
  const numFrames = times.length

  // --- Rest world orientations & positions ---
  // Source rest = the BVH skeleton before any motion.
  srcBones[0].updateWorldMatrix(false, true)
  const restSrcW = new Map()
  const restSrcP = new Map()
  for (const b of srcBones) {
    restSrcW.set(b, b.getWorldQuaternion(new THREE.Quaternion()))
    restSrcP.set(b, b.getWorldPosition(new THREE.Vector3()))
  }

  // Target rest = the pose the bones are in right now (the caller restores the
  // load-time rest first). Deliberately NOT skeleton.pose(): that rebuilds the
  // bind pose from inverse bind matrices in the skinned mesh's frame, which
  // tips the whole rig over when the armature sits under transformed parent
  // nodes (Sketchfab exports wrap models in rotated/scaled groups).
  model.root.updateMatrixWorld(true)
  const restTgtW = new Map()
  const restTgtL = new Map()
  const restTgtP = new Map()
  const parentRestW = new Map()
  for (const b of tgtBones) {
    restTgtW.set(b, b.getWorldQuaternion(new THREE.Quaternion()))
    restTgtL.set(b, b.quaternion.clone())
    restTgtP.set(b, b.getWorldPosition(new THREE.Vector3()))
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
  const mappedSet = new Set(mapped)
  const out = new Map()
  for (const b of mapped) out.set(b, new Float32Array(numFrames * 4))

  // --- Rest alignment (auto T-pose) ---
  // For each mapped bone, the world rotation swinging its rest bone direction
  // (towards its nearest mapped descendant) onto the source's rest direction.
  // With it, "source at rest" makes the character MIMIC the source's rest shape
  // instead of keeping its own — so A-pose rigs follow T-pose mocap correctly.
  const align = new Map()
  {
    const tDir = new THREE.Vector3()
    const sDir = new THREE.Vector3()
    const firstMappedDescendant = (node) => {
      for (const c of node.children) {
        if (mappedSet.has(c)) return c
        const deeper = firstMappedDescendant(c)
        if (deeper) return deeper
      }
      return null
    }
    for (const b of mapped) {
      const childT = firstMappedDescendant(b)
      if (!childT) continue
      const srcBone = srcByName.get(names[b.name])
      const childS = srcByName.get(names[childT.name])
      if (!childS || childS === srcBone) continue
      tDir.copy(restTgtP.get(childT)).sub(restTgtP.get(b))
      sDir.copy(restSrcP.get(childS)).sub(restSrcP.get(srcBone))
      if (tDir.lengthSq() < 1e-10 || sDir.lengthSq() < 1e-10) continue
      align.set(b, new THREE.Quaternion().setFromUnitVectors(tDir.normalize(), sDir.normalize()))
    }
  }

  // --- Yaw correction + hip translation setup (needs the frame-0 source pose) ---
  const srcHip = hip ? srcByName.get(hip) || null : null
  const tgtHip = srcHip ? mapped.find((b) => names[b.name] === hip) || null : null
  const yawFix = new THREE.Quaternion()
  let hipScale = 1
  const srcHipStart = new THREE.Vector3()
  const hipParentInv = new THREE.Matrix4()
  if (srcHip) {
    for (const { bone, values } of srcTracks) {
      bone.quaternion.set(values[0], values[1], values[2], values[3])
    }
    for (const { bone, values } of srcPosTracks) {
      bone.position.set(values[0], values[1], values[2])
    }
    srcBones[0].updateWorldMatrix(false, true)
    // How much the hips have yawed away from the mocap rest at frame 0 — undo
    // it so the character starts out facing wherever its rest pose faces.
    const d0 = restSrcW.get(srcHip).clone().invert().premultiply(srcHip.getWorldQuaternion(new THREE.Quaternion()))
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(d0)
    if (Math.abs(fwd.y) < 0.9) {
      // (skip when frame 0 has the body pitched vertical — yaw is meaningless)
      yawFix.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(fwd.x, fwd.z))
    }
    if (tgtHip) {
      srcHip.getWorldPosition(srcHipStart)
      const tgtY = restTgtP.get(tgtHip).y
      hipScale = srcHipStart.y > 1e-4 && tgtY > 1e-4 ? tgtY / srcHipStart.y : 1
      if (tgtHip.parent) hipParentInv.copy(tgtHip.parent.matrixWorld).invert()
    }
  }
  const hipPos = tgtHip ? new Float32Array(numFrames * 3) : null

  const D = new THREE.Quaternion()
  const desired = new THREE.Quaternion()
  const scratch = new THREE.Quaternion()
  const curSrcW = new THREE.Quaternion()
  const computedW = new Map()
  const hipW = new THREE.Vector3()

  for (let i = 0; i < numFrames; i++) {
    // Pose the source skeleton at this frame.
    for (const { bone, values } of srcTracks) {
      const o = i * 4
      bone.quaternion.set(values[o], values[o + 1], values[o + 2], values[o + 3])
    }
    for (const { bone, values } of srcPosTracks) {
      const o = i * 3
      bone.position.set(values[o], values[o + 1], values[o + 2])
    }
    srcBones[0].updateWorldMatrix(false, true)

    // Hip translation: source hip movement since frame 0, scaled to the
    // character's hip height, yaw-corrected, re-anchored on the target hip's
    // rest position, then expressed in the hip's parent space.
    if (hipPos) {
      srcHip.getWorldPosition(hipW).sub(srcHipStart).multiplyScalar(hipScale).applyQuaternion(yawFix)
      hipW.add(restTgtP.get(tgtHip)).applyMatrix4(hipParentInv)
      const o = i * 3
      hipPos[o] = hipW.x
      hipPos[o + 1] = hipW.y
      hipPos[o + 2] = hipW.z
    }

    computedW.clear()
    for (const b of order) {
      const parentW = (b.parent && computedW.get(b.parent)) || parentRestW.get(b)
      let localQ
      const srcBone = srcByName.get(names[b.name])
      if (srcBone) {
        srcBone.getWorldQuaternion(curSrcW)
        // delta = curSrc * restSrc⁻¹  (world-space rotation since the mocap rest)
        D.copy(restSrcW.get(srcBone)).invert().premultiply(curSrcW)
        // desiredWorld = yawFix * delta * align * restTargetWorld
        desired.copy(yawFix).multiply(D)
        const A = align.get(b)
        if (A) desired.multiply(A)
        desired.multiply(restTgtW.get(b))
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
  if (hipPos) {
    tracks.push(new THREE.VectorKeyframeTrack(tgtHip.name + '.position', outTimes, Array.from(hipPos)))
  }
  const clip = new THREE.AnimationClip(clipName || parsed.name, times[numFrames - 1], tracks)
  return { clip, matched: mapped.length, total: tgtBones.length }
}
