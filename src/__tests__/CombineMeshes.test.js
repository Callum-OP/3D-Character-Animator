import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { combineMeshes, describeCombine } from '../three/combineMeshes.js'

// A rig of two bones, and helpers to make skinned parts on it
function makeRig() {
  const root = new THREE.Group()
  const b0 = new THREE.Bone()
  const b1 = new THREE.Bone()
  b1.position.set(0, 1, 0)
  b0.add(b1)
  root.add(b0)
  root.updateMatrixWorld(true)
  return { root, b0, b1, skeleton: new THREE.Skeleton([b0, b1]) }
}

function skinnedPart(rig, geometry, material, name, { uv = true, normal = true, morph = false } = {}) {
  const n = geometry.getAttribute('position').count
  const si = new Uint16Array(n * 4)
  const sw = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    const y = geometry.getAttribute('position').getY(i)
    const t = Math.min(1, Math.max(0, y / 1))
    si[4 * i + 1] = 1
    sw[4 * i] = 1 - t
    sw[4 * i + 1] = t
  }
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4))
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
  if (!uv) geometry.deleteAttribute('uv')
  if (!normal) geometry.deleteAttribute('normal')
  if (morph) geometry.morphAttributes.position = [new THREE.BufferAttribute(new Float32Array(n * 3), 3)]
  const mesh = new THREE.SkinnedMesh(geometry, material)
  mesh.name = name
  rig.root.add(mesh)
  rig.root.updateMatrixWorld(true)
  mesh.bind(rig.skeleton)
  return mesh
}

const mat = (color) => new THREE.MeshStandardMaterial({ color })

function skinnedWorld(mesh, i) {
  mesh.updateWorldMatrix(true, false)
  mesh.skeleton.update()
  const v = new THREE.Vector3()
  mesh.getVertexPosition(i, v)
  return v.applyMatrix4(mesh.matrixWorld)
}

const count = (root) => {
  let n = 0
  root.traverse((o) => o.isMesh && n++)
  return n
}

