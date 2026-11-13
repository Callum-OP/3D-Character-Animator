import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import { runPoseFinder, BadOutputError } from '../three/poseFinder/run.js'
import { makeCrop, boxFromKeypoints, defaultCamera, projectKeypoints, pickNextBox } from '../three/poseFinder/cropMath.js'
import { fk, makeFrame } from './helpers/mhrSynth.js'
import { JOINT_INDEX } from '../three/poseFinder/humanoid.js'

const E = (x, y, z) => new THREE.Euler(x, y, z)

describe('cropMath', () => {
  it('maps the box centre to the crop centre with a square 0.75-aspect-derived window', () => {
    const c = makeCrop({ x1: 100, y1: 50, x2: 300, y2: 450 })
    expect(c.center).toEqual([200, 250])
    expect(c.scale[0]).toBe(c.scale[1])
    expect(c.scale[0]).toBeCloseTo(500, 5) // 400 * 1.25, taller than 0.75-wide so height wins
    const [a, , tx, , e, ty] = c.affine
    expect(a * 200 + tx).toBeCloseTo(256, 4)
    expect(e * 250 + ty).toBeCloseTo(256, 4)
  })
  it('widens a wide box to the 0.75 aspect before squaring', () => {
    const c = makeCrop({ x1: 0, y1: 0, x2: 400, y2: 100 })
    expect(c.scale[0]).toBeCloseTo(500 / 0.75, 3) // w=500 -> h=w/0.75=666.67 -> square
  })
  it('default camera follows f = sqrt(w^2+h^2)', () => {
    const k = defaultCamera(1920, 1080)
    expect(k[0]).toBeCloseTo(Math.hypot(1920, 1080), 3)
    expect([k[2], k[5]]).toEqual([960, 540])
  })
  it('re-boxes from keypoints and rejects junk', () => {
    const kp = new Float32Array([100, 100, 200, 400, 150, 250])
    expect(boxFromKeypoints(kp, 1000, 1000, null)).toEqual({ x1: 100, y1: 100, x2: 200, y2: 400 })
    expect(boxFromKeypoints(new Float32Array([1, 1, 2, 2]), 1000, 1000, null)).toBeNull()
    expect(boxFromKeypoints(new Float32Array([NaN, 1, 2, 2]), 1000, 1000, null)).toBeNull()
  })
  it('keeps a wider person in view when they move from standing to lying down', () => {
    const prev = { x1: 100, y1: 100, x2: 300, y2: 500 }
    const box = boxFromKeypoints(new Float32Array([10, 250, 450, 262, 220, 256]), 1000, 1000, prev)
    expect(box.x1).toBeLessThanOrEqual(10)
    expect(box.x2).toBeGreaterThanOrEqual(450)
    expect(box.y2 - box.y1).toBeGreaterThanOrEqual(400)
  })
})

describe('tracking gate and validation', () => {
  it('rejects a jump far from the previous box and falls back to the projection', () => {
    const prev = { x1: 100, y1: 100, x2: 300, y2: 500 }
    const far = new Float32Array([2000, 100, 2100, 500, 2050, 300])
    expect(pickNextBox({ kp2d: far }, 1280, 720, prev)).toBeNull()
  })
  it('flags non-rotations and NaNs', async () => {
    const { checkFrameOutput } = await import('../three/poseFinder/validate.js')
    const good = makeFrame(0, fk({}), { depth: 6 })
    const out = { joint_rotations: good.G, keypoints_3d: good.kp3, cam_t: good.camT, keypoints_2d: new Float32Array(140), joint_coords: good.jc }
    expect(checkFrameOutput(out).ok).toBe(true)
    expect(checkFrameOutput({ ...out, joint_rotations: new Float32Array(1143).fill(0.3) }).ok).toBe(false)
    expect(checkFrameOutput({ ...out, cam_t: [0, 0, NaN] }).reason).toMatch(/NaN/)
    expect(checkFrameOutput({ ...out, cam_t: [0, 0, 0.01] }).ok).toBe(false)
    expect(checkFrameOutput({ ...out, joint_coords: undefined }).reason).toMatch(/incomplete/)
  })
  it('accepts a horizontal person without mistaking their height for their body size', async () => {
    const { checkFrameOutput } = await import('../three/poseFinder/validate.js')
    const fr = makeFrame(0, fk({}), { depth: 6 })
    const kp = fr.kp3.slice()
    for (const ankle of [13, 14]) {
      kp[ankle * 3] = kp[0] + 1
      kp[ankle * 3 + 1] = kp[1]
      kp[ankle * 3 + 2] = kp[2]
    }
    expect(checkFrameOutput({ joint_rotations: fr.G, joint_coords: fr.jc, keypoints_3d: kp, cam_t: fr.camT, keypoints_2d: new Float32Array(140) }).ok).toBe(true)
  })
})

