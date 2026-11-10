import * as THREE from 'three'
import { planPartRig, normaliseOptions } from './partRigMath.js'
import { pushSceneHistory } from './sceneHistory.js'
import { getAdjacency, growRegion, toRanges, fromRanges, regionVertexCount } from './regions.js'
import { followFlattener } from './flattener.js'
import { addFlattenerUniforms } from './flattenerShader.js'

export { fromRanges }

// ---------------------------------------------------------------------------
// Part rigging: give a piece of a skinned mesh (a hair strand, a hood, a cape, a scarf...) its own
// chain of bones, with the skin weights worked out for you.
//
// The user picks faces; partRigMath.js works out bones + weights (in bind space); this file puts them
// into the live skeleton:
//   - new Bones are parented to the bone the piece hangs from (and to each other along the chain),
//     each a pure offset from its parent, so on the frame they are added NOTHING moves: a vertex
//     weighted to a new bone gets exactly the transform its old parent bone gave it.
//   - they are appended to each selected mesh's skeleton (bone + bone-inverse), so existing skin
//     indices stay valid, and the touched vertices' skinIndex / skinWeight are rewritten.
// What is saved with a project is only the recipe (faces + options + bone names). It is replayed on
// load, so a project file stays small and the model file is never modified.
// ---------------------------------------------------------------------------

const hooks = { scene: null, requestRender: null, onBonesChanged: null }

export function initPartRig(h) {
  hooks.scene = h.scene || null
  hooks.requestRender = h.requestRender || null
  hooks.onBonesChanged = h.onBonesChanged || null
}

const render = () => hooks.requestRender && hooks.requestRender()

export function isRigCapable(mesh) {
  const a = mesh && mesh.geometry && mesh.geometry.attributes
  return !!(mesh && mesh.isSkinnedMesh && mesh.skeleton && a && a.skinIndex && a.skinWeight && a.position)
}

export function safeBoneName(label) {
  const s = String(label || 'Part').trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return s || 'Part'
}

