import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// ---------------------------------------------------------------------------
// Combine meshes
//
// Merges the meshes of a group into as few meshes as possible, for export: a character's body,
// clothes, hair and shoes become ONE skinned mesh in the file (still with one material slot per
// distinct material, so every part keeps its own texture), and a prop's static pieces become one
// mesh. Fewer meshes is what game engines and many tools prefer (fewer draw calls, one thing to
// pick up and move), and it is a one-click way to hand over a single mesh.
//
// It works on the COPY that is being exported (see exportSceneModel), never on the live scene: the
// editor's parts, their looks, regions, shape keys and animation all stay as they are.
//
//   * Skinned parts are merged when they are driven by bones of the same rig with the same bind
//     data. Many files give every part its OWN skeleton object over the same bones; those count as
//     one. The parts' bone numbers are renumbered into one skeleton (the union of their bones), and
//     a part bound with a different bind matrix has the difference baked into its vertices, so the
//     merged mesh skins exactly like the originals.
//   * Rigid parts that sit on a bone (eyeballs on the head, a ring on a finger) are skinned to that
//     bone with full weight and merged in: they still move with the bone exactly as before.
//   * Parts with shape keys (a face) are merged with each other when they have the SAME shape keys
//     set to the same values; they stay a mesh of their own, because the shape keys of one part
//     cannot be added to a body without storing them for every body vertex.
//   * Static pieces (props) are merged per parent; each one's own transform is baked into its
//     vertices.
//   * Left alone, and reported: parts that already have several material slots. Hidden parts are
//     not exported, so they are ignored.
// ---------------------------------------------------------------------------

const KEEP_ATTRIBUTES = ['position', 'normal', 'uv', 'uv1', 'uv2', 'tangent']
const ATTRIBUTE_SIZE = { uv: 2, uv1: 2, uv2: 2, tangent: 4 }

const matrixKey = (m) => Array.from(m.elements, (v) => v.toFixed(6)).join(',')
const sameMatrix = (a, b) => a.elements.every((v, i) => Math.abs(v - b.elements[i]) < 1e-5)

function morphKeysOf(geometry) {
  const morph = geometry.morphAttributes
  return morph ? Object.keys(morph).filter((k) => morph[k] && morph[k].length) : []
}

// Parts can share one merged mesh's shape keys only when the keys are the same, in the same order,
// with the same names and the same values right now. The signature says that.
function morphSignature(mesh) {
  const keys = morphKeysOf(mesh.geometry)
  if (!keys.length) return ''
  const counts = keys.map((k) => `${k}:${mesh.geometry.morphAttributes[k].length}`).join(',')
  const names = mesh.morphTargetDictionary
    ? Object.entries(mesh.morphTargetDictionary)
        .sort((a, b) => a[1] - b[1])
        .map(([n]) => n)
        .join('|')
    : ''
  const values = (mesh.morphTargetInfluences || []).map((v) => v.toFixed(5)).join(',')
  return `${counts}#${mesh.geometry.morphTargetsRelative ? 'rel' : 'abs'}#${names}#${values}`
}

function singleMaterial(mesh) {
  if (!Array.isArray(mesh.material)) return mesh.material
  return mesh.material.length === 1 ? mesh.material[0] : null
}

// Why a mesh is left out of any merge (null = it can be merged).
function leaveOutReason(mesh) {
  if (!mesh.visible) return 'hidden'
  if (!mesh.geometry || !mesh.geometry.getAttribute('position')) return 'no geometry'
  if (!singleMaterial(mesh)) return 'has several material slots'
  if (mesh.userData && (mesh.userData.isSoftOverlay || mesh.userData.isRegionOverlay)) return 'a highlight'
  return null
}

// How a mesh is grouped: static meshes by parent; skinned meshes bound in the usual "attached" way are
// grouped by which bones drive them (see skinGroups); the rare "detached" ones only when everything
// about their binding is identical.
function classify(mesh) {
  mesh.updateMatrix()
  const morph = morphSignature(mesh)
  if (mesh.isSkinnedMesh && mesh.skeleton) {
    if (!mesh.geometry.getAttribute('skinIndex') || !mesh.geometry.getAttribute('skinWeight')) return null
    if (mesh.bindMode === 'attached') return { kind: 'skin', morph }
    return { kind: 'detached', morph, key: ['detached', morph, mesh.skeleton.uuid, mesh.parent ? mesh.parent.uuid : '', matrixKey(mesh.matrix), matrixKey(mesh.bindMatrix)].join('|') }
  }
  return { kind: 'static', morph, key: ['static', morph, mesh.parent ? mesh.parent.uuid : ''].join('|') }
}

