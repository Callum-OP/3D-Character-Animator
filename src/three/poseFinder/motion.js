// Turns per-frame SAM 3D Body output into clean humanoid motion: rotations relative to rest, smoothed with a
// zero-phase One-Euro filter, plus a root path that is steadied by foot contact. Pure maths — no DOM, no Electron.
import * as THREE from 'three'
import { MHR_NAMES, MHR_REST_POS_CM, MHR_REST_QUAT } from './mhrRest.js'
import { BVH_JOINTS, JOINT_INDEX, restOffsets } from './humanoid.js'
import { maxAngleFromFirst } from './validate.js'
import { limitTracks, toModelFrame, fromModelFrame } from './limits.js'

export const MHR_J = 127
const FLIP = [1, -1, -1] // model frame <-> camera frame (y down, z forward)

const SMOOTHING = {
  off: null,
  low: { minCutoff: 6.0, beta: 0.7 },
  medium: { minCutoff: 3.0, beta: 0.45 },
  high: { minCutoff: 1.6, beta: 0.3 },
}
export const SMOOTHING_LEVELS = Object.keys(SMOOTHING)

// ---- small helpers ----------------------------------------------------------------------------------------

const _m = new THREE.Matrix4()
function quatFromMat3(G, off, flip, out) {
  const g = (i, k) => G[off + i * 3 + k] * (flip ? FLIP[i] * FLIP[k] : 1)
  _m.set(g(0, 0), g(0, 1), g(0, 2), 0, g(1, 0), g(1, 1), g(1, 2), 0, g(2, 0), g(2, 1), g(2, 2), 0, 0, 0, 0, 1)
  return out.setFromRotationMatrix(_m)
}

const restQuat = (i) => new THREE.Quaternion(MHR_REST_QUAT[i * 4], MHR_REST_QUAT[i * 4 + 1], MHR_REST_QUAT[i * 4 + 2], MHR_REST_QUAT[i * 4 + 3]).normalize()
const REST_INV = Array.from({ length: MHR_J }, (_, i) => restQuat(i).invert())
const restVec = (i) => new THREE.Vector3(MHR_REST_POS_CM[i * 3], MHR_REST_POS_CM[i * 3 + 1], MHR_REST_POS_CM[i * 3 + 2])

// ---- which frame is the model talking in? ------------------------------------------------------------------
// SAM 3D Body works in an MHR model frame (y up, facing +z) and flips y/z to reach the camera frame. Which of
// those frames each ONNX output arrives in is not documented, so choose the combination whose predicted limb
// directions agree with the joint positions. This must not assume the person is upright.
const CHECK_BONES = [
  ['l_upleg', 'l_lowleg'], ['l_lowleg', 'l_foot'], ['r_upleg', 'r_lowleg'], ['r_lowleg', 'r_foot'],
  ['l_uparm', 'l_lowarm'], ['r_uparm', 'r_lowarm'], ['c_neck', 'c_head'],
]
const IDX = Object.fromEntries(MHR_NAMES.map((n, i) => [n, i]))

export function detectConvention(frames) {
  const sample = frames.filter((_, i) => i % Math.max(1, Math.floor(frames.length / 12)) === 0).slice(0, 12)
  const score = (rotFlip, coordFlip) => {
    let sum = 0, cnt = 0
    const q = new THREE.Quaternion()
    for (const f of sample) {
      for (const [a, b] of CHECK_BONES) {
        const ia = IDX[a], ib = IDX[b]
        const obs = new THREE.Vector3(
          f.jc[ib * 3] - f.jc[ia * 3],
          (f.jc[ib * 3 + 1] - f.jc[ia * 3 + 1]) * (coordFlip ? -1 : 1),
          (f.jc[ib * 3 + 2] - f.jc[ia * 3 + 2]) * (coordFlip ? -1 : 1),
        )
        if (obs.lengthSq() < 1e-8) continue
        obs.normalize()
        // predicted: parent's posed frame applied to the rest direction expressed in the parent's rest frame
        const local = restVec(ib).sub(restVec(ia)).applyQuaternion(REST_INV[ia]).normalize()
        quatFromMat3(f.G, ia * 9, rotFlip, q)
        sum += local.applyQuaternion(q).dot(obs)
        cnt++
      }
    }
    return cnt ? sum / cnt : -1
  }
  const candidates = []
  for (const coordFlip of [false, true]) {
    for (const rotFlip of [false, true]) candidates.push({ coordFlip, rotFlip, score: score(rotFlip, coordFlip) })
  }
  return candidates.reduce((best, candidate) => candidate.score > best.score ? candidate : best)
}

// ---- filtering --------------------------------------------------------------------------------------------

const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff) / dt)

// One-Euro filter over a quaternion track (values: Float32Array n*4, hemisphere-continuous). Returns a new array.
function oneEuroQuat(values, n, dt, { minCutoff, beta }, reverse) {
  const out = new Float32Array(values.length)
  const prevRaw = new THREE.Quaternion(), cur = new THREE.Quaternion(), filt = new THREE.Quaternion()
  let dxh = 0
  const order = reverse ? Array.from({ length: n }, (_, i) => n - 1 - i) : Array.from({ length: n }, (_, i) => i)
  let first = true
  for (const i of order) {
    cur.set(values[i * 4], values[i * 4 + 1], values[i * 4 + 2], values[i * 4 + 3])
    if (first) {
      filt.copy(cur)
      first = false
    } else {
      const d = Math.min(1, Math.abs(cur.dot(prevRaw)))
      const speed = (2 * Math.acos(d)) / dt
      const ad = alpha(1.0, dt)
      dxh = ad * speed + (1 - ad) * dxh
      filt.slerp(cur, alpha(minCutoff + beta * dxh, dt))
    }
    prevRaw.copy(cur)
    out[i * 4] = filt.x; out[i * 4 + 1] = filt.y; out[i * 4 + 2] = filt.z; out[i * 4 + 3] = filt.w
  }
  return out
}

