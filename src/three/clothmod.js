import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Cloth modifier
//
// An XPBD (position-based dynamics) cloth solver plus a body collider, wired
// up to work on a single selected mesh of the character — a cape, skirt,
// sash, whatever — rather than a whole separate garment file.
//
// This is a POSE-TIME drape, not a per-frame dynamic sim by default: enabling
// cloth on a mesh snapshots the character's CURRENT pose (every other visible
// mesh) as the collision body, and drapes against that fixed shape. Re-pose,
// then re-enable (or hit Redrape) to update the collider. "Bake to animation"
// (further down) is what turns this into real per-frame motion across a
// whole clip.
//
// "Vertex group" equivalent: there's no vertex-group import here (three.js/
// glTF don't carry Blender vertex groups), so pins start as the mesh's top
// band (like a cape's collar) and you refine them with an add/remove pin
// brush. Once a drape looks right, Bake writes the result into the mesh's
// own geometry and turns cloth off — after that it's just a normal static
// mesh again (posable, exportable, undo-able elsewhere).
// ---------------------------------------------------------------------------

const clamp01 = (x) => Math.max(0, Math.min(1, x))
function stretchComp(s) { return (1 - clamp01(s)) * 0.002 + 5e-8 }
function shearComp(s) { return (1 - clamp01(s)) * 0.02 + 1e-7 }
function bendComp(s) { const t = 1 - clamp01(s); return t * t * 0.25 + 2e-6 }

export const FABRIC_PRESETS = {
  cotton: { stretch: 0.95, bend: 0.32, mass: 0.3, friction: 0.55 },
  silk: { stretch: 0.97, bend: 0.12, mass: 0.16, friction: 0.35 },
  denim: { stretch: 0.99, bend: 0.7, mass: 0.6, friction: 0.65 },
  leather: { stretch: 0.99, bend: 0.85, mass: 0.85, friction: 0.7 },
  wool: { stretch: 0.94, bend: 0.45, mass: 0.45, friction: 0.6 },
}

// --- Solver: XPBD ClothSim + BodyCollider -----------------------------------
// (self-contained, no DOM dependencies)

class ClothSim {
  constructor(spec, opts = {}) {
    this.indices = spec.indices
    this.uv = spec.uv || null
    this.n = spec.count
    const N = this.n
    this.pos = new Float32Array(spec.positions)
    this.prev = new Float32Array(3 * N)
    this.vel = new Float32Array(3 * N)
    this.invMass = new Float32Array(N)
    this.pinned = new Uint8Array(N)
    this.pinPos = new Float32Array(spec.positions)
    this.home = new Float32Array(spec.positions)

    this._mass = opts.mass || 0.3
    for (let i = 0; i < N; i++) this.invMass[i] = 1 / this._mass
    if (spec.pinned) for (const i of spec.pinned) this.setPinned(i, true)

    this.ei = spec.ei
    this.ej = spec.ej
    this.rest = spec.rest
    this.egroup = spec.egroup
    this.lambda = new Float32Array(this.ei.length)

    this.collider = null
    this.params = {
      gravity: -9.8, damping: 1.2, friction: 0.55, thickness: 0.02,
      substeps: 12, wind: 0, comp: [stretchComp(0.95), shearComp(0.7), bendComp(0.35)],
      floor: null, cling: 0.3, clingBand: 0.06, slack: 0, shrinkwrap: false,
    }
    this._wind = new THREE.Vector3()
  }

  setStiffness({ stretch, shear, bend }) {
    if (stretch != null) this.params.comp[0] = stretchComp(stretch)
    if (shear != null) this.params.comp[1] = shearComp(shear)
    if (bend != null) this.params.comp[2] = bendComp(bend)
  }
  setMass(m) {
    this._mass = Math.max(0.02, m)
    const w = 1 / this._mass
    for (let i = 0; i < this.n; i++) if (!this.pinned[i]) this.invMass[i] = w
  }
  setParam(k, v) { this.params[k] = v }
  setCollider(c) { this.collider = c }

  setPinned(i, on) {
    this.pinned[i] = on ? 1 : 0
    this.invMass[i] = on ? 0 : 1 / (this._mass || 0.3)
    if (on) {
      this.pinPos[3 * i] = this.pos[3 * i]
      this.pinPos[3 * i + 1] = this.pos[3 * i + 1]
      this.pinPos[3 * i + 2] = this.pos[3 * i + 2]
    }
  }

  reset() {
    this.pos.set(this.home)
    this.prev.set(this.home)
    this.vel.fill(0)
    for (let i = 0; i < this.n; i++) if (this.pinned[i]) {
      this.pinPos[3 * i] = this.home[3 * i]
      this.pinPos[3 * i + 1] = this.home[3 * i + 1]
      this.pinPos[3 * i + 2] = this.home[3 * i + 2]
    }
  }

  step(dt) {
    dt = Math.min(dt, 1 / 30)
    const sub = Math.max(1, this.params.substeps | 0)
    const sdt = dt / sub
    for (let s = 0; s < sub; s++) this._substep(sdt)
  }