// The bone numbers (of this mesh's own skeleton) that any vertex actually uses.
function usedBones(mesh) {
  const si = mesh.geometry.getAttribute('skinIndex')
  const sw = mesh.geometry.getAttribute('skinWeight')
  const used = new Set()
  for (let i = 0; i < si.count; i++) {
    for (let c = 0; c < 4; c++) if (sw.getComponent(i, c) > 0) used.add(si.getComponent(i, c))
  }
  return used
}

// The top bone of a bone's rig (the start of the chain of bone parents).
function rigRoot(bone) {
  let b = bone
  while (b.parent && b.parent.isBone) b = b.parent
  return b
}

// The nearest bone above an object, or null.
function boneAbove(obj) {
  let o = obj.parent
  while (o) {
    if (o.isBone) return o
    o = o.parent
  }
  return null
}

// Add `mesh`'s bones to a group's combined skeleton (the bones of every part so far). Returns the renumbering
// (its bone number -> the group's), or null when a bone it uses is already there with different bind data, or
// belongs to another rig.
function placeInGroup(group, mesh) {
  const skeleton = mesh.skeleton
  const used = usedBones(mesh)
  for (const j of used) {
    const bone = skeleton.bones[j]
    if (!bone) return null
    // only bones of the same rig (the same character) are ever mixed in one mesh
    const root = rigRoot(bone)
    if (group.root && group.root !== root) return null
    const i = group.index.get(bone)
    if (i !== undefined) {
      const a = group.inverses[i]
      const b = skeleton.boneInverses[j]
      if (!a || !b || !sameMatrix(a, b)) return null
    } else if (!skeleton.boneInverses[j]) {
      return null
    }
  }
  const map = new Array(skeleton.bones.length).fill(0)
  for (const j of used) {
    const bone = skeleton.bones[j]
    if (!group.root) group.root = rigRoot(bone)
    let i = group.index.get(bone)
    if (i === undefined) {
      i = group.bones.length
      group.bones.push(bone)
      group.inverses.push(skeleton.boneInverses[j].clone())
      group.index.set(bone, i)
    }
    map[j] = i
  }
  return map
}

// Split the attached skinned meshes into groups that can share one skeleton: the union of their bones.
function skinGroups(meshes) {
  const groups = []
  for (const mesh of meshes) {
    let placed = false
    for (const group of groups) {
      const map = placeInGroup(group, mesh)
      if (map) {
        group.members.push({ mesh, map })
        placed = true
        break
      }
    }
    if (!placed) {
      const group = { bones: [], inverses: [], index: new Map(), members: [], rigids: [], root: null }
      const map = placeInGroup(group, mesh)
      if (map) {
        group.members.push({ mesh, map })
        groups.push(group)
      }
    }
  }
  return groups
}

// The bone a rigid part is carried by, added to the group's skeleton if the group does not have it yet.
// Returns the bone's number in the group, or -1 when the part cannot join (another rig).
function placeRigid(group, bone) {
  if (rigRoot(bone) !== group.root) return -1
  let i = group.index.get(bone)
  if (i === undefined) {
    bone.updateWorldMatrix(true, false)
    i = group.bones.length
    group.bones.push(bone)
    // any bind pose works for a bone only rigid parts use; the part's vertices are placed to match this one
    group.inverses.push(new THREE.Matrix4().copy(bone.matrixWorld).invert())
    group.index.set(bone, i)
  }
  return i
}

// --- building the merged geometry ---------------------------------------------------------------

