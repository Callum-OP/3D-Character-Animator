// ---------------------------------------------------------------------------
// Part rigging maths (no three.js, no scene): given the faces someone picked on a skinned mesh
// (a hair strand, a hood, a cape...), work out
//   - where a chain of new bones should sit, and
//   - how every vertex of those faces should be skinned to the new bones.
//
// Everything is in BIND space (the space the skeleton's bone-inverse matrices live in), so the
// result does not depend on whatever pose the character happens to be in.
//
// How it works, in plain words:
//   1. The picked faces are split into separate pieces (each hair card, a cape...). Each piece
//      becomes its own chain, or all pieces share one when `perPiece` is false.
//   2. Each piece gets a "root": the faces that touch the rest of the mesh (the seam where a
//      hood joins a jacket), or, for a free-standing piece, the end closest to the bone it hangs
//      from. Distance along the surface from the root (t = 0..1) says how far down the chain a
//      vertex is. "Hangs down" uses height instead.
//   3. Bones sit at the weighted centre of each slice. `columns` > 1 splits the piece across its
//      width as well (a cape gets several side-by-side chains).
//   4. Each vertex is skinned to the (up to) four nearest bones, blended back into its ORIGINAL
//      skinning near the root, so the top stays glued to the body exactly as before and nothing
//      tears where the piece joins the rest of the mesh.
//   5. Vertices at the same position (UV / normal seams) always get the same weights, so no
//      cracks open along a seam when the chain moves.
// ---------------------------------------------------------------------------

export const LIMITS = { maxSegments: 24, maxColumns: 8, maxBones: 96 }

export const DEFAULT_OPTIONS = {
  segments: 5, // bones per chain
  columns: 1, // chains side by side
  direction: 'shape', // 'shape' = follow the piece away from where it attaches, 'down' = hang by height
  flip: false, // swap which end is the root (direction 'shape' only)
  stick: 0.15, // 0..0.6 — how much of the top keeps its original skinning
  influence: 1, // 0..1 — how strongly the new bones replace the original skinning
  includeNearbySurfaces: false,
  nearbySurfaceDistance: 0.02, // fraction of the mesh bounds, for disconnected inner/outer layers
  perPiece: true,
  parentBone: null, // bone index to hang from; null = work it out from the existing skinning
}

const QUANT = 1e4

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const smooth = (x) => x * x * (3 - 2 * x)

export function normaliseOptions(opts = {}) {
  const o = { ...DEFAULT_OPTIONS, ...opts }
  o.segments = clamp(Math.round(o.segments) || 1, 1, LIMITS.maxSegments)
  o.columns = clamp(Math.round(o.columns) || 1, 1, LIMITS.maxColumns)
  o.stick = clamp(Number.isFinite(o.stick) ? o.stick : 0.15, 0, 0.6)
  o.influence = clamp(Number.isFinite(o.influence) ? o.influence : 1, 0, 1)
  o.nearbySurfaceDistance = clamp(Number.isFinite(o.nearbySurfaceDistance) ? o.nearbySurfaceDistance : 0.02, 0, 0.1)
  o.includeNearbySurfaces = !!o.includeNearbySurfaces
  o.direction = o.direction === 'down' ? 'down' : 'shape'
  o.flip = !!o.flip
  o.perPiece = o.perPiece !== false
  return o
}

