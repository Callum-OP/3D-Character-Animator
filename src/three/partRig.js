import * as THREE from 'three'
import { planPartRig, normaliseOptions } from './partRigMath.js'
import { pushSceneHistory } from './sceneHistory.js'
import { getAdjacency, growRegion, toRanges, fromRanges, regionVertexCount } from './regions.js'

// ---------------------------------------------------------------------------
// Part rigging: give a piece of a skinned mesh (a hair strand, a hood, a cape, a scarf...) its own
// chain of bones, with the skin weights worked out for you.
//
// The user picks faces; partRigMath.js works out bones + weights (in bind space); this file puts them
// into the live skeleton:
//   - new Bones are parented to the bone the piece hangs from (and to each other along the chain),
//     each a pure offset from its parent, so on the frame they are added NOTHING moves: a vertex
//     weighted to a new bone gets exactly the transform its old parent bone gave it.
//   - they are appended to the mesh's skeleton (bone + bone-inverse), so existing skin indices stay
//     valid, and the touched vertices' skinIndex / skinWeight are rewritten.
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

// --- planning --------------------------------------------------------------------

const bindPositionCache = new WeakMap() // geometry -> { matrix: string, positions }

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

export function planForMesh(mesh, tris, options = {}) {
  if (!isRigCapable(mesh)) return { ok: false, reason: 'This part is not skinned to a skeleton, so bones cannot be added to it.' }
  const geo = mesh.geometry
  const o = { ...normaliseOptions(options), parentBone: resolveParentIndex(mesh, options) }
  if (options && options.parentBoneName && o.parentBone == null) {
    return { ok: false, reason: 'That bone is not part of this mesh’s skeleton.' }
  }
  const m4 = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const bindCache = new Map()
  const plan = planPartRig({
    positions: bindSpacePositions(mesh),
    index: geo.index ? geo.index.array : null,
    tris,
    skinIndex: geo.attributes.skinIndex.array,
    skinWeight: geo.attributes.skinWeight.array,
    boneBind: (i) => {
      if (!bindCache.has(i)) {
        const m = boneBindMatrix(mesh, i)
        bindCache.set(i, m ? p.setFromMatrixPosition(m4.copy(m)).toArray() : null)
      }
      return bindCache.get(i)
    },
    options: o,
  })
  return plan
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

// Add the bone chains for `tris` of `mesh`. Returns { ok, entry } or { ok: false, reason }.
export function applyPartRig(model, mesh, tris, options = {}, { label = 'Part', names = null, record = true, id = null } = {}) {
  const plan = planForMesh(mesh, tris, options)
  if (!plan.ok) return plan
  const geo = mesh.geometry
  ensureSkinAttributes(geo)
  const skeleton = mesh.skeleton
  const baseCount = skeleton.bones.length
  const boneNames = names && names.length === plan.bones.length ? names : makeNames(plan, label, model)

  // bones
  const created = []
  const bindWorld = []
  const tmp = new THREE.Vector3()
  const newInverses = []
  plan.bones.forEach((b, i) => {
    const parentM = b.parentLocal >= 0 ? bindWorld[b.parentLocal] : boneBindMatrix(mesh, b.parentBone)
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

  // skin weights (remember what they were, for undo)
  const verts = Array.from(plan.weights.keys())
  const oldIdx = new Uint16Array(verts.length * 4)
  const oldW = new Float32Array(verts.length * 4)
  const newIdx = new Uint16Array(verts.length * 4)
  const newW = new Float32Array(verts.length * 4)
  const si = geo.attributes.skinIndex
  const sw = geo.attributes.skinWeight
  verts.forEach((v, n) => {
    const e = plan.weights.get(v)
    for (let k = 0; k < 4; k++) {
      oldIdx[n * 4 + k] = si.array[v * 4 + k]
      oldW[n * 4 + k] = sw.array[v * 4 + k]
      newIdx[n * 4 + k] = e.slots[k] >= 0 ? e.slots[k] : baseCount + (-1 - e.slots[k])
      newW[n * 4 + k] = e.w[k]
    }
  })

  const parents = new Map(created.map((b) => [b, b.parent]))
  skeleton.bones.push(...created)
  skeleton.boneInverses.push(...newInverses)
  refreshSkeleton(skeleton)
  writeSkin(mesh, verts, newIdx, newW)
  model.bones.push(...created)
  if (model.__poseRestQuats) for (const b of created) model.__poseRestQuats.set(b, b.quaternion.clone())

  const rootBoneNames = []
  plan.bones.forEach((b, i) => { if (b.parentLocal < 0) rootBoneNames.push(boneNames[i]) })
  const entry = {
    id: id || `rig_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    label: safeBoneName(label),
    meshIndex: model.meshes.indexOf(mesh),
    meshName: mesh.name || '',
    tris: toRanges(tris),
    vertexCount: regionVertexCount(geo),
    options: { ...options },
    boneNames,
    rootBoneNames,
    parentNames: plan.pieces.map((p) => skeleton.bones[p.parentBone].name),
    result: { mesh, created, parents, newInverses, verts, oldIdx, oldW, newIdx, newW, baseCount },
  }
  if (!model.__rigAdds) model.__rigAdds = []
  model.__rigAdds.push(entry)
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
  const skeleton = r.mesh.skeleton
  writeSkin(r.mesh, r.verts, r.oldIdx, r.oldW)
  for (const b of r.created) b.removeFromParent()
  skeleton.bones.length = r.baseCount
  skeleton.boneInverses.length = r.baseCount
  refreshSkeleton(skeleton)
  const gone = new Set(r.created)
  model.bones = model.bones.filter((b) => !gone.has(b))
  model.__rigAdds = (model.__rigAdds || []).filter((e) => e !== entry)
  if (hooks.onBonesChanged) hooks.onBonesChanged(model)
  render()
}

function attachEntry(model, entry) {
  const r = entry.result
  if (!r) return
  const skeleton = r.mesh.skeleton
  // each bone goes back under the parent it had
  r.created.forEach((bone) => {
    const parent = r.parents && r.parents.get(bone)
    if (parent) parent.add(bone)
  })
  skeleton.bones.push(...r.created)
  skeleton.boneInverses.push(...r.newInverses)
  refreshSkeleton(skeleton)
  writeSkin(r.mesh, r.verts, r.newIdx, r.newW)
  model.bones.push(...r.created)
  if (model.__poseRestQuats) for (const b of r.created) model.__poseRestQuats.set(b, b.quaternion.clone())
  if (!model.__rigAdds) model.__rigAdds = []
  model.__rigAdds.push(entry)
  if (hooks.onBonesChanged) hooks.onBonesChanged(model)
  render()
}

// Undo the most recent addition (the same as Ctrl+Z, but from the list).
export function removeLastPartRig(model) {
  const list = model.__rigAdds || []
  const entry = list[list.length - 1]
  if (!entry || !entry.result) return false
  detachEntry(model, entry)
  pushSceneHistory(
    () => attachEntry(model, entry),
    () => detachEntry(model, entry),
  )
  return true
}

export function getPartRigEntries(model) {
  return (model && model.__rigAdds) || []
}

// The recipe saved with a project.
export function getPartRigData(model) {
  return getPartRigEntries(model).map((e) => ({
    id: e.id,
    label: e.label,
    meshIndex: e.meshIndex,
    meshName: e.meshName,
    tris: e.tris,
    vertexCount: e.vertexCount,
    options: e.options,
    boneNames: e.boneNames,
  }))
}

// Replay saved recipes onto a freshly loaded model. Entries that no longer fit the mesh are skipped.
export function restorePartRigs(model, saved) {
  let restored = 0
  for (const s of saved || []) {
    const mesh = model.meshes[s.meshIndex]
    if (!mesh || !isRigCapable(mesh) || (s.meshName && mesh.name !== s.meshName)) continue
    if (s.vertexCount != null && s.vertexCount !== regionVertexCount(mesh.geometry)) continue
    const res = applyPartRig(model, mesh, fromRanges(s.tris), s.options || {}, { label: s.label, names: s.boneNames, record: false, id: s.id })
    if (res.ok) restored++
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

let highlight = null
let preview = null

function noOutline(obj) {
  obj.traverse((o) => {
    if (!o.material) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of mats) m.userData.outlineParameters = { visible: false }
  })
}

export function setPartRigHighlight(mesh, tris) {
  if (highlight) {
    highlight.removeFromParent()
    highlight.geometry.dispose()
    highlight.material.dispose()
    highlight = null
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
    highlight = new THREE.Mesh(g, mat)
    highlight.name = '(part rig highlight)'
    highlight.frustumCulled = false
    highlight.renderOrder = 998
    noOutline(highlight)
    hooks.scene.add(highlight)
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