// Forward + backward pass averaged: no lag, so footfalls and hand hits stay on the right frame.
function zeroPhaseQuat(values, n, dt, params) {
  const a = oneEuroQuat(values, n, dt, params, false)
  const b = oneEuroQuat(values, n, dt, params, true)
  const out = new Float32Array(values.length)
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion()
  for (let i = 0; i < n; i++) {
    qa.set(a[i * 4], a[i * 4 + 1], a[i * 4 + 2], a[i * 4 + 3])
    qb.set(b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3])
    if (qa.dot(qb) < 0) { qb.x *= -1; qb.y *= -1; qb.z *= -1; qb.w *= -1 }
    qa.slerp(qb, 0.5)
    out[i * 4] = qa.x; out[i * 4 + 1] = qa.y; out[i * 4 + 2] = qa.z; out[i * 4 + 3] = qa.w
  }
  return out
}

// Centred moving average over a scalar series (window in frames, odd).
function movingAverage(series, win) {
  const n = series.length, h = Math.max(0, (win - 1) >> 1), out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0
    for (let k = Math.max(0, i - h); k <= Math.min(n - 1, i + h); k++) { s += series[k]; c++ }
    out[i] = s / c
  }
  return out
}

// 5-point running median over interleaved vectors: removes single-frame depth/pose outliers before smoothing.
function medianFilter(values, dim, win = 5) {
  const n = values.length / dim, h = win >> 1, out = new Float32Array(values.length), buf = []
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < dim; d++) {
      buf.length = 0
      for (let k = Math.max(0, i - h); k <= Math.min(n - 1, i + h); k++) buf.push(values[k * dim + d])
      buf.sort((a, b) => a - b)
      out[i * dim + d] = buf[buf.length >> 1]
    }
  }
  return out
}

// ---- resampling -------------------------------------------------------------------------------------------

function makeGrid(times, outFps) {
  const t0 = times[0], t1 = times[times.length - 1]
  const count = Math.max(2, Math.floor((t1 - t0) * outFps + 1e-6) + 1)
  const idx = new Int32Array(count), frac = new Float32Array(count)
  let j = 0
  for (let k = 0; k < count; k++) {
    const t = Math.min(t1, t0 + k / outFps)
    while (j < times.length - 2 && times[j + 1] < t) j++
    idx[k] = j
    const span = times[j + 1] - times[j]
    frac[k] = span > 0 ? Math.min(1, Math.max(0, (t - times[j]) / span)) : 0
  }
  return { count, idx, frac }
}

function resampleQuat(values, grid) {
  const out = new Float32Array(grid.count * 4)
  const a = new THREE.Quaternion(), b = new THREE.Quaternion()
  for (let k = 0; k < grid.count; k++) {
    const i = grid.idx[k]
    a.set(values[i * 4], values[i * 4 + 1], values[i * 4 + 2], values[i * 4 + 3])
    b.set(values[i * 4 + 4], values[i * 4 + 5], values[i * 4 + 6], values[i * 4 + 7])
    a.slerp(b, grid.frac[k])
    out[k * 4] = a.x; out[k * 4 + 1] = a.y; out[k * 4 + 2] = a.z; out[k * 4 + 3] = a.w
  }
  return out
}

function resampleVec(values, dim, grid) {
  const out = new Float32Array(grid.count * dim)
  for (let k = 0; k < grid.count; k++) {
    const i = grid.idx[k], f = grid.frac[k]
    for (let d = 0; d < dim; d++) out[k * dim + d] = values[i * dim + d] * (1 - f) + values[(i + 1) * dim + d] * f
  }
  return out
}

// ---- root path --------------------------------------------------------------------------------------------
// Positions come from the camera-space keypoints (documented) + cam_t, then F maps camera -> y-up world.
const KP = { lShoulder: 5, rShoulder: 6, lHip: 9, rHip: 10, lAnkle: 13, rAnkle: 14, lToe: 15, lSmallToe: 16, lHeel: 17, rToe: 18, rSmallToe: 19, rHeel: 20 }
const worldKp = (f, i) => [f.kp3[i * 3] + f.camT[0], -(f.kp3[i * 3 + 1] + f.camT[1]), -(f.kp3[i * 3 + 2] + f.camT[2])]
const UP = new THREE.Vector3(0, 1, 0)
const median = (arr) => { const s = Array.from(arr).sort((a, b) => a - b); return s[s.length >> 1] }

// The model reports everything relative to the CAMERA. A camera tilted up or down makes a standing person look
// like they lean or stand on a slope. Estimate "up" from how the legs and torso are oriented over the whole
// clip (median, so bending over now and then does not matter) and return the rotation that levels it.
export function estimateUprightCorrection(frames) {
  const legs = [[], [], []], torso = [[], [], []]
  for (const f of frames) {
    const h = ['lHip', 'rHip'].map((k) => worldKp(f, KP[k])), a = ['lAnkle', 'rAnkle'].map((k) => worldKp(f, KP[k])), sh = ['lShoulder', 'rShoulder'].map((k) => worldKp(f, KP[k]))
    const mid = (p) => [0, 1, 2].map((d) => (p[0][d] + p[1][d]) / 2)
    const hm = mid(h), am = mid(a), sm = mid(sh)
    const v1 = new THREE.Vector3(hm[0] - am[0], hm[1] - am[1], hm[2] - am[2]), v2 = new THREE.Vector3(sm[0] - hm[0], sm[1] - hm[1], sm[2] - hm[2])
    if (v1.length() > 0.2) { v1.normalize(); for (let d = 0; d < 3; d++) legs[d].push(v1.getComponent(d)) }
    if (v2.length() > 0.2) { v2.normalize(); for (let d = 0; d < 3; d++) torso[d].push(v2.getComponent(d)) }
  }
  if (!legs[0].length || !torso[0].length) return { q: new THREE.Quaternion(), tiltDeg: 0 }
  const l = new THREE.Vector3(median(legs[0]), median(legs[1]), median(legs[2])).normalize()
  const t = new THREE.Vector3(median(torso[0]), median(torso[1]), median(torso[2])).normalize()
  const u = l.multiplyScalar(0.65).add(t.multiplyScalar(0.35)).normalize()
  const q = new THREE.Quaternion().setFromUnitVectors(u, UP)
  return { q, tiltDeg: (u.angleTo(UP) * 180) / Math.PI }
}