// positions: flat [x,y,z,...] in BIND space. index: flat triangle index array or null (triangle t = verts 3t..3t+2).
// tris: triangle numbers picked. skinIndex / skinWeight: flat 4-per-vertex arrays.
// boneBind(i) -> [x,y,z] bind-space position of existing bone i (or null).
export function planPartRig({ positions, index, tris, skinIndex, skinWeight, boneBind, options }) {
  const o = normaliseOptions(options)
  const nVerts = positions.length / 3
  const triVert = (t, k) => (index ? index[t * 3 + k] : t * 3 + k)
  const nTris = Math.floor((index ? index.length : nVerts) / 3)
  let picked = Array.from(new Set(tris)).filter((t) => t >= 0 && t < nTris)
  if (!picked.length) return { ok: false, reason: 'No faces selected.' }
  if (o.includeNearbySurfaces && o.nearbySurfaceDistance > 0) {
    picked = includeNearbyFaces(positions, index, picked, nVerts, nTris, o.nearbySurfaceDistance)
  }

  // --- weld: vertices at the same place share one id -----------------------
  const weldOf = new Int32Array(nVerts)
  const firstAt = new Map()
  for (let v = 0; v < nVerts; v++) {
    const key = Math.round(positions[v * 3] * QUANT) + ',' + Math.round(positions[v * 3 + 1] * QUANT) + ',' + Math.round(positions[v * 3 + 2] * QUANT)
    const seen = firstAt.get(key)
    if (seen === undefined) {
      firstAt.set(key, v)
      weldOf[v] = v
    } else weldOf[v] = seen
  }

  const pickedSet = new Set(picked)

  // --- seam: welded edges the picked faces share with faces that were NOT picked ---
  const edgeKey = (a, b) => (a < b ? a * nVerts + b : b * nVerts + a)
  const edgeInPicked = new Set()
  for (const t of picked) {
    for (let k = 0; k < 3; k++) {
      const a = weldOf[triVert(t, k)]
      const b = weldOf[triVert(t, (k + 1) % 3)]
      if (a !== b) edgeInPicked.add(edgeKey(a, b))
    }
  }
  const seamWelds = new Set()
  for (let t = 0; t < nTris; t++) {
    if (pickedSet.has(t)) continue
    for (let k = 0; k < 3; k++) {
      const a = weldOf[triVert(t, k)]
      const b = weldOf[triVert(t, (k + 1) % 3)]
      if (a !== b && edgeInPicked.has(edgeKey(a, b))) {
        seamWelds.add(a)
        seamWelds.add(b)
      }
    }
  }

  // --- pieces: connected groups of picked faces ---------------------------------
  const parent = new Map()
  const find = (x) => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)
    while (parent.get(x) !== r) {
      const n = parent.get(x)
      parent.set(x, r)
      x = n
    }
    return r
  }
  for (const t of picked) for (let k = 0; k < 3; k++) { const w = weldOf[triVert(t, k)]; if (!parent.has(w)) parent.set(w, w) }
  for (const t of picked) {
    const a = find(weldOf[triVert(t, 0)])
    for (let k = 1; k < 3; k++) {
      const b = find(weldOf[triVert(t, k)])
      if (a !== b) parent.set(b, a)
    }
  }
  const pieceTris = new Map()
  for (const t of picked) {
    const r = find(weldOf[triVert(t, 0)])
    if (!pieceTris.has(r)) pieceTris.set(r, [])
    pieceTris.get(r).push(t)
  }
  let pieces = Array.from(pieceTris.values())
  // A speck of a few faces next to a big piece is not worth a chain of its own.
  if (pieces.length > 1) {
    const biggest = Math.max(...pieces.map((p) => p.length))
    pieces = pieces.filter((p) => p.length >= Math.max(2, biggest * 0.02))
  }
  if (!o.perPiece && pieces.length > 1) pieces = [pieces.flat()]

  // Every vertex (not welded id) that must be re-skinned = those at a position the picked faces use.
  const pickedWelds = new Set()
  for (const t of picked) for (let k = 0; k < 3; k++) pickedWelds.add(weldOf[triVert(t, k)])
  const verticesAt = new Map() // weld id -> [vertex ids]
  for (let v = 0; v < nVerts; v++) {
    const w = weldOf[v]
    if (!pickedWelds.has(w)) continue
    if (!verticesAt.has(w)) verticesAt.set(w, [])
    verticesAt.get(w).push(v)
  }

  const bones = [] // { piece, col, seg, parentLocal (-1 = the existing bone), parentBone, world }
  const weights = new Map() // vertex -> { slots: [4], w: [4] } ; slot >= 0 existing bone, slot < 0 new bone (-1 - index)
  const pieceInfo = []

  for (const faceList of pieces) {
    if (bones.length >= LIMITS.maxBones) break
    const pieceIdx = pieceInfo.length

    // welded vertices + their positions
    const welds = []
    const slotOf = new Map()
    for (const t of faceList) for (let k = 0; k < 3; k++) {
      const w = weldOf[triVert(t, k)]
      if (!slotOf.has(w)) { slotOf.set(w, welds.length); welds.push(w) }
    }
    const n = welds.length
    const P = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) {
      P[i * 3] = positions[welds[i] * 3]
      P[i * 3 + 1] = positions[welds[i] * 3 + 1]
      P[i * 3 + 2] = positions[welds[i] * 3 + 2]
    }

    // edge graph over this piece
    const adj = Array.from({ length: n }, () => [])
    const addEdge = (a, b) => {
      if (a === b) return
      const dx = P[a * 3] - P[b * 3]
      const dy = P[a * 3 + 1] - P[b * 3 + 1]
      const dz = P[a * 3 + 2] - P[b * 3 + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      adj[a].push([b, d])
      adj[b].push([a, d])
    }
    for (const t of faceList) {
      const a = slotOf.get(weldOf[triVert(t, 0)])
      const b = slotOf.get(weldOf[triVert(t, 1)])
      const c = slotOf.get(weldOf[triVert(t, 2)])
      addEdge(a, b); addEdge(b, c); addEdge(c, a)
    }

    // which existing bone does this piece hang from?
    let parentBone = o.parentBone
    if (parentBone == null || parentBone < 0) {
      const sums = new Map()
      for (const w of welds) {
        for (const v of verticesAt.get(w) || [w]) {
          for (let k = 0; k < 4; k++) {
            const wt = skinWeight[v * 4 + k]
            if (wt > 0) sums.set(skinIndex[v * 4 + k], (sums.get(skinIndex[v * 4 + k]) || 0) + wt)
          }
        }
      }
      let best = -1
      let bestW = -1
      for (const [b, wt] of sums) if (wt > bestW) { best = b; bestW = wt }
      parentBone = best
    }
    if (parentBone == null || parentBone < 0) return { ok: false, reason: 'This part has no skinning to attach to.' }
    const anchor = boneBind(parentBone)
    if (!anchor) return { ok: false, reason: 'The bone to attach to is not part of this mesh’s skeleton.' }

    // bounds
    let ymin = Infinity, ymax = -Infinity
    for (let i = 0; i < n; i++) { ymin = Math.min(ymin, P[i * 3 + 1]); ymax = Math.max(ymax, P[i * 3 + 1]) }
    const height = Math.max(ymax - ymin, 1e-9)

    // roots
    const seamHere = []
    for (let i = 0; i < n; i++) if (seamWelds.has(welds[i])) seamHere.push(i)
    const useSeam = seamHere.length > 0 && seamHere.length < n
    let rootSet
    if (useSeam) rootSet = seamHere
    else if (o.direction === 'down') {
      rootSet = []
      for (let i = 0; i < n; i++) if (P[i * 3 + 1] >= ymax - height * 0.05) rootSet.push(i)
    } else {
      const d = new Float64Array(n)
      let dmin = Infinity, dmax = -Infinity
      for (let i = 0; i < n; i++) {
        const dx = P[i * 3] - anchor[0], dy = P[i * 3 + 1] - anchor[1], dz = P[i * 3 + 2] - anchor[2]
        d[i] = Math.sqrt(dx * dx + dy * dy + dz * dz) * (o.flip ? -1 : 1)
        dmin = Math.min(dmin, d[i]); dmax = Math.max(dmax, d[i])
      }
      rootSet = []
      for (let i = 0; i < n; i++) if (d[i] <= dmin + (dmax - dmin) * 0.08) rootSet.push(i)
    }
    if (!rootSet.length) rootSet = [0]

    const geo = dijkstra(adj, n, rootSet)
    let gmax = 0
    for (let i = 0; i < n; i++) if (Number.isFinite(geo[i])) gmax = Math.max(gmax, geo[i])
    gmax = Math.max(gmax, 1e-9)
    const t = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      if (o.direction === 'down') t[i] = clamp((ymax - P[i * 3 + 1]) / height, 0, 1)
      else t[i] = Number.isFinite(geo[i]) ? clamp(geo[i] / gmax, 0, 1) : 1
    }

    // how strongly the top stays glued: distance from the pinned edge
    const pin = useSeam ? geo : dijkstra(adj, n, rootSet)
    let pinMax = 0
    for (let i = 0; i < n; i++) if (Number.isFinite(pin[i])) pinMax = Math.max(pinMax, pin[i])
    pinMax = Math.max(pinMax, 1e-9)
    const mix = new Float64Array(n) // 0 = keep original skinning, 1 = fully the new chain
    for (let i = 0; i < n; i++) {
      if (o.stick <= 0) mix[i] = 1
      else mix[i] = smooth(clamp((Number.isFinite(pin[i]) ? pin[i] / pinMax : 1) / o.stick, 0, 1))
      mix[i] *= o.influence
    }

    // lateral coordinate for several chains side by side
    const segs = o.segments
    const cols = Math.min(o.columns, Math.max(1, Math.floor((LIMITS.maxBones - bones.length) / segs)))
    const uf = new Float64Array(n)
    if (cols > 1) {
      let mx = 0, my = 0, mz = 0
      for (let i = 0; i < n; i++) { mx += P[i * 3]; my += P[i * 3 + 1]; mz += P[i * 3 + 2] }
      mx /= n; my /= n; mz /= n
      // length axis: from the early part of the piece to the late part
      const lo = [0, 0, 0], hi = [0, 0, 0]
      let nl = 0, nh = 0
      for (let i = 0; i < n; i++) {
        if (t[i] < 0.25) { lo[0] += P[i * 3]; lo[1] += P[i * 3 + 1]; lo[2] += P[i * 3 + 2]; nl++ }
        if (t[i] > 0.75) { hi[0] += P[i * 3]; hi[1] += P[i * 3 + 1]; hi[2] += P[i * 3 + 2]; nh++ }
      }
      let ax = [0, -1, 0]
      if (nl && nh) ax = norm3([hi[0] / nh - lo[0] / nl, hi[1] / nh - lo[1] / nl, hi[2] / nh - lo[2] / nl]) || ax
      const b = lateralAxis(P, n, [mx, my, mz], ax)
      const u = new Float64Array(n)
      for (let i = 0; i < n; i++) u[i] = (P[i * 3] - mx) * b[0] + (P[i * 3 + 1] - my) * b[1] + (P[i * 3 + 2] - mz) * b[2]
      const sorted = Array.from(u).sort((p, q) => p - q)
      const ulo = sorted[Math.floor((n - 1) * 0.02)]
      const uhi = sorted[Math.ceil((n - 1) * 0.98)]
      const span = Math.max(uhi - ulo, 1e-9)
      for (let i = 0; i < n; i++) uf[i] = clamp((u[i] - ulo) / span, 0, 1) * (cols - 1)
    }

    // bilinear chain influences for each vertex
    const infl = new Array(n)
    for (let i = 0; i < n; i++) {
      const sf = segs > 1 ? Math.min(t[i] * segs, segs - 1) : 0
      const j0 = Math.floor(sf)
      const fj = sf - j0
      const j1 = Math.min(j0 + 1, segs - 1)
      const c0 = Math.min(Math.floor(uf[i]), cols - 1)
      const fc = uf[i] - c0
      const c1 = Math.min(c0 + 1, cols - 1)
      const e = []
      const add = (c, j, w) => { if (w > 1e-6) e.push([c * segs + j, w]) }
      add(c0, j0, (1 - fc) * (1 - fj))
      add(c0, j1, (1 - fc) * fj)
      add(c1, j0, fc * (1 - fj))
      add(c1, j1, fc * fj)
      infl[i] = mergeEntries(e)
    }

    // bone positions: weighted centre of what each bone controls
    const base = bones.length
    const bonePos = []
    for (let c = 0; c < cols; c++) {
      for (let j = 0; j < segs; j++) {
        const local = c * segs + j
        let sx = 0, sy = 0, sz = 0, sw = 0
        for (let i = 0; i < n; i++) {
          if (j === 0 && t[i] > 0.08) continue // the first bone sits at the root edge, not the middle of its slice
          for (const [li, w] of infl[i]) {
            if (li !== local) continue
            sx += P[i * 3] * w; sy += P[i * 3 + 1] * w; sz += P[i * 3 + 2] * w; sw += w
          }
        }
        bonePos[local] = sw > 1e-9 ? [sx / sw, sy / sw, sz / sw] : null
      }
    }
    fillGaps(bonePos, cols, segs, [P[0], P[1], P[2]])
    for (let c = 0; c < cols; c++) {
      for (let j = 0; j < segs; j++) {
        const local = c * segs + j
        bones.push({ piece: pieceIdx, col: c, seg: j, parentLocal: j === 0 ? -1 : base + local - 1, parentBone, world: bonePos[local] })
      }
    }

    // vertex weights
    for (let i = 0; i < n; i++) {
      for (const v of verticesAt.get(welds[i]) || [welds[i]]) {
        const acc = new Map()
        const m = mix[i]
        if (m < 1) {
          for (let k = 0; k < 4; k++) {
            const wt = skinWeight[v * 4 + k]
            if (wt > 0) acc.set(skinIndex[v * 4 + k], (acc.get(skinIndex[v * 4 + k]) || 0) + wt * (1 - m))
          }
        }
        if (m > 0) for (const [li, w] of infl[i]) acc.set(-1 - (base + li), (acc.get(-1 - (base + li)) || 0) + w * m)
        weights.set(v, topFour(acc))
      }
    }
    pieceInfo.push({ parentBone, boneStart: base, boneCount: cols * segs, columns: cols, faces: faceList.length })
  }

  if (!bones.length) return { ok: false, reason: 'Nothing to rig.' }
  return { ok: true, bones, weights, pieces: pieceInfo, options: o }
}

