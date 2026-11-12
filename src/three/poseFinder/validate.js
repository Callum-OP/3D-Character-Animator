// Sanity checks on one frame of model output. Garbage (NaNs, non-rotation matrices, a person the size of a pea)
// is what comes back when the crop contains no person or a GPU driver miscomputes, and must never reach the solver.
const J_CHECK = [1, 9, 23, 38, 52, 70, 90, 110, 120]

function allFinite(a) {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false
  return true
}

export function checkFrameOutput(o) {
  if (!o || !o.joint_rotations || !o.keypoints_3d || !o.cam_t || !o.keypoints_2d) return { ok: false, reason: 'incomplete output' }
  if (!allFinite(o.joint_rotations) || !allFinite(o.keypoints_3d) || !allFinite(o.cam_t) || !allFinite(o.keypoints_2d)) return { ok: false, reason: 'NaN/infinite values (a GPU driver problem is likely)' }
  const R = o.joint_rotations
  for (const j of J_CHECK) {
    const m = R.slice(j * 9, j * 9 + 9)
    let err = 0
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
      let d = 0
      for (let k = 0; k < 3; k++) d += m[k * 3 + a] * m[k * 3 + b] // (R^T R)[a][b]
      err = Math.max(err, Math.abs(d - (a === b ? 1 : 0)))
    }
    if (err > 0.05) return { ok: false, reason: `joint ${j} is not a rotation (error ${err.toFixed(2)})` }
  }
  const z = o.cam_t[2]
  if (!(z > 0.2 && z < 100)) return { ok: false, reason: `implausible distance (${z.toFixed(1)} m)` }
  const k = o.keypoints_3d
  const top = k[0 * 3 + 1], bottom = (k[13 * 3 + 1] + k[14 * 3 + 1]) / 2
  const personH = Math.abs(bottom - top)
  if (!(personH > 0.25 && personH < 4)) return { ok: false, reason: `implausible body size (${personH.toFixed(2)} m)` }
  return { ok: true }
}

// How much the pose moves across the clip (degrees), from the solver's local rotation tracks.
export function maxAngleFromFirst(track, count) {
  let best = 0
  const d = (i) => track[i * 4] * track[0] + track[i * 4 + 1] * track[1] + track[i * 4 + 2] * track[2] + track[i * 4 + 3] * track[3]
  for (let i = 1; i < count; i++) best = Math.max(best, 2 * Math.acos(Math.min(1, Math.abs(d(i)))))
  return (best * 180) / Math.PI
}
