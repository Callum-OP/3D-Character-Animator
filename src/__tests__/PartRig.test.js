import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { useStore } from '../store.js'
import { initPartRig, planForMesh, applyPartRig, updatePartRig, getPartRigData, restorePartRigs, getPartRigEntries, getPartRigDependents, removeLastPartRig, removePartRig, planForMeshes, resizeSelection, trisFromClick, setPartRigBodyFollow } from '../three/partRig.js'
import { cloneForExport } from '../three/exportPose.js'
import { skinnedVertexWithRig } from '../three/rigDeltaShader.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'
import { clearDangle, initDangle, setDangleConfig, stepDangleLive } from '../three/dangle.js'

// A synthetic character: hips > spine > head, a torso strip skinned to the spine, and a cape (a 6x6 grid hanging from
// y = 1.5 to y = 0.5) that is a separate piece skinned to the spine.
const N = 6
function build({ split = false, innerLayer = false } = {}) {
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
  let inner = []
  if (innerLayer) {
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) inner.push(addV(-0.5 + c / (N - 1), 1.5 - r / (N - 1), -0.12))
    for (let r = 0; r < N - 1; r++) for (let c = 0; c < N - 1; c++) {
      const a = inner[r * N + c], b = inner[r * N + c + 1], d = inner[(r + 1) * N + c], e = inner[(r + 1) * N + c + 1]
      idx.push(a, d, b, b, d, e)
    }
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
  return { model, mesh, capeTris, hips, spine, head, inner }
}

function posed(mesh) {
  mesh.parent.updateMatrixWorld(true) // the bones too, not just the mesh
  const out = []
  const v = new THREE.Vector3()
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
    skinnedVertexWithRig(mesh, i, v) // the drawn position, including the added bones' offsets in follow mode
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

  it('can extend a surface selection to a nearby disconnected inner layer', () => {
    const { mesh, capeTris, inner } = build({ innerLayer: true })
    const selected = capeTris.slice(0, 2)
    const without = planForMesh(mesh, selected, { segments: 3, columns: 1 })
    const withNearby = planForMesh(mesh, selected, {
      segments: 3,
      columns: 1,
      includeNearbySurfaces: true,
      nearbySurfaceDistance: 0.03,
    })
    expect(without.weights.has(inner[0])).toBe(false)
    expect(inner.some((vertex) => withNearby.weights.has(vertex))).toBe(true)
  })

  it('can blend added-bone skinning back to the original weights', () => {
    const { mesh, capeTris } = build()
    const plan = planForMesh(mesh, capeTris, { segments: 3, columns: 1, influence: 0 })
    expect(plan.ok).toBe(true)
    for (const [, entry] of plan.weights) {
      expect(entry.slots.every((slot, i) => entry.w[i] === 0 || slot >= 0)).toBe(true)
    }
  })
})

