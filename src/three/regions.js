import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Regions: pick out part of a mesh — a headlight, a window, a trim stripe — and give just
// that part its own colour, glow and shininess.
//
// Why not materials? A model often has ONE material whose texture holds many colours (the
// cars in the low-poly pack share a single colour atlas): the headlight is not a material
// of its own, it is a few faces that happen to sample a yellow square of the image. So a
// region is a set of TRIANGLES. Click a face and the selection grows across connected faces
// for as long as the texture colour stays close to the one you clicked — it stops where the
// colour ends instead of grabbing every pixel of that colour in the whole model.
//
// A mesh's regions live in its override entry:
//
//   ov.regions = [{ id, name, tris: [[first, last], ...], vertexCount, look }]
//   look = { mode: 'solid' | 'tint', color, glow, glowColor, roughness, metalness }
//
// Rendering marks each vertex with its region number (a `regionId` attribute) and the
// material's shader reads it (surfaceMaterials.js applyRegionLooks). The faces are the
// mesh's own, so nothing is cut or duplicated, and an unedited mesh is never touched.
// ---------------------------------------------------------------------------

export const MAX_REGIONS = 8

// Parts bent by a skeleton or morph targets are left alone: their triangles are not fixed.
export function isRegionCapable(mesh) {
  return !!(
    mesh && mesh.isMesh && !mesh.isSkinnedMesh &&
    mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position &&
    !(mesh.morphTargetInfluences && mesh.morphTargetInfluences.length)
  )
}

// Number of vertices the triangle list covers. For an indexed mesh this is the index count
// (the unit saved regions are checked against: a re-imported, re-decimated mesh no longer
// matches, and its saved regions are ignored rather than painted onto the wrong faces).
export function regionVertexCount(geometry) {
  return geometry.index ? geometry.index.count : geometry.attributes.position.count
}

// Faces need their own vertices to carry a region number, so an indexed mesh is unwrapped
// once (same triangle order, so face numbers stay valid). Idempotent.
export function ensureRegionGeometry(mesh) {
  let geo = mesh.geometry
  if (geo.index) {
    const indexed = geo
    geo = geo.toNonIndexed()
    geo.userData = { ...(indexed.userData || {}) }
    mesh.geometry = geo
    carryRegionCaches(indexed, geo) // same triangles in the same order: no need to work the connections out again
  }
  const count = geo.attributes.position.count
  const attr = geo.getAttribute('regionId')
  if (!attr || attr.count !== count) {
    geo.setAttribute('regionId', new THREE.BufferAttribute(new Float32Array(count), 1))
    geo.userData.regionSig = null
  }
  return geo
}

// The text form of a region's triangle ranges, worked out once per list (they are replaced, not edited,
// when a region changes) — materials are re-applied on every Look / lighting change and must not rebuild it.
const trisSigCache = new WeakMap()
function trisSignature(tris) {
  let sig = trisSigCache.get(tris)
  if (sig === undefined) {
    sig = tris.map((t) => t[0] + '-' + t[1]).join(',')
    trisSigCache.set(tris, sig)
  }
  return sig
}

// Write the region numbers (1-based; 0 = none) for a mesh's regions. Returns false (and
// paints nothing) when the saved regions no longer fit this geometry.
export function applyRegionIds(mesh, regions) {
  if (!isRegionCapable(mesh)) return false
  const expected = regionVertexCount(mesh.geometry)
  if (regions.some((r) => r.vertexCount != null && r.vertexCount !== expected)) return false
  const geo = ensureRegionGeometry(mesh)
  const sig = regions.map((r) => r.id + ':' + trisSignature(r.tris)).join('|')
  if (geo.userData.regionSig === sig) return true
  const attr = geo.getAttribute('regionId')
  attr.array.fill(0)
  regions.forEach((r, i) => {
    const id = i + 1
    for (const [first, last] of r.tris) {
      for (let t = first; t <= last; t++) attr.array[t * 3] = attr.array[t * 3 + 1] = attr.array[t * 3 + 2] = id
    }
  })
  attr.needsUpdate = true
  geo.userData.regionSig = sig
  return true
}

