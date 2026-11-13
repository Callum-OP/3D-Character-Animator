// The Pose Finder pipeline: video frames -> SAM 3D Body (via the engine) -> cleaned motion -> BVH text.
// `source` and `engine` are injected so the whole thing can be tested without a video or the model.
import { makeCrop, defaultCamera, pickNextBox } from './cropMath.js'
import { checkFrameOutput } from './validate.js'
import { solveMotion } from './motion.js'
import { writeBVH } from './bvhWrite.js'

export class BadOutputError extends Error {
  constructor(reason) { super(`The pose model returned unusable output (${reason}).`); this.name = 'BadOutputError'; this.reason = reason }
}

// source: { width, height, duration, frameAt(t, crop) -> Promise<Uint8Array rgba 512x512> }
// engine: { infer(payload) -> Promise<{ ok, out } | { ok:false, error }> }   (window.animare.pose)
// onFrame({ i, t, rgba, box, kp2d, valid, reason, source }) lets the UI show what the model was actually given.
export async function runPoseFinder({ source, engine, box, startTime = 0, endTime, sampleFps = 10, outFps = 30, smoothing = 'medium', footLock = true, clean = {}, onProgress, onFrame, signal }) {
  const end = Math.min(endTime ?? source.duration, source.duration)
  const total = Math.max(2, Math.floor((end - startTime) * sampleFps) + 1)
  const camera = defaultCamera(source.width, source.height)
  const frames = []
  const diag = []
  let current = box
  let lastGood = null
  let invalid = 0, lost = 0
  const t0 = Date.now()
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new Error('Cancelled')
    const t = Math.min(end, startTime + i / sampleFps)
    const crop = makeCrop(current)
    const rgba = await source.frameAt(t, crop)
    if (signal?.aborted) throw new Error('Cancelled')
    const res = await engine.infer({ rgba, center: crop.center, scale: crop.scale, affine: crop.affine, imageSize: [source.width, source.height], camera })
    if (!res.ok) throw new Error(res.error || 'The pose model failed on a frame.')
    const o = res.out
    const check = checkFrameOutput(o)
    let next = null
    if (check.ok) {
      const focal = o.focal_length || camera[0]
      next = pickNextBox({ kp2d: o.keypoints_2d, kp3: o.keypoints_3d, camT: o.cam_t, focal }, source.width, source.height, current)
      lastGood = { G: o.joint_rotations, jc: o.joint_coords, kp3: o.keypoints_3d, camT: [o.cam_t[0], o.cam_t[1], o.cam_t[2]] }
      frames.push({ t: t - startTime, ...lastGood })
      invalid = 0
    } else {
      if (!lastGood) throw new BadOutputError(check.reason) // the very first frame is already garbage
      frames.push({ t: t - startTime, ...lastGood }) // hold the previous pose rather than feed garbage to the solver
      invalid++
    }
    if (next) { current = next.box; lost = 0 } else lost++
    if (diag.length < 4 || i % 10 === 0) diag.push({ i, t: +t.toFixed(3), valid: check.ok, reason: check.reason || null, box: { ...current }, crop: { center: crop.center, scale: crop.scale }, kp2d: Array.from(o?.keypoints_2d?.slice?.(0, 20) || []), camT: Array.from(o?.cam_t?.slice?.(0, 3) || []), focal: o?.focal_length ?? null, ms: o?.ms ?? null })
    onFrame && onFrame({ i, t, rgba, box: current, kp2d: o?.keypoints_2d, valid: check.ok, reason: check.reason, source: next?.source ?? null })
    if (invalid >= 6 || lost >= 8) {
      throw new Error(`Lost the person around ${t.toFixed(1)}s (${invalid >= 6 ? 'the model stopped returning usable poses' : 'the tracking box could not follow them'}). Draw the box tighter, or start where they are fully in view.`)
    }
    const done = i + 1
    const elapsed = (Date.now() - t0) / 1000
    onProgress && onProgress({ done, total, etaSec: (elapsed / done) * (total - done), box: current, ms: o?.ms })
  }
  const solved = solveMotion(frames, { outFps, smoothing, footLock, ...clean })
  const bvh = writeBVH(solved)
  return { bvh, solved, frameCount: frames.length, diagnostics: diag }
}
