import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import { solveMotion, detectConvention } from '../three/poseFinder/motion.js'
import { writeBVH } from '../three/poseFinder/bvhWrite.js'
import { BVH_JOINTS, JOINT_INDEX } from '../three/poseFinder/humanoid.js'
import { buildSlotMapping, buildNameMatch } from '../three/bvh.js'
import { fk, makeFrame, IDX } from './helpers/mhrSynth.js'

const E = (x, y, z) => new THREE.Euler(x, y, z)

function poseAt(i) {
  const a = Math.sin(i * 0.7)
  return {
    l_uparm: E(0, 0, 0.6 * a),
    l_lowarm: E(0, 0.8 + 0.3 * a, 0),
    r_upleg: E(0.5 * a, 0, 0),
    r_lowleg: E(-0.4 * Math.abs(a), 0, 0),
    l_index1: E(0, 0, 0.7),
    c_spine1: E(0.1 * a, 0.2, 0),
    c_head: E(0, 0.3 * a, 0),
  }
}

function frames(n, opts) {
  return Array.from({ length: n }, (_, i) => makeFrame(i * 0.1, fk(poseAt(i), [0, 0.924, 0]), opts))
}

describe('detectConvention', () => {
  for (const [rotFlip, coordFlip] of [[false, false], [true, true], [false, true], [true, false]]) {
    it(`recovers rot=${rotFlip} coords=${coordFlip}`, () => {
      const c = detectConvention(frames(12, { rotFlip, coordFlip }))
      expect(c.coordFlip).toBe(coordFlip)
      expect(c.rotFlip).toBe(rotFlip)
      expect(c.score).toBeGreaterThan(0.99)
    })
  }
})

describe('humanoid skeleton', () => {
  it('names are all understood by the app BVH importer', () => {
    const names = BVH_JOINTS.map((j) => j.name)
    // a typical Mixamo-style character as the retarget target
    const target = ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Spine1', 'mixamorig:Spine2', 'mixamorig:Neck', 'mixamorig:Head',
      'mixamorig:LeftShoulder', 'mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHand',
      'mixamorig:RightShoulder', 'mixamorig:RightArm', 'mixamorig:RightForeArm', 'mixamorig:RightHand',
      'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'mixamorig:LeftFoot', 'mixamorig:LeftToeBase',
      'mixamorig:RightUpLeg', 'mixamorig:RightLeg', 'mixamorig:RightFoot', 'mixamorig:RightToeBase']
    const slots = buildSlotMapping(target, names)
    for (const s of slots) {
      expect(s.target, `target ${s.key}`).not.toBe('')
      expect(s.source, `source ${s.key}`).not.toBe('')
    }
    expect(slots.find((s) => s.key === 'hips').source).toBe('Hips')
    expect(slots.find((s) => s.key === 'hand.L').source).toBe('LeftHand')
    expect(slots.find((s) => s.key === 'lowerLeg.R').source).toBe('RightLeg')
    // fingers match a Mixamo-style target by finger slot
    const m = buildNameMatch(['mixamorig:LeftHandIndex2', 'mixamorig:RightHandThumb1', 'mixamorig:LeftHandPinky3'], names)
    expect(m['mixamorig:LeftHandIndex2']).toBe('LeftHandIndex2')
    expect(m['mixamorig:RightHandThumb1']).toBe('RightHandThumb1')
    expect(m['mixamorig:LeftHandPinky3']).toBe('LeftHandPinky3')
  })
})

