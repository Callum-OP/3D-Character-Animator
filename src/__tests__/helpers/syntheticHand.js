import * as THREE from 'three'

// A synthetic humanoid arm + hand for tests (no real model assets, so nothing copyrighted).
//
// The hand is built from one ANATOMY frame so tests know the truth independent of how the code works it out:
//   ey = the way the fingers point, ez = out of the palm, ex = thumb -> pinky on a right hand
//   (a left hand is the exact mirror: thumb on the other side, same palm normal).
// Every bone gets its own random world rest orientation (seeded), which is what different rigs do with their local
// bone axes - the code under test must not care.

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

const FINGER_BASES = {
  // [across (thumb->pinky), along, out-of-palm] of the knuckle, hand-local metres
  thumb: [-0.032, 0.02, 0.012],
  index: [-0.022, 0.09, 0],
  middle: [-0.005, 0.095, 0],
  ring: [0.012, 0.09, 0],
  pinky: [0.027, 0.08, 0],
}
const SEG_LEN = {
  thumb: [0.04, 0.032, 0.026],
  index: [0.04, 0.025, 0.02],
  middle: [0.044, 0.028, 0.021],
  ring: [0.04, 0.026, 0.02],
  pinky: [0.032, 0.02, 0.017],
}
const THUMB_DIR = new THREE.Vector3(-0.55, 0.8, 0.1).normalize() // along the palm plane, toward the thumb side

