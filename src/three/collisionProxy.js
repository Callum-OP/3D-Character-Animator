import * as THREE from 'three'
import { BodyCollider } from './clothmod.js'

// ---------------------------------------------------------------------------
// CollisionProxy: a cheap, always-current stand-in for "the body" to collide against.
//
// Why it exists: raycasting a skinned mesh re-skins every vertex of the whole mesh for every ray
// (tens of thousands of vertices x every bone x every sub-step), which is what made bone cloth /
// dangle collision run at a frame every few seconds. A proxy does the expensive part ONCE:
//
//   build (once)   pick which triangles count (a filter evaluated once, not per frame) and
//                  decimate them to a budget by VERTEX CLUSTERING: nearby vertices collapse onto
//                  one real representative vertex, so the whole surface stays covered. (Taking
//                  every Nth triangle instead leaves holes that thin cloth pokes straight through.)
//   refresh (frame) re-pose only the representative vertices (a couple of thousand, not the whole
//                  mesh) into world space, then refit one spatial index in place.
//   update (frame)  refresh on a cost-adaptive schedule: every frame while it is cheap, thinning
//                  out only if a very heavy scene makes the refresh itself measurable.
//
// The BodyCollider object (and its arrays) is created once and reused, so there is no per-frame
// allocation and `proxy.collider` is a stable reference.
// ---------------------------------------------------------------------------

const _p = new THREE.Vector3()
const REFRESH_FAST_MS = 1.2 // at or under this: refresh every frame
const REFRESH_SLOW_MS = 2.5 // under this: every 2nd frame; above: every 3rd

// Which faces of `mesh` to use, as a list of face ids (all faces when no filter is given).
function selectFaces(mesh, includeTriangle) {
  const geometry = mesh.geometry
  const position = geometry.getAttribute('position')
  const triangleCount = Math.floor((geometry.index ? geometry.index.count : position.count) / 3)
  const faces = []
  for (let face = 0; face < triangleCount; face++) {
    if (!includeTriangle || includeTriangle(mesh, face)) faces.push(face)
  }
  return faces
}

// Split a triangle budget across meshes. Shares follow the square root of each mesh's face count (a
// big body gets more than a pair of shoes, but not a hundred times more). A mesh that fits inside its
// share is kept whole, and what it leaves over goes to the bigger ones, so small parts (hands, shoes,
// buttons) are never decimated into nothing.
function shareBudget(counts, budget) {
  const shares = new Array(counts.length).fill(0)
  let remaining = Math.max(1, Math.floor(budget))
  let open = counts.map((_, i) => i).filter((i) => counts[i] > 0)
  while (open.length) {
    const totalWeight = open.reduce((sum, i) => sum + Math.sqrt(counts[i]), 0)
    const fits = open.filter((i) => counts[i] <= (remaining * Math.sqrt(counts[i])) / totalWeight)
    if (!fits.length) {
      for (const i of open) shares[i] = Math.max(1, Math.floor((remaining * Math.sqrt(counts[i])) / totalWeight))
      break
    }
    for (const i of fits) {
      shares[i] = counts[i]
      remaining -= counts[i]
    }
    open = open.filter((i) => !fits.includes(i))
  }
  return shares
}