// A geometry copy in the same form for every mesh of a group (types, attribute set, indexed), so they can
// be put side by side. `bake` moves the vertices (and their shape keys) by a matrix; `remap` renumbers the
// skin's bones; `rigidBone` (a bone number) skins a rigid part to that bone with full weight.
function prepareGeometry(mesh, skinned, keep, bake, remap, rigidBone) {
  const source = mesh.geometry
  const count = source.getAttribute('position').count
  const g = new THREE.BufferGeometry()
  for (const name of keep) {
    const a = source.getAttribute(name)
    const itemSize = ATTRIBUTE_SIZE[name] || 3
    const array = new Float32Array(count * itemSize)
    if (a) for (let i = 0; i < count; i++) for (let c = 0; c < itemSize; c++) array[i * itemSize + c] = a.getComponent(i, c)
    g.setAttribute(name, new THREE.BufferAttribute(array, itemSize))
  }
  if (!source.getAttribute('normal')) {
    const tmp = new THREE.BufferGeometry()
    tmp.setAttribute('position', g.getAttribute('position'))
    if (source.index) tmp.setIndex(source.index)
    tmp.computeVertexNormals()
    g.setAttribute('normal', tmp.getAttribute('normal'))
  }
  if (skinned) {
    const idx = new Uint16Array(count * 4)
    const wgt = new Float32Array(count * 4)
    if (rigidBone !== undefined && rigidBone !== null) {
      for (let i = 0; i < count; i++) {
        idx[i * 4] = rigidBone
        wgt[i * 4] = 1
      }
    } else {
      const si = source.getAttribute('skinIndex')
      const sw = source.getAttribute('skinWeight')
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < 4; c++) {
          const j = si.getComponent(i, c)
          idx[i * 4 + c] = remap ? remap[j] : j
          wgt[i * 4 + c] = sw.getComponent(i, c)
        }
      }
    }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4))
    g.setAttribute('skinWeight', new THREE.BufferAttribute(wgt, 4))
  }
  if (source.index) {
    g.setIndex(Array.from(source.index.array))
  } else {
    const seq = new Array(count)
    for (let i = 0; i < count; i++) seq[i] = i
    g.setIndex(seq)
  }

  // shape keys: the same number of targets for every part (checked by the group's signature)
  const relative = !!source.morphTargetsRelative
  g.morphTargetsRelative = relative
  for (const key of morphKeysOf(source)) {
    g.morphAttributes[key] = source.morphAttributes[key].map((target) => {
      const itemSize = target.itemSize
      const array = new Float32Array(count * itemSize)
      for (let i = 0; i < count; i++) for (let c = 0; c < itemSize; c++) array[i * itemSize + c] = target.getComponent(i, c)
      return new THREE.BufferAttribute(array, itemSize)
    })
  }

  if (bake) {
    g.applyMatrix4(bake)
    // a shape key moves vertices from where they are: a position target is a point (or an offset when
    // relative), a normal target is a direction
    const linear = new THREE.Matrix3().setFromMatrix4(bake)
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(bake)
    const v = new THREE.Vector3()
    for (const key of morphKeysOf(g)) {
      for (const target of g.morphAttributes[key]) {
        for (let i = 0; i < target.count; i++) {
          v.fromBufferAttribute(target, i)
          if (key === 'normal') v.applyMatrix3(normalMatrix).normalize()
          else if (relative) v.applyMatrix3(linear)
          else v.applyMatrix4(bake)
          target.setXYZ(i, v.x, v.y, v.z)
        }
      }
    }
  }
  return g
}