function includeNearbyFaces(positions, index, picked, nVerts, nTris, distanceFraction) {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let v = 0; v < nVerts; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2]
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z)
  }
  const radius = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * distanceFraction
  if (!(radius > 0)) return picked

  const cellKey = (x, y, z) => `${x},${y},${z}`
  const cell = (v) => [
    Math.floor(positions[v * 3] / radius),
    Math.floor(positions[v * 3 + 1] / radius),
    Math.floor(positions[v * 3 + 2] / radius),
  ]
  const nearby = new Map()
  const selectedVertices = new Set()
  for (const tri of picked) {
    for (let corner = 0; corner < 3; corner++) {
      const v = index ? index[tri * 3 + corner] : tri * 3 + corner
      selectedVertices.add(v)
    }
  }
  for (const v of selectedVertices) {
    const [x, y, z] = cell(v)
    const key = cellKey(x, y, z)
    if (!nearby.has(key)) nearby.set(key, [])
    nearby.get(key).push(v)
  }

  const closeToSelection = new Uint8Array(nVerts)
  const radiusSq = radius * radius
  for (let v = 0; v < nVerts; v++) {
    const [cx, cy, cz] = cell(v)
    for (let x = cx - 1; x <= cx + 1 && !closeToSelection[v]; x++) {
      for (let y = cy - 1; y <= cy + 1 && !closeToSelection[v]; y++) {
        for (let z = cz - 1; z <= cz + 1 && !closeToSelection[v]; z++) {
          for (const other of nearby.get(cellKey(x, y, z)) || []) {
            const dx = positions[v * 3] - positions[other * 3]
            const dy = positions[v * 3 + 1] - positions[other * 3 + 1]
            const dz = positions[v * 3 + 2] - positions[other * 3 + 2]
            if (dx * dx + dy * dy + dz * dz <= radiusSq) {
              closeToSelection[v] = 1
              break
            }
          }
        }
      }
    }
  }

  const expanded = new Set(picked)
  for (let tri = 0; tri < nTris; tri++) {
    if (expanded.has(tri)) continue
    let closeCorners = 0
    for (let corner = 0; corner < 3; corner++) {
      const v = index ? index[tri * 3 + corner] : tri * 3 + corner
      closeCorners += closeToSelection[v]
    }
    if (closeCorners >= 2) expanded.add(tri)
  }
  return Array.from(expanded)
}

