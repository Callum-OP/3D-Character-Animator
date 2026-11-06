import * as THREE from 'three'
import { BodyCollider, mergeWorldGeometry } from './clothmod.js'

// ---------------------------------------------------------------------------
// Soft cloth and Swing: a cheap alternative to the full cloth simulation
//
// The full cloth modifier (clothmod.js) drapes a mesh against the body with a real solver.
// That is the right tool for a cape or a skirt, but it is heavy, and it is far more than a
// jacket needs. A jacket, a hoodie's hood or a loose sleeve only has to move a LITTLE
// differently from the body, so it does not look glued to it. This module does that with no
// simulation of the cloth itself: each vertex of the chosen area follows where the animation
// (the skinned pose) puts it, but on a spring, so it lags, overshoots and settles, like the
// dangle effect for bones but for the vertices of a mesh. Two flavours:
//
//   SOFT   fabric. Every vertex of the area is a spring that follows its skinned position.
//          How far it is allowed to move grows with its distance from the parts that are
//          locked (a collar, a waistband, the edge of the area), and neighbouring vertices
//          are smoothed together, so a sleeve, a hem or a hood sways as one piece of cloth.
//   SWING  a separate piece that hangs and swings: a zip pull, a fastener, a charm, a
//          tassel. The piece is a pendulum hung from the place it attaches (or its top). The
//          hinge's own acceleration is fed in as an inertial force, so when the body speeds up,
//          stops or turns the piece lags and then swings. A piece joined to the mesh bends out
//          of its surface near the join (no stretching); a loose one swings as one rigid body.
//
// An effect applies to a ZONE: the whole part, or an area picked on it (a region, or faces
// picked in the viewport). A part can have several zones, each Soft or Swing, so a hoodie can
// have a bouncy hood, loose sleeves and a swinging zip pull.
//
// How it is drawn: nothing is simulated by the GPU and no copy of the mesh is made. The part
// keeps its own skinning; the only change is that the vertices in a zone get a small extra
// displacement baked into the position buffer BEFORE skinning, worked out so that after
// skinning they end up exactly where the spring wants them. Cost is one small loop over the
// vertices of the zones per frame.
//
// The offsets are only applied while the animation is playing (and cleared the moment it
// stops or you scrub), so a posed or scrubbed frame is always the clean pose.
// ---------------------------------------------------------------------------

export const SOFT_MODES = { soft: 'Soft cloth', swing: 'Swing' }

const GRAVITY_MS2 = 9.8
const MAX_DT = 1 / 30
const SUBSTEP = 1 / 120
const AFFECT_MIN = 0.004 // a vertex weight below this counts as locked

export const SOFT_PRESETS = {
  soft: [
    { id: 'jacket', label: 'Jacket / hoodie', hint: 'The body of a loose top: a gentle, slow sway', values: { stiffness: 0.4, damping: 0.4, gravity: 0.2, range: 0.09, smoothing: 0.65, blend: 0.45, lockTop: 0.25, bounce: 1, amount: 1 } },
    { id: 'sleeves', label: 'Loose sleeves', hint: 'Sleeves lag behind the arms and swing a little', values: { stiffness: 0.35, damping: 0.45, gravity: 0.3, range: 0.1, smoothing: 0.65, blend: 0.55, lockTop: 0.15, bounce: 1, amount: 1 } },
    { id: 'hood', label: 'Hood', hint: 'A hood bobbing on the back: loose and bouncy', values: { stiffness: 0.18, damping: 0.12, gravity: 0.45, range: 0.22, smoothing: 0.5, blend: 0.45, lockTop: 0.2, bounce: 1.7, amount: 1 } },
    { id: 'hem', label: 'Skirt / coat tails', hint: 'Free-hanging cloth below a locked top', values: { stiffness: 0.25, damping: 0.35, gravity: 0.6, range: 0.18, smoothing: 0.55, blend: 0.7, lockTop: 0.3, bounce: 1.2, amount: 1 } },
    { id: 'tight', label: 'Tight fabric', hint: 'Barely moves, just enough to break the rigid look', values: { stiffness: 0.7, damping: 0.7, gravity: 0.1, range: 0.025, smoothing: 0.8, blend: 0.35, lockTop: 0.2, bounce: 1, amount: 1 } },
  ],
  swing: [
    { id: 'zip', label: 'Zip pull', hint: 'A small pull tab hanging from the zip', values: { stiffness: 0.2, damping: 0.3, gravity: 0.9, swingLimit: 75, blend: 0.15, holdTop: 0.12, hangs: false, amount: 1 } },
    { id: 'drawstring', label: 'Drawstring', hint: 'A hood or waist string: its top stays fixed to the garment, the rest swings below', values: { stiffness: 0.14, damping: 0.22, gravity: 1, swingLimit: 80, blend: 0.12, holdTop: 0.15, reaction: 1, hangs: true, amount: 1 } },
    { id: 'fastener', label: 'Fastener / charm', hint: 'A button, buckle or charm that bounces', values: { stiffness: 0.3, damping: 0.4, gravity: 0.7, swingLimit: 55, blend: 0.15, holdTop: 0.1, hangs: false, amount: 1 } },
    { id: 'tassel', label: 'Tassel / drawstring end', hint: 'A loose end that swings freely', values: { stiffness: 0.1, damping: 0.18, gravity: 1, swingLimit: 90, blend: 0.08, holdTop: 0.12, hangs: false, amount: 1 } },
    { id: 'plate', label: 'Loose plate', hint: 'A stiff piece (armour, a badge) that rattles a little', values: { stiffness: 0.55, damping: 0.5, gravity: 0.4, swingLimit: 25, blend: 0.15, holdTop: 0.1, hangs: false, amount: 1 } },
  ],
}

const SOFT_DEFAULTS = SOFT_PRESETS.soft[0].values
const SWING_DEFAULTS = SOFT_PRESETS.swing[0].values