// Vertex-cluster the chosen faces down to about `budget` triangles. Returns the representative
// vertices (original vertex ids, real vertices, not averages) and triangles over them.
function decimate(geometry, faces, budget) {
  const position = geometry.getAttribute('position')
  const index = geometry.index
  const corner = (face, c) => (index ? index.getX(face * 3 + c) : face * 3 + c)

  const used = new Map() // original vertex -> dense id
  const usedList = []
  for (const face of faces) {
    for (let c = 0; c < 3; c++) {
      const vertex = corner(face, c)
      if (!used.has(vertex)) {
        used.set(vertex, usedList.length)
        usedList.push(vertex)
      }
    }
  }

  const keepAll = faces.length <= budget
  let rep // dense id -> representative dense id
  if (keepAll) {
    rep = Int32Array.from({ length: usedList.length }, (_, i) => i)
  } else {
    let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity
    for (const vertex of usedList) {
      const x = position.getX(vertex), y = position.getY(vertex), z = position.getZ(vertex)
      if (x < lx) lx = x; if (x > hx) hx = x
      if (y < ly) ly = y; if (y > hy) hy = y
      if (z < lz) lz = z; if (z > hz) hz = z
    }
    const sx = hx - lx, sy = hy - ly, sz = hz - lz
    const extent = Math.max(sx, sy, sz, 1e-6)
    const cellOf = (cell, out) => {
      const nx = Math.floor(sx / cell) + 1
      const ny = Math.floor(sy / cell) + 1
      const cluster = new Map()
      const ids = out || new Int32Array(usedList.length)
      for (let i = 0; i < usedList.length; i++) {
        const vertex = usedList[i]
        const key =
          Math.floor((position.getX(vertex) - lx) / cell) +
          nx * (Math.floor((position.getY(vertex) - ly) / cell) + ny * Math.floor((position.getZ(vertex) - lz) / cell))
        let id = cluster.get(key)
        if (id === undefined) {
          id = cluster.size
          cluster.set(key, id)
        }
        ids[i] = id
      }
      return { ids, count: cluster.size }
    }
    // Closed or open, a surface mesh has about twice as many triangles as vertices, so aim for
    // budget / 2 clusters, then check the real triangle count and coarsen if it overshoots.
    const wantClusters = Math.max(4, Math.floor(budget / 2))
    let lo = extent / 2048, hi = extent
    for (let i = 0; i < 14; i++) {
      const mid = Math.sqrt(lo * hi)
      if (cellOf(mid).count > wantClusters) lo = mid
      else hi = mid
    }
    let cell = hi
    let clustering = cellOf(cell)
    const countTriangles = (ids) => {
      let n = 0
      for (const face of faces) {
        const a = ids[used.get(corner(face, 0))], b = ids[used.get(corner(face, 1))], c = ids[used.get(corner(face, 2))]
        if (a !== b && b !== c && a !== c) n++
      }
      return n
    }
    // Duplicate triangles collapse to one below, so the raw count overshooting a little is fine.
    for (let guard = 0; guard < 6 && countTriangles(clustering.ids) > budget * 1.6; guard++) {
      cell *= 1.12
      clustering = cellOf(cell)
    }
    // Representative = the real member vertex nearest the cluster's centroid.
    const sum = new Float64Array(clustering.count * 3)
    const members = new Int32Array(clustering.count)
    for (let i = 0; i < usedList.length; i++) {
      const id = clustering.ids[i], vertex = usedList[i]
      sum[3 * id] += position.getX(vertex)
      sum[3 * id + 1] += position.getY(vertex)
      sum[3 * id + 2] += position.getZ(vertex)
      members[id]++
    }
    const best = new Int32Array(clustering.count).fill(-1)
    const bestD = new Float64Array(clustering.count).fill(Infinity)
    for (let i = 0; i < usedList.length; i++) {
      const id = clustering.ids[i], vertex = usedList[i]
      const dx = position.getX(vertex) - sum[3 * id] / members[id]
      const dy = position.getY(vertex) - sum[3 * id + 1] / members[id]
      const dz = position.getZ(vertex) - sum[3 * id + 2] / members[id]
      const d = dx * dx + dy * dy + dz * dz
      if (d < bestD[id]) {
        bestD[id] = d
        best[id] = i
      }
    }
    rep = new Int32Array(usedList.length)
    for (let i = 0; i < usedList.length; i++) rep[i] = best[clustering.ids[i]]
  }

  // Dense rep ids -> compact vertex list; triangles over them without degenerates or duplicates.
  const compact = new Map()
  const vertices = []
  const triangles = []
  const seen = new Set()
  const nUsed = usedList.length
  for (const face of faces) {
    const ids = [0, 0, 0]
    for (let c = 0; c < 3; c++) ids[c] = rep[used.get(corner(face, c))]
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue
    const sorted = [...ids].sort((u, v) => u - v)
    const key = (sorted[0] * nUsed + sorted[1]) * nUsed + sorted[2]
    if (seen.has(key)) continue
    seen.add(key)
    for (let c = 0; c < 3; c++) {
      let local = compact.get(ids[c])
      if (local === undefined) {
        local = vertices.length
        compact.set(ids[c], local)
        vertices.push(usedList[ids[c]])
      }
      triangles.push(local)
    }
  }
  return { vertices: Int32Array.from(vertices), triangles }
}


