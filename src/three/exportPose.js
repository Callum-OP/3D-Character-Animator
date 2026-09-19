import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'

// Builds the throwaway copy of a character/prop that GLTFExporter writes out.
//
// pose: 'current' (default) — export exactly what's on screen: the bones stay
//   in their posed rotations and the skin's inverse-bind matrices stay the
//   model's ORIGINAL bind data, so viewers/DCCs deform the mesh into the pose.
// pose: 'rest' — same copy, but every bone that has a known rest rotation is
//   put back to it (on the COPY only; the live character is never touched),
//   giving a clean T-/A-pose export.
//
// Why this doesn't just call SkeletonUtils.clone and trust it: three's
// Skeleton.clone() hands the clone the SAME boneInverses array as the source
// (no copy), and any later recompute on either skeleton (calculateInverses,
// or a bind() without a bindMatrix) rewrites both — quietly re-basing the
// inverse-bind matrices onto whatever pose the bones happen to be in. That
// exports a mesh whose bones are posed but whose skinning resolves to the
// rest shape. Copying the source's inverses/bindMatrix into the clone
// explicitly makes the export independent of that.
export function cloneForExport(root, { pose = 'current', restQuats = null } = {}) {
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
    }
    if (pose === 'rest' && src.isBone && restQuats) {
      const rest = restQuats.get(src)
      if (rest) out.quaternion.copy(rest)
    }
  }
  dup.updateMatrixWorld(true)
  return dup
}