function rootInputs(frames, Rc) {
  const n = frames.length
  const pelvis = new Float32Array(n * 3)
  const soles = [new Float32Array(n * 3), new Float32Array(n * 3)]
  const legCm = []
  const boneLegCm = []
  const bodyLow = new Float32Array(n)
  const P = (f, i) => { const w = worldKp(f, i); return new THREE.Vector3(w[0], w[1], w[2]).applyQuaternion(Rc) }
  for (let i = 0; i < n; i++) {
    const f = frames[i]
    const lh = P(f, KP.lHip), rh = P(f, KP.rHip)
    const pel = lh.clone().add(rh).multiplyScalar(0.5)
    pelvis.set([pel.x, pel.y, pel.z], i * 3)
    const am = P(f, KP.lAnkle).add(P(f, KP.rAnkle)).multiplyScalar(0.5)
    legCm.push(pel.distanceTo(am) * 100)
    const joint = (name) => new THREE.Vector3().fromArray(f.jc, IDX[name] * 3)
    for (const side of ['l', 'r']) {
      const hip = joint(`${side}_upleg`), knee = joint(`${side}_lowleg`), ankle = joint(`${side}_foot`)
      boneLegCm.push((hip.distanceTo(knee) + knee.distanceTo(ankle)) * 100)
    }
    bodyLow[i] = Math.min(...Object.values(KP).map((id) => P(f, id).y))
    ;[[KP.lToe, KP.lSmallToe, KP.lHeel], [KP.rToe, KP.rSmallToe, KP.rHeel]].forEach((ids, side) => {
      const points = ids.map((id) => P(f, id))
      const center = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / points.length)
      soles[side].set([center.x, Math.min(...points.map((p) => p.y)), center.z], i * 3)
    })
  }
  legCm.sort((a, b) => a - b)
  boneLegCm.sort((a, b) => a - b)
  return { pelvis, soles, bodyLow, legCm: legCm[legCm.length >> 1], boneLegCm: boneLegCm[boneLegCm.length >> 1] }
}

// Screen-space contacts are useful when depth estimates drift during jumps. Require a sustained, upright,
// low and slow foot; the screen position cannot distinguish movement directly towards the camera.
function screenFootContacts(frames, grid, rot, fps) {
  const ids = [[KP.lToe, KP.lSmallToe, KP.lHeel], [KP.rToe, KP.rSmallToe, KP.rHeel]]
  const required = [KP.lShoulder, KP.rShoulder, KP.lHip, KP.rHip, KP.lAnkle, KP.rAnkle, ...ids.flat()]
  if (frames.some((f) => !f.kp2 || required.some((id) => !Number.isFinite(f.kp2[id * 2]) || !Number.isFinite(f.kp2[id * 2 + 1])))) return null
  const sizes = frames.map((f) => {
    const mid = (a, b, d) => (f.kp2[a * 2 + d] + f.kp2[b * 2 + d]) / 2
    return Math.hypot(mid(KP.lShoulder, KP.rShoulder, 0) - mid(KP.lAnkle, KP.rAnkle, 0), mid(KP.lShoulder, KP.rShoulder, 1) - mid(KP.lAnkle, KP.rAnkle, 1))
  })
  const size = median(sizes)
  if (size < 8) return null
  const upright = new Uint8Array(grid.count)
  const q = new THREE.Quaternion(), up = new THREE.Vector3()
  for (let k = 0; k < grid.count; k++) {
    q.fromArray(rot[0], k * 4)
    upright[k] = up.set(0, 1, 0).applyQuaternion(q).y > 0.7 ? 1 : 0
  }
  const feet = ids.map((points) => {
    const source = new Float32Array(frames.length * 2)
    frames.forEach((f, i) => {
      for (let d = 0; d < 2; d++) source[i * 2 + d] = points.reduce((sum, id) => sum + f.kp2[id * 2 + d], 0) / points.length
    })
    const pos = resampleVec(medianFilter(source, 2), 2, grid)
    const x = movingAverage(Float32Array.from({ length: grid.count }, (_, i) => pos[i * 2]), 3)
    const y = movingAverage(Float32Array.from({ length: grid.count }, (_, i) => pos[i * 2 + 1]), 3)
    const floor = Array.from(y).filter((_, i) => upright[i]).sort((a, b) => a - b)
    return { x, y, floorY: floor.length ? floor[Math.floor((floor.length - 1) * 0.9)] : null }
  })
  const hipSource = Float32Array.from(frames, (f) => (f.kp2[KP.lHip * 2 + 1] + f.kp2[KP.rHip * 2 + 1]) / 2)
  const hipY = movingAverage(resampleVec(medianFilter(hipSource, 1), 1, grid), 3)
  const airborne = new Uint8Array(grid.count)
  if (feet.every((foot) => foot.floorY !== null)) {
    for (let i = 0; i < grid.count;) {
      if (!feet.every((foot) => foot.y[i] < foot.floorY - size * 0.06)) { i++; continue }
      let j = i
      while (j + 1 < grid.count && feet.every((foot) => foot.y[j + 1] < foot.floorY - size * 0.06)) j++
      // Feet can appear higher just because estimated camera depth changed; takeoff also raises the hips.
      const lookback = Math.max(1, Math.round(0.3 * fps))
      const before = Math.max(...hipY.slice(Math.max(0, i - lookback), i + 1))
      const after = Math.min(...hipY.slice(i, Math.min(j + 1, i + lookback + 1)))
      if (j - i + 1 >= Math.max(2, Math.round(0.1 * fps)) && before - after > size * 0.025) airborne.fill(1, i, j + 1)
      i = j + 1
    }
  }
  return feet.map(({ x, y, floorY }) => {
    const stance = new Uint8Array(grid.count)
    const allowed = new Uint8Array(grid.count)
    const radius = Math.max(1, Math.round(0.2 * fps))
    const speed = (a, b) => b > a ? Math.hypot(x[b] - x[a], y[b] - y[a]) / ((b - a) / fps) : Infinity
    for (let i = 0; i < grid.count; i++) {
      const lo = Math.max(0, i - radius), hi = Math.min(grid.count - 1, i + radius)
      const motion = Math.min(speed(lo, i), speed(i, hi))
      allowed[i] = floorY !== null && upright[i] && !airborne[i] && y[i] >= floorY - size * 0.22 ? 1 : 0
      stance[i] = allowed[i] && motion < size * 0.4 ? 1 : 0
    }
    const blend = new Float32Array(grid.count)
    const ramp = Math.max(1, Math.round(0.15 * fps))
    for (let i = 0; i < grid.count;) {
      if (!allowed[i]) { i++; continue }
      let j = i
      while (j + 1 < grid.count && allowed[j + 1]) j++
      for (let k = i; k <= j; k++) {
        const inWeight = i === 0 ? 1 : Math.min(1, (k - i + 1) / (ramp + 1))
        const outWeight = j === grid.count - 1 ? 1 : Math.min(1, (j - k + 1) / (ramp + 1))
        const w = Math.min(inWeight, outWeight)
        blend[k] = 0.5 - 0.5 * Math.cos(Math.PI * w)
      }
      i = j + 1
    }
    return { stance, blend }
  })
}