describe('combine meshes (for export)', () => {
  it('merges skinned parts on one skeleton into ONE mesh that skins exactly like the originals', () => {
    const rig = makeRig()
    const a = skinnedPart(rig, new THREE.BoxGeometry(0.4, 0.8, 0.4, 2, 4, 2).translate(0, 0.5, 0), mat('red'), 'Body')
    const b = skinnedPart(rig, new THREE.SphereGeometry(0.3, 10, 8).translate(0.5, 0.6, 0), mat('blue'), 'Hat')
    // pose it, and remember where every vertex of the originals is drawn
    rig.b1.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7)
    rig.b0.position.x = 0.3
    rig.root.updateMatrixWorld(true)
    const na = a.geometry.getAttribute('position').count
    const nb = b.geometry.getAttribute('position').count
    const before = [...Array(na)].map((_, i) => skinnedWorld(a, i)).concat([...Array(nb)].map((_, i) => skinnedWorld(b, i)))

    const report = combineMeshes(rig.root)
    expect(report.meshesBefore).toBe(2)
    expect(report.meshesAfter).toBe(1)
    expect(report.combined).toHaveLength(1)
    expect(report.combined[0].parts.sort()).toEqual(['Body', 'Hat'])

    let merged = null
    rig.root.traverse((o) => o.isSkinnedMesh && (merged = o))
    expect(merged.skeleton.bones).toEqual(rig.skeleton.bones)
    expect(merged.skeleton.boneInverses.length).toBe(rig.skeleton.boneInverses.length)
    expect(merged.geometry.getAttribute('position').count).toBe(na + nb)
    // every vertex draws exactly where it did (the order inside the merged mesh is by material, so match by position)
    const after = [...Array(na + nb)].map((_, i) => skinnedWorld(merged, i))
    for (const p of before) expect(after.some((q) => q.distanceTo(p) < 1e-5)).toBe(true)
    expect(after.length).toBe(before.length)
  })

  it('keeps one material slot per distinct material, and parts that share one share a slot', () => {
    const rig = makeRig()
    const red = mat('red')
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0, 0.2, 0), red, 'A')
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0.5, 0.2, 0), mat('green'), 'B')
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(-0.5, 0.2, 0), red, 'C')
    const report = combineMeshes(rig.root)
    expect(report.combined[0].parts).toHaveLength(3)
    let merged = null
    rig.root.traverse((o) => o.isSkinnedMesh && (merged = o))
    expect(Array.isArray(merged.material)).toBe(true)
    expect(merged.material).toHaveLength(2) // red (twice) + green
    expect(merged.geometry.groups).toHaveLength(2)
    const drawn = merged.geometry.groups.reduce((s, g) => s + g.count, 0)
    expect(drawn).toBe(merged.geometry.index.count)
  })

  it('one shared material gives a plain, single-material mesh', () => {
    const rig = makeRig()
    const m = mat('white')
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0, 0.2, 0), m, 'A')
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0.5, 0.2, 0), m, 'B')
    combineMeshes(rig.root)
    let merged = null
    rig.root.traverse((o) => o.isSkinnedMesh && (merged = o))
    expect(merged.material).toBe(m)
  })

  it('leaves hidden parts and multi-material parts alone, and says so; a lone shape-key part has nothing to merge with', () => {
    const rig = makeRig()
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0, 0.2, 0), mat('a'), 'Body')
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0.5, 0.2, 0), mat('b'), 'Shirt')
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(1, 0.2, 0), mat('c'), 'Face', { morph: true })
    const hidden = skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(1.5, 0.2, 0), mat('d'), 'Hidden')
    hidden.visible = false
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(2, 0.2, 0), [mat('e'), mat('f')], 'Two slots')
    const report = combineMeshes(rig.root)
    expect(report.combined).toHaveLength(1)
    expect(report.combined[0].parts.sort()).toEqual(['Body', 'Shirt'])
    expect(report.skipped.map((s) => s.name)).toEqual(['Two slots'])
    const names = []
    rig.root.traverse((o) => o.isMesh && names.push(o.name))
    expect(names.sort()).toEqual(['Combined mesh', 'Face', 'Hidden', 'Two slots'])
    expect(describeCombine(report)).toMatch(/Combined 2 meshes into 1; left separate: Two slots \(has several material slots\)/)
  })

  it('parts on different skeletons are combined separately, never mixed', () => {
    const rig1 = makeRig()
    const rig2 = makeRig()
    const both = new THREE.Group()
    both.add(rig1.root, rig2.root)
    skinnedPart(rig1, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0, 0.2, 0), mat('a'), 'A1')
    skinnedPart(rig1, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0.5, 0.2, 0), mat('b'), 'A2')
    skinnedPart(rig2, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0, 0.2, 0), mat('c'), 'B1')
    skinnedPart(rig2, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0.5, 0.2, 0), mat('d'), 'B2')
    const report = combineMeshes(both)
    expect(report.combined).toHaveLength(2)
    const skeletons = new Set()
    both.traverse((o) => o.isSkinnedMesh && skeletons.add(o.skeleton))
    expect(skeletons.size).toBe(2)
    expect(count(both)).toBe(2)
  })

  it('parts that each have their OWN skeleton object over the same bones still merge (what glTF files do)', () => {
    const rig = makeRig()
    const a = skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0, 0.4, 0), mat('a'), 'A')
    const bRig = { ...rig, skeleton: new THREE.Skeleton([rig.b0, rig.b1]) } // a second Skeleton over the very same bones
    const b = skinnedPart(bRig, new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0.6, 0.4, 0), mat('b'), 'B')
    expect(a.skeleton).not.toBe(b.skeleton)
    rig.b1.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.9)
    rig.root.updateMatrixWorld(true)
    const before = [a, b].flatMap((m) => [...Array(m.geometry.getAttribute('position').count)].map((_, i) => skinnedWorld(m, i)))
    const report = combineMeshes(rig.root)
    expect(report.combined).toHaveLength(1)
    let merged = null
    rig.root.traverse((o) => o.isSkinnedMesh && (merged = o))
    const after = [...Array(merged.geometry.getAttribute('position').count)].map((_, i) => skinnedWorld(merged, i))
    for (const p of before) expect(after.some((q) => q.distanceTo(p) < 1e-5)).toBe(true)
  })

  it('a part whose skeleton lists the bones in a different order is renumbered, not broken', () => {
    const rig = makeRig()
    const a = skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0, 0.4, 0), mat('a'), 'A')
    const swapped = new THREE.Skeleton([rig.b1, rig.b0]) // bone 0 and 1 swapped
    // a part skinned against the swapped numbering: its vertex bone numbers refer to [b1, b0]
    const geo = new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0.6, 0.4, 0)
    const n = geo.getAttribute('position').count
    const si = new Uint16Array(n * 4)
    const sw = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, Math.max(0, geo.getAttribute('position').getY(i)))
      si[4 * i] = 1 // b0
      si[4 * i + 1] = 0 // b1
      sw[4 * i] = 1 - t
      sw[4 * i + 1] = t
    }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4))
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
    const b = new THREE.SkinnedMesh(geo, mat('b'))
    b.name = 'B'
    rig.root.add(b)
    rig.root.updateMatrixWorld(true)
    b.bind(swapped)
    rig.b1.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.1)
    rig.b0.position.x = 0.2
    rig.root.updateMatrixWorld(true)
    const before = [a, b].flatMap((m) => [...Array(m.geometry.getAttribute('position').count)].map((_, i) => skinnedWorld(m, i)))
    const report = combineMeshes(rig.root)
    expect(report.combined).toHaveLength(1)
    let merged = null
    rig.root.traverse((o) => o.isSkinnedMesh && (merged = o))
    const after = [...Array(merged.geometry.getAttribute('position').count)].map((_, i) => skinnedWorld(merged, i))
    for (const p of before) expect(after.some((q) => q.distanceTo(p) < 1e-5)).toBe(true)
  })

  it('a part bound with a different bind matrix has the difference baked in', () => {
    const rig = makeRig()
    const a = skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0, 0.4, 0), mat('a'), 'A')
    const b = skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0.6, 0.4, 0), mat('b'), 'B')
    // bind B as if its node had been moved and scaled when it was bound
    const bind = new THREE.Matrix4().compose(new THREE.Vector3(0.5, 0, 0.2), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6), new THREE.Vector3(1.2, 1.2, 1.2))
    b.bind(rig.skeleton, bind)
    rig.b1.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.8)
    rig.root.updateMatrixWorld(true)
    const before = [a, b].flatMap((m) => [...Array(m.geometry.getAttribute('position').count)].map((_, i) => skinnedWorld(m, i)))
    const report = combineMeshes(rig.root)
    expect(report.combined).toHaveLength(1)
    let merged = null
    rig.root.traverse((o) => o.isSkinnedMesh && (merged = o))
    const after = [...Array(merged.geometry.getAttribute('position').count)].map((_, i) => skinnedWorld(merged, i))
    for (const p of before) expect(after.some((q) => q.distanceTo(p) < 1e-4)).toBe(true)
  })

  it('bones with different bind data are not mixed', () => {
    const rig = makeRig()
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0, 0.4, 0), mat('a'), 'A')
    const other = new THREE.Skeleton([rig.b0, rig.b1], [new THREE.Matrix4().makeTranslation(0, 5, 0), new THREE.Matrix4().makeTranslation(0, 6, 0)])
    const geo = new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0.6, 0.4, 0)
    const n = geo.getAttribute('position').count
    const si = new Uint16Array(n * 4)
    const sw = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) sw[4 * i] = 1
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4))
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
    const b = new THREE.SkinnedMesh(geo, mat('b'))
    rig.root.add(b)
    rig.root.updateMatrixWorld(true)
    b.bind(other, new THREE.Matrix4()) // (giving the bind matrix keeps the bone inverses as set above)
    const report = combineMeshes(rig.root)
    expect(report.combined).toHaveLength(0)
    expect(count(rig.root)).toBe(2)
  })

  it('parts whose skeletons list different bones merge onto the union of the bones', () => {
    const rig = makeRig()
    const b2 = new THREE.Bone()
    b2.position.set(0.5, 0, 0)
    rig.b0.add(b2)
    rig.root.updateMatrixWorld(true)
    // A is skinned to bones [b0, b1]; C only to [b2, b0] (a skeleton with another list and another order)
    const a = skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0, 0.4, 0), mat('a'), 'A')
    const skeletonC = new THREE.Skeleton([b2, rig.b0])
    const geo = new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0.8, 0.4, 0)
    const n = geo.getAttribute('position').count
    const si = new Uint16Array(n * 4)
    const sw = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, Math.max(0, geo.getAttribute('position').getY(i)))
      si[4 * i] = 0 // b2
      si[4 * i + 1] = 1 // b0
      sw[4 * i] = t
      sw[4 * i + 1] = 1 - t
    }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4))
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
    const c = new THREE.SkinnedMesh(geo, mat('c'))
    rig.root.add(c)
    rig.root.updateMatrixWorld(true)
    c.bind(skeletonC)
    b2.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.8)
    rig.b1.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.5)
    rig.root.updateMatrixWorld(true)
    const before = [a, c].flatMap((m) => [...Array(m.geometry.getAttribute('position').count)].map((_, i) => skinnedWorld(m, i)))
    const report = combineMeshes(rig.root)
    expect(report.combined).toHaveLength(1)
    let merged = null
    rig.root.traverse((o) => o.isSkinnedMesh && (merged = o))
    expect(merged.skeleton.bones).toHaveLength(3)
    const after = [...Array(merged.geometry.getAttribute('position').count)].map((_, i) => skinnedWorld(merged, i))
    for (const p of before) expect(after.some((q) => q.distanceTo(p) < 1e-5)).toBe(true)
  })

  // ---- shape keys
  const withTargets = (mesh, amounts) => {
    // two shape keys: 0 pushes every vertex up, 1 pushes it sideways (relative offsets)
    const n = mesh.geometry.getAttribute('position').count
    const up = new Float32Array(n * 3)
    const side = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      up[3 * i + 1] = amounts[0]
      side[3 * i] = amounts[1]
    }
    mesh.geometry.morphAttributes.position = [new THREE.BufferAttribute(up, 3), new THREE.BufferAttribute(side, 3)]
    mesh.geometry.morphTargetsRelative = true
    mesh.updateMorphTargets()
    mesh.morphTargetDictionary = { smile: 0, blink: 1 }
    return mesh
  }

  it('parts with the same shape keys merge into a mesh of their own, with the keys working', () => {
    const rig = makeRig()
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0, 0.4, 0), mat('body'), 'Body')
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0.5, 0.4, 0), mat('shirt'), 'Shirt')
    const f1 = withTargets(skinnedPart(rig, new THREE.BoxGeometry(0.2, 0.2, 0.2).translate(0, 1.2, 0), mat('skin'), 'Face_1', { morph: true }), [0.1, 0.05])
    const f2 = withTargets(skinnedPart(rig, new THREE.BoxGeometry(0.1, 0.1, 0.1).translate(0.3, 1.2, 0), mat('eye'), 'Face_2', { morph: true }), [0.1, 0.05])
    f1.morphTargetInfluences = [0.7, 0.4]
    f2.morphTargetInfluences = [0.7, 0.4]
    rig.b1.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5)
    rig.root.updateMatrixWorld(true)
    const before = [f1, f2].flatMap((m) => [...Array(m.geometry.getAttribute('position').count)].map((_, i) => skinnedWorld(m, i)))
    const report = combineMeshes(rig.root)
    expect(report.combined).toHaveLength(2)
    const face = report.combined.find((c) => c.shapeKeys)
    expect(face.parts.sort()).toEqual(['Face_1', 'Face_2'])
    expect(report.combined.find((c) => !c.shapeKeys).parts.sort()).toEqual(['Body', 'Shirt'])
    let merged = null
    rig.root.traverse((o) => o.isSkinnedMesh && o.geometry.morphAttributes.position && (merged = o))
    expect(merged.morphTargetDictionary).toEqual({ smile: 0, blink: 1 })
    expect(merged.morphTargetInfluences).toEqual([0.7, 0.4])
    expect(merged.geometry.morphAttributes.position).toHaveLength(2)
    // the shape keys still move the vertices to the same places (three applies them in getVertexPosition)
    const after = [...Array(merged.geometry.getAttribute('position').count)].map((_, i) => skinnedWorld(merged, i))
    for (const p of before) expect(after.some((q) => q.distanceTo(p) < 1e-5)).toBe(true)
  })

  it('shape-key parts with different shape keys, or different values, are not mixed', () => {
    const rig = makeRig()
    const f1 = withTargets(skinnedPart(rig, new THREE.BoxGeometry(0.2, 0.2, 0.2).translate(0, 1.2, 0), mat('a'), 'A', { morph: true }), [0.1, 0.05])
    const f2 = withTargets(skinnedPart(rig, new THREE.BoxGeometry(0.2, 0.2, 0.2).translate(0.5, 1.2, 0), mat('b'), 'B', { morph: true }), [0.1, 0.05])
    f1.morphTargetInfluences = [0.7, 0.4]
    f2.morphTargetInfluences = [0.1, 0.4] // a different value
    expect(combineMeshes(rig.root).combined).toHaveLength(0)
  })

  // ---- rigid parts on a bone
  it('a rigid part on a bone joins the skinned mesh and keeps following that bone exactly', () => {
    const rig = makeRig()
    const body = skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0, 0.4, 0), mat('body'), 'Body')
    const hat = skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.2, 0.3).translate(0.5, 0.4, 0), mat('hat'), 'Hat')
    // an eyeball: not skinned at all, just a child of the top bone, offset and turned
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), mat('eye'))
    eye.name = 'Eye'
    eye.position.set(0.1, 0.2, 0.15)
    eye.rotation.set(0.3, 0.5, 0.1)
    eye.scale.set(1.2, 1, 0.8)
    rig.b1.add(eye)
    rig.root.updateMatrixWorld(true)
    const eyeWorld = (m) => {
      m.updateWorldMatrix(true, false)
      const p = m.geometry.getAttribute('position')
      return [...Array(p.count)].map((_, i) => new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld))
    }
    const expectFollow = (merged) => {
      const mp = merged.geometry.getAttribute('position').count
      const drawn = [...Array(mp)].map((_, i) => skinnedWorld(merged, i))
      for (const p of eyeWorld(eye)) expect(drawn.some((q) => q.distanceTo(p) < 1e-4)).toBe(true)
    }
    // pose 1 at the time of the merge
    rig.b1.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.8)
    rig.b0.position.x = 0.25
    rig.root.updateMatrixWorld(true)
    const eyeNow = eyeWorld(eye) // where the eyeball is right now
    const report = combineMeshes(rig.root)
    expect(report.combined).toHaveLength(1)
    expect(report.combined[0].parts.sort()).toEqual(['Body', 'Eye', 'Hat'])
    let merged = null
    rig.root.traverse((o) => o.isSkinnedMesh && (merged = o))
    expect(count(rig.root)).toBe(1)
    const drawnNow = [...Array(merged.geometry.getAttribute('position').count)].map((_, i) => skinnedWorld(merged, i))
    for (const p of eyeNow) expect(drawnNow.some((q) => q.distanceTo(p) < 1e-4)).toBe(true)
    expect(body.parent).toBeNull()
    expect(hat.parent).toBeNull()
    // and in a completely different pose the (now skinned) eyeball is where a rigid child of the bone would be
    rig.b1.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -1.1)
    rig.b0.position.set(-0.4, 0.2, 0.3)
    rig.root.updateMatrixWorld(true)
    const expected = new THREE.Group()
    const ghost = eye.clone()
    expected.add(ghost)
    // a reference rigid child of b1 with the same local transform
    rig.b1.add(ghost)
    ghost.position.copy(eye.position)
    ghost.quaternion.copy(eye.quaternion)
    ghost.scale.copy(eye.scale)
    rig.root.updateMatrixWorld(true)
    const reference = eyeWorld(ghost)
    const drawnLater = [...Array(merged.geometry.getAttribute('position').count)].map((_, i) => skinnedWorld(merged, i))
    for (const p of reference) expect(drawnLater.some((q) => q.distanceTo(p) < 1e-4)).toBe(true)
    expect(typeof expectFollow).toBe('function')
  })

  it('a rigid part on a bone that no skinned part uses still joins (the bone is added)', () => {
    const rig = makeRig()
    const extra = new THREE.Bone()
    extra.position.set(0.4, 0.5, 0)
    rig.b1.add(extra) // a bone the skeleton of the skinned parts does not list
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.6, 0.3).translate(0, 0.4, 0), mat('body'), 'Body')
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.2, 0.3).translate(0.5, 0.4, 0), mat('hat'), 'Hat')
    const charm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), mat('charm'))
    charm.name = 'Charm'
    extra.add(charm)
    rig.root.updateMatrixWorld(true)
    combineMeshes(rig.root)
    let merged = null
    rig.root.traverse((o) => o.isSkinnedMesh && (merged = o))
    expect(merged.skeleton.bones).toContain(extra)
    rig.b1.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.9)
    extra.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6)
    rig.root.updateMatrixWorld(true)
    const n = merged.geometry.getAttribute('position').count
    const drawn = [...Array(n)].map((_, i) => skinnedWorld(merged, i))
    const reference = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1))
    extra.add(reference)
    rig.root.updateMatrixWorld(true)
    const p = reference.geometry.getAttribute('position')
    for (let i = 0; i < p.count; i++) {
      const w = new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(reference.matrixWorld)
      expect(drawn.some((q) => q.distanceTo(w) < 1e-4)).toBe(true)
    }
  })

  it('a part missing uvs or normals still merges (zeros / computed)', () => {
    const rig = makeRig()
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0, 0.2, 0), mat('a'), 'Textured')
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0.5, 0.2, 0), mat('b'), 'Plain', { uv: false, normal: false })
    const report = combineMeshes(rig.root)
    expect(report.combined).toHaveLength(1)
    let merged = null
    rig.root.traverse((o) => o.isSkinnedMesh && (merged = o))
    const n = merged.geometry.getAttribute('position').count
    expect(merged.geometry.getAttribute('uv').count).toBe(n)
    expect(merged.geometry.getAttribute('normal').count).toBe(n)
    const nrm = merged.geometry.getAttribute('normal')
    for (let i = 0; i < n; i++) expect(new THREE.Vector3().fromBufferAttribute(nrm, i).length()).toBeGreaterThan(0.99)
  })

  it('static pieces of an object merge with their own transforms baked in', () => {
    const root = new THREE.Group()
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), mat('a'))
    a.position.set(1, 0, 0)
    a.name = 'Left'
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), mat('b'))
    b.position.set(-1, 2, 0)
    b.rotation.z = 0.5
    b.scale.set(1, 2, 1)
    b.name = 'Right'
    root.add(a, b)
    root.updateMatrixWorld(true)
    const worldBefore = []
    for (const m of [a, b]) {
      const p = m.geometry.getAttribute('position')
      for (let i = 0; i < p.count; i++) worldBefore.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld))
    }
    combineMeshes(root)
    expect(count(root)).toBe(1)
    let merged = null
    root.traverse((o) => o.isMesh && (merged = o))
    root.updateMatrixWorld(true)
    const p = merged.geometry.getAttribute('position')
    const after = [...Array(p.count)].map((_, i) => new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(merged.matrixWorld))
    for (const v of worldBefore) expect(after.some((q) => q.distanceTo(v) < 1e-5)).toBe(true)
  })

  it('a single mesh, or nothing to merge, changes nothing and says so', () => {
    const rig = makeRig()
    const only = skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0, 0.2, 0), mat('a'), 'Only')
    const report = combineMeshes(rig.root)
    expect(report.combined).toHaveLength(0)
    expect(only.parent).toBe(rig.root)
    expect(describeCombine(report)).toMatch(/No meshes could be combined/)
  })

  it('the exported file has ONE mesh with one primitive per material', async () => {
    const rig = makeRig()
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0, 0.2, 0), mat('a'), 'A')
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(0.5, 0.2, 0), mat('b'), 'B')
    skinnedPart(rig, new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(-0.5, 0.2, 0), mat('c'), 'C')
    const group = new THREE.Group()
    group.add(rig.root)
    combineMeshes(group)
    const json = await new Promise((resolve, reject) => new GLTFExporter().parse(group, resolve, reject, { binary: false, onlyVisible: true }))
    expect(json.meshes).toHaveLength(1)
    expect(json.meshes[0].primitives).toHaveLength(3)
    expect(json.materials).toHaveLength(3)
    expect(json.skins).toHaveLength(1)
    const withMesh = json.nodes.filter((n) => n.mesh !== undefined)
    expect(withMesh).toHaveLength(1)
    expect(withMesh[0].skin).toBe(0)
  })
})
