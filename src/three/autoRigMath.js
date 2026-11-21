// Auto Rigger: landmark definitions and the pure maths around them (no three.js, no DOM).
// Space: glTF / three.js — Y up, the character faces +Z, the character's LEFT is +X. Metres or any
// consistent unit (the pipeline measures height from the mesh itself).

export const LANDMARKS = [
  { id: 'pelvis', label: 'Pelvis (hips centre)', group: 'Centre' },
  { id: 'spine', label: 'Lower spine', group: 'Centre' },
  { id: 'chest', label: 'Mid chest', group: 'Centre' },
  { id: 'upper_chest', label: 'Upper chest', group: 'Centre' },
  { id: 'neck', label: 'Neck base', group: 'Centre' },
  { id: 'head', label: 'Head joint (skull base)', group: 'Centre' },
  { id: 'head_top', label: 'Top of head', group: 'Centre' },
  ...['shoulder:Shoulder joint', 'elbow:Elbow', 'wrist:Wrist', 'fingertip:Middle fingertip', 'hip:Hip joint', 'knee:Knee', 'ankle:Ankle', 'toe:Ball of foot', 'toe_tip:Toe tip'].map((s) => {
    const [id, label] = s.split(':')
    return { id: 'l_' + id, label, group: 'Left (+X)', side: 'l', base: id }
  }),
  ...['shoulder:Shoulder joint', 'elbow:Elbow', 'wrist:Wrist', 'fingertip:Middle fingertip', 'hip:Hip joint', 'knee:Knee', 'ankle:Ankle', 'toe:Ball of foot', 'toe_tip:Toe tip'].map((s) => {
    const [id, label] = s.split(':')
    return { id: 'r_' + id, label, group: 'Right (−X)', side: 'r', base: id }
  }),
]

export const LANDMARK_IDS = LANDMARKS.map((l) => l.id)

export function mirrorId(id) {
  if (id.startsWith('l_')) return 'r_' + id.slice(2)
  if (id.startsWith('r_')) return 'l_' + id.slice(2)
  return null
}

export function mirrorPoint(p, cx) {
  return [2 * cx - p[0], p[1], p[2]]
}

// Proportion-based starting positions from a bounding box, so nobody places 25 markers from scratch.
// Assumes T-pose when the arms span clearly more than the height allows for arms-down, else A-pose.
// This is only a first guess: the person (or, later, a landmark detector) refines it.
export function guessLandmarks(box) {
  const { min, max } = box
  const H = max[1] - min[1]
  const cx = (min[0] + max[0]) / 2
  const cz = (min[2] + max[2]) / 2
  const y = (f) => min[1] + f * H
  const width = max[0] - min[0]
  const tpose = width > 0.75 * H
  const L = {}
  L.pelvis = [cx, y(0.53), cz]
  L.spine = [cx, y(0.61), cz]
  L.chest = [cx, y(0.69), cz]
  L.upper_chest = [cx, y(0.77), cz]
  L.neck = [cx, y(0.845), cz]
  L.head = [cx, y(0.878), cz]
  L.head_top = [cx, y(1.0), cz]
  const shoulder = [cx + 0.11 * H, y(0.82), cz]
  let elbow, wrist, tip
  if (tpose) {
    tip = [max[0], shoulder[1], cz]
    wrist = [max[0] - 0.1 * H, shoulder[1], cz]
    elbow = [(shoulder[0] + wrist[0]) / 2, shoulder[1], cz]
  } else {
    const d = Math.SQRT1_2
    const along = (len) => [shoulder[0] + d * len * H, shoulder[1] - d * len * H, cz]
    elbow = along(0.17)
    wrist = along(0.33)
    tip = along(0.42)
  }
  L.l_shoulder = shoulder
  L.l_elbow = elbow
  L.l_wrist = wrist
  L.l_fingertip = tip
  L.l_hip = [cx + 0.055 * H, y(0.51), cz]
  L.l_knee = [cx + 0.055 * H, y(0.28), cz]
  L.l_ankle = [cx + 0.055 * H, y(0.045), cz]
  L.l_toe = [cx + 0.055 * H, y(0.02), cz + 0.07 * H]
  L.l_toe_tip = [cx + 0.055 * H, y(0.015), cz + 0.12 * H]
  for (const id of LANDMARK_IDS) if (id.startsWith('r_')) L[id] = mirrorPoint(L['l_' + id.slice(2)], cx)
  return L
}

// Fill in anything missing on the right from the left (and vice versa), then turn into plain arrays.
export function toPayload(landmarks) {
  const cx = landmarks.pelvis ? landmarks.pelvis[0] : 0
  const out = {}
  for (const id of LANDMARK_IDS) {
    let p = landmarks[id]
    if (!p) {
      const m = mirrorId(id)
      if (m && landmarks[m]) p = mirrorPoint(landmarks[m], cx)
    }
    if (p) out[id] = [p[0], p[1], p[2]]
  }
  return out
}