describe('adding the bones', () => {
  it('blends body bends and added bone motion, and restores the original rig weights when disabled', () => {
    const { model, mesh, capeTris, spine } = build()
    const bottom = 4 + (N - 1) * N
    // The hem originally follows the hips, while the added chain hangs from the spine.
    for (let v = 4 + N; v < 4 + N * N; v++) mesh.geometry.attributes.skinIndex.setX(v, 0)
    const { entry } = applyPartRig(model, mesh, capeTris, { segments: 4, columns: 1, direction: 'down', parentBoneName: 'spine', stick: 0 }, { label: 'Jacket' })
    const originalIndices = Array.from(mesh.geometry.attributes.skinIndex.array)
    const originalWeights = Array.from(mesh.geometry.attributes.skinWeight.array)
    spine.rotation.z = 0.8
    const rigged = posed(mesh)[bottom]
    setPartRigBodyFollow(model, true)
    const blended = posed(mesh)[bottom]
    expect(blended.distanceTo(rigged)).toBeGreaterThan(0.1)
    const bone = entry.result.created[0]
    bone.rotation.z = 0.6
    const swung = posed(mesh)[bottom]
    expect(swung.distanceTo(blended)).toBeGreaterThan(0.03)
    setPartRigBodyFollow(model, false)
    expect(Array.from(mesh.geometry.attributes.skinIndex.array)).toEqual(originalIndices)
    expect(Array.from(mesh.geometry.attributes.skinWeight.array)).toEqual(originalWeights)
  })

  it('keeps body-follow weights through rig removal and undo', () => {
    const { model, mesh, capeTris } = build()
    const { entry } = applyPartRig(model, mesh, capeTris, { segments: 3, columns: 1 }, { label: 'Jacket' })
    setPartRigBodyFollow(model, true)
    const expected = Array.from(mesh.geometry.attributes.skinWeight.array)
    expect(removePartRig(model, entry.id)).toBe(true)
    performUndo(useStore.getState())
    expect(Array.from(mesh.geometry.attributes.skinWeight.array)).toEqual(expected)
    setPartRigBodyFollow(model, false)
    expect(model.__partRigBodyFollow).toBe(false)
  })

  it('creates and restores rigs using their unblended weights while the toggle is enabled', () => {
    const { model, mesh, capeTris } = build()
    setPartRigBodyFollow(model, true)
    const { entry } = applyPartRig(model, mesh, capeTris, { segments: 3, columns: 1, stick: 0 }, { label: 'Jacket' })
    const blended = Array.from(mesh.geometry.attributes.skinWeight.array)
    const saved = getPartRigData(model)
    setPartRigBodyFollow(model, false)
    expect(Array.from(mesh.geometry.attributes.skinWeight.array)).not.toEqual(blended)
    const restored = build()
    expect(restorePartRigs(restored.model, saved)).toBe(1)
    setPartRigBodyFollow(restored.model, true)
    expect(Array.from(restored.mesh.geometry.attributes.skinWeight.array)).toEqual(blended)
    expect(entry.result.meshes[0].oldW[0]).toBeCloseTo(0.6)
  })

  it('still moves the clothing during live bone physics', () => {
    const { model, mesh, capeTris, spine } = build()
    const { entry } = applyPartRig(model, mesh, capeTris, { segments: 4, columns: 1, direction: 'down', stick: 0 }, { label: 'Jacket' })
    setPartRigBodyFollow(model, true)
    initDangle({ requestRender: () => {} })
    const id = 'body-follow-test'
    setDangleConfig(id, model, true, [{ id: 'jacket', boneNames: entry.boneNames, stiffness: 0.1, gravity: 1, damping: 0.2 }])
    spine.rotation.z = 0.8
    const bottom = 4 + (N - 1) * N
    const before = posed(mesh)[bottom]
    for (let i = 0; i < 90; i++) stepDangleLive(1 / 60)
    const after = posed(mesh)[bottom]
    clearDangle(id)
    expect(after.distanceTo(before)).toBeGreaterThan(0.03)
  })

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

  it('updates and deletes a rig without invalidating later rigs, and both actions are undoable', () => {
    const { model, mesh, capeTris } = build()
    const first = applyPartRig(model, mesh, capeTris, { segments: 3 }, { label: 'Cape' }).entry
    const second = applyPartRig(model, mesh, capeTris, { segments: 2, parentBoneName: 'spine' }, { label: 'Scarf' }).entry
    const update = updatePartRig(model, first.id, { label: 'Cape edited', options: { segments: 1, columns: 1 } })
    expect(update.ok).toBe(true)
    expect(update.entry.boneNames).toHaveLength(1)
    performUndo(useStore.getState())
    expect(getPartRigEntries(model).find((entry) => entry.id === first.id).boneNames).toHaveLength(3)
    performRedo(useStore.getState())
    expect(getPartRigEntries(model).find((entry) => entry.id === first.id).boneNames).toHaveLength(1)

    expect(removePartRig(model, first.id)).toBe(true)
    expect(mesh.skeleton.bones).toHaveLength(3 + second.boneNames.length)
    expect(Array.from(mesh.geometry.attributes.skinIndex.array).every((index) => index < mesh.skeleton.bones.length)).toBe(true)
    expect(mesh.geometry.attributes.skinWeight.array.some((weight, i) => weight > 0 && mesh.geometry.attributes.skinIndex.array[i] >= 3)).toBe(true)
    performUndo(useStore.getState())
    expect(mesh.skeleton.bones).toHaveLength(3 + 1 + second.boneNames.length)
    performUndo(useStore.getState())
    expect(mesh.skeleton.bones).toHaveLength(3 + 3 + second.boneNames.length)
  })

  it('never removes dependent rigs implicitly and explains the dependency', () => {
    const { model, mesh, capeTris } = build()
    const parent = applyPartRig(model, mesh, capeTris, { segments: 2 }, { label: 'Parent' }).entry
    const child = applyPartRig(model, mesh, capeTris, {
      segments: 2,
      parentBoneName: parent.boneNames[0],
      allowAddedBoneAttachment: true,
    }, { label: 'Child' }).entry
    expect(getPartRigDependents(model, parent.id)).toEqual([child])
    expect(removePartRig(model, parent.id)).toBe(false)
    expect(getPartRigEntries(model).map((entry) => entry.id)).toEqual([parent.id, child.id])
    expect(model.skeleton.bones).toHaveLength(7)
    expect(removePartRig(model, child.id)).toBe(true)
    expect(removePartRig(model, parent.id)).toBe(true)
    expect(model.skeleton.bones).toHaveLength(3)
  })

  it('does not auto-attach to added bones unless explicitly enabled', () => {
    const { model, mesh, capeTris } = build()
    const parent = applyPartRig(model, mesh, capeTris, { segments: 2 }, { label: 'Parent' }).entry
    const automatic = planForMeshes([mesh], [{ mesh, tris: capeTris }], { segments: 2 }, parent.boneNames)
    expect(automatic.ok).toBe(true)
    expect(parent.boneNames).not.toContain(mesh.skeleton.bones[automatic.pieces[0].parentBone].name)

    const blocked = planForMeshes([mesh], [{ mesh, tris: capeTris }], {
      segments: 2,
      parentBoneName: parent.boneNames[0],
    }, parent.boneNames)
    expect(blocked.ok).toBe(false)
    const allowed = planForMeshes([mesh], [{ mesh, tris: capeTris }], {
      segments: 2,
      parentBoneName: parent.boneNames[0],
      allowAddedBoneAttachment: true,
    }, parent.boneNames)
    expect(allowed.ok).toBe(true)
    expect(mesh.skeleton.bones[allowed.pieces[0].parentBone].name).toBe(parent.boneNames[0])

    expect(updatePartRig(model, parent.id, { options: { segments: 3 } }).ok).toBe(true)
    expect(removePartRig(model, parent.id)).toBe(true)
    expect(model.skeleton.bones).toHaveLength(3)
  })

  it('builds one continuous rig across selected meshes that share a character skeleton', () => {
    const one = build()
    const secondMesh = new THREE.SkinnedMesh(one.mesh.geometry.clone(), one.mesh.material)
    secondMesh.name = 'Cape second half'
    secondMesh.bind(one.mesh.skeleton, one.mesh.bindMatrix)
    one.model.root.add(secondMesh)
    one.model.meshes.push(secondMesh)
    one.model.skinnedMeshes.push(secondMesh)

    const middle = Math.floor(one.capeTris.length / 2)
    const selections = [
      { mesh: one.mesh, tris: one.capeTris.slice(0, middle) },
      { mesh: secondMesh, tris: one.capeTris.slice(middle) },
    ]
    const plan = planForMeshes([one.mesh, secondMesh], selections, { segments: 4, columns: 1, perPiece: false })
    expect(plan.ok).toBe(true)
    const result = applyPartRig(one.model, [one.mesh, secondMesh], selections, { segments: 4, columns: 1, perPiece: false }, { label: 'Across' })
    expect(result.ok).toBe(true)
    expect(result.entry.meshIndices).toEqual([0, 1])
    expect(result.entry.boneNames).toHaveLength(4)
    expect(one.mesh.skeleton.bones).toHaveLength(7)
    expect(secondMesh.skeleton).toBe(one.mesh.skeleton)
    expect(Array.from(secondMesh.geometry.attributes.skinIndex.array).some((index) => index >= 3)).toBe(true)

    const saved = JSON.parse(JSON.stringify(getPartRigData(one.model)))
    const restored = build()
    const restoredSecond = new THREE.SkinnedMesh(restored.mesh.geometry.clone(), restored.mesh.material)
    restoredSecond.name = 'Cape second half'
    restoredSecond.bind(restored.mesh.skeleton, restored.mesh.bindMatrix)
    restored.model.root.add(restoredSecond)
    restored.model.meshes.push(restoredSecond)
    restored.model.skinnedMeshes.push(restoredSecond)
    expect(restorePartRigs(restored.model, saved)).toBe(1)
    expect(restored.model.bones.map((bone) => bone.name)).toEqual(one.model.bones.map((bone) => bone.name))
    expect(Array.from(restoredSecond.geometry.attributes.skinIndex.array)).toEqual(Array.from(secondMesh.geometry.attributes.skinIndex.array))
  })

  it('includes added bones in the exported glTF skin', async () => {
    const { model, mesh, capeTris } = build()
    const { entry } = applyPartRig(model, mesh, capeTris, { segments: 3 }, { label: 'Cape' })
    const exported = new THREE.Group()
    exported.add(cloneForExport(model.root))
    const json = await new Promise((resolve, reject) => {
      new GLTFExporter().parse(exported, resolve, reject, { binary: false, onlyVisible: true })
    })
    const nodeNames = new Set(json.nodes.map((node) => node.name))
    expect(entry.boneNames.every((name) => nodeNames.has(name))).toBe(true)
    expect(json.skins[0].joints.some((index) => entry.boneNames.includes(json.nodes[index].name))).toBe(true)
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
    expect(restorePartRigs(two.model, saved)).toBe(0)
    expect(two.model.bones).toHaveLength(one.model.bones.length)
  })

  it('keeps copied rigs serializable and safe when adding and undoing new rigs', () => {
    const { model, mesh, capeTris } = build()
    const copiedRig = applyPartRig(model, mesh, capeTris, { segments: 2 }, { label: 'Cape' }).entry
    const savedRig = { ...copiedRig }
    delete savedRig.result
    model.__rigAdds = [savedRig]

    const saved = getPartRigData(model)
    expect(saved).toHaveLength(1)
    expect(saved[0].vertexCounts).toEqual([mesh.geometry.index.count])
    const restored = build()
    expect(restorePartRigs(restored.model, saved)).toBe(1)
    expect(restored.model.bones.map((bone) => bone.name)).toEqual(model.bones.map((bone) => bone.name))

    const added = applyPartRig(model, mesh, capeTris, { segments: 1 }, { label: 'Scarf' })
    expect(added.ok).toBe(true)
    performUndo(useStore.getState())
    expect(mesh.skeleton.bones).toHaveLength(3 + copiedRig.boneNames.length)
    expect(getPartRigData(model)).toHaveLength(1)
  })

  it('skips a saved recipe that no longer fits the mesh', () => {
    const one = build()
    applyPartRig(one.model, one.mesh, one.capeTris, { segments: 2 }, { label: 'Cape' })
    const saved = getPartRigData(one.model)
    saved[0].vertexCount += 3
    const two = build()
    const skipped = []
    expect(restorePartRigs(two.model, saved, { onSkip: (entry) => skipped.push(entry) })).toBe(0)
    expect(skipped).toEqual([expect.objectContaining({ label: 'Cape', reason: 'the mesh topology changed' })])
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
