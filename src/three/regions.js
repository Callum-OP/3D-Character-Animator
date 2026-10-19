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
    geo = geo.toNonIndexed()
    geo.userData = { ...(mesh.geometry.userData || {}) }
    mesh.geometry = geo
  }
  const count = geo.attributes.position.count
  const attr = geo.getAttribute('regionId')
  if (!attr || attr.count !== count) {
    geo.setAttribute('regionId', new THREE.BufferAttribute(new Float32Array(count), 1))
    geo.userData.regionSig = null
  }
  return geo
}

// Write the region numbers (1-based; 0 = none) for a mesh's regions. Returns false (and
// paints nothing) when the saved regions no longer fit this geometry.
export function applyRegionIds(mesh, regions) {
  if (!isRegionCapable(mesh)) return false
  const expected = regionVertexCount(mesh.geometry)
  if (regions.some((r) => r.vertexCount != null && r.vertexCount !== expected)) return false
  const geo = ensureRegionGeometry(mesh)
  const sig = regions.map((r) => r.id + ':' + r.tris.map((t) => t[0] + '-' + t[1]).join(',')).join('|')
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
const QUANT = 1e4

// For every triangle, the triangles that share an edge with it (matched by POSITION, so a
// mesh whose vertices are split along UV seams still counts as connected).
export function getAdjacency(geometry) {
  const cached = adjacencyCache.get(geometry)
  if (cached && cached.count === geometry.attributes.position.count) return cached.adj
  const pos = geometry.attributes.position
  const nTris = Math.floor(regionVertexCount(geometry) / 3)
  const index = geometry.index
  const vert = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k)

  const ids = new Map()
  const idOf = (v) => {
    const key = Math.round(pos.getX(v) * QUANT) + ',' + Math.round(pos.getY(v) * QUANT) + ',' + Math.round(pos.getZ(v) * QUANT)
    let id = ids.get(key)
    if (id === undefined) ids.set(key, (id = ids.size))
    return id
  }
  const edges = new Map()
  for (let t = 0; t < nTris; t++) {
    const a = idOf(vert(t, 0))
    const b = idOf(vert(t, 1))
    const c = idOf(vert(t, 2))
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p < q ? p + '_' + q : q + '_' + p
      const list = edges.get(key)
      if (list) list.push(t)
      else edges.set(key, [t])
    }
  }
  const adj = Array.from({ length: nTris }, () => [])
  for (const list of edges.values()) {
    if (list.length < 2) continue
    for (const a of list) for (const b of list) if (a !== b) adj[a].push(b)
  }
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
export function triangleColor(mesh, tri, out = [0, 0, 0], source = null) {
  const geo = mesh.geometry
  const mat = materialForTriangle(mesh, tri, source || mesh.material)
  const uv = geo.attributes.uv
  const px = mat && mat.map && uv ? getTexturePixels(mat.map) : null
  if (!px) {
    const c = mat && mat.color ? mat.color.clone().convertLinearToSRGB() : { r: 1, g: 1, b: 1 }
    out[0] = c.r
    out[1] = c.g
    out[2] = c.b
    return out
  }
  const index = geo.index
  const v = (k) => (index ? index.getX(tri * 3 + k) : tri * 3 + k)
  const u0 = uv.getX(v(0)), v0 = uv.getY(v(0))
  const u1 = uv.getX(v(1)), v1 = uv.getY(v(1))
  const u2 = uv.getX(v(2)), v2 = uv.getY(v(2))
  // The middle of the face plus three points halfway out to its corners: sampling the corners
  // themselves would bleed into the neighbouring swatch of an atlas texture.
  const cu = (u0 + u1 + u2) / 3
  const cv = (v0 + v1 + v2) / 3
  const pts = [[cu, cv], [(cu + u0) / 2, (cv + v0) / 2], [(cu + u1) / 2, (cv + v1) / 2], [(cu + u2) / 2, (cv + v2) / 2]]
  const s = [0, 0, 0]
  let r = 0, g = 0, b = 0
  for (const [pu, pvv] of pts) {
    sampleTexture(px, mat.map, pu, pvv, s)
    r += s[0]; g += s[1]; b += s[2]
  }
  out[0] = r / 4
  out[1] = g / 4
  out[2] = b / 4
  return out
}

const colorDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / Math.sqrt(3)

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
  const seedColor = triangleColor(mesh, seedTri, [0, 0, 0], source)
  const scratch = [0, 0, 0]
  const matches = (t) => mode === 'piece' || colorDistance(triangleColor(mesh, t, scratch, source), seedColor) <= threshold

  const out = []
  if (mode === 'everywhere') {
    for (let t = 0; t < nTris; t++) if (matches(t)) out.push(t)
    return out
  }
  const adj = getAdjacency(geo)
  const seen = new Uint8Array(nTris)
  const stack = [seedTri]
  seen[seedTri] = 1
  while (stack.length) {
    const t = stack.pop()
    out.push(t)
    for (const n of adj[t]) {
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