// Merge compatible meshes into ONE mesh and put it in the first one's place.
// items: [{ mesh, remap?, bake?, rigidBone? }]
function mergeGroup(items, skinned, label, canonSkeleton, canonBind, anchor) {
  const meshes = items.map((i) => i.mesh)
  // the attributes any mesh has (position and normal always; missing ones are added: uvs as zeros)
  const keep = KEEP_ATTRIBUTES.filter((name) => name === 'position' || name === 'normal' || meshes.some((m) => m.geometry.getAttribute(name)))
  // order by material so meshes sharing a material end up in one slot
  const ordered = items.slice().sort((a, b) => singleMaterial(a.mesh).uuid.localeCompare(singleMaterial(b.mesh).uuid))
  const geometries = ordered.map((it) => prepareGeometry(it.mesh, skinned, keep, it.bake || null, it.remap || null, it.rigidBone))
  const merged = mergeGeometries(geometries, true)
  const relative = geometries[0].morphTargetsRelative
  geometries.forEach((g) => g.dispose())
  if (!merged) return null
  merged.morphTargetsRelative = relative // (not carried over by the merge: without it relative shape keys read as absolute)

  // one slot per distinct material; neighbours that share one become a single group
  const materials = []
  const slotOf = new Map()
  const slots = ordered.map((it) => {
    const mat = singleMaterial(it.mesh)
    if (!slotOf.has(mat)) {
      slotOf.set(mat, materials.length)
      materials.push(mat)
    }
    return slotOf.get(mat)
  })
  const groups = []
  for (const g of merged.groups) {
    const slot = slots[g.materialIndex]
    const last = groups[groups.length - 1]
    if (last && last.materialIndex === slot && last.start + last.count === g.start) last.count += g.count
    else groups.push({ start: g.start, count: g.count, materialIndex: slot })
  }
  merged.clearGroups()
  for (const g of groups) merged.addGroup(g.start, g.count, g.materialIndex)

  // the merged mesh sits where its anchor was (for skinned groups: the first skinned part, not a rigid one)
  const first = anchor || ordered[0].mesh
  const material = materials.length === 1 ? materials[0] : materials
  let mesh
  if (skinned) {
    mesh = new THREE.SkinnedMesh(merged, material)
    mesh.position.copy(first.position)
    mesh.quaternion.copy(first.quaternion)
    mesh.scale.copy(first.scale)
    mesh.bindMode = 'attached'
    mesh.updateMatrix()
    mesh.bind(canonSkeleton, canonBind) // the bind matrix every part's vertices were brought to
    mesh.frustumCulled = false
  } else {
    mesh = new THREE.Mesh(merged, material)
  }
  if (morphKeysOf(merged).length) {
    // the shape keys (names and current values) are the same on every part by construction
    mesh.updateMorphTargets()
    if (first.morphTargetDictionary) mesh.morphTargetDictionary = { ...first.morphTargetDictionary }
    if (first.morphTargetInfluences) mesh.morphTargetInfluences = first.morphTargetInfluences.slice()
  }
  mesh.name = label
  mesh.castShadow = meshes.some((m) => m.castShadow)
  mesh.receiveShadow = meshes.some((m) => m.receiveShadow)
  const parent = first.parent
  parent.add(mesh)
  for (const m of meshes) {
    if (m.parent) m.parent.remove(m)
  }
  parent.updateWorldMatrix(true, false)
  mesh.updateMatrixWorld(true) // (a skinned mesh keeps its own inverse bind matrix up to date here)
  return mesh
}

// --- the entry point ------------------------------------------------------------------------------

