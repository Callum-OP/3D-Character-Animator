import { describe, it, expect } from 'vitest'
import { LANDMARK_IDS, guessLandmarks, toPayload, validateLandmarks, mirrorId, mirrorPoint, boxOfPositions } from '../three/autoRigMath.js'

const tBox = { min: [-1, 0, -0.2], max: [1, 1.8, 0.25] }
const aBox = { min: [-0.45, 0, -0.2], max: [0.45, 1.8, 0.25] }

describe('Auto Rigger landmarks', () => {
  it('has 25 unique landmarks and a mirror for every side landmark', () => {
    expect(new Set(LANDMARK_IDS).size).toBe(LANDMARK_IDS.length)
    expect(LANDMARK_IDS).toHaveLength(7 + 9 * 2)
    expect(mirrorId('l_knee')).toBe('r_knee')
    expect(mirrorId('r_wrist')).toBe('l_wrist')
    expect(mirrorId('pelvis')).toBeNull()
  })
  it('guesses a plausible skeleton for T-pose and A-pose boxes', () => {
    for (const box of [tBox, aBox]) {
      expect(validateLandmarks(guessLandmarks(box))).toEqual([])
    }
    const t = guessLandmarks(tBox)
    expect(t.l_fingertip[0]).toBeCloseTo(1) // T-pose: arm reaches the box edge
    expect(t.l_wrist[1]).toBeCloseTo(t.l_shoulder[1])
    const a = guessLandmarks(aBox)
    expect(a.l_wrist[1]).toBeLessThan(a.l_shoulder[1]) // A-pose: arm hangs down
  })
  it('mirrors about the pelvis plane and fills missing right-side points', () => {
    const m = mirrorPoint([0.3, 1, 0.1], 0.1)
    expect(m[0]).toBeCloseTo(-0.1)
    expect(m.slice(1)).toEqual([1, 0.1])
    const g = guessLandmarks(tBox)
    const partial = {}
    for (const k of LANDMARK_IDS) if (!k.startsWith('r_')) partial[k] = g[k]
    const p = toPayload(partial)
    expect(p.r_knee[0]).toBeCloseTo(-g.l_knee[0])
    expect(Object.keys(p)).toHaveLength(LANDMARK_IDS.length)
  })
  it('reports real problems', () => {
    const g = guessLandmarks(tBox)
    expect(validateLandmarks({ ...g, head_top: [0, 0.2, 0] }).join(' ')).toMatch(/Top of head/)
    expect(validateLandmarks({ ...g, l_knee: [g.l_knee[0], 0.01, 0] }).join(' ')).toMatch(/knee/)
    expect(validateLandmarks({ ...g, l_shoulder: [-0.2, 1.45, 0], r_shoulder: [0.2, 1.45, 0] }).join(' ')).toMatch(/left side/)
    const missing = { ...g }
    delete missing.pelvis
    expect(validateLandmarks(missing).join(' ')).toMatch(/Missing landmark: pelvis/)
  })
  it('measures a bounding box', () => {
    expect(boxOfPositions(new Float32Array([0, 1, 2, -1, 3, 0]))).toEqual({ min: [-1, 1, 0], max: [0, 3, 2] })
  })
})

import { moveLandmark, enforceMirror, createHistory } from '../three/autoRigMath.js'
import { estimateRigSeconds, etaSeconds, formatDuration } from '../three/autoRig.js'