// A label no other added-bone rig on this model already uses ("Cape", then "Cape_2"). Two rigs sharing a
// label is what used to make renaming one of them drag the other one's physics chains along with it.
export function uniqueRigLabel(model, label, excludeId = null) {
  const base = safeBoneName(label)
  const used = new Set(((model && model.__rigAdds) || []).filter((e) => e.id !== excludeId).map((e) => e.label))
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base}_${n}`)) n++
  return `${base}_${n}`
}

// --- planning --------------------------------------------------------------------

const bindPositionCache = new WeakMap() // geometry -> { matrix: string, positions }

// A part's positions were rewritten (mirror / symmetrise): forget the copy planning keeps.
export function invalidatePartRigGeometry(geo) {
  bindPositionCache.delete(geo)
}

function bindSpacePositions(mesh) {
  const geo = mesh.geometry
  const key = mesh.bindMatrix.elements.join(',')
  const hit = bindPositionCache.get(geo)
  if (hit && hit.key === key && hit.count === geo.attributes.position.count) return hit.positions
  const pos = geo.attributes.position
  const out = new Float32Array(pos.count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix)
    out[i * 3] = v.x
    out[i * 3 + 1] = v.y
    out[i * 3 + 2] = v.z
  }
  bindPositionCache.set(geo, { key, count: pos.count, positions: out })
  return out
}

function boneBindMatrix(mesh, i) {
  const inv = mesh.skeleton.boneInverses[i]
  return inv ? inv.clone().invert() : null
}

function resolveParentIndex(mesh, options) {
  if (!options || !options.parentBoneName) return null
  const i = mesh.skeleton.bones.findIndex((b) => b.name === options.parentBoneName)
  return i >= 0 ? i : null
}

export function planForMesh(mesh, tris, options = {}, generatedBoneNames = []) {
  return planForMeshes([mesh], [{ mesh, tris }], options, generatedBoneNames)
}

function compatibleRigMeshes(meshes) {
  if (!meshes.length || meshes.some((mesh) => !isRigCapable(mesh))) return false
  const first = meshes[0].skeleton
  return meshes.every((mesh) =>
    mesh.skeleton.bones.length === first.bones.length &&
    mesh.skeleton.boneInverses.length === first.boneInverses.length &&
    mesh.skeleton.bones.every((bone, i) => bone === first.bones[i]) &&
    mesh.skeleton.boneInverses.every((matrix, i) =>
      matrix && first.boneInverses[i]
        ? matrix.elements.every((v, k) => Math.abs(v - first.boneInverses[i].elements[k]) < 1e-5)
        : !!matrix === !!first.boneInverses[i],
    ),
  )
}

export function planForMeshes(meshes, selections, options = {}, generatedBoneNames = []) {
  if (!compatibleRigMeshes(meshes)) {
    return { ok: false, reason: 'Choose skinned parts from the same character skeleton to make one continuous rig.' }
  }
  const skeleton = meshes[0].skeleton
  const parentBone = resolveParentIndex(meshes[0], options)
  const o = { ...normaliseOptions(options), parentBone }
  if (options && options.parentBoneName && parentBone == null) {
    return { ok: false, reason: 'That bone is not part of this mesh’s skeleton.' }
  }
  const totalVertices = meshes.reduce((n, mesh) => n + mesh.geometry.attributes.position.count, 0)
  const totalIndices = meshes.reduce((n, mesh) => n + (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count), 0)
  const positions = new Float32Array(totalVertices * 3)
  const index = new Uint32Array(totalIndices)
  const skinIndex = new Uint32Array(totalVertices * 4)
  const skinWeight = new Float32Array(totalVertices * 4)
  const tris = []
  const vertexOffsets = new Map()
  let vertexOffset = 0
  let triangleOffset = 0
  let indexOffset = 0
  for (const mesh of meshes) {
    const geo = mesh.geometry
    const count = geo.attributes.position.count
    vertexOffsets.set(mesh, vertexOffset)
    positions.set(bindSpacePositions(mesh), vertexOffset * 3)
    const sourceIndex = geo.index ? geo.index.array : null
    for (let i = 0; i < (sourceIndex ? sourceIndex.length : count); i++) {
      index[indexOffset + i] = (sourceIndex ? sourceIndex[i] : i) + vertexOffset
    }
    skinIndex.set(geo.attributes.skinIndex.array, vertexOffset * 4)
    skinWeight.set(geo.attributes.skinWeight.array, vertexOffset * 4)
    const selected = selections.find((s) => s.mesh === mesh)?.tris || []
    for (const tri of selected) tris.push(triangleOffset + tri)
    vertexOffset += count
    const meshIndexCount = sourceIndex ? sourceIndex.length : count
    triangleOffset += meshIndexCount / 3
    indexOffset += meshIndexCount
  }
  if (!options.allowAddedBoneAttachment && generatedBoneNames.length) {
    const generated = new Set(generatedBoneNames)
    const remap = new Map()
    skeleton.bones.forEach((bone, i) => {
      if (!generated.has(bone.name)) return
      let parent = bone.parent
      while (parent && generated.has(parent.name)) parent = parent.parent
      const parentIndex = skeleton.bones.indexOf(parent)
      if (parentIndex >= 0) remap.set(i, parentIndex)
    })
    for (let i = 0; i < skinIndex.length; i++) {
      const parentIndex = remap.get(skinIndex[i])
      if (parentIndex != null) skinIndex[i] = parentIndex
    }
  }
  const generatedSet = new Set(generatedBoneNames)
  if (!options.allowAddedBoneAttachment && options.parentBoneName && generatedSet.has(options.parentBoneName)) {
    return { ok: false, reason: 'Enable “Allow attachment to added bones” to attach this rig to an existing added bone.' }
  }
  const m4 = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const bindCache = new Map()
  const plan = planPartRig({
    positions,
    index,
    tris,
    skinIndex,
    skinWeight,
    boneBind: (i) => {
      if (!bindCache.has(i)) {
        const m = boneBindMatrix(meshes[0], i)
        bindCache.set(i, m ? p.setFromMatrixPosition(m4.copy(m)).toArray() : null)
      }
      return bindCache.get(i)
    },
    options: o,
  })
  return plan.ok ? { ...plan, vertexOffsets, selections: selections.map((s) => ({ mesh: s.mesh, tris: s.tris })) } : plan
}

// --- applying --------------------------------------------------------------------

function ensureSkinAttributes(geo) {
  const si = geo.attributes.skinIndex
  if (!(si.array instanceof Uint16Array) && !(si.array instanceof Uint32Array)) {
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(Uint16Array.from(si.array), 4))
  }
  const sw = geo.attributes.skinWeight
  if (!(sw.array instanceof Float32Array)) {
    const out = new Float32Array(sw.array.length)
    const norm = sw.normalized
    const max = sw.array instanceof Uint8Array ? 255 : sw.array instanceof Uint16Array ? 65535 : 1
    for (let i = 0; i < out.length; i++) out[i] = norm ? sw.array[i] / max : sw.array[i]
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(out, 4))
  }
}

function allBoneNames(model) {
  return new Set((model.bones || []).map((b) => b.name))
}

function uniqueName(base, used) {
  let name = base
  let n = 2
  while (used.has(name)) name = `${base}_${n++}`
  used.add(name)
  return name
}

function makeNames(plan, label, model) {
  const used = allBoneNames(model)
  const base = safeBoneName(label)
  const pieces = plan.pieces.length
  return plan.bones.map((b) => {
    const cols = plan.pieces[b.piece].columns
    let n = base
    if (pieces > 1) n += `${b.piece + 1}`
    if (cols > 1) n += `_c${b.col + 1}`
    return uniqueName(`${n}_${b.seg + 1}`, used)
  })
}

function refreshSkeleton(skeleton) {
  skeleton.boneMatrices = new Float32Array(skeleton.bones.length * 16)
  skeleton.dispose() // drops the bone texture; it is rebuilt at the new size on the next draw
  skeleton.update()
}

function writeSkin(mesh, verts, idxArr, wArr) {
  const geo = mesh.geometry
  const si = geo.attributes.skinIndex
  const sw = geo.attributes.skinWeight
  for (let n = 0; n < verts.length; n++) {
    const v = verts[n]
    for (let k = 0; k < 4; k++) {
      si.array[v * 4 + k] = idxArr[n * 4 + k]
      sw.array[v * 4 + k] = wArr[n * 4 + k]
    }
  }
  si.needsUpdate = true
  sw.needsUpdate = true
}

function rigSkeletons(entry) {
  const result = entry.result
  return result.skeletons || Array.from(new Set((result.meshes || [result]).map((item) => item.mesh.skeleton)))
}

function remapIndex(value, start, count, removing, removedBoneParents) {
  if (removing) {
    if (value >= start && value < start + count) return removedBoneParents.get(value) ?? start
    return value >= start + count ? value - count : value
  }
  return value >= start ? value + count : value
}

function remapIndexArray(array, start, count, removing, removedBoneParents) {
  for (let i = 0; i < array.length; i++) {
    array[i] = remapIndex(array[i], start, count, removing, removedBoneParents)
  }
}

function reindexRigBones(model, skeletons, start, count, removing, excludedEntry) {
  const skeletonSet = new Set(skeletons)
  const removedBoneParents = new Map()
  if (removing) {
    const skeleton = skeletons[0]
    const removed = new Set(skeleton.bones.slice(start, start + count))
    for (const bone of removed) {
      let parent = bone.parent
      while (parent && removed.has(parent)) parent = parent.parent
      const parentIndex = skeleton.bones.indexOf(parent)
      removedBoneParents.set(skeleton.bones.indexOf(bone), parentIndex >= 0 ? parentIndex : start)
    }
  }

  for (const mesh of model.meshes || []) {
    if (!mesh.skeleton || !skeletonSet.has(mesh.skeleton)) continue
    const attr = mesh.geometry?.attributes?.skinIndex
    if (!attr) continue
    remapIndexArray(attr.array, start, count, removing, removedBoneParents)
    attr.needsUpdate = true
  }
  for (const entry of model.__rigAdds || []) {
    if (entry === excludedEntry || !entry.result) continue
    if (!rigSkeletons(entry).some((skeleton) => skeletonSet.has(skeleton))) continue
    for (const meshResult of entry.result.meshes || [entry.result]) {
      remapIndexArray(meshResult.oldIdx, start, count, removing, removedBoneParents)
      remapIndexArray(meshResult.newIdx, start, count, removing, removedBoneParents)
    }
    if (removing) {
      if (entry.result.baseCount >= start + count) entry.result.baseCount -= count
      if (entry.result.startIndex >= start + count) entry.result.startIndex -= count
    } else if (entry.result.baseCount >= start) {
      entry.result.baseCount += count
      if (entry.result.startIndex >= start) entry.result.startIndex += count
    }
  }
}

function applyActiveRigWeights(model) {
  const entries = (model.__rigAdds || [])
    .filter((entry) => entry.result)
    .sort((a, b) => a.result.startIndex - b.result.startIndex)
  for (const entry of entries) {
    for (const meshResult of entry.result.meshes || [entry.result]) {
      if (model.__partRigBodyFollow) {
        const { indices, weights } = blendBodyWeights(meshResult, entry.result.startIndex ?? entry.result.baseCount, entry.result.created.length)
        writeSkin(meshResult.mesh, meshResult.verts, indices, weights)
      } else {
        writeSkin(meshResult.mesh, meshResult.verts, meshResult.newIdx, meshResult.newW)
      }
    }
  }
}

// Keep two slots for each skinning source so the body's bending and the added
// bones' motion both survive glTF's usual four-influence limit.
function blendBodyWeights(result, startIndex, boneCount) {
  const indices = new Uint32Array(result.verts.length * 4)
  const weights = new Float32Array(indices.length)
  for (let n = 0; n < result.verts.length; n++) {
    let hasAddedInfluence = false
    for (let k = 0; k < 4; k++) {
      const i = n * 4 + k
      if (result.newW[i] > 0 && result.newIdx[i] >= startIndex && result.newIdx[i] < startIndex + boneCount) hasAddedInfluence = true
    }
    if (!hasAddedInfluence) {
      indices.set(result.newIdx.subarray(n * 4, n * 4 + 4), n * 4)
      weights.set(result.newW.subarray(n * 4, n * 4 + 4), n * 4)
      continue
    }
    const groups = [[result.oldIdx, result.oldW], [result.newIdx, result.newW]]
    const combined = new Map()
    for (const [group, [sourceIndices, sourceWeights]] of groups.entries()) {
      const source = new Map()
      for (let k = 0; k < 4; k++) {
        const i = n * 4 + k
        if (sourceWeights[i] > 0) source.set(sourceIndices[i], (source.get(sourceIndices[i]) || 0) + sourceWeights[i])
      }
      const sorted = [...source].sort((a, b) => b[1] - a[1])
      const strongest = sorted.slice(0, 2)
      if (group === 1 && !strongest.some(([index]) => index >= startIndex && index < startIndex + boneCount)) {
        const added = sorted.find(([index]) => index >= startIndex && index < startIndex + boneCount)
        if (added) strongest[1] = added
      }
      const total = strongest.reduce((sum, item) => sum + item[1], 0)
      if (!total) continue
      for (const [index, weight] of strongest) {
        combined.set(index, (combined.get(index) || 0) + weight / total * 0.5)
      }
    }
    const slots = [...combined].sort((a, b) => b[1] - a[1])
    const total = slots.reduce((sum, item) => sum + item[1], 0)
    for (let k = 0; k < slots.length; k++) {
      indices[n * 4 + k] = slots[k][0]
      weights[n * 4 + k] = slots[k][1] / total
    }
  }
  return { indices, weights }
}

export function setPartRigBodyFollow(model, enabled) {
  if (!model || model.__partRigBodyFollow === !!enabled) return
  model.__partRigBodyFollow = !!enabled
  applyActiveRigWeights(model)
  render()
}

// Add the planned bone chains to one or more compatible skinned meshes.
export function applyPartRig(model, meshOrMeshes, trisOrSelections, options = {}, { label = 'Part', names = null, record = true, id = null } = {}) {
  const bodyFollow = !!model.__partRigBodyFollow
  if (bodyFollow) setPartRigBodyFollow(model, false)
  const meshes = Array.isArray(meshOrMeshes) ? meshOrMeshes : [meshOrMeshes]
  const selections = Array.isArray(meshOrMeshes)
    ? trisOrSelections
    : [{ mesh: meshOrMeshes, tris: trisOrSelections }]
  const generatedBoneNames = (model.__rigAdds || []).flatMap((entry) => entry.boneNames)
  const plan = planForMeshes(meshes, selections, options, generatedBoneNames)
  if (!plan.ok) {
    if (bodyFollow) setPartRigBodyFollow(model, true)
    return plan
  }
  for (const mesh of meshes) ensureSkinAttributes(mesh.geometry)
  const skeleton = meshes[0].skeleton
  const skeletons = Array.from(new Set(meshes.map((mesh) => mesh.skeleton)))
  const baseCount = skeleton.bones.length
  const boneNames = names && names.length === plan.bones.length ? names : makeNames(plan, label, model)

  // bones
  const created = []
  const bindWorld = []
  const tmp = new THREE.Vector3()
  const newInverses = []
  plan.bones.forEach((b, i) => {
    const parentM = b.parentLocal >= 0 ? bindWorld[b.parentLocal] : boneBindMatrix(meshes[0], b.parentBone)
    const local = tmp.fromArray(b.world).applyMatrix4(parentM.clone().invert()).clone()
    const bone = new THREE.Bone()
    bone.name = boneNames[i]
    bone.position.copy(local)
    const m = parentM.clone().multiply(new THREE.Matrix4().makeTranslation(local.x, local.y, local.z))
    bindWorld[i] = m
    newInverses[i] = m.clone().invert()
    ;(b.parentLocal >= 0 ? created[b.parentLocal] : skeleton.bones[b.parentBone]).add(bone)
    created[i] = bone
  })

  const meshResults = meshes.map((mesh) => {
    const geo = mesh.geometry
    const offset = plan.vertexOffsets.get(mesh)
    const count = geo.attributes.position.count
    const verts = Array.from(plan.weights.keys()).filter((v) => v >= offset && v < offset + count).map((v) => v - offset)
    const oldIdx = new Uint32Array(verts.length * 4)
    const oldW = new Float32Array(verts.length * 4)
    const newIdx = new Uint32Array(verts.length * 4)
    const newW = new Float32Array(verts.length * 4)
    const si = geo.attributes.skinIndex
    const sw = geo.attributes.skinWeight
    verts.forEach((v, n) => {
      const e = plan.weights.get(offset + v)
      for (let k = 0; k < 4; k++) {
        oldIdx[n * 4 + k] = si.array[v * 4 + k]
        oldW[n * 4 + k] = sw.array[v * 4 + k]
        newIdx[n * 4 + k] = e.slots[k] >= 0 ? e.slots[k] : baseCount + (-1 - e.slots[k])
        newW[n * 4 + k] = e.w[k]
      }
    })
    return { mesh, verts, oldIdx, oldW, newIdx, newW, baseCount }
  })
  const parents = new Map(created.map((b) => [b, b.parent]))
  const startIndex = baseCount
  for (const target of skeletons) {
    target.bones.push(...created)
    target.boneInverses.push(...newInverses.map((matrix) => matrix.clone()))
    refreshSkeleton(target)
  }
  for (const r of meshResults) writeSkin(r.mesh, r.verts, r.newIdx, r.newW)
  model.bones.push(...created)
  if (model.__poseRestQuats) for (const b of created) model.__poseRestQuats.set(b, b.quaternion.clone())

  const rootBoneNames = []
  plan.bones.forEach((b, i) => { if (b.parentLocal < 0) rootBoneNames.push(boneNames[i]) })
  const entry = {
    id: id || `rig_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    label: safeBoneName(label),
    meshIndex: model.meshes.indexOf(meshes[0]),
    meshName: meshes[0].name || '',
    meshIndices: meshes.map((mesh) => model.meshes.indexOf(mesh)),
    meshNames: meshes.map((mesh) => mesh.name || ''),
    tris: toRanges(selections.find((s) => s.mesh === meshes[0])?.tris || []),
    trisByMesh: meshes.map((mesh) => toRanges(selections.find((s) => s.mesh === mesh)?.tris || [])),
    vertexCount: regionVertexCount(meshes[0].geometry),
    options: { ...options },
    boneNames,
    rootBoneNames,
    parentNames: plan.pieces.map((p) => skeleton.bones[p.parentBone].name),
    result: { meshes: meshResults, skeletons, created, parents, newInverses, baseCount, startIndex },
  }
  if (!model.__rigAdds) model.__rigAdds = []
  model.__rigAdds.push(entry)
  if (bodyFollow) setPartRigBodyFollow(model, true)
  if (hooks.onBonesChanged) hooks.onBonesChanged(model)
  render()

  if (record) {
    pushSceneHistory(
      () => detachEntry(model, entry),
      () => attachEntry(model, entry),
    )
  }
  return { ok: true, entry, plan }
}