export function newZoneId() {
  return `z${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

// A new zone. area: { kind: 'all' } or { kind: 'tris', tris: [[first, last], ...], vertexCount }
export function makeSoftZone(mode, area, presetId = null) {
  const list = SOFT_PRESETS[mode] || SOFT_PRESETS.soft
  const preset = list.find((p) => p.id === presetId) || list[0]
  const base = mode === 'swing' ? SWING_DEFAULTS : SOFT_DEFAULTS
  const zone = {
    id: newZoneId(),
    name: area && area.kind === 'tris' ? `${SOFT_MODES[mode]} area` : `${SOFT_MODES[mode]}`,
    mode: mode === 'swing' ? 'swing' : 'soft',
    enabled: true,
    area: area || { kind: 'all' },
    preset: preset.id,
    ...base,
    ...preset.values,
  }
  // locking the top band only makes sense for fabric on the whole part
  if (zone.mode === 'swing') zone.lockTop = 0
  else if (zone.area.kind === 'tris') zone.lockTop = 0
  if (zone.area.kind === 'tris') {
    zone.blendOutside = true
    zone.outsideMode = 'connected'
    zone.outsideRange = 0.35
    zone.outsideStrength = 0.18
  }
  return zone
}

// The parts of a zone that decide HOW it is built (rebuilt when they change); every other
// number is read live, so a slider never resets the motion.
export function zoneStructure(zone) {
  const outsideBlend = zone.area?.kind === 'tris' && zone.blendOutside !== false
  return JSON.stringify([
    zone.mode,
    zone.area,
    zone.lockTop || 0,
    zone.blend,
    outsideBlend,
    outsideBlend ? (zone.outsideMode === 'all' ? 'all' : 'connected') : null,
    outsideBlend ? zone.outsideRange ?? 0.35 : null,
    outsideBlend ? zone.outsideStrength ?? 0.18 : null,
    zone.mode === 'swing' ? !!zone.hangs : null,
    zone.attachRange ?? null,
  ])
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

const sc = {
  requestRender: () => {},
  entries: new Map(), // mesh -> entry
  meshes: [],
  colliderCache: new Map(),
  frame: 0,
  couplings: [],
  suspended: false,
  overlays: new Map(), // mesh -> overlay
  dirty: false, // some entry currently has offsets written into its geometry
}

export function initSoftCloth(refs = {}) {
  sc.requestRender = refs.requestRender || (() => {})
}

export function disposeSoftCloth() {
  for (const mesh of [...sc.entries.keys()]) disposeEntry(mesh)
  sc.couplings = []
  sc.meshes = []
  sc.colliderCache.clear()
  for (const mesh of [...sc.overlays.keys()]) setSoftOverlay(mesh, null)
}

export function hasSoftCloth() {
  return sc.entries.size > 0
}

export function isSoftClothMesh(mesh) {
  return sc.entries.has(mesh)
}

export function getSoftEntry(mesh) {
  return sc.entries.get(mesh) || null
}

const clamp01 = (x) => Math.max(0, Math.min(1, x))
const smooth01 = (x) => {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

// --- geometry helpers ----------------------------------------------------------------

function readPositions(attr) {
  const out = new Float32Array(attr.count * 3)
  if (attr.isBufferAttribute && attr.itemSize === 3 && attr.array instanceof Float32Array && !attr.normalized) {
    out.set(attr.array.subarray(0, attr.count * 3))
    return out
  }
  for (let i = 0; i < attr.count; i++) {
    out[3 * i] = attr.getX(i)
    out[3 * i + 1] = attr.getY(i)
    out[3 * i + 2] = attr.getZ(i)
  }
  return out
}

// A private copy of the geometry that SHARES every buffer except `position`, so a zone can write
// its offsets without touching other parts that use the same geometry.
function swapInPrivateGeometry(mesh, rest) {
  const orig = mesh.geometry
  const g = new THREE.BufferGeometry()
  for (const name of Object.keys(orig.attributes)) g.setAttribute(name, orig.attributes[name])
  g.morphAttributes = orig.morphAttributes
  g.morphTargetsRelative = orig.morphTargetsRelative
  if (orig.index) g.setIndex(orig.index)
  g.groups = orig.groups.map((grp) => ({ ...grp }))
  g.drawRange = { ...orig.drawRange }
  g.userData = orig.userData
  if (orig.boundingSphere) g.boundingSphere = orig.boundingSphere.clone()
  if (orig.boundingBox) g.boundingBox = orig.boundingBox.clone()
  const own = new THREE.BufferAttribute(new Float32Array(rest), 3)
  own.setUsage(THREE.DynamicDrawUsage)
  g.setAttribute('position', own)
  mesh.geometry = g
  return { orig, geo: g, attr: own }
}

function topAncestor(obj) {
  let node = obj
  while (node.parent && !node.parent.isScene) node = node.parent
  return node
}

// Vertices at the same place (split along a UV seam, say) move as ONE site so a seam never tears.
function buildSites(rest, nVerts) {
  const siteOf = new Int32Array(nVerts)
  const key = new Map()
  const reps = []
  for (let v = 0; v < nVerts; v++) {
    const k = `${Math.round(rest[3 * v] * 1e4)},${Math.round(rest[3 * v + 1] * 1e4)},${Math.round(rest[3 * v + 2] * 1e4)}`
    let s = key.get(k)
    if (s === undefined) {
      s = reps.length
      key.set(k, s)
      reps.push(v)
    }
    siteOf[v] = s
  }
  return { siteOf, rep: Int32Array.from(reps), count: reps.length }
}

// Edges between sites, as a compact neighbour list.
function buildSiteGraph(index, nVerts, siteOf, nSites) {
  const triCount = Math.floor((index ? index.count : nVerts) / 3)
  const seen = new Set()
  const a = []
  const b = []
  const addEdge = (s0, s1) => {
    if (s0 === s1) return
    const lo = Math.min(s0, s1)
    const hi = Math.max(s0, s1)
    const k = lo * nSites + hi
    if (seen.has(k)) return
    seen.add(k)
    a.push(lo)
    b.push(hi)
  }
  for (let t = 0; t < triCount; t++) {
    const v0 = index ? index.getX(3 * t) : 3 * t
    const v1 = index ? index.getX(3 * t + 1) : 3 * t + 1
    const v2 = index ? index.getX(3 * t + 2) : 3 * t + 2
    const s0 = siteOf[v0]
    const s1 = siteOf[v1]
    const s2 = siteOf[v2]
    addEdge(s0, s1)
    addEdge(s1, s2)
    addEdge(s2, s0)
  }
  const deg = new Int32Array(nSites + 1)
  for (let e = 0; e < a.length; e++) {
    deg[a[e] + 1]++
    deg[b[e] + 1]++
  }
  for (let i = 0; i < nSites; i++) deg[i + 1] += deg[i]
  const start = deg
  const fill = Int32Array.from(start)
  const adj = new Int32Array(a.length * 2)
  for (let e = 0; e < a.length; e++) {
    adj[fill[a[e]]++] = b[e]
    adj[fill[b[e]]++] = a[e]
  }
  return { start, adj }
}

// A small binary heap of [distance, site] for the shortest-path pass.
class MinHeap {
  constructor() {
    this.d = []
    this.s = []
  }
  get size() {
    return this.d.length
  }
  push(dist, site) {
    const d = this.d
    const s = this.s
    let i = d.length
    d.push(dist)
    s.push(site)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (d[p] <= d[i]) break
      ;[d[p], d[i]] = [d[i], d[p]]
      ;[s[p], s[i]] = [s[i], s[p]]
      i = p
    }
  }
  pop() {
    const d = this.d
    const s = this.s
    const topD = d[0]
    const topS = s[0]
    const lastD = d.pop()
    const lastS = s.pop()
    if (d.length) {
      d[0] = lastD
      s[0] = lastS
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < d.length && d[l] < d[m]) m = l
        if (r < d.length && d[r] < d[m]) m = r
        if (m === i) break
        ;[d[m], d[i]] = [d[i], d[m]]
        ;[s[m], s[i]] = [s[i], s[m]]
        i = m
      }
    }
    return [topD, topS]
  }
}

// --- the entry: one mesh ----------------------------------------------------------------

const _m = new THREE.Matrix4()

function buildEntry(mesh) {
  const geometry = mesh.geometry
  const posAttr = geometry && geometry.getAttribute && geometry.getAttribute('position')
  if (!posAttr || !posAttr.count) return null
  const rest = readPositions(posAttr)
  const nVerts = posAttr.count
  const swapped = swapInPrivateGeometry(mesh, rest)

  const skinned = !!(mesh.isSkinnedMesh && mesh.skeleton && geometry.getAttribute('skinIndex') && geometry.getAttribute('skinWeight'))
  const entry = {
    mesh,
    orig: swapped.orig,
    geo: swapped.geo,
    attr: swapped.attr,
    rest,
    nVerts,
    skinned,
    skinIdx: skinned ? geometry.getAttribute('skinIndex').array : null,
    skinW: skinned ? geometry.getAttribute('skinWeight').array : null,
    index: geometry.index || null,
    root: topAncestor(mesh),
    zones: new Map(), // id -> zone runtime
    live: false,
    wasLive: false,
    unit: 1,
    sites: null,
    graph: null,
    bv: null, // rest positions in skin space
    bm: null,
    mw: new Float32Array(16),
    mwInvLin: new Float32Array(9),
    bindInvLin: new Float32Array(9),
    unionVerts: new Int32Array(0),
    siteD: null,
    T0: null, // rest WORLD position of every site
    collider: null,
    collisionThickness: 0,
  }
  // The bind matrix is fixed (it is the matrix the part was bound with); only bindMatrixInverse follows the
  // mesh around. Moving a displacement from skin space back into the part's own space uses the fixed one.
  if (skinned) {
    const bi = new THREE.Matrix4().copy(mesh.bindMatrix).invert().elements
    entry.bindInvLin.set([bi[0], bi[1], bi[2], bi[4], bi[5], bi[6], bi[8], bi[9], bi[10]])
  } else {
    entry.bindInvLin.set([1, 0, 0, 0, 1, 0, 0, 0, 1])
  }
  entry.sites = buildSites(rest, nVerts)
  entry.graph = buildSiteGraph(entry.index, nVerts, entry.sites.siteOf, entry.sites.count)
  entry.siteD = new Float32Array(entry.sites.count * 3)

  // rest in skin space (bindMatrix * v): skinning blends bone matrices, which act on that
  entry.bv = new Float32Array(nVerts * 3)
  if (skinned) {
    mesh.updateWorldMatrix(true, false)
    const b = mesh.bindMatrix.elements
    for (let v = 0; v < nVerts; v++) {
      const x = rest[3 * v]
      const y = rest[3 * v + 1]
      const z = rest[3 * v + 2]
      entry.bv[3 * v] = b[0] * x + b[4] * y + b[8] * z + b[12]
      entry.bv[3 * v + 1] = b[1] * x + b[5] * y + b[9] * z + b[13]
      entry.bv[3 * v + 2] = b[2] * x + b[6] * y + b[10] * z + b[14]
    }
  } else {
    entry.bv.set(rest)
  }
  prepareFrame(entry)
  // world position of every site at the pose it is built in
  const T0 = new Float32Array(entry.sites.count * 3)
  const p = new THREE.Vector3()
  for (let s = 0; s < entry.sites.count; s++) {
    targetOf(entry, entry.sites.rep[s], p)
    T0[3 * s] = p.x
    T0[3 * s + 1] = p.y
    T0[3 * s + 2] = p.z
  }
  entry.T0 = T0
  entry.unit = unitFor(entry)
  return entry
}

// World units per metre, so gravity looks right whether the model is in metres or centimetres.
function unitFor(entry) {
  const box = new THREE.Box3()
  const root = entry.root
  const meshes = []
  root.traverse((o) => {
    if (o.isMesh) meshes.push(o)
  })
  for (const m of meshes) {
    if (!m.geometry) continue
    const gb = m.geometry.boundingBox || (m.geometry.computeBoundingBox(), m.geometry.boundingBox)
    if (!gb) continue
    m.updateWorldMatrix(true, false)
    box.union(gb.clone().applyMatrix4(m.matrixWorld))
  }
  const size = box.getSize(new THREE.Vector3())
  const height = Math.max(size.x, size.y, size.z)
  return height > 1e-6 ? Math.max(1e-3, height / 1.7) : 1
}

// Everything that is the same for every vertex this frame: the bone matrices and the two
// matrices that carry a world-space offset back into the mesh's own space.
function prepareFrame(entry) {
  const mesh = entry.mesh
  entry.root.updateMatrixWorld(true)
  mesh.updateWorldMatrix(true, false)
  if (entry.skinned) {
    mesh.skeleton.update()
    entry.bm = mesh.skeleton.boneMatrices
    _m.copy(mesh.matrixWorld).multiply(mesh.bindMatrixInverse)
    entry.mw.set(_m.elements)
  } else {
    entry.mw.set(mesh.matrixWorld.elements)
  }
  _m.fromArray(entry.mw).invert()
  const e = _m.elements
  entry.mwInvLin.set([e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]])
}

// The world position the animation puts vertex `v` at (no offsets).
function targetOf(entry, v, out) {
  const bv = entry.bv
  const bx = bv[3 * v]
  const by = bv[3 * v + 1]
  const bz = bv[3 * v + 2]
  let x = bx
  let y = by
  let z = bz
  if (entry.skinned) {
    const bm = entry.bm
    const si = entry.skinIdx
    const sw = entry.skinW
    x = 0
    y = 0
    z = 0
    let total = 0
    for (let k = 0; k < 4; k++) {
      const w = sw[4 * v + k]
      if (w === 0) continue
      const o = 16 * si[4 * v + k]
      x += w * (bm[o] * bx + bm[o + 4] * by + bm[o + 8] * bz + bm[o + 12])
      y += w * (bm[o + 1] * bx + bm[o + 5] * by + bm[o + 9] * bz + bm[o + 13])
      z += w * (bm[o + 2] * bx + bm[o + 6] * by + bm[o + 10] * bz + bm[o + 14])
      total += w
    }
    if (total < 1e-6) {
      x = bx
      y = by
      z = bz
    }
  }
  const m = entry.mw
  out.set(
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  )
  return out
}

// Turn a world-space displacement of vertex `v` into the displacement of its rest position that
// skinning will turn back into exactly that: d = bindInv * S^-1 * mwInv * D.
function bindSpaceOffset(entry, v, dx, dy, dz, out) {
  const w = entry.mwInvLin
  let ux = w[0] * dx + w[3] * dy + w[6] * dz
  let uy = w[1] * dx + w[4] * dy + w[7] * dz
  let uz = w[2] * dx + w[5] * dy + w[8] * dz
  if (entry.skinned) {
    const bm = entry.bm
    const si = entry.skinIdx
    const sw = entry.skinW
    // blended 3x3 (column-major in the matrices: columns at +0, +4, +8)
    let a00 = 0, a01 = 0, a02 = 0, a10 = 0, a11 = 0, a12 = 0, a20 = 0, a21 = 0, a22 = 0
    let total = 0
    for (let k = 0; k < 4; k++) {
      const wt = sw[4 * v + k]
      if (wt === 0) continue
      const o = 16 * si[4 * v + k]
      a00 += wt * bm[o]
      a10 += wt * bm[o + 1]
      a20 += wt * bm[o + 2]
      a01 += wt * bm[o + 4]
      a11 += wt * bm[o + 5]
      a21 += wt * bm[o + 6]
      a02 += wt * bm[o + 8]
      a12 += wt * bm[o + 9]
      a22 += wt * bm[o + 10]
      total += wt
    }
    if (total >= 1e-6) {
      const c00 = a11 * a22 - a12 * a21
      const c01 = a02 * a21 - a01 * a22
      const c02 = a01 * a12 - a02 * a11
      const det = a00 * c00 + a10 * c01 + a20 * c02
      if (Math.abs(det) > 1e-9) {
        const id = 1 / det
        const i00 = c00 * id
        const i01 = c01 * id
        const i02 = c02 * id
        const i10 = (a12 * a20 - a10 * a22) * id
        const i11 = (a00 * a22 - a02 * a20) * id
        const i12 = (a02 * a10 - a00 * a12) * id
        const i20 = (a10 * a21 - a11 * a20) * id
        const i21 = (a01 * a20 - a00 * a21) * id
        const i22 = (a00 * a11 - a01 * a10) * id
        const nx = i00 * ux + i01 * uy + i02 * uz
        const ny = i10 * ux + i11 * uy + i12 * uz
        const nz = i20 * ux + i21 * uy + i22 * uz
        ux = nx
        uy = ny
        uz = nz
      }
    }
  }
  const b = entry.bindInvLin
  out[0] = b[0] * ux + b[3] * uy + b[6] * uz
  out[1] = b[1] * ux + b[4] * uy + b[7] * uz
  out[2] = b[2] * ux + b[5] * uy + b[8] * uz
  return out
}

// --- zones -------------------------------------------------------------------------------

function vertexOfTri(entry, t, k) {
  return entry.index ? entry.index.getX(3 * t + k) : 3 * t + k
}

// Works out which sites a zone moves and by how much (the "weight"): the area's sites, minus the
// locked ones (the edge of the area, the top band), fading in with distance from the locked ones.
function buildZone(entry, cfg) {
  const { sites, graph, T0 } = entry
  const nSites = sites.count
  const triCount = Math.floor((entry.index ? entry.index.count : entry.nVerts) / 3)
  const area = cfg.area && cfg.area.kind === 'tris' ? cfg.area : { kind: 'all' }

  const inArea = new Uint8Array(nSites)
  const locked = new Uint8Array(nSites)
  const boundary = new Uint8Array(nSites)
  const blendOutside = area.kind === 'tris' && cfg.blendOutside !== false
  if (area.kind === 'tris') {
    const triIn = new Uint8Array(triCount)
    for (const [first, last] of area.tris || []) {
      for (let t = Math.max(0, first); t <= Math.min(triCount - 1, last); t++) triIn[t] = 1
    }
    const touchedOutside = new Uint8Array(nSites)
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) {
        const s = sites.siteOf[vertexOfTri(entry, t, k)]
        if (triIn[t]) inArea[s] = 1
        else touchedOutside[s] = 1
      }
    }
    for (let s = 0; s < nSites; s++) {
      if (!inArea[s] || !touchedOutside[s]) continue
      boundary[s] = 1
      if (!blendOutside && cfg.mode !== 'swing') locked[s] = 1
    }
  } else {
    inArea.fill(1)
  }

  let minY = Infinity
  let maxY = -Infinity
  const min = new THREE.Vector3(Infinity, Infinity, Infinity)
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  for (let s = 0; s < nSites; s++) {
    if (!inArea[s]) continue
    const x = T0[3 * s]
    const y = T0[3 * s + 1]
    const z = T0[3 * s + 2]
    min.set(Math.min(min.x, x), Math.min(min.y, y), Math.min(min.z, z))
    max.set(Math.max(max.x, x), Math.max(max.y, y), Math.max(max.z, z))
  }
  minY = min.y
  maxY = max.y
  const size = Math.max(1e-6, min.distanceTo(max))
  const lockTop = Math.min(0.9, Math.max(0, cfg.lockTop || 0))
  if (lockTop > 0 && maxY > minY) {
    const limit = maxY - lockTop * (maxY - minY)
    for (let s = 0; s < nSites; s++) if (inArea[s] && T0[3 * s + 1] >= limit) locked[s] = 1
  }

  // Distance from held sites and the selection edge, measured along the surface.
  const dist = new Float32Array(nSites).fill(Infinity)
  const heap = new MinHeap()
  let anyLocked = false
  for (let s = 0; s < nSites; s++) {
    if (inArea[s] && (locked[s] || boundary[s])) {
      dist[s] = 0
      heap.push(0, s)
      anyLocked = true
    }
  }
  while (heap.size) {
    const [d, s] = heap.pop()
    if (d > dist[s]) continue
    for (let e = graph.start[s]; e < graph.start[s + 1]; e++) {
      const n = graph.adj[e]
      if (!inArea[n]) continue
      const nd = d + Math.hypot(T0[3 * s] - T0[3 * n], T0[3 * s + 1] - T0[3 * n + 1], T0[3 * s + 2] - T0[3 * n + 2])
      if (nd < dist[n]) {
        dist[n] = nd
        heap.push(nd, n)
      }
    }
  }

  const outsideDist = new Float32Array(nSites).fill(Infinity)
  if (blendOutside) {
    const outsideHeap = new MinHeap()
    for (let s = 0; s < nSites; s++) {
      if (!boundary[s]) continue
      outsideDist[s] = 0
      outsideHeap.push(0, s)
    }
    while (outsideHeap.size) {
      const [d, s] = outsideHeap.pop()
      if (d > outsideDist[s]) continue
      for (let e = graph.start[s]; e < graph.start[s + 1]; e++) {
        const n = graph.adj[e]
        if (inArea[n]) continue
        const nd = d + Math.hypot(T0[3 * s] - T0[3 * n], T0[3 * s + 1] - T0[3 * n + 1], T0[3 * s + 2] - T0[3 * n + 2])
        if (nd < outsideDist[n]) {
          outsideDist[n] = nd
          outsideHeap.push(nd, n)
        }
      }
    }
  }

  // How far the unselected piece each outside site belongs to reaches from the selection. Influence on
  // it dies out by halfway along, so the far end of a piece (say, the top of a drawstring that is
  // joined to a hood) is never pulled away from whatever it is attached to.
  const outsideFar = new Float32Array(nSites)
  if (blendOutside) {
    const seenOut = new Uint8Array(nSites)
    for (let s0 = 0; s0 < nSites; s0++) {
      if (seenOut[s0] || !Number.isFinite(outsideDist[s0])) continue
      const members = []
      const stack = [s0]
      seenOut[s0] = 1
      let far = 0
      while (stack.length) {
        const t = stack.pop()
        members.push(t)
        far = Math.max(far, outsideDist[t])
        for (let e = graph.start[t]; e < graph.start[t + 1]; e++) {
          const nb = graph.adj[e]
          if (seenOut[nb] || inArea[nb] || !Number.isFinite(outsideDist[nb])) continue
          seenOut[nb] = 1
          stack.push(nb)
        }
      }
      for (const t of members) outsideFar[t] = far
    }
  }

  const blendDist = Math.max(1e-6, (cfg.blend ?? 0.4) * size)
  const outsideRange = Math.max(1e-6, (cfg.outsideRange ?? 0.35) * Math.max(size, entry.unit))
  const outsideStrength = clamp01(cfg.outsideStrength ?? 0.18)
  const outsideMode = cfg.outsideMode === 'all' ? 'all' : 'connected'
  const weightOf = new Float32Array(nSites)
  const affList = []
  for (let s = 0; s < nSites; s++) {
    if (locked[s]) continue
    let w
    if (inArea[s]) {
      w = cfg.mode === 'swing'
        ? 1
        : boundary[s]
        ? outsideStrength
        : anyLocked && Number.isFinite(dist[s])
          ? smooth01(dist[s] / blendDist)
          : 1
    } else if (blendOutside) {
      const reach = Math.min(outsideRange, Math.max(1e-6, 0.5 * outsideFar[s]))
      const edgeFade = Number.isFinite(outsideDist[s]) ? 1 - smooth01(outsideDist[s] / reach) : 0
      const allAreaFloor = outsideMode === 'all' ? outsideStrength * 0.65 : 0
      w = Math.max(allAreaFloor, outsideStrength * edgeFade)
    } else {
      continue
    }
    if (w < AFFECT_MIN) continue
    weightOf[s] = w
    affList.push(s)
  }
  const aff = Int32Array.from(affList)
  const lockedSites = []
  for (let s = 0; s < nSites; s++) if (locked[s] && inArea[s]) lockedSites.push(s)
  const local = new Int32Array(nSites).fill(-1)
  aff.forEach((s, i) => {
    local[s] = i
  })

  // neighbours inside the zone (locked / outside neighbours count as "no offset")
  const nbrStart = new Int32Array(aff.length + 1)
  const nbrList = []
  for (let i = 0; i < aff.length; i++) {
    const s = aff[i]
    for (let e = graph.start[s]; e < graph.start[s + 1]; e++) nbrList.push(local[graph.adj[e]])
    nbrStart[i + 1] = nbrList.length
  }

  // anchors: the sites just outside the zone that it hangs from (for a swinging piece's pivot)
  const anchorSet = new Set()
  for (const s of aff) {
    for (let e = graph.start[s]; e < graph.start[s + 1]; e++) {
      const n = graph.adj[e]
      if (local[n] < 0 || (cfg.mode === 'swing' && !inArea[n])) anchorSet.add(n)
    }
  }
  const anchors = Int32Array.from(anchorSet)

  const n = aff.length
  const zr = {
    cfg,
    structure: zoneStructure(cfg),
    mode: cfg.mode === 'swing' ? 'swing' : 'soft',
    core: inArea,
    aff,
    local,
    weight: Float32Array.from(aff, (s) => weightOf[s]),
    nbrStart,
    nbr: Int32Array.from(nbrList),
    anchors,
    size,
    p: new Float32Array(3 * n),
    v: new Float32Array(3 * n),
    T: new Float32Array(3 * n),
    prevT: new Float32Array(3 * n),
    off: new Float32Array(3 * n),
    off2: new Float32Array(3 * n),
    anchorT: new Float32Array(3 * anchors.length),
    lockedSites: Int32Array.from(lockedSites), // held to the pose: they follow what they are attached to
    attach: [], // [{ entry, site }]: what the held sites are attached to (other effects' vertices nearby)
    ho: new Float32Array(3), // how far that has moved them this frame
    outD: new Float32Array(3 * n), // what this zone added last frame (to hold still when no time passes)
    ready: false,
    comps: [],
    selfCollider: null,
    selfColliderFrame: -Infinity,
  }
  if (zr.mode === 'swing') {
    buildComponents(entry, zr)
    buildSwing(entry, zr, { boundary, blendOutside, outsideStrength })
  }
  return zr
}

// Pieces of a swinging zone: connected vertex islands, each with its own pendulum.
function buildComponents(entry, zr) {
  const n = zr.aff.length
  const seen = new Uint8Array(n)
  const anchorOf = new Map() // site -> index in zr.anchors
  zr.anchors.forEach((s, i) => anchorOf.set(s, i))
  const graph = entry.graph
  for (let start = 0; start < n; start++) {
    if (seen[start] || !zr.core[zr.aff[start]]) continue
    const members = []
    const stack = [start]
    seen[start] = 1
    const attach = new Set()
    while (stack.length) {
      const i = stack.pop()
      members.push(i)
      const s = zr.aff[i]
      for (let e = graph.start[s]; e < graph.start[s + 1]; e++) {
        const nb = graph.adj[e]
        const j = zr.local[nb]
        if (!zr.core[nb]) {
          const a = anchorOf.get(nb)
          if (a !== undefined) attach.add(a)
        } else if (j >= 0 && !seen[j]) {
          seen[j] = 1
          stack.push(j)
        }
      }
    }
    // no attachment (a loose chunk): hang it from its highest point
    let top = members[0]
    for (const i of members) if (entry.T0[3 * zr.aff[i] + 1] > entry.T0[3 * zr.aff[top] + 1]) top = i
    let topAttach = Int32Array.from(attach)
    if (attach.size > 1) {
      let highestY = -Infinity
      for (const ai of attach) highestY = Math.max(highestY, entry.T0[3 * zr.anchors[ai] + 1])
      const topBand = Math.max(1e-6, zr.size * 0.04)
      topAttach = Int32Array.from([...attach].filter((ai) => highestY - entry.T0[3 * zr.anchors[ai] + 1] <= topBand))
    }
    zr.comps.push({
      members: Int32Array.from(members),
      attach: topAttach,
      top,
      q: new Float32Array(3),
      qv: new Float32Array(3),
      ready: false,
      blendMembers: [],
    })
  }

  // Expanded vertices follow their nearest swinging island, without changing
  // the island's pendulum centre or rigid shape.
  const owner = new Int32Array(n).fill(-1)
  const queue = []
  for (let ci = 0; ci < zr.comps.length; ci++) {
    for (const i of zr.comps[ci].members) {
      const site = zr.aff[i]
      for (let e = graph.start[site]; e < graph.start[site + 1]; e++) {
        const outside = graph.adj[e]
        const j = zr.local[outside]
        if (j < 0 || zr.core[outside] || owner[j] >= 0) continue
        owner[j] = ci
        queue.push(j)
      }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]
    const ci = owner[i]
    zr.comps[ci].blendMembers.push(i)
    const site = zr.aff[i]
    for (let e = graph.start[site]; e < graph.start[site + 1]; e++) {
      const outside = graph.adj[e]
      const j = zr.local[outside]
      if (j < 0 || zr.core[outside] || owner[j] >= 0) continue
      owner[j] = ci
      queue.push(j)
    }
  }
}

// What a swinging piece needs besides its islands: where it hinges, how far each vertex is down the
// piece from the hinge (the "axial" distance, which decides how much it bends), and how much each
// vertex follows the swing (`weight`: 1 for the piece itself, fading only where it is joined to the
// rest of the mesh along its sides or bottom, so that join is never torn or stretched).
const STRAIN_BUDGET = 0.08 // most a joined edge may be stretched at the swing limit
const OUTSIDE_STRAIN = 0.08 // most that unselected vertices following a swing may be stretched
const INPLANE_BUDGET = 0.05 // most a bending piece may be sheared by swinging sideways inside its surface
const BEND_STEPS = 12

function buildSwing(entry, zr, ctx) {
  const { T0, graph } = entry
  const n = zr.aff.length
  const nSites = entry.sites.count
  const hMin = ctx.blendOutside ? ctx.outsideStrength : 0
  const blend = clamp01(zr.cfg.blend ?? 0.15)
  zr.axial = new Float32Array(n)
  zr.dhIdx = new Int32Array(3 * n).fill(-1)
  zr.dhW = new Float32Array(3 * n)
  zr.joined = new Uint8Array(n) // vertices shared with the mesh the piece hangs from: they stay where the mesh draws them

  // per island: rest hinge point and hang direction
  const lateralSources = []
  for (const comp of zr.comps) {
    const A0 = new THREE.Vector3()
    // The hinge is the top of the edge where the piece is joined to the mesh (or, for a loose piece,
    // the top of the piece). The joined row itself stays put; everything below it swings.
    const joined = comp.members.filter((i) => ctx.boundary[zr.aff[i]])
    const pool = joined.length ? joined : Array.from(comp.members)
    let topY = -Infinity
    for (const i of pool) topY = Math.max(topY, T0[3 * zr.aff[i] + 1])
    const band = Math.max(1e-6, zr.size * 0.04)
    const topBand = pool.filter((i) => topY - T0[3 * zr.aff[i] + 1] <= band)
    for (const i of topBand) A0.add(_a.set(T0[3 * zr.aff[i]], T0[3 * zr.aff[i] + 1], T0[3 * zr.aff[i] + 2]))
    A0.multiplyScalar(1 / topBand.length)
    const C0 = new THREE.Vector3()
    for (const i of comp.members) C0.add(_a.set(T0[3 * zr.aff[i]], T0[3 * zr.aff[i] + 1], T0[3 * zr.aff[i] + 2]))
    C0.multiplyScalar(1 / comp.members.length)
    const c0 = C0.clone().sub(A0)
    const length = c0.length()
    if (length < 1e-6) c0.set(0, -1, 0)
    else c0.multiplyScalar(1 / length)
    comp.A0 = A0
    comp.c0 = c0
    comp.length = length
    comp.topBand = Int32Array.from(topBand)
    comp.hingeD = new Float32Array(3 * topBand.length) // how far what the hinge hangs from has moved this frame
    comp.hingeLinks = [] // per hinge vertex: the vertex of another effect it hangs from, if any
    comp.joinedPiece = joined.length > 0 // shares vertices with the mesh it hangs from
    comp.hangs = zr.cfg.hangs === true // the user says it hangs from its top (a drawstring whose hood has no effect on it)
    comp.attached = comp.joinedPiece || comp.hangs // (also true when it hangs from another part: see rebuildAttach)
    // A piece that is joined to the mesh bends near the join; a loose piece is one rigid body.
    comp.rampAttached = Math.min(blend * zr.size, 0.6 * length)
    if (comp.rampAttached < 1e-6) comp.rampAttached = 0
    comp.ramp = comp.attached ? comp.rampAttached : 0
    comp.cap = Infinity
    for (const i of comp.members) if (ctx.boundary[zr.aff[i]]) zr.joined[i] = 1
    for (const list of [comp.members, comp.blendMembers]) {
      for (const i of list) {
        const o = 3 * zr.aff[i]
        zr.axial[i] = Math.max(0, (T0[o] - A0.x) * c0.x + (T0[o + 1] - A0.y) * c0.y + (T0[o + 2] - A0.z) * c0.z)
      }
    }
    // each vertex of the piece moves with the nearest few vertices of the hinge row, so a mesh that
    // deforms along the join carries the piece with it instead of shearing against it
    for (const i of comp.members) {
      if (zr.joined[i]) continue
      const o = 3 * zr.aff[i]
      const best = [-1, -1, -1]
      const bestD = [Infinity, Infinity, Infinity]
      topBand.forEach((hI, pos) => {
        const q = 3 * zr.aff[hI]
        const d = Math.hypot(T0[o] - T0[q], T0[o + 1] - T0[q + 1], T0[o + 2] - T0[q + 2])
        for (let k = 0; k < 3; k++) {
          if (d < bestD[k]) {
            for (let m = 2; m > k; m--) {
              bestD[m] = bestD[m - 1]
              best[m] = best[m - 1]
            }
            bestD[k] = d
            best[k] = pos
            break
          }
        }
      })
      let sum = 0
      for (let k = 0; k < 3; k++) {
        zr.dhIdx[3 * i + k] = best[k]
        zr.dhW[3 * i + k] = best[k] < 0 ? 0 : 1 / (bestD[k] * bestD[k] + 1e-8)
        sum += zr.dhW[3 * i + k]
      }
      for (let k = 0; k < 3; k++) zr.dhW[3 * i + k] /= sum || 1
    }
    comp.extent = 0
    for (const i of comp.members) comp.extent = Math.max(comp.extent, zr.axial[i])
    // joined edges that are not the hinge itself (the sides and the bottom of a patch)
    const hingeBand = comp.ramp + 0.1 * zr.size
    for (const i of comp.members) {
      if (ctx.boundary[zr.aff[i]] && zr.axial[i] > hingeBand) lateralSources.push(i)
    }
  }

  // The surface normal of each piece. A piece joined to the mesh swings out of its own surface (like a
  // flap); swinging sideways inside its surface would shear it, so that part is limited.
  const compOf = new Int32Array(n).fill(-1)
  zr.comps.forEach((comp, ci) => comp.members.forEach((i) => (compOf[i] = ci)))
  const normals = zr.comps.map(() => new THREE.Vector3())
  const compTris = zr.comps.map(() => [])
  const triCount = Math.floor((entry.index ? entry.index.count : entry.nVerts) / 3)
  for (let t = 0; t < triCount; t++) {
    const l0 = zr.local[entry.sites.siteOf[vertexOfTri(entry, t, 0)]]
    const l1 = zr.local[entry.sites.siteOf[vertexOfTri(entry, t, 1)]]
    const l2 = zr.local[entry.sites.siteOf[vertexOfTri(entry, t, 2)]]
    if (l0 < 0 || l1 < 0 || l2 < 0) continue
    const ci = compOf[l0]
    if (ci < 0 || ci !== compOf[l1] || ci !== compOf[l2]) continue
    const a = 3 * zr.aff[l0]
    const b = 3 * zr.aff[l1]
    const c = 3 * zr.aff[l2]
    _a.set(T0[b] - T0[a], T0[b + 1] - T0[a + 1], T0[b + 2] - T0[a + 2])
    _b.set(T0[c] - T0[a], T0[c + 1] - T0[a + 1], T0[c + 2] - T0[a + 2])
    _a.cross(_b)
    // fold to one side so a surface that faces both ways does not cancel itself out
    if (normals[ci].dot(_a) < 0) _a.negate()
    normals[ci].add(_a)
    compTris[ci].push([l0, l1, l2, _a.x, _a.y, _a.z])
  }
  zr.comps.forEach((comp, ci) => {
    comp.w = null
    comp.N = null
    comp.capN = Infinity
    if (comp.rampAttached <= 0) return
    const N = normals[ci].addScaledVector(comp.c0, -normals[ci].dot(comp.c0))
    if (N.lengthSq() < 1e-14) return
    N.normalize()
    comp.N = N
    comp.w = new THREE.Vector3().crossVectors(comp.c0, N).normalize()
    // a few triangles spread over the piece, to read its surface direction from every frame's pose
    const list = compTris[ci]
    const pick = Math.min(8, list.length)
    comp.refTris = new Int32Array(3 * pick)
    comp.refNormals = new Float32Array(3 * pick)
    for (let q = 0; q < pick; q++) {
      const tri = list[Math.floor((q * list.length) / pick)]
      comp.refTris.set([tri[0], tri[1], tri[2]], 3 * q)
      comp.refNormals.set([tri[3], tri[4], tri[5]], 3 * q)
    }
    let off = 0
    for (const i of comp.members) {
      const o = 3 * zr.aff[i]
      const dx = T0[o] - comp.A0.x
      const dy = T0[o + 1] - comp.A0.y
      const dz = T0[o + 2] - comp.A0.z
      const along = dx * comp.c0.x + dy * comp.c0.y + dz * comp.c0.z
      off = Math.max(off, Math.hypot(dx - along * comp.c0.x, dy - along * comp.c0.y, dz - along * comp.c0.z))
    }
    comp.capN = off > 1e-6 ? Math.max(THREE.MathUtils.degToRad(0.5), (INPLANE_BUDGET * comp.rampAttached) / (1.5 * off)) : Infinity
  })

  // distance from those joined edges, through the piece, sets how much each vertex of it follows
  const dist = new Float32Array(n).fill(Infinity)
  const heap = new MinHeap()
  for (const i of lateralSources) {
    dist[i] = 0
    heap.push(0, i)
  }
  while (heap.size) {
    const [d, i] = heap.pop()
    if (d > dist[i]) continue
    const s = zr.aff[i]
    for (let e = graph.start[s]; e < graph.start[s + 1]; e++) {
      const nb = graph.adj[e]
      const j = zr.local[nb]
      if (j < 0 || !zr.core[nb]) continue
      const nd = d + Math.hypot(T0[3 * s] - T0[3 * nb], T0[3 * s + 1] - T0[3 * nb + 1], T0[3 * s + 2] - T0[3 * nb + 2])
      if (nd < dist[j]) {
        dist[j] = nd
        heap.push(nd, j)
      }
    }
  }
  const lat = Math.max(0.25, blend) * zr.size
  for (const comp of zr.comps) {
    let rFar = 0
    for (const i of comp.members) {
      if (Number.isFinite(dist[i])) {
        zr.weight[i] = hMin + (1 - hMin) * smooth01(dist[i] / lat)
        const o = 3 * zr.aff[i]
        if (zr.weight[i] < 0.999) rFar = Math.max(rFar, Math.hypot(T0[o] - comp.A0.x, T0[o + 1] - comp.A0.y, T0[o + 2] - comp.A0.z))
      } else {
        zr.weight[i] = 1
      }
    }
    // the unselected vertices that follow it ease in over the same distance, so there is no step where they begin
    for (const i of comp.blendMembers) zr.weight[i] *= smooth01(zr.axial[i] / lat)
    // a piece joined along its sides can only turn so far before that join stretches: cap it
    if (rFar > 1e-6) comp.cap = Math.max(THREE.MathUtils.degToRad(0.5), (STRAIN_BUDGET * lat) / (1.5 * (1 - hMin) * rFar))
    comp.lutI = new Float32Array(BEND_STEPS + 1)
    comp.lutJ = new Float32Array(BEND_STEPS + 1)
    comp.pa = new Float32Array(3)
    comp.pv = new Float32Array(3)
  }
  void nSites
}

// --- stepping ---------------------------------------------------------------------------

const _p = new THREE.Vector3()
const _g = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _qi = new THREE.Quaternion()
const _rx = new THREE.Vector3()
const _bob = new THREE.Vector3()
const _physDir = new THREE.Vector3()

function springParams(cfg) {
  const s = clamp01(cfg.stiffness ?? 0.4)
  const k = 10 + 300 * s * s
  const zeta = 0.12 + 1.1 * clamp01(cfg.damping ?? 0.5)
  return { k, c: 2 * Math.sqrt(k) * zeta }
}

function fillTargets(entry, zr) {
  for (let i = 0; i < zr.aff.length; i++) {
    targetOf(entry, entry.sites.rep[zr.aff[i]], _p)
    zr.T[3 * i] = _p.x
    zr.T[3 * i + 1] = _p.y
    zr.T[3 * i + 2] = _p.z
  }
  for (let i = 0; i < zr.anchors.length; i++) {
    targetOf(entry, entry.sites.rep[zr.anchors[i]], _p)
    zr.anchorT[3 * i] = _p.x
    zr.anchorT[3 * i + 1] = _p.y
    zr.anchorT[3 * i + 2] = _p.z
  }
}

function resetZone(zr) {
  zr.p.set(zr.T)
  zr.prevT.set(zr.T)
  zr.v.fill(0)
  zr.off.fill(0)
  zr.ready = true
  for (const c of zr.comps) c.ready = false
}

function resolveMeshCollision(colliders, thickness, maxDistance, p, v, ix, tx, ty, tz) {
  for (const collider of colliders || []) {
    const q = collider.query(p[ix], p[ix + 1], p[ix + 2], 1, maxDistance)
    if (!q) continue
    let nx = q.fnx
    let ny = q.fny
    let nz = q.fnz
    if (nx * nx + ny * ny + nz * nz < 1e-8) {
      nx = q.nx
      ny = q.ny
      nz = q.nz
    }
    const targetSide = (tx - q.x) * nx + (ty - q.y) * ny + (tz - q.z) * nz
    if (targetSide < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
    } else if (Math.abs(targetSide) < 1e-8) {
      const currentSide = (p[ix] - q.x) * nx + (p[ix + 1] - q.y) * ny + (p[ix + 2] - q.z) * nz
      if (currentSide < 0) {
        nx = -nx
        ny = -ny
        nz = -nz
      }
    }
    const sd = (p[ix] - q.x) * nx + (p[ix + 1] - q.y) * ny + (p[ix + 2] - q.z) * nz
    if (sd >= thickness) continue
    const push = thickness - sd
    p[ix] += nx * push
    p[ix + 1] += ny * push
    p[ix + 2] += nz * push
    const inward = v[ix] * nx + v[ix + 1] * ny + v[ix + 2] * nz
    if (inward < 0) {
      v[ix] -= nx * inward
      v[ix + 1] -= ny * inward
      v[ix + 2] -= nz * inward
    }
  }
}

function stepSoft(entry, zr, dt, colliders = [], thickness = 0) {
  const cfg = zr.cfg
  const n = zr.aff.length
  const { k, c } = springParams(cfg)
  const amount = clamp01(cfg.amount ?? 1)
  const range = Math.max(0, cfg.range ?? 0.08) * zr.size
  const maxCollisionDistance = Math.max(range + thickness, entry.unit * 0.05)
  _g.set(0, -GRAVITY_MS2 * entry.unit * clamp01(cfg.gravity ?? 0.3) * 1.2, 0)
  const { p, v, T, prevT, weight } = zr
  // Bounce: how freely the cloth moves up and down. More = softer, longer vertical springs, less
  // vertical damping and more vertical room; less = held firmly in the vertical.
  const bounce = Math.min(2.5, Math.max(0, cfg.bounce ?? 1))
  const kyScale = 1 / (0.4 + 0.6 * bounce)
  const cy = (c * Math.sqrt(kyScale)) / (0.25 + 0.75 * bounce)
  const yRoom = 0.4 + 0.6 * bounce

  // a jump (a scrub, a cut) is not motion: start again from the pose
  let jump = false
  for (let i = 0; i < n && !jump; i++) {
    const dx = T[3 * i] - prevT[3 * i]
    const dy = T[3 * i + 1] - prevT[3 * i + 1]
    const dz = T[3 * i + 2] - prevT[3 * i + 2]
    if (dx * dx + dy * dy + dz * dz > zr.size * zr.size * 0.25) jump = true
  }
  if (jump) resetZone(zr)

  const steps = Math.max(1, Math.min(4, Math.ceil(dt / SUBSTEP)))
  const h = dt / steps
  for (let s = 1; s <= steps; s++) {
    const f = s / steps
    for (let i = 0; i < n; i++) {
      const ix = 3 * i
      const w = weight[i]
      const kk = k * (0.3 + 0.7 * w)
      const tx = prevT[ix] + (T[ix] - prevT[ix]) * f
      const ty = prevT[ix + 1] + (T[ix + 1] - prevT[ix + 1]) * f
      const tz = prevT[ix + 2] + (T[ix + 2] - prevT[ix + 2]) * f
      v[ix] += (kk * (tx - p[ix]) - c * v[ix] + _g.x * w) * h
      v[ix + 1] += (kk * kyScale * (ty - p[ix + 1]) - cy * v[ix + 1] + _g.y * w) * h
      v[ix + 2] += (kk * (tz - p[ix + 2]) - c * v[ix + 2] + _g.z * w) * h
      p[ix] += v[ix] * h
      p[ix + 1] += v[ix + 1] * h
      p[ix + 2] += v[ix + 2] * h
      // never further from the pose than the zone's range allows
      const ox = p[ix] - tx
      const oy = (p[ix + 1] - ty) / yRoom // measured in an ellipsoid: more room up and down with more bounce
      const oz = p[ix + 2] - tz
      const lim = range * w
      const len2 = ox * ox + oy * oy + oz * oz
      if (len2 > lim * lim) {
        const len = Math.sqrt(len2) || 1
        const sc2 = lim / len
        p[ix] = tx + ox * sc2
        p[ix + 1] = ty + oy * sc2 * yRoom
        p[ix + 2] = tz + oz * sc2
        const radial = (v[ix] * ox + v[ix + 1] * oy + v[ix + 2] * oz) / len
        if (radial > 0) {
          v[ix] -= (ox / len) * radial
          v[ix + 1] -= (oy / len) * radial
          v[ix + 2] -= (oz / len) * radial
        }
      }
    }
  }
  prevT.set(T)

  // offsets, then smoothed across neighbours so the cloth moves as one piece
  const { off, off2, nbrStart, nbr } = zr
  for (let i = 0; i < n; i++) {
    off[3 * i] = p[3 * i] - T[3 * i]
    off[3 * i + 1] = p[3 * i + 1] - T[3 * i + 1]
    off[3 * i + 2] = p[3 * i + 2] - T[3 * i + 2]
  }
  const sm = clamp01(cfg.smoothing ?? 0.6) * 0.5
  if (sm > 0) {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const a = nbrStart[i]
        const b = nbrStart[i + 1]
        let sx = 0
        let sy = 0
        let sz = 0
        for (let e = a; e < b; e++) {
          const j = nbr[e]
          if (j < 0) continue
          sx += off[3 * j]
          sy += off[3 * j + 1]
          sz += off[3 * j + 2]
        }
        const cnt = b - a || 1
        off2[3 * i] = off[3 * i] + (sx / cnt - off[3 * i]) * sm
        off2[3 * i + 1] = off[3 * i + 1] + (sy / cnt - off[3 * i + 1]) * sm
        off2[3 * i + 2] = off[3 * i + 2] + (sz / cnt - off[3 * i + 2]) * sm
      }
      off.set(off2)
    }
  }
  if (colliders.length) {
    for (let i = 0; i < n; i++) {
      const ix = 3 * i
      p[ix] = T[ix] + off[ix]
      p[ix + 1] = T[ix + 1] + off[ix + 1]
      p[ix + 2] = T[ix + 2] + off[ix + 2]
      resolveMeshCollision(
        colliders,
        thickness,
        maxCollisionDistance,
        p,
        v,
        ix,
        T[ix],
        T[ix + 1],
        T[ix + 2],
      )
      off[ix] = p[ix] - T[ix]
      off[ix + 1] = p[ix + 1] - T[ix + 1]
      off[ix + 2] = p[ix + 2] - T[ix + 2]
    }
  }

  // what it is attached to has moved it as a whole (zr.ho); the springs work on top of that
  const D = entry.siteD
  const { outD, ho } = zr
  for (let i = 0; i < n; i++) {
    const s = zr.aff[i]
    outD[3 * i] = off[3 * i] * amount + ho[0]
    outD[3 * i + 1] = off[3 * i + 1] * amount + ho[1]
    outD[3 * i + 2] = off[3 * i + 2] * amount + ho[2]
    D[3 * s] += outD[3 * i]
    D[3 * s + 1] += outD[3 * i + 1]
    D[3 * s + 2] += outD[3 * i + 2]
  }
}

// A swinging piece is a pendulum hung from its hinge. It is simulated RELATIVE to the hinge, so moving
// the whole garment never leaves it behind, but the hinge's acceleration is fed in as a real inertial
// force: when the body speeds up, stops or turns, the piece lags and then swings, the way a hanging
// thing does. A spring pulls it back towards where the animation puts it, gravity droops it, and it
// is limited to a maximum angle.
function swingSpring(cfg) {
  const k = 10 + 300 * clamp01(cfg.stiffness ?? 0.3) ** 2
  const zeta = 0.06 + 0.95 * clamp01(cfg.damping ?? 0.4)
  return { k, c: 2 * Math.sqrt(k) * zeta }
}

const _n = new THREE.Vector3()
const _mm = new THREE.Vector3()
const _acc = new THREE.Vector3()
const _wv = new THREE.Vector3()
const _uv = new THREE.Vector3()

function stepSwing(entry, zr, dt) {
  const cfg = zr.cfg
  const { k, c: cd } = swingSpring(cfg)
  const amount = clamp01(cfg.amount ?? 1)
  const react = Math.min(3, Math.max(0, cfg.reaction ?? 1))
  const userLimit = THREE.MathUtils.degToRad(Math.min(180, Math.max(1, cfg.swingLimit ?? 70)))
  const gy = -GRAVITY_MS2 * entry.unit * clamp01(cfg.gravity ?? 0.8)
  const minLen = 0.12 * entry.unit // a tiny piece swings like a short pendulum, not a blur
  const jumpDist = 0.35 * entry.unit
  const accMax = 80 * entry.unit
  const steps = Math.max(1, Math.min(4, Math.ceil(dt / SUBSTEP)))
  const h = dt / steps
  const { T, weight, axial, joined } = zr
  const D = entry.siteD
  const smoothK = 1 - Math.exp(-dt / 0.04) // the hinge's velocity is smoothed a little, so keyframed clips do not jolt it

  for (const comp of zr.comps) {
    // the hinge now, and where the piece's middle is now
    _a.set(0, 0, 0)
    for (const i of comp.topBand) _a.add(_b.set(T[3 * i], T[3 * i + 1], T[3 * i + 2]))
    _a.multiplyScalar(1 / comp.topBand.length)
    // ...and how far whatever it hangs from has been moved by other effects (a soft hood, a bouncing
    // jacket, on this part or another): the hinge is where that is DRAWN, so the piece never lags
    // behind what it is attached to
    let dhx = 0
    let dhy = 0
    let dhz = 0
    for (let k = 0; k < comp.topBand.length; k++) {
      const link = comp.hingeLinks[k]
      const own = zr.aff[comp.topBand[k]]
      if (link) {
        linkShift(entry, own, link, cfg.closeGap === true, comp.hingeD, 3 * k)
      } else {
        comp.hingeD[3 * k] = D[3 * own]
        comp.hingeD[3 * k + 1] = D[3 * own + 1]
        comp.hingeD[3 * k + 2] = D[3 * own + 2]
      }
      dhx += comp.hingeD[3 * k]
      dhy += comp.hingeD[3 * k + 1]
      dhz += comp.hingeD[3 * k + 2]
    }
    dhx /= comp.topBand.length
    dhy /= comp.topBand.length
    dhz /= comp.topBand.length
    _b.set(0, 0, 0)
    for (const i of comp.members) _b.add(_c.set(T[3 * i], T[3 * i + 1], T[3 * i + 2]))
    _b.multiplyScalar(1 / comp.members.length)
    _c.copy(_b).sub(_a)
    const len = _c.length()
    if (len < 1e-6) continue
    _c.multiplyScalar(1 / len)
    const L = Math.max(len, minLen)

    if (!comp.ready) {
      comp.q[0] = _c.x * L
      comp.q[1] = _c.y * L
      comp.q[2] = _c.z * L
      comp.qv.fill(0)
      comp.pa[0] = _a.x + dhx
      comp.pa[1] = _a.y + dhy
      comp.pa[2] = _a.z + dhz
      comp.pv.fill(0)
      comp.ready = true
    }

    // the hinge's acceleration (a cut or a teleport is not motion)
    const mx = _a.x + dhx - comp.pa[0]
    const my = _a.y + dhy - comp.pa[1]
    const mz = _a.z + dhz - comp.pa[2]
    if (mx * mx + my * my + mz * mz > jumpDist * jumpDist) {
      _acc.set(0, 0, 0)
      comp.pv.fill(0)
    } else {
      const vx = comp.pv[0] + (mx / dt - comp.pv[0]) * smoothK
      const vy = comp.pv[1] + (my / dt - comp.pv[1]) * smoothK
      const vz = comp.pv[2] + (mz / dt - comp.pv[2]) * smoothK
      _acc.set((vx - comp.pv[0]) / dt, (vy - comp.pv[1]) / dt, (vz - comp.pv[2]) / dt)
      const am = _acc.length()
      if (am > accMax) _acc.multiplyScalar(accMax / am)
      comp.pv[0] = vx
      comp.pv[1] = vy
      comp.pv[2] = vz
    }
    comp.pa[0] = _a.x + dhx
    comp.pa[1] = _a.y + dhy
    comp.pa[2] = _a.z + dhz
    _acc.multiplyScalar(react)

    const limit = Math.min(userLimit, comp.cap)
    let qx = comp.q[0]
    let qy = comp.q[1]
    let qz = comp.q[2]
    let vx = comp.qv[0]
    let vy = comp.qv[1]
    let vz = comp.qv[2]
    for (let s = 0; s < steps; s++) {
      vx += (k * (_c.x * L - qx) - cd * vx - _acc.x) * h
      vy += (k * (_c.y * L - qy) - cd * vy - _acc.y + gy) * h
      vz += (k * (_c.z * L - qz) - cd * vz - _acc.z) * h
      qx += vx * h
      qy += vy * h
      qz += vz * h

      // the piece is rigid: fixed distance from the hinge, no velocity along it
      let r = Math.hypot(qx, qy, qz)
      if (r < 1e-9) {
        qx = _c.x * L
        qy = _c.y * L
        qz = _c.z * L
        r = L
      }
      let dx = qx / r
      let dy = qy / r
      let dz = qz / r
      const radial = vx * dx + vy * dy + vz * dz
      vx -= dx * radial
      vy -= dy * radial
      vz -= dz * radial

      // never further from where the animation puts it than the swing limit
      const dot = THREE.MathUtils.clamp(dx * _c.x + dy * _c.y + dz * _c.z, -1, 1)
      const angle = Math.acos(dot)
      if (angle > limit) {
        _physDir.set(dx, dy, dz)
        _q.setFromUnitVectors(_physDir, _c)
        _qi.identity().slerp(_q, (angle - limit) / angle)
        _physDir.applyQuaternion(_qi)
        dx = _physDir.x
        dy = _physDir.y
        dz = _physDir.z
        // remove the velocity that is still carrying it outwards
        _bob.set(dx * dot - _c.x, dy * dot - _c.y, dz * dot - _c.z)
        if (_bob.lengthSq() > 1e-10) {
          _bob.normalize()
          const out = vx * _bob.x + vy * _bob.y + vz * _bob.z
          if (out > 0) {
            vx -= _bob.x * out
            vy -= _bob.y * out
            vz -= _bob.z * out
          }
        }
      }
      qx = dx * L
      qy = dy * L
      qz = dz * L
    }
    comp.q[0] = qx
    comp.q[1] = qy
    comp.q[2] = qz
    comp.qv[0] = vx
    comp.qv[1] = vy
    comp.qv[2] = vz

    // how far the piece has turned from the pose, about which axis
    _n.set(qx / L, qy / L, qz / L) // the direction it hangs in now
    _bob.crossVectors(_c, _n)
    const sinT = _bob.length()
    let theta = Math.atan2(sinT, _c.dot(_n)) * amount
    let bendOn = sinT >= 1e-8 && theta >= 1e-5
    if (bendOn) _n.copy(_bob).multiplyScalar(1 / sinT) // the axis
    else _n.set(1, 0, 0)
    if (bendOn && comp.attached && comp.w) {
      // the piece's surface as the pose has it now (the body may have turned since it was built)
      _wv.set(0, 0, 0)
      for (let q = 0; q < comp.refTris.length; q += 3) {
        const a0 = 3 * comp.refTris[q]
        const a1 = 3 * comp.refTris[q + 1]
        const a2 = 3 * comp.refTris[q + 2]
        _g.set(T[a1] - T[a0], T[a1 + 1] - T[a0 + 1], T[a1 + 2] - T[a0 + 2])
        _p.set(T[a2] - T[a0], T[a2 + 1] - T[a0 + 1], T[a2 + 2] - T[a0 + 2])
        _g.cross(_p)
        if (_g.x * comp.refNormals[q] + _g.y * comp.refNormals[q + 1] + _g.z * comp.refNormals[q + 2] < 0) _g.negate()
        _wv.add(_g)
      }
      _wv.addScaledVector(_c, -_wv.dot(_c))
      if (_wv.lengthSq() < 1e-14) _wv.copy(comp.N)
      _wv.normalize()
      _uv.crossVectors(_c, _wv) // across the piece
      // split the turn into out of the surface (free) and sideways inside it (limited)
      const rw = theta * _n.dot(_uv)
      const rn = theta * _n.dot(_wv)
      const cap = comp.capN
      const rn2 = cap * Math.tanh(rn / cap)
      _n.copy(_uv).multiplyScalar(rw).addScaledVector(_wv, rn2)
      theta = _n.length()
      if (theta < 1e-5) bendOn = false
      else _n.multiplyScalar(1 / theta)
    }
    if (!bendOn) theta = 0
    _mm.crossVectors(_n, _c) // across the hang direction, in the plane of the swing
    const cosT = Math.cos(theta)
    const sinTh = Math.sin(theta)

    // The piece bends from the hinge over `ramp` and is rigid beyond it. Bending (rather than
    // fading the movement in) keeps every fibre its own length, so the join does not stretch.
    const ramp = comp.ramp
    const lutI = comp.lutI
    const lutJ = comp.lutJ
    if (ramp > 0 && bendOn) {
      const step = ramp / BEND_STEPS
      lutI[0] = 0
      lutJ[0] = 0
      let pc = 1
      let ps = 0
      for (let i = 1; i <= BEND_STEPS; i++) {
        const phi = theta * smooth01(i / BEND_STEPS)
        const cc = Math.cos(phi)
        const ss = Math.sin(phi)
        lutI[i] = lutI[i - 1] + 0.5 * step * (pc + cc)
        lutJ[i] = lutJ[i - 1] + 0.5 * step * (ps + ss)
        pc = cc
        ps = ss
      }
    }
    const nx = _n.x, ny = _n.y, nz = _n.z
    const cx = _c.x, cy = _c.y, cz = _c.z
    const mxx = _mm.x, myy = _mm.y, mzz = _mm.z
    // the top of the piece (`holdTop`) is rigidly fixed to the mesh; the bend starts below it
    const hold = comp.attached ? Math.min(0.7, Math.max(0, cfg.holdTop ?? 0)) * comp.extent : 0
    const apply = (i, core) => {
      const t = 3 * i
      const site = zr.aff[i]
      // unselected vertices only follow as far as that cannot stretch them (their pull-along grows with the angle)
      const hw = core ? weight[i] : Math.min(weight[i], OUTSIDE_STRAIN / Math.max(theta, 1e-3))
      const sAx = axial[i]
      const s1 = Math.max(0, sAx - hold)
      let bx = 0
      let by = 0
      let bz = 0
      if (bendOn && hw >= 1e-4 && (hold === 0 || sAx > hold)) {
        const ox = T[t] - _a.x - sAx * cx
        const oy = T[t + 1] - _a.y - sAx * cy
        const oz = T[t + 2] - _a.z - sAx * cz
        let I
        let J
        let cp = cosT
        let sp = sinTh
        if (ramp > 0 && s1 < ramp) {
          const u = s1 / ramp
          const kf = Math.min(BEND_STEPS - 1e-6, u * BEND_STEPS)
          const k0 = Math.floor(kf)
          const fr = kf - k0
          I = lutI[k0] + (lutI[k0 + 1] - lutI[k0]) * fr
          J = lutJ[k0] + (lutJ[k0 + 1] - lutJ[k0]) * fr
          const phi = theta * smooth01(u)
          cp = Math.cos(phi)
          sp = Math.sin(phi)
        } else {
          const extra = ramp > 0 ? s1 - ramp : s1
          I = (ramp > 0 ? lutI[BEND_STEPS] : 0) + extra * cosT
          J = (ramp > 0 ? lutJ[BEND_STEPS] : 0) + extra * sinTh
        }
        // rotate the offset from the hang axis about the swing axis (Rodrigues)
        const nxo = ny * oz - nz * oy
        const nyo = nz * ox - nx * oz
        const nzo = nx * oy - ny * ox
        const ndo = (nx * ox + ny * oy + nz * oz) * (1 - cp)
        bx = hw * ((I - s1) * cx + J * mxx + (cp - 1) * ox + sp * nxo + nx * ndo)
        by = hw * ((I - s1) * cy + J * myy + (cp - 1) * oy + sp * nyo + ny * ndo)
        bz = hw * ((I - s1) * cz + J * mzz + (cp - 1) * oz + sp * nzo + nz * ndo)
      }
      if (core && !joined[i]) {
        // the piece goes wherever the mesh at its hinge has gone, then swings from there
        let hx = 0
        let hy = 0
        let hz = 0
        for (let k = 0; k < 3; k++) {
          const hp = zr.dhIdx[3 * i + k]
          if (hp < 0) continue
          const hwk = zr.dhW[3 * i + k]
          hx += comp.hingeD[3 * hp] * hwk
          hy += comp.hingeD[3 * hp + 1] * hwk
          hz += comp.hingeD[3 * hp + 2] * hwk
        }
        bx += hx
        by += hy
        bz += hz
        D[3 * site] = bx
        D[3 * site + 1] = by
        D[3 * site + 2] = bz
      } else {
        D[3 * site] += bx
        D[3 * site + 1] += by
        D[3 * site + 2] += bz
      }
      zr.off[t] = bx
      zr.off[t + 1] = by
      zr.off[t + 2] = bz
    }
    for (const i of comp.members) apply(i, true)
    for (const i of comp.blendMembers) apply(i, false)
  }
}

// Write the zones' offsets into the part's position buffer.
function writeOffsets(entry) {
  const arr = entry.attr.array
  const rest = entry.rest
  const D = entry.siteD
  const { siteOf } = entry.sites
  const out = [0, 0, 0]
  for (let i = 0; i < entry.unionVerts.length; i++) {
    const v = entry.unionVerts[i]
    const s = siteOf[v]
    bindSpaceOffset(entry, v, D[3 * s], D[3 * s + 1], D[3 * s + 2], out)
    arr[3 * v] = rest[3 * v] + out[0]
    arr[3 * v + 1] = rest[3 * v + 1] + out[1]
    arr[3 * v + 2] = rest[3 * v + 2] + out[2]
  }
  entry.attr.needsUpdate = true
}

function restoreRest(entry) {
  entry.attr.array.set(entry.rest)
  entry.attr.needsUpdate = true
  entry.live = false
}

function rebuildUnion(entry) {
  const sites = new Uint8Array(entry.sites.count)
  for (const zr of entry.zones.values()) {
    for (const s of zr.aff) sites[s] = 1
    for (const s of zr.lockedSites) sites[s] = 1 // held sites can still be carried along by what they hang from
  }
  const verts = []
  for (let v = 0; v < entry.nVerts; v++) if (sites[entry.sites.siteOf[v]]) verts.push(v)
  entry.unionVerts = Int32Array.from(verts)
}

function setEntryZones(entry, zones) {
  const wanted = new Map(zones.map((z) => [z.id, z]))
  let changed = false
  for (const id of [...entry.zones.keys()]) {
    if (!wanted.has(id)) {
      entry.zones.delete(id)
      changed = true
    }
  }
  for (const cfg of zones) {
    const have = entry.zones.get(cfg.id)
    if (have && have.structure === zoneStructure(cfg)) {
      have.cfg = cfg
      continue
    }
    entry.zones.set(cfg.id, buildZone(entry, cfg))
    changed = true
  }
  if (changed) {
    rebuildUnion(entry)
    restoreRest(entry)
  }
  return changed
}

function disposeEntry(mesh) {
  const entry = sc.entries.get(mesh)
  if (!entry) return
  sc.entries.delete(mesh)
  if (mesh.geometry === entry.geo) mesh.geometry = entry.orig
  entry.geo.dispose()
}

function closestSites(entry, targetEntry, sites, buckets, cellSize) {
  const nearest = new Map()
  for (const site of sites) {
    const x = entry.T0[3 * site]
    const y = entry.T0[3 * site + 1]
    const z = entry.T0[3 * site + 2]
    const cx = Math.floor(x / cellSize)
    const cy = Math.floor(y / cellSize)
    const cz = Math.floor(z / cellSize)
    let best = -1
    let bestD2 = cellSize * cellSize
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const candidates = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`)
          if (!candidates) continue
          for (const candidate of candidates) {
            const ox = x - targetEntry.T0[3 * candidate]
            const oy = y - targetEntry.T0[3 * candidate + 1]
            const oz = z - targetEntry.T0[3 * candidate + 2]
            const d2 = ox * ox + oy * oy + oz * oz
            if (d2 < bestD2) {
              best = candidate
              bestD2 = d2
            }
          }
        }
      }
    }
    if (best >= 0) nearest.set(site, best)
  }
  return nearest
}

