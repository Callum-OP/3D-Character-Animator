import * as THREE from 'three'
import { fingerInfo, fingerNameOf } from './fingers.js'
import { isHandBone, analyseHands, handSegments } from './handPose.js'

// ---------------------------------------------------------------------------
// Stick-figure thumbnails for the Pose Library cards.
//
// A thumbnail is a handful of line segments { segs: [[x1, y1, x2, y2], ...] } scaled into a 0..100 box (y up), cheap
// to store with a saved pose and cheap to draw as SVG. They are made from bone positions, so a preset BVH needs no
// character loaded to get one, and a saved pose gets one from the character it was saved from.
// ---------------------------------------------------------------------------

const BOX = 100
const PAD = 8

// Scale 2D segments to fit the box, keeping their shape.
export function normalizeSegments(segs2d) {
  if (!segs2d.length) return { segs: [] }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x1, y1, x2, y2] of segs2d) {
    minX = Math.min(minX, x1, x2)
    maxX = Math.max(maxX, x1, x2)
    minY = Math.min(minY, y1, y2)
    maxY = Math.max(maxY, y1, y2)
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6)
  const scale = (BOX - 2 * PAD) / span
  const offX = (BOX - (maxX - minX) * scale) / 2 - minX * scale
  const offY = (BOX - (maxY - minY) * scale) / 2 - minY * scale
  const r = (n) => Math.round(n * 10) / 10
  return {
    segs: segs2d.map(([x1, y1, x2, y2]) => [r(x1 * scale + offX), r(y1 * scale + offY), r(x2 * scale + offX), r(y2 * scale + offY)]),
  }
}

// Whether a bone belongs in a body stick figure (no fingers, no tip helpers).
function isBodyBone(bone) {
  if (!bone || !bone.isBone) return false
  if (fingerNameOf(bone.name) !== null && fingerInfo(bone, isHandBone)) return false
  return !/(_end|\.end|_nub|nub$|leaf|tip)\d*$/i.test(bone.name)
}

const YAW = (35 * Math.PI) / 180 // turn the figure a little so depth shows

// Parent -> child lines of the bones as they are posed right now (their world matrices must be current).
export function bodySegments(bones) {
  const keep = new Set(bones.filter(isBodyBone))
  const world = new Map()
  const at = (b) => {
    if (!world.has(b)) world.set(b, b.getWorldPosition(new THREE.Vector3()))
    return world.get(b)
  }
  const cos = Math.cos(YAW)
  const sin = Math.sin(YAW)
  const flat = (v) => [v.x * cos + v.z * sin, v.y]
  const segs = []
  for (const bone of keep) {
    const parent = bone.parent
    if (parent && keep.has(parent)) segs.push([...flat(at(parent)), ...flat(at(bone))])
  }
  return segs
}

export function bodyThumb(bones) {
  return normalizeSegments(bodySegments(bones))
}

// Thumbnail of the first hand found on a character's bones (as they are posed right now).
export function handThumbFromBones(bones, restQuatOf, side = null) {
  const rigs = analyseHands(bones, restQuatOf)
  const rig = (side && rigs.find((r) => r.side === side)) || rigs[0]
  return rig ? normalizeSegments(handSegments(rig)) : { segs: [] }
}

// Put a parsed BVH (BVHLoader's result) into the pose of its frame 0 so its bones can be read.
export function poseParsedBVH(parsed) {
  for (const tr of parsed.clip.tracks) {
    const m = /^(.+)\.quaternion$/.exec(tr.name)
    const bone = m && parsed.skeleton.bones.find((b) => b.name === m[1])
    if (bone) bone.quaternion.set(tr.values[0], tr.values[1], tr.values[2], tr.values[3])
    const p = /^(.+)\.position$/.exec(tr.name)
    const moved = p && parsed.skeleton.bones.find((b) => b.name === p[1])
    if (moved) moved.position.set(tr.values[0], tr.values[1], tr.values[2])
  }
  parsed.skeleton.bones[0].updateWorldMatrix(false, true)
  return parsed.skeleton.bones
}

// Thumbnail of a one-frame parsed BVH: 'hand' shows the first hand, anything else the whole body.
export function thumbFromParsedBVH(parsed, kind) {
  const identity = new THREE.Quaternion()
  // measure hands against the file's own rest (every joint unrotated) BEFORE posing the bones
  if (kind === 'hand') {
    const rigs = analyseHands(parsed.skeleton.bones, () => identity)
    const bones = poseParsedBVH(parsed)
    const rig = rigs.find((r) => r.side === 'R') || rigs[0]
    return rig ? normalizeSegments(handSegments(rig)) : { segs: [] }
  }
  return bodyThumb(poseParsedBVH(parsed))
}
