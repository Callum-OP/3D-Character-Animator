// The humanoid BVH skeleton Pose Finder writes, and how each bone maps onto Meta's 127-joint MHR rig.
// Names follow the common "Hips / Spine / LeftArm / LeftHandIndex1" scheme so the existing BVH importer's
// name matching and bone-slot guessing (bvh.js) recognise every bone, fingers included.
import { MHR_NAMES, MHR_REST_POS_CM } from './mhrRest.js'

const FINGERS = [
  // [BVH name, MHR stem, the three MHR joints driving the three BVH segments, MHR joint that marks the tip]
  ['Thumb', 'thumb', ['thumb0', 'thumb1', 'thumb2'], 'thumb3'],
  ['Index', 'index', ['index1', 'index2', 'index3'], 'index_null'],
  ['Middle', 'middle', ['middle1', 'middle2', 'middle3'], 'middle_null'],
  ['Ring', 'ring', ['ring1', 'ring2', 'ring3'], 'ring_null'],
  ['Pinky', 'pinky', ['pinky1', 'pinky2', 'pinky3'], 'pinky_null'],
]

function buildSpec() {
  const joints = [] // { name, mhr (joint name), parent (name|null), end? (mhr joint name | [x,y,z] cm) }
  const add = (name, mhr, parent, end) => joints.push({ name, mhr, parent, end })
  add('Hips', 'root', null)
  add('Spine', 'c_spine0', 'Hips')
  add('Spine1', 'c_spine1', 'Spine')
  add('Spine2', 'c_spine2', 'Spine1')
  add('Spine3', 'c_spine3', 'Spine2')
  add('Neck', 'c_neck', 'Spine3')
  add('Head', 'c_head', 'Neck', 'c_head_null')
  for (const [S, s] of [['Left', 'l'], ['Right', 'r']]) {
    add(`${S}Shoulder`, `${s}_clavicle`, 'Spine3')
    add(`${S}Arm`, `${s}_uparm`, `${S}Shoulder`)
    add(`${S}ForeArm`, `${s}_lowarm`, `${S}Arm`)
    add(`${S}Hand`, `${s}_wrist`, `${S}ForeArm`)
    for (const [F, , segs, tip] of FINGERS) {
      let parent = `${S}Hand`
      segs.forEach((seg, i) => {
        const name = `${S}Hand${F}${i + 1}`
        add(name, `${s}_${seg}`, parent, i === 2 ? `${s}_${tip}` : undefined)
        parent = name
      })
    }
    add(`${S}UpLeg`, `${s}_upleg`, 'Hips')
    add(`${S}Leg`, `${s}_lowleg`, `${S}UpLeg`)
    add(`${S}Foot`, `${s}_foot`, `${S}Leg`)
    add(`${S}ToeBase`, `${s}_ball`, `${S}Foot`, [0, 0, 6])
  }
  return joints
}

const SPEC = buildSpec()
const byName = new Map(SPEC.map((j, i) => [j.name, i]))

export const BVH_JOINTS = SPEC.map((j) => {
  const mhr = MHR_NAMES.indexOf(j.mhr)
  if (mhr < 0) throw new Error(`MHR joint ${j.mhr} missing from skeleton`)
  return { name: j.name, mhr, parent: j.parent == null ? -1 : byName.get(j.parent), end: j.end }
})

export const JOINT_INDEX = Object.fromEntries(BVH_JOINTS.map((j, i) => [j.name, i]))

const restPos = (mhrIndex) => [MHR_REST_POS_CM[mhrIndex * 3], MHR_REST_POS_CM[mhrIndex * 3 + 1], MHR_REST_POS_CM[mhrIndex * 3 + 2]]

// Rest-pose OFFSET of each bone from its parent, in world axes (centimetres). The BVH is authored so that every
// bone's rest orientation is identity — the offsets alone describe the rest skeleton.
export function restOffsets() {
  return BVH_JOINTS.map((j) => {
    const p = restPos(j.mhr)
    if (j.parent < 0) return p
    const q = restPos(BVH_JOINTS[j.parent].mhr)
    return [p[0] - q[0], p[1] - q[1], p[2] - q[2]]
  })
}

// End-site offset for leaf bones (null for bones with children).
export function endOffset(i) {
  const j = BVH_JOINTS[i]
  if (j.end === undefined) return null
  if (Array.isArray(j.end)) return j.end
  const e = restPos(MHR_NAMES.indexOf(j.end))
  const p = restPos(j.mhr)
  return [e[0] - p[0], e[1] - p[1], e[2] - p[2]]
}

export const hasChildren = (i) => BVH_JOINTS.some((j) => j.parent === i)
