import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initPartRig, planForMesh, applyPartRig, getPartRigData, restorePartRigs, getPartRigEntries, removeLastPartRig, resizeSelection, trisFromClick } from '../three/partRig.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

// A synthetic character: hips > spine > head, a torso strip skinned to the spine, and a cape (a 6x6 grid hanging from
// y = 1.5 to y = 0.5) that is a separate piece skinned to the spine.
const N = 6
function build({ split = false } = {}) {
  const hips = new THREE.Bone(); hips.name = 'hips'
  const spine = new THREE.Bone(); spine.name = 'spine'; spine.position.set(0, 1, 0)
  const head = new THREE.Bone(); head.name = 'head'; head.position.set(0, 0.5, 0)
  hips.add(spine); spine.add(head)
  const pos = []
  const idx = []
  const skinIdx = []
  const skinW = []
  const addV = (x, y, z, w = [1, 0, 0, 0], b = [1, 0, 0, 0]) => { pos.push(x, y, z); skinIdx.push(...b); skinW.push(...w); return pos.length / 3 - 1 }
  // torso: two triangles (not picked)
  const t0 = addV(-0.3, 1.5, 0), t1 = addV(0.3, 1.5, 0), t2 = addV(-0.3, 0.5, 0), t3 = addV(0.3, 0.5, 0)
  idx.push(t0, t2, t1, t1, t2, t3)
  // cape grid
  const g = []
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) g.push(addV(-0.5 + c / (N - 1), 1.5 - r / (N - 1), -0.1, r === 0 ? [0.6, 0.4, 0, 0] : [1, 0, 0, 0], r === 0 ? [1, 2, 0, 0] : [1, 0, 0, 0]))
  for (let r = 0; r < N - 1; r++) for (let c = 0; c < N - 1; c++) {
    const a = g[r * N + c], b = g[r * N + c + 1], d = g[(r + 1) * N + c], e = g[(r + 1) * N + c + 1]
    idx.push(a, d, b, b, d, e)
  }
  if (split) addV(-0.5, 1.5, -0.1, [0.6, 0.4, 0, 0], [1, 2, 0, 0]) // a loose duplicate of the top-left cape vertex (a UV seam)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIdx, 4))
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinW, 4))
  geo.setIndex(idx)
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial())
  mesh.name = 'Body'
  const root = new THREE.Group()
  root.add(mesh, hips)
  root.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton([hips, spine, head]))
  const model = { root, meshes: [mesh], bones: [hips, spine, head], skinnedMeshes: [mesh], skeleton: mesh.skeleton, __poseRestQuats: new Map() }
  const capeTris = []
  for (let t = 2; t < idx.length / 3; t++) capeTris.push(t)
  return { model, mesh, capeTris, hips, spine, head }
}

function posed(mesh) {
  mesh.parent.updateMatrixWorld(true) // the bones too, not just the mesh
  const out = []
  const v = new THREE.Vector3()
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
    v.fromBufferAttribute(mesh.geometry.attributes.position, i)
    mesh.applyBoneTransform(i, v)
    out.push(v.clone())
  }
  return out
}

let changed = 0
beforeEach(() => {
  clearUndoHistory()
  changed = 0
  initPartRig({ scene: new THREE.Scene(), requestRender: () => {}, onBonesChanged: () => { changed++ } })
  useStore.setState({ activeCharacterId: 1, characters: {} })
})

