import * as THREE from 'three'
import { fingerInfo, fingerNameOf } from './fingers.js'
import { isHandBone, analyseHands, handSegments } from './handPose.js'
import { classifyBone } from './bvh.js'

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
  const core = bones.filter((bone) => bone?.isBone && classifyBone(bone.name))
  const keep = new Set(core.length >= 2 ? core : bones.filter(isBodyBone))
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
    let parent = bone.parent
    while (parent && !keep.has(parent)) parent = parent.parent
    if (parent) segs.push([...flat(at(parent)), ...flat(at(bone))])
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

export function basicHandThumb({ curl = {}, spread = 0 } = {}) {
  const fingers = [
    ['thumb', 18, 46, -0.16],
    ['index', 36, 70, -0.18],
    ['middle', 50, 78, 0],
    ['ring', 64, 72, 0.16],
    ['pinky', 78, 62, 0.28],
  ]
  const segs = []
  for (const [name, x, straightY, tilt] of fingers) {
    const amount = typeof curl === 'number' ? curl : curl[name] ?? 0
    const fan = (x - 50) * spread * 0.52
    const baseX = x + fan
    const length = straightY * (1 - amount * 0.58)
    const endX = baseX + tilt * 16 * amount
    const endY = 92 - length
    segs.push([50, 92, baseX, 92 - length * 0.48])
    segs.push([baseX, 92 - length * 0.48, endX, endY])
  }
  segs.push([50, 92, 50, 72])
  return normalizeSegments(segs)
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

function quaternionTracks(clip) {
  return (clip?.tracks || []).filter((track) => track.name.endsWith('.quaternion') && track.times.length > 1)
}

// Pick the frame furthest from the opening pose, ignoring translations so a character simply walking across the
// scene still gets a useful pose rather than "the moment it travelled farthest".
export function representativeClipTime(clip, samples = 24) {
  const duration = Math.max(Number(clip?.duration) || 0, 0)
  if (!duration) return 0
  const tracks = quaternionTracks(clip)
  if (!tracks.length) return duration / 2
  const prepared = tracks.map((track) => ({
    interpolant: track.createInterpolant(new Float32Array(4)),
    initial: new THREE.Quaternion(track.values[0], track.values[1], track.values[2], track.values[3]).normalize(),
  }))
  let bestTime = 0
  let bestScore = -1
  for (let i = 0; i <= samples; i++) {
    const time = duration * i / samples
    let score = 0
    for (const { interpolant, initial } of prepared) {
      const value = interpolant.evaluate(time)
      const sample = new THREE.Quaternion(value[0], value[1], value[2], value[3]).normalize()
      score += 1 - Math.abs(initial.dot(sample))
    }
    if (score > bestScore) {
      bestScore = score
      bestTime = time
    }
  }
  return bestTime
}

export function applyClipFrame(root, clip, time, resolveTarget = (name) => root?.getObjectByName(name)) {
  if (!root || !clip) return
  for (const track of clip.tracks || []) {
    const match = /^(.+)\.(quaternion|position)$/.exec(track.name)
    if (!match) continue
    const target = resolveTarget(match[1])
    if (!target) continue
    if (match[2] === 'quaternion') {
      const value = track.createInterpolant(new Float32Array(4)).evaluate(time)
      target.quaternion.set(value[0], value[1], value[2], value[3])
    } else {
      const value = track.createInterpolant(new Float32Array(3)).evaluate(time)
      target.position.set(value[0], value[1], value[2])
    }
  }
  root.updateWorldMatrix(true, true)
}

export function animationThumbFromClipJSON(json, bones) {
  if (!json) return { segs: [] }
  let clip
  try {
    clip = THREE.AnimationClip.parse(json.clip || json)
  } catch {
    return { segs: [] }
  }
  if (!bones?.length) return { segs: [], duration: clip.duration }
  const root = bones[0]
  const saved = bones.map((bone) => ({
    bone,
    position: bone.position.clone(),
    quaternion: bone.quaternion.clone(),
  }))
  try {
    applyClipFrame(root, clip, representativeClipTime(clip), (name) => bones.find((bone) => bone.name === name))
    return { ...bodyThumb(bones), duration: clip.duration }
  } finally {
    for (const item of saved) {
      item.bone.position.copy(item.position)
      item.bone.quaternion.copy(item.quaternion)
    }
    root.updateWorldMatrix(true, true)
  }
}
