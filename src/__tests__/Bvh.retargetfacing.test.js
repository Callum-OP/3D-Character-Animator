import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { parseBVH, buildSlotMapping, mergeNames, buildNameMatch, retargetParsed, detectFacingYaw } from '../three/bvh.js'

// A BVH whose frame 0 is a T-pose and frame 1 swings both arms FORWARD (+Z, the
// way mocap faces), kicks the left leg forward, and nothing else.
function joint(name, off, depth, kids, ch = 3, end = null) {
  const pad = '\t'.repeat(depth)
  let s = `${pad}${depth === 0 ? 'ROOT' : 'JOINT'} ${name}\n${pad}{\n${pad}\tOFFSET ${off.join(' ')}\n`
  s += `${pad}\tCHANNELS ${ch} ${ch === 6 ? 'Xposition Yposition Zposition ' : ''}Zrotation Xrotation Yrotation\n`
  if (kids.length) s += kids.join('')
  else s += `${pad}\tEnd Site\n${pad}\t{\n${pad}\t\tOFFSET ${end.join(' ')}\n${pad}\t}\n`
  return s + `${pad}}\n`
}
const arm = (side, sign, d) =>
  joint(`${side}Shoulder`, [sign * 0.08, 0.15, 0], d, [
    joint(`${side}Arm`, [sign * 0.28, 0, 0], d + 1, [joint(`${side}ForeArm`, [sign * 0.28, 0, 0], d + 2, [joint(`${side}Hand`, [sign * 0.1, 0, 0], d + 3, [], 3, [sign * 0.08, 0, 0])])]),
  ])
const leg = (side, sign, d) =>
  joint(`${side}UpLeg`, [sign * 0.09, -0.05, 0], d, [joint(`${side}Leg`, [0, -0.42, 0], d + 1, [joint(`${side}Foot`, [0, -0.42, 0], d + 2, [joint(`${side}Toe`, [0, -0.05, 0.12], d + 3, [], 3, [0, 0, 0.08])])])])
const hierarchy = joint('Hips', [0, 0.95, 0], 0, [
  joint('Spine', [0, 0.12, 0], 1, [joint('Chest', [0, 0.15, 0], 2, [joint('Neck', [0, 0.2, 0], 3, [joint('Head', [0, 0.1, 0], 4, [], 3, [0, 0.15, 0])]), arm('Left', 1, 3), arm('Right', -1, 3)])]),
  leg('Left', 1, 1),
  leg('Right', -1, 1),
], 6)
const order = [...hierarchy.matchAll(/(?:ROOT|JOINT) (\w+)/g)].map((m) => m[1])
const frame = (rot) => ['0', '0.95', '0', ...order.flatMap((n) => (rot[n] || [0, 0, 0]).map(String))].join(' ')
const BVH = `HIERARCHY\n${hierarchy}MOTION\nFrames: 2\nFrame Time: 0.5\n${frame({})}\n${frame({ LeftArm: [0, 0, -90], RightArm: [0, 0, 90], LeftUpLeg: [0, -60, 0] })}\n`

// A T-pose humanoid facing +Z (left on +X) whose root can be turned.
function humanoid(prefix, yaw = 0) {
  const root = new THREE.Group()
  const mk = (n, x, y, z, parent) => { const b = new THREE.Bone(); b.name = prefix + n; b.position.set(x, y, z); parent.add(b); return b }
  const hips = mk('Hips', 0, 0.95, 0, root)
  const spine = mk('Spine', 0, 0.12, 0, hips), chest = mk('Chest', 0, 0.15, 0, spine), neck = mk('Neck', 0, 0.2, 0, chest), head = mk('Head', 0, 0.1, 0, neck)
  const bones = [hips, spine, chest, neck, head]
  for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
    const sh = mk(side + 'Shoulder', sign * 0.08, 0.15, 0, chest), a = mk(side + 'Arm', sign * 0.28, 0, 0, sh), f = mk(side + 'ForeArm', sign * 0.28, 0, 0, a), h = mk(side + 'Hand', sign * 0.1, 0, 0, f)
    const up = mk(side + 'UpLeg', sign * 0.09, -0.05, 0, hips), l = mk(side + 'Leg', 0, -0.42, 0, up), ft = mk(side + 'Foot', 0, -0.42, 0, l), t = mk(side + 'Toe', 0, -0.05, 0.12, ft)
    bones.push(sh, a, f, h, up, l, ft, t)
  }
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  mesh.add(hips); mesh.bind(new THREE.Skeleton(bones)); root.add(mesh)
  root.rotation.y = yaw
  root.updateMatrixWorld(true)
  return { root, skinnedMeshes: [mesh], meshes: [], skeleton: mesh.skeleton, bones }
}