describe('part rig plan', () => {
  it('makes a bone grid and weights that always add up to one', () => {
    const { mesh, capeTris } = build()
    const plan = planForMesh(mesh, capeTris, { segments: 4, columns: 3, direction: 'down' })
    expect(plan.ok).toBe(true)
    expect(plan.bones).toHaveLength(12)
    for (const [, e] of plan.weights) expect(e.w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5)
    // the first bone of each chain hangs from the spine (index 1: it holds most of the cape's weight)
    expect(plan.bones.filter((b) => b.parentLocal < 0).every((b) => b.parentBone === 1)).toBe(true)
  })

  it('keeps the top row on its original skinning and the bottom on the new bones', () => {
    const { mesh, capeTris } = build()
    const plan = planForMesh(mesh, capeTris, { segments: 4, columns: 1, direction: 'down', stick: 0.2 })
    const topVertex = 4 + 0 // first cape vertex (after 4 torso vertices)
    const bottomVertex = 4 + (N - 1) * N
    const top = plan.weights.get(topVertex)
    expect(top.slots.slice(0, 2).sort()).toEqual([1, 2]) // original spine + head, untouched
    expect(plan.weights.get(bottomVertex).slots.every((s, k) => plan.weights.get(bottomVertex).w[k] === 0 || s < 0)).toBe(true)
  })

  it('refuses a part with nothing selected or without skinning', () => {
    const { mesh } = build()
    expect(planForMesh(mesh, [], {}).ok).toBe(false)
    expect(planForMesh(new THREE.Mesh(new THREE.BufferGeometry()), [0], {}).ok).toBe(false)
  })

  it('gives vertices at the same place the same weights (no cracks along a seam)', () => {
    const { mesh, capeTris } = build({ split: true })
    const plan = planForMesh(mesh, capeTris, { segments: 3, columns: 2, direction: 'down' })
    const loose = mesh.geometry.attributes.position.count - 1
    expect(plan.weights.get(loose)).toEqual(plan.weights.get(4))
  })
})

describe('adding the bones', () => {
  it('changes nothing visible on the frame it is added, even in a pose', () => {
    const { model, mesh, capeTris, spine } = build()
    spine.rotation.z = 0.5
    const before = posed(mesh)
    const res = applyPartRig(model, mesh, capeTris, { segments: 4, columns: 3, direction: 'down' }, { label: 'Cape' })
    expect(res.ok).toBe(true)
    const after = posed(mesh)
    before.forEach((p, i) => expect(p.distanceTo(after[i])).toBeLessThan(1e-4))
    expect(mesh.skeleton.bones).toHaveLength(3 + 12)
    expect(model.bones).toHaveLength(3 + 12)
    expect(changed).toBe(1)
  })

  it('bends the hem but not the top when a new bone turns', () => {
    const { model, mesh, capeTris } = build()
    const { entry } = applyPartRig(model, mesh, capeTris, { segments: 4, columns: 1, direction: 'down' }, { label: 'Cape' })
    const before = posed(mesh)
    const first = model.bones.find((b) => b.name === entry.boneNames[0])
    first.rotation.z = 0.6
    const after = posed(mesh)
    const bottom = 4 + (N - 1) * N
    expect(before[bottom].distanceTo(after[bottom])).toBeGreaterThan(0.05)
    expect(before[4].distanceTo(after[4])).toBeLessThan(0.02) // the top row sits at the pivot
  })

  it('is a single undo step, and redo brings it back', () => {
    const { model, mesh, capeTris } = build()
    const w0 = Array.from(mesh.geometry.attributes.skinWeight.array)
    const i0 = Array.from(mesh.geometry.attributes.skinIndex.array)
    applyPartRig(model, mesh, capeTris, { segments: 3, columns: 2 }, { label: 'Cape' })
    const wAfter = Array.from(mesh.geometry.attributes.skinWeight.array)
    performUndo(useStore.getState())
    expect(mesh.skeleton.bones).toHaveLength(3)
    expect(model.bones).toHaveLength(3)
    expect(Array.from(mesh.geometry.attributes.skinWeight.array)).toEqual(w0)
    expect(Array.from(mesh.geometry.attributes.skinIndex.array)).toEqual(i0)
    expect(getPartRigEntries(model)).toHaveLength(0)
    performRedo(useStore.getState())
    expect(mesh.skeleton.bones).toHaveLength(3 + 6)
    expect(Array.from(mesh.geometry.attributes.skinWeight.array)).toEqual(wAfter)
    expect(getPartRigEntries(model)).toHaveLength(1)
  })

  it('removeLast takes the latest bones off, and that is undoable too', () => {
    const { model, mesh, capeTris } = build()
    applyPartRig(model, mesh, capeTris, { segments: 2, columns: 1 }, { label: 'Cape' })
    expect(removeLastPartRig(model)).toBe(true)
    expect(model.bones).toHaveLength(3)
    performUndo(useStore.getState())
    expect(model.bones).toHaveLength(5)
  })

  it('names bones uniquely and safely', () => {
    const { model, mesh, capeTris } = build()
    const a = applyPartRig(model, mesh, capeTris, { segments: 2, columns: 1 }, { label: 'My cape!' })
    expect(a.entry.boneNames).toEqual(['My_cape_1', 'My_cape_2'])
    const b = applyPartRig(model, mesh, capeTris, { segments: 2, columns: 1 }, { label: 'My cape!' })
    expect(new Set([...a.entry.boneNames, ...b.entry.boneNames]).size).toBe(4)
  })

  it('can be saved as a recipe and replayed on a fresh load', () => {
    const one = build()
    applyPartRig(one.model, one.mesh, one.capeTris, { segments: 4, columns: 3, direction: 'down' }, { label: 'Cape' })
    const saved = JSON.parse(JSON.stringify(getPartRigData(one.model)))
    const two = build()
    expect(restorePartRigs(two.model, saved)).toBe(1)
    expect(two.model.bones.map((b) => b.name)).toEqual(one.model.bones.map((b) => b.name))
    expect(Array.from(two.mesh.geometry.attributes.skinWeight.array)).toEqual(Array.from(one.mesh.geometry.attributes.skinWeight.array))
    expect(Array.from(two.mesh.geometry.attributes.skinIndex.array)).toEqual(Array.from(one.mesh.geometry.attributes.skinIndex.array))
  })

  it('skips a saved recipe that no longer fits the mesh', () => {
    const one = build()
    applyPartRig(one.model, one.mesh, one.capeTris, { segments: 2 }, { label: 'Cape' })
    const saved = getPartRigData(one.model)
    saved[0].vertexCount += 3
    const two = build()
    expect(restorePartRigs(two.model, saved)).toBe(0)
    expect(two.model.bones).toHaveLength(3)
  })

  it('upgrades 8-bit skin indices so new bone numbers fit', () => {
    const { model, mesh, capeTris } = build()
    const g = mesh.geometry
    g.setAttribute('skinIndex', new THREE.BufferAttribute(Uint8Array.from(g.attributes.skinIndex.array), 4))
    applyPartRig(model, mesh, capeTris, { segments: 2 }, { label: 'Cape' })
    expect(mesh.geometry.attributes.skinIndex.array).toBeInstanceOf(Uint16Array)
  })
})

