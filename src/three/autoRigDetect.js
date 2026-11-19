// Auto Rigger: read the landmarks off the MESH instead of guessing them from the bounding box.
// Pure maths over a Float32Array of world-space positions (no three.js, no DOM).
// Space: Y up, the character faces +Z, the character's LEFT is +X (same as autoRigMath.js).
//
// What it finds (all of it from the vertices, in both views):
//   * the middle line (torso centre) and the head top
//   * the neck (narrowest part above the shoulders) and the crotch (where the legs separate)
//   * each leg's centre line, knee and ankle (the ankle is where the foot's length ends), the ball of
//     the foot and the toe tip
//   * each arm: hand tip, wrist, elbow and shoulder, for arms held out (T-pose) or angled down (A-pose)
//   * the depth (Z) centre of every joint, from the cross-section of the body at that height, so the side
//     view starts in the right place too
// Anything it cannot find with confidence falls back to the proportion guess, and `notes` says what.

import { guessLandmarks } from './autoRigMath.js'

const BINS = 800

function makeSlicer(pos, minY, H) {
  const n = pos.length / 3
  const buckets = Array.from({ length: BINS + 1 }, () => [])
  for (let i = 0; i < n; i++) {
    const b = Math.min(BINS, Math.max(0, Math.floor(((pos[i * 3 + 1] - minY) / H) * BINS)))
    buckets[b].push(i)
  }
  // all vertex indices with y in [y0, y1]
  const range = (y0, y1) => {
    const b0 = Math.max(0, Math.floor(((y0 - minY) / H) * BINS))
    const b1 = Math.min(BINS, Math.ceil(((y1 - minY) / H) * BINS))
    const out = []
    for (let b = b0; b <= b1; b++) for (const i of buckets[b]) if (pos[i * 3 + 1] >= y0 && pos[i * 3 + 1] <= y1) out.push(i)
    return out
  }
  return { range }
}

