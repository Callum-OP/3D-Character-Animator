import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { initAnimation, setAnimationModel, poseFromBVHText } from '../three/animation.js'
import { bvhSingleFrame } from '../three/bvhText.js'

// A synthetic T-pose BVH skeleton (frame 1 swings the arms forward) - no real model assets.
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


describe('poseFromBVHText (body presets)', () => {
  function setup() {
    const model = humanoid('', 0)
    initAnimation({ requestRender() {}, setContinuousRender() {}, resumePosing() {}, suspendPosing() {}, onEnded() {} })
    setAnimationModel(model, 'c1')
    return model
  }

  it('returns only the bones the file drives, as a pose, and leaves the character as it was', async () => {
    const model = setup()
    const arm = model.bones.find((b) => b.name === 'LeftArm')
    arm.quaternion.setFromEuler(new THREE.Euler(0.3, 0.2, 0.1)) // a pose already on screen
    const before = model.bones.map((b) => b.quaternion.clone())
    const pose = await poseFromBVHText(bvhSingleFrame(BVH, 1), 'arms')
    model.bones.forEach((b, i) => expect(b.quaternion.equals(before[i])).toBe(true))
    expect(pose.LeftArm).toBeDefined()
    expect(pose.Hips).toBeDefined()
    // frame 1 raised the left arm 90 degrees about Z: the arm differs a lot from rest, the head is untouched
    const q = (n) => new THREE.Quaternion(...pose[n])
    expect(q('LeftArm').angleTo(new THREE.Quaternion())).toBeGreaterThan(1)
    expect(q('Head').angleTo(new THREE.Quaternion())).toBeLessThan(0.05)
  })

  it('frame 0 of the same file is the plain T-pose', async () => {
    setup()
    const pose = await poseFromBVHText(bvhSingleFrame(BVH, 0), 'tpose')
    expect(new THREE.Quaternion(...pose.LeftArm).angleTo(new THREE.Quaternion())).toBeLessThan(0.05)
  })

  it('refuses without a model loaded', async () => {
    const { clearAnimationModel } = await import('../three/animation.js')
    clearAnimationModel('c1')
    await expect(poseFromBVHText(BVH)).rejects.toThrow(/Load a model/)
  })
})
