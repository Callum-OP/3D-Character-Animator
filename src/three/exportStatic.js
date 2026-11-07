import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Static-mesh export (OBJ / STL / PLY).
//
// These formats hold geometry only — no skeleton, no animation, no real materials — so a
// posed character has to become plain meshes first. Three's OBJExporter and PLYExporter
// read the raw bind-pose vertices and ignore skinning (STLExporter handles it, but nothing
// else here does), so every mesh is baked into world space with its skin and shape keys
// applied. The result is exactly the shape on screen (or the rest pose, if the caller put
// the copy in it), and one code path feeds all three writers.
//
// Works on the export COPY from exportSceneModel — the live scene is never touched.

export const STATIC_FORMATS = {
  obj: { ext: 'obj', label: 'OBJ', mime: 'text/plain' },
  stl: { ext: 'stl', label: 'STL', mime: 'model/stl' },
  ply: { ext: 'ply', label: 'PLY', mime: 'application/octet-stream' },
}

export function isStaticFormat(format) {
  return Object.prototype.hasOwnProperty.call(STATIC_FORMATS, format)
}

function visibleInHierarchy(node) {
  for (let o = node; o; o = o.parent) if (o.visible === false) return false
  return true
}

const _v = new THREE.Vector3()

// A mesh's CURRENT shape in world space: shape keys and skinning applied, then its transform.
function bakeGeometry(mesh) {
  const src = mesh.geometry
  const position = src?.getAttribute('position')
  if (!position || position.count === 0) return null

  const count = position.count
  const out = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    mesh.getVertexPosition(i, _v) // applies morph targets, and bones for a SkinnedMesh
    _v.applyMatrix4(mesh.matrixWorld)
    out[i * 3] = _v.x
    out[i * 3 + 1] = _v.y
    out[i * 3 + 2] = _v.z
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(out, 3))
  const uv = src.getAttribute('uv')
  if (uv) geometry.setAttribute('uv', uv.clone())
  const color = src.getAttribute('color')
  if (color) geometry.setAttribute('color', color.clone())

  // A mirrored transform (negative scale) turns triangles inside out — flip them back.
  let index = src.index ? Array.from(src.index.array) : null
  if (mesh.matrixWorld.determinant() < 0) {
    if (!index) index = Array.from({ length: count }, (_, i) => i)
    for (let i = 0; i + 2 < index.length; i += 3) {
      const t = index[i + 1]
      index[i + 1] = index[i + 2]
      index[i + 2] = t
    }
  }
  if (index) geometry.setIndex(index)

  geometry.computeVertexNormals()
  return geometry
}

// Merge baked meshes into one, keeping only what every writer can use. Geometries are made
// uniform first (same attributes, all indexed) because mergeGeometries requires that.
function mergeBaked(list) {
  const uniform = list.map((geometry) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', geometry.getAttribute('position'))
    g.setAttribute('normal', geometry.getAttribute('normal'))
    g.setAttribute('uv', geometry.getAttribute('uv') || new THREE.BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 2), 2))
    g.setIndex(geometry.index || Array.from({ length: geometry.getAttribute('position').count }, (_, i) => i))
    return g
  })
  return mergeGeometries(uniform, false)
}

// root: the export copy (already posed / un-posed as asked). Returns plain world-space meshes
// in a fresh group, plus counts for the status message.
export function bakeStaticMeshes(root, { merge = false } = {}) {
  root.updateMatrixWorld(true)
  const baked = []
  root.traverse((node) => {
    if (!node.isMesh || !visibleInHierarchy(node)) return
    const geometry = bakeGeometry(node)
    if (geometry) baked.push({ name: node.name, geometry })
  })

  const group = new THREE.Group()
  group.name = 'Scene'
  const material = new THREE.MeshBasicMaterial()
  if (merge && baked.length > 1) {
    const mesh = new THREE.Mesh(mergeBaked(baked.map((b) => b.geometry)), material)
    mesh.name = 'Combined'
    group.add(mesh)
  } else {
    for (const { name, geometry } of baked) {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.name = (name || 'mesh').replace(/\s+/g, '_') // OBJ object names can't hold spaces
      group.add(mesh)
    }
  }
  group.updateMatrixWorld(true)
  return { group, meshes: baked.length }
}

// → Blob in the requested format. Exporters are imported on demand (rarely used, sizeable).
export async function writeStaticModel(format, group) {
  const info = STATIC_FORMATS[format]
  if (!info) throw new Error(`Unknown export format: ${format}`)
  if (format === 'obj') {
    const { OBJExporter } = await import('three/examples/jsm/exporters/OBJExporter.js')
    return new Blob([new OBJExporter().parse(group)], { type: info.mime })
  }
  if (format === 'stl') {
    const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js')
    return new Blob([new STLExporter().parse(group, { binary: true })], { type: info.mime })
  }
  const { PLYExporter } = await import('three/examples/jsm/exporters/PLYExporter.js')
  return new Blob([new PLYExporter().parse(group, undefined, { binary: true, littleEndian: true })], { type: info.mime })
}