// Pin planted feet so depth noise cannot make the body glide: while a foot is low and slow, its XZ is held at
// the segment's median and its sole is held on the ground. The correction is spread over the root path.
// Also returns, per foot, how "planted" it is on each frame (0..1) so the foot can be levelled too.
function footLock(rootXYZ, soles, ground, fps, screenContacts = null) {
  const n = rootXYZ.length / 3
  const corr = new Float32Array(n * 3)
  const weightSum = new Float32Array(n)
  const planted = [new Float32Array(n), new Float32Array(n)]
  const tracked = []
  const ramp = Math.max(1, Math.round(0.1 * fps))
  const minLen = Math.max(2, Math.round((screenContacts ? 0.25 : 0.12) * fps))
  const trendRadius = Math.max(1, Math.round(0.3 * fps))
  let segments = 0
  soles.forEach((sole, side) => {
    const sx = movingAverage(Float32Array.from({ length: n }, (_, i) => sole[i * 3]), 3)
    const sy = movingAverage(Float32Array.from({ length: n }, (_, i) => sole[i * 3 + 1]), 3)
    const sz = movingAverage(Float32Array.from({ length: n }, (_, i) => sole[i * 3 + 2]), 3)
    if (screenContacts) tracked.push([sx, sy, sz])
    const stance = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1)
      const speed = Math.hypot(sx[b] - sx[a], sy[b] - sy[a], sz[b] - sz[a]) / ((b - a) / fps)
      const lo = Math.max(0, i - trendRadius), hi = Math.min(n - 1, i + trendRadius)
      const trend = Math.hypot(sx[hi] - sx[lo], sz[hi] - sz[lo]) / ((hi - lo) / fps)
      stance[i] = screenContacts ? screenContacts[side].stance[i] : (sy[i] - ground < 0.07 && speed < 0.45 && trend < 0.16 ? 1 : 0)
    }
    for (let i = 0; i < n;) {
      if (!stance[i]) { i++; continue }
      let j = i
      while (j + 1 < n && stance[j + 1]) j++
      const hasAnchor = !screenContacts || screenContacts[side].blend.subarray(i, j + 1).some((w) => w >= 0.999)
      if (j - i + 1 >= minLen && hasAnchor) {
        segments++
        const anchorEnd = screenContacts ? Math.min(j + 1, i + Math.max(2, Math.round(0.15 * fps))) : j + 1
        const xs = Array.from(sx.slice(i, anchorEnd)).sort((p, q) => p - q)
        const zs = Array.from(sz.slice(i, anchorEnd)).sort((p, q) => p - q)
        const ax = xs[xs.length >> 1], az = zs[zs.length >> 1]
        const ay = screenContacts ? median(sy.slice(i, anchorEnd)) : ground
        for (let k = Math.max(0, i - ramp); k <= Math.min(n - 1, j + ramp); k++) {
          let w = k < i ? 0.5 - 0.5 * Math.cos(Math.PI * (1 - (i - k) / (ramp + 1))) : k > j ? 0.5 - 0.5 * Math.cos(Math.PI * (1 - (k - j) / (ramp + 1))) : 1
          if (screenContacts) w *= screenContacts[side].blend[k]
          if (!w) continue
          corr[k * 3] += w * (sx[k] - ax)
          corr[k * 3 + 1] += w * (sy[k] - ay)
          corr[k * 3 + 2] += w * (sz[k] - az)
          weightSum[k] += w
          planted[side][k] = Math.max(planted[side][k], w)
        }
      }
      i = j + 1
    }
  })
  const out = Float32Array.from(rootXYZ)
  if (screenContacts) {
    // Keep accumulated tracking corrections after release; only new planted-foot motion changes the offset.
    const offset = [0, 0, 0]
    for (let k = 1; k < n; k++) {
      const weights = planted.map((p) => Math.min(p[k - 1], p[k]))
      const total = Math.max(1, weights[0] + weights[1])
      for (const d of [0, 2]) {
        for (let side = 0; side < 2; side++) offset[d] += weights[side] * (tracked[side][d][k] - tracked[side][d][k - 1]) / total
        out[k * 3 + d] -= offset[d]
      }
    }
    for (let k = 0; k < n; k++) out[k * 3 + 1] -= corr[k * 3 + 1] / Math.max(1, weightSum[k])
    return { path: out, segments, planted }
  }
  for (let k = 0; k < n; k++) {
    const d = Math.max(1, weightSum[k])
    out[k * 3] -= corr[k * 3] / d
    out[k * 3 + 1] -= corr[k * 3 + 1] / d
    out[k * 3 + 2] -= corr[k * 3 + 2] / d
  }
  return { path: out, segments, planted }
}

// ---- posture and feet --------------------------------------------------------------------------------------
const SPINE = ['Spine', 'Spine1', 'Spine2', 'Spine3'].map((n) => JOINT_INDEX[n])
const _q = new THREE.Quaternion(), _dq = new THREE.Quaternion(), _eu = new THREE.Euler()