function mergeEntries(e) {
  const m = new Map()
  for (const [k, w] of e) m.set(k, (m.get(k) || 0) + w)
  return Array.from(m.entries())
}

function topFour(acc) {
  const arr = Array.from(acc.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4)
  let sum = 0
  for (const [, w] of arr) sum += w
  const slots = [0, 0, 0, 0]
  const w = [0, 0, 0, 0]
  arr.forEach(([s, wt], k) => { slots[k] = s; w[k] = sum > 0 ? wt / sum : 0 })
  return { slots, w }
}

function dijkstra(adj, n, sources) {
  const dist = new Float64Array(n).fill(Infinity)
  // simple binary heap
  const heap = []
  const push = (d, v) => {
    heap.push([d, v])
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p][0] <= heap[i][0]) break
      ;[heap[p], heap[i]] = [heap[i], heap[p]]
      i = p
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1, r = l + 1
        let s = i
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r
        if (s === i) break
        ;[heap[s], heap[i]] = [heap[i], heap[s]]
        i = s
      }
    }
    return top
  }
  for (const s of sources) { dist[s] = 0; push(0, s) }
  while (heap.length) {
    const [d, v] = pop()
    if (d > dist[v]) continue
    for (const [u, w] of adj[v]) {
      const nd = d + w
      if (nd < dist[u]) { dist[u] = nd; push(nd, u) }
    }
  }
  return dist
}

