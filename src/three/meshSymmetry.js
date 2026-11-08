import * as THREE from 'three'
import { pushSceneHistory } from './sceneHistory.js'
import { fromRanges, toRanges } from './regions.js'
import { buildGraph, matchMirror, pairBones, centreFromBones, leftSign } from './symmetryMath.js'

// ---------------------------------------------------------------------------
// Mirror / symmetrise a part of a character without losing its skin weights or rig.
//
//  - Mirror part:  flip the whole part left <-> right, as Mirror does for a pose. Positions, normals and
//    shape keys are reflected, the triangles are re-wound so the surface still faces outward, and every
//    skin weight moves to the opposite-side bone (left arm weights -> right arm bone).
//  - Symmetrise:   make one side match the other. Every vertex on the target side takes the reflected
//    position / normal / shape-key offsets of its partner on the source side, and the partner's skin
//    weights moved onto the opposite-side bones. Works for a whole part, only for the picked faces
//    (one arm), or across two parts (a separate left and right arm).
//
// Vertex partners are found by topology (symmetryMath.js), so the two sides can already differ in shape.
// Nothing is added or removed: vertex and triangle numbers do not change, so regions, soft cloth zones
// and Add bones recipes keep pointing at the right faces. UVs and colours stay as they were.
// Bones are not moved. A vertex weighted to a bone with no opposite (hair bones added by Add bones...)
// is left alone, so those rigs keep working.
//
// The project stores only the recipe; it is replayed on load (restoreSymmetry).
// ---------------------------------------------------------------------------

const hooks = { requestRender: null, beforeEdit: null, afterEdit: null, blockReason: null }

export function initMeshSymmetry(h = {}) {
  hooks.requestRender = h.requestRender || null
  hooks.beforeEdit = h.beforeEdit || null // (meshes) clean pose before the geometry is read
  hooks.afterEdit = h.afterEdit || null // (meshes) drop caches that hold copies of the old positions
  hooks.blockReason = h.blockReason || null // (mesh) -> string | null
}

export function isSymmetryCapable(mesh) {
  return !!(mesh && mesh.isMesh && mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position)
}

const isSkinned = (mesh) => !!(mesh.isSkinnedMesh && mesh.skeleton && mesh.geometry.attributes.skinIndex && mesh.geometry.attributes.skinWeight)

// --- the character's frame ---------------------------------------------------------------------------

function frameOf(model, mesh) {
  model.root.updateWorldMatrix(true, true)
  mesh.updateWorldMatrix(true, false)
  const T = new THREE.Matrix4().copy(model.root.matrixWorld).invert().multiply(mesh.matrixWorld)
  const pos = mesh.geometry.attributes.position
  const root = new Float32Array(pos.count * 3)
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(T)
    root[i * 3] = v.x
    root[i * 3 + 1] = v.y
    root[i * 3 + 2] = v.z
  }
  let bones = null
  if (isSkinned(mesh)) {
    const names = mesh.skeleton.bones.map((b) => b.name)
    const bonePos = new Float32Array(names.length * 3)
    const inv = new THREE.Matrix4()
    const bindToMesh = new THREE.Matrix4().copy(mesh.bindMatrix).invert()
    names.forEach((_, i) => {
      const bi = mesh.skeleton.boneInverses[i]
      if (!bi) return
      v.setFromMatrixPosition(inv.copy(bi).invert()).applyMatrix4(bindToMesh).applyMatrix4(T)
      bonePos[i * 3] = v.x
      bonePos[i * 3 + 1] = v.y
      bonePos[i * 3 + 2] = v.z
    })
    bones = { names, pos: bonePos }
  }
  const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(root, 3))
  const diag = Math.max(box.getSize(new THREE.Vector3()).length(), 1e-6)
  return { T, root, bones, diag }
}

// What the tool would use for this part: the centre line and which side is the character's left.
export function describeSymmetryFrame(model, mesh) {
  const f = frameOf(model, mesh)
  const centre = f.bones ? centreFromBones(f.bones.names, f.bones.pos, 0) : 0
  return { centre, leftIsPositive: f.bones ? leftSign(f.bones.names, f.bones.pos, centre) > 0 : true, diag: f.diag }
}

const reflect = (cx) => new THREE.Matrix4().set(-1, 0, 0, 2 * cx, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)

// --- planning ----------------------------------------------------------------------------------------

/**
 * Work out the edit without touching anything.
 * spec: { kind: 'mirror' | 'symmetrise', sourceSide: 'left' | 'right', tris?: number[] (faces on the source
 *         part to copy from; empty = the whole side), centre?: number | null }
 */
