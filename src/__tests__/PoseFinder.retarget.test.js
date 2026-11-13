// A neutral (all-identity) Pose Finder clip must retarget to a character's OWN rest pose: no leaning neck, no
// tips or thumbs bent away from the hand. Uses the real BVH importer with a Mixamo-style T-pose character.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { parseBVH, buildSlotMapping, mergeNames, buildNameMatch, retargetParsed } from '../three/bvh.js'
import { writeBVH } from '../three/poseFinder/bvhWrite.js'
import { BVH_JOINTS } from '../three/poseFinder/humanoid.js'

function neutralBVH(frames = 3) {
  const rot = BVH_JOINTS.map(() => { const a = new Float32Array(frames * 4); for (let k = 0; k < frames; k++) a[k * 4 + 3] = 1; return a })
  const root = new Float32Array(frames * 3); for (let k = 0; k < frames; k++) root[k * 3 + 1] = 92
  return writeBVH({ fps: 30, count: frames, root, rot, restFrame: false })
}

// T-pose character, left on +X, facing +Z, straight spine/neck, hands along the arms with 3 finger segments.
function character() {
  const P = 'mixamorig:'
  const root = new THREE.Group()
  const mk = (n, x, y, z, parent) => { const b = new THREE.Bone(); b.name = P + n; b.position.set(x, y, z); parent.add(b); return b }
  const hips = mk('Hips', 0, 0.95, 0, root)
  const spine = mk('Spine', 0, 0.1, 0, hips), s1 = mk('Spine1', 0, 0.12, 0, spine), s2 = mk('Spine2', 0, 0.12, 0, s1)
  const neck = mk('Neck', 0, 0.1, 0, s2), head = mk('Head', 0, 0.12, 0, neck), top = mk('HeadTop_End', 0, 0.15, 0, head)
  const bones = [hips, spine, s1, s2, neck, head, top]
  for (const [S, sign] of [['Left', 1], ['Right', -1]]) {
    const sh = mk(`${S}Shoulder`, sign * 0.05, 0.12, 0, s2), arm = mk(`${S}Arm`, sign * 0.12, 0, 0, sh), fore = mk(`${S}ForeArm`, sign * 0.27, 0, 0, arm), hand = mk(`${S}Hand`, sign * 0.25, 0, 0, fore)
    bones.push(sh, arm, fore, hand)
    for (const [F, dir, start] of [['Thumb', [0, 0, 1], [sign * 0.02, -0.01, 0.02]], ['Index', [sign, 0, 0], [sign * 0.08, 0, 0.02]], ['Middle', [sign, 0, 0], [sign * 0.08, 0, 0]], ['Ring', [sign, 0, 0], [sign * 0.075, 0, -0.02]], ['Pinky', [sign, 0, 0], [sign * 0.07, 0, -0.04]]]) {
      let parent = hand
      for (let i = 1; i <= 4; i++) {
        const b = mk(`${S}Hand${F}${i}`, ...(i === 1 ? start : dir.map((d) => d * 0.03)), parent)
        bones.push(b); parent = b
      }
    }
    const up = mk(`${S}UpLeg`, sign * 0.09, -0.05, 0, hips), leg = mk(`${S}Leg`, 0, -0.42, 0, up), foot = mk(`${S}Foot`, 0, -0.42, 0, leg), toe = mk(`${S}ToeBase`, 0, -0.05, 0.12, foot)
    bones.push(up, leg, foot, toe)
  }
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  mesh.add(hips); mesh.bind(new THREE.Skeleton(bones)); root.add(mesh)
  root.updateMatrixWorld(true)
  return { root, skinnedMeshes: [mesh], meshes: [], skeleton: mesh.skeleton, bones }
}

async function retarget(model, bvhText) {
  const parsed = await parseBVH({ name: 'pose.bvh', text: async () => bvhText })
  const names = model.bones.map((b) => b.name)
  parsed.autoNames = buildNameMatch(names, parsed.bones)
  const slots = buildSlotMapping(names, parsed.bones, model.bones, parsed.skeleton.bones)
  const { names: map, hip } = mergeNames(parsed.autoNames, slots)
  return retargetParsed(parsed, model, map, hip)
}

describe('a neutral Pose Finder clip leaves the character in its own rest pose', () => {
  it('every driven bone keeps its rest orientation relative to its parent (no tips-up, no hooked thumb, no leaning neck)', async () => {
    const model = character()
    const rest = new Map(model.bones.map((b) => [b.name, b.quaternion.clone()]))
    const { clip, matched } = await retarget(model, neutralBVH())
    expect(matched).toBeGreaterThan(40)
    const worst = []
    for (const t of clip.tracks) {
      if (!t.name.endsWith('.quaternion')) continue
      const name = t.name.replace('.quaternion', '')
      const q = new THREE.Quaternion().fromArray(t.values, 0)
      worst.push([name, (q.angleTo(rest.get(name)) * 180) / Math.PI])
    }
    const bad = worst.filter(([n, a]) => a > 3 && /Hand(Thumb|Index|Middle|Ring|Pinky)|Neck|Head|Spine/.test(n))
    expect(bad, JSON.stringify(bad)).toEqual([])
  })
})
