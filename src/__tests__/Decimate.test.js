import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import {
  ensureDecimatorReady,
  decimateGeometry,
  applyMeshDecimation,
  decimateSpecOf,
  getOriginalGeometry,
  isDecimated,
  triangleCount,
} from '../three/decimate.js'
import { useStore } from '../store.js'

beforeAll(async () => {
  await ensureDecimatorReady()
})

const sphere = () => new THREE.SphereGeometry(1, 48, 32) // indexed, with uv + normal

function validIndex(g) {
  const n = g.attributes.position.count
  for (let i = 0; i < g.index.count; i++) if (g.index.getX(i) >= n) return false
  return true
}

describe('decimateGeometry', () => {
  it('keeps about the asked share of the triangles and leaves the input alone', () => {
    const g = sphere()
    const before = triangleCount(g)
    const out = decimateGeometry(g, 0.25)
    expect(triangleCount(g)).toBe(before)
    expect(out).not.toBe(g)
    const after = triangleCount(out)
    expect(after).toBeLessThan(before * 0.4)
    expect(after).toBeGreaterThan(before * 0.1)
    expect(validIndex(out)).toBe(true)
    expect(out.attributes.position.count).toBeLessThan(g.attributes.position.count)
  })

  it('keeps UVs, normals and the same attribute set, all the same length', () => {
    const out = decimateGeometry(sphere(), 0.3)
    expect(Object.keys(out.attributes).sort()).toEqual(['normal', 'position', 'uv'])
    const n = out.attributes.position.count
    expect(out.attributes.uv.count).toBe(n)
    expect(out.attributes.normal.count).toBe(n)
    expect(out.boundingSphere.radius).toBeGreaterThan(0.9)
  })

  it('returns the input untouched at full detail', () => {
    const g = sphere()
    expect(decimateGeometry(g, 1)).toBe(g)
  })

  it('keeps skin weights and morph targets matched to the vertices that remain', () => {
    const g = sphere()
    const n = g.attributes.position.count
    const idx = new Uint16Array(n * 4)
    const w = new Float32Array(n * 4)
    for (let v = 0; v < n; v++) {
      idx[v * 4] = v % 7
      w[v * 4] = 1
    }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4))
    g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4))
    const morph = new Float32Array(n * 3)
    for (let v = 0; v < n; v++) morph[v * 3] = g.attributes.position.getX(v) + 5 // marker: old x + 5
    g.morphAttributes.position = [new THREE.BufferAttribute(morph, 3)]
    const out = decimateGeometry(g, 0.2)
    const m = out.attributes.position.count
    expect(out.attributes.skinIndex.count).toBe(m)
    expect(out.attributes.skinWeight.count).toBe(m)
    expect(out.morphAttributes.position[0].count).toBe(m)
    for (let v = 0; v < m; v++) {
      expect(out.morphAttributes.position[0].getX(v)).toBeCloseTo(out.attributes.position.getX(v) + 5, 5)
      expect(out.attributes.skinWeight.getX(v)).toBe(1)
    }
  })

  it('keeps material groups, each covering its own triangles', () => {
    const g = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12) // six groups
    const out = decimateGeometry(g, 0.3)
    expect(out.groups.length).toBe(g.groups.length)
    let at = 0
    out.groups.forEach((grp, i) => {
      expect(grp.start).toBe(at)
      expect(grp.materialIndex).toBe(g.groups[i].materialIndex)
      at += grp.count
    })
    expect(at).toBe(out.index.count)
    expect(triangleCount(out)).toBeLessThan(triangleCount(g))
  })

  it('handles a mesh with no index list (and ignores old region numbers)', () => {
    const g = sphere().toNonIndexed()
    g.setAttribute('regionId', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1))
    const out = decimateGeometry(g, 0.25)
    expect(out.index).toBeTruthy()
    expect(out.attributes.regionId).toBeUndefined()
    expect(triangleCount(out)).toBeLessThan(triangleCount(g) * 0.4)
    expect(validIndex(out)).toBe(true)
  })
})

describe('applyMeshDecimation', () => {
  const makeMesh = () => new THREE.Mesh(sphere(), new THREE.MeshStandardMaterial())

  it('reduces, then restores the original geometry', () => {
    const mesh = makeMesh()
    const original = mesh.geometry
    const spec = decimateSpecOf({ decimate: { ratio: 0.2 } })
    expect(applyMeshDecimation(mesh, spec)).toBe(true)
    expect(mesh.geometry).not.toBe(original)
    expect(isDecimated(mesh)).toBe(true)
    expect(getOriginalGeometry(mesh)).toBe(original)
    expect(applyMeshDecimation(mesh, null)).toBe(false)
    expect(mesh.geometry).toBe(original)
    expect(isDecimated(mesh)).toBe(false)
  })

  it('does not redo the work when nothing changed, and re-reduces from the original when it does', () => {
    const mesh = makeMesh()
    const original = mesh.geometry
    applyMeshDecimation(mesh, decimateSpecOf({ decimate: { ratio: 0.5 } }))
    const half = mesh.geometry
    applyMeshDecimation(mesh, decimateSpecOf({ decimate: { ratio: 0.5 } }))
    expect(mesh.geometry).toBe(half)
    applyMeshDecimation(mesh, decimateSpecOf({ decimate: { ratio: 0.1 } }))
    expect(getOriginalGeometry(mesh)).toBe(original)
    expect(triangleCount(mesh.geometry)).toBeLessThan(triangleCount(half))
  })

  it('does not reduce twice on a clone of a reduced part', () => {
    const mesh = makeMesh()
    applyMeshDecimation(mesh, decimateSpecOf({ decimate: { ratio: 0.25 } }))
    const copy = new THREE.Mesh(mesh.geometry.clone(), mesh.material)
    const tris = triangleCount(copy.geometry)
    applyMeshDecimation(copy, decimateSpecOf({ decimate: { ratio: 0.25 } }))
    expect(triangleCount(copy.geometry)).toBe(tris)
    applyMeshDecimation(copy, null)
    expect(triangleCount(copy.geometry)).toBe(triangleCount(getOriginalGeometry(mesh)))
  })

  it('writes nothing about it into the exported file (userData stays clean)', () => {
    const mesh = makeMesh()
    applyMeshDecimation(mesh, decimateSpecOf({ decimate: { ratio: 0.25 } }))
    expect(JSON.stringify(mesh.geometry.userData)).toBe('{}')
    expect(Object.keys(mesh.geometry.userData)).toEqual([])
  })

  it('treats full detail as no setting', () => {
    expect(decimateSpecOf(undefined)).toBeNull()
    expect(decimateSpecOf({ decimate: { ratio: 1 } })).toBeNull()
    expect(decimateSpecOf({ decimate: { ratio: 0 } }).ratio).toBe(0.01)
  })
})

describe('store.setMeshesDecimate', () => {
  it('stores the setting per part and clears it at full detail', () => {
    useStore.setState({ meshOverrides: {} })
    useStore.getState().setMeshesDecimate(['a', 'b'], { ratio: 0.3 })
    expect(useStore.getState().meshOverrides.a.decimate).toEqual({ ratio: 0.3, protect: true })
    useStore.getState().setMeshesDecimate(['a'], { protect: false })
    expect(useStore.getState().meshOverrides.a.decimate).toEqual({ ratio: 0.3, protect: false })
    useStore.getState().setMeshesDecimate(['a'], { ratio: 1 })
    expect(useStore.getState().meshOverrides.a.decimate).toBeUndefined()
    expect(useStore.getState().meshOverrides.b.decimate.ratio).toBe(0.3)
  })
})