  _substep(sdt) {
    const { pos, prev, vel, invMass, pinned, n } = this
    const g = this.params.gravity, drag = Math.max(0, 1 - this.params.damping * sdt)
    _windClock.t += 0.0007
    this._wind.set(Math.sin(_windClock.t * 1.7) * 0.6, 0, Math.cos(_windClock.t * 1.3))
    const wind = this.params.wind, w = this._wind

    for (let i = 0; i < n; i++) {
      if (pinned[i]) { prev[3 * i] = pos[3 * i]; prev[3 * i + 1] = pos[3 * i + 1]; prev[3 * i + 2] = pos[3 * i + 2]; continue }
      const ix = 3 * i
      vel[ix + 1] += g * sdt
      if (wind) { vel[ix] += w.x * wind * sdt; vel[ix + 2] += w.z * wind * sdt }
      vel[ix] *= drag; vel[ix + 1] *= drag; vel[ix + 2] *= drag
      prev[ix] = pos[ix]; prev[ix + 1] = pos[ix + 1]; prev[ix + 2] = pos[ix + 2]
      pos[ix] += vel[ix] * sdt; pos[ix + 1] += vel[ix + 1] * sdt; pos[ix + 2] += vel[ix + 2] * sdt
    }

    this.lambda.fill(0)
    const { ei, ej, rest, egroup, lambda } = this
    const comp = this.params.comp, isdt2 = 1 / (sdt * sdt), slack = this.params.slack
    for (let k = 0; k < ei.length; k++) {
      const i = ei[k], j = ej[k]
      const wi = invMass[i], wj = invMass[j]
      const wsum = wi + wj; if (wsum === 0) continue
      const ix = 3 * i, jx = 3 * j
      let dx = pos[ix] - pos[jx], dy = pos[ix + 1] - pos[jx + 1], dz = pos[ix + 2] - pos[jx + 2]
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz); if (len < 1e-9) continue
      const grp = egroup[k]
      const r = slack && grp < 2 ? rest[k] * (1 - slack) : rest[k]
      const C = len - r
      const alpha = comp[grp] * isdt2
      const dl = -(C + alpha * lambda[k]) / (wsum + alpha)
      lambda[k] += dl
      const s = dl / len
      dx *= s; dy *= s; dz *= s
      pos[ix] += dx * wi; pos[ix + 1] += dy * wi; pos[ix + 2] += dz * wi
      pos[jx] -= dx * wj; pos[jx + 1] -= dy * wj; pos[jx + 2] -= dz * wj
    }

    for (let i = 0; i < n; i++) {
      if (pinned[i]) { pos[3 * i] = this.pinPos[3 * i]; pos[3 * i + 1] = this.pinPos[3 * i + 1]; pos[3 * i + 2] = this.pinPos[3 * i + 2]; continue }
      this._collide(i)
    }

    for (let i = 0; i < n; i++) {
      if (pinned[i]) { vel[3 * i] = vel[3 * i + 1] = vel[3 * i + 2] = 0; continue }
      const ix = 3 * i, inv = 1 / sdt
      vel[ix] = (pos[ix] - prev[ix]) * inv
      vel[ix + 1] = (pos[ix + 1] - prev[ix + 1]) * inv
      vel[ix + 2] = (pos[ix + 2] - prev[ix + 2]) * inv
    }
  }

  _collide(i) {
    const pos = this.pos, prev = this.prev, ix = 3 * i, th = this.params.thickness
    const f = this.params.friction
    if (this.params.floor != null && pos[ix + 1] < this.params.floor + th) {
      pos[ix + 1] = this.params.floor + th
      prev[ix] += (pos[ix] - prev[ix]) * f
      prev[ix + 2] += (pos[ix + 2] - prev[ix + 2]) * f
    }
    if (!this.collider) return
    const q = this.collider.query(pos[ix], pos[ix + 1], pos[ix + 2])
    if (!q) return
    const cling = this.params.cling

    if (this.params.shrinkwrap) {
      // nx/ny/nz above point from the surface toward wherever the particle
      // CURRENTLY is — so if it's already tunnelled through to the inside,
      // that "normal" points inward too, and the old logic below would just
      // snap it back against the inside of the body instead of pushing it
      // back out. fnx/fny/fnz is the triangle's true outward normal instead,
      // fixed by winding order, so it stays correct no matter which side the
      // particle ends up on. Signed distance along that fixed normal (rather
      // than the always-positive Euclidean q.dist) is what actually tells us
      // "outside" from "inside".
      const sd = (pos[ix] - q.x) * q.fnx + (pos[ix + 1] - q.y) * q.fny + (pos[ix + 2] - q.z) * q.fnz
      const outX = q.x + q.fnx * th, outY = q.y + q.fny * th, outZ = q.z + q.fnz * th
      if (sd < th) {
        pos[ix] = outX; pos[ix + 1] = outY; pos[ix + 2] = outZ
        this._friction(ix, { nx: q.fnx, ny: q.fny, nz: q.fnz }, f)
      } else if (cling > 0 && sd < th + this.params.clingBand) {
        pos[ix] += (outX - pos[ix]) * cling
        pos[ix + 1] += (outY - pos[ix + 1]) * cling
        pos[ix + 2] += (outZ - pos[ix + 2]) * cling
        this._friction(ix, { nx: q.fnx, ny: q.fny, nz: q.fnz }, f * 0.5)
      }
      return
    }

    const tx = q.x + q.nx * th, ty = q.y + q.ny * th, tz = q.z + q.nz * th
    if (q.dist < th) {
      pos[ix] = tx; pos[ix + 1] = ty; pos[ix + 2] = tz
      this._friction(ix, q, f)
    } else if (cling > 0 && q.dist < th + this.params.clingBand) {
      pos[ix] += (tx - pos[ix]) * cling
      pos[ix + 1] += (ty - pos[ix + 1]) * cling
      pos[ix + 2] += (tz - pos[ix + 2]) * cling
      this._friction(ix, q, f * 0.5)
    }
  }

  _friction(ix, hit, f) {
    const pos = this.pos, prev = this.prev
    const mx = pos[ix] - prev[ix], my = pos[ix + 1] - prev[ix + 1], mz = pos[ix + 2] - prev[ix + 2]
    const dn = mx * hit.nx + my * hit.ny + mz * hit.nz
    prev[ix] += (mx - dn * hit.nx) * f
    prev[ix + 1] += (my - dn * hit.ny) * f
    prev[ix + 2] += (mz - dn * hit.nz) * f
  }

  energy() {
    let e = 0; const v = this.vel
    for (let i = 0; i < this.n; i++) { if (this.pinned[i]) continue; e += v[3 * i] ** 2 + v[3 * i + 1] ** 2 + v[3 * i + 2] ** 2 }
    return e / Math.max(1, this.n)
  }
}

