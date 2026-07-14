import * as THREE from 'three'
import { clampQuaternionForBone } from './limits.js'

// ---------------------------------------------------------------------------
// Ragdoll baker
//
// Drops the rig limply to the ground and bakes the fall into a regular
// THREE.AnimationClip, so the result plays, loops and exports like any other
// clip. No physics library: a tiny verlet simulation with one particle per
// simulated joint, distance constraints along the hierarchy (plus sibling
// links to keep branch points like the pelvis solid), and a flat ground plane.
//
// Only the CORE skeleton is simulated — hips, spine, head, limbs. Helper bones
// (twists, IK targets, sockets, "_end" tails — the load-time deform=false set)
// and spatially tiny bones (fingers, facial rig) keep their pose and simply
// ride along with their simulated ancestor. Simulating those too is what turns
// a dense game rig into exploding spaghetti: stacks of co-located bones make
// near-zero-length constraints (numerically unstable), and letting the solver
// twist every tiny bone candy-wraps the skin.
//
// On top of that, four things keep the fall looking like a body:
// - rotations are re-derived from the STARTING pose every frame (one swing
//   onto the particle direction) — never accumulated frame over frame — so
//   twist cannot build up and flatten the mesh into ribbons,
// - the fall is seeded as a gentle topple about the feet (a perfectly balanced
//   body would otherwise compress straight down and buckle with solver jitter),
// - every particle carries a contact radius derived from its bone's size, so
//   the torso and head rest at flesh thickness above the floor,
// - each joint gets a soft, fading spring toward its starting angle (muscle
//   tone) and a hard anti-fold stop, so limbs bend on impact but don't crumple.
//
// The clip carries a quaternion track per simulated bone and ONE position
// track, on the root bone (hips) — the same shape as a retargeted BVH clip, so
// the existing mixer/playback path handles it unchanged. The simulation starts
// from whatever pose the bones are in when it runs.
//
// Everything is scale-aware: gravity, radii and thresholds derive from the
// rig's height, so metre-scale glTF and centimetre-scale FBX fall the same.
// ---------------------------------------------------------------------------

const HUMAN_HEIGHT_M = 1.7 // assumed real-world height of the rig, for unit scaling
const GRAVITY_MS2 = 9.8
const SUBSTEP = 1 / 120 // physics step (seconds)
const ITERATIONS = 8 // constraint relaxations per substep
const DAMPING = 0.992 // per-substep velocity keep (heavy, fleshy drag)
const FRICTION = 0.7 // per-substep tangential velocity kill on ground contact
const RESTITUTION = 0.1 // fraction of impact speed kept as bounce (flesh thuds)
const TIP_SPEED = 0.4 // initial topple: the top of the body starts at this × height /s
const STRAIGHTEN = 0.12 // per-substep spring of each joint back toward its start angle
const TONE_TIME = 2 // muscle tone fades to zero over this long, so the body can rest
const ANTIFOLD = 0.72 // hard stop: a joint's span can't compress below this fraction
const SIM_MIN_LEN = 0.04 // × height: bones with less reach ride along instead of simulating
const MERGE_LEN = 0.008 // × height: a bone this close to its sim-parent shares its particle
const MAX_DURATION = 4 // hard cap on the baked fall (seconds)
const SETTLE_SPEED = 0.03 // "at rest" when nothing moves faster than this × height per second
const SETTLE_TIME = 0.3 // …sustained for this long (seconds)