// The body model tends to read a front-on person as hunched (forward bend is ambiguous from the front). Remove the
// CONSTANT part of the forward bend from the spine (median over the clip), keeping all movement around it, and let
// the neck take half back so the head does not tip up. Returns the bend removed (radians).
// MHR bend is rotation about z in the joint's own frame, positive = forward (its limit is [-0.5, 1.5]).
function straightenPosture(local, count, allowance) {
  const z = SPINE.map(() => new Float32Array(count)), eul = SPINE.map(() => new Array(count))
  SPINE.forEach((j, s) => {
    for (let k = 0; k < count; k++) {
      _q.set(local[j][k * 4], local[j][k * 4 + 1], local[j][k * 4 + 2], local[j][k * 4 + 3])
      toModelFrame(_q, j, _dq)
      _eu.setFromQuaternion(_dq, 'ZYX')
      eul[s][k] = [_eu.x, _eu.y, _eu.z]
      z[s][k] = _eu.z
    }
  })
  const med = z.map((arr) => median(arr))
  const total = med.reduce((a, b) => a + Math.max(0, b), 0)
  const excess = Math.min(0.9, Math.max(0, med.reduce((a, b) => a + b, 0) - allowance))
  if (excess < 0.03 || total <= 0) return 0
  SPINE.forEach((j, s) => {
    const share = Math.max(0, med[s]) / total
    if (share <= 0) return
    for (let k = 0; k < count; k++) {
      const e = eul[s][k]
      _eu.set(e[0], e[1], e[2] - excess * share, 'ZYX')
      _dq.setFromEuler(_eu)
      fromModelFrame(_dq, j, _q)
      local[j].set([_q.x, _q.y, _q.z, _q.w], k * 4)
    }
  })
  // head: take half of the correction back through the neck
  const nj = JOINT_INDEX.Neck
  for (let k = 0; k < count; k++) {
    _q.set(local[nj][k * 4], local[nj][k * 4 + 1], local[nj][k * 4 + 2], local[nj][k * 4 + 3])
    toModelFrame(_q, nj, _dq)
    _eu.setFromQuaternion(_dq, 'ZYX')
    _eu.set(_eu.x, _eu.y, _eu.z + excess * 0.5, 'ZYX')
    _dq.setFromEuler(_eu)
    fromModelFrame(_dq, nj, _q)
    local[nj].set([_q.x, _q.y, _q.z, _q.w], k * 4)
  }
  return excess
}

// While a foot is planted, make its sole level with the ground (removes toes-up / on-a-slope feet). Works on the
// foot's world orientation and only ever swings the sole's up vector back to vertical (no twist, so heading is kept).
function levelFeet(rot, count, planted) {
  const sides = [['LeftUpLeg', 'LeftLeg', 'LeftFoot'], ['RightUpLeg', 'RightLeg', 'RightFoot']]
  const a = new THREE.Quaternion(), b = new THREE.Quaternion(), dLeg = new THREE.Quaternion(), dFoot = new THREE.Quaternion(), r = new THREE.Quaternion(), rw = new THREE.Quaternion(), id = new THREE.Quaternion()
  const get = (j, k, out) => out.set(rot[j][k * 4], rot[j][k * 4 + 1], rot[j][k * 4 + 2], rot[j][k * 4 + 3])
  const u = new THREE.Vector3()
  let applied = 0
  sides.forEach(([up, leg, foot], s) => {
    const [ju, jl, jf] = [JOINT_INDEX[up], JOINT_INDEX[leg], JOINT_INDEX[foot]]
    for (let k = 0; k < count; k++) {
      const w = planted[s][k]
      if (w < 0.02) continue
      get(0, k, a); get(ju, k, b); a.multiply(b)            // hips * upleg
      get(jl, k, b); dLeg.copy(a).multiply(b)              // ... * leg
      get(jf, k, b); dFoot.copy(dLeg).multiply(b)          // ... * foot
      u.set(0, 1, 0).applyQuaternion(dFoot)
      const tilt = (u.angleTo(UP) * 180) / Math.PI
      if (tilt < 0.5) continue
      r.setFromUnitVectors(u, UP)
      rw.copy(id).slerp(r, w)
      dFoot.premultiply(rw)
      b.copy(dLeg).invert().multiply(dFoot)                // new local foot rotation
      rot[jf].set([b.x, b.y, b.z, b.w], k * 4)
      applied = Math.max(applied, tilt * w)
    }
  })
  return applied
}


// ---- shoulders and ground ----------------------------------------------------------------------------------
const SHRUG = { off: null, slight: { keep: 0.5, lowerDeg: 2 }, more: { keep: 0.25, lowerDeg: 5 } }
export const SHOULDER_LEVELS = Object.keys(SHRUG)

// The body model often raises the shoulders (a shrug) and pushes them forward. Damp any raise above the neutral
// height and drop the shoulder a little, keeping the arm itself pointing where it was. Returns the largest change (deg).
function lowerShoulders(local, count, level) {
  const cfg = SHRUG[level]
  if (!cfg) return 0
  const offs = restOffsets()
  const lower = (cfg.lowerDeg * Math.PI) / 180
  const L = new THREE.Quaternion(), R = new THREE.Quaternion(), La = new THREE.Quaternion()
  const elev = (v) => Math.atan2(v.y, Math.hypot(v.x, v.z))
  let worst = 0
  for (const [sh, arm] of [['LeftShoulder', 'LeftArm'], ['RightShoulder', 'RightArm']]) {
    const j = JOINT_INDEX[sh], ja = JOINT_INDEX[arm]
    const d0 = new THREE.Vector3(...offs[ja]).normalize()
    const e0 = elev(d0)
    for (let k = 0; k < count; k++) {
      L.set(local[j][k * 4], local[j][k * 4 + 1], local[j][k * 4 + 2], local[j][k * 4 + 3])
      const dir = d0.clone().applyQuaternion(L)
      const e = elev(dir) - e0
      const de = (e > 0 ? -(1 - cfg.keep) * e : 0) - lower
      const h = new THREE.Vector3(dir.x, 0, dir.z)
      if (h.lengthSq() < 1e-6) continue
      h.normalize()
      R.setFromAxisAngle(h.clone().cross(UP).normalize(), de) // raises a horizontal direction by +de
      const Rinv = R.clone().invert()
      La.set(local[ja][k * 4], local[ja][k * 4 + 1], local[ja][k * 4 + 2], local[ja][k * 4 + 3])
      // shoulder' = R * shoulder ; arm' = shoulder'^-1 * shoulder * arm  (the arm keeps its world orientation)
      const Lnew = R.clone().multiply(L)
      const Lanew = L.clone().invert().multiply(Rinv).multiply(L).multiply(La)
      local[j].set([Lnew.x, Lnew.y, Lnew.z, Lnew.w], k * 4)
      local[ja].set([Lanew.x, Lanew.y, Lanew.z, Lanew.w], k * 4)
      worst = Math.max(worst, Math.abs(de))
    }
  }
  return (worst * 180) / Math.PI
}