const _windClock = { t: 0 }
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3()
const _d = new THREE.Vector3(), _e = new THREE.Vector3()

class BodyCollider {
  constructor(geometry, pad = 0.02) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry
    this.tris = g.getAttribute('position').array
    this.T = this.tris.length / 9
    this.pad = pad

    // True per-triangle outward normal (from winding order), independent of
    // which side a query point currently sits on. Used by shrinkwrap so it
    // can tell "outside" from "inside" even after a particle has tunnelled
    // through the body, instead of just pointing away-from-closest-point
    // (which flips sign the moment a particle crosses to the wrong side).
    this.faceNormals = new Float32Array(this.T * 3)
    const t0 = this.tris
    for (let f = 0; f < this.T; f++) {
      const o = f * 9
      _a.set(t0[o], t0[o + 1], t0[o + 2])
      _b.set(t0[o + 3], t0[o + 4], t0[o + 5])
      _c.set(t0[o + 6], t0[o + 7], t0[o + 8])
      _d.subVectors(_b, _a)
      _e.subVectors(_c, _a)
      _d.cross(_e)
      const len = _d.length()
      if (len > 1e-9) _d.multiplyScalar(1 / len)
      this.faceNormals[f * 3] = _d.x
      this.faceNormals[f * 3 + 1] = _d.y
      this.faceNormals[f * 3 + 2] = _d.z
    }

    const bb = new THREE.Box3().setFromBufferAttribute(g.getAttribute('position'))
    this.min = bb.min.clone()
    const size = bb.getSize(new THREE.Vector3())
    const diag = size.length() || 1
    this.cell = Math.max(diag / 48, 1e-3)
    this.nx = Math.max(1, Math.ceil(size.x / this.cell) + 1)
    this.ny = Math.max(1, Math.ceil(size.y / this.cell) + 1)
    this.nz = Math.max(1, Math.ceil(size.z / this.cell) + 1)
    this.grid = new Map()

    const t = this.tris
    for (let f = 0; f < this.T; f++) {
      const o = f * 9
      let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity
      for (let v = 0; v < 3; v++) {
        const x = t[o + v * 3], y = t[o + v * 3 + 1], z = t[o + v * 3 + 2]
        if (x < lx) lx = x; if (y < ly) ly = y; if (z < lz) lz = z
        if (x > hx) hx = x; if (y > hy) hy = y; if (z > hz) hz = z
      }
      const ci0 = this._ci(lx - pad), ci1 = this._ci(hx + pad)
      const cj0 = this._cj(ly - pad), cj1 = this._cj(hy + pad)
      const ck0 = this._ck(lz - pad), ck1 = this._ck(hz + pad)
      for (let ci = ci0; ci <= ci1; ci++)
        for (let cj = cj0; cj <= cj1; cj++)
          for (let ck = ck0; ck <= ck1; ck++) {
            const key = ci + this.nx * (cj + this.ny * ck)
            let arr = this.grid.get(key); if (!arr) this.grid.set(key, arr = [])
            arr.push(f)
          }
    }
  }
  _ci(x) { return Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.min.x) / this.cell))) }
  _cj(y) { return Math.max(0, Math.min(this.ny - 1, Math.floor((y - this.min.y) / this.cell))) }
  _ck(z) { return Math.max(0, Math.min(this.nz - 1, Math.floor((z - this.min.z) / this.cell))) }

  query(px, py, pz) {
    const key = this._ci(px) + this.nx * (this._cj(py) + this.ny * this._ck(pz))
    const arr = this.grid.get(key); if (!arr) return null
    const t = this.tris
    let best = Infinity, bx = 0, by = 0, bz = 0, bestFace = -1
    _a.set(px, py, pz)
    for (let n = 0; n < arr.length; n++) {
      const f = arr[n]
      const o = f * 9
      _b.set(t[o], t[o + 1], t[o + 2])
      _c.set(t[o + 3], t[o + 4], t[o + 5])
      _d.set(t[o + 6], t[o + 7], t[o + 8])
      closestOnTri(_a, _b, _c, _d, _e)
      const dx = px - _e.x, dy = py - _e.y, dz = pz - _e.z
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 < best) { best = d2; bx = _e.x; by = _e.y; bz = _e.z; bestFace = f }
    }
    if (best === Infinity) return null
    const dist = Math.sqrt(best)
    let nx, ny, nz
    if (dist > 1e-6) { nx = (px - bx) / dist; ny = (py - by) / dist; nz = (pz - bz) / dist }
    else { nx = 0; ny = 1; nz = 0 }
    // True face normal, fixed regardless of which side the query point is
    // currently on — a tunnelled-through particle still gets the correct
    // "outside" direction here, unlike nx/ny/nz above.
    const fnx = this.faceNormals[bestFace * 3], fny = this.faceNormals[bestFace * 3 + 1], fnz = this.faceNormals[bestFace * 3 + 2]
    return { dist, x: bx, y: by, z: bz, nx, ny, nz, fnx, fny, fnz }
  }
}

