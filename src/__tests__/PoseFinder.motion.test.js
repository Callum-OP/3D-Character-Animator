import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import { solveMotion, detectConvention } from '../three/poseFinder/motion.js'
import { writeBVH } from '../three/poseFinder/bvhWrite.js'
import { BVH_JOINTS, JOINT_INDEX } from '../three/poseFinder/humanoid.js'
import { buildSlotMapping, buildNameMatch } from '../three/bvh.js'
import { fk, makeFrame, IDX, tiltFk } from './helpers/mhrSynth.js'
import { limitJoint, toModelFrame, fromModelFrame } from '../three/poseFinder/limits.js'
import { POSE_PRESETS } from '../three/poseFinder/presets.js'

const E = (x, y, z) => new THREE.Euler(x, y, z)
// the exact-reproduction tests switch the anatomical clean-ups off
const RAW = { levelCamera: false, posture: 'off', limitJoints: false, levelFeet: false }

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
  for (const [rotFlip, coordFlip] of [[false, false], [true, true], [false, true], [true, false]]) {
    it(`recovers conventions for an inverted person (rot=${rotFlip}, coords=${coordFlip})`, () => {
      const fr = Array.from({ length: 8 }, (_, i) => makeFrame(i * 0.1, tiltFk(fk(poseAt(i)), 180), { rotFlip, coordFlip }))
      const c = detectConvention(fr)
      expect(c.coordFlip).toBe(coordFlip)
      expect(c.rotFlip).toBe(rotFlip)
      expect(c.score).toBeGreaterThan(0.99)
    })
  }
})

