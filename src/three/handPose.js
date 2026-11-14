import * as THREE from 'three'
import { classifyBone, detectSide } from './bvh.js'
import { fingerInfo, fingerNameOf, looksLikeHand } from './fingers.js'

// ---------------------------------------------------------------------------
// Hand poses that work on ANY rig
//
// A pose is stored per finger bone as a rotation measured in the hand's PALM FRAME instead of in the
// bone's own (rig-specific) local axes:
//
//   y = the way the fingers point        x = across the palm (pinky -> thumb on a right hand, the
//   z = out of the palm (x cross y)          mirror of that on a left hand, so both hands share one frame)
//
// The frame is worked out from the rig's REST pose geometry (where the finger bones sit), so it does not
// matter how a model orients its bone axes. Curling a finger is "rotate about x", fanning is "rotate about
// z", and the same stored pose gives the same gesture on a different model, or on the other hand.
//
// Each stored rotation is a DELTA from the bone's own rest rotation, one per finger segment:
//   { format: 'hand-v1', fingers: { thumb: [[x,y,z,w], ...], index: [...], ... } }
//
// Poses are stored in the RIGHT hand's frame (stored hand poses carry frame: 2; see migrateHandPose). A left hand's palm frame is a mirror image of it, so a pose
// moving between hands has its y and z parts negated (curling is unchanged, fanning and twisting reverse) -
// see mirrorQ(). Callers never do this themselves: capture and apply both handle it.
//
// A pose is turned into real bone rotations with handPoseToBoneQuats(). A bone's own local axes are only
// used at that very last step: newLocal = restLocal * (C * q * C^-1), C = restWorld(bone)^-1 * paletteFrame.
// ---------------------------------------------------------------------------

export const HAND_POSE_FORMAT = 'hand-v1'
export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky']
const FLAT_FINGERS = ['index', 'middle', 'ring', 'pinky']

const META_RE = /meta|palm/i
const IDENTITY = new THREE.Quaternion()

// How far each segment bends at a full fist, in degrees, by number of segments in the chain.
const FIST_DEG = {
  finger: { 1: [90], 2: [90, 100], 3: [80, 100, 70] },
  thumb: { 1: [60], 2: [45, 65], 3: [35, 50, 65] },
}
// How far each finger fans out for spread = 1 (degrees about the palm normal; + turns toward the thumb side).
const FAN_DEG = { index: 14, middle: 4, ring: -6, pinky: -16 }

export function isHandBone(bone) {
  return !!bone && ((classifyBone(bone.name) || '').startsWith('hand') || looksLikeHand(bone))
}

function isPalmOnly(bone) {
  return META_RE.test(bone.name)
}

function nextFingerBone(bone, finger) {
  return (bone.children || []).find(
    (c) => c.isBone && fingerNameOf(c.name) === finger && !isPalmOnly(c) && fingerInfo(c, isHandBone)?.tip !== true,
  )
}

// Every hand on a skeleton that has finger bones:
//   [{ hand: Bone, side: 'L' | 'R' | '', fingers: { thumb: [Bone, ...], ... } }]
// Chains run from the knuckle outward and stop at three bones (the joints that bend); helper tip markers and
// metacarpal / palm bones are left out. `bones` is any list of Bone objects (a model's or a parsed BVH's).
export function findHandRigs(bones) {
  const hands = new Map()
  for (const bone of bones || []) {
    if (!bone || !bone.isBone) continue
    const info = fingerInfo(bone, isHandBone)
    if (!info || info.tip || isPalmOnly(bone)) continue
    const parent = bone.parent
    // only start a chain at the bone nearest the hand
    if (parent && parent.isBone && fingerNameOf(parent.name) === info.finger && !isPalmOnly(parent)) continue
    const chain = [bone]
    while (chain.length < 3) {
      const next = nextFingerBone(chain[chain.length - 1], info.finger)
      if (!next) break
      chain.push(next)
    }
    let hand = parent
    while (hand && !(hand.isBone && isHandBone(hand) && fingerNameOf(hand.name) === null)) hand = hand.parent
    if (!hand || !hand.isBone) hand = parent && parent.isBone ? parent : null
    if (!hand) continue
    let rig = hands.get(hand)
    if (!rig) {
      rig = { hand, side: '', fingers: {} }
      hands.set(hand, rig)
    }
    if (!rig.fingers[info.finger]) rig.fingers[info.finger] = chain
  }
  const rigs = [...hands.values()].filter((rig) => usableFingerCount(rig) >= 2)
  assignSides(rigs)
  return rigs
}

function usableFingerCount(rig) {
  return FLAT_FINGERS.filter((f) => rig.fingers[f]?.length).length
}