// Can the triangle winding be trusted to say which side is "outside"?
//   +1  consistently wound with the volume outside (a normal body), -1 consistently wound inside out,
//    0  unknown: flat or open pieces, or mixed winding. Callers then work out the side some other way.
// Winding is consistent when the two triangles sharing an edge run along it in opposite directions;
// the sign comes from the signed volume the surface encloses, which needs to be clearly non-zero.
const WINDING_MIN_SHARED_EDGES = 8
const WINDING_CONSISTENT_FRACTION = 0.92
const WINDING_MIN_VOLUME_RATIO = 0.004 // signed volume / (surface area x size): a cylinder is ~0.03

export function windingOrientation(positions, indices) {
  const triangleCount = Math.floor(indices.length / 3)
  if (!triangleCount) return 0
  let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity
  let cx = 0, cy = 0, cz = 0
  const vertexCount = positions.length / 3
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2]
    if (x < lx) lx = x; if (x > hx) hx = x
    if (y < ly) ly = y; if (y > hy) hy = y
    if (z < lz) lz = z; if (z > hz) hz = z
    cx += x; cy += y; cz += z
  }
  cx /= vertexCount; cy /= vertexCount; cz /= vertexCount
  const size = Math.hypot(hx - lx, hy - ly, hz - lz)
  if (!(size > 0)) return 0

  // Vertices at the same place (seams) count as one, or a seam would look like an open edge.
  const quant = 1 / Math.max(size * 1e-5, 1e-9)
  const weldKey = new Map()
  const weld = new Int32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) {
    const key = Math.round(positions[3 * i] * quant) + ',' + Math.round(positions[3 * i + 1] * quant) + ',' + Math.round(positions[3 * i + 2] * quant)
    let id = weldKey.get(key)
    if (id === undefined) {
      id = weldKey.size
      weldKey.set(key, id)
    }
    weld[i] = id
  }

  let volume = 0
  let area = 0
  const edges = new Map() // low->high welded pair -> direction flags seen (1 = low->high, 2 = high->low)
  const seenTwice = []
  for (let t = 0; t < triangleCount; t++) {
    const ia = indices[3 * t], ib = indices[3 * t + 1], ic = indices[3 * t + 2]
    const ax = positions[3 * ia] - cx, ay = positions[3 * ia + 1] - cy, az = positions[3 * ia + 2] - cz
    const bx = positions[3 * ib] - cx, by = positions[3 * ib + 1] - cy, bz = positions[3 * ib + 2] - cz
    const ccx = positions[3 * ic] - cx, ccy = positions[3 * ic + 1] - cy, ccz = positions[3 * ic + 2] - cz
    volume += (ax * (by * ccz - bz * ccy) + ay * (bz * ccx - bx * ccz) + az * (bx * ccy - by * ccx)) / 6
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = ccx - ax, vy = ccy - ay, vz = ccz - az
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    const w = [weld[ia], weld[ib], weld[ic]]
    for (let e = 0; e < 3; e++) {
      const from = w[e], to = w[(e + 1) % 3]
      if (from === to) continue
      const low = from < to ? from : to, high = from < to ? to : from
      const key = low * vertexCount + high
      const flag = from < to ? 1 : 2
      const seen = edges.get(key)
      if (seen === undefined) edges.set(key, flag)
      else if (seen < 4) {
        edges.set(key, seen | flag | 4) // second triangle on this edge; flags 1|2 both set = opposite directions
        seenTwice.push(key)
      }
    }
  }
  let shared = 0
  let consistent = 0
  for (const key of seenTwice) {
    shared++
    if ((edges.get(key) & 3) === 3) consistent++
  }
  if (shared < WINDING_MIN_SHARED_EDGES || consistent / shared < WINDING_CONSISTENT_FRACTION) return 0
  if (!(area > 0) || Math.abs(volume) / (area * size) < WINDING_MIN_VOLUME_RATIO) return 0
  return volume > 0 ? 1 : -1
}