// Height of the hips above the ground that puts the lowest point of either foot exactly on it, for every frame,
// computed on the FINAL skeleton (template bone lengths + the finished rotations). cm.
// Heel = 7.4 cm below the ankle joint and 6 cm behind it; toe tip = 2.1 cm below the ball joint and 5 cm ahead
// (the template's own flat-foot proportions).
function groundLockHeights(rot, count) {
  const off = restOffsets()
  const J = JOINT_INDEX
  const ang = (j, k, out) => out.set(rot[j][k * 4], rot[j][k * 4 + 1], rot[j][k * 4 + 2], rot[j][k * 4 + 3])
  const out = new Float32Array(count)
  const dH = new THREE.Quaternion(), dU = new THREE.Quaternion(), dL = new THREE.Quaternion(), dF = new THREE.Quaternion(), dT = new THREE.Quaternion(), t = new THREE.Quaternion()
  const v = new THREE.Vector3()
  for (let k = 0; k < count; k++) {
    ang(0, k, dH)
    let lowest = Infinity
    for (const S of ['Left', 'Right']) {
      const ju = J[`${S}UpLeg`], jl = J[`${S}Leg`], jf = J[`${S}Foot`], jt = J[`${S}ToeBase`]
      dU.copy(dH).multiply(ang(ju, k, t))
      dL.copy(dU).multiply(ang(jl, k, t))
      dF.copy(dL).multiply(ang(jf, k, t))
      dT.copy(dF).multiply(ang(jt, k, t))
      const p = new THREE.Vector3(...off[ju]).applyQuaternion(dH) // hip joint
        .add(v.set(...off[jl]).applyQuaternion(dU))               // knee
        .add(v.set(...off[jf]).applyQuaternion(dL))               // ankle
      const toeJoint = p.clone().add(v.set(...off[jt]).applyQuaternion(dF)) // ball
      const heel = p.clone().add(v.set(0, -7.4, -6).applyQuaternion(dF))
      const toe = toeJoint.clone().add(v.set(0, -2.1, 5).applyQuaternion(dT))
      lowest = Math.min(lowest, heel.y, toe.y)
    }
    out[k] = -lowest
  }
  return out
}


// Re-solve each leg towards its contact target, retaining the original knee bend direction.
// A target outside leg reach is clamped rather than stretching the skeleton.
function lockFeet(rot, root, count, planted, fixed, ground, level, contactFps = 0) {
  const off = restOffsets()
  const J = JOINT_INDEX
  const get = (j, k, out) => out.set(rot[j][k * 4], rot[j][k * 4 + 1], rot[j][k * 4 + 2], rot[j][k * 4 + 3])
  const put = (j, k, q) => { rot[j].set([q.x, q.y, q.z, q.w], k * 4) }
  const V = (i) => new THREE.Vector3(...off[i])
  const dH = new THREE.Quaternion(), t = new THREE.Quaternion()
  const legs = []
  for (const S of ['Left', 'Right']) {
    const ju = J[`${S}UpLeg`], jl = J[`${S}Leg`], jf = J[`${S}Foot`]
    const offU = V(ju), offL = V(jl), offF = V(jf)
    const l1 = offL.length(), l2 = offF.length()
    const chain = (k) => {
      get(0, k, dH)
      const dU = dH.clone().multiply(get(ju, k, t))
      const dL = dU.clone().multiply(get(jl, k, t))
      const dF = dL.clone().multiply(get(jf, k, t))
      const P0 = new THREE.Vector3(root[k * 3], root[k * 3 + 1], root[k * 3 + 2]).add(offU.clone().applyQuaternion(dH))
      const K = P0.clone().add(offL.clone().applyQuaternion(dU))
      const A = K.clone().add(offF.clone().applyQuaternion(dL))
      return { dH: dH.clone(), dU, dL, dF, P0, K, A }
    }
    const side = S === 'Left' ? 0 : 1
    const targets = new Array(count)
    if (fixed) {
      const first = chain(0)
      for (let k = 1; k < count; k++) targets[k] = { T: first.A, R: first.dF, w: 1 }
    } else {
      for (let i = 0; i < count;) {
        if (planted[side][i] < 0.999) { i++; continue }
        let j = i
        while (j + 1 < count && planted[side][j + 1] >= 0.999) j++
        const sampleCount = contactFps ? Math.min(j - i + 1, Math.max(2, Math.round(0.15 * contactFps))) : j - i + 1
        const samples = Array.from({ length: sampleCount }, (_, k) => chain(i + k))
        const T = new THREE.Vector3(...['x', 'y', 'z'].map((d) => median(samples.map((c) => c.A[d]))))
        const R = samples[Math.floor(samples.length / 2)].dF
        if (ground) {
          const jt = J[`${S}ToeBase`]
          const heel = new THREE.Vector3(0, -7.4, -6).applyQuaternion(R)
          const toe = V(jt).add(new THREE.Vector3(0, -2.1, 5)).applyQuaternion(R)
          T.y = -Math.min(heel.y, toe.y)
        }
        let start = i, end = j
        while (start > 0 && planted[side][start - 1] > 0 && !targets[start - 1]) start--
        while (end + 1 < count && planted[side][end + 1] > 0 && planted[side][end + 1] < 0.999) end++
        for (let k = start; k <= end; k++) targets[k] = { T, R, w: planted[side][k] }
        i = j + 1
      }
    }
    legs.push({ S, ju, jl, jf, offL, offF, l1, l2, chain, targets })
  }
  if (contactFps && !fixed) {
    // Keep the hips inside both planted legs' reach before solving either leg.
    for (let k = 0; k < count; k++) {
      for (let iteration = 0; iteration < 8; iteration++) {
        for (const leg of legs) {
          const target = leg.targets[k]
          if (!target) continue
          const c = leg.chain(k)
          const toTarget = c.A.clone().lerp(target.T, target.w).sub(c.P0)
          const distance = toTarget.length()
          const excess = distance - (leg.l1 + leg.l2 - 1e-4)
          if (excess > 0) {
            toTarget.multiplyScalar(target.w * excess / distance)
            root[k * 3] += toTarget.x
            root[k * 3 + 1] += toTarget.y
            root[k * 3 + 2] += toTarget.z
          }
        }
      }
    }
  }
  for (const { S, ju, jl, jf, offL, offF, l1, l2, chain, targets } of legs) {
    for (let k = 0; k < count; k++) {
      const target = targets[k]
      if (!target) continue
      const c = chain(k)
      if (!fixed && level) {
        const jt = J[`${S}ToeBase`]
        const toe = get(jt, k, new THREE.Quaternion()).slerp(new THREE.Quaternion(), target.w)
        put(jt, k, toe)
      }
      const T = c.A.clone().lerp(target.T, target.w)
      const Rf = c.dF.clone().slerp(target.R, target.w)
      const u = T.clone().sub(c.P0)
      const dist = u.length()
      if (dist < 1e-6) continue
      u.multiplyScalar(1 / dist)
      // keep the knee bending the way the motion had it: its offset from the hip-ankle line
      const ac = c.A.clone().sub(c.P0).normalize()
      const pole = c.K.clone().sub(c.P0)
      pole.addScaledVector(ac, -pole.dot(ac))
      if (pole.lengthSq() < 1e-8) pole.set(0, 0, 1)
      pole.addScaledVector(u, -pole.dot(u))
      if (pole.lengthSq() < 1e-8) {
        pole.set(Math.abs(u.x) < 0.9 ? 1 : 0, Math.abs(u.x) < 0.9 ? 0 : 1, 0)
        pole.addScaledVector(u, -pole.dot(u))
      }
      pole.normalize()
      const reach = Math.min(Math.max(dist, Math.abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4)
      const a = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach)
      const h = Math.sqrt(Math.max(0, l1 * l1 - a * a))
      const K = c.P0.clone().addScaledVector(u, a).addScaledVector(pole, h)
      const Tc = c.P0.clone().addScaledVector(u, reach)
      // thigh swings to put the knee at K; shank keeps its bend, then swings to put the ankle on the target
      const dU = new THREE.Quaternion().setFromUnitVectors(offL.clone().applyQuaternion(c.dU).normalize(), K.clone().sub(c.P0).normalize()).multiply(c.dU)
      const dLc = dU.clone().multiply(c.dU.clone().invert().multiply(c.dL))
      const dL = new THREE.Quaternion().setFromUnitVectors(offF.clone().applyQuaternion(dLc).normalize(), Tc.clone().sub(K).normalize()).multiply(dLc)
      const dHinv = c.dH.clone().invert()
      const lu = dHinv.clone().multiply(dU)
      const ll = dU.clone().invert().multiply(dL)
      const lf = dL.clone().invert().multiply(Rf)
      for (const [j, q] of [[ju, lu], [jl, ll], [jf, lf]]) {
        const p = k * 4
        if (q.x * rot[j][p] + q.y * rot[j][p + 1] + q.z * rot[j][p + 2] + q.w * rot[j][p + 3] < 0) q.set(-q.x, -q.y, -q.z, -q.w)
        put(j, k, q)
      }
    }
  }
}

