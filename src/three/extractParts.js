import * as THREE from 'three'

// Turn parts of a scene into a standalone group, ready to be written out as the file of a
// brand-new object (see scene.js extractPartsToObject).
//
// The parts keep their exact WORLD placement relative to a new pivot — the middle of their
// footprint, resting on their lowest point — so once the new object is placed at that pivot
// it sits exactly where the originals were, and its gizmo is somewhere sensible (a car's
// pivot is under the car, not at the origin of the whole scene).
//
// `materialFor(mesh)` supplies the material(s) to write for each part; the geometry is shared
// with the source mesh (the exporter only reads it).
export function buildPartsGroup(meshes, materialFor, name = 'Object', bakeFor = null) {
  const box = new THREE.Box3()
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false)
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld))
  }
  const pivot = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2)
  const toPivot = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z)

  const group = new THREE.Group()
  group.name = name
  for (const mesh of meshes) {
    // bakeFor(mesh) -> { geometry, material } when the part has regions: they are written out as real
    // materials (regrouped faces), since a viewport shader effect cannot live in a file.
    const baked = bakeFor ? bakeFor(mesh) : null
    const copy = baked ? new THREE.Mesh(baked.geometry, baked.material) : new THREE.Mesh(mesh.geometry, materialFor(mesh) || mesh.material)
    copy.name = mesh.name
    new THREE.Matrix4().multiplyMatrices(toPivot, mesh.matrixWorld).decompose(copy.position, copy.quaternion, copy.scale)
    group.add(copy)
  }
  group.updateMatrixWorld(true)
  return { group, pivot }
}

// A file-name-safe version of a part name.
export function safeFileStem(name, fallback = 'Object') {
  const stem = String(name || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, ' ')
  return stem || fallback
}
