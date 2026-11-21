// Auto Rigger source: whatever the preview shows (a picked file, or an object from the scene) turned into a
// plain, static, textured .glb that Blender can only read one way.
//
//  * Skinning, shape keys and every parent transform are baked into ordinary world-space vertices, so no
//    skeleton, bind matrices, node scales or unit tricks travel with the file. (Skinned files are the usual
//    reason a model is a different size in Blender than in the preview: the preview shows the posed result,
//    Blender's importer shows the raw bind data.)
//  * Textures and materials stay (a geometry-only format would come back white).
//  * The preview group and the bounding box are made from the very same baked geometry that is written to the
//    file, so the markers the user places and the mesh Blender receives can never disagree.
import * as THREE from 'three'
import { bakeMeshesWithMaterials } from './exportStatic.js'
import { withExportSafeMaterials } from './materialUserData.js'

// root: an object that is already in the pose / scale wanted (matrices are updated here).
// → { name, data: Uint8Array (.glb), group (grey translucent preview), box: { min, max }, meshes }
export async function bakeRigSource(root, { name = 'model' } = {}) {
  root.updateMatrixWorld(true)
  const { group: baked, meshes } = bakeMeshesWithMaterials(root)
  if (!meshes) throw new Error('That model has no visible meshes to rig.')
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
  const exporter = new GLTFExporter()
  const result = await withExportSafeMaterials(baked, () => new Promise((resolve, reject) => {
    exporter.parse(baked, resolve, reject, { binary: true, onlyVisible: true })
  }))
  // the preview: the same geometry, flat grey and translucent, so the joints show through
  const preview = new THREE.Group()
  const grey = new THREE.MeshStandardMaterial({ color: 0xb8b8c4, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
  baked.traverse((o) => {
    if (o.isMesh) preview.add(new THREE.Mesh(o.geometry.clone(), grey))
  })
  preview.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(preview)
  if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) throw new Error('That model has no usable geometry.')
  const base = String(name).replace(/\.[^.]+$/, '') || 'model'
  return { name: `${base}.glb`, data: new Uint8Array(result), group: preview, box: { min: box.min.toArray(), max: box.max.toArray() }, meshes }
}
