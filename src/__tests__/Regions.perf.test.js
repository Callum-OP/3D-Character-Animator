import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { getAdjacency, growRegion, ensureRegionGeometry, regionVertexCount, applyRegionIds, toRanges } from '../three/regions.js'

// The straightforward version the fast one replaced (strings and lists): the neighbour sets must be identical.
function referenceAdjacency(geometry) {
  const pos = geometry.attributes.position
  const nTris = Math.floor(regionVertexCount(geometry) / 3)
  const index = geometry.index
  const vert = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k)
  const ids = new Map()
  const idOf = (v) => {
    const key = Math.round(pos.getX(v) * 1e4) + ',' + Math.round(pos.getY(v) * 1e4) + ',' + Math.round(pos.getZ(v) * 1e4)
    let id = ids.get(key)
    if (id === undefined) ids.set(key, (id = ids.size))
    return id
  }
  const edges = new Map()
  for (let t = 0; t < nTris; t++) {
    const a = idOf(vert(t, 0)), b = idOf(vert(t, 1)), c = idOf(vert(t, 2))
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p < q ? p + '_' + q : q + '_' + p
      const list = edges.get(key)
      if (list) list.push(t)
      else edges.set(key, [t])
    }
  }
  const adj = Array.from({ length: nTris }, () => new Set())
  for (const list of edges.values()) {
    if (list.length < 2) continue
    for (const a of list) for (const b of list) if (a !== b) adj[a].add(b)
  }
  return adj
}
const neighbours = (adj, t) => new Set(Array.from(adj.list.subarray(adj.offsets[t], adj.offsets[t + 1])))

function sameAsReference(geometry) {
  const fast = getAdjacency(geometry)
  const ref = referenceAdjacency(geometry)
  expect(fast.length).toBe(ref.length)
  for (let t = 0; t < ref.length; t++) expect(neighbours(fast, t)).toEqual(ref[t])
}

describe('getAdjacency (fast) matches the plain version', () => {
  it('an indexed sphere (its seam splits vertices, matched by position)', () => sameAsReference(new THREE.SphereGeometry(1, 24, 16)))
  it('the same sphere with no index list', () => sameAsReference(new THREE.SphereGeometry(1, 24, 16).toNonIndexed()))
  it('a box with shared and split edges', () => sameAsReference(new THREE.BoxGeometry(1, 1, 1, 3, 3, 3)))
  it('a torus', () => sameAsReference(new THREE.TorusGeometry(1, 0.3, 12, 20)))
  it('a mesh where three faces meet on one edge', () => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1], 3))
    g.setIndex([0, 1, 2, 0, 1, 3, 0, 1, 4])
    sameAsReference(g)
    const adj = getAdjacency(g)
    expect(neighbours(adj, 0)).toEqual(new Set([1, 2]))
  })
  it('empty and tiny meshes', () => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
    expect(getAdjacency(g).length).toBe(1)
    expect(neighbours(getAdjacency(g), 0).size).toBe(0)
  })
})

describe('regions stay fast and correct when the mesh is unwrapped', () => {
  it('keeps the connections (and colours) it worked out for the indexed mesh', () => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshStandardMaterial({ color: 0x336699 }))
    const before = getAdjacency(mesh.geometry)
    const grown = growRegion(mesh, 5, { mode: 'piece' })
    const unwrapped = ensureRegionGeometry(mesh)
    expect(unwrapped).not.toBe(mesh.geometry === unwrapped ? null : unwrapped)
    expect(getAdjacency(mesh.geometry)).toBe(before) // not rebuilt
    expect(growRegion(mesh, 5, { mode: 'piece' })).toEqual(grown) // same faces, same order
    sameAsReference(mesh.geometry)
  })

  it('growing in colour mode gives the same faces after unwrapping', () => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshStandardMaterial({ color: 0x336699 }))
    const a = growRegion(mesh, 7, { mode: 'color', tolerance: 0.3 })
    ensureRegionGeometry(mesh)
    expect(growRegion(mesh, 7, { mode: 'color', tolerance: 0.3 })).toEqual(a)
  })

  it('re-applying the same regions does not rewrite the face numbers', () => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshStandardMaterial())
    const n = regionVertexCount(mesh.geometry)
    const regions = [{ id: 'a', tris: toRanges([0, 1, 2, 10, 11]), vertexCount: n }]
    expect(applyRegionIds(mesh, regions)).toBe(true)
    const attr = mesh.geometry.getAttribute('regionId')
    const version = attr.version
    for (let i = 0; i < 5; i++) expect(applyRegionIds(mesh, regions)).toBe(true)
    expect(attr.version).toBe(version)
    const changed = [{ id: 'a', tris: toRanges([0, 1, 2]), vertexCount: n }]
    applyRegionIds(mesh, changed)
    expect(mesh.geometry.getAttribute('regionId').array[10 * 3]).toBe(0)
  })
})