export function planSymmetry(model, mesh, spec, targetMesh = null) {
  if (!isSymmetryCapable(mesh)) return { ok: false, reason: 'This part has no surface to mirror.' }
  const target = targetMesh && targetMesh !== mesh ? targetMesh : mesh
  if (!isSymmetryCapable(target)) return { ok: false, reason: 'The other part has no surface to mirror.' }
  for (const m of target === mesh ? [mesh] : [mesh, target]) {
    const why = hooks.blockReason ? hooks.blockReason(m) : null
    if (why) return { ok: false, reason: why }
  }
  if (target !== mesh && isSkinned(mesh) !== isSkinned(target)) return { ok: false, reason: 'Both parts must be skinned, or neither.' }
  if (target !== mesh && isSkinned(mesh) && mesh.skeleton !== target.skeleton) {
    const a = mesh.skeleton.bones
    const b = target.skeleton.bones
    if (a.length !== b.length || a.some((bone, i) => bone !== b[i])) return { ok: false, reason: 'The two parts belong to different skeletons.' }
  }

  const fa = frameOf(model, mesh)
  const fb = target === mesh ? fa : frameOf(model, target)
  const centre = Number.isFinite(spec.centre) ? spec.centre : (fa.bones ? centreFromBones(fa.bones.names, fa.bones.pos, 0) : 0)
  const tol = fa.diag * 0.04
  const mirrorBone = fa.bones ? pairBones(fa.bones.names, fa.bones.pos, centre, fa.diag * 0.02) : null
  const sign = fa.bones ? leftSign(fa.bones.names, fa.bones.pos, centre) : 1
  const sourceSign = spec.sourceSide === 'right' ? -sign : sign

  const plan = { ok: true, kind: spec.kind, mesh, target, centre, tol, fa, fb, mirrorBone, sourceSign, pairs: [], stats: {} }

  if (spec.kind === 'mirror') {
    if (target !== mesh) return { ok: false, reason: 'Mirror flips one part. Use Symmetrise to copy between two parts.' }
    plan.stats = { vertices: mesh.geometry.attributes.position.count }
    return plan
  }

  // Symmetrise: pair the two sides.
  const index = (m) => (m.geometry.index ? m.geometry.index.array : null)
  const A = buildGraph(fa.root, index(mesh), fa.diag * 1e-5)
  const B = target === mesh ? A : buildGraph(fb.root, index(target), fb.diag * 1e-5)
  const { map, seeds } = matchMirror(A, B, centre, tol)
  plan.graphA = A
  plan.graphB = B
  plan.map = map
  plan.stats.seeds = seeds

  // Which source points to copy from.
  const selected = new Set()
  const tris = spec.tris || []
  if (tris.length) {
    const idx = index(mesh)
    for (const t of tris) {
      for (let k = 0; k < 3; k++) selected.add(A.weld.group[idx ? idx[t * 3 + k] : t * 3 + k])
    }
  }
  let side = sourceSign
  if (tris.length && target === mesh && spec.sourceSide === 'auto') {
    let sum = 0
    selected.forEach((g) => { sum += A.weld.gpos[g * 3] - centre })
    side = sum >= 0 ? 1 : -1
  }
  const planeTol = fa.diag * 0.006
  for (let g = 0; g < A.N; g++) {
    const h = plan.map[g]
    if (h < 0) continue
    if (tris.length && !selected.has(g)) continue
    if (target === mesh) {
      if (h === g) continue
      const gs = (A.weld.gpos[g * 3] - centre) * side
      const hs = (A.weld.gpos[h * 3] - centre) * side
      if (gs <= planeTol) continue // only copy FROM the source side
      if (hs > planeTol) continue // ...and never onto the same side
      if (tris.length && selected.has(h)) continue
    }
    plan.pairs.push([g, h])
  }
  let unmatched = 0
  const wantSet = tris.length ? selected : null
  for (let g = 0; g < A.N; g++) {
    if (wantSet && !wantSet.has(g)) continue
    if (plan.map[g] < 0) unmatched++
  }
  plan.stats.pairs = plan.pairs.length
  plan.stats.unmatched = unmatched
  if (!plan.pairs.length) {
    return { ok: false, reason: tris.length
      ? 'Nothing on the other side matches these faces. Pick faces that have a mirror image (an arm, a leg), or check the centre line.'
      : 'No matching points found between the two sides. The centre line may be off, or the two sides are not built the same way.' }
  }
  return plan
}

// --- applying ----------------------------------------------------------------------------------------