export class CollisionProxy {
  // meshes: the meshes to collide against. includeTriangle(mesh, face) is evaluated ONCE, here.
  constructor(meshes, { maxTriangles = 3000, includeTriangle = null, pad = 0.01 } = {}) {
    this.pad = pad
    this.collider = null
    this.sources = []
    this.lastFrame = -Infinity
    this.interval = 1
    this.lastCost = 0

    const prepared = []
    for (const mesh of meshes || []) {
      if (!mesh || !mesh.geometry?.getAttribute?.('position')) continue
      const faces = selectFaces(mesh, includeTriangle)
      if (faces.length) prepared.push({ mesh, faces })
    }
    if (!prepared.length) return
    const shares = shareBudget(prepared.map((item) => item.faces.length), maxTriangles)

    let vertexTotal = 0
    let triangleTotal = 0
    for (let i = 0; i < prepared.length; i++) {
      const { mesh, faces } = prepared[i]
      const { vertices, triangles } = decimate(mesh.geometry, faces, shares[i])
      if (!triangles.length) continue
      this.sources.push({ mesh, vertices, triangles, vertexStart: vertexTotal })
      vertexTotal += vertices.length
      triangleTotal += triangles.length / 3
    }
    if (!this.sources.length) return

    const positions = new Float32Array(vertexTotal * 3)
    const indices = new Uint32Array(triangleTotal * 3)
    let at = 0
    for (const source of this.sources) {
      for (let k = 0; k < source.triangles.length; k++) indices[at++] = source.vertexStart + source.triangles[k]
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setIndex(new THREE.BufferAttribute(indices, 1))
    this.positions = positions
    this.refreshPositions()
    this.collider = new BodyCollider(geometry, pad)
    // Fixed by the topology, so worked out once. 0 = do not trust the winding to mean "outside".
    this.collider.orientation = windingOrientation(positions, indices)
    geometry.dispose() // the collider keeps the arrays; the geometry object itself is not needed
  }

  get triangleCount() {
    return this.collider ? this.collider.T : 0
  }

  refreshPositions() {
    const out = this.positions
    for (const { mesh, vertices, vertexStart } of this.sources) {
      mesh.updateWorldMatrix(true, false)
      if (mesh.isSkinnedMesh) mesh.skeleton.update()
      const world = mesh.matrixWorld
      let o = 3 * vertexStart
      for (let k = 0; k < vertices.length; k++) {
        mesh.getVertexPosition(vertices[k], _p).applyMatrix4(world)
        out[o++] = _p.x
        out[o++] = _p.y
        out[o++] = _p.z
      }
    }
  }

  // Re-pose and refit now.
  refresh(pad = this.pad) {
    if (!this.collider) return
    this.pad = pad
    this.refreshPositions()
    this.collider.refit(pad)
  }

  // Call once per frame. Refreshes on the cost-adaptive schedule; `frame` is any increasing counter.
  update(frame, pad = this.pad) {
    if (!this.collider) return null
    if (frame - this.lastFrame >= this.interval) {
      const t0 = performance.now()
      this.refresh(pad)
      this.lastCost = performance.now() - t0
      this.lastFrame = frame
      this.interval = this.lastCost <= REFRESH_FAST_MS ? 1 : this.lastCost <= REFRESH_SLOW_MS ? 2 : 3
    }
    return this.collider
  }

  dispose() {
    this.collider = null
    this.sources = []
    this.positions = null
  }
}