function closestOnTri(p, a, b, c, out) {
  const ABx = b.x - a.x, ABy = b.y - a.y, ABz = b.z - a.z
  const ACx = c.x - a.x, ACy = c.y - a.y, ACz = c.z - a.z
  const APx = p.x - a.x, APy = p.y - a.y, APz = p.z - a.z
  const d1 = ABx * APx + ABy * APy + ABz * APz
  const d2 = ACx * APx + ACy * APy + ACz * APz
  if (d1 <= 0 && d2 <= 0) { out.set(a.x, a.y, a.z); return }
  const BPx = p.x - b.x, BPy = p.y - b.y, BPz = p.z - b.z
  const d3 = ABx * BPx + ABy * BPy + ABz * BPz
  const d4 = ACx * BPx + ACy * BPy + ACz * BPz
  if (d3 >= 0 && d4 <= d3) { out.set(b.x, b.y, b.z); return }
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out.set(a.x + ABx * v, a.y + ABy * v, a.z + ABz * v); return }
  const CPx = p.x - c.x, CPy = p.y - c.y, CPz = p.z - c.z
  const d5 = ABx * CPx + ABy * CPy + ABz * CPz
  const d6 = ACx * CPx + ACy * CPy + ACz * CPz
  if (d6 >= 0 && d5 <= d6) { out.set(c.x, c.y, c.z); return }
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); out.set(a.x + ACx * w, a.y + ACy * w, a.z + ACz * w); return }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
    out.set(b.x + (c.x - b.x) * w, b.y + (c.y - b.y) * w, b.z + (c.z - b.z) * w); return
  }
  const denom = 1 / (va + vb + vc)
  const v = vb * denom, w = vc * denom
  out.set(a.x + ABx * v + ACx * w, a.y + ABy * v + ACy * w, a.z + ABz * v + ACz * w)
}

// Turn an arbitrary (already world-space) mesh geometry into a cloth spec:
// weld coincident vertices into particles, one stretch constraint per unique
// edge, one bend constraint per interior edge (opposite vertices of its two
// triangles), and pin the top `pinTopFrac` band as a starting "vertex group".
// Returns `weldOf`: for each ORIGINAL vertex, which welded particle it became
// — used to map welded particle data back to every original vertex,
// including ones duplicated across a UV seam.
function buildSpecFromGeometry(geom, pinTopFrac) {
  const posAttr = geom.getAttribute('position')
  const uvAttr = geom.getAttribute('uv')
  const srcCount = posAttr.count

  geom.computeBoundingBox()
  const diag = geom.boundingBox.getSize(new THREE.Vector3()).length() || 1
  const q = 1 / Math.max(diag / 2000, 1e-6)

  const map = new Map()
  const weldOf = new Int32Array(srcCount)
  const weldRep = [] // weld index -> one original (pre-weld) vertex index, for skin-position lookups
  const P = [], UV = []
  for (let i = 0; i < srcCount; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i)
    const key = Math.round(x * q) + ',' + Math.round(y * q) + ',' + Math.round(z * q)
    let ni = map.get(key)
    if (ni === undefined) {
      ni = P.length / 3; map.set(key, ni)
      P.push(x, y, z)
      if (uvAttr) UV.push(uvAttr.getX(i), uvAttr.getY(i))
      weldRep.push(i)
    }
    weldOf[i] = ni
  }
  const count = P.length / 3
  const positions = Float32Array.from(P)
  if (count < 3) throw new Error('mesh has too few vertices to drape')

  const srcIndex = geom.index ? geom.index.array : null
  const triLen = srcIndex ? srcIndex.length : srcCount
  const gv = (t) => weldOf[srcIndex ? srcIndex[t] : t]
  const tri = []
  for (let t = 0; t + 2 < triLen; t += 3) {
    const a = gv(t), b = gv(t + 1), c = gv(t + 2)
    if (a !== b && b !== c && a !== c) tri.push(a, b, c)
  }
  if (!tri.length) throw new Error('mesh has no faces to drape')

  const ekey = (a, b) => (a < b ? a * count + b : b * count + a)
  const edges = new Map()
  const addEdge = (a, b, opp) => {
    const k = ekey(a, b)
    let e = edges.get(k)
    if (!e) edges.set(k, e = { i: a, j: b, opp: [] })
    e.opp.push(opp)
  }
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2]
    addEdge(a, b, c); addEdge(b, c, a); addEdge(c, a, b)
  }

  const ei = [], ej = [], rest = [], egroup = []
  const dist = (p, r) => {
    const dx = positions[3 * p] - positions[3 * r]
    const dy = positions[3 * p + 1] - positions[3 * r + 1]
    const dz = positions[3 * p + 2] - positions[3 * r + 2]
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
  for (const e of edges.values()) {
    ei.push(e.i); ej.push(e.j); rest.push(dist(e.i, e.j)); egroup.push(0)
    if (e.opp.length >= 2) {
      ei.push(e.opp[0]); ej.push(e.opp[1])
      rest.push(dist(e.opp[0], e.opp[1])); egroup.push(2)
    }
  }

  let minY = Infinity, maxY = -Infinity
  for (let i = 0; i < count; i++) { const y = positions[3 * i + 1]; if (y < minY) minY = y; if (y > maxY) maxY = y }
  const thresh = maxY - (maxY - minY) * clamp01(pinTopFrac)
  const pinned = new Set()
  if (pinTopFrac > 0) for (let i = 0; i < count; i++) if (positions[3 * i + 1] >= thresh) pinned.add(i)

  return {
    count, positions,
    uv: uvAttr ? Float32Array.from(UV) : null,
    indices: Uint32Array.from(tri), pinned,
    ei: Int32Array.from(ei), ej: Int32Array.from(ej),
    rest: Float32Array.from(rest), egroup: Uint8Array.from(egroup),
    weldOf, weldRep: Int32Array.from(weldRep),
  }
}

// --- Glue: selection, drape playback, pin brush, bake -----------------------

const cm = {
  scene: null, camera: null, renderer: null, controls: null, requestRender: null, setContinuousRender: null,
  entries: new Map(), // meshUuid -> { mesh, proxy, sim, spec, avgEdge, pinDots, otherMeshes, colliderAge }
  pinTool: 'add', // 'add' | 'del' | null
  brush: 3,
  playing: false,
  colliderTick: 0, // frame counter used to throttle collider rebuilds (see COLLIDER_REFRESH_EVERY)
  raycaster: new THREE.Raycaster(),
  pointerDown: false,
}

