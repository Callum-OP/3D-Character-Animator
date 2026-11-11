import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { initPartRig, applyPartRig, setPartRigBodyFollow } from '../three/partRig.js'
import { clearUndoHistory } from '../three/undoHistory.js'
import { initDangle, setDangleConfig, stepDangleLive, clearDangle } from '../three/dangle.js'
import { installRigDeltaShader, isRigDeltaShaderInstalled, skinnedVertexWithRig, RIG_INDEX_BASE } from '../three/rigDeltaShader.js'

// A jacket hem: hips > spine > head, and a hanging sheet of cloth (6x6) whose vertices are skinned to the HIPS (the body part
// that moves the hem), while the added chain hangs from the SPINE. That is the case where a plain rig leaves the hem rigid:
// it follows the spine only, so bending at the hips cannot move it.
const N = 6
function build() {
  const hips = new THREE.Bone(); hips.name = 'hips'
  const spine = new THREE.Bone(); spine.name = 'spine'; spine.position.set(0, 1, 0)
  const head = new THREE.Bone(); head.name = 'head'; head.position.set(0, 0.5, 0)
  hips.add(spine); spine.add(head)
  const pos = []
  const idx = []
  const skinIdx = []
  const skinW = []
  const g = []
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      pos.push(-0.5 + c / (N - 1), 1.5 - r / (N - 1), 0.1)
      skinIdx.push(0, 1, 0, 0)
      skinW.push(r === 0 ? 0.5 : 1, r === 0 ? 0.5 : 0, 0, 0) // the hem follows the hips, the top edge is shared with the spine
      g.push(pos.length / 3 - 1)
    }
  }
  const tris = []
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N - 1; c++) {
      const a = g[r * N + c], b = g[r * N + c + 1], d = g[(r + 1) * N + c], e = g[(r + 1) * N + c + 1]
      idx.push(a, d, b, b, d, e)
      tris.push(tris.length, tris.length + 1)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIdx, 4))
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinW, 4))
  geo.setIndex(idx)
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial())
  mesh.name = 'Jacket'
  const root = new THREE.Group()
  root.add(mesh, hips)
  root.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton([hips, spine, head]))
  const model = { root, meshes: [mesh], bones: [hips, spine, head], skinnedMeshes: [mesh], skeleton: mesh.skeleton, __poseRestQuats: new Map() }
  return { model, mesh, hips, spine, head, tris, hem: pos.length / 3 - 1 }
}

function drawn(mesh) {
  mesh.parent.updateMatrixWorld(true)
  const out = []
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) out.push(skinnedVertexWithRig(mesh, i, new THREE.Vector3()))
  return out
}

const OPTIONS = { segments: 4, columns: 1, direction: 'down', parentBoneName: 'spine', stick: 0 }

beforeEach(() => {
  clearUndoHistory()
  initPartRig({ requestRender: () => {}, onBonesChanged: () => {} })
  useStore.setState({ historyEnabled: true })
})