describe('motion presets', () => {
  it.each([-1, 1])('preserves a full flip (%s direction) and its height changes in the written BVH', (direction) => {
    const fr = Array.from({ length: 21 }, (_, i) => {
      const f = makeFrame(i * 0.1, fk({ root: E(direction * Math.PI * 2 * i / 20, 0, 0) }), { depth: 4 })
      f.camT[1] -= 0.5 * Math.sin(Math.PI * i / 20)
      return f
    })
    const s = solveMotion(fr, { ...POSE_PRESETS.flips.settings, outFps: 10, smoothing: 'off' })
    const parsed = new BVHLoader().parse(writeBVH(s))
    const rot = parsed.clip.tracks.find((t) => t.name === 'Hips.quaternion')
    const position = parsed.clip.tracks.find((t) => t.name === 'Hips.position')
    const middle = new THREE.Quaternion().fromArray(rot.values, 11 * 4)
    expect(middle.angleTo(new THREE.Quaternion())).toBeGreaterThan(3)
    expect(position.values[11 * 3 + 1]).toBeGreaterThan(position.values[1 * 3 + 1] + 20)
    expect(s.info.groundLocked).toBe(false)
  })

  it('preserves a transition from standing to lying down in adaptable mode', () => {
    const fr = Array.from({ length: 20 }, (_, i) => {
      const t = i / 19
      const f = makeFrame(i * 0.1, fk({ root: E(0, 0, t * Math.PI / 2) }), { depth: 4 })
      f.camT[1] += t * 0.65
      return f
    })
    const s = solveMotion(fr, { ...POSE_PRESETS.adaptable.settings, outFps: 10, smoothing: 'off' })
    const clip = new BVHLoader().parse(writeBVH(s)).clip
    const position = clip.tracks.find((t) => t.name === 'Hips.position')
    const rotation = clip.tracks.find((t) => t.name === 'Hips.quaternion')
    expect(position.values[4] - position.values[s.count * 3 + 1]).toBeGreaterThan(30)
    expect(new THREE.Quaternion().fromArray(rotation.values, s.count * 4).angleTo(new THREE.Quaternion())).toBeGreaterThan(1.3)
  })

  it('uses the body rather than raised feet as a reference for lying poses', () => {
    const fr = Array.from({ length: 10 }, (_, i) => makeFrame(i * 0.1, fk({ root: E(0, 0, Math.PI / 2), l_upleg: E(0, 0, 1.4), r_upleg: E(0, 0, 1.4) }), { depth: 4 }))
    const opts = { ...POSE_PRESETS.lying.settings, outFps: 10, smoothing: 'off' }
    const body = solveMotion(fr, opts)
    const feet = solveMotion(fr, { ...opts, groundReference: 'feet' })
    expect(body.root[1]).toBeGreaterThan(feet.root[1] + 10)
    expect(body.info.tiltDeg).toBe(0)
    expect(body.info.groundLocked).toBe(false)
  })
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
  const sol = solveMotion(fr, { outFps: 10, smoothing: 'off', footLock: false, ...RAW })
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
    const s3 = byName.Spine3.getWorldPosition(new THREE.Vector3())
    const fa = byName.LeftForeArm.getWorldPosition(new THREE.Vector3()).sub(s3)
    const i3 = IDX.c_spine3, ia = IDX.l_lowarm
    const armTruth = new THREE.Vector3(truth.pos[ia * 3] - truth.pos[i3 * 3], truth.pos[ia * 3 + 1] - truth.pos[i3 * 3 + 1], truth.pos[ia * 3 + 2] - truth.pos[i3 * 3 + 2]).multiplyScalar(100)
    expect(fa.distanceTo(armTruth), 'LeftForeArm relative to Spine3').toBeLessThan(1.5)
    // positions: compare bone positions relative to the hips (cm), for joints whose chain has no skipped joints
    const hips = byName.Hips.getWorldPosition(new THREE.Vector3())
    // (the spine/neck/head rest is deliberately straightened, so the arm is compared relative to Spine3)
    for (const [name, mhrName] of [['LeftLeg', 'l_lowleg'], ['LeftFoot', 'l_foot'], ['RightLeg', 'r_lowleg']]) {
      const w = byName[name].getWorldPosition(p).sub(hips)
      const i = IDX[mhrName]
      const t = new THREE.Vector3(truth.pos[i * 3], truth.pos[i * 3 + 1], truth.pos[i * 3 + 2]).multiplyScalar(100)
      const root = new THREE.Vector3(truth.pos[IDX.root * 3], truth.pos[IDX.root * 3 + 1], truth.pos[IDX.root * 3 + 2]).multiplyScalar(100)
      expect(w.distanceTo(t.sub(root)), `${name} position`).toBeLessThan(1.5)
    }
  })

  it('classifies frame-flip conventions identically', () => {
    const base = solveMotion(frames(12), { outFps: 10, smoothing: 'off', footLock: false, ...RAW })
    for (const opts of [{ rotFlip: true, coordFlip: true }, { rotFlip: false, coordFlip: true }]) {
      const alt = solveMotion(frames(12, opts), { outFps: 10, smoothing: 'off', footLock: false, ...RAW })
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
    const clean = solveMotion(Array.from({ length: n }, (_, i) => makeFrame(i / 15, fk({ l_lowarm: E(0, sig(i), 0) }))), { outFps: 15, smoothing: 'off', footLock: false, ...RAW })
    const raw = solveMotion(noisy, { outFps: 15, smoothing: 'off', footLock: false, ...RAW })
    const smooth = solveMotion(noisy, { outFps: 15, smoothing: 'medium', footLock: false, ...RAW })
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
    const raw = solveMotion(fr, { outFps: 15, smoothing: 'off', footLock: false, ...RAW })
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

describe('anatomical clean-up', () => {
  const idx = (n) => JOINT_INDEX[n]
  const rzQuat = (name, a) => fromModelFrame(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a)), idx(name))

  it('clamps a fingertip bent backwards by 90 degrees but keeps normal flexion', () => {
    const j = idx('LeftHandIndex3')
    const bad = rzQuat('LeftHandIndex3', -1.5)
    const moved = limitJoint(bad, j)
    expect(moved).toBeGreaterThan(1.3)
    const back = toModelFrame(bad, j)
    expect(2 * Math.atan2(back.z, back.w)).toBeCloseTo(-0.1, 2)
    const ok = rzQuat('LeftHandIndex3', 1.0)
    expect(limitJoint(ok, j)).toBeLessThan(1e-4)
    const flex = toModelFrame(ok, j)
    expect(2 * Math.atan2(flex.z, flex.w)).toBeCloseTo(1.0, 3)
  })

  it('locks the axes a hinge joint does not have (finger phalanx, elbow, knee) and limits the thumb hook', () => {
    const j = idx('RightHandIndex2')
    const q = fromModelFrame(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.6, 0.6, 0.8, 'ZYX')), j)
    limitJoint(q, j)
    const m = toModelFrame(q, j)
    expect(Math.abs(m.x)).toBeLessThan(1e-4)
    expect(Math.abs(m.y)).toBeLessThan(1e-4)
    const t = idx('RightHandThumb2')
    const hook = fromModelFrame(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 1.5, 'ZYX')), t)
    limitJoint(hook, t)
    const th = toModelFrame(hook, t)
    expect(new THREE.Euler().setFromQuaternion(th, 'ZYX').z).toBeCloseTo(1.0, 2) // thumb MCP max 1.0 rad
  })

  const walkFrames = (n, post = {}, tilt = 0) => Array.from({ length: n }, (_, i) => {
    let out = fk({ l_uparm: E(0, 0, 0.3 * Math.sin(i * 0.5)), ...post })
    if (tilt) out = tiltFk(out, tilt)
    return makeFrame(i * 0.1, out, { depth: 4 })
  })
  const hipsTilt = (sol) => { const q = new THREE.Quaternion().fromArray(sol.rot[0], 0); return (q.angleTo(new THREE.Quaternion()) * 180) / Math.PI }

  it('levels a tilted camera so a standing person is upright', () => {
    const fr = walkFrames(20, {}, 15)
    const off = solveMotion(fr, { outFps: 10, smoothing: 'off', footLock: false, levelCamera: false, posture: 'off', limitJoints: false })
    const on = solveMotion(fr, { outFps: 10, smoothing: 'off', footLock: false, levelCamera: true, posture: 'off', limitJoints: false })
    expect(hipsTilt(off)).toBeGreaterThan(12)
    expect(hipsTilt(on)).toBeLessThan(3)
    expect(on.info.tiltDeg).toBeGreaterThan(11)
    expect(on.info.tiltDeg).toBeLessThan(19)
  })

  it('removes a constant slouch from the spine but keeps the movement around it', () => {
    const bend = (a) => ({ c_spine0: rzQuat2('c_spine0', a), c_spine1: rzQuat2('c_spine1', a), c_spine2: rzQuat2('c_spine2', a), c_spine3: rzQuat2('c_spine3', a) })
    function rzQuat2(mhrName, a) { const j = BVH_JOINTS.findIndex((b) => b.name === { c_spine0: 'Spine', c_spine1: 'Spine1', c_spine2: 'Spine2', c_spine3: 'Spine3' }[mhrName]); return rzQuat(BVH_JOINTS[j].name, a) }
    const fr = Array.from({ length: 24 }, (_, i) => makeFrame(i * 0.1, fk(bend(0.3 + 0.08 * Math.sin(i * 0.6))), { depth: 4 }))
    const raw = solveMotion(fr, { outFps: 10, smoothing: 'off', footLock: false, levelCamera: false, posture: 'off', limitJoints: false })
    const fixed = solveMotion(fr, { outFps: 10, smoothing: 'off', footLock: false, levelCamera: false, posture: 'auto', limitJoints: false })
    const totalBend = (s, k) => ['Spine', 'Spine1', 'Spine2', 'Spine3'].reduce((a, n) => {
      const q = new THREE.Quaternion().fromArray(s.rot[idx(n)], k * 4)
      return a + new THREE.Euler().setFromQuaternion(toModelFrame(q, idx(n)), 'ZYX').z
    }, 0)
    const med = (s) => { const v = Array.from({ length: s.count }, (_, k) => totalBend(s, k)).sort((a, b) => a - b); return v[v.length >> 1] }
    expect(med(raw)).toBeGreaterThan(1.0)
    expect(med(fixed)).toBeLessThan(med(raw) - 0.7)
    expect(fixed.info.slouchDeg).toBeGreaterThan(30)
    const swing = (s) => { const v = Array.from({ length: s.count }, (_, k) => totalBend(s, k)); return Math.max(...v) - Math.min(...v) }
    expect(swing(fixed)).toBeGreaterThan(swing(raw) * 0.8) // movement preserved
  })

  it('leaves an already upright person alone', () => {
    const fr = walkFrames(20)
    const s = solveMotion(fr, { outFps: 10, smoothing: 'off', footLock: false })
    expect(s.info.slouchDeg).toBe(0)
    expect(s.info.tiltDeg).toBeLessThan(2)
  })

  it('levels a planted foot that the model tipped up', () => {
    const fr = Array.from({ length: 30 }, (_, i) => makeFrame(i * 0.1, fk({ r_foot: E(-0.45, 0, 0.1) }), { depth: 4 }))
    const footUp = (s) => {
      const names = ['Hips', 'RightUpLeg', 'RightLeg', 'RightFoot']
      const d = new THREE.Quaternion()
      for (const n of names) d.multiply(new THREE.Quaternion().fromArray(s.rot[idx(n)], 15 * 4))
      return (new THREE.Vector3(0, 1, 0).applyQuaternion(d).angleTo(new THREE.Vector3(0, 1, 0)) * 180) / Math.PI
    }
    const base = { outFps: 10, smoothing: 'off', footLock: true, levelCamera: false, posture: 'off', limitJoints: false }
    const off = solveMotion(fr, { ...base, levelFeet: false })
    const on = solveMotion(fr, { ...base, levelFeet: true })
    expect(footUp(off)).toBeGreaterThan(20)
    expect(footUp(on)).toBeLessThan(6)
    expect(on.info.footLevelDeg).toBeGreaterThan(15)
  })
})

