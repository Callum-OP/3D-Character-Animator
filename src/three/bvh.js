// ---------------------------------------------------------------------------
// BVH mocap import + retargeting (Phase 4 future-work, now implemented)
//
// A BVH file carries its OWN skeleton (joint hierarchy + motion), which almost
// never matches the character's rig — bone names, rest orientations and
// proportions differ. So we don't apply the motion directly; we RETARGET it:
// SkeletonUtils.retargetClip samples the BVH motion frame by frame and, for each
// frame, orients the character's bones to match the mocap skeleton's world-space
// rotations, producing a new AnimationClip in the CHARACTER'S space.
//
// BVHLoader + SkeletonUtils are code-split (dynamic import) so they only load
// when the user actually imports mocap.
// ---------------------------------------------------------------------------

// Normalize a bone name so rigs with different conventions still match:
// case-insensitive, and stripping the common DEF-/mixamorig prefixes and
// separators (Rigify "DEF-upper_arm.L" ~ "upperarml", Mixamo "mixamorig:LeftArm"
// ~ "leftarm").
function normBoneName(n) {
  return n
    .toLowerCase()
    .replace(/^def-/, '')
    .replace(/^mixamorig:?/, '')
    .replace(/[ _.:-]/g, '')
}

// Build the target-bone -> source-bone name map retargetClip expects. Exact name
// matches win; otherwise fall back to the normalized comparison.
function buildNameMap(targetBones, sourceBones) {
  const byNorm = new Map()
  for (const sb of sourceBones) {
    const k = normBoneName(sb.name)
    if (!byNorm.has(k)) byNorm.set(k, sb.name)
  }
  const names = {}
  let matched = 0
  for (const tb of targetBones) {
    const exact = sourceBones.find((sb) => sb.name === tb.name)
    if (exact) {
      names[tb.name] = exact.name
      matched++
      continue
    }
    const m = byNorm.get(normBoneName(tb.name))
    if (m) {
      names[tb.name] = m
      matched++
    }
  }
  return { names, matched }
}

// Parse a BVH File and retarget its motion onto the loaded model. Returns
// { clip, matched, total } — clip is in the character's space with plain
// `BoneName.quaternion` track names (plays on the model.root mixer).
export async function loadBVHClip(file, model) {
  const target = model.skinnedMeshes && model.skinnedMeshes[0]
  if (!target) throw new Error('This model has no skinned mesh to retarget mocap onto.')

  const [{ BVHLoader }, { retargetClip }] = await Promise.all([
    import('three/examples/jsm/loaders/BVHLoader.js'),
    import('three/examples/jsm/utils/SkeletonUtils.js'),
  ])

  const text = await file.text()
  const result = new BVHLoader().parse(text) // { skeleton, clip }
  if (!result || !result.clip || !result.skeleton) {
    throw new Error('Could not parse this BVH file.')
  }

  target.updateMatrixWorld(true)
  const { names, matched } = buildNameMap(target.skeleton.bones, result.skeleton.bones)
  if (matched === 0) {
    throw new Error(
      'No bones matched between the mocap skeleton and this rig — their bone names are too different to retarget automatically.',
    )
  }

  // hip = the mocap skeleton's root bone (retargetClip handles it specially).
  const hip = result.skeleton.bones[0] && result.skeleton.bones[0].name

  const clip = retargetClip(target, result.skeleton, result.clip, {
    names,
    hip,
    useFirstFramePosition: true, // zero out the starting hip offset (less drift)
  })

  // Rewrite '.bones[X].quaternion' -> 'X.quaternion' so this clip binds on the
  // model.root mixer like baked/in-app clips, and drop position tracks so the
  // character animates in place (BVH world units would otherwise fling the hip
  // around at the wrong scale).
  clip.tracks = clip.tracks
    .filter((t) => t.name.endsWith('.quaternion'))
    .map((t) => {
      t.name = t.name.replace(/^\.bones\[(.+?)\]\./, '$1.')
      return t
    })

  // retargetClip leaves the character at the last sampled frame — reset to rest.
  target.skeleton.pose()

  clip.name = file.name.replace(/\.bvh$/i, '')
  return { clip, matched, total: target.skeleton.bones.length }
}