function detachEntry(model, entry) {
  const r = entry.result
  if (!r) return
  for (const meshResult of r.meshes || [r]) {
    writeSkin(meshResult.mesh, meshResult.verts, meshResult.oldIdx, meshResult.oldW)
  }
  for (const b of r.created) b.removeFromParent()
  model.__rigAdds = (model.__rigAdds || []).filter((e) => e !== entry)
  const startIndex = r.startIndex ?? r.baseCount
  reindexRigBones(model, rigSkeletons(entry), startIndex, r.created.length, true, entry)
  for (const skeleton of rigSkeletons(entry)) {
    skeleton.bones.splice(startIndex, r.created.length)
    skeleton.boneInverses.splice(startIndex, r.created.length)
    refreshSkeleton(skeleton)
  }
  const gone = new Set(r.created)
  model.bones = model.bones.filter((b) => !gone.has(b))
  applyActiveRigWeights(model)
  if (hooks.onBonesChanged) hooks.onBonesChanged(model)
  render()
}

function attachEntry(model, entry) {
  const r = entry.result
  if (!r) return
  const startIndex = r.startIndex ?? r.baseCount
  reindexRigBones(model, rigSkeletons(entry), startIndex, r.created.length, false, entry)
  // each bone goes back under the parent it had
  r.created.forEach((bone) => {
    const parent = r.parents && r.parents.get(bone)
    if (parent) parent.add(bone)
  })
  for (const skeleton of rigSkeletons(entry)) {
    skeleton.bones.splice(startIndex, 0, ...r.created)
    skeleton.boneInverses.splice(startIndex, 0, ...r.newInverses.map((matrix) => matrix.clone()))
    refreshSkeleton(skeleton)
  }
  model.bones.push(...r.created)
  if (model.__poseRestQuats) for (const b of r.created) model.__poseRestQuats.set(b, b.quaternion.clone())
  if (!model.__rigAdds) model.__rigAdds = []
  model.__rigAdds.push(entry)
  model.__rigAdds.sort((a, b) => (a.result?.startIndex ?? Infinity) - (b.result?.startIndex ?? Infinity))
  applyActiveRigWeights(model)
  if (hooks.onBonesChanged) hooks.onBonesChanged(model)
  render()
}

