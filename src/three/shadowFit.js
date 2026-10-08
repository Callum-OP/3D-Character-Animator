import * as THREE from 'three'

// Helpers for the realistic-shadow setup. Pure three.js maths (no renderer), so
// they can be unit-tested without WebGL.

// Union of the caster bounding spheres -> where the key light's shadow camera
// should point and how wide it has to be. Returns null when nothing casts.
export function fitShadowExtents(spheres, { minHalf = 1, maxHalf = Infinity, padding = 1.15 } = {}) {
  if (!spheres || !spheres.length) return null
  const union = spheres[0].clone()
  for (let i = 1; i < spheres.length; i++) union.union(spheres[i])
  const half = Math.min(maxHalf, Math.max(minHalf, union.radius * padding))
  return { center: union.center.clone(), half }
}

// Avoid re-fitting (and re-uploading shadow-camera matrices) for tiny changes
// such as a character swaying while it animates.
export function needsRefit(prev, next, tolerance = 0.08) {
  if (!next) return false
  if (!prev) return true
  if (Math.abs(next.half / prev.half - 1) > tolerance) return true
  return next.center.distanceTo(prev.center) > prev.half * tolerance
}

const MAX_PROBE_TRIANGLES = 500000

// Meshes a downward floor probe may hit: visible, not skinned (skinned raycasts
// are expensive), not absurdly dense, and not flagged as non-receivers.
export function collectFloorReceivers(roots) {
  const meshes = []
  const visit = (obj) => {
    if (!obj.visible) return
    if (obj.isMesh && !obj.isSkinnedMesh && obj.receiveShadow !== false) {
      const g = obj.geometry
      const tris = g?.index ? g.index.count / 3 : (g?.attributes?.position?.count || 0) / 3
      if (tris <= MAX_PROBE_TRIANGLES) meshes.push(obj)
    }
    for (const child of obj.children) visit(child)
  }
  for (const root of roots) if (root) visit(root)
  return meshes
}

const _ray = new THREE.Raycaster()
const _down = new THREE.Vector3(0, -1, 0)
const _from = new THREE.Vector3()

// Look straight down from just above `origin` (a character's feet) for a
// surface that can receive shadows. Returns { hit, y }: when nothing is below,
// hit is false and y is `fallback`. Starting a little ABOVE the feet (not at
// the top of the head) means a ceiling or upper floor is never mistaken for the
// floor the character stands on.
export function probeFloor(receivers, origin, { startAbove = 0.5, maxDrop = 1000, fallback = 0 } = {}) {
  if (!receivers.length) return { hit: false, y: fallback }
  _from.copy(origin)
  _from.y += startAbove
  _ray.set(_from, _down)
  _ray.near = 0
  _ray.far = startAbove + maxDrop
  const hits = _ray.intersectObjects(receivers, false)
  return hits.length ? { hit: true, y: hits[0].point.y } : { hit: false, y: fallback }
}

// Height of the surface below `origin`, or `fallback` when there is none.
export function probeFloorY(receivers, origin, options = {}) {
  return probeFloor(receivers, origin, options).y
}