export function makeHandRig({
  side = 'R',
  anatomy = null, // { ex, ey, ez } world vectors; default: hand hangs along -Y... see below
  handPos = new THREE.Vector3(side === 'R' ? -0.7 : 0.7, 1.4, 0),
  names = 'mixamo', // 'mixamo' | 'blender' | 'plain'
  seed = 1,
  extraFingerSegment = true,
  thumbDirection = THUMB_DIR,
} = {}) {
  const rand = rng(seed)
  const mirror = side === 'L' ? -1 : 1
  // default anatomy: T-pose, fingers pointing out along +/-X, palm facing down (-Y)
  const outX = side === 'R' ? -1 : 1
  const ey0 = new THREE.Vector3(outX, 0, 0)
  const ez0 = new THREE.Vector3(0, -1, 0)
  // Anatomy: palm normal = fingers x (thumb->pinky) on a RIGHT hand (hold a right hand up, palm to your face,
  // fingers up: thumb is on the right, pinky on the left, palm faces you). So ez = ey x ex  =>  ex = ez x ey.
  const exR = new THREE.Vector3().crossVectors(ez0, ey0)
  const A = anatomy || { ex: exR, ey: ey0, ez: ez0 }
  // For a left hand the geometry is the mirror image: thumb->pinky points along -ex.
  const toWorld = (c) =>
    new THREE.Vector3()
      .addScaledVector(A.ex, c[0] * mirror)
      .addScaledVector(A.ey, c[1])
      .addScaledVector(A.ez, c[2])

  const sideWord = side === 'R' ? 'Right' : 'Left'
  const nameOf = {
    mixamo: (part) => `mixamorig:${sideWord}${part}`,
    blender: (part) => `${part.replace(/([a-z])([A-Z])/g, '$1_$2')}.${side}`,
    plain: (part) => `${part}_${side.toLowerCase()}`,
  }[names]
  const fingerName = (finger, i) => {
    const cap = finger[0].toUpperCase() + finger.slice(1)
    if (names === 'mixamo') return `mixamorig:${sideWord}Hand${cap}${i + 1}`
    if (names === 'blender') return `${finger}.0${i + 1}.${side}`
    return `${finger}${i + 1}_${side.toLowerCase()}`
  }

  const bones = []
  const worldRestQ = new Map()
  const worldPos = new Map()
  const make = (name, pos, parent) => {
    const bone = new THREE.Bone()
    bone.name = name
    const q = new THREE.Quaternion()
    // random world rest orientation per bone
    q.set(rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize()
    const pw = parent ? worldRestQ.get(parent) : new THREE.Quaternion()
    const pp = parent ? worldPos.get(parent) : new THREE.Vector3()
    bone.quaternion.copy(pw.clone().invert().multiply(q))
    bone.position.copy(pos.clone().sub(pp).applyQuaternion(pw.clone().invert()))
    worldRestQ.set(bone, q)
    worldPos.set(bone, pos.clone())
    if (parent) parent.add(bone)
    bones.push(bone)
    return bone
  }

  const hips = make('mixamorig:Hips', new THREE.Vector3(0, 1, 0), null)
  const spine = make('mixamorig:Spine', new THREE.Vector3(0, 1.2, 0), hips)
  const arm = make(nameOf('Arm'), handPos.clone().add(new THREE.Vector3(outX * -0.5, 0, 0)), spine)
  const hand = make(nameOf('Hand'), handPos.clone(), arm)

  const fingers = {}
  for (const finger of Object.keys(FINGER_BASES)) {
    const chain = []
    let parent = hand
    let pos = handPos.clone().add(toWorld(FINGER_BASES[finger]))
    const dir = finger === 'thumb' ? toWorld(thumbDirection.clone().normalize().toArray()) : A.ey.clone()
    const lens = SEG_LEN[finger]
    for (let i = 0; i < 3; i++) {
      const bone = make(fingerName(finger, i), pos.clone(), parent)
      chain.push(bone)
      parent = bone
      pos = pos.clone().addScaledVector(dir, lens[i])
    }
    if (extraFingerSegment) {
      const tipName = names === 'mixamo' ? `${fingerName(finger, 2).replace(/3$/, '4')}` : `${fingerName(finger, 2)}_end`
      make(tipName, pos.clone(), parent)
    }
    fingers[finger] = chain
  }

  hips.updateWorldMatrix(false, true)
  const restQuats = new Map(bones.map((b) => [b, b.quaternion.clone()]))
  const restQuatOf = (b) => restQuats.get(b) || null

  // coordinates of a world point in the hand's anatomy frame (x flipped for a left hand so both read the same)
  const anat = (v) => {
    const d = v.clone().sub(hand.getWorldPosition(new THREE.Vector3()))
    return new THREE.Vector3(d.dot(A.ex) * mirror, d.dot(A.ey), d.dot(A.ez))
  }
  return { hips, hand, bones, fingers, restQuatOf, anat, A, side, tip: (finger) => tipPos(fingers[finger]) }
}

export function tipPos(chain) {
  const last = chain[chain.length - 1]
  const child = last.children.find((c) => c.isBone)
  const bone = child || last
  return bone.getWorldPosition(new THREE.Vector3())
}

// A BVH (text) of a right/left hand only: Hand root, 5 fingers x 3 joints + end sites, first frame = the given rotations.
// Axes: fingers along +Y, palm normal +Z; thumb->pinky runs along -X for a right hand and +X for a left hand.
export function makeHandBVH({ side = 'R', curlDeg = [0, 0, 0], thumbCurlDeg = [0, 0, 0], frames = 1, rootName } = {}) {
  const word = side === 'R' ? 'Right' : 'Left'
  const sx = side === 'R' ? -1 : 1 // right hand: pinky toward -X so the palm normal (fingers x thumb->pinky) is +Z
  const lines = []
  const joints = []
  const bases = {
    Thumb: [-0.03 * sx, 0.02, 0.01],
    Index: [-0.02 * sx, 0.09, 0],
    Middle: [0, 0.095, 0],
    Ring: [0.015 * sx, 0.09, 0],
    Pinky: [0.03 * sx, 0.08, 0],
  }
  lines.push('HIERARCHY', `ROOT ${rootName || `${word}Hand`}`, '{', '\tOFFSET 0 0 0', '\tCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation')
  joints.push('root')
  for (const [finger, b] of Object.entries(bases)) {
    for (let i = 0; i < 3; i++) {
      const off = i === 0 ? b : [finger === 'Thumb' ? -0.01 * sx : 0, 0.03, 0]
      lines.push('\t'.repeat(i + 1) + `JOINT ${word}Hand${finger}${i + 1}`, '\t'.repeat(i + 1) + '{', '\t'.repeat(i + 2) + `OFFSET ${off.join(' ')}`, '\t'.repeat(i + 2) + 'CHANNELS 3 Zrotation Xrotation Yrotation')
      joints.push(`${finger}${i}`)
    }
    lines.push('\t'.repeat(4) + 'End Site', '\t'.repeat(4) + '{', '\t'.repeat(5) + 'OFFSET 0 0.02 0', '\t'.repeat(4) + '}')
    for (let i = 2; i >= 0; i--) lines.push('\t'.repeat(i + 1) + '}')
  }
  lines.push('}')
  const frame = [0, 0, 0, 0, 0, 0]
  for (const finger of Object.keys(bases)) {
    const deg = finger === 'Thumb' ? thumbCurlDeg : curlDeg
    for (let i = 0; i < 3; i++) frame.push(0, deg[i], 0) // Zrotation Xrotation Yrotation
  }
  lines.push('MOTION', `Frames: ${frames}`, 'Frame Time: 0.033333')
  for (let f = 0; f < frames; f++) lines.push(frame.join(' '))
  return lines.join('\n') + '\n'
}