function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2])
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : null
}

// The widest direction of the piece that is square-on to its length axis (power iteration).
function lateralAxis(P, n, mean, ax) {
  let b = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const d = b[0] * ax[0] + b[1] * ax[1] + b[2] * ax[2]
  b = norm3([b[0] - ax[0] * d, b[1] - ax[1] * d, b[2] - ax[2] * d]) || [1, 0, 0]
  for (let it = 0; it < 12; it++) {
    const nb = [0, 0, 0]
    for (let i = 0; i < n; i++) {
      let x = P[i * 3] - mean[0], y = P[i * 3 + 1] - mean[1], z = P[i * 3 + 2] - mean[2]
      const along = x * ax[0] + y * ax[1] + z * ax[2]
      x -= ax[0] * along; y -= ax[1] * along; z -= ax[2] * along
      const proj = x * b[0] + y * b[1] + z * b[2]
      nb[0] += x * proj; nb[1] += y * proj; nb[2] += z * proj
    }
    const nn = norm3(nb)
    if (!nn) break
    b = nn
  }
  return b
}

// A slice that no vertex reached borrows from its neighbours so every bone has a place.
function fillGaps(pos, cols, segs, fallback) {
  for (let c = 0; c < cols; c++) {
    for (let j = 0; j < segs; j++) {
      const i = c * segs + j
      if (pos[i]) continue
      let a = -1, b = -1
      for (let k = j - 1; k >= 0; k--) if (pos[c * segs + k]) { a = k; break }
      for (let k = j + 1; k < segs; k++) if (pos[c * segs + k]) { b = k; break }
      if (a >= 0 && b >= 0) {
        const f = (j - a) / (b - a)
        const pa = pos[c * segs + a], pb = pos[c * segs + b]
        pos[i] = [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f, pa[2] + (pb[2] - pa[2]) * f]
      } else if (a >= 0) pos[i] = [...pos[c * segs + a]]
      else if (b >= 0) pos[i] = [...pos[c * segs + b]]
    }
  }
  for (let i = 0; i < cols * segs; i++) {
    if (pos[i]) continue
    let best = null
    for (let k = 0; k < cols * segs; k++) if (pos[k]) { best = pos[k]; break }
    pos[i] = best ? [...best] : [...fallback]
  }
}