// ---- main entry ------------------------------------------------------------------------------------------
// frames: [{ t (s), G: Float32Array(127*9) joint_rotations, jc: Float32Array(127*3) joint_coords,
//            kp3: Float32Array(70*3) keypoints_3d, camT: [x,y,z] }]
// Returns { fps, count, root: Float32Array(count*3) in cm, rot: Float32Array(count*4)[] per BVH joint (local),
//           info: {...} }
export function solveMotion(frames, opts = {}) {
  const o = { outFps: 30, smoothing: 'medium', footLock: true, contactMode: 'ground', levelCamera: true, posture: 'auto', levelFeet: true, limitJoints: true, shoulders: 'slight', ground: 'strict', groundReference: 'feet', lockFeet: false, ...opts }
  if (!frames || frames.length < 2) throw new Error('Need at least two analysed frames.')
  const n = frames.length
  const times = frames.map((f) => f.t)
  for (let i = 1; i < n; i++) if (!(times[i] > times[i - 1])) throw new Error('Frame times must increase.')

  const conv = detectConvention(frames)
  const warnings = []
  if (conv.score < 0.85) warnings.push(`Pose conventions look inconsistent (agreement ${conv.score.toFixed(2)}); results may be wrong.`)

  // 0) camera tilt
  let Rc = new THREE.Quaternion(), tiltDeg = 0
  if (o.levelCamera) {
    const est = estimateUprightCorrection(frames)
    if (est.tiltDeg > 40) warnings.push(`The camera tilt looks like ${est.tiltDeg.toFixed(0)}° (the person may be sitting or lying down), so it was not corrected.`)
    else if (est.tiltDeg > 1) { Rc = est.q; tiltDeg = est.tiltDeg }
  }

  // 1) local rotations relative to rest, per BVH joint
  const J = BVH_JOINTS.length
  const local = Array.from({ length: J }, () => new Float32Array(n * 4))
  const D = Array.from({ length: J }, () => new THREE.Quaternion())
  const qg = new THREE.Quaternion(), l = new THREE.Quaternion()
  for (let i = 0; i < n; i++) {
    const f = frames[i]
    for (let j = 0; j < J; j++) {
      quatFromMat3(f.G, BVH_JOINTS[j].mhr * 9, conv.rotFlip, qg)
      D[j].copy(qg).multiply(REST_INV[BVH_JOINTS[j].mhr]) // world rotation relative to rest
    }
    for (let j = 0; j < J; j++) {
      const p = BVH_JOINTS[j].parent
      if (p < 0) l.copy(Rc).multiply(D[j]) // level the whole body by the camera tilt
      else l.copy(D[p]).invert().multiply(D[j])
      l.normalize()
      if (i > 0) { // keep each joint's track in one hemisphere so interpolation takes the short way
        const k = (i - 1) * 4
        if (l.x * local[j][k] + l.y * local[j][k + 1] + l.z * local[j][k + 2] + l.w * local[j][k + 3] < 0) { l.x *= -1; l.y *= -1; l.z *= -1; l.w *= -1 }
      }
      local[j][i * 4] = l.x; local[j][i * 4 + 1] = l.y; local[j][i * 4 + 2] = l.z; local[j][i * 4 + 3] = l.w
    }
  }

  // 2) anatomical clean-up on the raw samples (before smoothing, so a one-frame spike is not smeared into neighbours)
  let slouchDeg = 0, limitDeg = 0
  if (o.posture !== 'off') slouchDeg = (straightenPosture(local, n, o.posture === 'strong' ? 0 : 0.12) * 180) / Math.PI
  let shoulderDeg = 0
  if (o.shoulders !== 'off') shoulderDeg = lowerShoulders(local, n, o.shoulders)
  if (o.limitJoints) limitDeg = (limitTracks(local, n) * 180) / Math.PI

  // 3) resample to the output rate, then smooth there (zero-phase)
  const grid = makeGrid(times, o.outFps)
  const sm = SMOOTHING[o.smoothing]
  const rot = local.map((track) => {
    const up = resampleQuat(track, grid)
    return sm ? zeroPhaseQuat(up, grid.count, 1 / o.outFps, sm) : up
  })
  if (o.limitJoints) limitTracks(rot, grid.count)

  // 4) root path
  const raw = rootInputs(frames, Rc)
  const pelvis = medianFilter(raw.pelvis, 3), soles = raw.soles.map((x) => medianFilter(x, 3))
  const legCm = o.groundReference === 'body' ? raw.boneLegCm : raw.legCm
  const pelvisUp = resampleVec(pelvis, 3, grid)
  const solesUp = soles.map((s) => resampleVec(s, 3, grid))

  const bodyLowUp = resampleVec(medianFilter(raw.bodyLow, 1), 1, grid)
  const lows = Array.from({ length: grid.count }, (_, i) => o.groundReference === 'body' ? bodyLowUp[i] : Math.min(solesUp[0][i * 3 + 1], solesUp[1][i * 3 + 1])).sort((a, b) => a - b)
  const ground = lows[Math.floor(lows.length * 0.03)]
  // Foot lock works on the RAW path (planted feet share the body's depth jitter exactly, so it cancels), and only
  // then is the path smoothed. Depth is the noisy axis, so it gets the longer window.
  let path = pelvisUp
  let lockSegments = 0
  let planted = [new Float32Array(grid.count), new Float32Array(grid.count)]
  if (o.footLock) {
    const screenContacts = o.contactMode === 'screen' ? screenFootContacts(frames, grid, rot, o.outFps) : null
    if (o.contactMode === 'screen' && !screenContacts) warnings.push('Could not estimate image-space foot contacts; planted-foot cleanup was skipped.')
    const noContacts = planted.map((stance) => ({ stance, blend: stance }))
    const r = footLock(pelvisUp, solesUp, ground, o.outFps, o.contactMode === 'screen' ? (screenContacts || noContacts) : null)
    path = r.path
    lockSegments = r.segments
    planted = r.planted
  }
  const winXY = Math.max(1, Math.round(o.outFps * 0.15)) | 1
  const winZ = Math.max(1, Math.round(o.outFps * 0.4)) | 1
  const col = (d) => Float32Array.from({ length: grid.count }, (_, i) => path[i * 3 + d])
  const px = movingAverage(col(0), winXY), py = movingAverage(col(1), winXY), pz = movingAverage(col(2), winZ)
  const baselineY = o.footLock && o.contactMode === 'screen' ?
    movingAverage(Float32Array.from({ length: grid.count }, (_, i) => pelvisUp[i * 3 + 1]), winXY) : null
  path = new Float32Array(grid.count * 3)
  for (let i = 0; i < grid.count; i++) {
    const w = baselineY ? Math.max(planted[0][i], planted[1][i]) : 1
    path.set([px[i], baselineY ? baselineY[i] + w * (py[i] - baselineY[i]) : py[i], pz[i]], i * 3)
  }

  // 5) planted feet lie flat on the ground
  let footLevelDeg = 0
  if (o.levelFeet && o.footLock) footLevelDeg = levelFeet(rot, grid.count, planted)

  // 5b) strict ground lock: the lowest foot is on the ground on every frame (no floating, no bobbing). Applied to
  // the template skeleton, so it also fixes the hip height the importer later scales the whole root motion by.
  let groundLocked = false
  let lockedY = null
  if (o.ground === 'strict') {
    const hs = groundLockHeights(rot, grid.count)
    lockedY = hs
    groundLocked = true
  }

  // 6) into the template skeleton's units: ground at 0, start at the origin, scaled to the template's leg length
  const templateLeg = Math.abs(MHR_REST_POS_CM[IDX.root * 3 + 1] - MHR_REST_POS_CM[IDX.l_foot * 3 + 1])
  const scale = Math.min(2, Math.max(0.5, templateLeg / Math.max(1, legCm)))
  const root = new Float32Array(grid.count * 3)
  const x0 = path[0], z0 = path[2]
  for (let i = 0; i < grid.count; i++) {
    root[i * 3] = (path[i * 3] - x0) * 100 * scale
    root[i * 3 + 1] = lockedY ? lockedY[i] : (path[i * 3 + 1] - ground) * 100 * scale
    root[i * 3 + 2] = (path[i * 3 + 2] - z0) * 100 * scale
  }

  if (o.lockFeet || o.footLock) lockFeet(rot, root, grid.count, planted, o.lockFeet, o.ground === 'strict' && o.levelFeet, o.levelFeet, o.contactMode === 'screen' ? o.outFps : 0)
  if (o.ground === 'strict') {
    const heights = groundLockHeights(rot, grid.count)
    for (let i = 0; i < grid.count; i++) root[i * 3 + 1] = heights[i]
  }
  if (o.footLock && o.contactMode === 'screen' && !o.lockFeet) {
    const x = root[0], z = root[2]
    for (let i = 0; i < grid.count; i++) { root[i * 3] -= x; root[i * 3 + 2] -= z }
  }

  // How much did the person actually move? Near zero means the model was not looking at them.
  let variationDeg = 0
  for (const name of ['LeftArm', 'RightArm', 'LeftUpLeg', 'RightUpLeg', 'Spine2', 'Head']) variationDeg = Math.max(variationDeg, maxAngleFromFirst(rot[JOINT_INDEX[name]], grid.count))
  if (variationDeg < 4) warnings.push('The pose barely changes between frames. The model probably could not see the person — check the box and the "model view" picture.')

  return { fps: o.outFps, count: grid.count, root, rot, info: { convention: conv, scale, groundM: ground, lockSegments, variationDeg, tiltDeg, slouchDeg, limitDeg, footLevelDeg, shoulderDeg, groundLocked, feetLocked: !!o.lockFeet, warnings } }
}

export { JOINT_INDEX }