function stats(pos, idx, keep = () => true) {
  let n = 0
  let sx = 0
  let sz = 0
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const i of idx) {
    const x = pos[i * 3]
    const y = pos[i * 3 + 1]
    const z = pos[i * 3 + 2]
    if (!keep(x, y, z)) continue
    n++
    sx += x
    sz += z
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return n ? { n, cx: sx / n, cz: sz / n, minX, maxX, minZ, maxZ, minY, maxY } : { n: 0 }
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

export function detectLandmarks(pos) {
  const n = pos.length / 3
  const notes = []
  const box = boxOf(pos)
  const H = box.max[1] - box.min[1]
  const guess = guessLandmarks(box)
  if (n < 200 || H <= 0) return { landmarks: guess, notes: ['too little geometry to analyse; using proportions'], detected: [] }
  const minY = box.min[1]
  const yAt = (f) => minY + f * H
  const sl = makeSlicer(pos, minY, H)
  const detected = []
  const L = { ...guess }

  // ---- middle line: median x of the torso band ----
  const bcx = (box.min[0] + box.max[0]) / 2
  const torso = sl.range(yAt(0.55), yAt(0.72))
  const cx = median(torso.filter((i) => Math.abs(pos[i * 3] - bcx) < 0.2 * H).map((i) => pos[i * 3]))
  const sideSign = (x) => (x >= cx ? 1 : -1)

  // ---- head top: highest vertex near the middle line (a raised hand must not count) ----
  const central = (x) => Math.abs(x - cx) < 0.12 * H
  const headTopY = stats(pos, sl.range(yAt(0.8), box.max[1]), (x) => central(x)).maxY
  if (Number.isFinite(headTopY)) L.head_top = [cx, headTopY, guess.head_top[2]] // depth fixed up once the neck is known
  const top = Number.isFinite(headTopY) ? headTopY : box.max[1]

  // ---- neck: narrowest central width between 0.80H and 0.93H ----
  let neckY = null
  {
    let best = Infinity
    for (let f = 0.8; f <= 0.93; f += 0.004) {
      const s = stats(pos, sl.range(yAt(f) - 0.004 * H, yAt(f) + 0.004 * H), (x) => Math.abs(x - cx) < 0.1 * H)
      if (s.n < 20) continue
      const w = s.maxX - s.minX
      if (w < best) {
        best = w
        neckY = yAt(f)
      }
    }
    if (neckY != null) detected.push('neck')
  }
  const neckBase = neckY != null ? neckY - 0.025 * H : guess.neck[1]
  const neckSlice = stats(pos, sl.range(neckBase - 0.01 * H, neckBase + 0.01 * H), (x) => central(x))
  // Mixamo's spine joints sit ~1-2 cm in FRONT of the centroid of the body's cross-section (the centroid includes
  // the back of the neck and the chest); detected depths were all 1-2 cm too far back, which carried the whole
  // body back when a Mixamo pose was applied
  const neckZ = (neckSlice.n ? neckSlice.cz : guess.neck[2]) + 0.012 * H
  L.neck = [cx, neckBase, neckZ]
  L.head = [cx, neckBase + 0.03 * H, neckZ]
  if (Number.isFinite(headTopY)) L.head_top = [cx, headTopY, neckZ]

  // ---- crotch: first height (going up) where the middle line is occupied ----
  // The legs part company between ~42% and ~56% of the height. If the middle line is already occupied
  // below that (legs touching from the knees up), there is no gap to see: use a typical crotch height.
  let crotchY = null
  const occupied = (f) => stats(pos, sl.range(yAt(f) - 0.004 * H, yAt(f) + 0.004 * H), (x) => Math.abs(x - cx) < 0.02 * H).n >= 6
  if (!occupied(0.42)) {
    for (let f = 0.42; f <= 0.58; f += 0.004) {
      if (occupied(f)) {
        crotchY = yAt(f)
        break
      }
    }
  }
  if (crotchY != null) detected.push('crotch')
  else {
    crotchY = yAt(0.47)
    notes.push('the legs touch, so the crotch height is a typical one rather than measured')
  }

  // ---- spine from crotch to neck ----
  const pel = crotchY + 0.2 * (neckBase - crotchY)
  const pelS = stats(pos, sl.range(pel - 0.01 * H, pel + 0.01 * H), (x) => Math.abs(x - cx) < 0.1 * H)
  const pelZ = pelS.n ? pelS.cz + 0.006 * H : neckZ
  const place = (t) => [cx, pel + t * (neckBase - pel), pelZ + t * (neckZ - pelZ)]
  L.pelvis = [cx, pel, pelZ]
  L.spine = place(0.2)
  L.chest = place(0.434) // Mixamo spacing: Spine 0.2, Spine1 0.434, Spine2 0.70 of the way from hips to neck
  L.upper_chest = place(0.7)

  // ---- legs ----
  for (const sgn of [1, -1]) {
    const k = sgn > 0 ? 'l' : 'r'
    const side = (x) => sgn * (x - cx) > 0.012 * H
    // foot: everything on this side near the floor
    const footAll = sl.range(minY, yAt(0.2))
    const foot = stats(pos, footAll, (x) => side(x) && Math.abs(x - cx) < 0.2 * H)
    if (foot.n < 30) {
      notes.push(`no ${sgn > 0 ? 'left' : 'right'} foot found; legs use proportions`)
      continue
    }
    // ankle: going up from the sole, the foot's front-to-back length collapses to the leg's depth
    const floorLen = foot.maxZ - foot.minZ
    let ankleY = null
    for (let f = 0.02; f <= 0.2; f += 0.003) {
      const s = stats(pos, sl.range(yAt(f) - 0.006 * H, yAt(f) + 0.006 * H), (x) => side(x) && Math.abs(x - cx) < 0.2 * H)
      if (s.n < 10) continue
      if (s.maxZ - s.minZ < 0.6 * floorLen) {
        ankleY = yAt(f) + 0.01 * H
        break
      }
    }
    if (ankleY == null) ankleY = yAt(0.077)
    else detected.push(`${k}_ankle`)
    const legAtAnkle = stats(pos, sl.range(ankleY + 0.04 * H, ankleY + 0.08 * H), (x) => side(x) && Math.abs(x - cx) < 0.2 * H)
    const ax = legAtAnkle.n ? legAtAnkle.cx : cx + sgn * 0.037 * H
    const az = legAtAnkle.n ? legAtAnkle.cz : foot.minZ + 0.35 * floorLen
    L[`${k}_ankle`] = [ax, ankleY, az]
    const footBottom = foot.minY
    L[`${k}_toe_tip`] = [ax, footBottom + 0.011 * H, foot.maxZ]
    L[`${k}_toe`] = [ax, footBottom + 0.011 * H, foot.maxZ - 0.045 * H]
    // hip: just under the crotch, at the centre of this leg's cross-section
    const thigh = stats(pos, sl.range(crotchY - 0.06 * H, crotchY - 0.02 * H), (x) => side(x) && Math.abs(x - cx) < 0.2 * H)
    // the hip joint sits inside the thigh's centre line, so x is pulled in from the slice centroid
    const hip = [thigh.n ? cx + (thigh.cx - cx) * 0.78 : cx + sgn * 0.035 * H, crotchY + 0.045 * H, thigh.n ? thigh.cz : az]
    L[`${k}_hip`] = hip
    // knee: 54% of the way from hip to ankle, following the leg's own centre line at that height
    const ky = hip[1] + (ankleY - hip[1]) * 0.54
    const kn = stats(pos, sl.range(ky - 0.02 * H, ky + 0.02 * H), (x) => side(x) && Math.abs(x - cx) < 0.2 * H)
    L[`${k}_knee`] = [kn.n ? cx + (kn.cx - cx) * 0.9 : ax, ky, kn.n ? kn.cz : az]
    detected.push(`${k}_hip`, `${k}_knee`, `${k}_toe`)
  }

  // ---- arms ----
  let tposeVotes = 0
  let armsFound = 0
  for (const sgn of [1, -1]) {
    const k = sgn > 0 ? 'l' : 'r'
    // hand tip: the farthest vertices out to this side (above knee height, so a skirt or tail cannot win)
    const cand = sl.range(yAt(0.35), top)
    let far = -Infinity
    for (const i of cand) far = Math.max(far, sgn * (pos[i * 3] - cx))
    const tipPts = cand.filter((i) => sgn * (pos[i * 3] - cx) > far - 0.012 * H)
    const tip = stats(pos, tipPts)
    if (!tip.n || far < 0.22 * H) {
      notes.push(`${sgn > 0 ? 'left' : 'right'} arm not found sticking out; using proportions`)
      continue
    }
    const tipP = [tip.cx, (tip.minY + tip.maxY) / 2, tip.cz]
    // held out level with the shoulders (T-pose) or angled down (A-pose)?
    const tpose = tipP[1] > neckBase - 0.12 * H
    armsFound++
    if (tpose) tposeVotes++
    // shoulder: out to the edge of the torso (measured just below the arms), and level with the arm.
    // T-pose: the arm's own height and depth. A-pose: a typical spot under the neck.
    const torsoHalf = (() => {
      const q = stats(pos, sl.range(yAt(0.7) - 0.01 * H, yAt(0.7) + 0.01 * H), (x) => Math.abs(x - cx) < 0.2 * H)
      return q.n ? (q.maxX - q.minX) / 2 : 0.08 * H
    })()
    const shoulderX = cx + sgn * torsoHalf * 1.12
    const shoulder = tpose ? [shoulderX, tipP[1], tipP[2]] : [shoulderX, neckBase - 0.032 * H, neckZ]
    // wrist: a hand is ~11.5% of the height; elbow ~46% of the way from shoulder to wrist
    const dir = norm3(sub3(tipP, shoulder))
    const wrist = add3(tipP, scale3(dir, -0.115 * H))
    const elbow = lerp3(shoulder, wrist, 0.46)
    // keep the arm's own height/depth at each joint in a T-pose (the arm is rarely perfectly level)
    if (tpose) {
      for (const p of [wrist, elbow]) {
        const s = stats(pos, sl.range(tipP[1] - 0.1 * H, tipP[1] + 0.1 * H), (x) => Math.abs(x - p[0]) < 0.012 * H)
        if (s.n > 15) {
          p[1] = (s.minY + s.maxY) / 2
          p[2] = s.cz
        }
      }
    }
    L[`${k}_shoulder`] = shoulder
    L[`${k}_elbow`] = elbow
    L[`${k}_wrist`] = wrist
    L[`${k}_fingertip`] = tipP
    detected.push(`${k}_shoulder`, `${k}_wrist`, `${k}_fingertip`)
  }
  return { landmarks: L, notes, detected, tpose: armsFound > 0 && tposeVotes === armsFound, height: H, centreX: cx }
}

function boxOf(pos) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k]
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
  }
  return { min, max }
}
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const norm3 = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