function assignSides(rigs) {
  for (const rig of rigs) {
    let side = detectSide(rig.hand.name.toLowerCase())
    if (!side) {
      for (const chain of Object.values(rig.fingers)) {
        side = detectSide(chain[0].name.toLowerCase())
        if (side) break
      }
    }
    rig.side = side
  }
  const unsided = rigs.filter((r) => !r.side)
  if (!unsided.length) return
  // No L/R in the names: the character's left is +X when it faces +Z, so the hand further along +X is the left one.
  const xs = (rig) => rig.hand.getWorldPosition(new THREE.Vector3()).x
  if (unsided.length >= 2) {
    const sorted = [...unsided].sort((a, b) => xs(b) - xs(a))
    sorted[0].side = 'L'
    sorted[sorted.length - 1].side = 'R'
  } else {
    let root = unsided[0].hand
    while (root.parent && root.parent.isBone) root = root.parent
    const rootX = root.getWorldPosition(new THREE.Vector3()).x
    unsided[0].side = xs(unsided[0]) >= rootX ? 'L' : 'R'
  }
}

// Work out the rig's palm frame and per-bone conversion from its rest pose. `restQuatOf(bone)` returns the
// bone's rest rotation (or null to leave it as it is). The hand's bones are put at rest, measured, and put
// back exactly as they were. Returns false when the geometry can't give a palm frame.
export function computeHandFrame(rig, restQuatOf) {
  const subtree = []
  rig.hand.traverse((o) => {
    if (o.isBone) subtree.push(o)
  })
  const saved = subtree.map((b) => b.quaternion.clone())
  try {
    for (const b of subtree) {
      const r = restQuatOf(b)
      if (r) b.quaternion.copy(r)
    }
    rig.hand.updateWorldMatrix(true, true)
    return measureFrame(rig, restQuatOf)
  } finally {
    subtree.forEach((b, i) => b.quaternion.copy(saved[i]))
    rig.hand.updateWorldMatrix(false, true)
  }
}

function measureFrame(rig, restQuatOf) {
  const pos = (b) => b.getWorldPosition(new THREE.Vector3())
  const present = FLAT_FINGERS.filter((f) => rig.fingers[f]?.length)
  if (present.length < 2) return false
  const handPos = pos(rig.hand)

  const across = pos(rig.fingers[present[present.length - 1]][0]).sub(pos(rig.fingers[present[0]][0]))
  const along = new THREE.Vector3()
  for (const f of present) {
    const chain = rig.fingers[f]
    const from = pos(chain[0])
    const to = chain.length > 1 ? pos(chain[chain.length - 1]) : pos(chain[0]).sub(handPos).add(from)
    along.add(to.sub(from).normalize())
  }
  if (along.lengthSq() < 1e-12 || across.lengthSq() < 1e-12) return false
  const y = along.normalize()
  const ax = across.addScaledVector(y, -across.dot(y))
  if (ax.lengthSq() < 1e-12) return false
  ax.normalize()
  // Palm normal = fingers x (thumb->pinky) on a right hand, the reverse on a left hand; with x = y cross z that
  // makes x run thumb->pinky on a LEFT hand and pinky->thumb on a right one.
  const x = rig.side === 'L' ? ax : ax.clone().negate()
  const z = new THREE.Vector3().crossVectors(x, y).normalize()
  const frameW = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z))
  const frameInv = frameW.clone().invert()

  const handW = rig.hand.getWorldQuaternion(new THREE.Quaternion())
  const frame = {
    world: frameW,
    handLocal: handW.clone().invert().multiply(frameW), // palm frame in the hand bone's own axes
    bones: new Map(),
    curlAxis: new Map(),
  }
  for (const chain of Object.values(rig.fingers)) {
    for (const bone of chain) {
      const w = bone.getWorldQuaternion(new THREE.Quaternion())
      frame.bones.set(bone, {
        C: w.clone().invert().multiply(frameW),
        restLocal: (restQuatOf(bone) || bone.quaternion).clone(),
      })
    }
  }
  // Curl axis per bone, in palm coordinates: bends the bone toward the palm (toward the palm and across it for the thumb).
  // (the pinky side is +x on a left hand and -x on a right hand)
  const thumbAcross = isLeft(rig) ? 0.6 : -0.6
  const toward = (finger) =>
    finger === 'thumb' ? new THREE.Vector3(thumbAcross, 0, 1).normalize() : new THREE.Vector3(0, 0, 1)
  for (const [finger, chain] of Object.entries(rig.fingers)) {
    chain.forEach((bone, i) => {
      const next = chain[i + 1] || (bone.children || []).find((c) => c.isBone)
      let t
      if (next) t = pos(next).sub(pos(bone))
      else t = pos(bone).sub(i > 0 ? pos(chain[i - 1]) : handPos)
      t.applyQuaternion(frameInv)
      let axis = t.clone().cross(toward(finger))
      if (axis.lengthSq() < 1e-8) axis = new THREE.Vector3(1, 0, 0)
      frame.curlAxis.set(bone, axis.normalize())
    })
  }
  rig.frame = frame
  return true
}

