import * as THREE from 'three'
import { classifyBone } from './bvh.js'

// ---------------------------------------------------------------------------
// Limb limits (anatomical joint constraints)
//
// Keeps joints inside natural human ranges: elbows and knees bend far in one
// direction and barely at all the other way, spines don't corkscrew, heads
// don't spin. Bones are matched to body parts by name (the same classifier
// the mocap retargeter uses); anything unrecognised — tails, wings, hair,
// props — stays completely unconstrained.
//
// Limits are expressed relative to the REST pose as a swing/twist split:
// swing = how far the bone's own axis may tip away from its rest direction
// (a cone, or an asymmetric cone for hinge joints), twist = how far it may
// roll around that axis. Hinge direction comes from the character's facing
// (+Z of the model root — the glTF/Mixamo convention): knees bend backward,
// elbows bend forward.
//
// This module only CHECKS and CLAMPS rotations — deciding when to apply them
// is the caller's job. Interactive posing clamps live edits (gizmo, sliders)
// when the toggle is on; loaded poses and playing clips are never touched, so
// mocap that exceeds the ranges plays back exactly as authored. The ragdoll
// clamps its solved rotations each frame. posing.applyLimitsToPose() is the
// explicit "pull the current pose back into range" action.
// ---------------------------------------------------------------------------

// Per-role limits in degrees. { swing, twist } is a symmetric cone;
// { fwd, back, twist } is a hinge: `fwd` toward the natural bend direction,
// `back` against it (sideways blends between the two).
const ROLE_LIMITS = {
  spine: { swing: 30, twist: 30 },
  chest: { swing: 30, twist: 30 },
  neck: { swing: 50, twist: 60 },
  head: { swing: 45, twist: 60 },
  shoulder: { swing: 30, twist: 20 },
  upperArm: { swing: 110, twist: 60 },
  lowerArm: { fwd: 145, back: 8, twist: 85 }, // elbow (twist covers pronation)
  hand: { swing: 70, twist: 35 },
  upperLeg: { swing: 110, twist: 45 },
  lowerLeg: { fwd: 145, back: 8, twist: 30 }, // knee
  foot: { swing: 55, twist: 25 },
  toe: { swing: 50, twist: 10 },
  // hips (the root) and unclassified bones are unconstrained
}

const state = {
  enabled: true, // the "Limb limits" toggle (mirrors the store via Viewport)
  specs: new Map(), // Bone -> { restQ, restInv, axis, twist, swing? | fwd/back/pref }
}

export function setLimitsEnabled(on) {
  state.enabled = on
}

export function limitsEnabled() {
  return state.enabled
}

// Bind to a freshly loaded model. Must run while the rig is in its rest pose
// (right after load) — limits are measured relative to it.
export function setLimitsModel(model) {
  clearLimitsModel()
  const bones = (model && model.bones) || []
  if (!bones.length) return
  model.root.updateWorldMatrix(true, true)
  const boneSet = new Set(bones)
  // Character facing, for hinge directions.
  const rootWQ = model.root.getWorldQuaternion(new THREE.Quaternion())
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rootWQ)

  const wq = new THREE.Quaternion()
  const wp = new THREE.Vector3()
  const cp = new THREE.Vector3()
  for (const bone of bones) {
    const slot = classifyBone(bone.name)
    if (!slot) continue
    const lim = ROLE_LIMITS[slot.split('.')[0]]
    if (!lim) continue
    bone.getWorldQuaternion(wq)
    bone.getWorldPosition(wp)
    // Longitudinal axis: toward the farthest child bone, else away from the parent.
    const axisWorld = new THREE.Vector3()
    let bestLen = 0
    for (const c of bone.children) {
      if (!c.isBone) continue
      c.getWorldPosition(cp).sub(wp)
      const len = cp.length()
      if (len > bestLen) {
        bestLen = len
        axisWorld.copy(cp)
      }
    }
    if (bestLen < 1e-9 && bone.parent && boneSet.has(bone.parent)) {
      bone.parent.getWorldPosition(cp)
      axisWorld.copy(wp).sub(cp)
    }
    if (axisWorld.lengthSq() < 1e-12) continue
    const invWQ = wq.clone().invert()
    const axis = axisWorld.normalize().applyQuaternion(invWQ) // bone-local
    const spec = {
      restQ: bone.quaternion.clone(),
      restInv: bone.quaternion.clone().invert(),
      axis,
      twist: THREE.MathUtils.degToRad(lim.twist),
    }
    if (lim.fwd != null) {
      // Hinge: the allowed bend direction in bone-local space, ⊥ the axis.
      // Knees bend backward (heel comes up behind), elbows bend forward.
      const pref = (slot.startsWith('lowerLeg') ? forward.clone().negate() : forward.clone())
        .applyQuaternion(invWQ)
      pref.addScaledVector(axis, -pref.dot(axis))
      if (pref.length() > 0.2) {
        spec.pref = pref.normalize()
        spec.fwd = THREE.MathUtils.degToRad(lim.fwd)
        spec.back = THREE.MathUtils.degToRad(lim.back)
      } else {
        // Axis nearly parallel to the facing (unusual rig): symmetric fallback.
        spec.swing = THREE.MathUtils.degToRad(lim.fwd)
      }
    } else {
      spec.swing = THREE.MathUtils.degToRad(lim.swing)
    }
    state.specs.set(bone, spec)
  }
}

