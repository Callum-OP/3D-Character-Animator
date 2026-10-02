import { describe, it, expect } from 'vitest'
import { buildNameMatch, buildSlotMapping, classifyBone } from '../three/bvh.js'

// classifyBone is the single point of truth for matching mocap/rig bone
// names across incompatible naming schemes onto the app's canonical
// humanoid slots. It's grown several special cases by hand over time
// (Rigify DEF- prefixes, MCH-/ORG- exclusions, dot-stripping quirks from
// GLTFLoader, sided "Hip" vs. unsided "Hips", plain "Leg" meaning shin…) —
// exactly the kind of logic where a future tweak for one rig can
// silently break another. Table-driven so adding a new rig's names later is
// a one-line addition, not a new test.
describe('classifyBone', () => {
  const cases = [
    // --- Common humanoid rig names ---
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
    ['LeftLeg', 'lowerLeg.L'], // plain "Leg" == shin
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
    ['HeadFace', null],
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

  it('does not map side-specific chest joints as the central chest slot', () => {
    expect(classifyBone('right_chest_aux')).toBeNull()
    expect(classifyBone('left_chest_aux')).toBeNull()
  })

  it('prefers anatomical bones over corrective joints when building slots', () => {
    const targetNames = [
      'root_joint',
      'pelvis_main',
      'spine_main_01',
      'spine_main_02',
      'spine_main_03',
      'spine_main_04',
      'spine_main_05',
      'right_chest_aux',
      'left_chest_aux',
      'left_spine_fix_1',
      'right_spine_fix_1',
      'left_ankle_fix_1',
      'left_foot',
    ]
    const sourceNames = ['Hips', 'Spine', 'Chest', 'LeftAnkle']
    const slots = buildSlotMapping(targetNames, sourceNames)
    const selected = Object.fromEntries(slots.map(({ key, target }) => [key, target]))

    expect(selected.hips).toBe('pelvis_main')
    expect(selected.spine).toBe('spine_main_01')
    expect(selected.chest).toBe('spine_main_05')
    expect(selected['foot.L']).toBe('left_foot')
  })

  it('matches finger segments across naming conventions', () => {
    const targetBones = [
      'left_arm',
      'thumb_01_l',
      'thumb_02_l',
      'thumb_03_l',
      'index_metacarpal_l',
      'index_01_l',
      'thumb_01_r',
      'thumb_01_l_end',
    ]
    const sourceBones = [
      'source:LeftArm',
      'source:LeftHandThumb1',
      'source:LeftHandThumb2',
      'source:LeftHandThumb3',
      'source:LeftHandIndex1',
      'source:RightHandThumb1',
    ]

    expect(buildNameMatch(targetBones, sourceBones)).toEqual({
      left_arm: 'source:LeftArm',
      thumb_01_l: 'source:LeftHandThumb1',
      thumb_02_l: 'source:LeftHandThumb2',
      thumb_03_l: 'source:LeftHandThumb3',
      index_01_l: 'source:LeftHandIndex1',
      thumb_01_r: 'source:RightHandThumb1',
    })
  })
})