// --- triangle lists <-> compact ranges -------------------------------------------

export function toRanges(tris) {
  const sorted = Array.from(tris).sort((a, b) => a - b)
  const ranges = []
  for (const t of sorted) {
    const last = ranges[ranges.length - 1]
    if (last && t === last[1] + 1) last[1] = t
    else if (!last || t > last[1]) ranges.push([t, t])
  }
  return ranges
}

export function fromRanges(ranges) {
  const out = []
  for (const [first, last] of ranges) for (let t = first; t <= last; t++) out.push(t)
  return out
}

// --- reading the texture ------------------------------------------------------------

const pixelCache = new WeakMap()
const MAX_SAMPLE_SIDE = 1024 // region picking does not need full resolution

// { data (RGBA bytes), width, height } for a texture, or null when it cannot be read.
export function getTexturePixels(texture) {
  const img = texture && texture.image
  if (!img) return null
  if (pixelCache.has(texture)) return pixelCache.get(texture)
  let result = null
  try {
    if (img.data && img.width && img.height) {
      const channels = Math.round(img.data.length / (img.width * img.height))
      let data = img.data
      if (channels !== 4) {
        data = new Uint8ClampedArray(img.width * img.height * 4)
        for (let i = 0; i < img.width * img.height; i++) {
          data[i * 4] = img.data[i * channels]
          data[i * 4 + 1] = img.data[i * channels + (channels > 2 ? 1 : 0)]
          data[i * 4 + 2] = img.data[i * channels + (channels > 2 ? 2 : 0)]
          data[i * 4 + 3] = 255
        }
      }
      result = { data, width: img.width, height: img.height }
    } else {
      const w0 = img.naturalWidth || img.width
      const h0 = img.naturalHeight || img.height
      if (w0 && h0) {
        const scale = Math.min(1, MAX_SAMPLE_SIDE / Math.max(w0, h0))
        const width = Math.max(1, Math.round(w0 * scale))
        const height = Math.max(1, Math.round(h0 * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0, width, height)
        result = { data: ctx.getImageData(0, 0, width, height).data, width, height }
      }
    }
  } catch {
    result = null // tainted / unsupported image: fall back to the flat material colour
  }
  pixelCache.set(texture, result)
  return result
}

function sampleTexture(px, texture, u, v, out) {
  u -= Math.floor(u)
  v -= Math.floor(v)
  const x = Math.min(px.width - 1, Math.floor(u * px.width))
  const y = Math.min(px.height - 1, Math.floor((texture.flipY ? 1 - v : v) * px.height))
  const i = (y * px.width + x) * 4
  out[0] = px.data[i] / 255
  out[1] = px.data[i + 1] / 255
  out[2] = px.data[i + 2] / 255
}

// --- face colours and adjacency ----------------------------------------------------

const adjacencyCache = new WeakMap()
const colorCache = new WeakMap() // geometry -> { mats, colors (Float32 rgb per triangle), has (Uint8) }
const QUANT = 1e4

function carryRegionCaches(from, to) {
  const adj = adjacencyCache.get(from)
  if (adj) adjacencyCache.set(to, { count: to.attributes.position.count, adj: adj.adj })
  const col = colorCache.get(from)
  if (col) colorCache.set(to, col)
}

const nextPow2 = (n) => {
  let p = 16
  while (p < n) p <<= 1
  return p
}

// For every triangle, the triangles that share an edge with it (matched by POSITION, so a
// mesh whose vertices are split along UV seams still counts as connected).
// Returned in a compact form: `adj.list[adj.offsets[t] .. adj.offsets[t + 1])` are the neighbours of
// triangle `t`, and `adj.length` is the number of triangles. Built with typed arrays and hash tables
// (no strings, no per-triangle arrays), so a big part is worked out in a fraction of the time and memory.
export function getAdjacency(geometry) {
  const cached = adjacencyCache.get(geometry)
  if (cached && cached.count === geometry.attributes.position.count) return cached.adj
  const pos = geometry.attributes.position
  const nVerts = pos.count
  const nTris = Math.floor(regionVertexCount(geometry) / 3)
  const index = geometry.index

  // 1. Vertices at the same place share one id.
  const px = new Float64Array(nVerts)
  const py = new Float64Array(nVerts)
  const pz = new Float64Array(nVerts)
  for (let v = 0; v < nVerts; v++) {
    px[v] = Math.round(pos.getX(v) * QUANT)
    py[v] = Math.round(pos.getY(v) * QUANT)
    pz[v] = Math.round(pos.getZ(v) * QUANT)
  }
  const vCap = nextPow2(nVerts * 2)
  const vMask = vCap - 1
  const vSlot = new Int32Array(vCap) // 0 = empty, else first vertex seen at that place + 1
  const weld = new Int32Array(nVerts)
  for (let v = 0; v < nVerts; v++) {
    let h = (Math.imul(px[v] | 0, 73856093) ^ Math.imul(py[v] | 0, 19349663) ^ Math.imul(pz[v] | 0, 83492791)) & vMask
    for (;;) {
      const at = vSlot[h]
      if (at === 0) {
        vSlot[h] = v + 1
        weld[v] = v
        break
      }
      const w = at - 1
      if (px[w] === px[v] && py[w] === py[v] && pz[w] === pz[v]) {
        weld[v] = w
        break
      }
      h = (h + 1) & vMask
    }
  }

  // 2. Group the triangle edges (a, b) that are the same edge. Edge e = triangle * 3 + corner.
  const nEdges = nTris * 3
  const ea = new Int32Array(nEdges)
  const eb = new Int32Array(nEdges)
  for (let t = 0; t < nTris; t++) {
    const base = t * 3
    const v0 = weld[index ? index.getX(base) : base]
    const v1 = weld[index ? index.getX(base + 1) : base + 1]
    const v2 = weld[index ? index.getX(base + 2) : base + 2]
    ea[base] = v0 < v1 ? v0 : v1
    eb[base] = v0 < v1 ? v1 : v0
    ea[base + 1] = v1 < v2 ? v1 : v2
    eb[base + 1] = v1 < v2 ? v2 : v1
    ea[base + 2] = v2 < v0 ? v2 : v0
    eb[base + 2] = v2 < v0 ? v0 : v2
  }
  const eCap = nextPow2(nEdges * 2)
  const eMask = eCap - 1
  const eSlot = new Int32Array(eCap) // 0 = empty, else the first edge with that key + 1
  const nextSame = new Int32Array(nEdges).fill(-1) // the other edges with the same key, chained
  const heads = new Int32Array(nEdges)
  let headCount = 0
  for (let e = 0; e < nEdges; e++) {
    const a = ea[e]
    const b = eb[e]
    if (a === b) continue // a collapsed edge joins nothing
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) & eMask
    for (;;) {
      const at = eSlot[h]
      if (at === 0) {
        eSlot[h] = e + 1
        heads[headCount++] = e
        break
      }
      const r = at - 1
      if (ea[r] === a && eb[r] === b) {
        nextSame[e] = nextSame[r]
        nextSame[r] = e
        break
      }
      h = (h + 1) & eMask
    }
  }

  // 3. Neighbour lists: every triangle on an edge neighbours the others on it.
  const offsets = new Uint32Array(nTris + 1)
  for (let i = 0; i < headCount; i++) {
    let size = 0
    for (let e = heads[i]; e !== -1; e = nextSame[e]) size++
    if (size < 2) continue
    for (let e = heads[i]; e !== -1; e = nextSame[e]) offsets[Math.floor(e / 3) + 1] += size - 1
  }
  for (let t = 0; t < nTris; t++) offsets[t + 1] += offsets[t]
  const list = new Int32Array(offsets[nTris])
  const fill = offsets.slice(0, nTris)
  for (let i = 0; i < headCount; i++) {
    let size = 0
    for (let e = heads[i]; e !== -1; e = nextSame[e]) size++
    if (size < 2) continue
    for (let e = heads[i]; e !== -1; e = nextSame[e]) {
      const t = Math.floor(e / 3)
      for (let o = heads[i]; o !== -1; o = nextSame[o]) {
        if (o !== e) list[fill[t]++] = Math.floor(o / 3)
      }
    }
  }
  const adj = { offsets, list, length: nTris }
  adjacencyCache.set(geometry, { count: pos.count, adj })
  return adj
}

