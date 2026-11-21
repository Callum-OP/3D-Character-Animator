import { describe, it, expect } from 'vitest'
import { detectLandmarks } from '../three/autoRigDetect.js'
import { guessLandmarks, boxOfPositions, LANDMARK_IDS, validateLandmarks } from '../three/autoRigMath.js'

// A procedural body (point clouds on capsules): no model files, and every joint position is known exactly.
function capsule(out, a, b, r, rings = 60, around = 24) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const len = Math.hypot(...d) || 1
  const w = d.map((c) => c / len)
  const u = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const e1 = norm(cross(w, u))
  const e2 = cross(w, e1)
  for (let i = 0; i <= rings * 3; i++) {
    const t = i / (rings * 3)
    for (let j = 0; j < around; j++) {
      const ang = (j / around) * Math.PI * 2
      const rr = r * (1 + 0.0 * t)
      out.push(a[0] + d[0] * t + rr * (Math.cos(ang) * e1[0] + Math.sin(ang) * e2[0]), a[1] + d[1] * t + rr * (Math.cos(ang) * e1[1] + Math.sin(ang) * e2[1]), a[2] + d[2] * t + rr * (Math.cos(ang) * e1[2] + Math.sin(ang) * e2[2]))
    }
  }
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a) => {
  const l = Math.hypot(...a) || 1
  return a.map((c) => c / l)
}

