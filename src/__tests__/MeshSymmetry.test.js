import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  initMeshSymmetry,
  applySymmetry,
  mirrorMeshes,
  planSymmetry,
  describeSymmetryFrame,
  getSymmetryData,
  restoreSymmetry,
} from '../three/meshSymmetry.js'
import { pairBones, centreFromBones, leftSign, buildGraph, matchMirror } from '../three/symmetryMath.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'
import { useStore } from '../store.js'

const M = 20 // rings along the tube
const S = 8 // points round each ring

// A tube along X from -1 to +1: the middle ring is the centre line. Skinned to Hips (centre), LeftArm (+x) and
// RightArm (-x). `stretch` lengthens the +x half (a long arm on the left).
function makeModel({ stretch = 1, seam = false, openCentre = false } = {}) {
  const SS = seam ? S + 1 : S // a UV seam: the first point of every ring is there twice
  const pos = []
  const skinIndex = []
  const skinWeight = []
  for (let j = 0; j <= M; j++) {
    const x0 = -1 + (2 * j) / M
    const x = openCentre && j === M / 2 ? -0.05 : x0 > 1e-9 ? x0 * stretch : x0
    for (let k = 0; k < SS; k++) {
      const th = (k / S) * Math.PI * 2
      pos.push(x, 0.1 * Math.cos(th) + 1, 0.1 * Math.sin(th))
      const bone = j === M / 2 ? 0 : x0 > 0 ? 1 : 2
      skinIndex.push(bone, 0, 0, 0)
      skinWeight.push(1, 0, 0, 0)
    }
  }
  const index = []
  for (let j = 0; j < M; j++) {
    for (let k = 0; k < S; k++) {
      const a = j * SS + k
      const b = j * SS + (seam ? k + 1 : (k + 1) % S)
      const c = (j + 1) * SS + k
      const d = (j + 1) * SS + (seam ? k + 1 : (k + 1) % S)
      index.push(a, b, c, b, d, c)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4))
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4))
  geo.setIndex(index)
  geo.computeVertexNormals()

  const root = new THREE.Group()
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0)
  const left = new THREE.Bone(); left.name = 'LeftArm'; left.position.set(0.5, 0, 0)
  const right = new THREE.Bone(); right.name = 'RightArm'; right.position.set(-0.5, 0, 0)
  hips.add(left, right)
  root.add(hips)
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial())
  mesh.name = 'Body'
  root.add(mesh)
  root.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton([hips, left, right]))
  return { root, bones: [hips, left, right], meshes: [mesh], mesh, geo }
}

const x = (geo, v) => geo.attributes.position.getX(v)
const ring = (j, k = 0) => j * S + k
const bone = (geo, v) => geo.attributes.skinIndex.getX(v)
const state = () => useStore.getState()

// Is every triangle wound so it faces away from the tube's axis?
function facesOutward(geo) {
  const idx = geo.index.array
  const p = geo.attributes.position
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  let outward = 0
  for (let t = 0; t < idx.length; t += 3) {
    a.fromBufferAttribute(p, idx[t]); b.fromBufferAttribute(p, idx[t + 1]); c.fromBufferAttribute(p, idx[t + 2])
    const n = b.clone().sub(a).cross(c.clone().sub(a))
    const mid = a.clone().add(b).add(c).multiplyScalar(1 / 3)
    const radial = new THREE.Vector3(0, mid.y - 1, mid.z)
    if (n.dot(radial) > 0) outward++
  }
  return outward / (idx.length / 3)
}

beforeEach(() => {
  clearUndoHistory()
  initMeshSymmetry({})
  useStore.setState({ activeCharacterId: 1, characters: {} })
})

