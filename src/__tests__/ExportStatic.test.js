import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { bakeStaticMeshes, writeStaticModel, isStaticFormat, STATIC_FORMATS } from '../three/exportStatic.js'

// Signed volume of a closed triangle mesh: positive when the triangles wind outward.
function signedVolume(geometry) {
  const p = geometry.getAttribute('position')
  const idx = geometry.index ? geometry.index.array : Array.from({ length: p.count }, (_, i) => i)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  let volume = 0
  for (let i = 0; i < idx.length; i += 3) {
    a.fromBufferAttribute(p, idx[i]); b.fromBufferAttribute(p, idx[i + 1]); c.fromBufferAttribute(p, idx[i + 2])
    volume += a.dot(b.clone().cross(c)) / 6
  }
  return volume
}

const meshesOf = (group) => group.children.filter((c) => c.isMesh)

describe('bakeStaticMeshes', () => {
  it('applies the mesh transform and leaves the original geometry untouched', () => {
    const root = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    mesh.position.set(0, 2, 0)
    mesh.scale.set(2, 2, 2)
    root.add(mesh)
    const { group } = bakeStaticMeshes(root)
    const box = new THREE.Box3().setFromBufferAttribute(meshesOf(group)[0].geometry.getAttribute('position'))
    expect(box.min.y).toBeCloseTo(1)
    expect(box.max.y).toBeCloseTo(3)
    expect(mesh.geometry.getAttribute('position').getY(0)).toBeLessThanOrEqual(0.5) // source geometry unchanged
  })

  it('applies shape keys at their current influence', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const count = geometry.attributes.position.count
    const target = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) target[i * 3 + 2] = 1 // every vertex +1 on z
    geometry.morphAttributes.position = [new THREE.BufferAttribute(target, 3)]
    geometry.morphTargetsRelative = true
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
    mesh.updateMorphTargets()
    mesh.morphTargetInfluences[0] = 0.5
    const root = new THREE.Group().add(mesh)
    const { group } = bakeStaticMeshes(root)
    const box = new THREE.Box3().setFromBufferAttribute(meshesOf(group)[0].geometry.getAttribute('position'))
    expect(box.min.z).toBeCloseTo(0) // was -0.5
    expect(box.max.z).toBeCloseTo(1) // was 0.5
  })

  it('keeps triangles facing outward when the transform mirrors the mesh', () => {
    const normal = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    const mirrored = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    mirrored.scale.x = -1
    const root = new THREE.Group().add(normal, mirrored)
    const { group } = bakeStaticMeshes(root)
    const [a, b] = meshesOf(group)
    expect(signedVolume(a.geometry)).toBeCloseTo(1)
    expect(signedVolume(b.geometry)).toBeCloseTo(1) // naive baking would give -1
  })

  it('skips hidden meshes, including ones under a hidden parent', () => {
    const root = new THREE.Group()
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    hidden.visible = false
    const parent = new THREE.Group()
    parent.visible = false
    parent.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))
    root.add(hidden, parent, new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))
    expect(bakeStaticMeshes(root).meshes).toBe(1)
  })

  it('merges into one mesh, even when only some parts have UVs', () => {
    const withUv = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    const noUv = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    noUv.geometry.deleteAttribute('uv')
    noUv.position.x = 3
    const { group, meshes } = bakeStaticMeshes(new THREE.Group().add(withUv, noUv), { merge: true })
    expect(meshes).toBe(2)
    expect(meshesOf(group)).toHaveLength(1)
    expect(meshesOf(group)[0].geometry.getAttribute('position').count).toBe(48)
    expect(meshesOf(group)[0].name).toBe('Combined')
  })

  it('reports no meshes for an empty scene', () => {
    expect(bakeStaticMeshes(new THREE.Group()).meshes).toBe(0)
  })
})

describe('writeStaticModel', () => {
  const group = () => bakeStaticMeshes(new THREE.Group().add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()), { name: 'cube' }))).group
  const bytes = async (blob) => Buffer.from(await blob.arrayBuffer())

  it('knows which formats are static', () => {
    expect(['obj', 'stl', 'ply'].every(isStaticFormat)).toBe(true)
    expect(isStaticFormat('glb')).toBe(false)
    expect(isStaticFormat('toString')).toBe(false)
    expect(Object.keys(STATIC_FORMATS)).toEqual(['obj', 'stl', 'ply'])
  })

  it('OBJ: named object, vertices, normals, UVs and faces', async () => {
    const text = (await bytes(await writeStaticModel('obj', group()))).toString()
    expect(text).toContain('o cube')
    expect((text.match(/^v /gm) || []).length).toBe(24)
    expect((text.match(/^vn /gm) || []).length).toBe(24)
    expect((text.match(/^vt /gm) || []).length).toBe(24)
    expect((text.match(/^f /gm) || []).length).toBe(12)
  })

  it('STL: binary with the right triangle count', async () => {
    const data = await bytes(await writeStaticModel('stl', group()))
    expect(data.readUInt32LE(80)).toBe(12)
    expect(data.length).toBe(84 + 50 * 12)
  })

  it('PLY: binary little-endian header with vertex and face counts', async () => {
    const head = (await bytes(await writeStaticModel('ply', group()))).subarray(0, 300).toString('latin1')
    expect(head.startsWith('ply')).toBe(true)
    expect(head).toContain('format binary_little_endian 1.0')
    expect(head).toContain('element vertex 24')
    expect(head).toContain('element face 12')
  })

  it('rejects an unknown format', async () => {
    await expect(writeStaticModel('fbx', group())).rejects.toThrow(/Unknown export format/)
  })
})