function body({ pose, hand = 'normal' }) {
  const pts = []
  const H = 1.75
  const armDir = pose === 'T' ? [1, 0, 0] : norm([1, -1.1, 0])
  const j = {
    pelvis: [0, 0.97, 0], spine: [0, 1.08, 0], chest: [0, 1.2, 0], upper_chest: [0, 1.32, 0], neck: [0, 1.46, 0], head: [0, 1.5, 0], head_top: [0, 1.75, 0],
  }
  for (const [side, sx] of [['l', 1], ['r', -1]]) {
    const sh = [sx * 0.17, pose === 'T' ? 1.4 : 1.4, 0]
    const dir = [sx * armDir[0], armDir[1], armDir[2]]
    const at = (t) => [sh[0] + dir[0] * t, sh[1] + dir[1] * t, sh[2] + dir[2] * t]
    j[side + '_shoulder'] = sh
    j[side + '_elbow'] = at(0.29)
    // a big-gloved hand (a wide flat palm, thin fingers) is 0.28 long = 16% of the height, not the usual ~11%
    j[side + '_wrist'] = at(hand === 'big' ? 0.5 : 0.55)
    j[side + '_fingertip'] = at(hand === 'big' ? 0.78 : 0.74)
    j[side + '_hip'] = [sx * 0.085, 0.92, 0]
    j[side + '_knee'] = [sx * 0.085, 0.5, 0.01]
    j[side + '_ankle'] = [sx * 0.085, 0.09, -0.02]
    j[side + '_toe'] = [sx * 0.085, 0.03, 0.1]
    j[side + '_toe_tip'] = [sx * 0.085, 0.025, 0.16]
    capsule(pts, sh, j[side + '_elbow'], 0.045)
    capsule(pts, j[side + '_elbow'], j[side + '_wrist'], 0.038)
    if (hand === 'big') {
      capsule(pts, j[side + '_wrist'], at(0.63), 0.085)
      capsule(pts, at(0.63), j[side + '_fingertip'], 0.02)
    } else capsule(pts, j[side + '_wrist'], j[side + '_fingertip'], 0.03)
    capsule(pts, [sx * 0.085, 0.95, 0], j[side + '_knee'], 0.075)
    capsule(pts, j[side + '_knee'], j[side + '_ankle'], 0.055)
    capsule(pts, [sx * 0.085, 0.04, -0.07], [sx * 0.085, 0.04, 0.16], 0.045)
    capsule(pts, [sx * 0.085, 0.09, -0.02], [sx * 0.085, 0.2, -0.015], 0.05)
  }
  capsule(pts, [0, 0.93, 0], [0, 1.4, 0], 0.15)
  capsule(pts, [0, 1.4, 0], [0, 1.52, 0], 0.055)
  capsule(pts, [0, 1.6, 0], [0, 1.68, 0], 0.095)
  return { pos: new Float32Array(pts), joints: j, H }
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('Auto Rigger mesh-based marker placement', () => {
  for (const pose of ['T', 'A']) {
    it(`finds the arm, leg and foot joints of a ${pose}-pose body from the mesh alone`, () => {
      const { pos, joints } = body({ pose })
      const det = detectLandmarks(pos)
      expect(det.tpose).toBe(pose === 'T')
      for (const id of ['l_fingertip', 'r_fingertip', 'l_wrist', 'r_wrist', 'l_ankle', 'r_ankle', 'l_toe_tip']) {
        expect(dist(det.landmarks[id], joints[id]), `${pose}-pose ${id}`).toBeLessThan(0.06)
      }
      for (const id of ['neck', 'l_hip', 'l_knee']) expect(dist(det.landmarks[id], joints[id]), id).toBeLessThan(0.11)
    })
    it.runIf(pose === 'A')(`beats the bounding-box proportion guess on average (${pose}-pose)`, () => {
      const { pos, joints } = body({ pose })
      const det = detectLandmarks(pos)
      const guess = guessLandmarks(boxOfPositions(pos))
      const mean = (L) => LANDMARK_IDS.reduce((s, id) => s + dist(L[id], joints[id]), 0) / LANDMARK_IDS.length
      expect(mean(det.landmarks)).toBeLessThan(mean(guess))
    })
    it(`always returns every landmark, in a plausible order (${pose}-pose)`, () => {
      const det = detectLandmarks(body({ pose }).pos)
      for (const id of LANDMARK_IDS) expect(det.landmarks[id], id).toHaveLength(3)
      expect(validateLandmarks(det.landmarks)).toEqual([])
    })
  }
  for (const pose of ['T']) {
    it('measures a hand that is much bigger than usual instead of assuming 11.5% of the height', () => {
      const { pos, joints, H } = body({ pose, hand: 'big' })
      const det = detectLandmarks(pos)
      for (const k of ['l', 'r']) {
        expect(dist(det.landmarks[k + '_wrist'], joints[k + '_wrist']), k + ' wrist').toBeLessThan(0.05)
        expect(dist(det.landmarks[k + '_wrist'], det.landmarks[k + '_fingertip']) / H).toBeGreaterThan(0.14)
      }
      expect(det.notes.join(' ')).toMatch(/hand measured at/)
    })
    it('keeps the usual hand length for a normal hand (no note, same wrist as before)', () => {
      const { pos, H } = body({ pose })
      const det = detectLandmarks(pos)
      expect(dist(det.landmarks.l_wrist, det.landmarks.l_fingertip) / H).toBeCloseTo(0.115, 2)
      expect(det.notes.join(' ')).not.toMatch(/hand measured at/)
    })
  }
  it('depth (Z) comes from the body: a body standing off-centre in Z gets markers at that depth', () => {
    const { pos } = body({ pose: 'T' })
    const shifted = pos.map((v, i) => (i % 3 === 2 ? v + 0.4 : v))
    const det = detectLandmarks(shifted)
    for (const id of ['pelvis', 'neck', 'l_knee', 'l_ankle', 'l_wrist']) expect(Math.abs(det.landmarks[id][2] - 0.4), id).toBeLessThan(0.08)
  })
  it('falls back to proportions, with a note, when there is nothing to analyse', () => {
    const det = detectLandmarks(new Float32Array([0, 0, 0, 1, 1, 1]))
    expect(det.notes.join(' ')).toMatch(/too little geometry/)
    expect(Object.keys(det.landmarks)).toHaveLength(LANDMARK_IDS.length)
  })
  it('notes it when the legs touch and the crotch is not measurable', () => {
    const { pos } = body({ pose: 'T' })
    // fill the gap between the legs with a thick thigh column so the middle line is occupied low down
    const extra = []
    capsule(extra, [0, 0.4, 0], [0, 0.95, 0], 0.06, 200, 24)
    const merged = new Float32Array(pos.length + extra.length)
    merged.set(pos)
    merged.set(extra, pos.length)
    const det = detectLandmarks(merged)
    expect(det.notes.join(' ')).toMatch(/legs touch/)
    expect(validateLandmarks(det.landmarks)).toEqual([])
  })
})
