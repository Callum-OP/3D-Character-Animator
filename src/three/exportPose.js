import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'

// Builds the throwaway copy of a character/prop that GLTFExporter writes out.
//
// pose: 'baked' (default for DCC use) — the on-screen pose becomes the file's
//   bind pose: skinned vertices are baked into the mesh, and every joint's
//   inverse-bind matrix is re-based on that joint's posed world matrix, so
//   world * inverseBind = identity for EVERY joint. Nothing is left for a
//   viewer to interpret as a pose-vs-bind delta — the same result as Blender's
//   "Apply Pose as Rest Pose". This is the mode to use for Blender: the
//   importer never has to reconcile a posed skeleton against the bind data
//   (which is what stretches limbs on rigs whose bind data is inconsistent
//   with their node hierarchy, e.g. the Sketchfab Juno rig, where ~47 joints
//   carry inverse-bind matrices that are off by a factor of 100).
// pose: 'current' — the bones stay posed and the skin keeps the model's
//   ORIGINAL inverse-bind data, so a spec-following viewer deforms the mesh
//   into the pose at runtime. Correct by the glTF spec, but leaves DCCs to
//   work out the delta themselves.
// pose: 'rest' — like 'current', but every bone with a known rest rotation is
//   put back to it (on the COPY only; the live character is never touched).
//
// Why this doesn't just call SkeletonUtils.clone and trust it: three's
// Skeleton.clone() hands the clone the SAME boneInverses array as the source
// (no copy), and any later recompute on either skeleton (calculateInverses,
// or a bind() without a bindMatrix) rewrites both — quietly re-basing the
// inverse-bind matrices onto whatever pose the bones happen to be in. That
// exports a mesh whose bones are posed but whose skinning resolves to the
// rest shape. Copying the source's inverses/bindMatrix into the clone
// explicitly makes the export independent of that.
//
// NOTE for 'baked': vertices are written in WORLD space and inverse-binds are
// inverse(jointWorld), i.e. the export group's world transform is baked in.
// scene.js places each copy at its source's world transform, so joint worlds
// in the file equal the ones used here. glTF ignores a skinned mesh node's own
// transform, so this is the spec-correct way to store it.
export function cloneForExport(root, { pose = 'current', restQuats = null } = {}) {
  root.updateWorldMatrix(true, true)
  const dup = cloneSkinned(root)

  const srcNodes = []
  const dupNodes = []
  ;(function walk(a, b) {
    srcNodes.push(a)
    dupNodes.push(b)
    for (let i = 0; i < a.children.length; i++) walk(a.children[i], b.children[i])
  })(root, dup)

  for (let i = 0; i < srcNodes.length; i++) {
    const src = srcNodes[i]
    const out = dupNodes[i]
    if (src.isSkinnedMesh && out.isSkinnedMesh) {
      out.skeleton.boneInverses = src.skeleton.boneInverses.map((m) => m.clone())
      out.bindMatrix.copy(src.bindMatrix)
      out.bindMatrixInverse.copy(src.bindMatrix).invert()
      if (pose === 'baked') bakePosedSkin(src, out)
    }
    if (pose === 'rest' && src.isBone && restQuats) {
      const rest = restQuats.get(src)
      if (rest) out.quaternion.copy(rest)
    }
  }
  dup.updateMatrixWorld(true)
  return dup
}

const _v = new THREE.Vector3()
const _n = new THREE.Vector3()
const _acc = new THREE.Matrix4()
const _full = new THREE.Matrix4()
const _m3 = new THREE.Matrix3()
const _nm = new THREE.Matrix3()

// Replace `out`'s geometry with the source mesh's CURRENT skinned shape in
// world space, and re-base its skeleton so the skin resolves to identity.
function bakePosedSkin(src, out) {
  src.skeleton.update() // boneMatrices from the live bones (the pose on screen)
  const geom = src.geometry.clone()
  const count = geom.attributes.position.count

  const pos = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    src.getVertexPosition(i, _v) // mesh-local, skinned + morphed, exactly as drawn
    _v.applyMatrix4(src.matrixWorld)
    pos[i * 3] = _v.x
    pos[i * 3 + 1] = _v.y
    pos[i * 3 + 2] = _v.z
  }

  const normalAttr = geom.attributes.normal
  const skinIndex = geom.attributes.skinIndex
  const skinWeight = geom.attributes.skinWeight
  if (normalAttr && skinIndex && skinWeight) {
    const nrm = new Float32Array(count * 3)
    const bm = src.skeleton.boneMatrices
    _nm.getNormalMatrix(src.matrixWorld)
    for (let i = 0; i < count; i++) {
      _acc.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
      let total = 0
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(i, k)
        if (!w) continue
        const j = skinIndex.getComponent(i, k) * 16
        for (let e = 0; e < 16; e++) _acc.elements[e] += w * bm[j + e]
        total += w
      }
      _n.fromBufferAttribute(normalAttr, i)
      if (total > 0) {
        _full.multiplyMatrices(src.bindMatrixInverse, _acc).multiply(src.bindMatrix)
        _m3.setFromMatrix4(_full)
        _n.applyMatrix3(_m3)
      }
      _n.applyMatrix3(_nm).normalize()
      nrm[i * 3] = _n.x
      nrm[i * 3 + 1] = _n.y
      nrm[i * 3 + 2] = _n.z
    }
    geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  }

  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geom.deleteAttribute('tangent') // would be stale after posing
  // The morphs are already baked into `pos`; leaving them would apply twice.
  geom.morphAttributes = {}
  out.morphTargetInfluences = []
  out.morphTargetDictionary = undefined
  geom.boundingBox = null
  geom.boundingSphere = null
  out.geometry = geom

  // bind = pose: inverse-bind is the inverse of each joint's posed world matrix.
  out.skeleton.boneInverses = src.skeleton.bones.map((b) => b.matrixWorld.clone().invert())
  out.bindMatrix.identity()
  out.bindMatrixInverse.identity()
}