describe('Blend clothing with body: body first, added bones on top', () => {
  it('patches three\'s skinning chunks once', () => {
    expect(installRigDeltaShader()).toBe(true)
    expect(installRigDeltaShader()).toBe(true) // idempotent: patched exactly once
    expect(isRigDeltaShaderInstalled()).toBe(true)
    expect(THREE.ShaderChunk.skinning_vertex.split('rigDelta').length).toBe(2)
    expect(THREE.ShaderChunk.skinnormal_vertex).toContain('rigDelta')
    expect(THREE.ShaderChunk.skinbase_vertex).toContain('rigIndex')
    expect(THREE.ShaderChunk.skinning_pars_vertex).toContain('attribute vec4 rigWeight')
  })

  it('looks exactly like the rig-free mesh in any body pose while nothing swings', () => {
    const plain = build()
    const rigged = build()
    expect(applyPartRig(rigged.model, rigged.mesh, rigged.tris.map((_, i) => i), OPTIONS, { label: 'Jacket' }).ok).toBe(true)
    setPartRigBodyFollow(rigged.model, true)
    for (const pose of [{ hips: 0.9, spine: 0 }, { hips: 0, spine: 0.7 }, { hips: -0.6, spine: 0.5 }]) {
      for (const m of [plain, rigged]) {
        m.hips.rotation.z = pose.hips
        m.spine.rotation.x = pose.spine
      }
      const a = drawn(plain.mesh)
      const b = drawn(rigged.mesh)
      a.forEach((p, i) => expect(p.distanceTo(b[i])).toBeLessThan(1e-4))
    }
  })

  it('moves the hem with a body bone the added chain is NOT connected to (the jacket-bends-with-the-body case)', () => {
    const plain = build()
    const rigged = build()
    applyPartRig(rigged.model, rigged.mesh, rigged.tris.map((_, i) => i), OPTIONS, { label: 'Jacket' })
    const rest = drawn(rigged.mesh)
    const hem = rigged.hem
    expect(hem).toBeGreaterThan(0)
    // The hem is skinned to the hips, the added chain hangs from the spine. Rotate the SPINE: the plain rig drags the hem
    // along with it (the chain is its only driver), the original skinning leaves it alone.
    const before = rest[hem].clone()
    rigged.spine.rotation.z = 0.8
    const rigidHem = drawn(rigged.mesh)[hem]
    setPartRigBodyFollow(rigged.model, true)
    const followHem = drawn(rigged.mesh)[hem]
    plain.spine.rotation.z = 0.8
    const originalHem = drawn(plain.mesh)[hem]
    expect(rigidHem.distanceTo(before)).toBeGreaterThan(0.2) // the plain rig drags the hem along with the spine
    expect(followHem.distanceTo(originalHem)).toBeLessThan(1e-4) // follow mode: exactly what the body alone does
    expect(followHem.distanceTo(rigidHem)).toBeGreaterThan(0.2)
  })

  it('applies the added bones\' own motion on top of the body, and agrees with the plain rig when the body is at rest', () => {
    const a = build()
    const b = build()
    const ra = applyPartRig(a.model, a.mesh, a.tris.map((_, i) => i), OPTIONS, { label: 'Jacket' })
    const rb = applyPartRig(b.model, b.mesh, b.tris.map((_, i) => i), OPTIONS, { label: 'Jacket' })
    setPartRigBodyFollow(b.model, true)
    for (const m of [ra, rb]) m.entry.result.created[0].rotation.z = 0.5
    // body at rest: the offset equals the plain rig's motion
    const plainSwing = drawn(a.mesh)
    const followSwing = drawn(b.mesh)
    plainSwing.forEach((p, i) => expect(p.distanceTo(followSwing[i])).toBeLessThan(1e-4))
    expect(plainSwing[b.hem].distanceTo(drawn(build().mesh)[b.hem])).toBeGreaterThan(0.01) // and it really did swing
    // body bent: the swing is applied on top of the bent hem, not instead of it
    b.hips.rotation.z = 0.7
    const bentSwing = drawn(b.mesh)[b.hem]
    rb.entry.result.created[0].rotation.z = 0
    const bentRest = drawn(b.mesh)[b.hem]
    const plainBent = build()
    plainBent.hips.rotation.z = 0.7
    expect(bentRest.distanceTo(drawn(plainBent.mesh)[b.hem])).toBeLessThan(1e-4)
    expect(bentSwing.distanceTo(bentRest)).toBeGreaterThan(0.01)
  })

  it('keeps the original body weights in the mesh and the added-bone share in rigIndex / rigWeight', () => {
    const { model, mesh, tris } = build()
    const original = Array.from(mesh.geometry.attributes.skinWeight.array)
    const { entry } = applyPartRig(model, mesh, tris.map((_, i) => i), OPTIONS, { label: 'Jacket' })
    expect(Array.from(mesh.geometry.attributes.skinWeight.array)).not.toEqual(original) // plain rig: skinned to the new bones
    setPartRigBodyFollow(model, true)
    expect(Array.from(mesh.geometry.attributes.skinWeight.array)).toEqual(original)
    const rigIndex = mesh.geometry.getAttribute('rigIndex')
    const rigWeight = mesh.geometry.getAttribute('rigWeight')
    expect(rigIndex.itemSize).toBe(4)
    const hem = N * N - 1
    const [start, end] = [entry.result.startIndex, entry.result.startIndex + entry.result.created.length]
    let total = 0
    for (let k = 0; k < 4; k++) {
      const stored = rigIndex.getComponent(hem, k)
      if (stored >= RIG_INDEX_BASE) {
        expect(stored - RIG_INDEX_BASE).toBeGreaterThanOrEqual(start)
        expect(stored - RIG_INDEX_BASE).toBeLessThan(end)
        total += rigWeight.getComponent(hem, k)
      }
    }
    expect(total).toBeCloseTo(1, 4)
    // turning it off removes the extra attributes and the slot offsets again
    setPartRigBodyFollow(model, false)
    expect(mesh.geometry.getAttribute('rigIndex')).toBeUndefined()
    expect(mesh.geometry.getAttribute('rigWeight')).toBeUndefined()
    expect(mesh.skeleton.__rigHooked).toBeFalsy()
    mesh.skeleton.update()
    const bone = entry.result.created[0]
    const slot = mesh.skeleton.bones.indexOf(bone)
    const expected = new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, mesh.skeleton.boneInverses[slot])
    expect(Array.from(mesh.skeleton.boneMatrices.slice(slot * 16, slot * 16 + 16))).toEqual(expected.toArray().map((x) => expect.closeTo(x, 5)))
  })

  it('stores each added bone as an offset from its body parent (identity while nothing swings)', () => {
    const { model, mesh, tris, spine } = build()
    const { entry } = applyPartRig(model, mesh, tris.map((_, i) => i), OPTIONS, { label: 'Jacket' })
    setPartRigBodyFollow(model, true)
    spine.rotation.z = 1.1 // the body moves a lot ...
    mesh.parent.updateMatrixWorld(true)
    mesh.skeleton.update()
    for (const bone of entry.result.created) {
      const slot = mesh.skeleton.bones.indexOf(bone)
      const m = new THREE.Matrix4().fromArray(mesh.skeleton.boneMatrices, slot * 16)
      m.elements.forEach((x, i) => expect(x).toBeCloseTo(new THREE.Matrix4().elements[i], 4)) // ... but the offset is still the identity
    }
  })

  it('still lets live dangle physics swing the hem while the body bends', () => {
    const { model, mesh, tris, hips } = build()
    const { entry } = applyPartRig(model, mesh, tris.map((_, i) => i), OPTIONS, { label: 'Jacket' })
    setPartRigBodyFollow(model, true)
    initDangle({ requestRender: () => {} })
    const id = 'body-follow-physics'
    setDangleConfig(id, model, true, [{ id: 'jacket', boneNames: entry.boneNames, stiffness: 0.1, gravity: 1, damping: 0.2 }])
    hips.rotation.z = 0.8
    const hem = N * N - 1
    const before = drawn(mesh)[hem]
    for (let i = 0; i < 90; i++) stepDangleLive(1 / 60)
    const after = drawn(mesh)[hem]
    clearDangle(id)
    expect(after.distanceTo(before)).toBeGreaterThan(0.01)
  })
})