function materialForTriangle(mesh, tri, mats = mesh.material) {
  const mat = mats
  if (!Array.isArray(mat)) return mat
  const groups = mesh.geometry.groups
  const v = tri * 3
  for (const g of groups) if (v >= g.start && v < g.start + g.count) return mat[g.materialIndex]
  return mat[0]
}

// The colour (sRGB, 0..1) a triangle shows in the texture: the average of four points inside it, or the material's flat colour when it has no readable texture. `source`
// lets callers pass the ORIGINAL material (the viewport may be showing a toon stand-in).
const _flat = new THREE.Color()
export function triangleColor(mesh, tri, out = [0, 0, 0], source = null) {
  const geo = mesh.geometry
  const mat = materialForTriangle(mesh, tri, source || mesh.material)
  const uv = geo.attributes.uv
  const px = mat && mat.map && uv ? getTexturePixels(mat.map) : null
  if (!px) {
    if (mat && mat.color) {
      _flat.copy(mat.color).convertLinearToSRGB()
      out[0] = _flat.r
      out[1] = _flat.g
      out[2] = _flat.b
    } else {
      out[0] = out[1] = out[2] = 1
    }
    return out
  }
  const index = geo.index
  const base = tri * 3
  const i0 = index ? index.getX(base) : base
  const i1 = index ? index.getX(base + 1) : base + 1
  const i2 = index ? index.getX(base + 2) : base + 2
  const u0 = uv.getX(i0), v0 = uv.getY(i0)
  const u1 = uv.getX(i1), v1 = uv.getY(i1)
  const u2 = uv.getX(i2), v2 = uv.getY(i2)
  // The middle of the face plus three points halfway out to its corners: sampling the corners
  // themselves would bleed into the neighbouring swatch of an atlas texture.
  const cu = (u0 + u1 + u2) / 3
  const cv = (v0 + v1 + v2) / 3
  const s = _sample
  const map = mat.map
  sampleTexture(px, map, cu, cv, s)
  let r = s[0], g = s[1], b = s[2]
  sampleTexture(px, map, (cu + u0) / 2, (cv + v0) / 2, s)
  r += s[0]; g += s[1]; b += s[2]
  sampleTexture(px, map, (cu + u1) / 2, (cv + v1) / 2, s)
  r += s[0]; g += s[1]; b += s[2]
  sampleTexture(px, map, (cu + u2) / 2, (cv + v2) / 2, s)
  out[0] = (r + s[0]) / 4
  out[1] = (g + s[1]) / 4
  out[2] = (b + s[2]) / 4
  return out
}
const _sample = [0, 0, 0]

