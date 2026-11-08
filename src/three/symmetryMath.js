// Pure maths for mirroring / symmetrising a skinned mesh. No three.js, no scene: arrays in, arrays out,
// so it can be tested on tiny synthetic meshes.
//
// The hard part is knowing which vertex on one side belongs with which vertex on the other. Matching by
// position alone breaks the moment the two sides differ (a long arm on one side has nothing to land on),
// so the match is TOPOLOGICAL: a few vertices that do line up (the centre line, the torso) seed it, then it
// grows across the surface face by face, the way Blender's topology mirror does. Every vertex of a mesh
// that is shaped the same way on both sides gets a partner, however different the shapes now are.
//
// All positions here are in the character's own frame (X = left/right), mirrored across x = cx.

// --- welding ---------------------------------------------------------------------------------------------
// Vertices that sit at the same spot (UV seams, hard edges) are one point of the surface. The matching
// works on those points, and the result is mapped back to every vertex.
export function weldVertices(pos, eps) {
  const count = pos.length / 3
  const inv = 1 / Math.max(eps, 1e-9)
  const cells = new Map()
  const group = new Int32Array(count)
  const reps = []
  for (let v = 0; v < count; v++) {
    const key = `${Math.round(pos[v * 3] * inv)},${Math.round(pos[v * 3 + 1] * inv)},${Math.round(pos[v * 3 + 2] * inv)}`
    let g = cells.get(key)
    if (g === undefined) {
      g = reps.length
      cells.set(key, g)
      reps.push(v)
    }
    group[v] = g
  }
  const members = reps.map(() => [])
  for (let v = 0; v < count; v++) members[group[v]].push(v)
  const gpos = new Float32Array(reps.length * 3)
  reps.forEach((v, g) => {
    gpos[g * 3] = pos[v * 3]
    gpos[g * 3 + 1] = pos[v * 3 + 1]
    gpos[g * 3 + 2] = pos[v * 3 + 2]
  })
  return { group, count: reps.length, members, gpos }
}

// The surface as welded points + faces, with a lookup from a directed edge to the face that owns it.
export function buildGraph(pos, index, eps) {
  const weld = weldVertices(pos, eps)
  const triCount = Math.floor((index ? index.length : pos.length / 3) / 3)
  const faces = []
  const edges = new Map()
  const N = weld.count
  for (let t = 0; t < triCount; t++) {
    const a = weld.group[index ? index[t * 3] : t * 3]
    const b = weld.group[index ? index[t * 3 + 1] : t * 3 + 1]
    const c = weld.group[index ? index[t * 3 + 2] : t * 3 + 2]
    if (a === b || b === c || a === c) continue
    const f = faces.length
    faces.push([a, b, c])
    for (const [u, v, w] of [[a, b, c], [b, c, a], [c, a, b]]) {
      const key = u * N + v
      if (!edges.has(key)) edges.set(key, { f, w })
    }
  }
  const touching = Array.from({ length: N }, () => [])
  faces.forEach((f, i) => f.forEach((g) => touching[g].push(i)))
  // Which points share an edge. Triangulation differs between the two sides of many meshes (the diagonal of
  // a quad), so the matching below works on these links and not on whole faces.
  const nbr = Array.from({ length: N }, () => new Set())
  for (const [a, b, c] of faces) {
    nbr[a].add(b); nbr[a].add(c)
    nbr[b].add(a); nbr[b].add(c)
    nbr[c].add(a); nbr[c].add(b)
  }
  return { weld, faces, edges, touching, nbr, N }
}

// --- spatial lookup --------------------------------------------------------------------------------------
function makeGrid(gpos, count, cell) {
  const grid = new Map()
  const inv = 1 / cell
  for (let g = 0; g < count; g++) {
    const key = `${Math.floor(gpos[g * 3] * inv)},${Math.floor(gpos[g * 3 + 1] * inv)},${Math.floor(gpos[g * 3 + 2] * inv)}`
    let list = grid.get(key)
    if (!list) grid.set(key, (list = []))
    list.push(g)
  }
  return { grid, inv }
}

function nearest(grid, gpos, x, y, z, within) {
  const cx = Math.floor(x * grid.inv)
  const cy = Math.floor(y * grid.inv)
  const cz = Math.floor(z * grid.inv)
  let best = -1
  let bestD = within * within
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      for (let k = -1; k <= 1; k++) {
        const list = grid.grid.get(`${cx + i},${cy + j},${cz + k}`)
        if (!list) continue
        for (const g of list) {
          const dx = gpos[g * 3] - x
          const dy = gpos[g * 3 + 1] - y
          const dz = gpos[g * 3 + 2] - z
          const d = dx * dx + dy * dy + dz * dz
          if (d <= bestD) {
            bestD = d
            best = g
          }
        }
      }
    }
  }
  return best
}