async function retarget(model) {
  const parsed = await parseBVH({ name: 'm.bvh', text: async () => BVH })
  const names = model.bones.map((b) => b.name)
  parsed.autoNames = buildNameMatch(names, parsed.bones)
  const slots = buildSlotMapping(names, parsed.bones, model.bones, parsed.skeleton.bones)
  const { names: map, hip } = mergeNames(parsed.autoNames, slots)
  const { clip } = retargetParsed(parsed, model, map, hip)
  return clip
}

// Pose the model at the clip's last frame and report how far, along the model's
// OWN forward direction, the left hand and left foot end up.
function forwardness(model, clip) {
  const bone = (re) => model.bones.find((b) => re.test(b.name))
  const wp = (b) => b.getWorldPosition(new THREE.Vector3())
  model.root.updateMatrixWorld(true)
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(model.root.quaternion)
  const mixer = new THREE.AnimationMixer(model.root)
  const action = mixer.clipAction(clip)
  action.setLoop(THREE.LoopOnce)
  action.clampWhenFinished = true // hold the last frame instead of wrapping back to the first
  action.play()
  mixer.setTime(0.5)
  model.root.updateMatrixWorld(true)
  return {
    hand: wp(bone(/LeftHand$/)).sub(wp(bone(/LeftArm$/))).dot(fwd),
    foot: wp(bone(/LeftFoot$/)).sub(wp(bone(/Hips$/))).dot(fwd),
  }
}

describe('retargeting follows the way the character faces', () => {
  it('a character facing +Z is unchanged: arms and legs go forward', async () => {
    const m = humanoid('a_')
    const r = forwardness(m, await retarget(m))
    expect(r.hand).toBeGreaterThan(0.3)
    expect(r.foot).toBeGreaterThan(0.6)
  })

  it('a character turned the other way (facing -Z) swings arms and legs to ITS front, not its back', async () => {
    const m = humanoid('b_', Math.PI)
    const r = forwardness(m, await retarget(m))
    expect(r.hand).toBeGreaterThan(0.3)
    expect(r.foot).toBeGreaterThan(0.6)
  })

  it.each([90, -90, 135, -60])('works for a character turned %i degrees', async (deg) => {
    const m = humanoid('c_', (deg * Math.PI) / 180)
    const r = forwardness(m, await retarget(m))
    expect(r.hand).toBeGreaterThan(0.3)
    expect(r.foot).toBeGreaterThan(0.6)
  })

  it('a facing within a few degrees of +Z is left exactly as it was (no behaviour change for ordinary rigs)', async () => {
    const a = humanoid('d_', 0)
    const b = humanoid('e_', (6 * Math.PI) / 180)
    const clipA = await retarget(a)
    const clipB = await retarget(b)
    const pa = forwardness(a, clipA)
    const pb = forwardness(b, clipB)
    expect(pb.hand).toBeCloseTo(pa.hand, 2)
    expect(detectFacingYaw(b.bones, new Map(b.bones.map((x) => [x, x.getWorldPosition(new THREE.Vector3())])))).toBe(0)
  })

  it('reads the facing from the left/right pairs, in the right direction', () => {
    for (const deg of [180, 90, -90, 150]) {
      const m = humanoid('f_', (deg * Math.PI) / 180)
      const restP = new Map(m.bones.map((x) => [x, x.getWorldPosition(new THREE.Vector3())]))
      const yaw = detectFacingYaw(m.bones, restP)
      const want = THREE.MathUtils.euclideanModulo((deg * Math.PI) / 180 + Math.PI, Math.PI * 2) - Math.PI
      expect(THREE.MathUtils.euclideanModulo(yaw - want + Math.PI, Math.PI * 2) - Math.PI).toBeCloseTo(0, 3)
    }
  })

  it('does not throw and assumes +Z when the rig has no recognisable left/right bones', () => {
    const b1 = new THREE.Bone(); b1.name = 'x1'
    const b2 = new THREE.Bone(); b2.name = 'x2'
    b1.add(b2)
    const restP = new Map([[b1, new THREE.Vector3()], [b2, new THREE.Vector3(0, 1, 0)]])
    expect(detectFacingYaw([b1, b2], restP)).toBe(0)
  })
})