describe('solveMotion + writeBVH round trip', () => {
  const n = 24
  const fr = frames(n)
  const sol = solveMotion(fr, { outFps: 10, smoothing: 'off', footLock: false })
  const text = writeBVH({ ...sol })
  const parsed = new BVHLoader().parse(text)

  it('writes a hierarchy the three.js loader reads', () => {
    expect(parsed.skeleton.bones.filter((b) => b.name !== 'ENDSITE').map((b) => b.name).sort()).toEqual(BVH_JOINTS.map((j) => j.name).sort())
    expect(parsed.clip.tracks.find((t) => t.name === 'Hips.position').times.length).toBe(sol.count + 1)
  })

  it('first frame is a neutral rest frame', () => {
    const t = parsed.clip.tracks.find((t) => t.name === 'LeftArm.quaternion')
    expect([...t.values.slice(0, 4)].map((v) => +v.toFixed(4))).toEqual([0, 0, 0, 1])
  })

  it('reproduces the posed world rotations and joint positions of the MHR skeleton', () => {
    const k = 7 // an analysed frame (outFps === sample fps here)
    const bones = parsed.skeleton.bones
    const byName = Object.fromEntries(bones.map((b) => [b.name, b]))
    for (const b of bones.filter((b) => b.name !== 'ENDSITE')) {
      const tr = parsed.clip.tracks.find((t) => t.name === `${b.name}.quaternion`)
      b.quaternion.fromArray(tr.values, (k + 1) * 4)
    }
    const pt = parsed.clip.tracks.find((t) => t.name === 'Hips.position')
    byName.Hips.position.fromArray(pt.values, (k + 1) * 3)
    byName.Hips.updateWorldMatrix(false, true)
    const truth = fk(poseAt(k))
    const q = new THREE.Quaternion(), p = new THREE.Vector3()
    for (const name of ['LeftArm', 'LeftForeArm', 'LeftHandIndex1', 'RightUpLeg', 'RightLeg', 'Head', 'Spine1']) {
      const b = byName[name]
      const mhr = BVH_JOINTS[JOINT_INDEX[name]].mhr
      // world rotation delta must match the synthetic skeleton's accumulated delta
      b.getWorldQuaternion(q)
      expect(q.angleTo(truth.deltas[mhr]), `${name} rotation`).toBeLessThan(0.02)
    }
    // positions: compare bone positions relative to the hips (cm), for joints whose chain has no skipped joints
    const hips = byName.Hips.getWorldPosition(new THREE.Vector3())
    for (const [name, mhrName] of [['LeftLeg', 'l_lowleg'], ['LeftFoot', 'l_foot'], ['RightLeg', 'r_lowleg'], ['LeftForeArm', 'l_lowarm']]) {
      const w = byName[name].getWorldPosition(p).sub(hips)
      const i = IDX[mhrName]
      const t = new THREE.Vector3(truth.pos[i * 3], truth.pos[i * 3 + 1], truth.pos[i * 3 + 2]).multiplyScalar(100)
      const root = new THREE.Vector3(truth.pos[IDX.root * 3], truth.pos[IDX.root * 3 + 1], truth.pos[IDX.root * 3 + 2]).multiplyScalar(100)
      expect(w.distanceTo(t.sub(root)), `${name} position`).toBeLessThan(1.5)
    }
  })

  it('classifies frame-flip conventions identically', () => {
    const base = solveMotion(frames(12), { outFps: 10, smoothing: 'off', footLock: false })
    for (const opts of [{ rotFlip: true, coordFlip: true }, { rotFlip: false, coordFlip: true }]) {
      const alt = solveMotion(frames(12, opts), { outFps: 10, smoothing: 'off', footLock: false })
      for (const j of [JOINT_INDEX.LeftArm, JOINT_INDEX.RightUpLeg]) {
        for (let k = 0; k < base.count; k++) {
          const a = new THREE.Quaternion().fromArray(base.rot[j], k * 4), b = new THREE.Quaternion().fromArray(alt.rot[j], k * 4)
          expect(a.angleTo(b)).toBeLessThan(0.01)
        }
      }
    }
  })
})

describe('smoothing and foot lock', () => {
  it('smoothing removes jitter without wrecking the motion', () => {
    const n = 60
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.16
    const sig = (i) => 0.8 * Math.sin(i * 0.35)
    const noisy = Array.from({ length: n }, (_, i) => makeFrame(i / 15, fk({ l_lowarm: E(0, sig(i) + rnd(), 0) })))
    const clean = solveMotion(Array.from({ length: n }, (_, i) => makeFrame(i / 15, fk({ l_lowarm: E(0, sig(i), 0) }))), { outFps: 15, smoothing: 'off', footLock: false })
    const raw = solveMotion(noisy, { outFps: 15, smoothing: 'off', footLock: false })
    const smooth = solveMotion(noisy, { outFps: 15, smoothing: 'medium', footLock: false })
    const j = JOINT_INDEX.LeftForeArm
    const Q = (s, k) => new THREE.Quaternion().fromArray(s.rot[j], k * 4)
    // roughness = mean angle between a frame and the average of its neighbours
    const rough = (s) => { let e = 0; for (let k = 2; k < n - 2; k++) e += Q(s, k).angleTo(Q(s, k - 1).clone().slerp(Q(s, k + 1), 0.5)); return e / (n - 4) }
    const err = (s) => { let e = 0; for (let k = 4; k < n - 4; k++) e += Q(s, k).angleTo(Q(clean, k)); return e / (n - 8) }
    expect(rough(smooth)).toBeLessThan(rough(raw) * 0.75)
    expect(err(smooth)).toBeLessThan(err(raw) + 0.02) // within ~1 degree of extra distortion
  })

  it('foot lock steadies a planted foot against depth noise and puts the body on the ground', () => {
    const n = 45
    let seed = 3
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5)
    // standing still, but depth (camera z) jitters +-8 cm and height wobbles
    const fr = Array.from({ length: n }, (_, i) => makeFrame(i / 15, fk({}), { depth: 3 + rnd() * 0.16 }))
    const raw = solveMotion(fr, { outFps: 15, smoothing: 'off', footLock: false })
    const locked = solveMotion(fr, { outFps: 15, smoothing: 'off', footLock: true })
    const spread = (s) => { let lo = Infinity, hi = -Infinity; for (let k = 0; k < s.count; k++) { lo = Math.min(lo, s.root[k * 3 + 2]); hi = Math.max(hi, s.root[k * 3 + 2]) } return hi - lo }
    expect(locked.info.lockSegments).toBeGreaterThan(0)
    expect(spread(locked)).toBeLessThan(spread(raw) * 0.5)
    // standing upright: hips about leg-length above the ground
    expect(locked.root[1]).toBeGreaterThan(70)
    expect(locked.root[1]).toBeLessThan(100)
  })

  it('output frame count follows the output fps, and the root starts at the origin', () => {
    const s = solveMotion(frames(11), { outFps: 30, smoothing: 'low', footLock: false })
    expect(s.count).toBe(31)
    expect(s.root[0]).toBeCloseTo(0, 3)
    expect(s.root[2]).toBeCloseTo(0, 3)
  })
})
