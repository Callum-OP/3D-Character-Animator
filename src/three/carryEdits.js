import * as THREE from 'three'

// "Carry edits forward" for pose keyframes.
//
// Keying a bone at a time normally just writes that one key. With carrying on, the key also records how far the
// bone MOVED from what the animation already had at that time (its own keys, blended), and applies that same move to
// every later key of the same bone. Later frames keep their own animation and simply gain the same adjustment, as if
// the bone had been nudged by that amount in each one: spread the legs apart once and they are further apart in
// every later frame, without flattening the walk.
//
// The move is a rotation in the bone's PARENT space (newPose * oldPose^-1), applied to the left of each later key.
// That means it is the same turn relative to the body whatever the limb itself is doing, and because a rotation on the
// left commutes with slerp, the frames BETWEEN later keys come out as the original animation plus the same turn too.
//
// Bones that only differ by float noise (a whole-pose key captures every bone) are left alone.

export const CARRY_MIN_ANGLE = 0.005 // radians, about 0.3 degrees
export const CARRY_MIN_MOVE = 1e-4 // position units

const TIME_EPS = 1e-6

const toQuat = (array) => new THREE.Quaternion(array[0], array[1], array[2], array[3])
const toArray = (q) => [q.x, q.y, q.z, q.w]

function sortedKeys(keys) {
  return [...(keys || [])].sort((a, b) => a.time - b.time)
}

// Blend between the two keys either side of `time` (slerp / lerp, as playback does), holding the first and last key
// beyond the ends. Resolves with { quat, pos } (pos is null when no key has one), or null when there are no keys.
export function sampleBoneKeys(keys, time) {
  const sorted = sortedKeys(keys)
  if (!sorted.length) return null
  const find = (list) => {
    if (!list.length) return null
    if (time <= list[0].time) return { a: list[0], b: list[0], f: 0 }
    const last = list[list.length - 1]
    if (time >= last.time) return { a: last, b: last, f: 0 }
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i]
      const b = list[i + 1]
      if (time >= a.time && time <= b.time) return { a, b, f: b.time > a.time ? (time - a.time) / (b.time - a.time) : 0 }
    }
    return { a: last, b: last, f: 0 }
  }
  const rot = find(sorted)
  const quat = toArray(toQuat(rot.a.quat).slerp(toQuat(rot.b.quat), rot.f))
  const withPos = find(sorted.filter((k) => k.pos))
  const pos = withPos ? [0, 1, 2].map((i) => withPos.a.pos[i] + (withPos.b.pos[i] - withPos.a.pos[i]) * withPos.f) : null
  return { quat, pos }
}

// The keys for one bone after keying it at `time`. `quat` / `pos` are the bone's new values. Without `carry` this is
// plain insert-or-replace. With it, every later key also takes the same change the bone just got.
export function keyBone(existing, time, quat, pos, carry = false) {
  const others = (existing || []).filter((k) => k.time !== time)
  const previousPos = (existing || []).find((k) => k.time === time)?.pos
  let keys = others
  if (carry && others.length) {
    const before = sampleBoneKeys(existing, time)
    if (before) keys = carryKeysAfter(others, time, before, quat, pos)
  }
  const key = { time, quat }
  if (pos || previousPos) key.pos = pos || previousPos
  return [...keys, key].sort((a, b) => a.time - b.time)
}

// Apply the change from `before` ({ quat, pos } as the animation stood) to the new values onto every key after `time`.
function carryKeysAfter(keys, time, before, quat, pos) {
  const turn = toQuat(quat).multiply(toQuat(before.quat).invert()).normalize()
  const turnAngle = 2 * Math.acos(Math.min(1, Math.abs(turn.w)))
  const turnBy = turnAngle > CARRY_MIN_ANGLE
  const move = pos && before.pos ? [0, 1, 2].map((i) => pos[i] - before.pos[i]) : null
  const moveBy = move && Math.hypot(move[0], move[1], move[2]) > CARRY_MIN_MOVE
  if (!turnBy && !moveBy) return keys

  let previous = toQuat(quat)
  return sortedKeys(keys).map((key) => {
    if (key.time <= time + TIME_EPS) return key
    const next = { ...key }
    if (turnBy) {
      const q = turn.clone().multiply(toQuat(key.quat)).normalize()
      // Keep neighbouring keys in the same hemisphere so blending between them still takes the short way.
      if (q.dot(previous) < 0) q.set(-q.x, -q.y, -q.z, -q.w)
      previous = q
      next.quat = toArray(q)
    }
    if (moveBy && key.pos) next.pos = [key.pos[0] + move[0], key.pos[1] + move[1], key.pos[2] + move[2]]
    return next
  })
}

// ---- Resizing objects and parts ---------------------------------------------------------------------------------
//
// Keying a new size carries forward as a ratio: if the object was 1.0 here and you made it 1.5, every later key's size
// is multiplied by 1.5 (per axis), so later sizes keep their own animation and all grow by the same factor.

export const CARRY_MIN_SCALE_CHANGE = 1e-4

// The size an object's keys give at `time` (linear between the two keys either side, held beyond the ends).
export function sampleScaleKeys(keys, time) {
  const sorted = sortedKeys((keys || []).filter((k) => k.scale))
  if (!sorted.length) return null
  if (time <= sorted[0].time) return [...sorted[0].scale]
  const last = sorted[sorted.length - 1]
  if (time >= last.time) return [...last.scale]
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (time >= a.time && time <= b.time) {
      const f = b.time > a.time ? (time - a.time) / (b.time - a.time) : 0
      return [0, 1, 2].map((axis) => a.scale[axis] + (b.scale[axis] - a.scale[axis]) * f)
    }
  }
  return [...last.scale]
}

// The keys for an object or part after keying `key` ({ ...transform, scale }) at `time`. With `carry`, a change of
// size also scales every later key by the same factor.
export function keyTransform(existing, time, key, carry = false) {
  const others = (existing || []).filter((k) => k.time !== time)
  let keys = others
  if (carry && others.length && key.scale) {
    const before = sampleScaleKeys(existing, time)
    if (before) {
      const ratio = [0, 1, 2].map((axis) => (Math.abs(before[axis]) > 1e-9 ? key.scale[axis] / before[axis] : 1))
      if (ratio.some((r) => Math.abs(r - 1) > CARRY_MIN_SCALE_CHANGE)) {
        keys = others.map((k) =>
          k.time > time + TIME_EPS && k.scale ? { ...k, scale: k.scale.map((value, axis) => value * ratio[axis]) } : k,
        )
      }
    }
  }
  return [...keys, { time, ...key }].sort((a, b) => a.time - b.time)
}