export function clearLimitsModel() {
  state.specs = new Map()
}

const _d = new THREE.Quaternion()
const _tw = new THREE.Quaternion()
const _sw = new THREE.Quaternion()
const _inv = new THREE.Quaternion()
const _u = new THREE.Vector3()
const _m = new THREE.Vector3()

// Clamp a proposed LOCAL rotation for this bone to its limits (mutates q).
// Returns true if it changed. Deliberately ignores the enabled flag — callers
// that should respect the toggle use clampBoneLocal() or check limitsEnabled().
export function clampQuaternionForBone(bone, q) {
  const spec = state.specs.get(bone)
  if (!spec) return false
  const a = spec.axis
  _d.copy(spec.restInv).multiply(q) // rotation relative to rest
  if (_d.w < 0) _d.set(-_d.x, -_d.y, -_d.z, -_d.w) // canonical hemisphere
  // Split into twist about the bone's own axis and the remaining swing.
  const proj = _d.x * a.x + _d.y * a.y + _d.z * a.z
  _tw.set(a.x * proj, a.y * proj, a.z * proj, _d.w)
  if (_tw.lengthSq() < 1e-12) _tw.set(0, 0, 0, 1)
  else _tw.normalize()
  _sw.copy(_d).multiply(_inv.copy(_tw).invert()) // delta = swing ∘ twist

  let changed = false
  // Twist: signed angle about the axis, clamped symmetrically.
  const sinHalf = _tw.x * a.x + _tw.y * a.y + _tw.z * a.z
  let t = 2 * Math.atan2(sinHalf, _tw.w)
  if (Math.abs(t) > spec.twist + 1e-4) {
    t = THREE.MathUtils.clamp(t, -spec.twist, spec.twist)
    _tw.setFromAxisAngle(a, t)
    changed = true
  }
  // Swing: cone angle, with an asymmetric allowance for hinges.
  if (_sw.w < 0) _sw.set(-_sw.x, -_sw.y, -_sw.z, -_sw.w)
  const sinS = Math.sqrt(Math.max(0, 1 - _sw.w * _sw.w))
  if (sinS > 1e-6) {
    const s = 2 * Math.atan2(sinS, _sw.w) // 0..π
    _u.set(_sw.x / sinS, _sw.y / sinS, _sw.z / sinS) // swing axis (⊥ the bone axis)
    let maxS = spec.swing
    if (spec.pref) {
      _m.crossVectors(_u, a) // the direction this swing tips the bone
      const k = THREE.MathUtils.clamp(_m.dot(spec.pref), -1, 1)
      // Full range toward the bend direction, almost none against it,
      // squeezed in between so sideways wobble stays small too.
      maxS = spec.back + (spec.fwd - spec.back) * (0.5 + 0.5 * k) ** 2
    }
    if (s > maxS + 1e-4) {
      _sw.setFromAxisAngle(_u, maxS)
      changed = true
    }
  }
  if (!changed) return false
  q.copy(spec.restQ).multiply(_sw).multiply(_tw)
  return true
}

// Toggle-respecting variant for live posing: clamps the bone's own quaternion.
export function clampBoneLocal(bone) {
  if (!state.enabled) return false
  return clampQuaternionForBone(bone, bone.quaternion)
}
