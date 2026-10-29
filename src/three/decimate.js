import * as THREE from 'three'
import { MeshoptSimplifier } from 'meshoptimizer/meshopt_simplifier.module.js'

// Reduce a part's detail (decimate): fewer triangles and vertices, so a high-resolution model
// becomes low-poly / game ready and the exported file is much smaller.
//
// It is non-destructive. The setting lives in the per-part override map as
// `decimate: { ratio, protect }` (ratio = share of the triangles to keep, 0.01 .. 1), so it
// saves with the project, copies with the part and goes through undo / redo. The original
// geometry is remembered, so putting the slider back to 100% restores every triangle. The
// viewport shows the reduced geometry and the exporters simply read it, so the file is lighter.
//
// The simplifier (an edge-collapse algorithm) only ever DROPS vertices; it never moves or
// invents them. So UVs, normals, vertex colours, skin weights and morph targets of the vertices
// that remain stay exactly right, and skinned characters keep animating.

const MARK = '__decimated' // hidden (non-enumerable) note on a reduced geometry: { src, key }

let ready = false
let readyPromise = null
let readyHandler = null

// The simplifier is WebAssembly and starts up asynchronously. Call this early (or await it
// before the first reduction). `fn` runs once when it becomes usable, so a project that is
// loading with reduced parts can re-apply them.
export function ensureDecimatorReady() {
  if (!readyPromise) {
    readyPromise = Promise.resolve(MeshoptSimplifier.ready)
      .then(() => {
        ready = !!MeshoptSimplifier.supported
        if (ready && readyHandler) readyHandler()
      })
      .catch(() => {})
  }
  return readyPromise
}
export const isDecimatorReady = () => ready
export function setDecimatorReadyHandler(fn) {
  readyHandler = fn
}

export const MIN_RATIO = 0.01