// Refreshing this every single frame costs a full collider rebuild (re-hashes
// every triangle into a spatial grid) per cloth mesh per frame. That was
// throttled down to every 3rd frame to save CPU, but the saving wasn't worth
// it: cloth interpenetrates the STALE collider for the in-between frames,
// then the sim snaps it out all at once the instant a fresh collider arrives
// — visibly a "sits still, then teleports" stutter in sync with the throttle
// interval. Refresh every frame instead so collision tracks the body
// smoothly; if this turns out too expensive on very high-poly bodies, prefer
// simplifying the collider mesh (fewer otherMeshes / a decimated proxy) over
// re-introducing this kind of temporal gap.
const COLLIDER_REFRESH_EVERY = 1

export function initClothMod(refs) {
  cm.scene = refs.scene
  cm.camera = refs.camera
  cm.renderer = refs.renderer
  cm.controls = refs.controls
  cm.requestRender = refs.requestRender
  cm.setContinuousRender = refs.setContinuousRender || null
  const dom = cm.renderer.domElement
  cm._onDown = onPointerDown
  cm._onMove = onPointerMove
  cm._onUp = onPointerUp
  dom.addEventListener('pointerdown', cm._onDown)
  dom.addEventListener('pointermove', cm._onMove)
  window.addEventListener('pointerup', cm._onUp)
}

export function disposeClothMod() {
  setClothPlaying(false)
  for (const uuid of [...cm.entries.keys()]) disableCloth(uuid, { restoreVisible: false })
  if (cm.renderer) {
    cm.renderer.domElement.removeEventListener('pointerdown', cm._onDown)
    cm.renderer.domElement.removeEventListener('pointermove', cm._onMove)
  }
  window.removeEventListener('pointerup', cm._onUp)
  cm.scene = null
}

export function isClothEnabled(uuid) { return cm.entries.has(uuid) }
export function getClothEntry(uuid) { return cm.entries.get(uuid) || null }

// Disable cloth on everything, without trying to restore visibility on meshes
// that are about to be disposed anyway (called when the character unloads).
export function clearAllCloth() {
  setClothPlaying(false)
  for (const uuid of [...cm.entries.keys()]) disableCloth(uuid, { restoreVisible: false })
}

// World-space copy of a mesh's geometry — POSED, not bind pose. Plain
// Mesh.getVertexPosition just returns the raw vertex; SkinnedMesh overrides it
// to include the current bone transform, so this works correctly either way.
// (Cloning geometry and doing `.applyMatrix4(mesh.matrixWorld)` looks similar
// but is wrong for a skinned mesh — it ignores the skeleton entirely and gives
// the bind pose, wherever that happens to be relative to the current pose.)
const _vpos = new THREE.Vector3()
function worldSpaceGeometry(mesh) {
  mesh.updateWorldMatrix(true, false)
  if (mesh.isSkinnedMesh) mesh.skeleton.update()
  const src = mesh.geometry
  const srcPos = src.getAttribute('position')
  const out = new Float32Array(srcPos.count * 3)
  for (let i = 0; i < srcPos.count; i++) {
    mesh.getVertexPosition(i, _vpos).applyMatrix4(mesh.matrixWorld)
    out[3 * i] = _vpos.x; out[3 * i + 1] = _vpos.y; out[3 * i + 2] = _vpos.z
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(out, 3))
  if (src.getAttribute('uv')) geom.setAttribute('uv', src.getAttribute('uv').clone())
  if (src.index) geom.setIndex(src.index.clone())
  return geom
}

// Merge the world-space geometry of a list of meshes into one BufferGeometry
// for use as a collider (the character's OTHER parts — not props).
function mergeWorldGeometry(meshes) {
  const geoms = []
  for (const mesh of meshes) {
    if (!mesh || !mesh.geometry) continue
    const g = worldSpaceGeometry(mesh)
    const nonIndexed = g.index ? g.toNonIndexed() : g
    // Only position is needed for collision.
    const stripped = new THREE.BufferGeometry()
    stripped.setAttribute('position', nonIndexed.getAttribute('position'))
    geoms.push(stripped)
  }
  if (!geoms.length) return null
  if (geoms.length === 1) return geoms[0]
  const merged = new THREE.BufferGeometry()
  let total = 0
  for (const g of geoms) total += g.getAttribute('position').count
  const pos = new Float32Array(total * 3)
  let o = 0
  for (const g of geoms) { pos.set(g.getAttribute('position').array, o); o += g.getAttribute('position').array.length }
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  return merged
}

function meanStructuralEdge(spec) {
  let sum = 0, cnt = 0
  for (let k = 0; k < spec.egroup.length; k++) if (spec.egroup[k] === 0) { sum += spec.rest[k]; cnt++ }
  return cnt ? sum / cnt : 0.05
}

// Collider push-out margin, scaled off the garment's own average edge length
// instead of one fixed absolute number — a fixed margin only looks right at
// the particular character scale it was tuned against; on a different-scale
// asset it can be too tight (thin cloth clips through) or too loose (cloth
// visibly floats off the body).
function collisionMargin(avgEdge) {
  return Math.max(0.01, avgEdge * 0.35)
}