// Undo the most recent addition (the same as Ctrl+Z, but from the list).
export function removeLastPartRig(model) {
  const list = model.__rigAdds || []
  const entry = list[list.length - 1]
  if (!entry || !entry.result) return false
  return removePartRig(model, entry.id)
}

export function removePartRig(model, id) {
  const entry = (model.__rigAdds || []).find((item) => item.id === id)
  if (!entry || !entry.result || getPartRigDependents(model, id).length) return false
  detachEntry(model, entry)
  pushSceneHistory(
    () => attachEntry(model, entry),
    () => detachEntry(model, entry),
  )
  return true
}

export function updatePartRig(model, id, { label, options } = {}) {
  const entry = (model.__rigAdds || []).find((item) => item.id === id)
  if (!entry || !entry.result) return { ok: false, reason: 'That bone rig is no longer available.' }
  const dependents = getPartRigDependents(model, id)
  if (dependents.length) {
    return { ok: false, reason: `Remove dependent rigs first: ${dependents.map((item) => item.label).join(', ')}.` }
  }
  const meshes = (entry.result.meshes || [entry.result]).map((item) => item.mesh)
  const ranges = entry.trisByMesh || [entry.tris]
  const selections = meshes.map((mesh, i) => ({ mesh, tris: fromRanges(ranges[i] || []) }))
  const nextLabel = label ?? entry.label
  const nextOptions = options ?? entry.options
  detachEntry(model, entry)
  const result = applyPartRig(model, meshes, selections, nextOptions, {
    label: nextLabel,
    record: false,
    id: entry.id,
  })
  if (!result.ok) {
    attachEntry(model, entry)
    return result
  }
  const updated = result.entry
  pushSceneHistory(
    () => {
      detachEntry(model, updated)
      attachEntry(model, entry)
    },
    () => {
      detachEntry(model, entry)
      attachEntry(model, updated)
    },
  )
  return { ...result, entry: updated }
}

