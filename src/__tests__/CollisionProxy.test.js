import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CollisionProxy, windingOrientation } from '../three/collisionProxy.js'
import { BodyCollider } from '../three/clothmod.js'

function skinnedTube({ segments = 40, radial = 24, bones = 8 } = {}) {
  const root = new THREE.Group()
  const list = []
  let parent = null
  for (let i = 0; i < bones; i++) {
    const bone = new THREE.Bone()
    bone.position.set(0, i ? 1 / (bones - 1) : 0, 0)
    if (parent) parent.add(bone)
    else root.add(bone)
    parent = bone
    list.push(bone)
  }
  const geometry = new THREE.CylinderGeometry(0.12, 0.12, 1, radial, segments, false).translate(0, 0.5, 0)
  const n = geometry.getAttribute('position').count
  const index = new Uint16Array(n * 4)
  const weight = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    const f = Math.min(bones - 1.001, Math.max(0, geometry.getAttribute('position').getY(i) * (bones - 1)))
    const k = Math.floor(f)
    index[4 * i] = k
    index[4 * i + 1] = k + 1
    weight[4 * i] = 1 - (f - k)
    weight[4 * i + 1] = f - k
  }
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(index, 4))
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weight, 4))
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
  root.add(mesh)
  root.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton(list))
  return { root, mesh, bones: list }
}

describe('CollisionProxy', () => {
  it('stays within its triangle budget and still covers the whole surface (no holes)', () => {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(4, 4, 64, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial())
    plane.updateMatrixWorld(true)
    const proxy = new CollisionProxy([plane], { maxTriangles: 1000 })
    expect(proxy.triangleCount).toBeGreaterThan(300)
    expect(proxy.triangleCount).toBeLessThanOrEqual(1000)
    // Every point of the real surface has proxy surface close by. Taking every Nth triangle instead
    // leaves gaps several times this wide.
    let worst = 0
    for (let i = 0; i < 400; i++) {
      const q = proxy.collider.query(Math.random() * 3.9 - 1.95, 0, Math.random() * 3.9 - 1.95, 3, 2)
      worst = Math.max(worst, q ? q.dist : 2)
    }
    expect(worst).toBeLessThan(0.02)
  })

  it('keeps small meshes whole and gives a big one the budget the small one did not need', () => {
    const small = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 4, 4), new THREE.MeshBasicMaterial()) // 32 triangles
    const big = new THREE.Mesh(new THREE.PlaneGeometry(3, 3, 60, 60), new THREE.MeshBasicMaterial()) // 7200
    big.position.y = 1
    big.updateMatrixWorld(true)
    const proxy = new CollisionProxy([small, big], { maxTriangles: 1200 })
    const smallSource = proxy.sources.find((s) => s.mesh === small)
    expect(smallSource.triangles.length / 3).toBe(32)
    expect(proxy.triangleCount).toBeLessThanOrEqual(1200)
    expect(proxy.triangleCount).toBeGreaterThan(900)
  })

  it('evaluates the face filter once, when it is built, not every frame', () => {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 10, 10), new THREE.MeshBasicMaterial())
    let calls = 0
    const proxy = new CollisionProxy([plane], {
      includeTriangle: (mesh, face) => {
        calls++
        return face % 2 === 0
      },
    })
    const afterBuild = calls
    expect(afterBuild).toBe(200)
    expect(proxy.triangleCount).toBe(100)
    for (let f = 0; f < 5; f++) proxy.update(f)
    expect(calls).toBe(afterBuild)
  })

  it('keeps one collider object and follows a skinned mesh as it is posed', () => {
    const { root, mesh, bones } = skinnedTube()
    const proxy = new CollisionProxy([mesh], { maxTriangles: 800, pad: 0 })
    const collider = proxy.collider
    expect(collider.query(0.12, 0.5, 0, 2, 0.05)).not.toBeNull()
    bones[0].position.x = 0.5 // the whole tube moves half a metre sideways
    root.updateMatrixWorld(true)
    proxy.update(1)
    expect(proxy.collider).toBe(collider)
    expect(collider.query(0.12, 0.5, 0, 2, 0.05)).toBeNull() // the old spot is empty now
    const q = collider.query(0.62, 0.5, 0, 2, 0.05)
    expect(q).not.toBeNull()
    expect(q.dist).toBeLessThan(0.01)
  })

  it('does not refresh twice in the same frame', () => {
    const { root, mesh, bones } = skinnedTube()
    const proxy = new CollisionProxy([mesh], { maxTriangles: 400 })
    proxy.update(5)
    bones[0].position.x = 1
    root.updateMatrixWorld(true)
    proxy.update(5)
    expect(proxy.collider.query(1.12, 0.5, 0, 2, 0.05)).toBeNull()
  })
})