// Combine the meshes under `root` (a copy made for export). Returns
// { meshesBefore, meshesAfter, combined: [{ name, parts, shapeKeys }], skipped: [{ name, reason }] }.
export function combineMeshes(root) {
  const skinnedByMorph = new Map() // shape-key signature -> attached skinned meshes
  const keyed = new Map() // static + detached meshes, grouped by key
  const skipped = []
  let total = 0
  root.updateMatrixWorld(true)
  root.traverse((o) => {
    if (!o.isMesh) return
    total++
    const reason = leaveOutReason(o)
    if (reason) {
      if (reason !== 'hidden' && reason !== 'a highlight') skipped.push({ name: o.name || 'Mesh', reason })
      return
    }
    const kind = classify(o)
    if (kind === null) {
      skipped.push({ name: o.name || 'Mesh', reason: 'has no skin data' })
    } else if (kind.kind === 'skin') {
      if (!skinnedByMorph.has(kind.morph)) skinnedByMorph.set(kind.morph, [])
      skinnedByMorph.get(kind.morph).push(o)
    } else {
      if (!keyed.has(kind.key)) keyed.set(kind.key, { skinned: kind.kind === 'detached', morph: kind.morph, meshes: [] })
      keyed.get(kind.key).meshes.push(o)
    }
  })

  // 1. skinned parts, per shape-key signature: groups that can share one skeleton
  const skinJobs = []
  for (const [morph, meshes] of skinnedByMorph) {
    for (const group of skinGroups(meshes)) skinJobs.push({ group, morph })
  }

  // 2. rigid parts carried by a bone join the plain (no shape keys) skin group of the same rig
  const plainGroups = skinJobs.filter((j) => j.morph === '').map((j) => j.group)
  for (const [key, entry] of [...keyed]) {
    if (entry.skinned || entry.morph !== '') continue
    const remaining = []
    for (const mesh of entry.meshes) {
      const bone = boneAbove(mesh)
      let joined = false
      if (bone) {
        for (const group of plainGroups) {
          if (group.root && rigRoot(bone) === group.root) {
            const index = placeRigid(group, bone)
            if (index >= 0) {
              group.rigids.push({ mesh, boneIndex: index, bone })
              joined = true
              break
            }
          }
        }
      }
      if (!joined) remaining.push(mesh)
    }
    entry.meshes = remaining
    if (!remaining.length) keyed.delete(key)
  }

  // work out every merge first (the scene graph changes as they are made)
  const jobs = []
  for (const { group, morph } of skinJobs) {
    const count = group.members.length + group.rigids.length
    if (count < 2) continue
    const firstBind = group.members[0].mesh.bindMatrix
    const inv = new THREE.Matrix4().copy(firstBind).invert()
    const items = group.members.map(({ mesh, map }) => ({
      mesh,
      remap: map,
      // a part bound with a different bind matrix: move the difference into its vertices
      bake: sameMatrix(mesh.bindMatrix, firstBind) ? null : new THREE.Matrix4().multiplyMatrices(inv, mesh.bindMatrix),
    }))
    for (const { mesh, boneIndex, bone } of group.rigids) {
      // where a vertex must sit in the merged mesh's bind space so that  bone * inverse * bind * v  lands on
      // the part's own world position, at the pose it has now (and then follows the bone from there)
      bone.updateWorldMatrix(true, false)
      mesh.updateWorldMatrix(true, false)
      const invBone = group.inverses[boneIndex]
      const bake = new THREE.Matrix4()
        .copy(inv)
        .multiply(new THREE.Matrix4().copy(invBone).invert())
        .multiply(new THREE.Matrix4().copy(bone.matrixWorld).invert())
        .multiply(mesh.matrixWorld)
      items.push({ mesh, rigidBone: boneIndex, bake })
    }
    jobs.push({ skinned: true, skeleton: new THREE.Skeleton(group.bones, group.inverses), bindMatrix: firstBind, items, morph, anchor: group.members[0].mesh })
  }
  for (const { skinned: isSkinned, morph, meshes } of keyed.values()) {
    if (meshes.length < 2) continue
    jobs.push({
      skinned: isSkinned,
      skeleton: isSkinned ? meshes[0].skeleton : null,
      bindMatrix: isSkinned ? meshes[0].bindMatrix : null,
      items: meshes.map((mesh) => ({ mesh, bake: isSkinned ? null : mesh.matrix.clone() })),
      morph,
    })
  }

  const combined = []
  const used = new Map()
  for (const job of jobs) {
    // a name that says what it is, numbered when there are several of a kind
    const base = job.morph ? 'Combined mesh (shape keys)' : job.skinned ? 'Combined mesh' : 'Combined static mesh'
    const seen = (used.get(base) || 0) + 1
    used.set(base, seen)
    const label = seen === 1 ? base : `${base} ${seen}`
    const names = job.items.map((it) => it.mesh.name || 'Mesh')
    const made = mergeGroup(job.items, job.skinned, label, job.skeleton, job.bindMatrix, job.anchor)
    if (made) combined.push({ name: label, parts: names, shapeKeys: !!job.morph })
    else for (const name of names) skipped.push({ name, reason: 'could not be merged' })
  }

  let after = 0
  root.traverse((o) => {
    if (o.isMesh) after++
  })
  return { meshesBefore: total, meshesAfter: after, combined, skipped }
}

// A sentence for the export message.
export function describeCombine(report) {
  if (!report || !report.combined.length) {
    return 'No meshes could be combined (each one is already on its own, or cannot be merged).'
  }
  const parts = report.combined.reduce((sum, c) => sum + c.parts.length, 0)
  let text = `Combined ${parts} meshes into ${report.combined.length}`
  if (report.combined.some((c) => c.shapeKeys)) text += ' (parts with shape keys form their own mesh)'
  if (report.skipped.length) {
    const names = report.skipped.slice(0, 3).map((s) => `${s.name} (${s.reason})`).join(', ')
    text += `; left separate: ${names}${report.skipped.length > 3 ? ` and ${report.skipped.length - 3} more` : ''}`
  }
  return text + '.'
}