describe('Auto Rigger marker editing', () => {
  const g = guessLandmarks({ min: [-1, 0, -0.2], max: [1, 1.8, 0.25] })
  const axisX = 0
  it('locks centre markers to the middle line while mirror is on', () => {
    const moved = moveLandmark(g, 'neck', { x: 0.4, y: 1.5 }, { mirror: true, axisX })
    expect(moved.neck[0]).toBe(axisX)
    expect(moved.neck[1]).toBe(1.5)
    const free = moveLandmark(g, 'neck', { x: 0.4, y: 1.5 }, { mirror: false, axisX })
    expect(free.neck[0]).toBe(0.4)
  })
  it('drags the opposite side with a left/right marker only when mirror is on', () => {
    const on = moveLandmark(g, 'l_elbow', { x: 0.7, y: 1.3 }, { mirror: true, axisX })
    expect(on.r_elbow[0]).toBeCloseTo(-0.7)
    expect(on.r_elbow[1]).toBeCloseTo(1.3)
    const off = moveLandmark(g, 'l_elbow', { x: 0.7, y: 1.3 }, { mirror: false, axisX })
    expect(off.r_elbow).toEqual(g.r_elbow)
  })
  it('front view never changes depth (z), on the marker or on its mirror partner', () => {
    const uneven = { ...g, l_knee: [g.l_knee[0], g.l_knee[1], 0.05], r_knee: [g.r_knee[0], g.r_knee[1], -0.03] }
    const m = moveLandmark(uneven, 'l_knee', { x: 0.2, y: 0.45 }, { mirror: true, axisX })
    expect(m.l_knee[2]).toBe(0.05)
    expect(m.r_knee[2]).toBe(-0.03) // the other leg keeps its own depth
    expect(m.r_knee[0]).toBeCloseTo(-0.2)
    expect(m.r_knee[1]).toBeCloseTo(0.45)
    const c = moveLandmark({ ...g, neck: [0, 1.5, 0.07] }, 'neck', { x: 0.3, y: 1.52 }, { mirror: true, axisX })
    expect(c.neck[2]).toBe(0.07)
  })
  it('side view never changes sideways position (x), on the marker or on its mirror partner', () => {
    const uneven = { ...g, l_knee: [0.11, g.l_knee[1], 0], r_knee: [-0.09, g.r_knee[1], 0] }
    const m = moveLandmark(uneven, 'l_knee', { z: 0.1, y: 0.5 }, { mirror: true, axisX })
    expect(m.l_knee[0]).toBe(0.11)
    expect(m.r_knee[0]).toBe(-0.09)
    expect(m.r_knee[2]).toBeCloseTo(0.1)
    expect(m.r_knee[1]).toBeCloseTo(0.5)
  })
  it('side view moves depth (z) and mirrors it to the other side', () => {
    const m = moveLandmark(g, 'l_knee', { z: 0.1, y: 0.5 }, { mirror: true, axisX })
    expect(m.r_knee[2]).toBeCloseTo(0.1)
    expect(m.l_knee[0]).toBe(g.l_knee[0]) // x untouched in side view
  })
  it('enforceMirror snaps the centre onto the line and rebuilds the right side', () => {
    const messy = { ...g, spine: [0.3, 1.1, 0], r_wrist: [-0.1, 1, 0] }
    const fixed = enforceMirror(messy, 0)
    expect(fixed.spine[0]).toBe(0)
    expect(fixed.r_wrist[0]).toBeCloseTo(-fixed.l_wrist[0])
  })
})

describe('Auto Rigger undo / redo history', () => {
  it('undoes and redoes snapshots, and a new edit clears redo', () => {
    const h = createHistory()
    expect(h.canUndo()).toBe(false)
    h.push('a')
    h.push('b')
    expect(h.undo('c')).toBe('b')
    expect(h.undo('b')).toBe('a')
    expect(h.undo('a')).toBeNull()
    expect(h.redo('a')).toBe('b')
    expect(h.canRedo()).toBe(true)
    h.push('x')
    expect(h.canRedo()).toBe(false)
  })
  it('is capped', () => {
    const h = createHistory(3)
    for (let i = 0; i < 10; i++) h.push(i)
    let n = 0
    while (h.undo('cur') !== null) n++
    expect(n).toBe(3)
  })
})

describe('Auto Rigger time estimates', () => {
  it('gives a range that grows with the model and scales with the machine', () => {
    const small = estimateRigSeconds(10000)
    const big = estimateRigSeconds(200000)
    expect(big.high).toBeGreaterThan(small.high)
    expect(small.low).toBeLessThan(small.high)
    expect(estimateRigSeconds(50000, 2).high).toBeGreaterThan(estimateRigSeconds(50000, 1).high)
  })
  it('only gives an ETA once progress means something, and extrapolates from it', () => {
    expect(etaSeconds(0.05, 20)).toBeNull()
    expect(etaSeconds(0.5, 1)).toBeNull()
    expect(etaSeconds(0.5, 30)).toBeCloseTo(30)
    expect(etaSeconds(1, 40)).toBe(0)
  })
  it('formats durations', () => {
    expect(formatDuration(8)).toBe('8s')
    expect(formatDuration(125)).toBe('2m 05s')
    expect(formatDuration(null)).toBe('')
  })
})
