import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { bakeRigSource } from '../three/rigSource.js'

function glbJson(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const len = dv.getUint32(12, true)
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)))
}

// A skinned "character" whose skeleton is scaled 100x in its parents (cm rig inside a metre scene) and whose
// mesh is rotated: the situation where a raw file is read differently by Blender than by the preview.
function skinnedCharacter() {
  const geo = new THREE.CylinderGeometry(0.2, 0.2, 180, 8, 6)
  geo.translate(0, 90, 0)
  const n = geo.getAttribute('position').count
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4))
  const w = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) w[i * 4] = 1
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4))
  const bone = new THREE.Bone()
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff }))
  mesh.name = 'Body'
  mesh.add(bone)
  mesh.bind(new THREE.Skeleton([bone]))
  const root = new THREE.Group()
  root.scale.setScalar(0.01)
  root.rotation.x = -Math.PI / 2
  root.add(mesh)
  return root
}

describe('bakeRigSource (what Blender receives for any model)', () => {
  it('writes a static file whose size equals the preview box, whatever the source scale / rotation', async () => {
    const root = skinnedCharacter()
    root.updateMatrixWorld(true)
    const live = new THREE.Box3().setFromObject(root)
    const src = await bakeRigSource(root, { name: 'hero.fbx' })
    expect(src.name).toBe('hero.glb')
    expect(src.box.max[1] - src.box.min[1]).toBeCloseTo(live.max.y - live.min.y, 3)
    expect(src.box.max[2] - src.box.min[2]).toBeCloseTo(live.max.z - live.min.z, 3)
    const j = glbJson(src.data)
    expect(j.skins).toBeUndefined() // nothing to misread
    expect(j.meshes.length).toBe(1)
    const pos = j.accessors[j.meshes[0].primitives[0].attributes.POSITION]
    // the written vertices already ARE the preview's size (metres), not the raw 180-unit bind data
    expect(pos.max[1] - pos.min[1]).toBeCloseTo(live.max.y - live.min.y, 2)
    expect(pos.max[1] - pos.min[1]).toBeLessThan(5)
  })

  it('refuses a model with nothing to rig', async () => {
    await expect(bakeRigSource(new THREE.Group())).rejects.toThrow(/no visible meshes/)
  })
})