// Find every hand on `bones` and measure its palm frame against the rig's rest pose. Hands whose geometry
// gives no palm frame (fewer than two non-thumb fingers) are dropped.
export function analyseHands(bones, restQuatOf) {
  const rigs = findHandRigs(bones)
  return rigs.filter((rig) => computeHandFrame(rig, restQuatOf))
}

// ---- Reading and writing poses -------------------------------------------------------------------------

const toArr = (q) => [q.x, q.y, q.z, q.w]

// Left hands use the mirror image of the right hand's frame (see the top of this file).
const isLeft = (rig) => rig.side === 'L'
const mirrorQ = (q) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w)

// Measure the hand's current pose. `quatOf(bone)` returns the bone's current local rotation.
export function captureHandPose(rig, quatOf = (b) => b.quaternion) {
  const fingers = {}
  for (const [finger, chain] of Object.entries(rig.fingers)) {
    fingers[finger] = chain.map((bone) => {
      const { C, restLocal } = rig.frame.bones.get(bone)
      const dLocal = restLocal.clone().invert().multiply(quatOf(bone))
      const q = C.clone().invert().multiply(dLocal).multiply(C)
      const canonical = isLeft(rig) ? mirrorQ(q) : q
      if (canonical.w < 0) canonical.set(-canonical.x, -canonical.y, -canonical.z, -canonical.w)
      return toArr(canonical.normalize())
    })
  }
  return { format: HAND_POSE_FORMAT, frame: 2, fingers }
}

export function validateHandPose(json) {
  if (!json || json.format !== HAND_POSE_FORMAT || !json.fingers || typeof json.fingers !== 'object') {
    throw new Error(`Not a valid hand pose (expected format "${HAND_POSE_FORMAT}").`)
  }
}

function resample(segs, count) {
  if (segs.length === count) return segs
  if (count === 1) return [segs[Math.min(1, segs.length - 1)]]
  return Array.from({ length: count }, (_, i) => segs[Math.round((i * (segs.length - 1)) / (count - 1))])
}

// Turn a hand pose into local bone rotations on this rig: { boneName: [x, y, z, w] }.
// `amount` scales the whole pose from rest (0) to the pose (1), or beyond; give an object to set it per finger.
export function handPoseToBoneQuats(rig, pose, amount = 1) {
  validateHandPose(pose)
  const out = {}
  for (const [finger, chain] of Object.entries(rig.fingers)) {
    const stored = pose.fingers[finger]
    if (!stored || !stored.length) continue
    const amt = typeof amount === 'number' ? amount : amount?.[finger] ?? 1
    const segs = resample(stored, chain.length)
    chain.forEach((bone, i) => {
      const { C, restLocal } = rig.frame.bones.get(bone)
      let stored = new THREE.Quaternion(...segs[i])
      if (isLeft(rig)) stored = mirrorQ(stored)
      const qp = IDENTITY.clone().slerp(stored, amt)
      const dLocal = C.clone().multiply(qp).multiply(C.clone().invert())
      out[bone.name] = toArr(restLocal.clone().multiply(dLocal).normalize())
    })
  }
  return out
}

// ---- Built-in poses (made for the rig they are applied to) ---------------------------------------------

// curl: 0 (straight) .. 1 (full fist) per finger; spread: 0 .. 1 fans the four fingers apart.
// Returned like any stored pose (in the right hand's frame), so it can be applied to either hand.
export function analyticHandPose(rig, { curl = {}, spread = 0 } = {}) {
  const fingers = {}
  for (const [finger, chain] of Object.entries(rig.fingers)) {
    const amount = typeof curl === 'number' ? curl : curl[finger] ?? 0
    const table = (finger === 'thumb' ? FIST_DEG.thumb : FIST_DEG.finger)[Math.min(chain.length, 3)]
    fingers[finger] = chain.map((bone, i) => {
      const axis = rig.frame.curlAxis.get(bone)
      const q = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad((table[i] || 0) * amount))
      if (i === 0 && finger !== 'thumb' && spread) {
        const fan = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 0, 1),
          THREE.MathUtils.degToRad((FAN_DEG[finger] || 0) * spread * (isLeft(rig) ? 1 : -1)),
        )
        q.premultiply(fan)
      }
      return toArr(isLeft(rig) ? mirrorQ(q) : q)
    })
  }
  return { format: HAND_POSE_FORMAT, frame: 2, fingers }
}