function snapshotOf(geo, kind) {
  const list = []
  const take = (attr) => { if (attr && attr.array) list.push({ attr, before: attr.array.slice(), after: null }) }
  const attrs = kind === 'mirror' && !geo.index
    ? Object.values(geo.attributes)
    : [geo.attributes.position, geo.attributes.normal, geo.attributes.tangent, geo.attributes.skinIndex, geo.attributes.skinWeight]
  attrs.forEach(take)
  take(geo.index)
  for (const key of Object.keys(geo.morphAttributes || {})) for (const attr of geo.morphAttributes[key]) take(attr)
  return list
}

function finish(geo, snaps) {
  for (const s of snaps) {
    if (!s.after) s.after = s.attr.array.slice()
    s.attr.needsUpdate = true
  }
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
}

function invalidateSkinnedBounds(meshes) {
  for (const mesh of meshes) {
    if (!isSkinned(mesh)) continue
    mesh.boundingBox = null
    mesh.boundingSphere = null
  }
}

function restore(geo, snaps, which) {
  for (const s of snaps) {
    s.attr.array.set(s[which])
    s.attr.needsUpdate = true
  }
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
}

const normalMatrixOf = (m) => new THREE.Matrix3().getNormalMatrix(m)

function applyMirror(plan) {
  const { mesh, fa, centre, mirrorBone } = plan
  const geo = mesh.geometry
  const K = new THREE.Matrix4().copy(fa.T).invert().multiply(reflect(centre)).multiply(fa.T)
  const N = normalMatrixOf(K)
  const v = new THREE.Vector3()
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(K)
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  const nor = geo.attributes.normal
  if (nor) {
    for (let i = 0; i < nor.count; i++) {
      v.fromBufferAttribute(nor, i).applyMatrix3(N).normalize()
      nor.setXYZ(i, v.x, v.y, v.z)
    }
  }
  const tan = geo.attributes.tangent
  if (tan) {
    for (let i = 0; i < tan.count; i++) {
      v.set(tan.getX(i), tan.getY(i), tan.getZ(i)).transformDirection(K)
      tan.setXYZ(i, v.x, v.y, v.z)
      tan.setW(i, -tan.getW(i))
    }
  }
  const relative = geo.morphTargetsRelative
  for (const key of Object.keys(geo.morphAttributes || {})) {
    const useNormal = key === 'normal'
    for (const attr of geo.morphAttributes[key]) {
      for (let i = 0; i < attr.count; i++) {
        v.fromBufferAttribute(attr, i)
        if (useNormal) v.applyMatrix3(N).normalize()
        else if (relative) v.transformDirection(K).multiplyScalar(Math.hypot(attr.getX(i), attr.getY(i), attr.getZ(i)))
        else v.applyMatrix4(K)
        attr.setXYZ(i, v.x, v.y, v.z)
      }
    }
  }
  // Flipping the surface reverses every triangle's winding.
  const index = geo.index
  if (index) {
    const a = index.array
    for (let t = 0; t + 2 < a.length; t += 3) {
      const tmp = a[t + 1]
      a[t + 1] = a[t + 2]
      a[t + 2] = tmp
    }
  } else {
    // A non-indexed mesh: swap the second and third vertex of every attribute instead.
    const swap = (attr) => {
      if (!attr) return
      const size = attr.itemSize
      for (let t = 0; t + 2 < attr.count; t += 3) {
        for (let c = 0; c < size; c++) {
          const x = attr.array[(t + 1) * size + c]
          attr.array[(t + 1) * size + c] = attr.array[(t + 2) * size + c]
          attr.array[(t + 2) * size + c] = x
        }
      }
    }
    for (const attr of Object.values(geo.attributes)) swap(attr)
    for (const key of Object.keys(geo.morphAttributes || {})) geo.morphAttributes[key].forEach(swap)
  }
  let unpaired = 0
  if (mirrorBone && isSkinned(mesh)) {
    const si = geo.attributes.skinIndex
    const sw = geo.attributes.skinWeight
    for (let i = 0; i < si.count; i++) {
      for (let k = 0; k < 4; k++) {
        if (sw.getComponent(i, k) <= 1e-5) continue
        const b = si.getComponent(i, k)
        const m = mirrorBone[b]
        if (m < 0) unpaired++
        else si.setComponent(i, k, m)
      }
    }
  }
  return { vertices: pos.count, influencesOnUnpairedBones: unpaired }
}