export function getPartRigDependents(model, id) {
  const entry = (model && model.__rigAdds || []).find((item) => item.id === id)
  if (!entry) return []
  const names = new Set(entry.boneNames)
  return getPartRigEntries(model).filter((other) =>
    other.id !== id && (other.parentNames || []).some((name) => names.has(name)),
  )
}

export function getPartRigEntries(model) {
  return (model && model.__rigAdds) || []
}

// The recipe saved with a project.
export function getPartRigData(model) {
  return getPartRigEntries(model).map((e) => {
    const meshIndices = e.meshIndices || [e.meshIndex]
    const meshes = meshIndices.map((index, i) => e.result?.meshes?.[i]?.mesh || model?.meshes?.[index])
    if (meshes.some((mesh) => !mesh)) return null
    return {
      id: e.id,
      label: e.label,
      meshIndex: e.meshIndex,
      meshName: e.meshName,
      meshIndices: e.meshIndices,
      meshNames: e.meshNames,
      tris: e.tris,
      trisByMesh: e.trisByMesh,
      vertexCount: e.vertexCount ?? regionVertexCount(meshes[0].geometry),
      vertexCounts: meshes.map((mesh) => regionVertexCount(mesh.geometry)),
      options: e.options,
      boneNames: e.boneNames,
    }
  }).filter(Boolean)
}

