import { describe, it, expect } from 'vitest'
import { classifyBone } from '../three/bvh.js'

// classifyBone is the single point of truth for matching mocap/rig bone
// names across incompatible naming schemes onto the app's canonical
// humanoid slots. It's grown several special cases by hand over time
// (Rigify DEF- prefixes, MCH-/ORG- exclusions, dot-stripping quirks from
// GLTFLoader, sided "Hip" vs. unsided "Hips", plain "Leg" meaning shin in
// Mixamo…) — exactly the kind of logic where a future tweak for one rig can
// silently break another. Table-driven so adding a new rig's names later is
// a one-line addition, not a new test.
describe('classifyBone', () => {
  const cases = [
    // --- Mixamo ---
    ['Hips', 'hips'],
    ['Spine', 'spine'],
    ['Spine1', 'spine'],
    ['Neck', 'neck'],
    ['Head', 'head'],
    ['LeftShoulder', 'shoulder.L'],
    ['LeftArm', 'upperArm.L'],
    ['LeftForeArm', 'lowerArm.L'],
    ['LeftHand', 'hand.L'],
    ['RightShoulder', 'shoulder.R'],
    ['RightArm', 'upperArm.R'],
    ['RightForeArm', 'lowerArm.R'],
    ['RightHand', 'hand.R'],
    ['LeftUpLeg', 'upperLeg.L'],
    ['LeftLeg', 'lowerLeg.L'], // plain "Leg" == shin in Mixamo
    ['LeftFoot', 'foot.L'],
    ['LeftToeBase', 'toe.L'],
    ['RightUpLeg', 'upperLeg.R'],
    ['RightLeg', 'lowerLeg.R'],

    // --- CMU-style BVH ---
    ['LeftElbow', 'lowerArm.L'],
    ['RightElbow', 'lowerArm.R'],
    ['LeftKnee', 'lowerLeg.L'],
    ['LeftAnkle', 'foot.L'],
    ['LeftHip', 'upperLeg.L'], // SIDED "Hip" is the thigh, not the root
    ['RightHip', 'upperLeg.R'],

    // --- Rigify deform rig (dots collapsed, DEF- prefix, .L/.R suffix) ---
    ['DEF-spine', 'spine'],
    ['DEF-upper_arm.L', 'upperArm.L'],
    ['DEF-forearm.L', 'lowerArm.L'],
    ['DEF-thigh.R', 'upperLeg.R'],
    ['DEF-shin.R', 'lowerLeg.R'],

    // --- Generic game rig (spine chain, snake_case) ---
    ['pelvis', 'hips'],
    ['spine_01', 'spine'],
    ['upperarm_l', 'upperArm.L'],
    ['lowerarm_r', 'lowerArm.R'],
    ['thigh_l', 'upperLeg.L'],
    ['calf_r', 'lowerLeg.R'],
    ['foot_l', 'foot.L'],
    ['ball_r', 'toe.R'],

    // --- Unsided / root fallbacks ---
    ['root', 'hips'],
    ['torso', 'spine'],
    ['abdomen', 'spine'],

    // --- Things that must NOT classify as a core humanoid slot ---
    ['LeftHandThumb1', null],
    ['LeftHandIndex2', null],
    ['LeftForeArmTwist', null],
    ['RightArmTwist1', null],
    ['LeftEye', null],
    ['Jaw', null],
    ['Breast_L', null],
    ['weapon_socket_r', null],
    ['cloth_flag_01', null],
    ['ik_hand_l', null],
    ['hand_l_end', null],
  ]

  for (const [raw, expected] of cases) {
    it(`"${raw}" -> ${expected === null ? 'null (excluded)' : expected}`, () => {
      expect(classifyBone(raw)).toBe(expected)
    })
  }

  it('is case-insensitive and separator-insensitive together', () => {
    expect(classifyBone('LEFT_UPPER_ARM')).toBe('upperArm.L')
    expect(classifyBone('left.upper.arm')).toBe('upperArm.L')
    expect(classifyBone('left-upper-arm')).toBe('upperArm.L')
  })

  it('does not mis-side a name that merely contains a stray "l" or "r" letter', () => {
    // "Collar" contains "l" but isn't a left-sided anything on its own —
    // guards against an over-eager side-detection regex.
    expect(classifyBone('Collar')).not.toBe('shoulder.L')
  })
})