// --- matching --------------------------------------------------------------------------------------------
/**
 * Pair every welded point of graph A with its mirror image in graph B (B === A for one mesh).
 * Returns { map, seeds } where map[a] is the partner point in B (-1 = none). For one mesh the pairing goes
 * both ways (map[map[a]] === a).
 */
export function matchMirror(A, B, cx, tol) {
  const same = A === B
  const map = new Int32Array(A.N).fill(-1)
  const back = same ? map : new Int32Array(B.N).fill(-1)
  const gridB = makeGrid(B.weld.gpos, B.N, tol)
  const gridA = same ? gridB : makeGrid(A.weld.gpos, A.N, tol)
  const queue = []

  const link = (a, b) => {
    map[a] = b
    back[b] = a
    queue.push(a)
    if (same && b !== a) {
      map[b] = a
      back[a] = b
      queue.push(b)
    }
  }

  // Grow the pairing across the surface. A point next to an already paired point u is paired with the point
  // next to u's partner that lies in the mirrored direction. The candidate whose direction agrees best goes
  // first, so the exact matches claim their partners before the doubtful ones (a quad's diagonal, which one
  // side may have and the other not) can.
  const PA = A.weld.gpos
  const PB = B.weld.gpos
  const heap = []
  const push = (item) => {
    heap.push(item)
    let i = heap.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (heap[parent].score >= heap[i].score) break
      ;[heap[parent], heap[i]] = [heap[i], heap[parent]]
      i = parent
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < heap.length && heap[l].score > heap[m].score) m = l
        if (r < heap.length && heap[r].score > heap[m].score) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return top
  }
  const offer = (a, b) => {
    for (const w of A.nbr[a]) {
      if (map[w] >= 0) continue
      const dx = -(PA[w * 3] - PA[a * 3])
      const dy = PA[w * 3 + 1] - PA[a * 3 + 1]
      const dz = PA[w * 3 + 2] - PA[a * 3 + 2]
      const len1 = Math.hypot(dx, dy, dz)
      if (len1 < 1e-12) continue
      for (const w2 of B.nbr[b]) {
        if (back[w2] >= 0 || (same && map[w2] >= 0)) continue
        const ex = PB[w2 * 3] - PB[b * 3]
        const ey = PB[w2 * 3 + 1] - PB[b * 3 + 1]
        const ez = PB[w2 * 3 + 2] - PB[b * 3 + 2]
        const len2 = Math.hypot(ex, ey, ez)
        if (len2 < 1e-12) continue
        const cos = (dx * ex + dy * ey + dz * ez) / (len1 * len2)
        if (cos < 0.5) continue
        push({ score: cos, w, w2 })
      }
    }
  }
  const grow = () => {
    while (queue.length) {
      const a = queue.pop()
      offer(a, map[a])
    }
    while (heap.length) {
      const { w, w2 } = pop()
      if (map[w] >= 0 || back[w2] >= 0 || (same && map[w2] >= 0)) continue
      link(w, w2)
      while (queue.length) {
        const a = queue.pop()
        offer(a, map[a])
      }
    }
  }

  // Candidate starting pairs: points that already sit on each other's mirror image (nearest both ways).
  const onCentre = []
  const elsewhere = []
  for (let a = 0; a < A.N; a++) {
    const x = 2 * cx - A.weld.gpos[a * 3]
    const y = A.weld.gpos[a * 3 + 1]
    const z = A.weld.gpos[a * 3 + 2]
    const b = nearest(gridB, B.weld.gpos, x, y, z, tol)
    if (b < 0) continue
    const a2 = nearest(gridA, A.weld.gpos, 2 * cx - B.weld.gpos[b * 3], B.weld.gpos[b * 3 + 1], B.weld.gpos[b * 3 + 2], tol)
    if (a2 !== a) continue
    const d = Math.hypot(B.weld.gpos[b * 3] - x, B.weld.gpos[b * 3 + 1] - y, B.weld.gpos[b * 3 + 2] - z)
    if (same && b === a) onCentre.push(a)
    else elsewhere.push({ a, b, d })
  }

  // Phase 1: points on the centre line are their own mirror image, so they are always right. Starting from
  // them is what lets two sides that have drifted apart (a long arm) still pair up correctly: the position
  // guesses further out can coincide with the WRONG point once one side is stretched.
  let seeds = 0
  for (const a of onCentre) {
    if (map[a] >= 0) continue
    link(a, a)
    seeds++
  }
  grow()

  // Phase 2: whatever is still unpaired (separate parts, pieces not joined to the centre) starts from the
  // closest position matches, best first, each growing before the next is considered.
  elsewhere.sort((p, q) => p.d - q.d)
  for (const { a, b } of elsewhere) {
    if (map[a] >= 0 || back[b] >= 0 || (same && map[b] >= 0)) continue
    link(a, b)
    seeds++
    grow()
  }
  return { map, seeds }
}