// Replay saved recipes onto a freshly loaded model. Entries that no longer fit the mesh are skipped.
export function restorePartRigs(model, saved, { onSkip } = {}) {
  let restored = 0
  for (const s of saved || []) {
    if (getPartRigEntries(model).some((entry) => entry.id === s.id)) continue
    const indices = s.meshIndices || [s.meshIndex]
    const meshes = indices.map((index) => model.meshes[index])
    const skip = (reason) => onSkip?.({ id: s.id, label: s.label || 'Added bones', reason })
    if (meshes.some((mesh, i) => !mesh || !isRigCapable(mesh) || ((s.meshNames || [s.meshName])[i] && mesh.name !== (s.meshNames || [s.meshName])[i]))) {
      skip('the saved mesh is missing or changed')
      continue
    }
    if (!compatibleRigMeshes(meshes)) {
      skip('the saved meshes no longer share a compatible skeleton')
      continue
    }
    const vertexCounts = indices.length === 1 && s.vertexCount != null
      ? [s.vertexCount]
      : (s.vertexCounts || [])
    if (vertexCounts.some((count, i) => count !== regionVertexCount(meshes[i].geometry))) {
      skip('the mesh topology changed')
      continue
    }
    const ranges = s.trisByMesh || [s.tris]
    const selections = meshes.map((mesh, i) => ({ mesh, tris: fromRanges(ranges[i] || []) }))
    const options = { ...(s.options || {}) }
    if (options.parentBoneName && getPartRigEntries(model).some((entry) => entry.boneNames.includes(options.parentBoneName))) {
      options.allowAddedBoneAttachment = true
    }
    const res = applyPartRig(model, meshes, selections, options, { label: s.label, names: s.boneNames, record: false, id: s.id })
    if (res.ok) restored++
    else skip(res.reason)
  }
  return restored
}