// Enable cloth on `mesh`, colliding against `otherMeshes` (typically every
// other visible mesh of the same character, snapshotted at the current pose).
export function enableCloth(mesh, otherMeshes, { pinTop = 0.12, preset = 'cotton', shrinkwrap = false } = {}) {
  if (!mesh || cm.entries.has(mesh.uuid)) return false
  const worldGeom = worldSpaceGeometry(mesh)
  let spec
  try {
    spec = buildSpecFromGeometry(worldGeom, pinTop)
  } catch (e) {
    worldGeom.dispose()
    console.warn('Cloth: could not enable on this mesh —', e.message)
    return false
  }
  worldGeom.dispose()

  const p = FABRIC_PRESETS[preset] || FABRIC_PRESETS.cotton
  const sim = new ClothSim(spec, { mass: p.mass })
  sim.setStiffness({ stretch: p.stretch, shear: 0.6, bend: p.bend })
  sim.setParam('friction', p.friction)

  // Shrinkwrap: hugs the collider tight and over a much wider band than
  // normal cling, using the collider's fixed per-triangle outward normal
  // (not the point-to-particle direction) so it forces the cloth to stay
  // OUTSIDE the body even if a fast-moving vertex has tunnelled through —
  // a soft physical analog of Blender's Shrinkwrap modifier, good for
  // skin-tight garments (t-shirts, gloves) rather than free-hanging cloth.
  if (shrinkwrap) {
    sim.setParam('shrinkwrap', true)
    sim.setParam('cling', 0.9)
    sim.setParam('clingBand', 0.15)
  }

  const avgEdge = meanStructuralEdge(spec)
  // A fixed 0.015-unit margin assumes a particular character scale. On a
  // bigger/smaller asset it can be too tight, letting thin cloth (a t-shirt)
  // clip through the body and leaving looser garments (shorts) resting
  // inside it instead of just outside — scale it off the garment's own
  // average edge length instead so it's proportional to this mesh.
  const margin = collisionMargin(avgEdge)
  const colliderGeom = mergeWorldGeometry(otherMeshes)
  if (colliderGeom) sim.setCollider(new BodyCollider(colliderGeom, margin))

  const proxyGeom = new THREE.BufferGeometry()
  proxyGeom.setAttribute('position', new THREE.BufferAttribute(sim.pos, 3))
  if (spec.uv) proxyGeom.setAttribute('uv', new THREE.BufferAttribute(spec.uv, 2))
  proxyGeom.setIndex(new THREE.BufferAttribute(spec.indices, 1))
  proxyGeom.computeVertexNormals()

  const srcMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  const proxyMat = srcMat.clone() // don't share one material instance between the hidden skinned mesh and this plain one
  // Cloth is a thin open sheet, not closed body geometry — it constantly
  // flips to show its "back" as it drapes and folds. A single-sided material
  // culls that side entirely, and the anime-outline effect always draws a
  // solid black backface shell regardless of the material's own side setting
  // — so wherever you were looking at the back of the sheet, that black
  // shell was the only thing left visible. Force double-sided so the real
  // material actually renders there too.
  proxyMat.side = THREE.DoubleSide
  // The proxy geometry carries no per-vertex color data, but the cloned
  // material may have vertexColors=true (materials.js copies that flag onto
  // every toon/unlit variant it generates). An enabled-but-unbound `color`
  // attribute reads as (0,0,0) in the shader and multiplies the whole
  // surface to black — which is exactly what was happening. The proxy has
  // nothing to contribute there, so switch it off.
  proxyMat.vertexColors = false
  proxyMat.needsUpdate = true

  // Mark cloth material so style system can update it
  proxyMat.userData.isCloth = true

  // Copy shader variant (toon/unlit/etc.)
  if (srcMat.userData?.variant) {
    proxyMat.userData.variant = srcMat.userData.variant
  }

  // Ensure cloth participates in outline effect
  proxyMat.userData.outlineParameters = {
    thickness: srcMat.userData?.outlineParameters?.thickness ?? 0.003,
    color: [0, 0, 0],
    alpha: 1,
    visible: true,
    keepAlive: false,
  }

  const proxy = new THREE.Mesh(proxyGeom, proxyMat)
  proxy.frustumCulled = false
  proxy.name = (mesh.name || 'mesh') + ' (cloth preview)'
  cm.scene.add(proxy)
  mesh.visible = false

  const pinDots = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ color: 0xffd23f, size: 0.015, sizeAttenuation: true, depthTest: false }),
  )
  pinDots.visible = cm.pinTool != null // 'off' tool starts hidden, not just non-interactive
  cm.scene.add(pinDots)

  cm.entries.set(mesh.uuid, { mesh, proxy, sim, spec, avgEdge, pinDots, otherMeshes, preset, pinTop, shrinkwrap })
  refreshPinMarkers(cm.entries.get(mesh.uuid))
  cm.requestRender()
  return true
}

export function disableCloth(uuid, { restoreVisible = true } = {}) {
  const entry = cm.entries.get(uuid)
  if (!entry) return
  cm.scene.remove(entry.proxy)
  entry.proxy.geometry.dispose()
  entry.proxy.material.dispose()
  cm.scene.remove(entry.pinDots)
  entry.pinDots.geometry.dispose()
  entry.pinDots.material.dispose()
  if (restoreVisible) entry.mesh.visible = true
  cm.entries.delete(uuid)
  cm.requestRender()
}

// Reset an entry's cloth simulation back to its bind/rest pose.
export function resetCloth(uuid) {
  const entry = cm.entries.get(uuid)
  if (!entry) return
  entry.sim.reset()
  syncProxy(entry)
  refreshPinMarkers(entry)
  cm.requestRender()
}

export function setFabricParams(uuid, { stretch, bend, mass, friction, gravity, wind } = {}) {
  const entry = cm.entries.get(uuid)
  if (!entry) return
  if (stretch != null || bend != null) entry.sim.setStiffness({ stretch, shear: 0.6, bend })
  if (mass != null) entry.sim.setMass(mass)
  if (friction != null) entry.sim.setParam('friction', friction)
  if (gravity != null) entry.sim.setParam('gravity', -gravity)
  if (wind != null) entry.sim.setParam('wind', wind)
}

export function applyFabricPreset(uuid, presetName) {
  const p = FABRIC_PRESETS[presetName]
  if (p) setFabricParams(uuid, p)
}

