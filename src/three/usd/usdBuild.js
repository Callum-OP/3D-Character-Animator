import * as THREE from 'three'

// Turns the plain data from usdCore.js into a three.js scene (static meshes with PBR materials).
//
//   • USD texture coordinates start at the bottom-left, glTF's (and so this app's) at the top-left, so v is
//     flipped to 1 - v, exactly as when a glTF is loaded. Images are used as decoded (flipY false); that keeps
//     the exported .glb correct.
//   • UsdPreviewSurface becomes MeshStandardMaterial. A constant (colour, roughness, metalness) is the
//     FALLBACK for a texture, so when a texture is connected the factor becomes 1 and the texture decides.
//   • Colour textures (base colour, emissive) are sRGB; everything else (normal, roughness, metalness,
//     occlusion, opacity) is linear data.
//   • Up axis Y and metres are assumed (the reader does not report them). A Z-up file imports lying on its side:
//     rotate it afterwards.
//   • Empty transform groups are dropped, and a mesh used by several nodes shares one geometry.

const WRAP = { repeat: THREE.RepeatWrapping, clamp: THREE.ClampToEdgeWrapping, mirror: THREE.MirroredRepeatWrapping }
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' }

export function mimeOf(image) {
  const ext = String(image.uri || '').split('?')[0].split('.').pop().toLowerCase()
  if (MIME[ext]) return MIME[ext]
  const d = image.data
  if (d && d[0] === 0xff && d[1] === 0xd8) return 'image/jpeg'
  if (d && d[0] === 0x89 && d[1] === 0x50) return 'image/png'
  return 'image/png'
}

// The browser's own decoder (off the main thread, and much faster than doing it in WebAssembly).
export async function decodeImageBytes(image) {
  const blob = new Blob([image.data], { type: mimeOf(image) })
  return createImageBitmap(blob)
}

// Run async work over a list, a few at a time.
async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn))
}

function geometryOf(mesh) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.points, 3))
  const vertexCount = mesh.points.length / 3
  geometry.setIndex(new THREE.BufferAttribute(vertexCount < 65536 ? Uint16Array.from(mesh.indices) : mesh.indices, 1))
  if (mesh.texcoords && mesh.texcoords.length === vertexCount * 2) {
    const uv = mesh.texcoords
    for (let i = 1; i < uv.length; i += 2) uv[i] = 1 - uv[i]
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  }
  if (mesh.normals && mesh.normals.length === mesh.points.length) {
    geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
  } else {
    geometry.computeVertexNormals()
  }
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
  return geometry
}

/**
 * @param data    the result of extractUsd()
 * @param options { decode(image) -> ImageBitmap | canvas | null, name }
 * @returns {Promise<THREE.Group>}
 */