describe('symmetry maths', () => {
  it('pairs Left/Right bones, keeps centre bones as their own mirror and finds the centre line', () => {
    const names = ['Hips', 'LeftArm', 'RightArm', 'Tail']
    const pos = new Float32Array([0, 1, 0, 0.5, 1, 0, -0.5, 1, 0, 0.6, 0, 0])
    expect(Array.from(pairBones(names, pos, 0, 0.05))).toEqual([0, 2, 1, -1])
    expect(centreFromBones(names, pos, 9)).toBeCloseTo(0)
    expect(leftSign(names, pos, 0)).toBe(1)
  })

  it('keeps the symmetry frame in model space when the character root is translated', () => {
    const m = makeModel({ stretch: 1.5 })
    m.root.position.x = 5
    m.root.updateMatrixWorld(true)

    expect(describeSymmetryFrame(m, m.mesh).centre).toBeCloseTo(0)
    const plan = planSymmetry(m, m.mesh, { kind: 'symmetrise', sourceSide: 'right' })
    expect(plan.ok).toBe(true)
    expect(plan.stats.pairs).toBeGreaterThan(0)

    const before = Float32Array.from(m.geo.attributes.position.array)
    expect(applySymmetry(m, m.mesh, { kind: 'mirror' }).ok).toBe(true)
    expect(x(m.geo, ring(2, 3))).toBeCloseTo(-before[ring(2, 3) * 3], 5)
  })

  it('matches the two halves of a tube even when one half is stretched', () => {
    const { geo } = makeModel({ stretch: 1.6 })
    const g = buildGraph(Float32Array.from(geo.attributes.position.array), geo.index.array, 1e-4)
    const { map } = matchMirror(g, g, 0, 0.03)
    expect(Array.from(map).every((m) => m >= 0)).toBe(true)
    const a = g.weld.group[ring(5, 3)]
    const b = g.weld.group[ring(M - 5, 3)]
    expect(map[a]).toBe(b)
  })

  it('finds topological partners when asymmetric halves have no centre-line vertices', () => {
    const m = makeModel({ stretch: 1.5, openCentre: true })
    const plan = planSymmetry(m, m.mesh, { kind: 'symmetrise', sourceSide: 'left' })
    expect(plan.ok).toBe(true)
    expect(plan.stats.pairs).toBeGreaterThan(0)
  })
})

describe('symmetrise on a mesh with a UV seam', () => {
  it('still pairs every point, seam copies included', () => {
    const m = makeModel({ stretch: 1.5, seam: true })
    const res = applySymmetry(m, m.mesh, { kind: 'symmetrise', sourceSide: 'left' })
    expect(res.ok).toBe(true)
    const p = m.geo.attributes.position
    const key = (x, y, z) => [x, y, z].map((n) => n.toFixed(3)).join(',')
    const left = []
    const right = []
    for (let v = 0; v < p.count; v++) {
      if (p.getX(v) > 1e-4) left.push(key(-p.getX(v), p.getY(v), p.getZ(v)))
      else if (p.getX(v) < -1e-4) right.push(key(p.getX(v), p.getY(v), p.getZ(v)))
    }
    expect(right.sort()).toEqual(left.sort())
  })
})