function applySymmetrise(plan) {
  const { mesh, target, fa, fb, centre, mirrorBone, graphA, graphB, pairs } = plan
  const geoS = mesh.geometry
  const geoT = target.geometry
  const K = new THREE.Matrix4().copy(fb.T).invert().multiply(reflect(centre)).multiply(fa.T)
  const N = normalMatrixOf(K)
  const posS = geoS.attributes.position
  const posT = geoT.attributes.position
  const norS = geoS.attributes.normal
  const norT = geoT.attributes.normal
  const skinned = isSkinned(mesh) && isSkinned(target)
  const si = skinned ? geoS.attributes.skinIndex : null
  const sw = skinned ? geoS.attributes.skinWeight : null
  const ti = skinned ? geoT.attributes.skinIndex : null
  const tw = skinned ? geoT.attributes.skinWeight : null
  const mappable = (idxAttr, wAttr, v) => {
    if (!mirrorBone) return true
    for (let k = 0; k < 4; k++) {
      if (wAttr.getComponent(v, k) > 1e-4 && mirrorBone[idxAttr.getComponent(v, k)] < 0) return false
    }
    return true
  }
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  let moved = 0
  let keptForRig = 0
  const morphKeys = Object.keys(geoS.morphAttributes || {}).filter((k) => geoT.morphAttributes && geoT.morphAttributes[k] && geoT.morphAttributes[k].length === geoS.morphAttributes[k].length)
  const relative = geoS.morphTargetsRelative

  for (const [g, h] of pairs) {
    const srcVerts = graphA.weld.members[g]
    const dstVerts = graphB.weld.members[h]
    // each destination vertex copies the source vertex whose (reflected) normal agrees best with its own
    const choice = dstVerts.map((tv) => {
      if (!norS || !norT || srcVerts.length === 1) return srcVerts[0]
      b.fromBufferAttribute(norT, tv)
      let best = srcVerts[0]
      let bestDot = -2
      for (const sv of srcVerts) {
        a.fromBufferAttribute(norS, sv).applyMatrix3(N).normalize()
        const d = a.dot(b)
        if (d > bestDot) { bestDot = d; best = sv }
      }
      return best
    })
    if (skinned) {
      const blocked = dstVerts.some((tv, i) => !mappable(ti, tw, tv) || !mappable(si, sw, choice[i]))
      if (blocked) { keptForRig++; continue }
    }
    dstVerts.forEach((tv, i) => {
      const sv = choice[i]
      a.fromBufferAttribute(posS, sv).applyMatrix4(K)
      posT.setXYZ(tv, a.x, a.y, a.z)
      if (norS && norT) {
        a.fromBufferAttribute(norS, sv).applyMatrix3(N).normalize()
        norT.setXYZ(tv, a.x, a.y, a.z)
      }
      if (skinned) {
        for (let k = 0; k < 4; k++) {
          const wgt = sw.getComponent(sv, k)
          const bone = si.getComponent(sv, k)
          ti.setComponent(tv, k, wgt > 1e-5 && mirrorBone && mirrorBone[bone] >= 0 ? mirrorBone[bone] : bone)
          tw.setComponent(tv, k, wgt)
        }
      }
      for (const key of morphKeys) {
        const useNormal = key === 'normal'
        geoS.morphAttributes[key].forEach((srcAttr, m) => {
          const dstAttr = geoT.morphAttributes[key][m]
          c.fromBufferAttribute(srcAttr, sv)
          if (useNormal) c.applyMatrix3(N).normalize()
          else if (relative) c.transformDirection(K).multiplyScalar(Math.hypot(srcAttr.getX(sv), srcAttr.getY(sv), srcAttr.getZ(sv)))
          else c.applyMatrix4(K)
          dstAttr.setXYZ(tv, c.x, c.y, c.z)
        })
      }
      moved++
    })
  }

  // The seam: points on the centre line stay on it.
  let snapped = 0
  if (target === mesh) {
    const inv = new THREE.Matrix4().copy(fa.T).invert()
    const planeTol = plan.tol * 0.5
    for (let g = 0; g < graphA.N; g++) {
      if (plan.map[g] !== g) continue
      if (Math.abs(graphA.weld.gpos[g * 3] - centre) > planeTol) continue
      for (const v of graphA.weld.members[g]) {
        a.fromBufferAttribute(posS, v).applyMatrix4(fa.T)
        a.x = centre
        a.applyMatrix4(inv)
        posS.setXYZ(v, a.x, a.y, a.z)
        snapped++
      }
    }
  }
  return { ...plan.stats, vertices: moved, keptForRig, snapped }
}

let counter = 0

/**
 * Apply a mirror / symmetrise to `mesh` (and `targetMesh` for two-part symmetrise).
 * Returns { ok, entry, stats } or { ok: false, reason }.
 */