describe('picking faces', () => {
  it('a whole piece picks the cape and nothing of the torso', () => {
    const { mesh } = build()
    const tris = trisFromClick(mesh, { faceIndex: 10, point: new THREE.Vector3() }, { mode: 'piece' })
    expect(tris.length).toBe((N - 1) * (N - 1) * 2)
    expect(tris.every((t) => t >= 2)).toBe(true)
  })

  it('the brush stays near the click, and grow / shrink move the edge by a ring', () => {
    const { mesh } = build()
    const hit = { faceIndex: 2, point: new THREE.Vector3(-0.5, 1.5, -0.1) }
    const small = trisFromClick(mesh, hit, { mode: 'brush', radius: 0.25 })
    const big = trisFromClick(mesh, hit, { mode: 'brush', radius: 0.7 })
    expect(small.length).toBeGreaterThan(0)
    expect(big.length).toBeGreaterThan(small.length)
    expect(resizeSelection(mesh, small, 1).length).toBeGreaterThan(small.length)
    expect(resizeSelection(mesh, big, -1).length).toBeLessThan(big.length)
  })

  it('a hood joined to the rest of the mesh keeps its seam attached', () => {
    const { mesh } = build()
    // pick only the top half of the cape's faces and the torso is not joined, so use the cape's own lower half
    const half = []
    for (let t = 2; t < 2 + (N - 1) * (N - 1) * 2; t++) {
      const row = Math.floor((t - 2) / ((N - 1) * 2))
      if (row >= 2) half.push(t)
    }
    const plan = planForMesh(mesh, half, { segments: 3, columns: 1, stick: 0.3 })
    expect(plan.ok).toBe(true)
    // the row shared with the unpicked faces above (row 2 vertices) must keep its original weights
    const seamVertex = 4 + 2 * N
    expect(plan.weights.get(seamVertex).slots[0]).toBe(0 + 1 /* original spine bone */)
  })
})