describe('symmetrise', () => {
  it('makes the right side match a long left arm and keeps the right-side weights', () => {
    const m = makeModel({ stretch: 1.5 })
    const before = Float32Array.from(m.geo.attributes.position.array)
    const res = applySymmetry(m, m.mesh, { kind: 'symmetrise', sourceSide: 'left' })
    expect(res.ok).toBe(true)
    // the right half is now the mirror of the (long) left half, vertex for vertex
    for (let j = 0; j < M / 2; j++) {
      for (let k = 0; k < S; k++) {
        const L = ring(M - j, k)
        const R = ring(j, k)
        expect(x(m.geo, R)).toBeCloseTo(-before[L * 3], 4)
        expect(m.geo.attributes.position.getY(R)).toBeCloseTo(before[L * 3 + 1], 4)
        expect(bone(m.geo, R)).toBe(2) // still RightArm
      }
    }
    // the left half did not move and is still on the left bone
    for (let v = ring(M / 2 + 1); v < (M + 1) * S; v++) {
      expect(x(m.geo, v)).toBeCloseTo(before[v * 3], 6)
      expect(bone(m.geo, v)).toBe(1)
    }
    expect(m.geo.attributes.position.count).toBe((M + 1) * S)
    expect(facesOutward(m.geo)).toBe(1)
  })

  it('can copy from the right instead', () => {
    const m = makeModel({ stretch: 1.5 })
    const before = Float32Array.from(m.geo.attributes.position.array)
    applySymmetry(m, m.mesh, { kind: 'symmetrise', sourceSide: 'right' })
    // the short right half now overwrites the long left half
    const L = ring(M - 4, 2)
    const R = ring(4, 2)
    expect(x(m.geo, L)).toBeCloseTo(-before[R * 3], 4)
    expect(bone(m.geo, L)).toBe(1)
  })

  it('moves weights across bones: weights copied from the source side land on the opposite bones', () => {
    const m = makeModel()
    m.geo.attributes.skinIndex.setX(ring(M - 3, 1), 1)
    m.geo.attributes.skinWeight.setXYZW(ring(M - 3, 1), 0.7, 0.3, 0, 0)
    m.geo.attributes.skinIndex.setY(ring(M - 3, 1), 0) // second influence on Hips
    applySymmetry(m, m.mesh, { kind: 'symmetrise', sourceSide: 'left' })
    const t = ring(3, 1)
    expect(bone(m.geo, t)).toBe(2)
    expect(m.geo.attributes.skinIndex.getY(t)).toBe(0)
    expect(m.geo.attributes.skinWeight.getX(t)).toBeCloseTo(0.7)
    expect(m.geo.attributes.skinWeight.getY(t)).toBeCloseTo(0.3)
  })

  it('only copies the picked faces when a selection is given', () => {
    const m = makeModel({ stretch: 1.5 })
    const before = Float32Array.from(m.geo.attributes.position.array)
    // the faces between rings 18 and 19 on the left (the far end of the long arm)
    const tris = []
    for (let k = 0; k < S; k++) tris.push((18 * S + k) * 2, (18 * S + k) * 2 + 1)
    const res = applySymmetry(m, m.mesh, { kind: 'symmetrise', sourceSide: 'auto', tris })
    expect(res.ok).toBe(true)
    expect(x(m.geo, ring(1, 0))).toBeCloseTo(-before[ring(19, 0) * 3], 4) // picked: copied
    expect(x(m.geo, ring(2, 0))).toBeCloseTo(-before[ring(18, 0) * 3], 4) // the partner of the other picked ring
    expect(x(m.geo, ring(3, 0))).toBeCloseTo(before[ring(3, 0) * 3], 6) // not picked: untouched
  })

  it('leaves a vertex alone when it is weighted to a bone with no opposite (an added rig)', () => {
    const m = makeModel({ stretch: 1.5 })
    const extra = new THREE.Bone(); extra.name = 'Hair_1'; extra.position.set(0.9, 0, 0)
    m.bones[0].add(extra)
    m.root.updateMatrixWorld(true)
    m.mesh.skeleton.bones.push(extra)
    m.mesh.skeleton.boneInverses.push(new THREE.Matrix4().copy(extra.matrixWorld).invert())
    const target = ring(2, 0)
    m.geo.attributes.skinIndex.setX(target, 3)
    const before = x(m.geo, target)
    const res = applySymmetry(m, m.mesh, { kind: 'symmetrise', sourceSide: 'left' })
    expect(res.ok).toBe(true)
    expect(res.stats.keptForRig).toBeGreaterThan(0)
    expect(x(m.geo, target)).toBeCloseTo(before, 6)
    expect(bone(m.geo, target)).toBe(3)
  })

  it('is one undo step, and redo puts it back', () => {
    const m = makeModel({ stretch: 1.5 })
    const before = Float32Array.from(m.geo.attributes.position.array)
    applySymmetry(m, m.mesh, { kind: 'symmetrise', sourceSide: 'left' })
    const after = Float32Array.from(m.geo.attributes.position.array)
    expect(after).not.toEqual(before)
    performUndo(state())
    expect(Float32Array.from(m.geo.attributes.position.array)).toEqual(before)
    expect(m.root.__symEdits ?? m.__symEdits).toHaveLength(0)
    performRedo(state())
    expect(Float32Array.from(m.geo.attributes.position.array)).toEqual(after)
  })

  it('replays from the saved recipe onto a fresh copy of the model', () => {
    const m = makeModel({ stretch: 1.5 })
    applySymmetry(m, m.mesh, { kind: 'symmetrise', sourceSide: 'left' })
    const data = JSON.parse(JSON.stringify(getSymmetryData(m)))
    const fresh = makeModel({ stretch: 1.5 })
    expect(restoreSymmetry(fresh, data)).toBe(1)
    expect(Array.from(fresh.geo.attributes.position.array)).toEqual(Array.from(m.geo.attributes.position.array))
  })

  it('copies between two separate parts (a left arm part and a right arm part)', () => {
    const a = makeModel({ stretch: 1.5 })
    const b = makeModel({ stretch: 1 })
    // both parts share one skeleton and one model
    b.mesh.bind(a.mesh.skeleton)
    a.meshes.push(b.mesh)
    a.root.add(b.mesh)
    a.root.updateMatrixWorld(true)
    const srcBefore = Float32Array.from(a.geo.attributes.position.array)
    const res = applySymmetry(a, a.mesh, { kind: 'symmetrise', sourceSide: 'left' }, { targetMesh: b.mesh })
    expect(res.ok).toBe(true)
    expect(x(b.geo, ring(M - 3, 0))).toBeCloseTo(-srcBefore[ring(3, 0) * 3], 4)
  })

  it('says so when the two sides do not match at all', () => {
    const m = makeModel()
    const plan = planSymmetry(m, m.mesh, { kind: 'symmetrise', sourceSide: 'left', centre: 5 })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toMatch(/centre line|No matching/)
  })
})