export function applySymmetry(model, mesh, spec, { targetMesh = null, record = true, id = null } = {}) {
  const plan = planSymmetry(model, mesh, spec, targetMesh)
  if (!plan.ok) return plan
  const geos = Array.from(new Set([plan.mesh.geometry, plan.target.geometry]))
  const touched = Array.from(new Set([plan.mesh, plan.target]))
  if (hooks.beforeEdit) hooks.beforeEdit(touched)
  const snaps = new Map(geos.map((g) => [g, snapshotOf(g, plan.kind)]))
  const stats = plan.kind === 'mirror' ? applyMirror(plan) : applySymmetrise(plan)
  for (const g of geos) finish(g, snaps.get(g))
  invalidateSkinnedBounds(touched)
  if (hooks.afterEdit) hooks.afterEdit(touched)
  if (hooks.requestRender) hooks.requestRender()

  const entry = {
    id: id || `sym_${Date.now()}_${counter++}`,
    kind: plan.kind,
    sourceSide: spec.sourceSide || 'left',
    meshIndex: model.meshes.indexOf(plan.mesh),
    meshName: plan.mesh.name || '',
    targetIndex: plan.target === plan.mesh ? null : model.meshes.indexOf(plan.target),
    targetName: plan.target === plan.mesh ? '' : plan.target.name || '',
    tris: toRanges(spec.tris || []),
    vertexCount: plan.mesh.geometry.attributes.position.count,
    centre: plan.centre,
  }
  if (!model.__symEdits) model.__symEdits = []
  model.__symEdits.push(entry)

  if (record) {
    const redo = () => {
      for (const g of geos) restore(g, snaps.get(g), 'after')
      invalidateSkinnedBounds(touched)
      if (!model.__symEdits.includes(entry)) model.__symEdits.push(entry)
      if (hooks.afterEdit) hooks.afterEdit(touched)
      if (hooks.requestRender) hooks.requestRender()
    }
    const undo = () => {
      if (hooks.beforeEdit) hooks.beforeEdit(touched)
      for (const g of geos) restore(g, snaps.get(g), 'before')
      invalidateSkinnedBounds(touched)
      model.__symEdits = (model.__symEdits || []).filter((e) => e !== entry)
      if (hooks.afterEdit) hooks.afterEdit(touched)
      if (hooks.requestRender) hooks.requestRender()
    }
    pushSceneHistory(undo, redo)
  }
  return { ok: true, entry, stats }
}

export function getSymmetryEntries(model) {
  return (model && model.__symEdits) || []
}

// The recipe saved with a project.
export function getSymmetryData(model) {
  return getSymmetryEntries(model).map((e) => ({ ...e }))
}

// Replay saved recipes onto a freshly loaded model, in the order they were made.
export function restoreSymmetry(model, saved) {
  let restored = 0
  for (const s of saved || []) {
    if (getSymmetryEntries(model).some((e) => e.id === s.id)) continue
    const mesh = model.meshes[s.meshIndex]
    const target = s.targetIndex == null ? null : model.meshes[s.targetIndex]
    if (!mesh || (s.meshName && mesh.name !== s.meshName)) continue
    if (s.targetIndex != null && (!target || (s.targetName && target.name !== s.targetName))) continue
    if (s.vertexCount != null && mesh.geometry.attributes.position.count !== s.vertexCount) continue
    const res = applySymmetry(model, mesh, {
      kind: s.kind,
      sourceSide: s.sourceSide,
      tris: fromRanges(s.tris || []),
      centre: s.centre,
    }, { targetMesh: target, record: false, id: s.id })
    if (res.ok) restored++
  }
  return restored
}

// The viewport's Mirror / Symmetrise buttons: apply to each of these parts (the selected ones). Returns a
// one-line message for the person.
export function mirrorMeshes(model, meshes, kind, side = 'left') {
  const list = (meshes || []).filter((m) => isSymmetryCapable(m))
  if (!model || !list.length) return 'Select a part of the character first.'
  let done = 0
  let reason = ''
  let kept = 0
  for (const mesh of list) {
    const res = applySymmetry(model, mesh, { kind, sourceSide: side })
    if (res.ok) {
      done++
      kept += (res.stats && res.stats.keptForRig) || 0
    } else reason = res.reason
  }
  if (!done) return reason
  const what = kind === 'mirror' ? 'Mirrored' : `Copied the ${side} side to the other side of`
  const parts = `${done} part${done === 1 ? '' : 's'}`
  const skipped = list.length - done
  return `${what} ${parts}.${skipped ? ` ${skipped} could not be done: ${reason}` : ''}${kept ? ` ${kept} point${kept === 1 ? '' : 's'} on added rig bones were left alone.` : ''} Ctrl+Z undoes it.`
}