// Toggle shrinkwrap live on an already-draped mesh — dials the same
// shrinkwrap/cling/clingBand params enableCloth sets at creation time, and
// remembers the flag on the entry so it survives refreshClothForStyleChange
// rebuilds.
export function setClothShrinkwrap(uuid, on) {
  const entry = cm.entries.get(uuid)
  if (!entry) return
  entry.shrinkwrap = on
  entry.sim.setParam('shrinkwrap', on)
  entry.sim.setParam('cling', on ? 0.9 : 0.3)
  entry.sim.setParam('clingBand', on ? 0.15 : 0.06)
  cm.requestRender()
}
export function isClothShrinkwrap(uuid) {
  const entry = cm.entries.get(uuid)
  return entry ? !!entry.shrinkwrap : false
}

// --- Drape playback ----------------------------------------------------------

// Pinned particles used to be frozen at whatever world-space point they were
// at the moment you pinned them — so a collar or waistband stayed hanging in
// mid-air the instant the character moved or the pose changed, since nothing
// ever told a pin where the body underneath it went. `mesh.getVertexPosition`
// already applies the mesh's own skin weights ("auto weights") for a given
// vertex under the current pose for a SkinnedMesh — and for a plain rigid
// Mesh (this app's own "make your own" keyframed parts, which move the whole
// mesh transform rather than skinning it) it just returns the raw local
// vertex, which `applyMatrix4(mesh.matrixWorld)` then carries along with
// whatever rigid transform that part currently has. Either way this reuses
// the SAME mechanism worldSpaceGeometry() already relies on, so it works for
// both an imported/mocap clip (skinned) and this app's own rigid-part clip
// (not skinned) — it was previously gated to skinned meshes only, which
// silently did nothing at all for rigid parts.
const _skinTmp = new THREE.Vector3()
function updatePinsFromSkin(entry) {
  const { mesh, sim, spec } = entry
  if (!spec.weldRep) return
  if (mesh.isSkinnedMesh) mesh.skeleton.update() // make sure skin deformation reflects the CURRENT pose
  mesh.updateMatrixWorld()
  const pinPos = sim.pinPos
  for (let i = 0; i < sim.n; i++) {
    if (!sim.pinned[i]) continue
    const srcVert = spec.weldRep[i]
    mesh.getVertexPosition(srcVert, _skinTmp).applyMatrix4(mesh.matrixWorld)
    pinPos[3 * i] = _skinTmp.x
    pinPos[3 * i + 1] = _skinTmp.y
    pinPos[3 * i + 2] = _skinTmp.z
  }
}

// Cloth that's ENABLED but not actively draping (Drape/cm.playing is off)
// was previously a completely frozen snapshot — the proxy is only ever
// touched by stepClothLive or by turning Drape on, so with neither running,
// NOTHING moved the proxy at all — not the character's animation, not a
// manual gizmo drag on the underlying mesh. This is a cheap, physics-free
// kinematic follow: every particle just directly mirrors the underlying
// mesh's CURRENT vertex position under its current pose/transform (same
// getVertexPosition + matrixWorld trick as updatePinsFromSkin, just applied
// to every particle instead of only pinned ones) — so idle cloth always
// visually tracks the body, exactly like any other rigid part would, right
// up until you hit Drape and it takes over with real simulation.
export function followIdleClothPose() {
  if (!cm.entries.size) return
  for (const entry of cm.entries.values()) {
    if (cm.playing) continue // Drape already drives the proxy itself
    const { mesh, sim, spec, proxy } = entry
    if (!spec.weldRep) continue
    if (mesh.isSkinnedMesh) mesh.skeleton.update()
    mesh.updateMatrixWorld()
    const pos = sim.pos, prev = sim.prev, vel = sim.vel
    for (let i = 0; i < sim.n; i++) {
      const srcVert = spec.weldRep[i]
      mesh.getVertexPosition(srcVert, _skinTmp).applyMatrix4(mesh.matrixWorld)
      const ix = 3 * i
      pos[ix] = prev[ix] = _skinTmp.x
      pos[ix + 1] = prev[ix + 1] = _skinTmp.y
      pos[ix + 2] = prev[ix + 2] = _skinTmp.z
      vel[ix] = vel[ix + 1] = vel[ix + 2] = 0 // no residual velocity when Drape actually starts
    }
    proxy.geometry.attributes.position.needsUpdate = true
    proxy.geometry.computeVertexNormals()
  }
}


// frozen at enable-time, without re-hashing the collider grid every frame.
function refreshLiveCollider(entry) {
  if (!entry.otherMeshes || !entry.otherMeshes.length) return
  const colliderGeom = mergeWorldGeometry(entry.otherMeshes)
  if (colliderGeom) entry.sim.setCollider(new BodyCollider(colliderGeom, collisionMargin(entry.avgEdge)))
}

// Turn live cloth simulation on/off. Stepping itself happens once per frame
// from the scene's shared render tick (stepClothLive below) rather than a
// separate requestAnimationFrame loop — one clock driving both animation and
// cloth keeps them in lockstep and means cloth can't keep looping after the
// viewport itself has stopped rendering.
export function setClothPlaying(on) {
  if (on === cm.playing) return
  cm.playing = on
  if (cm.setContinuousRender) cm.setContinuousRender(on)
  if (on) cm.colliderTick = 0
  else cm.requestRender()
}
export function isClothPlaying() { return cm.playing }

// Called every frame from the scene tick while cm.playing is true. Steps
// every LIVE (non-baked) cloth entry against its current collider, and
// refreshes that collider on a throttle so a running animation is followed
// without rebuilding the collision grid on every single frame.
export function stepClothLive(dt) {
  if (!cm.playing || !cm.entries.size) return
  const refreshCollider = cm.colliderTick % COLLIDER_REFRESH_EVERY === 0
  cm.colliderTick++
  const clampedDt = Math.min(dt || 1 / 60, 1 / 30)
  for (const entry of cm.entries.values()) {
    if (refreshCollider) refreshLiveCollider(entry)
    updatePinsFromSkin(entry)
    entry.sim.step(clampedDt)
    syncProxy(entry)
  }
  cm.requestRender()
}