// --- picking faces ------------------------------------------------------------------

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()

function triCentreWorld(mesh, t, out) {
  const geo = mesh.geometry
  const idx = geo.index
  const pos = geo.attributes.position
  const vs = [0, 1, 2].map((k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k))
  for (const [k, target] of [[0, _a], [1, _b], [2, _c]]) {
    target.fromBufferAttribute(pos, vs[k])
    if (mesh.isSkinnedMesh) mesh.applyBoneTransform(vs[k], target)
  }
  out.copy(_a).add(_b).add(_c).multiplyScalar(1 / 3)
  return out.applyMatrix4(mesh.matrixWorld)
}

// Faces picked by a click at `hit` ({ faceIndex, point }). mode: 'face' | 'piece' | 'color' | 'brush'.
export function trisFromClick(mesh, hit, { mode = 'piece', tolerance = 0.25, radius = 0.1 } = {}) {
  const seed = hit.faceIndex
  if (mode === 'face') return [seed]
  if (mode === 'piece') return growRegion(mesh, seed, { mode: 'piece' })
  if (mode === 'color') return growRegion(mesh, seed, { mode: 'color', tolerance })
  // brush: connected faces whose centre is within `radius` (world units) of the click
  const { offsets, list } = getAdjacency(mesh.geometry)
  mesh.updateMatrixWorld(true)
  const centre = new THREE.Vector3()
  const point = hit.point
  const seen = new Set([seed])
  const stack = [seed]
  const out = []
  const r2 = radius * radius
  while (stack.length) {
    const t = stack.pop()
    triCentreWorld(mesh, t, centre)
    if (centre.distanceToSquared(point) > r2 && t !== seed) continue
    out.push(t)
    for (let i = offsets[t]; i < offsets[t + 1]; i++) {
      const n = list[i]
      if (!seen.has(n)) { seen.add(n); stack.push(n) }
    }
  }
  return out
}

