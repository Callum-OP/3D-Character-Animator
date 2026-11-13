// Person box -> the 512px crop SAM 3D Body expects, and keeping the box on the person from frame to frame.
export const CROP_SIZE = 512

// Box = { x1, y1, x2, y2 } in image pixels. Follows the model card: centre c, size (w,h)*1.25, widened to an
// aspect ratio of 0.75 (w/h), then made square.
export function makeCrop(box) {
  const cx = (box.x1 + box.x2) / 2
  const cy = (box.y1 + box.y2) / 2
  let w = (box.x2 - box.x1) * 1.25
  let h = (box.y2 - box.y1) * 1.25
  if (w > h * 0.75) h = w / 0.75
  else w = h * 0.75
  const size = Math.max(w, h)
  const k = CROP_SIZE / size
  return {
    center: [cx, cy],
    scale: [size, size],
    // image -> crop: [[k,0,256-k*cx],[0,k,256-k*cy]]
    affine: [k, 0, CROP_SIZE / 2 - k * cx, 0, k, CROP_SIZE / 2 - k * cy],
    k,
  }
}

// Default intrinsics used by SAM 3D Body: f = sqrt(w^2 + h^2), principal point at the image centre.
export function defaultCamera(width, height) {
  const f = Math.hypot(width, height)
  return [f, 0, width / 2, 0, f, height / 2, 0, 0, 1]
}

// The whole-image box (a sensible starting guess), or a centred box covering most of the frame.
export function defaultBox(width, height) {
  const mx = width * 0.2
  return { x1: mx, y1: height * 0.04, x2: width - mx, y2: height * 0.96 }
}

// Next frame's box from this frame's 2D keypoints (original-image pixels). Returns null if they look unusable.
export function boxFromKeypoints(kp2d, width, height, prev) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (let i = 0; i < kp2d.length; i += 2) {
    const x = kp2d[i], y = kp2d[i + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    if (x < x1) x1 = x
    if (x > x2) x2 = x
    if (y < y1) y1 = y
    if (y > y2) y2 = y
  }
  const w = x2 - x1, h = y2 - y1
  if (w < 8 || h < 8) return null
  // The model's keypoints stop at the fingertips/toes; keep the previous box's size from collapsing.
  const box = { x1, y1, x2, y2 }
  if (prev) {
    const pw = prev.x2 - prev.x1, ph = prev.y2 - prev.y1
    if (h < ph * 0.45) { // person curled up or a bad frame: keep the old size around the new centre
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2
      const keepW = Math.max(pw, w), keepH = Math.max(ph, h)
      return { x1: cx - keepW / 2, y1: cy - keepH / 2, x2: cx + keepW / 2, y2: cy + keepH / 2 }
    }
  }
  // Clamp loosely to the frame (a limb may sit just outside it).
  box.x1 = Math.max(-width * 0.25, box.x1)
  box.y1 = Math.max(-height * 0.25, box.y1)
  box.x2 = Math.min(width * 1.25, box.x2)
  box.y2 = Math.min(height * 1.25, box.y2)
  return box
}

// Project camera-space keypoints (+ cam_t) to image pixels with the pinhole model SAM 3D Body uses. Independent of
// whatever frame the model's own keypoints_2d is reported in, so it works as a cross-check for tracking.
export function projectKeypoints(kp3, camT, focal, width, height) {
  const out = new Float32Array((kp3.length / 3) * 2)
  for (let i = 0; i < kp3.length / 3; i++) {
    const z = kp3[i * 3 + 2] + camT[2]
    if (!(z > 0.05)) { out[i * 2] = NaN; out[i * 2 + 1] = NaN; continue }
    out[i * 2] = (focal * (kp3[i * 3] + camT[0])) / z + width / 2
    out[i * 2 + 1] = (focal * (kp3[i * 3 + 1] + camT[1])) / z + height / 2
  }
  return out
}

const centre = (b) => [(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2]

// Next box from the model's keypoints, trusting them only if they stay close to where the person just was.
// Considers the model's own 2D keypoints and the projected 3D ones, and takes whichever lands nearer the previous
// box (people move a little between frames; a keypoint set in the wrong space lands far away). { box, source } | null
export function pickNextBox({ kp2d, kp3, camT, focal }, width, height, prev) {
  const cands = [['kp2d', kp2d]]
  if (kp3 && camT && focal) cands.push(['projected', projectKeypoints(kp3, camT, focal, width, height)])
  const pw = prev.x2 - prev.x1, ph = prev.y2 - prev.y1
  const [pcx, pcy] = centre(prev)
  let best = null
  for (const [source, pts] of cands) {
    const box = boxFromKeypoints(pts, width, height, prev)
    if (!box) continue
    const [cx, cy] = centre(box)
    const dist = Math.hypot(cx - pcx, cy - pcy)
    const ratio = (box.y2 - box.y1) / ph
    if (dist < 1.2 * Math.max(pw, ph) && ratio > 0.35 && ratio < 2.8 && (!best || dist < best.dist)) best = { box, source, dist }
  }
  return best && { box: best.box, source: best.source }
}