describe('runPoseFinder with a fake video and a fake engine', () => {
  const W = 1280, H = 720
  const F = Math.hypot(W, H)
  const synth = (i) => fk({ l_uparm: E(0, 0, 0.5 * Math.sin(i * 0.8)), r_upleg: E(0.4 * Math.sin(i * 0.8), 0, 0), c_head: E(0, 0.4 * Math.sin(i * 0.5), 0) })
  const START_BOX = { x1: 540, y1: 140, x2: 740, y2: 580 }

  // opts: moveX (m per frame), kp2dSpace 'image' | 'crop', garbage(i) -> bool, still (constant pose)
  function rig({ moveX = 0, kp2dSpace = 'image', garbage = () => false, still = false } = {}) {
    const calls = []
    let i = 0
    const engine = {
      async infer(payload) {
        calls.push(payload)
        const k = i++
        if (garbage(k)) {
          return { ok: true, out: { joint_rotations: new Float32Array(1143).fill(NaN), joint_coords: new Float32Array(381), keypoints_3d: new Float32Array(210), cam_t: [0, 0, 0], keypoints_2d: new Float32Array(140), ms: 1 } }
        }
        const fr = makeFrame(0, fk(still ? {} : synth(k).deltas ? poseFor(k) : {}), { depth: 6, x: k * moveX })
        fr.camT[1] = 0.85
        const kp2 = projectKeypoints(fr.kp3, fr.camT, F, W, H)
        if (kp2dSpace === 'crop') { // simulate keypoints reported in the 512px crop instead of image pixels
          const [a, , c, , e, f] = payload.affine
          for (let n = 0; n < 70; n++) { kp2[n * 2] = a * kp2[n * 2] + c; kp2[n * 2 + 1] = e * kp2[n * 2 + 1] + f }
        }
        return { ok: true, out: { joint_rotations: fr.G, joint_coords: fr.jc, keypoints_3d: fr.kp3, cam_t: fr.camT, keypoints_2d: kp2, focal_length: F, ms: 5 } }
      },
    }
    const source = { width: W, height: H, duration: 2, frameAt: async () => new Uint8Array(512 * 512 * 4) }
    return { engine, source, calls }
  }
  const poseFor = (k) => ({ l_uparm: E(0, 0, 0.5 * Math.sin(k * 0.8)), r_upleg: E(0.4 * Math.sin(k * 0.8), 0, 0), c_head: E(0, 0.4 * Math.sin(k * 0.5), 0) })
  void synth

  it('produces a BVH the app loader reads, with the right frame counts', async () => {
    const { engine, source, calls } = rig()
    const progress = []
    const r = await runPoseFinder({ source, engine, box: START_BOX, sampleFps: 5, outFps: 30, onProgress: (p) => progress.push(p.done) })
    expect(calls.length).toBe(11)
    expect(calls[0].rgba.length).toBe(512 * 512 * 4)
    expect(calls[0].imageSize).toEqual([W, H])
    expect(progress.at(-1)).toBe(11)
    const parsed = new BVHLoader().parse(r.bvh)
    expect(parsed.clip.tracks.find((t) => t.name === 'Hips.position').times.length).toBe(r.solved.count + 1)
    expect(r.solved.info.convention.score).toBeGreaterThan(0.99)
    expect(r.solved.info.variationDeg).toBeGreaterThan(10)
    expect(r.diagnostics.length).toBeGreaterThan(0)
  })

  it('writes the selected ground and fixed-foot settings into the BVH', async () => {
    const { engine, source } = rig({ moveX: 0.02 })
    const r = await runPoseFinder({ source, engine, box: START_BOX, sampleFps: 5, outFps: 10, footLock: false, clean: { ground: 'natural', groundReference: 'body', lockFeet: true } })
    expect(r.solved.info.groundLocked).toBe(false)
    expect(r.solved.info.feetLocked).toBe(true)
    const clip = new BVHLoader().parse(r.bvh).clip
    const hips = clip.tracks.find((t) => t.name === 'Hips.position')
    const foot = clip.tracks.find((t) => t.name === 'LeftFoot.quaternion')
    const i = Math.floor(r.solved.count / 2)
    expect(hips.values[(i + 1) * 3 + 1]).toBeCloseTo(r.solved.root[i * 3 + 1], 3)
    const written = new THREE.Quaternion().fromArray(foot.values, (i + 1) * 4)
    const solved = new THREE.Quaternion().fromArray(r.solved.rot[JOINT_INDEX.LeftFoot], i * 4)
    expect(written.angleTo(solved)).toBeLessThan(0.01)
  })

  it('follows a person who walks across the frame', async () => {
    const { engine, source, calls } = rig({ moveX: 0.25 }) // 0.25 m per analysed frame ~ 61 px
    await runPoseFinder({ source, engine, box: START_BOX, sampleFps: 5, outFps: 10 })
    expect(calls.at(-1).center[0]).toBeGreaterThan(calls[0].center[0] + 300)
  })

  it('still follows when the model reports 2D keypoints in crop space (the cross-check uses the 3D projection)', async () => {
    const { engine, source, calls } = rig({ moveX: 0.25, kp2dSpace: 'crop' })
    await runPoseFinder({ source, engine, box: START_BOX, sampleFps: 5, outFps: 10 })
    expect(calls.at(-1).center[0]).toBeGreaterThan(calls[0].center[0] + 300)
  })

  it('uses image-space projections for flip contacts when model 2D output is in crop space', async () => {
    const { engine, source } = rig({ still: true, kp2dSpace: 'crop' })
    const r = await runPoseFinder({ source, engine, box: START_BOX, sampleFps: 5, outFps: 30, footLock: true, clean: { contactMode: 'screen', ground: 'natural', groundReference: 'body', levelCamera: false, levelFeet: true } })
    expect(r.solved.info.lockSegments).toBe(2)
    expect(r.solved.info.warnings.join(' ')).not.toMatch(/image-space foot contacts/)
  })

  it('fails clearly when the very first frame is garbage (so the app can retry on CPU)', async () => {
    const { engine, source } = rig({ garbage: () => true })
    await expect(runPoseFinder({ source, engine, box: START_BOX, sampleFps: 5 })).rejects.toBeInstanceOf(BadOutputError)
  })

  it('holds the last good pose through a few bad frames, and gives up on a long run of them', async () => {
    const some = rig({ garbage: (k) => k === 4 || k === 5 })
    const r = await runPoseFinder({ source: some.source, engine: some.engine, box: START_BOX, sampleFps: 5 })
    expect(r.frameCount).toBe(11)
    const many = rig({ garbage: (k) => k >= 3 })
    await expect(runPoseFinder({ source: many.source, engine: many.engine, box: START_BOX, sampleFps: 5 })).rejects.toThrow(/Lost the person/)
  })

  it('warns when the pose never changes (the model is not seeing the person)', async () => {
    const { engine, source } = rig({ still: true })
    const r = await runPoseFinder({ source, engine, box: START_BOX, sampleFps: 5 })
    expect(r.solved.info.warnings.join(' ')).toMatch(/barely changes/)
  })

  it('cancels cleanly', async () => {
    const { engine, source } = rig()
    const ac = new AbortController()
    const p = runPoseFinder({ source, engine, box: START_BOX, sampleFps: 5, signal: ac.signal, onProgress: (x) => { if (x.done === 3) ac.abort() } })
    await expect(p).rejects.toThrow(/Cancelled/)
  })

  it('surfaces engine errors', async () => {
    const { source } = rig()
    const engine = { infer: async () => ({ ok: false, error: 'out of memory' }) }
    await expect(runPoseFinder({ source, engine, box: { x1: 0, y1: 0, x2: 100, y2: 200 }, sampleFps: 5 })).rejects.toThrow(/out of memory/)
  })
})