// triangleColor, remembered per triangle (a part is read from the same texture however many times the
// selection is regrown while a slider is dragged). Filled lazily, so only the triangles a growth reaches
// are ever read. Dropped when the materials it was read from change.
function colorLookup(mesh, source) {
  const geo = mesh.geometry
  const mats = source || mesh.material
  const nTris = Math.floor(regionVertexCount(geo) / 3)
  let cache = colorCache.get(geo)
  if (!cache || cache.mats !== mats || cache.has.length !== nTris) {
    cache = { mats, colors: new Float32Array(nTris * 3), has: new Uint8Array(nTris) }
    colorCache.set(geo, cache)
  }
  const tmp = [0, 0, 0]
  return (tri, out) => {
    const i = tri * 3
    if (!cache.has[tri]) {
      triangleColor(mesh, tri, tmp, source)
      cache.colors[i] = tmp[0]
      cache.colors[i + 1] = tmp[1]
      cache.colors[i + 2] = tmp[2]
      cache.has[tri] = 1
    }
    out[0] = cache.colors[i]
    out[1] = cache.colors[i + 1]
    out[2] = cache.colors[i + 2]
    return out
  }
}


// Grow a selection from one clicked triangle.
//   mode 'face'       just that triangle
//   mode 'color'      the connected faces whose colour stays close to the clicked one (default)
//   mode 'piece'      the whole connected piece, whatever its colours
//   mode 'everywhere' every face in the mesh of that colour, connected or not
// tolerance 0..1: how far a colour may drift from the clicked one and still count.
// `source` (optional): the original material to read colours from.
export function growRegion(mesh, seedTri, { mode = 'color', tolerance = 0.25, source = null } = {}) {
  const geo = mesh.geometry
  const nTris = Math.floor(regionVertexCount(geo) / 3)
  if (seedTri < 0 || seedTri >= nTris) return []
  if (mode === 'face') return [seedTri]

  const tol = Math.min(1, Math.max(0, tolerance))
  const threshold = 0.02 + tol * 0.5 + tol * tol * 0.48 // fine control at the low end; 1 reaches any colour
  const colorOf = colorLookup(mesh, source)
  const seedColor = colorOf(seedTri, [0, 0, 0])
  const scratch = [0, 0, 0]
  // Squared distance in colour space against the squared limit (distance / sqrt(3) <= threshold): no square roots.
  const limit = threshold * threshold * 3
  const matches = (t) => {
    if (mode === 'piece') return true
    colorOf(t, scratch)
    const dr = scratch[0] - seedColor[0]
    const dg = scratch[1] - seedColor[1]
    const db = scratch[2] - seedColor[2]
    return dr * dr + dg * dg + db * db <= limit
  }

  const out = []
  if (mode === 'everywhere') {
    for (let t = 0; t < nTris; t++) if (matches(t)) out.push(t)
    return out
  }
  const { offsets, list } = getAdjacency(geo)
  const seen = new Uint8Array(nTris)
  const stack = [seedTri]
  seen[seedTri] = 1
  while (stack.length) {
    const t = stack.pop()
    out.push(t)
    for (let i = offsets[t], end = offsets[t + 1]; i < end; i++) {
      const n = list[i]
      if (seen[n]) continue
      seen[n] = 1
      if (matches(n)) stack.push(n)
    }
  }
  return out
}