// Human-readable problems that would make a rig come out wrong. [] = looks plausible.
export function validateLandmarks(landmarks) {
  const L = toPayload(landmarks)
  const problems = []
  for (const id of LANDMARK_IDS) {
    if (!L[id]) problems.push(`Missing landmark: ${id}`)
    else if (L[id].some((n) => !Number.isFinite(n))) problems.push(`Landmark ${id} has an invalid position`)
  }
  if (problems.length) return problems
  const above = (a, b, what) => {
    if (!(L[a][1] > L[b][1])) problems.push(what)
  }
  above('head_top', 'head', 'Top of head should be above the head joint.')
  above('head', 'neck', 'Head joint should be above the neck base.')
  above('neck', 'upper_chest', 'Neck base should be above the upper chest.')
  above('upper_chest', 'chest', 'Upper chest should be above the mid chest.')
  above('chest', 'spine', 'Mid chest should be above the lower spine.')
  above('spine', 'pelvis', 'Lower spine should be above the pelvis.')
  for (const s of ['l', 'r']) {
    above(`${s}_hip`, `${s}_knee`, `The ${s === 'l' ? 'left' : 'right'} hip should be above the knee.`)
    above(`${s}_knee`, `${s}_ankle`, `The ${s === 'l' ? 'left' : 'right'} knee should be above the ankle.`)
    if (!(L[`${s}_toe`][2] > L[`${s}_ankle`][2])) problems.push(`The ${s === 'l' ? 'left' : 'right'} toe should be in front of (+Z of) the ankle.`)
    const d = (a, b) => Math.hypot(L[a][0] - L[b][0], L[a][1] - L[b][1], L[a][2] - L[b][2])
    if (d(`${s}_shoulder`, `${s}_wrist`) < d(`${s}_shoulder`, `${s}_elbow`)) problems.push(`The ${s === 'l' ? 'left' : 'right'} elbow is further from the shoulder than the wrist is.`)
  }
  const cx = L.pelvis[0]
  if (!(L.l_shoulder[0] > cx)) problems.push('The left side is the +X side: left landmarks should be to the right of centre as you look at the front.')
  if (!(L.r_shoulder[0] < cx)) problems.push('Right landmarks should be on the −X side.')
  return problems
}

// Bounding box of an array of [x,y,z] or a Float32Array of positions.
export function boxOfPositions(pos) {
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

// Move one landmark and apply the mirror rules. `to` = the axes the current view edits: the front view
// passes { x, y }, the side view { z, y }. ONLY those axes change, on the marker and on its mirror
// partner: dragging in the front view never touches depth (z), dragging in the side view never touches
// sideways position (x). Mirror ON: a left/right marker drags its partner with it (x mirrored about the
// middle line); a CENTRE marker is locked to the middle line.
export function moveLandmark(landmarks, id, to, { mirror, axisX }) {
  const next = [...landmarks[id]]
  if (to.x !== undefined) next[0] = to.x
  if (to.y !== undefined) next[1] = to.y
  if (to.z !== undefined) next[2] = to.z
  const partner = mirrorId(id)
  if (mirror && !partner) next[0] = axisX
  const out = { ...landmarks, [id]: next }
  if (mirror && partner) {
    const p = [...landmarks[partner]]
    if (to.x !== undefined) p[0] = 2 * axisX - next[0]
    if (to.y !== undefined) p[1] = next[1]
    if (to.z !== undefined) p[2] = next[2]
    out[partner] = p
  }
  return out
}

// Turning Mirror on: centre markers snap to the middle line and the right side becomes the mirror of the left.
export function enforceMirror(landmarks, axisX) {
  const out = { ...landmarks }
  for (const id of LANDMARK_IDS) {
    const partner = mirrorId(id)
    if (!partner) out[id] = [axisX, landmarks[id][1], landmarks[id][2]]
    else if (id.startsWith('r_')) out[id] = mirrorPoint(landmarks[partner], axisX)
  }
  return out
}

// Undo / redo of whole-landmark snapshots.
export function createHistory(limit = 200) {
  let past = []
  let future = []
  return {
    push(snapshot) {
      past.push(snapshot)
      if (past.length > limit) past.shift()
      future = []
    },
    undo(current) {
      if (!past.length) return null
      future.push(current)
      return past.pop()
    },
    redo(current) {
      if (!future.length) return null
      past.push(current)
      return future.pop()
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    clear() {
      past = []
      future = []
    },
  }
}