function seamLinks(a, b) {
  if (a.entry === b.entry) return []
  // Match mutually nearest sites close enough to represent the same garment seam.
  const cellSize = Math.max(1e-5, Math.min(a.entry.unit, b.entry.unit) * 0.015)
  const buckets = new Map()
  for (const site of b.zone.aff) {
    const key = `${Math.floor(b.entry.T0[3 * site] / cellSize)},${Math.floor(b.entry.T0[3 * site + 1] / cellSize)},${Math.floor(b.entry.T0[3 * site + 2] / cellSize)}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(site)
    else buckets.set(key, [site])
  }
  const forward = closestSites(a.entry, b.entry, a.zone.aff, buckets, cellSize)

  const reverseBuckets = new Map()
  for (const site of a.zone.aff) {
    const key = `${Math.floor(a.entry.T0[3 * site] / cellSize)},${Math.floor(a.entry.T0[3 * site + 1] / cellSize)},${Math.floor(a.entry.T0[3 * site + 2] / cellSize)}`
    const bucket = reverseBuckets.get(key)
    if (bucket) bucket.push(site)
    else reverseBuckets.set(key, [site])
  }
  const reverse = closestSites(b.entry, a.entry, b.zone.aff, reverseBuckets, cellSize)
  const links = []
  for (const [siteA, siteB] of forward) {
    if (reverse.get(siteB) === siteA) links.push({ a: { entry: a.entry, site: siteA }, b: { entry: b.entry, site: siteB } })
  }
  return links
}

// Work out, for every effect, what it is attached to: its held vertices (a locked top, the hinge row of
// a swing) against the vertices another effect moves, on this part or another part of the same
// character, at the same place. Done when effects change, not per frame.
const ATTACH_TOL = 0.04 // of a character's height-ish unit: close enough to count as joined
const ATTACH_CAP = 0.15 // ...and the furthest a join is ever looked for unless asked

// A sparse (low-poly) part has few vertices, so the nearest one can be a good way off: the range grows
// with how far apart that part's vertices are.
function meanEdge(entry) {
  if (entry.meanEdgeLen != null) return entry.meanEdgeLen
  const { graph, T0 } = entry
  let total = 0
  let count = 0
  for (let s = 0; s < entry.sites.count; s++) {
    for (let e = graph.start[s]; e < graph.start[s + 1]; e++) {
      const t = graph.adj[e]
      if (t <= s) continue
      total += Math.hypot(T0[3 * s] - T0[3 * t], T0[3 * s + 1] - T0[3 * t + 1], T0[3 * s + 2] - T0[3 * t + 2])
      count++
    }
  }
  entry.meanEdgeLen = count ? total / count : 0
  return entry.meanEdgeLen
}

function rebuildAttach() {
  const entries = [...sc.entries.values()]
  for (const entry of entries) {
    entry.zoneOrder = [...entry.zones.values()]
    prepareFrame(entry)
  }
  const cands = []
  let cell = 0
  for (const entry of entries) {
    cell = Math.max(cell, ATTACH_CAP * entry.unit)
    for (const zr of entry.zones.values()) cell = Math.max(cell, (zr.cfg.attachRange ?? 0) * entry.unit)
  }
  if (!(cell > 0)) return
  const buckets = new Map()
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
  const at = new THREE.Vector3()
  for (const entry of entries) {
    for (const zr of entry.zones.values()) {
      for (let i = 0; i < zr.aff.length; i++) {
        const site = zr.aff[i]
        targetOf(entry, entry.sites.rep[site], at)
        const c = { entry, site, zr, x: at.x, y: at.y, z: at.z }
        cands.push(c)
        const k = key(c.x, c.y, c.z)
        const list = buckets.get(k)
        if (list) list.push(c)
        else buckets.set(k, [c])
      }
    }
  }
  const nearest = (entry, site, zr) => {
    targetOf(entry, entry.sites.rep[site], at)
    const base = (zr.cfg.attachRange ?? ATTACH_TOL) * entry.unit
    const cap = Math.max(ATTACH_CAP * entry.unit, base)
    let best = null
    let bestD2 = cap * cap
    const cx = Math.floor(at.x / cell)
    const cy = Math.floor(at.y / cell)
    const cz = Math.floor(at.z / cell)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`)
          if (!list) continue
          for (const c of list) {
            if (c.zr === zr) continue // not to itself
            const d2 = (c.x - at.x) ** 2 + (c.y - at.y) ** 2 + (c.z - at.z) ** 2
            if (d2 >= bestD2) continue
            const reach = Math.min(cap, Math.max(base, 0.75 * meanEdge(c.entry)))
            if (d2 < reach * reach) {
              best = c
              bestD2 = d2
            }
          }
        }
      }
    }
    return best ? { entry: best.entry, site: best.site } : null
  }
  void cands
  for (const entry of entries) {
    for (const zr of entry.zones.values()) {
      zr.attach = []
      if (zr.mode === 'swing') {
        for (const comp of zr.comps) {
          comp.hingeLinks = Array.from(comp.topBand, (i) => nearest(entry, zr.aff[i], zr))
          // a piece that hangs from another part is held and bends from the join, like one that is
          // joined within its own part; a loose one is a single rigid body
          comp.attached = comp.joinedPiece || comp.hangs || comp.hingeLinks.some(Boolean)
          comp.ramp = comp.attached ? comp.rampAttached : 0
        }
      } else {
        for (const site of zr.lockedSites) {
          const link = nearest(entry, site, zr)
          if (link) zr.attach.push({ ...link, from: site })
        }
      }
    }
    // effects that hang from another effect go after the ones they hang from
    const dependent = (zr) => (zr.mode === 'swing' ? zr.comps.some((c) => c.hingeLinks.some(Boolean)) : zr.attach.length > 0)
    entry.zoneOrder.sort((a, b) => Number(dependent(a)) - Number(dependent(b)))
  }
  // entries with dependent effects go last in the frame
  sc.entries = new Map(
    [...sc.entries].sort(
      (a, b) => Number(a[1].zoneOrder.some((z) => z.attach.length)) - Number(b[1].zoneOrder.some((z) => z.attach.length)),
    ),
  )
}