describe('ground lock and shoulders', () => {
  const idx = (n) => JOINT_INDEX[n]
  const base = { outFps: 10, smoothing: 'off', footLock: false, levelCamera: false, posture: 'off', limitJoints: false, levelFeet: false, shoulders: 'off' }

  it('strict mode keeps the feet on the ground: hip height ignores bobbing in the model\'s depth/height estimate', () => {
    // standing still, but the model's pelvis height wobbles by +-12 cm
    let seed = 11
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5)
    const fr = Array.from({ length: 30 }, (_, i) => {
      const f = makeFrame(i * 0.1, fk({}), { depth: 4 })
      f.camT[1] += rnd() * 0.24 // shifts every keypoint, incl. the feet, up and down
      return f
    })
    const natural = solveMotion(fr, { ...base, ground: 'natural' })
    const strict = solveMotion(fr, { ...base, ground: 'strict' })
    const spread = (s) => { let lo = Infinity, hi = -Infinity; for (let k = 0; k < s.count; k++) { lo = Math.min(lo, s.root[k * 3 + 1]); hi = Math.max(hi, s.root[k * 3 + 1]) } return hi - lo }
    expect(strict.info.groundLocked).toBe(true)
    expect(spread(strict)).toBeLessThan(1)
    expect(strict.root[1]).toBeGreaterThan(88) // template hip height when the sole is flat on the ground
    expect(strict.root[1]).toBeLessThan(97)
    void natural
  })

  it('strict mode still lowers the hips when the knees bend', () => {
    const fr = Array.from({ length: 20 }, (_, i) => {
      const b = i < 10 ? 0 : 1.0
      return makeFrame(i * 0.1, fk({ l_upleg: E(-b * 0.6, 0, 0), r_upleg: E(-b * 0.6, 0, 0), l_lowleg: E(b * 1.1, 0, 0), r_lowleg: E(b * 1.1, 0, 0) }), { depth: 4 })
    })
    const s = solveMotion(fr, { ...base, ground: 'strict' })
    expect(s.root[1]).toBeGreaterThan(s.root[(s.count - 1) * 3 + 1] + 4) // crouching lowers the hips (the tipped-down foot limits how far)
  })

  it('lowers a shrugged shoulder but keeps the arm pointing where it was', () => {
    const fr = Array.from({ length: 12 }, (_, i) => makeFrame(i * 0.1, fk({ l_clavicle: E(0, 0, 0.35), l_uparm: E(0, 0, -0.35 + 0.1 * Math.sin(i)) }), { depth: 4 }))
    const run = (shoulders) => solveMotion(fr, { ...base, ground: 'off', shoulders })
    const off = run('off'), slight = run('slight'), more = run('more')
    const elev = (s) => {
      const q = new THREE.Quaternion().fromArray(s.rot[idx('LeftShoulder')], 4 * 4)
      const d0 = new THREE.Vector3(14.8, 1.3, -9.6).normalize()
      const d = d0.clone().applyQuaternion(q)
      return Math.atan2(d.y, Math.hypot(d.x, d.z)) - Math.atan2(d0.y, Math.hypot(d0.x, d0.z))
    }
    expect(elev(off)).toBeGreaterThan(0.25)
    expect(elev(slight)).toBeLessThan(elev(off) - 0.1)
    expect(elev(more)).toBeLessThan(elev(slight))
    expect(slight.info.shoulderDeg).toBeGreaterThan(4)
    // world orientation of the upper arm is unchanged
    const worldArm = (s) => { const d = new THREE.Quaternion(); for (const n of ['Hips', 'Spine', 'Spine1', 'Spine2', 'Spine3', 'LeftShoulder', 'LeftArm']) d.multiply(new THREE.Quaternion().fromArray(s.rot[idx(n)], 4 * 4)); return d }
    expect((worldArm(off).angleTo(worldArm(slight)) * 180) / Math.PI).toBeLessThan(0.5)
  })

  it('leaves relaxed shoulders alone', () => {
    const fr = Array.from({ length: 12 }, (_, i) => makeFrame(i * 0.1, fk({ l_uparm: E(0, 0, 0.2 * Math.sin(i)) }), { depth: 4 }))
    const s = solveMotion(fr, { ...base, ground: 'off', shoulders: 'slight' })
    expect(s.info.shoulderDeg).toBeLessThan(2.1) // only the small constant drop
  })
})