// --- bone pairing ----------------------------------------------------------------------------------------
export function sideKey(name) {
  let normalized = String(name).toLowerCase()
  let side = null
  if (/left/.test(normalized)) {
    side = 'left'
    normalized = normalized.replace(/left/g, '{side}')
  } else if (/right/.test(normalized)) {
    side = 'right'
    normalized = normalized.replace(/right/g, '{side}')
  } else {
    const marker = /(^|[._-])([lr])(?=$|[._-])/.exec(normalized)
    if (!marker) return null
    side = marker[2] === 'l' ? 'left' : 'right'
    normalized = normalized.replace(marker[0], `${marker[1]}{side}`)
  }
  normalized = normalized.replace(/([._-])\d+$/g, '')
  return { side, key: normalized }
}

/**
 * For each bone, the index of its opposite-side bone (itself for a centre bone), -1 when it has none.
 * `rootPos` is each bone's rest position in the character's frame. Names decide first (Left/Right, _L/_R);
 * bones without a side in their name are paired by position (a bone sitting on the centre line is its own
 * mirror, an off-centre one pairs with the unpaired bone nearest its reflection).
 */
export function pairBones(names, rootPos, cx, tol) {
  const n = names.length
  const mirror = new Int32Array(n).fill(-1)
  const keys = names.map(sideKey)
  const byKey = new Map()
  keys.forEach((k, i) => {
    if (!k) return
    const id = `${k.key}`
    if (!byKey.has(id)) byKey.set(id, {})
    const slot = byKey.get(id)
    if (!slot[k.side]) slot[k.side] = i
  })
  for (const slot of byKey.values()) {
    if (slot.left !== undefined && slot.right !== undefined) {
      mirror[slot.left] = slot.right
      mirror[slot.right] = slot.left
    }
  }
  for (let i = 0; i < n; i++) {
    if (mirror[i] >= 0 || keys[i]) continue
    if (Math.abs(rootPos[i * 3] - cx) <= tol) mirror[i] = i
  }
  for (let i = 0; i < n; i++) {
    if (mirror[i] >= 0) continue
    let best = -1
    let bestD = tol * tol
    for (let j = 0; j < n; j++) {
      if (j === i || mirror[j] >= 0 || keys[i] || keys[j]) continue
      const dx = 2 * cx - rootPos[i * 3] - rootPos[j * 3]
      const dy = rootPos[i * 3 + 1] - rootPos[j * 3 + 1]
      const dz = rootPos[i * 3 + 2] - rootPos[j * 3 + 2]
      const d = dx * dx + dy * dy + dz * dz
      if (d <= bestD) {
        bestD = d
        best = j
      }
    }
    if (best >= 0) {
      mirror[i] = best
      mirror[best] = i
    }
  }
  return mirror
}

// Where the middle of the character is: the average midpoint of the name-paired bones, else `fallback`.
export function centreFromBones(names, rootPos, fallback = 0) {
  const keys = names.map(sideKey)
  const seen = new Map()
  const mids = []
  keys.forEach((k, i) => {
    if (!k) return
    const other = seen.get(k.key)
    if (other !== undefined && keys[other].side !== k.side) mids.push((rootPos[i * 3] + rootPos[other * 3]) / 2)
    else seen.set(k.key, i)
  })
  if (!mids.length) return fallback
  mids.sort((a, b) => a - b)
  return mids[Math.floor(mids.length / 2)]
}

// Which side of the centre the character's LEFT is, going by the name-paired bones (+1 = larger x).
export function leftSign(names, rootPos, cx) {
  let sum = 0
  names.forEach((name, i) => {
    const k = sideKey(name)
    if (!k) return
    sum += (k.side === 'left' ? 1 : -1) * Math.sign(rootPos[i * 3] - cx)
  })
  return sum >= 0 ? 1 : -1
}