export function stepClothOnce(substeps = 4) {
  for (const entry of cm.entries.values()) { refreshLiveCollider(entry); updatePinsFromSkin(entry) }
  for (let s = 0; s < substeps; s++) for (const entry of cm.entries.values()) entry.sim.step(1 / 60)
  for (const entry of cm.entries.values()) syncProxy(entry)
  cm.requestRender()
}

export function clothEnergy(uuid) {
  const entry = cm.entries.get(uuid)
  return entry ? entry.sim.energy() : 0
}

function syncProxy(entry) {
  entry.proxy.geometry.attributes.position.needsUpdate = true
  entry.proxy.geometry.computeVertexNormals()
  entry.proxy.geometry.computeBoundingSphere()

  // Recompute normals every frame so lighting reacts properly
  entry.proxy.geometry.computeVertexNormals()
  if (entry.proxy.geometry.attributes.normal) {
    entry.proxy.geometry.attributes.normal.needsUpdate = true
  }
}

// Cloth proxies are plain meshes living directly in the top-level scene
// (cm.scene), not under the loaded model's own root — enableCloth() hides
// the real SkinnedMesh and adds this proxy as a sibling of the whole
// character, not a child of it. That means a style/lighting change run
// through applyMaterials() (which only walks model.meshes) never touches
// draped proxies. Simplest fix: just disable and re-enable cloth for every
// active entry — enableCloth() clones the mesh's freshly-restyled material
// fresh each time, so the new proxy is automatically in sync. Rebuilding the
// spec from the same mesh geometry welds vertices in the same order every
// time, so particle indices line up between the old and new sim — pinned
// indices (including any set by the pin brush, not just the pinTop default)
// are captured before disabling and re-applied after, so a style change
// doesn't undo the user's pinning work. The drape itself still resets to
// bind-pose, which is an acceptable trade for "style changed".
export function refreshClothForStyleChange() {
  for (const [uuid, entry] of Array.from(cm.entries)) {
    const { mesh, otherMeshes, preset, pinTop, shrinkwrap } = entry
    const pinnedIndices = []
    for (let i = 0; i < entry.sim.n; i++) if (entry.sim.pinned[i]) pinnedIndices.push(i)

    disableCloth(uuid, { restoreVisible: false })
    enableCloth(mesh, otherMeshes, { preset, pinTop, shrinkwrap })

    const newEntry = cm.entries.get(uuid)
    if (!newEntry) continue
    for (const i of pinnedIndices) if (i < newEntry.sim.n) newEntry.sim.setPinned(i, true)
    refreshPinMarkers(newEntry)
  }
}

export function setPinTool(tool) {
  cm.pinTool = tool // 'add' | 'del' — brush-editing the vertex group. null while not editing.
  for (const entry of cm.entries.values()) if (!entry.groupSaved) entry.pinDots.visible = tool != null
  cm.requestRender()
}

// Locks in the current pin selection as the mesh's "vertex group" and hides
// the marker overlay for good — replaces the old add/del/OFF three-way
// toggle, where "off" only stopped further clicks but left the dots on
// screen forever. Also snaps pin tracking on immediately (instead of waiting
// for the next play/step) so the result is visible right away.
export function saveVertexGroup(uuid) {
  const entry = cm.entries.get(uuid)
  if (!entry) return
  entry.groupSaved = true
  entry.pinDots.visible = false
  cm.pinTool = null
  updatePinsFromSkin(entry)
  syncProxy(entry)
  cm.requestRender()
}
export function setBrushSize(n) { cm.brush = n }

export function clearPins(uuid) {
  const entry = cm.entries.get(uuid)
  if (!entry) return
  for (let i = 0; i < entry.sim.n; i++) if (entry.sim.pinned[i]) entry.sim.setPinned(i, false)
  refreshPinMarkers(entry)
  cm.requestRender()
}

function refreshPinMarkers(entry) {
  const pts = []
  for (let i = 0; i < entry.sim.n; i++) if (entry.sim.pinned[i]) pts.push(entry.sim.pos[3 * i], entry.sim.pos[3 * i + 1], entry.sim.pos[3 * i + 2])
  entry.pinDots.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3))
  entry.pinDots.geometry.computeBoundingSphere()
  entry.pinDots.material.size = Math.max(0.008, entry.avgEdge * 0.9)
}

function onPointerDown(e) {
  if (cm.pinTool == null || !cm.entries.size) return
  const hit = pick(e)
  if (hit) { cm.pointerDown = true; cm.controls.enabled = false; paint(hit) }
}
function onPointerMove(e) {
  if (!cm.pointerDown) return
  const hit = pick(e)
  if (hit) paint(hit)
}
function onPointerUp() {
  if (cm.pointerDown) { cm.pointerDown = false; cm.controls.enabled = true }
}

function pick(e) {
  const rect = cm.renderer.domElement.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  )
  cm.raycaster.setFromCamera(ndc, cm.camera)
  const entries = [...cm.entries.values()]
  const hits = cm.raycaster.intersectObjects(entries.map((en) => en.proxy), false)
  if (!hits.length) return null
  const entry = entries.find((en) => en.proxy === hits[0].object)
  return { entry, point: hits[0].point }
}

function paint({ entry, point }) {
  const sim = entry.sim
  const on = cm.pinTool === 'add'
  const radius = cm.brush * entry.avgEdge
  for (let i = 0; i < sim.n; i++) {
    const dx = sim.pos[3 * i] - point.x, dy = sim.pos[3 * i + 1] - point.y, dz = sim.pos[3 * i + 2] - point.z
    if (dx * dx + dy * dy + dz * dz <= radius * radius) sim.setPinned(i, on)
  }
  refreshPinMarkers(entry)
  cm.requestRender()
}