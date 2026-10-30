import initTinyUSDZ from 'tinyusdz/tinyusdz.js'

// Reads a USD file (.usdz / .usdc / .usda / .usd) with TinyUSDZ (WebAssembly) and returns it as PLAIN DATA:
// no three.js objects, only arrays and typed arrays, so the result can be posted out of a Web Worker without
// copying work and so the reader's memory can be thrown away (see usdImport.js: the worker is terminated
// afterwards, which frees the WebAssembly heap — about 370 MB for a 35 MB file — instead of keeping it for the
// life of the page).
//
// Shape of the result:
//   {
//     nodes:     { name, type: 'xform' | 'mesh', mesh: index | -1, matrix: [16 numbers, row-major], children: [...] },
//     meshes:    [{ name, points: Float32Array, normals?: Float32Array, texcoords?: Float32Array,
//                   indices: Uint32Array, materialId, doubleSided }],   // triangles, vertex-indexed
//     materials: { [id]: { ...UsdPreviewSurface values and texture ids } },
//     textures:  { [id]: { imageId, wrapS, wrapT } },
//     images:    { [id]: { uri, data?: Uint8Array } },                  // encoded bytes (jpg / png), not decoded
//   }

const copy = (typed) => (typed ? typed.slice() : undefined) // the reader's arrays are views into its own memory

function convertNode(node) {
  return {
    name: node.primName || '',
    type: node.nodeType,
    mesh: node.nodeType === 'mesh' ? node.contentId : -1,
    matrix: Array.from(node.localMatrix || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    children: (node.children || []).map(convertNode),
  }
}

/**
 * @param {Uint8Array} bytes   the file
 * @param {string} name        its file name (the reader uses the extension)
 * @param {Uint8Array} wasmBinary  the TinyUSDZ WebAssembly module
 */
export async function extractUsd(bytes, name, wasmBinary) {
  // `locateFile` matters inside the app's inline (blob:) worker: without it the reader's start-up builds
  // new URL('tinyusdz.wasm', import.meta.url) even though the binary is supplied, and a relative URL on a
  // blob: address throws. With it the supplied binary is used and no URL is built.
  const native = await initTinyUSDZ({ wasmBinary, locateFile: (path) => path })
  const usd = new native.TinyUSDZLoaderNative()
  try {
    usd.setLoadTextureInNative(false) // keep the encoded images: the browser decodes them far faster than the module would
    if (!usd.loadFromBinary(bytes, name)) {
      throw new Error(String(usd.error() || 'the file could not be read as USD'))
    }

    const meshes = []
    const materials = {}
    const textures = {}
    const images = {}
    for (let i = 0; i < usd.numMeshes(); i++) {
      const m = usd.getMesh(i)
      const mesh = {
        name: m.primName || '',
        points: copy(m.points),
        normals: copy(m.normals),
        texcoords: copy(m.texcoords),
        indices: Uint32Array.from(m.faceVertexIndices),
        materialId: m.materialId,
        doubleSided: !!m.doubleSided,
      }
      meshes.push(mesh)
      if (mesh.materialId >= 0 && materials[mesh.materialId] === undefined) {
        const material = JSON.parse(JSON.stringify(usd.getMaterial(mesh.materialId)))
        materials[mesh.materialId] = material
        for (const key of Object.keys(material)) {
          if (!key.endsWith('TextureId')) continue
          const id = material[key]
          if (textures[id] !== undefined) continue
          const tex = usd.getTexture(id)
          textures[id] = { imageId: tex.textureImageId, wrapS: tex.wrapS, wrapT: tex.wrapT }
          if (images[tex.textureImageId] === undefined) {
            const image = usd.getImage(tex.textureImageId)
            images[tex.textureImageId] = {
              uri: image.uri || '',
              data: image.bufferId >= 0 && image.data ? new Uint8Array(image.data) : undefined,
            }
          }
        }
      }
    }
    return { nodes: convertNode(usd.getDefaultRootNode()), meshes, materials, textures, images }
  } finally {
    usd.delete()
  }
}

// Every ArrayBuffer in an extractUsd() result, to hand over (not copy) when posting out of a worker.
export function transferablesOf(data) {
  const buffers = new Set()
  for (const m of data.meshes) {
    for (const key of ['points', 'normals', 'texcoords', 'indices']) if (m[key]) buffers.add(m[key].buffer)
  }
  for (const id of Object.keys(data.images)) if (data.images[id].data) buffers.add(data.images[id].data.buffer)
  return [...buffers]
}