// --- highlight shown while selecting -------------------------------------------------

const overlays = new Map() // mesh -> overlay mesh

export function setRegionOverlay(mesh, tris, color = 0xff2bd6) {
  const old = overlays.get(mesh)
  if (old) {
    old.parent && old.parent.remove(old)
    old.geometry.dispose()
    old.material.dispose()
    overlays.delete(mesh)
  }
  if (!mesh || !tris || !tris.length) return
  const pos = mesh.geometry.attributes.position
  const index = mesh.geometry.index
  const arr = new Float32Array(tris.length * 9)
  let o = 0
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const v = index ? index.getX(t * 3 + k) : t * 3 + k
      arr[o++] = pos.getX(v)
      arr[o++] = pos.getY(v)
      arr[o++] = pos.getZ(v)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3))
  const overlay = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.6, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false,
    }),
  )
  overlay.userData.isRegionOverlay = true
  overlay.raycast = () => {} // never a click target
  overlay.frustumCulled = false
  overlay.renderOrder = 10
  mesh.add(overlay)
  overlays.set(mesh, overlay)
}

// Highlights must never leak into an exported file: hide them while `fn` runs.
export async function withOverlaysHidden(fn) {
  const shown = [...overlays.values()].filter((o) => o.visible)
  for (const o of shown) o.visible = false
  try {
    return await fn()
  } finally {
    for (const o of shown) o.visible = true
  }
}

