import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'

// A single synthetic character: a box skinned to one bone that has been moved away from its bind position.
const roots = []
vi.mock('../three/objects.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getAllRootsForExport: () => roots,
}))

import { exportSceneModel } from '../three/scene.js'

function skinnedBox() {
  const root = new THREE.Group()
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const count = geometry.attributes.position.count
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), 4))
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial())
  mesh.name = 'Body Mesh'
  const bone = new THREE.Bone()
  bone.name = 'root'
  mesh.add(bone)
  root.add(mesh)
  mesh.bind(new THREE.Skeleton([bone]))
  bone.position.x = 5 // the pose on screen: moved 5 along x from the bind pose
  root.updateMatrixWorld(true)
  return { root, name: 'Hero' }
}

let saved
beforeEach(() => {
  roots.length = 0
  roots.push(skinnedBox())
  saved = []
  URL.createObjectURL = vi.fn((blob) => { saved.push(blob); return 'blob:x' })
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { saved.at(-1).fileName = this.download })
})
afterEach(() => vi.restoreAllMocks())

const text = async (blob) => Buffer.from(await blob.arrayBuffer()).toString('latin1')
const xs = (obj) => [...obj.matchAll(/^v ([-\d.e+]+) /gm)].map((m) => Number(m[1]))

describe('exportSceneModel — static formats', () => {
  it('writes an OBJ of the POSED shape, not the bind pose', async () => {
    const result = await exportSceneModel('obj', 'hero', 'current')
    expect(result.ok).toBe(true)
    expect(result.message).toMatch(/\.obj — geometry only/)
    expect(saved[0].fileName).toMatch(/^hero_\d{8}_\d{6}\.obj$/)
    const obj = await text(saved[0])
    const x = xs(obj)
    expect(x.length).toBe(24) // a box has 24 vertices
    expect(Math.min(...x)).toBeCloseTo(4.5) // bind pose would be -0.5..0.5
    expect(Math.max(...x)).toBeCloseTo(5.5)
    expect(obj).toContain('o Body_Mesh')
  })

  it.each([
    ['stl', 84 + 50 * 12], // binary STL: 80 header + 4 count + 50 bytes × 12 triangles
  ])('writes a binary %s of the right size', async (format, bytes) => {
    const result = await exportSceneModel(format, 'hero', 'current')
    expect(result.ok).toBe(true)
    expect(saved[0].size).toBe(bytes)
  })

  it('writes a binary PLY with the posed vertices', async () => {
    const result = await exportSceneModel('ply', 'hero', 'current')
    expect(result.ok).toBe(true)
    const head = (await text(saved[0])).slice(0, 400)
    expect(head).toContain('format binary_little_endian 1.0')
    expect(head).toContain('element vertex 24')
  })

  it('combine merges every mesh into one object', async () => {
    const second = skinnedBox()
    roots.push(second)
    const separate = await exportSceneModel('obj', 'a', 'current', { combineMeshes: false })
    const apart = await text(saved[0])
    expect((apart.match(/^o /gm) || []).length).toBe(2)
    const merged = await exportSceneModel('obj', 'a', 'current', { combineMeshes: true })
    const one = await text(saved[1])
    expect((one.match(/^o /gm) || []).length).toBe(1)
    expect(merged.message).toMatch(/Merged 2 meshes into one/)
    expect(separate.ok && merged.ok).toBe(true)
  })

  it('still reports nothing to export when the scene is empty', async () => {
    roots.length = 0
    const result = await exportSceneModel('obj', 'hero', 'current')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Nothing to export/)
  })
})

describe('exportSceneModel — glTF family is unchanged', () => {
  it('still writes a binary glb', async () => {
    const result = await exportSceneModel('glb', 'hero', 'baked')
    expect(result.ok).toBe(true)
    expect(saved[0].fileName).toMatch(/\.glb$/)
    expect((await text(saved[0])).slice(0, 4)).toBe('glTF')
  })
})
