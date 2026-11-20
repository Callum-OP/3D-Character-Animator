// Human joint limits taken from Meta's own MHR model definition (compact_v6_1.model, Apache-2.0).
// The model's hand/finger and neck outputs are not clamped, so fingertips can bend backwards 90 degrees and
// thumbs hook out. MHR joints rotate in their own frames (x along the bone), with these degrees of freedom:
//   finger phalanges 2 and 3, thumb tip, elbow, knee: a single hinge about z
//   finger knuckles: rx (twist), ry (spread), rz (bend); thumb joints and neck/head: as listed
// All angles are radians in the MHR joint's own frame. [min, max]; a missing axis is locked to 0.
import * as THREE from 'three'
import { MHR_REST_QUAT } from './mhrRest.js'
import { BVH_JOINTS, JOINT_INDEX } from './humanoid.js'

const FINGERS = { Index: 0.5, Middle: 0.3, Ring: 0.3, Pinky: 0.3 }
export const LIMITS = {}
for (const S of ['Left', 'Right']) {
  for (const [F, twist] of Object.entries(FINGERS)) {
    LIMITS[`${S}Hand${F}1`] = { rx: [-twist, twist], ry: [-0.8, 0.8], rz: [F === 'Pinky' ? -1 : -0.78, 1.57] }
    LIMITS[`${S}Hand${F}2`] = { rz: [-0.2, 1.57] }
    LIMITS[`${S}Hand${F}3`] = { rz: [-0.1, 1.57] }
  }
  LIMITS[`${S}HandThumb1`] = { ry: [-1, 1], rz: [-1, 1] }
  LIMITS[`${S}HandThumb2`] = { rx: [-0.5, 0.5], ry: [-0.5, 0.5], rz: [-0.2, 1.0] }
  LIMITS[`${S}HandThumb3`] = { rz: [-0.3, 1.57] }
  LIMITS[`${S}ForeArm`] = { rz: [-0.5, 2.0] } // elbow
  LIMITS[`${S}Leg`] = { rz: [-0.05, 2.8] } // knee (a hair of tolerance)
}
LIMITS.Neck = { rx: [-0.8, 0.8], ry: [-0.5, 0.5], rz: [-0.6, 0.5] }
LIMITS.Head = { rx: [-0.8, 0.8], ry: [-0.3, 0.3], rz: [-0.4, 0.4] }

const restQ = (mhr) => new THREE.Quaternion(MHR_REST_QUAT[mhr * 4], MHR_REST_QUAT[mhr * 4 + 1], MHR_REST_QUAT[mhr * 4 + 2], MHR_REST_QUAT[mhr * 4 + 3]).normalize()
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v))

// Rest frame helpers per BVH joint: our local rotation L (rest-aligned axes) relates to the model's joint-frame
// rotation Delta by L = Grest * Delta * Grest^-1, so Delta = Grest^-1 * L * Grest.
const G = new Map(), GI = new Map()
export function restFrame(jointIndex) {
  if (!G.has(jointIndex)) {
    const g = restQ(BVH_JOINTS[jointIndex].mhr)
    G.set(jointIndex, g); GI.set(jointIndex, g.clone().invert())
  }
  return [G.get(jointIndex), GI.get(jointIndex)]
}

export const toModelFrame = (q, jointIndex, out = new THREE.Quaternion()) => {
  const [g, gi] = restFrame(jointIndex)
  return out.copy(gi).multiply(q).multiply(g)
}
export const fromModelFrame = (d, jointIndex, out = new THREE.Quaternion()) => {
  const [g, gi] = restFrame(jointIndex)
  return out.copy(g).multiply(d).multiply(gi)
}

const _e = new THREE.Euler(), _d = new THREE.Quaternion()
// Clamp one local rotation (in place) to the limits of the named joint. Returns the angle moved (radians).
export function limitJoint(q, jointIndex) {
  const lim = LIMITS[BVH_JOINTS[jointIndex].name]
  if (!lim) return 0
  const before = q.clone()
  toModelFrame(q, jointIndex, _d)
  if (_d.w < 0) { _d.x *= -1; _d.y *= -1; _d.z *= -1; _d.w *= -1 }
  if (lim.rz && !lim.rx && !lim.ry) {
    let a = 2 * Math.atan2(_d.z, _d.w)
    if (a > Math.PI) a -= 2 * Math.PI
    a = clamp(a, lim.rz)
    _d.set(0, 0, Math.sin(a / 2), Math.cos(a / 2))
  } else {
    _e.setFromQuaternion(_d, 'ZYX') // R = Rz * Ry * Rx
    _e.set(lim.rx ? clamp(_e.x, lim.rx) : 0, lim.ry ? clamp(_e.y, lim.ry) : 0, lim.rz ? clamp(_e.z, lim.rz) : 0, 'ZYX')
    _d.setFromEuler(_e)
  }
  fromModelFrame(_d, jointIndex, q)
  return before.angleTo(q)
}

export const LIMITED_JOINTS = Object.keys(LIMITS).map((n) => JOINT_INDEX[n])

// Apply limits to every limited joint of every frame in the per-joint quaternion tracks (Float32Array n*4 each).
export function limitTracks(tracks, count) {
  const q = new THREE.Quaternion()
  let moved = 0
  for (const j of LIMITED_JOINTS) {
    const t = tracks[j]
    for (let k = 0; k < count; k++) {
      q.set(t[k * 4], t[k * 4 + 1], t[k * 4 + 2], t[k * 4 + 3])
      moved = Math.max(moved, limitJoint(q, j))
      t[k * 4] = q.x; t[k * 4 + 1] = q.y; t[k * 4 + 2] = q.z; t[k * 4 + 3] = q.w
    }
  }
  return moved
}