// --- writing regions to a file ----------------------------------------------------------
//
// A shader effect cannot go into a .glb, so for export (and for turning parts into an
// object) every region becomes a real material: the triangles are regrouped so each region is
// one contiguous group with its own copy of the part's material, carrying the region's
// colour / glow / roughness / metalness. Returns { geometry, material: [...] } or null when
// the mesh has nothing to bake (or several material groups already, which are left as they are).
export function bakeRegionsForExport(mesh, regions, baseMaterial) {
  if (!regions || !regions.length || !isRegionCapable(mesh) || Array.isArray(baseMaterial)) return null
  const src = mesh.geometry
  if (regions.some((r) => r.vertexCount != null && r.vertexCount !== regionVertexCount(src))) return null
  const nonIndexed = src.index ? src.toNonIndexed() : src
  const nTris = Math.floor(nonIndexed.attributes.position.count / 3)

  const owner = new Int16Array(nTris).fill(-1)
  regions.forEach((r, i) => {
    for (const [first, last] of r.tris) for (let t = first; t <= last && t < nTris; t++) owner[t] = i
  })
  const order = []
  const groups = []
  const push = (id) => {
    const start = order.length
    for (let t = 0; t < nTris; t++) if (owner[t] === id) order.push(t)
    if (order.length > start) groups.push({ id, start: start * 3, count: (order.length - start) * 3 })
  }
  push(-1)
  regions.forEach((_, i) => push(i))

  const geometry = new THREE.BufferGeometry()
  for (const [name, attr] of Object.entries(nonIndexed.attributes)) {
    if (name === 'regionId') continue
    const size = attr.itemSize
    const arr = new attr.array.constructor(nTris * 3 * size)
    order.forEach((t, k) => {
      for (let j = 0; j < 3 * size; j++) arr[k * 3 * size + j] = attr.array[t * 3 * size + j]
    })
    geometry.setAttribute(name, new THREE.BufferAttribute(arr, size, attr.normalized))
  }
  const materials = groups.map((g, gi) => {
    geometry.addGroup(g.start, g.count, gi)
    if (g.id < 0) return baseMaterial
    return regionMaterial(baseMaterial, regions[g.id].look || {})
  })
  return { geometry, material: materials }
}

// One region's look as a plain PBR material: a copy of the part's material with the colour,
// glow and surface settings applied.
export function regionMaterial(base, look) {
  const m = new THREE.MeshPhysicalMaterial()
  const copy = ['name', 'color', 'map', 'alphaMap', 'alphaTest', 'transparent', 'opacity', 'side', 'depthWrite', 'normalMap', 'aoMap',
    'emissive', 'emissiveMap', 'emissiveIntensity', 'roughness', 'roughnessMap', 'metalness', 'metalnessMap']
  for (const k of copy) {
    const v = base[k]
    if (v === undefined || v === null) continue
    if (m[k] && m[k].isColor && v.isColor) m[k].copy(v)
    else m[k] = v
  }
  if (!base.isMeshStandardMaterial) {
    m.roughness = 0.8
    m.metalness = 0
  }
  if (look.color && look.mode === 'solid') {
    m.color.set(look.color)
    m.map = null
  } else if (look.color && look.mode === 'tint') {
    m.color.multiply(new THREE.Color(look.color))
  }
  if (look.glow > 0) {
    m.emissive.set(look.glowColor || look.color || '#ffffff')
    m.emissiveMap = null
    m.emissiveIntensity = look.glow
  }
  if (look.roughness != null) {
    m.roughness = look.roughness
    m.roughnessMap = null
  }
  if (look.metalness != null) {
    m.metalness = look.metalness
    m.metalnessMap = null
  }
  m.userData = {}
  return m
}