export function triangleCount(geometry) {
  if (!geometry || !geometry.attributes || !geometry.attributes.position) return 0
  return Math.floor((geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3)
}
export function vertexCount(geometry) {
  return geometry && geometry.attributes && geometry.attributes.position ? geometry.attributes.position.count : 0
}

// How the vertices of an attribute are stored: { array, stride, offset }.
function reader(attr) {
  if (attr.isInterleavedAttribute || attr.isInterleavedBufferAttribute) {
    return { array: attr.data.array, stride: attr.data.stride, offset: attr.offset }
  }
  return { array: attr.array, stride: attr.itemSize, offset: 0 }
}

// Copy the chosen vertices (`order`: old indices) of one attribute into a fresh attribute.
function pickAttribute(attr, order) {
  const { array, stride, offset } = reader(attr)
  const size = attr.itemSize
  const Ctor = attr.isInterleavedBufferAttribute ? Float32Array : array.constructor
  const out = new Ctor(order.length * size)
  for (let n = 0; n < order.length; n++) {
    const from = order[n] * stride + offset
    const to = n * size
    for (let c = 0; c < size; c++) out[to + c] = array[from + c]
  }
  return new THREE.BufferAttribute(out, size, attr.normalized)
}

function floatsOf(attr, count) {
  const { array, stride, offset } = reader(attr)
  const size = attr.itemSize
  const out = new Float32Array(count * size)
  for (let i = 0; i < count; i++) for (let c = 0; c < size; c++) out[i * size + c] = array[i * stride + offset + c]
  return out
}

// A mesh with no index list (every triangle owns its three vertices) is welded first:
// vertices that are identical in every attribute are merged, so triangles can share them.
function weld(geometry) {
  const count = vertexCount(geometry)
  const names = Object.keys(geometry.attributes).filter((n) => n !== 'regionId')
  const morphNames = Object.keys(geometry.morphAttributes || {})
  const sources = []
  for (const n of names) sources.push(reader(geometry.attributes[n]), geometry.attributes[n].itemSize)
  for (const n of morphNames) {
    for (const a of geometry.morphAttributes[n]) sources.push(reader(a), a.itemSize)
  }
  const seen = new Map()
  const order = []
  const index = new Uint32Array(count)
  for (let v = 0; v < count; v++) {
    let key = ''
    for (let s = 0; s < sources.length; s += 2) {
      const { array, stride, offset } = sources[s]
      const size = sources[s + 1]
      for (let c = 0; c < size; c++) key += array[v * stride + offset + c] + ','
    }
    let id = seen.get(key)
    if (id === undefined) {
      id = order.length
      seen.set(key, id)
      order.push(v)
    }
    index[v] = id
  }
  return { index, order }
}

function copyGeometryAttributes(src, out, order) {
  for (const name of Object.keys(src.attributes)) {
    if (name === 'regionId') continue // face numbers of the old geometry mean nothing on the new one
    out.setAttribute(name, pickAttribute(src.attributes[name], order))
  }
  for (const name of Object.keys(src.morphAttributes || {})) {
    out.morphAttributes[name] = src.morphAttributes[name].map((a) => pickAttribute(a, order))
  }
  out.morphTargetsRelative = src.morphTargetsRelative
}

/**
 * Simplify `geometry` to keep about `ratio` of its triangles. Returns a NEW geometry (the input
 * is not changed), or the input itself when there is nothing to do (ratio >= 1, no triangles).
 *
 * Needs the simplifier to be ready (ensureDecimatorReady).
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {number} ratio  0.01 .. 1 — share of the triangles to keep
 * @param {{ protectEdges?: boolean }} [opts]  protectEdges keeps the outline of open meshes and the
 *   borders between materials fixed, so cloth / hair cards / material patches do not shrink or tear.
 */
export function decimateGeometry(geometry, ratio, { protectEdges = true } = {}) {
  if (!ready) throw new Error('decimate: the simplifier is not ready yet')
  const r = Math.min(1, Math.max(MIN_RATIO, Number(ratio) || 1))
  if (r >= 1 || !triangleCount(geometry)) return geometry

  // 1. A shared vertex list + one index list.
  let source = geometry
  let remap = null // old (unwelded) vertex -> welded vertex, when welding was needed
  let index
  let order = null // welded vertex -> a vertex of `geometry`
  if (geometry.index) {
    index = Uint32Array.from(geometry.index.array)
  } else {
    const welded = weld(geometry)
    index = welded.index
    order = welded.order
    remap = true
  }
  const total = remap ? order.length : vertexCount(geometry)
  const posAttr = geometry.attributes.position
  const positions = floatsOf(posAttr, vertexCount(geometry))
  const weldedPositions = remap ? pickFloats(positions, 3, order) : positions

  // 2. Extra things the simplifier should try to keep intact: where the UVs, normals, colours and
  //    skin weights are. (They only weigh into WHICH vertices are removed; the rest are not changed.)
  const extra = []
  const weights = []
  const addExtra = (attr, weight) => {
    if (!attr) return
    let data = floatsOf(attr, vertexCount(geometry))
    if (remap) data = pickFloats(data, attr.itemSize, order)
    extra.push({ data, size: attr.itemSize })
    for (let c = 0; c < attr.itemSize; c++) weights.push(weight)
  }
  addExtra(geometry.attributes.uv, 1)
  addExtra(geometry.attributes.normal, 0.5)
  addExtra(geometry.attributes.color, 0.5)
  addExtra(geometry.attributes.skinWeight, 1)
  const stride = weights.length
  let attrs = null
  if (stride) {
    attrs = new Float32Array(total * stride)
    let at = 0
    for (const e of extra) {
      for (let v = 0; v < total; v++) for (let c = 0; c < e.size; c++) attrs[v * stride + at + c] = e.data[v * e.size + c]
      at += e.size
    }
  }

  // 3. Each material group is simplified on its own, so the groups stay intact. Their shared
  //    borders are then locked (they are borders of each piece), which avoids cracks between materials.
  const ranges = geometry.groups && geometry.groups.length
    ? geometry.groups.map((g) => ({ start: g.start, count: Math.min(g.count, index.length - g.start), materialIndex: g.materialIndex }))
    : [{ start: 0, count: index.length, materialIndex: 0 }]
  const lock = protectEdges || ranges.length > 1
  const flags = lock ? ['LockBorder'] : []
  const pieces = ranges.map((range) => {
    const part = index.slice(range.start, range.start + range.count)
    const target = Math.max(12, Math.round((part.length * r) / 3) * 3)
    if (part.length <= target) return { ...range, index: part }
    const [reduced] = attrs
      ? MeshoptSimplifier.simplifyWithAttributes(part, weldedPositions, 3, attrs, stride, weights, null, target, 1, flags)
      : MeshoptSimplifier.simplify(part, weldedPositions, 3, target, 1, flags)
    return { ...range, index: reduced }
  })

  // 4. Keep only the vertices still used, in their old order.
  const used = new Uint8Array(total)
  for (const p of pieces) for (let i = 0; i < p.index.length; i++) used[p.index[i]] = 1
  const newId = new Int32Array(total).fill(-1)
  const keep = []
  for (let v = 0; v < total; v++) {
    if (used[v]) {
      newId[v] = keep.length
      keep.push(order ? order[v] : v)
    }
  }
  const Index = keep.length > 65535 ? Uint32Array : Uint16Array
  const finalIndex = new Index(pieces.reduce((n, p) => n + p.index.length, 0))
  const out = new THREE.BufferGeometry()
  out.name = geometry.name
  let at = 0
  for (const p of pieces) {
    const start = at
    for (let i = 0; i < p.index.length; i++) finalIndex[at++] = newId[p.index[i]]
    if (geometry.groups && geometry.groups.length) out.addGroup(start, p.index.length, p.materialIndex)
  }
  out.setIndex(new THREE.BufferAttribute(finalIndex, 1))
  copyGeometryAttributes(source, out, keep)
  out.userData = { ...(geometry.userData || {}) }
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

function pickFloats(data, size, order) {
  const out = new Float32Array(order.length * size)
  for (let n = 0; n < order.length; n++) for (let c = 0; c < size; c++) out[n * size + c] = data[order[n] * size + c]
  return out
}

// ---------------------------------------------------------------------------------------------
// Applying the per-part setting to live meshes
// ---------------------------------------------------------------------------------------------

const keyOf = (spec) => spec.ratio.toFixed(4) + '|' + (spec.protect === false ? 0 : 1)

// The setting stored on a part -> { ratio, protect } or null when the part is at full detail.
export function decimateSpecOf(override) {
  const d = override && override.decimate
  if (!d || !(d.ratio < 0.9995)) return null
  return { ratio: Math.min(1, Math.max(MIN_RATIO, Number(d.ratio))), protect: d.protect !== false }
}

// The geometry a part had before it was reduced (the geometry itself when it was not).
export function getOriginalGeometry(mesh) {
  const mark = mesh && mesh.geometry && mesh.geometry.userData && mesh.geometry.userData[MARK]
  return mark ? mark.src : mesh ? mesh.geometry : null
}
export const isDecimated = (mesh) => !!(mesh && mesh.geometry && mesh.geometry.userData && mesh.geometry.userData[MARK])

/**
 * Make `mesh` show the geometry `spec` asks for (null = the original). Cheap when nothing changed.
 * Returns true while the part is reduced. Reduced parts do not take Paint regions (their faces
 * are different), so callers skip regions for them.
 */
export function applyMeshDecimation(mesh, spec) {
  if (!mesh || !mesh.geometry) return false
  const current = mesh.geometry
  const mark = current.userData && current.userData[MARK]
  if (!spec) {
    if (mark) {
      mesh.geometry = mark.src
      current.dispose()
    }
    return false
  }
  if (!ready) {
    ensureDecimatorReady() // applied as soon as it is ready (the ready handler re-runs the materials)
    return !!mark
  }
  const key = keyOf(spec)
  if (mark && mark.key === key) return true
  const src = mark ? mark.src : current
  let reduced
  try {
    reduced = decimateGeometry(src, spec.ratio, { protectEdges: spec.protect })
  } catch (e) {
    console.warn('Reduce detail failed for', mesh.name, e)
    return !!mark
  }
  if (reduced === src) {
    if (mark) {
      mesh.geometry = src
      current.dispose()
    }
    return false
  }
  Object.defineProperty(reduced.userData, MARK, { value: { src, key }, enumerable: false, configurable: true, writable: true })
  mesh.geometry = reduced
  current.dispose() // the geometry no longer drawn (the full one, or the previous reduction) frees its graphics memory; the data stays for restoring
  return true
}

/**
 * Thin every mesh of `root` that has more than `maxTriangles` triangles down to about that many (a lower Quality
 * preset, as a model is imported). Permanent for this load — the original is not kept; opening the project under
 * a higher preset loads it in full again. Skinned meshes, morph targets, UVs and material groups are kept (the
 * simplifier only drops vertices). Returns { meshes, trianglesBefore, trianglesAfter }.
 */
export async function limitMeshTriangles(root, maxTriangles) {
  const result = { meshes: 0, trianglesBefore: 0, trianglesAfter: 0 }
  if (!root || !(maxTriangles >= 1)) return result
  await ensureDecimatorReady()
  if (!ready) return result // no WebAssembly here: leave the meshes as they are
  const meshes = []
  root.traverse((obj) => {
    if (obj.isMesh && obj.geometry && triangleCount(obj.geometry) > maxTriangles) meshes.push(obj)
  })
  for (const mesh of meshes) {
    const before = triangleCount(mesh.geometry)
    const reduced = decimateGeometry(mesh.geometry, Math.max(MIN_RATIO, maxTriangles / before), { protectEdges: true })
    if (reduced === mesh.geometry) continue
    const old = mesh.geometry
    mesh.geometry = reduced
    old.dispose()
    result.meshes++
    result.trianglesBefore += before
    result.trianglesAfter += triangleCount(reduced)
  }
  return result
}
