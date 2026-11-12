// Synthetic SAM 3D Body output built by forward kinematics on the REAL MHR rest skeleton, so tests exercise the
// same maths the model's output goes through without needing the model.
import * as THREE from 'three'
import { MHR_PARENTS, MHR_REST_POS_CM, MHR_REST_QUAT, MHR_NAMES } from '../../three/poseFinder/mhrRest.js'

export const IDX = Object.fromEntries(MHR_NAMES.map((n, i) => [n, i]))
const rq = (i) => new THREE.Quaternion(MHR_REST_QUAT[i * 4], MHR_REST_QUAT[i * 4 + 1], MHR_REST_QUAT[i * 4 + 2], MHR_REST_QUAT[i * 4 + 3])
const rp = (i) => new THREE.Vector3(MHR_REST_POS_CM[i * 3], MHR_REST_POS_CM[i * 3 + 1], MHR_REST_POS_CM[i * 3 + 2])

// pose: { jointName: THREE.Euler|Quaternion } rotation applied in WORLD axes on top of rest (a "world delta").
// rootPos: metres, y-up. Returns model-frame { G (127*9), pos (127*3, m), world quats }.
export function fk(pose = {}, rootPos = [0, 0.924, 0]) {
  const n = MHR_NAMES.length
  const Gq = new Array(n), P = new Array(n)
  for (let i = 0; i < n; i++) {
    const par = MHR_PARENTS[i]
    const delta = new THREE.Quaternion()
    const d = pose[MHR_NAMES[i]]
    if (d) delta.copy(d.isEuler ? new THREE.Quaternion().setFromEuler(d) : d)
    // world rotation = (accumulated parent delta) * own delta * rest. Deltas are LOCAL-in-world-axes per joint,
    // so accumulate them down the chain.
    const accParent = par < 0 ? new THREE.Quaternion() : Gq[par].delta
    const acc = accParent.clone().multiply(delta)
    Gq[i] = { delta: acc, q: acc.clone().multiply(rq(i)) }
    const offsetWorldRest = par < 0 ? rp(i) : rp(i).sub(rp(par))
    const off = offsetWorldRest.applyQuaternion(accParent) // rest offset rotated by the parent's accumulated delta
    P[i] = par < 0 ? new THREE.Vector3(rootPos[0] * 100, rootPos[1] * 100 + (rp(i).y - 92.3987), rootPos[2] * 100) : P[par].clone().add(off)
  }
  const G = new Float32Array(n * 9), pos = new Float32Array(n * 3)
  const m = new THREE.Matrix4()
  for (let i = 0; i < n; i++) {
    m.makeRotationFromQuaternion(Gq[i].q)
    const e = m.elements // column-major
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) G[i * 9 + r * 3 + c] = e[c * 4 + r]
    pos.set([P[i].x / 100, P[i].y / 100, P[i].z / 100], i * 3)
  }
  return { G, pos, quats: Gq.map((g) => g.q), deltas: Gq.map((g) => g.delta) }
}

// MHR-70 keypoints we use, derived from the FK joints (hips, ankles, three points per foot).
export function keypointsFromFk(pos) {
  const kp = new Float32Array(70 * 3)
  const set = (k, v) => kp.set(v, k * 3)
  const j = (name) => [pos[IDX[name] * 3], pos[IDX[name] * 3 + 1], pos[IDX[name] * 3 + 2]]
  const add = (a, d) => [a[0] + d[0], a[1] + d[1], a[2] + d[2]]
  const head = j('c_head')
  set(0, add(head, [0, 0.1, 0.05])) // nose, just above the head joint
  for (const [side, s, k0] of [['l', 'l', 15], ['r', 'r', 18]]) {
    const ankle = j(`${s}_foot`), ball = j(`${s}_ball`)
    set(side === 'l' ? 13 : 14, ankle)
    set(side === 'l' ? 9 : 10, j(`${s}_upleg`))
    set(k0, add(ball, [0, -0.02, 0.06])) // big toe tip
    set(k0 + 1, add(ball, [0.03, -0.02, 0.04]))
    set(k0 + 2, add(ankle, [0, -0.07, -0.06])) // heel
  }
  return kp
}

// One analysed frame in the CAMERA frame (y down, z forward, camera at origin looking +z), as the ONNX model reports.
// opts.rotFlip / opts.coordFlip simulate which frame each output arrives in.
export function makeFrame(t, fkOut, { depth = 3, x = 0, rotFlip = false, coordFlip = false } = {}) {
  const F = [1, -1, -1]
  const G = Float32Array.from(fkOut.G)
  if (rotFlip) for (let j = 0; j < 127; j++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) G[j * 9 + r * 3 + c] *= F[r] * F[c]
  const jc = Float32Array.from(fkOut.pos)
  const kp = keypointsFromFk(fkOut.pos)
  // person centred on the y-up pelvis; place them `depth` metres from the camera
  const camT = [x, 0, depth]
  const kp3 = Float32Array.from(kp)
  for (let i = 0; i < 70; i++) { kp3[i * 3 + 1] *= -1; kp3[i * 3 + 2] *= -1 } // model -> camera frame, "before cam_t"
  // keypoints are relative to the world origin; cam_t puts them in front of the camera. Keep y-up world = origin at ground.
  camT[1] = 0
  if (coordFlip) for (let i = 0; i < 127; i++) { jc[i * 3 + 1] *= -1; jc[i * 3 + 2] *= -1 }
  return { t, G, jc, kp3, camT }
}