function rebuildCouplings() {
  const grouped = new Map()
  for (const entry of sc.entries.values()) {
    for (const zone of entry.zones.values()) {
      const id = zone.cfg.couplingGroup
      if (!id || !zone.cfg.couplingMode) continue
      let group = grouped.get(id)
      if (!group) {
        group = { id, mode: zone.cfg.couplingMode, parts: [] }
        grouped.set(id, group)
      }
      group.parts.push({ entry, zone })
    }
  }
  sc.couplings = []
  for (const group of grouped.values()) {
    if (group.parts.length < 2) continue
    if (group.mode === 'seams') {
      group.links = []
      for (let i = 0; i < group.parts.length; i++) {
        for (let j = i + 1; j < group.parts.length; j++) {
          group.links.push(...seamLinks(group.parts[i], group.parts[j]))
        }
      }
    }
    sc.couplings.push(group)
  }
}

function applyCouplings() {
  for (const group of sc.couplings) {
    if (group.mode === 'rigid') {
      const sites = new Map()
      for (const { entry, zone } of group.parts) {
        for (const site of zone.aff) sites.set(entry, (sites.get(entry) || new Set()).add(site))
      }
      let x = 0
      let y = 0
      let z = 0
      let count = 0
      for (const [entry, partSites] of sites) {
        for (const site of partSites) {
          x += entry.siteD[3 * site]
          y += entry.siteD[3 * site + 1]
          z += entry.siteD[3 * site + 2]
          count++
        }
      }
      if (!count) continue
      x /= count
      y /= count
      z /= count
      for (const [entry, partSites] of sites) {
        for (const site of partSites) {
          entry.siteD[3 * site] = x
          entry.siteD[3 * site + 1] = y
          entry.siteD[3 * site + 2] = z
        }
      }
    } else if (group.mode === 'seams') {
      const sums = new Map()
      const add = (ref, other) => {
        let value = sums.get(ref.entry)
        if (!value) {
          value = new Map()
          sums.set(ref.entry, value)
        }
        let total = value.get(ref.site)
        if (!total) {
          total = [0, 0, 0, 0]
          value.set(ref.site, total)
        }
        total[0] += other.entry.siteD[3 * other.site]
        total[1] += other.entry.siteD[3 * other.site + 1]
        total[2] += other.entry.siteD[3 * other.site + 2]
        total[3]++
      }
      for (const link of group.links) {
        add(link.a, link.b)
        add(link.b, link.a)
      }
      for (const [entry, sites] of sums) {
        for (const [site, [x, y, z, count]] of sites) {
          entry.siteD[3 * site] = (entry.siteD[3 * site] + x) / (count + 1)
          entry.siteD[3 * site + 1] = (entry.siteD[3 * site + 1] + y) / (count + 1)
          entry.siteD[3 * site + 2] = (entry.siteD[3 * site + 2] + z) / (count + 1)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Make the running effects match the saved zones. `groups` = [{ meshes, overrides }] for every
// character and prop (overrides = that map of per-part settings; its `softZones` is what matters).
// Meshes no longer in any group (or with no zones left) are put back to normal.
export function syncSoftCloth(groups) {
  const keep = new Set()
  const nextMeshes = [...new Set((groups || []).flatMap(({ meshes }) => meshes || []))]
  if (nextMeshes.length !== sc.meshes.length || nextMeshes.some((mesh) => !sc.meshes.includes(mesh))) {
    sc.meshes = nextMeshes
    sc.colliderCache.clear()
  }
  let structural = false // anything that changes what is attached to what (a slider drag does not)
  for (const { meshes, overrides } of groups) {
    for (const mesh of meshes || []) {
      const zones = ((overrides && overrides[mesh.uuid] && overrides[mesh.uuid].softZones) || []).filter((z) => z && z.enabled !== false)
      let entry = sc.entries.get(mesh)
      if (!zones.length) continue
      if (entry && entry.geo !== mesh.geometry) {
        // someone else replaced the part's geometry (regions, mesh edits): start over from it
        sc.entries.delete(mesh)
        entry.geo.dispose()
        entry = null
        structural = true
      }
      if (!entry) {
        entry = buildEntry(mesh)
        if (!entry) continue
        sc.entries.set(mesh, entry)
        structural = true
      }
      keep.add(mesh)
      if (setEntryZones(entry, zones)) structural = true
    }
  }
  for (const mesh of [...sc.entries.keys()]) {
    if (!keep.has(mesh)) {
      disposeEntry(mesh)
      structural = true
    }
  }
  if (structural) rebuildAttach()
  rebuildCouplings()
  sc.requestRender()
}

// Put every part back to its clean pose without ending the effects (before something copies the
// geometry — materials, exports — and when playback stops).
export function restoreSoftRest() {
  for (const entry of sc.entries.values()) {
    if (entry.live) restoreRest(entry)
    for (const zr of entry.zones.values()) zr.ready = false
  }
}

export function clearSoftClothForMeshes(meshes) {
  const removed = new Set(meshes || [])
  for (const mesh of removed) disposeEntry(mesh)
  sc.meshes = sc.meshes.filter((mesh) => !removed.has(mesh))
  sc.colliderCache.clear()
  rebuildAttach()
  rebuildCouplings()
}

// Hold the effects off (clean pose, no overlay) while something is exported.
export function suspendSoftCloth() {
  sc.suspended = true
  restoreSoftRest()
  for (const o of sc.overlays.values()) o.visible = false
}

export function resumeSoftCloth() {
  sc.suspended = false
  for (const o of sc.overlays.values()) o.visible = true
}

// Zero the motion (a hard pose change, a restart).
export function resetSoftCloth(mesh = null, zoneId = null) {
  const entries = mesh ? [sc.entries.get(mesh)].filter(Boolean) : sc.entries.values()
  for (const entry of entries) {
    for (const [id, zr] of entry.zones) {
      if (zoneId && id !== zoneId) continue
      zr.ready = false
    }
  }
}

// Advance every effect by `dt` seconds, while playing.
function stepZoneFrame(entry, zr, dt) {
  fillTargets(entry, zr)
  const D = entry.siteD
  if (zr.mode === 'swing') {
    if (!zr.ready) resetZone(zr)
    if (dt > 0) {
      stepSwing(entry, zr, dt)
    } else {
      for (let i = 0; i < zr.aff.length; i++) {
        const s = zr.aff[i]
        D[3 * s] += zr.off[3 * i]
        D[3 * s + 1] += zr.off[3 * i + 1]
        D[3 * s + 2] += zr.off[3 * i + 2]
      }
    }
    return
  }
  // a soft zone: shift its targets by how far its attachment has moved, then simulate
  const ho = zr.ho
  attachShift(entry, zr, ho)
  if (ho[0] !== 0 || ho[1] !== 0 || ho[2] !== 0) {
    const T = zr.T
    for (let i = 0; i < zr.aff.length; i++) {
      T[3 * i] += ho[0]
      T[3 * i + 1] += ho[1]
      T[3 * i + 2] += ho[2]
    }
  }
  if (!zr.ready) resetZone(zr)
  if (dt > 0) {
    const colliders = []
    if (zr.cfg.collideWithMeshes === true && entry.collider) colliders.push(entry.collider)
    if (zr.cfg.collideWithSelf === true && zr.selfCollider) colliders.push(zr.selfCollider)
    stepSoft(entry, zr, dt, colliders, entry.collisionThickness)
  } else {
    // no time passed: keep the last offsets where they are
    for (let i = 0; i < zr.aff.length; i++) {
      const s = zr.aff[i]
      D[3 * s] += zr.outD[3 * i]
      D[3 * s + 1] += zr.outD[3 * i + 1]
      D[3 * s + 2] += zr.outD[3 * i + 2]
    }
  }
  // held sites (a locked top) are not simulated, but they go where what they are attached to goes:
  // the ones that touch it exactly where it is drawn, the rest with the zone as a whole
  if (ho[0] !== 0 || ho[1] !== 0 || ho[2] !== 0 || zr.attach.length) {
    for (const s of zr.lockedSites) {
      D[3 * s] += ho[0]
      D[3 * s + 1] += ho[1]
      D[3 * s + 2] += ho[2]
    }
    zr.attach.forEach((link, k) => {
      const f = link.from
      D[3 * f] += zr.linkVals[3 * k] - ho[0]
      D[3 * f + 1] += zr.linkVals[3 * k + 1] - ho[1]
      D[3 * f + 2] += zr.linkVals[3 * k + 2] - ho[2]
    })
  }
}

// How far the vertices a soft zone is attached to (held sites: a locked top, a pinned edge) have been
// moved by OTHER effects this frame, as one shift for the whole zone. The zone moves with it, and its own
// springs work on top. Without this a part that hangs from another part (drawstrings on a hood) stays
// where the plain pose puts it while the part it hangs from bounces away.
const _ls1 = new THREE.Vector3()
const _ls2 = new THREE.Vector3()

// Where a held vertex goes because of what it is attached to: that vertex's displacement, and, with
// "pull the join together", also the gap between the two at the pose, so they meet exactly.
function linkShift(entry, site, link, close, out, o = 0) {
  const D = link.entry.siteD
  out[o] = D[3 * link.site]
  out[o + 1] = D[3 * link.site + 1]
  out[o + 2] = D[3 * link.site + 2]
  if (close) {
    targetOf(link.entry, link.entry.sites.rep[link.site], _ls1)
    targetOf(entry, entry.sites.rep[site], _ls2)
    out[o] += _ls1.x - _ls2.x
    out[o + 1] += _ls1.y - _ls2.y
    out[o + 2] += _ls1.z - _ls2.z
  }
}

function attachShift(entry, zr, out) {
  out[0] = 0
  out[1] = 0
  out[2] = 0
  let count = 0
  const close = zr.cfg.closeGap === true
  if (!zr.linkVals || zr.linkVals.length !== 3 * zr.attach.length) zr.linkVals = new Float32Array(3 * zr.attach.length)
  zr.attach.forEach((link, k) => {
    linkShift(entry, link.from, link, close, zr.linkVals, 3 * k)
    out[0] += zr.linkVals[3 * k]
    out[1] += zr.linkVals[3 * k + 1]
    out[2] += zr.linkVals[3 * k + 2]
    count++
  })
  if (count) {
    out[0] /= count
    out[1] /= count
    out[2] /= count
  }
  return count
}

export function stepSoftCloth(dt) {
  if (sc.suspended || !sc.entries.size) return
  sc.frame++
  const clamped = Math.min(Math.max(dt || 0, 0), MAX_DT)
  const active = []
  for (const entry of sc.entries.values()) {
    if (!entry.unionVerts.length) continue
    prepareFrame(entry)
    entry.siteD.fill(0)
    active.push(entry)
  }
  const collidersByRoot = new Map()
  for (const entry of active) {
    const zones = [...entry.zones.values()].filter((zr) => zr.mode === 'soft')
    entry.collisionThickness = entry.unit * 0.008
    const needsCollider = zones.some((zr) => zr.cfg.collideWithMeshes === true)
    if (!needsCollider) {
      entry.collider = null
      continue
    }
    let collider = collidersByRoot.get(entry.mesh)
    if (collidersByRoot.has(entry.mesh)) {
      entry.collider = collider
      continue
    }
    let cache = sc.colliderCache.get(entry.mesh)
    if (!cache) {
      cache = { collider: null, refreshedAt: -Infinity }
      sc.colliderCache.set(entry.mesh, cache)
    }
    const refresh = !cache.collider || sc.frame - cache.refreshedAt >= 3
    if (refresh) {
      const others = sc.meshes.filter((mesh) => {
        if (!mesh || mesh === entry.mesh || !mesh.isMesh || !mesh.geometry?.getAttribute?.('position')) return false
        if (topAncestor(mesh) !== entry.root) return false
        for (let parent = mesh; parent; parent = parent.parent) if (!parent.visible) return false
        return true
      })
      const geometry = mergeWorldGeometry(others, 4000)
      if (geometry) {
        cache.collider = new BodyCollider(geometry, entry.collisionThickness)
        cache.refreshedAt = sc.frame
        geometry.dispose()
      } else {
        cache.collider = null
      }
    }
    collider = cache.collider
    entry.collisionThickness = entry.unit * 0.008
    entry.collider = collider
    collidersByRoot.set(entry.mesh, collider)
  }
  for (const entry of active) {
    for (const zr of entry.zones.values()) {
      if (zr.mode !== 'soft' || zr.cfg.collideWithSelf !== true) {
        zr.selfCollider = null
        continue
      }
      if (sc.frame - zr.selfColliderFrame < 3) continue
      const geometry = mergeWorldGeometry(
        [entry.mesh],
        2000,
        (mesh, face) => {
          const index = mesh.geometry.index
          for (let corner = 0; corner < 3; corner++) {
            const vertex = index ? index.getX(face * 3 + corner) : face * 3 + corner
            const site = entry.sites.siteOf[vertex]
            if (zr.core[site] || zr.local[site] >= 0) return false
          }
          return true
        },
      )
      zr.selfCollider = geometry ? new BodyCollider(geometry, entry.unit * 0.008) : null
      zr.selfColliderFrame = sc.frame
      geometry?.dispose()
    }
  }
  // Soft cloth first, then swings; within each, the effects that hang from nothing go before the ones
  // that hang from another effect, so those see where it is DRAWN this frame.
  for (const wantSwing of [false, true]) {
    for (const entry of active) {
      for (const zr of entry.zoneOrder || entry.zones.values()) {
        if ((zr.mode === 'swing') !== wantSwing) continue
        stepZoneFrame(entry, zr, clamped)
      }
    }
  }
  applyCouplings()
  for (const entry of sc.entries.values()) {
    if (!entry.unionVerts.length) continue
    writeOffsets(entry)
    entry.live = true
  }
  sc.requestRender()
}

// Not playing (paused, scrubbed, posed): the clean pose.
export function settleSoftCloth() {
  if (!sc.entries.size) return
  let any = false
  for (const entry of sc.entries.values()) {
    if (entry.live) {
      restoreRest(entry)
      any = true
    }
    for (const zr of entry.zones.values()) zr.ready = false
  }
  if (any) sc.requestRender()
}

// ---------------------------------------------------------------------------
// A highlight of an area on a part (also for skinned parts, which follow the skeleton)
// ---------------------------------------------------------------------------

export function setSoftOverlay(mesh, tris, color = 0xff2bd6) {
  const old = sc.overlays.get(mesh)
  if (old) {
    if (old.parent) old.parent.remove(old)
    old.geometry.dispose()
    old.material.dispose()
    sc.overlays.delete(mesh)
  }
  if (!mesh || !tris || !tris.length) {
    if (old) sc.requestRender() // the highlight went away: the on-demand viewport has to draw that too
    return
  }
  const entry = sc.entries.get(mesh)
  const geo0 = entry ? entry.orig : mesh.geometry
  const pos = geo0.attributes.position
  const index = geo0.index
  const skinIndex = geo0.getAttribute('skinIndex')
  const skinWeight = geo0.getAttribute('skinWeight')
  const skinned = !!(mesh.isSkinnedMesh && skinIndex && skinWeight && mesh.skeleton)
  const arr = new Float32Array(tris.length * 9)
  const si = skinned ? new Float32Array(tris.length * 12) : null
  const sw = skinned ? new Float32Array(tris.length * 12) : null
  let o = 0
  let q = 0
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const v = index ? index.getX(t * 3 + k) : t * 3 + k
      arr[o++] = pos.getX(v)
      arr[o++] = pos.getY(v)
      arr[o++] = pos.getZ(v)
      if (skinned) {
        for (let c = 0; c < 4; c++) {
          si[q] = skinIndex.getComponent(v, c)
          sw[q] = skinWeight.getComponent(v, c)
          q++
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3))
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
  })
  material.userData.outlineParameters = { visible: false }
  let overlay
  if (skinned) {
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4))
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
    overlay = new THREE.SkinnedMesh(geo, material)
    overlay.position.copy(mesh.position)
    overlay.quaternion.copy(mesh.quaternion)
    overlay.scale.copy(mesh.scale)
    overlay.bind(mesh.skeleton, mesh.bindMatrix)
    ;(mesh.parent || mesh).add(overlay)
  } else {
    overlay = new THREE.Mesh(geo, material)
    mesh.add(overlay)
  }
  overlay.userData.isSoftOverlay = true
  overlay.raycast = () => {}
  overlay.frustumCulled = false
  overlay.renderOrder = 10
  sc.overlays.set(mesh, overlay)
  sc.requestRender()
}

// Triangle indices covered by a list of [first, last] ranges.
export function trisOfRanges(ranges) {
  const out = []
  for (const [a, b] of ranges || []) for (let t = a; t <= b; t++) out.push(t)
  return out
}