// The named basics shown at the top of the Hand tab.
export const BASIC_HANDS = [
  { id: 'open', name: 'Open hand', curl: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 }, spread: 0 },
  { id: 'spread', name: 'Spread fingers', curl: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 }, spread: 1 },
  { id: 'relaxed', name: 'Relaxed', curl: { thumb: 0.15, index: 0.22, middle: 0.28, ring: 0.33, pinky: 0.38 }, spread: 0 },
  { id: 'fist', name: 'Fist', curl: { thumb: 1, index: 1, middle: 1, ring: 1, pinky: 1 }, spread: 0 },
  { id: 'point', name: 'Point', curl: { thumb: 0.8, index: 0, middle: 1, ring: 1, pinky: 1 }, spread: 0 },
  { id: 'thumbs-up', name: 'Thumbs up', curl: { thumb: 0, index: 1, middle: 1, ring: 1, pinky: 1 }, spread: 0 },
  { id: 'peace', name: 'Peace', curl: { thumb: 1, index: 0, middle: 0, ring: 1, pinky: 1 }, spread: 0.8 },
]

// ---- Sorting out which hand to act on ------------------------------------------------------------------

// Pick the rigs a "Left / Right / Both" choice means.
export function rigsForSide(rigs, side) {
  if (side === 'both') return rigs
  return rigs.filter((r) => r.side === side)
}

// Which pose to give a rig out of a stored { L, R } pair: its own side if stored, else the other (mirrored for free).
export function poseForRig(poses, rig) {
  return (rig.side && poses[rig.side]) || poses.R || poses.L || null
}

// ---- Poses out of a parsed BVH -------------------------------------------------------------------------

// Read the hand poses in the first frame of a parsed BVH ({ skeleton, clip }): { L?: pose, R?: pose }.
// A BVH's rest is the skeleton as written (every joint unrotated), so the first frame's rotations ARE the deltas.
export function handPosesFromBVH(parsed) {
  const bones = parsed.skeleton.bones
  const rigs = analyseHands(bones, () => IDENTITY)
  const first = new Map()
  for (const tr of parsed.clip.tracks) {
    const m = /^(.+)\.quaternion$/.exec(tr.name)
    if (m) first.set(m[1], new THREE.Quaternion(tr.values[0], tr.values[1], tr.values[2], tr.values[3]))
  }
  const out = {}
  for (const rig of rigs) {
    const side = rig.side === 'L' || rig.side === 'R' ? rig.side : 'R'
    out[side] = captureHandPose(rig, (b) => first.get(b.name) || IDENTITY)
  }
  return out
}

// ---- Stick figure of a posed hand ----------------------------------------------------------------------

// 2D line segments [[x1, y1, x2, y2], ...] (y up) of the rig's fingers as they are posed right now, seen from the
// palm side with a little tilt so a curled finger reads as curled. Bones must have up-to-date world matrices.
export function handSegments(rig) {
  const handPos = rig.hand.getWorldPosition(new THREE.Vector3())
  const frameNow = rig.hand.getWorldQuaternion(new THREE.Quaternion()).multiply(rig.frame.handLocal)
  const inv = frameNow.clone().invert()
  const flat = (v) => {
    const p = v.clone().sub(handPos).applyQuaternion(inv)
    return [p.x + 0.55 * p.z, p.y + 0.3 * p.z]
  }
  const segs = []
  const link = (a, b) => segs.push([...flat(a), ...flat(b)])
  for (const chain of Object.values(rig.fingers)) {
    const pts = chain.map((b) => b.getWorldPosition(new THREE.Vector3()))
    const last = chain[chain.length - 1]
    const tipBone = (last.children || []).find((c) => c.isBone)
    if (tipBone) pts.push(tipBone.getWorldPosition(new THREE.Vector3()))
    else if (pts.length > 1) pts.push(pts[pts.length - 1].clone().add(pts[pts.length - 1].clone().sub(pts[pts.length - 2])))
    link(handPos, pts[0])
    for (let i = 0; i + 1 < pts.length; i++) link(pts[i], pts[i + 1])
  }
  return segs
}

// Hand poses saved before the palm normal was corrected (no `frame` marker) used a frame turned half way round the
// finger axis; this puts one into the current frame. Poses that already carry frame: 2 come back unchanged.
export function migrateHandPose(pose) {
  if (!pose || pose.frame === 2) return pose
  const fingers = {}
  for (const [f, segs] of Object.entries(pose.fingers || {})) fingers[f] = segs.map(([x, y, z, w]) => [-x, y, -z, w])
  return { ...pose, fingers, frame: 2 }
}