export async function buildUsdRoot(data, { decode = decodeImageBytes, name = 'usd', units = null } = {}) {
  // 1. Decode the images (a few at a time), then wrap them as textures as materials ask for them.
  const imageIds = Object.keys(data.images).filter((id) => data.images[id].data)
  const decoded = new Map()
  await inBatches(imageIds, 8, async (id) => {
    try {
      const image = await decode(data.images[id])
      if (image) decoded.set(Number(id), image)
    } catch {
      /* an image that cannot be decoded: the material keeps its constant colour */
    }
  })
  const baseTextures = new Map() // imageId -> Texture (its Source is shared by every variant)
  const textureCache = new Map()
  const textureFor = (textureId, srgb) => {
    if (textureId === undefined) return null
    const info = data.textures[textureId]
    if (!info) return null
    const key = textureId + (srgb ? ':s' : ':l')
    if (textureCache.has(key)) return textureCache.get(key)
    const image = decoded.get(info.imageId)
    if (!image) return null
    let texture
    const base = baseTextures.get(info.imageId)
    if (base) {
      texture = base.clone() // shares the image
    } else {
      texture = new THREE.Texture(image)
      baseTextures.set(info.imageId, texture)
    }
    texture.flipY = false
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    texture.wrapS = WRAP[info.wrapS] ?? THREE.RepeatWrapping
    texture.wrapT = WRAP[info.wrapT] ?? THREE.RepeatWrapping
    texture.needsUpdate = true
    textureCache.set(key, texture)
    return texture
  }

  // 2. Materials (shared between the meshes that use them).
  const materialCache = new Map()
  const materialFor = (materialId, doubleSided) => {
    const key = materialId + (doubleSided ? ':2' : ':1')
    if (materialCache.has(key)) return materialCache.get(key)
    const u = data.materials[materialId]
    const m = new THREE.MeshStandardMaterial({ name: 'usd_material_' + materialId })
    if (u) {
      const map = textureFor(u.diffuseColorTextureId, true)
      if (map) {
        m.map = map
        m.color.setRGB(1, 1, 1)
      } else if (u.diffuseColor) {
        m.color.setRGB(u.diffuseColor[0], u.diffuseColor[1], u.diffuseColor[2])
      }
      const emissiveMap = textureFor(u.emissiveColorTextureId, true)
      if (emissiveMap) {
        m.emissiveMap = emissiveMap
        m.emissive.setRGB(1, 1, 1)
      } else if (u.emissiveColor) {
        m.emissive.setRGB(u.emissiveColor[0], u.emissiveColor[1], u.emissiveColor[2])
      }
      const roughnessMap = textureFor(u.roughnessTextureId, false)
      m.roughness = roughnessMap ? 1 : u.roughness ?? 0.5
      if (roughnessMap) m.roughnessMap = roughnessMap
      const metalnessMap = textureFor(u.metallicTextureId, false)
      m.metalness = metalnessMap ? 1 : u.metallic ?? 0
      if (metalnessMap) m.metalnessMap = metalnessMap
      const normalMap = textureFor(u.normalTextureId, false)
      if (normalMap) m.normalMap = normalMap
      const aoMap = textureFor(u.occlusionTextureId, false)
      if (aoMap) m.aoMap = aoMap
      const alphaMap = textureFor(u.opacityTextureId, false)
      if (alphaMap) {
        m.alphaMap = alphaMap
        m.transparent = true
      }
      if (u.opacity !== undefined && u.opacity < 1) {
        m.opacity = u.opacity
        m.transparent = true
      }
      if (u.opacityThreshold > 0) m.alphaTest = u.opacityThreshold
    }
    if (doubleSided) m.side = THREE.DoubleSide
    materialCache.set(key, m)
    return m
  }

  // 3. The scene graph.
  const geometries = new Map()
  const placeholder = new THREE.MeshStandardMaterial({ color: 0xb0b0b0, name: 'usd_default' })
  const matrix = new THREE.Matrix4()
  const place = (object, node) => {
    object.name = node.name
    matrix.fromArray(node.matrix) // USD writes its matrices for row vectors: the translation sits in elements 12-14, which is three.js's own order
    matrix.decompose(object.position, object.quaternion, object.scale)
  }
  const build = (node) => {
    let object
    if (node.type === 'mesh' && data.meshes[node.mesh]) {
      const mesh = data.meshes[node.mesh]
      let geometry = geometries.get(node.mesh)
      if (!geometry) {
        geometry = geometryOf(mesh)
        geometries.set(node.mesh, geometry)
      }
      const material = mesh.materialId >= 0 && data.materials[mesh.materialId] ? materialFor(mesh.materialId, mesh.doubleSided) : placeholder
      object = new THREE.Mesh(geometry, material)
    } else {
      object = new THREE.Group()
    }
    place(object, node)
    for (const child of node.children) {
      const built = build(child)
      if (built) object.add(built)
    }
    // An empty transform adds nothing but scene nodes.
    if (!object.isMesh && object.children.length === 0) return null
    return object
  }

  const root = new THREE.Group()
  root.name = name
  const scene = build(data.nodes)
  if (scene) {
    root.add(scene)
    applyUnits(scene, units)
  }
  return root
}

// A scene wider than this many units is taken to be in centimetres when the file does not say (see applyUnits).
export const CENTIMETRE_GUESS_SIZE = 1500

// USD scenes declare their units (metersPerUnit) and up axis, and most DCC tools write centimetres. The
// binary reader does not report them, so they come from the header of a text file when there is one
// (readUsdHeader). Otherwise a scene whose largest side is over CENTIMETRE_GUESS_SIZE units is taken to be in
// centimetres — a station 4500 units long is 45 m, not 4.5 km — and scaled by 0.01; smaller scenes are left alone.
// The scale and rotation go on the scene's top node, so the object's own transform stays the user's.
export function applyUnits(scene, units) {
  if (units && units.upAxis === 'Z') scene.rotateX(-Math.PI / 2)
  let scale = units && units.metersPerUnit > 0 ? units.metersPerUnit : null
  let guessed = false
  if (scale === null) {
    scene.updateMatrixWorld(true)
    const size = new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3())
    if (Math.max(size.x, size.y, size.z) > CENTIMETRE_GUESS_SIZE) {
      scale = 0.01
      guessed = true
    }
  }
  if (scale !== null && scale !== 1) scene.scale.multiplyScalar(scale)
  scene.userData.usdUnits = { metersPerUnit: scale ?? 1, guessed, upAxis: units && units.upAxis === 'Z' ? 'Z' : 'Y' }
  return scene.userData.usdUnits
}

// Units and up axis from the header of a TEXT USD file (.usda); null for binary files.
export function readUsdHeader(bytes) {
  if (!bytes || bytes.length < 8) return null
  let head = ''
  for (let i = 0; i < Math.min(bytes.length, 4096); i++) head += String.fromCharCode(bytes[i])
  if (!/^#usda/.test(head)) return null
  const meters = /metersPerUnit\s*=\s*([0-9.eE+-]+)/.exec(head)
  const up = /upAxis\s*=\s*"([XYZxyz])"/.exec(head)
  return { metersPerUnit: meters ? parseFloat(meters[1]) : null, upAxis: up ? up[1].toUpperCase() : null }
}