describe('windingOrientation', () => {
  const flat = (geometry) => ({ positions: geometry.getAttribute('position').array, indices: geometry.index.array })
  it('says +1 for an outward-wound closed body and -1 when it is inside out', () => {
    const g = new THREE.SphereGeometry(0.5, 24, 16)
    const { positions, indices } = flat(g)
    expect(windingOrientation(positions, indices)).toBe(1)
    const flipped = Uint32Array.from(indices)
    for (let i = 0; i < flipped.length; i += 3) {
      const t = flipped[i + 1]
      flipped[i + 1] = flipped[i + 2]
      flipped[i + 2] = t
    }
    expect(windingOrientation(positions, flipped)).toBe(-1)
  })

  it('does not trust a flat sheet, whichever way it is wound', () => {
    const g = new THREE.PlaneGeometry(2, 2, 6, 6).rotateX(-Math.PI / 2)
    const { positions, indices } = flat(g)
    expect(windingOrientation(positions, indices)).toBe(0)
  })

  it('does not trust mixed winding', () => {
    const g = new THREE.SphereGeometry(0.5, 24, 16)
    const { positions } = flat(g)
    const mixed = Uint32Array.from(g.index.array)
    for (let i = 0; i < mixed.length; i += 6) {
      const t = mixed[i + 1]
      mixed[i + 1] = mixed[i + 2]
      mixed[i + 2] = t
    }
    expect(windingOrientation(positions, mixed)).toBe(0)
  })

  it('is read onto the collider a proxy builds', () => {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), new THREE.MeshBasicMaterial())
    expect(new CollisionProxy([sphere]).collider.orientation).toBe(1)
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 6, 6), new THREE.MeshBasicMaterial())
    expect(new CollisionProxy([sheet]).collider.orientation).toBe(0)
  })
})

describe('BodyCollider.refit', () => {
  it('gives the same answers as a collider built fresh on the moved surface', () => {
    const g = new THREE.SphereGeometry(0.5, 24, 16)
    const collider = new BodyCollider(g, 0.01)
    const positions = collider.tris
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] += 0.3
      positions[i + 1] *= 1.4
    }
    collider.refit(0.01)
    const fresh = new BodyCollider(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3)).setIndex(Array.from(g.index.array)), 0.01)
    for (let i = 0; i < 300; i++) {
      const x = Math.random() * 2 - 0.6, y = Math.random() * 2 - 1, z = Math.random() * 2 - 1
      const a = collider.query(x, y, z, 2, 1)
      const b = fresh.query(x, y, z, 2, 1)
      expect(a === null).toBe(b === null)
      if (a) expect(a.dist).toBeCloseTo(b.dist, 6)
    }
  })

  it('finds the true nearest triangle (matches a brute-force search)', () => {
    const g = new THREE.SphereGeometry(0.5, 20, 14)
    const collider = new BodyCollider(g, 0)
    const pos = g.getAttribute('position')
    const index = g.index
    const tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
    const target = new THREE.Triangle()
    const out = new THREE.Vector3()
    for (let i = 0; i < 200; i++) {
      // within the search window (3 cells ~ 0.1 m) of the surface, inside and outside
      const p = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize()
        .multiplyScalar(0.5 + (Math.random() - 0.5) * 0.16)
      let best = Infinity
      for (let f = 0; f < index.count; f += 3) {
        for (let c = 0; c < 3; c++) tri[c].fromBufferAttribute(pos, index.getX(f + c))
        target.set(tri[0], tri[1], tri[2]).closestPointToPoint(p, out)
        best = Math.min(best, out.distanceTo(p))
      }
      const q = collider.query(p.x, p.y, p.z, 3, 5)
      expect(q.dist).toBeCloseTo(best, 5)
    }
  })
})
