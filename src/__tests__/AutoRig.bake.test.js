import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { bakeMeshesWithMaterials } from '../three/exportStatic.js'

describe('bakeMeshesWithMaterials (what the Auto Rigger sends to Blender)', () => {
  function scene() {
    const root = new THREE.Group()
    const geo = new THREE.BoxGeometry(1, 2, 1)
    geo.clearGroups()
    geo.addGroup(0, 18, 0)
    geo.addGroup(18, 18, 1)
    const matA = new THREE.MeshStandardMaterial({ name: 'skin', color: 0xffccaa })
    const matB = new THREE.MeshStandardMaterial({ name: 'cloth', color: 0x3366ff })
    const body = new THREE.Mesh(geo, [matA, matB])
    body.name = 'Body Part'
    body.position.set(5, 0, 0)
    body.scale.setScalar(2)
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), matA)
    hidden.name = 'Hidden'
    hidden.visible = false
    root.add(body, hidden)
    return { root, matA, matB }
  }

  it('keeps each mesh\'s own materials, multi-material groups and name', () => {
    const { root, matA, matB } = scene()
    const { group, meshes } = bakeMeshesWithMaterials(root)
    expect(meshes).toBe(1) // the hidden mesh is left out
    const m = group.children[0]
    expect(m.name).toBe('Body Part')
    expect(m.material).toEqual([matA, matB]) // textures / colours travel with it
    expect(m.geometry.groups.map((g) => [g.start, g.count, g.materialIndex])).toEqual([[0, 18, 0], [18, 18, 1]])
    expect(m.geometry.getAttribute('uv')).toBeTruthy()
  })

  it('writes plain world-space geometry (no skin data to misread)', () => {
    const { root } = scene()
    const { group } = bakeMeshesWithMaterials(root)
    const m = group.children[0]
    expect(m.isSkinnedMesh).toBeFalsy()
    expect(m.geometry.getAttribute('skinIndex')).toBeUndefined()
    const box = new THREE.Box3().setFromObject(group)
    expect(box.min.x).toBeCloseTo(4) // x 5 +/- (0.5 * scale 2)
    expect(box.max.x).toBeCloseTo(6)
    expect(box.max.y - box.min.y).toBeCloseTo(4) // height 2 * scale 2
  })

  it('bakes a skinned mesh at its current pose into ordinary vertices', () => {
    const geo = new THREE.CylinderGeometry(0.2, 0.2, 2, 8, 4)
    geo.translate(0, 1, 0)
    const n = geo.getAttribute('position').count
    const idx = new Uint16Array(n * 4)
    const wts = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) wts[i * 4] = 1
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4))
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4))
    const bone = new THREE.Bone()
    const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial())
    mesh.add(bone)
    mesh.bind(new THREE.Skeleton([bone]))
    const root = new THREE.Group()
    root.add(mesh)
    bone.position.set(0, 0, 3) // the pose moves the whole mesh 3 units along Z
    root.updateMatrixWorld(true)
    mesh.skeleton.update()
    const { group } = bakeMeshesWithMaterials(root)
    const box = new THREE.Box3().setFromObject(group)
    expect(box.min.z).toBeGreaterThan(2.7)
    expect(group.children[0].isSkinnedMesh).toBeFalsy()
  })
})