// Simulate the model falling limply from its current pose onto the ground at
// world height `groundY`, baked at `fps`. Returns { clip, duration } or null
// if there's no usable skeleton. Leaves the live rig untouched.
export function simulateRagdollClip(model, opts = {}) {
  const allBones = (model && model.bones) || []
  if (allBones.length < 2) return null
  const fps = opts.fps || 30
  const groundY = opts.groundY ?? 0
  const limits = opts.limits !== false // respect the limb-limits toggle (on by default)

  model.root.updateWorldMatrix(true, true)

  // --- measure every bone: world positions, hierarchy, overall size ---
  const boneSet = new Set(allBones)
  const P = allBones.map((b) => b.getWorldPosition(new THREE.Vector3()))
  let minY = Infinity
  let maxY = -Infinity
  for (const v of P) {
    if (v.y < minY) minY = v.y
    if (v.y > maxY) maxY = v.y
  }
  const height = Math.max(maxY - minY, 1e-6)
  const gravity = GRAVITY_MS2 * (height / HUMAN_HEIGHT_M) // world units / s²

  const index = new Map(allBones.map((b, i) => [b, i]))
  const parentOf = allBones.map((b) =>
    b.parent && boneSet.has(b.parent) ? index.get(b.parent) : -1,
  )
  const childrenOf = allBones.map(() => [])
  parentOf.forEach((pi, i) => {
    if (pi >= 0) childrenOf[pi].push(i)
  })
  // Parents-first order over the whole rig.
  const order = []
  const visit = (i) => {
    order.push(i)
    for (const c of childrenOf[i]) visit(c)
  }
  parentOf.forEach((pi, i) => {
    if (pi < 0) visit(i)
  })
  const rootIndex = order[0]

  // --- pick the core skeleton worth simulating ---
  // Load-time classification (model.info.bones is index-aligned with bones):
  // deform=false marks twists/IK/sockets/_end tails. On top of that, a size
  // gate drops fingers, facial bones and other tiny correctives.
  const info = (model.info && model.info.bones) || []
  const deform = info.length === allBones.length ? info.map((x) => !!x.deform) : null
  const hasSplit = !!deform && deform.some(Boolean) && deform.some((d) => !d)
  const reachOf = (i) => {
    let m = parentOf[i] >= 0 ? P[i].distanceTo(P[parentOf[i]]) : 0
    for (const c of childrenOf[i]) m = Math.max(m, P[c].distanceTo(P[i]))
    return m
  }
  const kept = allBones.map(
    (b, i) => (!hasSplit || deform[i]) && reachOf(i) >= height * SIM_MIN_LEN,
  )
  kept[rootIndex] = true
  // Unusual rigs: if the classification left almost nothing, fall back to the
  // size gate alone; if even that fails, simulate everything.
  if (kept.filter(Boolean).length < 4) {
    for (let i = 0; i < kept.length; i++) kept[i] = reachOf(i) >= height * SIM_MIN_LEN
    kept[rootIndex] = true
  }
  if (kept.filter(Boolean).length < 2) kept.fill(true)

  // Sim hierarchy: each simulated bone hangs off its nearest simulated ancestor.
  const simOrder = order.filter((i) => kept[i])
  const simParentOf = allBones.map(() => -1)
  for (const i of simOrder) {
    let a = parentOf[i]
    while (a >= 0 && !kept[a]) a = parentOf[a]
    simParentOf[i] = a
  }
  const simChildrenOf = allBones.map(() => [])
  for (const i of simOrder) {
    if (simParentOf[i] >= 0) simChildrenOf[simParentOf[i]].push(i)
  }

  // --- particles: one per simulated bone, except bones sitting right on their
  // sim-parent, which share its particle (a zero-length constraint would blow up).
  const particleOf = allBones.map(() => -1)
  const pStart = [] // particle start positions
  for (const i of simOrder) {
    const sp = simParentOf[i]
    if (sp >= 0 && P[i].distanceTo(P[sp]) < height * MERGE_LEN) {
      particleOf[i] = particleOf[sp]
    } else {
      particleOf[i] = pStart.length
      pStart.push(P[i].clone())
    }
  }

  // The farthest simulated child defines each bone's aim direction.
  const primaryChild = allBones.map(() => -1)
  const aimLen = allBones.map(() => 0)
  for (const i of simOrder) {
    let best = -1
    let bestLen = height * 1e-3
    for (const c of simChildrenOf[i]) {
      if (particleOf[c] === particleOf[i]) continue
      const len = pStart[particleOf[c]].distanceTo(pStart[particleOf[i]])
      if (len > bestLen) {
        best = c
        bestLen = len
      }
    }
    primaryChild[i] = best
    aimLen[i] = best >= 0 ? bestLen : 0
  }

  // --- constraints (between particles) ---
  const constraints = [] // hard: { a, b, len, stiffness, minOnly }
  const springs = [] // soft joint tone: { a, b, len }, applied once per substep
  const linkLens = pStart.map(() => []) // bone-link lengths per particle (for radii)
  const link = (a, b, len, stiffness, minOnly) =>
    constraints.push({ a, b, len, stiffness, minOnly })
  for (const i of simOrder) {
    const sp = simParentOf[i]
    if (sp < 0 || particleOf[i] === particleOf[sp]) continue
    const len = pStart[particleOf[sp]].distanceTo(pStart[particleOf[i]])
    link(particleOf[sp], particleOf[i], len, 1, false)
    linkLens[particleOf[i]].push(len)
    linkLens[particleOf[sp]].push(len)
  }
  // Sibling links make branch points (pelvis, chest) behave as solid bodies.
  for (const i of simOrder) {
    const kids = simChildrenOf[i]
    for (let a = 0; a < kids.length; a++) {
      for (let b = a + 1; b < kids.length; b++) {
        const pa = particleOf[kids[a]]
        const pb = particleOf[kids[b]]
        if (pa === pb) continue
        const len = pStart[pa].distanceTo(pStart[pb])
        if (len < height * MERGE_LEN) continue
        link(pa, pb, len, 1, false)
      }
    }
  }
  // Per joint (grandparent↔grandchild span): a soft spring toward the starting
  // angle (tissue resistance) and a hard stop so it can't fold onto itself.
  for (const i of simOrder) {
    const sp = simParentOf[i]
    const gp = sp >= 0 ? simParentOf[sp] : -1
    if (gp < 0) continue
    const pa = particleOf[gp]
    const pb = particleOf[i]
    if (pa === pb) continue
    const span = pStart[pa].distanceTo(pStart[pb])
    if (span <= height * 0.02) continue
    springs.push({ a: pa, b: pb, len: span })
    link(pa, pb, span * ANTIFOLD, 0.8, true)
  }

  // Contact radius per particle — a flesh-thickness proxy from the size of the
  // bones meeting there. Big joints (hips, chest) rest high off the floor,
  // hands almost on it. This is what keeps the corpse from lying flat.
  const radii = linkLens.map((lens) => {
    const avg = lens.length ? lens.reduce((s, l) => s + l, 0) / lens.length : height * 0.1
    return THREE.MathUtils.clamp(avg * 0.35, height * 0.015, height * 0.06)
  })

  // --- verlet particles (position + previous position; velocity is implicit) ---
  const pos = pStart.map((v) => v.clone())
  const prev = pStart.map((v) => v.clone())
  let maxSpeed = 0 // fastest particle in the latest substep (world units / s)

  // Seed the fall as a slow topple about the feet — like a felled tree — in
  // the direction the body already leans. A perfectly balanced body gets a
  // deterministic nudge toward wherever the model is facing.
  const lean = new THREE.Vector3()
  const base = new THREE.Vector3()
  let nBase = 0
  for (const v of pStart) {
    lean.add(v)
    if (v.y < minY + height * 0.15) {
      base.add(v)
      nBase++
    }
  }
  lean.divideScalar(pStart.length)
  if (nBase) base.divideScalar(nBase)
  const tipDir = new THREE.Vector3(lean.x - base.x, 0, lean.z - base.z)
  if (tipDir.length() < height * 0.01) {
    tipDir.set(0, 0, 1).applyQuaternion(model.root.getWorldQuaternion(new THREE.Quaternion()))
    tipDir.y = 0
  }
  if (tipDir.lengthSq() < 1e-12) tipDir.set(0, 0, 1)
  tipDir.normalize()
  for (let i = 0; i < prev.length; i++) {
    const speed = TIP_SPEED * (pStart[i].y - minY) // angular: faster higher up
    prev[i].addScaledVector(tipDir, -speed * SUBSTEP)
  }

  function applyGround(i) {
    const p = pos[i]
    const fl = groundY + radii[i]
    if (p.y >= fl) return
    const q = prev[i]
    const impact = p.y - q.y // downward travel this substep (negative)
    p.y = fl
    if (impact < 0) q.y = fl + impact * RESTITUTION // flip a fraction into a bounce
    q.x += (p.x - q.x) * FRICTION // grip: bleed off sliding
    q.z += (p.z - q.z) * FRICTION
  }

  function step(tone) {
    // Integrate: carry damped velocity forward, add gravity, resolve the floor.
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i]
      const q = prev[i]
      const vx = (p.x - q.x) * DAMPING
      const vy = (p.y - q.y) * DAMPING
      const vz = (p.z - q.z) * DAMPING
      q.copy(p)
      p.x += vx
      p.y += vy - gravity * SUBSTEP * SUBSTEP
      p.z += vz
      applyGround(i)
    }
    // Relax the hard constraints toward their rest lengths.
    for (let it = 0; it < ITERATIONS; it++) {
      for (const c of constraints) {
        const pa = pos[c.a]
        const pb = pos[c.b]
        const dx = pb.x - pa.x
        const dy = pb.y - pa.y
        const dz = pb.z - pa.z
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (d < 1e-12) continue
        if (c.minOnly && d >= c.len) continue
        const corr = ((d - c.len) / d) * 0.5 * c.stiffness
        pa.x += dx * corr
        pa.y += dy * corr
        pa.z += dz * corr
        pb.x -= dx * corr
        pb.y -= dy * corr
        pb.z -= dz * corr
      }
      // Relaxation must never push anything underground.
      for (let i = 0; i < pos.length; i++) {
        const fl = groundY + radii[i]
        if (pos[i].y < fl) pos[i].y = fl
      }
    }
    // Soft joint tone: nudge every joint back toward its starting angle. The
    // tone fades out over TONE_TIME — an undamped spring would keep feeding
    // energy in and the body would twitch forever instead of coming to rest.
    const stiff = 0.5 * STRAIGHTEN * tone
    for (const c of springs) {
      const pa = pos[c.a]
      const pb = pos[c.b]
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      const dz = pb.z - pa.z
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d < 1e-12) continue
      const corr = ((d - c.len) / d) * stiff
      pa.x += dx * corr
      pa.y += dy * corr
      pa.z += dz * corr
      pb.x -= dx * corr
      pb.y -= dy * corr
      pb.z -= dz * corr
    }
    maxSpeed = 0
    for (let i = 0; i < pos.length; i++) {
      applyGround(i)
      const s = pos[i].distanceTo(prev[i]) / SUBSTEP
      if (s > maxSpeed) maxSpeed = s
    }
  }

  // --- rotation solve: START pose + one swing per frame (twist can't build up) ---
  const startLocalQ = allBones.map((b) => b.quaternion.clone())
  const startWorldQ = allBones.map((b) => b.getWorldQuaternion(new THREE.Quaternion()))
  const worldQ = startWorldQ.map((q) => q.clone()) // live world rotations (sim bones)
  const localQ = allBones.map((b) => b.quaternion.clone()) // recorded local rotations
  // Rotation of each sim bone's ACTUAL parent node relative to its sim-parent's
  // world rotation. Any bones in between aren't simulated and hold their pose,
  // so this bridge is constant. Sim roots store their parent's rotation as-is.
  const bridgeQ = allBones.map((b, i) => {
    if (!kept[i]) return null
    const parentWQ = b.parent
      ? b.parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion()
    const sp = simParentOf[i]
    if (sp < 0) return parentWQ
    return startWorldQ[sp].clone().invert().multiply(parentWQ)
  })
  // Each bone's aim axis toward its primary child, in its own local space.
  const aimLocal = allBones.map((b, i) => {
    const c = primaryChild[i]
    if (c < 0) return null
    return pStart[particleOf[c]]
      .clone()
      .sub(pStart[particleOf[i]])
      .normalize()
      .applyQuaternion(startWorldQ[i].clone().invert())
  })
  const rootParentInv = allBones[rootIndex].parent
    ? allBones[rootIndex].parent.matrixWorld.clone().invert()
    : new THREE.Matrix4()

  const _q = new THREE.Quaternion()
  const _pq = new THREE.Quaternion()
  const _va = new THREE.Vector3()
  const _vb = new THREE.Vector3()
  const minAimSq = (height * 1e-5) ** 2

  function solveRotations() {
    for (const i of simOrder) {
      const sp = simParentOf[i]
      // The actual parent's world rotation, via the constant bridge.
      const aWQ = sp >= 0 ? _pq.copy(worldQ[sp]).multiply(bridgeQ[i]) : _pq.copy(bridgeQ[i])
      // Candidate: the STARTING local rotation under today's parent. Deriving
      // from the start (not from last frame) is what stops twist accumulating.
      worldQ[i].copy(aWQ).multiply(startLocalQ[i])
      localQ[i].copy(startLocalQ[i])
      const c = primaryChild[i]
      if (c < 0) continue // no simulated child: rides along rigidly
      _vb.copy(pos[particleOf[c]]).sub(pos[particleOf[i]])
      if (_vb.lengthSq() < minAimSq) continue
      _vb.normalize()
      _va.copy(aimLocal[i]).applyQuaternion(worldQ[i]) // where the aim axis points now
      _q.setFromUnitVectors(_va, _vb) // shortest arc onto the particle direction
      worldQ[i].premultiply(_q)
      localQ[i].copy(aWQ).invert().multiply(worldQ[i])
      // Limb limits: clamp the solved joint, then drag the child particle
      // toward where the clamped bone points, so the physics follows the
      // limit instead of fighting it (knees can't fold backward mid-fall).
      if (limits && clampQuaternionForBone(allBones[i], localQ[i])) {
        worldQ[i].copy(aWQ).multiply(localQ[i])
        _va.copy(aimLocal[i]).applyQuaternion(worldQ[i])
        _vb.copy(pos[particleOf[i]]).addScaledVector(_va, aimLen[i])
        pos[particleOf[c]].lerp(_vb, 0.5)
      }
    }
  }

  // --- bake: one frame per 1/fps until the body settles (or the cap) ---
  const times = []
  const quatValues = allBones.map(() => null)
  for (const i of simOrder) quatValues[i] = []
  const rootPosValues = []
  const _wp = new THREE.Vector3()

  function record(t) {
    times.push(t)
    for (const i of simOrder) {
      const q = localQ[i]
      quatValues[i].push(q.x, q.y, q.z, q.w)
    }
    // The hips' world position expressed in their parent's (static) space.
    _wp.copy(pos[particleOf[rootIndex]]).applyMatrix4(rootParentInv)
    rootPosValues.push(_wp.x, _wp.y, _wp.z)
  }

  record(0) // frame 0 = the pose the character is in right now
  const frameDt = 1 / fps
  const substepsPerFrame = Math.max(1, Math.round(frameDt / SUBSTEP))
  let settled = 0
  for (let t = frameDt; t <= MAX_DURATION + 1e-6; t += frameDt) {
    const tone = Math.max(0, 1 - t / TONE_TIME)
    for (let s = 0; s < substepsPerFrame; s++) step(tone)
    solveRotations()
    record(t)
    if (maxSpeed < SETTLE_SPEED * height) settled += frameDt
    else settled = 0
    if (settled >= SETTLE_TIME && t >= 0.5) break
  }

  // --- build the clip (only simulated bones get tracks; static ones dropped) ---
  const tracks = []
  for (const i of simOrder) {
    const vals = quatValues[i]
    let moves = i === rootIndex // always keep the root's rotation
    for (let o = 4; o < vals.length && !moves; o += 4) {
      moves =
        Math.abs(vals[o] - vals[0]) > 1e-4 ||
        Math.abs(vals[o + 1] - vals[1]) > 1e-4 ||
        Math.abs(vals[o + 2] - vals[2]) > 1e-4 ||
        Math.abs(vals[o + 3] - vals[3]) > 1e-4
    }
    if (!moves) continue
    tracks.push(new THREE.QuaternionKeyframeTrack(allBones[i].name + '.quaternion', times, vals))
  }
  tracks.push(
    new THREE.VectorKeyframeTrack(allBones[rootIndex].name + '.position', times, rootPosValues),
  )
  const clip = new THREE.AnimationClip('Ragdoll', times[times.length - 1], tracks)
  return { clip, duration: clip.duration }
}