describe('mirror part', () => {
  it('flips the part, swaps left and right weights and keeps the surface facing outward', () => {
    const m = makeModel({ stretch: 1.5 })
    const before = Float32Array.from(m.geo.attributes.position.array)
    expect(applySymmetry(m, m.mesh, { kind: 'mirror' }).ok).toBe(true)
    for (const v of [ring(2, 3), ring(15, 5), ring(M, 0)]) {
      expect(x(m.geo, v)).toBeCloseTo(-before[v * 3], 5)
    }
    expect(bone(m.geo, ring(2, 3))).toBe(1) // was RightArm
    expect(bone(m.geo, ring(15, 5))).toBe(2) // was LeftArm
    expect(bone(m.geo, ring(M / 2, 0))).toBe(0) // centre stays on Hips
    expect(facesOutward(m.geo)).toBe(1)
    performUndo(state())
    expect(Float32Array.from(m.geo.attributes.position.array)).toEqual(before)
    expect(bone(m.geo, ring(2, 3))).toBe(2)
    expect(facesOutward(m.geo)).toBe(1)
  })

  it('invalidates cached skinned bounds after edits, undo and redo', () => {
    const m = makeModel({ stretch: 1.5 })
    m.mesh.computeBoundingBox()
    m.mesh.computeBoundingSphere()
    expect(m.mesh.boundingSphere).not.toBeNull()

    applySymmetry(m, m.mesh, { kind: 'mirror' })
    expect(m.mesh.boundingBox).toBeNull()
    expect(m.mesh.boundingSphere).toBeNull()

    performUndo(state())
    expect(m.mesh.boundingSphere).toBeNull()
    performRedo(state())
    expect(m.mesh.boundingSphere).toBeNull()
  })

  it('restores every non-indexed vertex attribute when undoing a mirror', () => {
    const m = makeModel()
    m.geo.setAttribute('uv', new THREE.Float32BufferAttribute(
      Array.from({ length: m.geo.attributes.position.count * 2 }, (_, i) => i),
      2,
    ))
    m.mesh.geometry = m.geo.toNonIndexed()
    const uvBefore = Float32Array.from(m.mesh.geometry.attributes.uv.array)

    expect(applySymmetry(m, m.mesh, { kind: 'mirror' }).ok).toBe(true)
    expect(Array.from(m.mesh.geometry.attributes.uv.array)).not.toEqual(Array.from(uvBefore))

    performUndo(state())
    expect(Float32Array.from(m.mesh.geometry.attributes.uv.array)).toEqual(uvBefore)
  })
})

describe('viewport buttons', () => {
  it('mirror / symmetrise the selected parts and say what happened', () => {
    const m = makeModel({ stretch: 1.5 })
    const before = Float32Array.from(m.geo.attributes.position.array)
    expect(mirrorMeshes(m, [m.mesh], 'symmetrise', 'left')).toMatch(/Copied the left side to the other side of 1 part/)
    expect(Float32Array.from(m.geo.attributes.position.array)).not.toEqual(before)
    expect(mirrorMeshes(m, [m.mesh], 'mirror')).toMatch(/^Mirrored 1 part/)
    expect(mirrorMeshes(m, [], 'mirror')).toMatch(/Select a part/)
  })
})