// Grow (+1) or shrink (-1) a selection by one ring of faces.
export function resizeSelection(mesh, tris, delta) {
  const set = new Set(tris)
  const { offsets, list } = getAdjacency(mesh.geometry)
  if (delta > 0) {
    for (const t of Array.from(set)) for (let i = offsets[t]; i < offsets[t + 1]; i++) set.add(list[i])
    return Array.from(set)
  }
  const keep = []
  for (const t of set) {
    let edge = false
    for (let i = offsets[t]; i < offsets[t + 1]; i++) if (!set.has(list[i])) { edge = true; break }
    if (!edge) keep.push(t)
  }
  return keep.length ? keep : Array.from(set)
}

// --- viewport feedback ------------------------------------------------------------------

const highlights = new Map()
let preview = null

function noOutline(obj) {
  obj.traverse((o) => {
    if (!o.material) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of mats) m.userData.outlineParameters = { visible: false }
  })
}

export function setPartRigHighlight(mesh, tris) {
  const previous = mesh ? highlights.get(mesh) : null
  if (previous) {
    previous.removeFromParent()
    previous.geometry.dispose()
    previous.material.dispose()
    highlights.delete(mesh)
  } else if (!mesh) {
    for (const object of highlights.values()) {
      object.removeFromParent()
      object.geometry.dispose()
      object.material.dispose()
    }
    highlights.clear()
  }
  if (mesh && tris && tris.length && hooks.scene) {
    mesh.updateMatrixWorld(true)
    const geo = mesh.geometry
    const pos = geo.attributes.position
    const out = new Float32Array(tris.length * 9)
    const v = new THREE.Vector3()
    tris.forEach((t, n) => {
      for (let k = 0; k < 3; k++) {
        const vi = geo.index ? geo.index.getX(t * 3 + k) : t * 3 + k
        v.fromBufferAttribute(pos, vi)
        if (mesh.isSkinnedMesh) mesh.applyBoneTransform(vi, v)
        v.applyMatrix4(mesh.matrixWorld)
        out.set([v.x, v.y, v.z], n * 9 + k * 3)
      }
    })
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(out, 3))
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff2bd6, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false,
    })
    mat.onBeforeCompile = (shader) => addFlattenerUniforms(shader.uniforms) // follow the flatten effect
    const highlight = new THREE.Mesh(g, mat)
    followFlattener(highlight, mesh)
    highlight.name = '(part rig highlight)'
    highlight.frustumCulled = false
    highlight.renderOrder = 998
    noOutline(highlight)
    hooks.scene.add(highlight)
    highlights.set(mesh, highlight)
  }
  render()
}

// World position of a bind-space point, as it would be shown right now (follows the parent bone's pose).
function bindPointToWorld(mesh, parentBone, p) {
  const bone = mesh.skeleton.bones[parentBone]
  const skin = new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, mesh.skeleton.boneInverses[parentBone])
  return new THREE.Vector3().fromArray(p).applyMatrix4(skin).applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld)
}

export function setPartRigPreview(mesh, plan) {
  if (preview) {
    preview.removeFromParent()
    preview.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose() })
    preview = null
  }
  if (mesh && plan && plan.ok && hooks.scene) {
    mesh.updateMatrixWorld(true)
    mesh.skeleton.bones.forEach((b) => b.updateWorldMatrix(true, false))
    const pts = plan.bones.map((b) => bindPointToWorld(mesh, b.parentBone, b.world))
    const dots = new Float32Array(pts.length * 3)
    pts.forEach((p, i) => p.toArray(dots, i * 3))
    const lines = []
    plan.bones.forEach((b, i) => {
      const from = b.parentLocal >= 0 ? pts[b.parentLocal] : mesh.skeleton.bones[b.parentBone].getWorldPosition(new THREE.Vector3())
      lines.push(from.x, from.y, from.z, pts[i].x, pts[i].y, pts[i].z)
    })
    const group = new THREE.Group()
    group.name = '(part rig preview)'
    const pg = new THREE.BufferGeometry()
    pg.setAttribute('position', new THREE.BufferAttribute(dots, 3))
    const points = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x2bd6ff, size: 9, sizeAttenuation: false, depthTest: false, transparent: true }))
    const lg = new THREE.BufferGeometry()
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3))
    const seg = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x2bd6ff, depthTest: false, transparent: true }))
    for (const o of [points, seg]) { o.frustumCulled = false; o.renderOrder = 999; group.add(o) }
    noOutline(group)
    hooks.scene.add(group)
    preview = group
  }
  render()
}

export function clearPartRigFeedback() {
  setPartRigHighlight(null, null)
  setPartRigPreview(null, null)
}
