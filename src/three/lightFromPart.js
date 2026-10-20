import * as THREE from 'three'
import { fromRanges, regionVertexCount, triangleColor } from './regions.js'

// Work out where a light should go to stand in for a part of the scene — a tail light, a
// window, a whole lamp shade: the middle of the part (or of one region of it), the direction
// its surface faces, how big it is, and what colour it is. See scene.js createLightFromParts.

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()

function vertexOf(geometry, tri, k) {
  return geometry.index ? geometry.index.getX(tri * 3 + k) : tri * 3 + k
}

// All triangles of a mesh, or the listed ones.
function triangleList(mesh, tris) {
  if (tris && tris.length) return tris
  const n = Math.floor(regionVertexCount(mesh.geometry) / 3)
  const step = Math.max(1, Math.floor(n / 4000)) // plenty for a centroid, cheap for huge meshes
  const out = []
  for (let t = 0; t < n; t += step) out.push(t)
  return out
}

// { position, normal, size } in WORLD space for the given triangles of one mesh (all of it when
// `tris` is empty). position = area-weighted middle of the faces, normal = their average facing
// (null when the faces point every which way, like a closed box), size = the bounding diagonal.
export function analyseSurface(mesh, tris) {
  mesh.updateWorldMatrix(true, false)
  const geo = mesh.geometry
  const pos = geo.attributes.position
  const list = triangleList(mesh, tris)
  const centre = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const box = new THREE.Box3()
  let areaSum = 0
  const mirrored = mesh.matrixWorld.determinant() < 0
  for (const t of list) {
    _a.fromBufferAttribute(pos, vertexOf(geo, t, 0)).applyMatrix4(mesh.matrixWorld)
    _b.fromBufferAttribute(pos, vertexOf(geo, t, 1)).applyMatrix4(mesh.matrixWorld)
    _c.fromBufferAttribute(pos, vertexOf(geo, t, 2)).applyMatrix4(mesh.matrixWorld)
    box.expandByPoint(_a).expandByPoint(_b).expandByPoint(_c)
    const cross = new THREE.Vector3().subVectors(_b, _a).cross(new THREE.Vector3().subVectors(_c, _a))
    const area = cross.length() / 2
    if (area <= 0) continue
    if (mirrored) cross.negate() // a mirrored transform flips the winding
    areaSum += area
    centre.add(new THREE.Vector3().add(_a).add(_b).add(_c).multiplyScalar(area / 3))
    normal.add(cross.multiplyScalar(0.5)) // area-weighted face normal
  }
  if (areaSum <= 0) {
    box.setFromObject(mesh)
    return { position: box.getCenter(new THREE.Vector3()), normal: null, size: box.getSize(new THREE.Vector3()).length() }
  }
  centre.divideScalar(areaSum)
  // How one-sided are the faces? ~1 for a flat panel / lens, ~0 for a closed shape.
  const coherence = normal.length() / areaSum
  return {
    position: centre,
    normal: coherence > 0.25 ? normal.normalize() : null,
    size: box.getSize(new THREE.Vector3()).length(),
  }
}

// The direction a cone light should shine: along the surface's own facing, flipped if need be so
// it points AWAY from the part it sits on (`partCentre`: the middle of the whole mesh), or — for a
// part with no single facing — straight out from `partCentre`, falling back to up.
export function outwardDirection(surface, partCentre) {
  const away = new THREE.Vector3().subVectors(surface.position, partCentre)
  if (surface.normal) {
    const n = surface.normal.clone()
    if (away.lengthSq() > 1e-10 && n.dot(away) < 0) n.negate()
    return n
  }
  return away.lengthSq() > 1e-10 ? away.normalize() : new THREE.Vector3(0, 1, 0)
}

const hex = (rgb) => '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')

// The average colour (sRGB hex) of some faces as the TEXTURE shows them — what the light
// should be tinted. `source` = the original material(s), so a toon / unlit stand-in does not matter.
export function averageSurfaceColor(mesh, tris, source = null) {
  const list = triangleList(mesh, tris)
  const stride = Math.max(1, Math.floor(list.length / 64))
  const sum = [0, 0, 0]
  const tmp = [0, 0, 0]
  let n = 0
  for (let i = 0; i < list.length; i += stride) {
    triangleColor(mesh, list[i], tmp, source)
    sum[0] += tmp[0]; sum[1] += tmp[1]; sum[2] += tmp[2]
    n++
  }
  return n ? hex([sum[0] / n, sum[1] / n, sum[2] / n]) : '#ffffff'
}

// Brighten a colour toward its own hue (a dull red lens makes a red light, not a dark one).
export function lightColourFrom(hexColour) {
  const c = new THREE.Color(hexColour)
  const hsl = { h: 0, s: 0, l: 0 }
  c.getHSL(hsl)
  if (hsl.s < 0.08) return '#' + new THREE.Color().setHSL(hsl.h, 0, Math.max(hsl.l, 0.85)).getHexString() // greys / whites -> soft white
  return '#' + new THREE.Color().setHSL(hsl.h, Math.max(hsl.s, 0.7), Math.min(Math.max(hsl.l, 0.5), 0.65)).getHexString()
}

export { fromRanges }