describe('baked foot lock', () => {
  const idx = (n) => JOINT_INDEX[n]
  // bent knees, hips swaying 4 cm side to side and dipping, feet planted in the model's own output
  const frames = () => Array.from({ length: 30 }, (_, i) => {
    const fr = makeFrame(i * 0.1, fk({ l_upleg: E(-0.4, 0, 0), r_upleg: E(-0.4, 0, 0), l_lowleg: E(0.8, 0, 0), r_lowleg: E(0.8, 0, 0), c_spine1: E(0, 0.05 * Math.sin(i * 0.6), 0) }), { depth: 4 })
    fr.camT[0] += 0.04 * Math.sin(i * 0.6)
    return fr
  })
  const base = { outFps: 10, smoothing: 'off', footLock: false, levelCamera: false, posture: 'off', limitJoints: false, levelFeet: false, shoulders: 'off', ground: 'strict' }
  const feet = (sol) => {
    const { skeleton, clip } = new BVHLoader().parse(writeBVH({ ...sol }))
    const by = Object.fromEntries(skeleton.bones.map((b) => [b.name, b]))
    const tr = Object.fromEntries(clip.tracks.map((t) => [t.name, t]))
    const out = { pos: [], rot: [] }
    for (let k = 1; k <= sol.count; k++) {
      for (const b of skeleton.bones) { const t = tr[`${b.name}.quaternion`]; if (t) b.quaternion.fromArray(t.values, k * 4) }
      by.Hips.position.fromArray(tr['Hips.position'].values, k * 3)
      by.Hips.updateWorldMatrix(false, true)
      out.pos.push(by.LeftFoot.getWorldPosition(new THREE.Vector3()))
      out.rot.push(by.LeftFoot.getWorldQuaternion(new THREE.Quaternion()))
    }
    return out
  }
  const spread = (pts) => Math.max(...pts.map((p) => p.distanceTo(pts[0])))

  it('keeps the feet at the first frame\'s position and rotation while the hips move', () => {
    const free = feet(solveMotion(frames(), { ...base, lockFeet: false }))
    const locked = feet(solveMotion(frames(), { ...base, lockFeet: true }))
    expect(spread(free.pos)).toBeGreaterThan(1.5) // cm: the hips sway and the feet go with them
    expect(spread(locked.pos)).toBeLessThan(0.5)
    expect(Math.max(...locked.rot.map((q) => (q.angleTo(locked.rot[0]) * 180) / Math.PI))).toBeLessThan(1)
  })

  it('does not change the motion when the lock is off', () => {
    const a = solveMotion(frames(), { ...base, lockFeet: false })
    const b = solveMotion(frames(), { ...base })
    expect(a.info.feetLocked).toBe(false)
    expect(Array.from(a.rot[idx('LeftLeg')])).toEqual(Array.from(b.rot[idx('LeftLeg')]))
  })
})
