// Tiny hand-made model files for the folder/bundle loading tests. Real exporters
// reference textures in all the ways below; these reproduce them without checking
// megabytes of someone else's assets into the repo.

// A 1x1 PNG (a real, decodable file) — the bytes matter for "was THIS file served" checks.
export const PNG_1PX = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)
// A different payload that is still "an image" for the loader (never decoded — the test stubs decode).
export const imageBytes = (seed) => Uint8Array.from({ length: 24 }, (_, i) => (seed * 31 + i * 7) & 255)

// jsdom's TextEncoder hands back Node's Uint8Array, a different class from the test's global one,
// which fflate then mistakes for a folder. Copy into the global realm.
const enc = (s) => new Uint8Array(new TextEncoder().encode(s))

// ASCII FBX: one UV'd quad, one material, and a Texture/Video pair whose file name
// is `filename` — an ABSOLUTE WINDOWS path from the exporter's machine, the usual case.
export function asciiFbx({ filename = 'C:\\Users\\artist\\Desktop\\project\\textures\\wood.png', relative = '..\\textures\\wood.png', withTexture = true } = {}) {
  const texture = withTexture
    ? `
    Texture: 4000, "Texture::wood", "" {
        Type: "TextureVideoClip"
        Version: 202
        TextureName: "Texture::wood"
        Media: "Video::wood"
        FileName: "${filename.replace(/\\/g, '\\\\')}"
        RelativeFilename: "${relative.replace(/\\/g, '\\\\')}"
    }
    Video: 5000, "Video::wood", "Clip" {
        Type: "Clip"
        FileName: "${filename.replace(/\\/g, '\\\\')}"
        RelativeFilename: "${relative.replace(/\\/g, '\\\\')}"
    }`
    : ''
  const textureLinks = withTexture
    ? `
    C: "OP", 4000, 3000, "DiffuseColor"
    C: "OO", 5000, 4000`
    : ''
  return enc(tabify(`; FBX 7.3.0 project file
FBXHeaderExtension:  {
    FBXHeaderVersion: 1003
    FBXVersion: 7300
}
GlobalSettings:  {
    Version: 1000
    Properties70:  {
        P: "UpAxis", "int", "Integer", "",1
        P: "UpAxisSign", "int", "Integer", "",1
        P: "FrontAxis", "int", "Integer", "",2
        P: "FrontAxisSign", "int", "Integer", "",1
        P: "CoordAxis", "int", "Integer", "",0
        P: "CoordAxisSign", "int", "Integer", "",1
        P: "UnitScaleFactor", "double", "Number", "",1
    }
}
Objects:  {
    Geometry: 1000, "Geometry::Quad", "Mesh" {
        Vertices: *12 {
            a: 0,0,0,1,0,0,1,1,0,0,1,0
        }
        PolygonVertexIndex: *4 {
            a: 0,1,2,-4
        }
        GeometryVersion: 124
        LayerElementUV: 0 {
            Version: 101
            Name: "UVMap"
            MappingInformationType: "ByPolygonVertex"
            ReferenceInformationType: "IndexToDirect"
            UV: *8 {
                a: 0,0,1,0,1,1,0,1
            }
            UVIndex: *4 {
                a: 0,1,2,3
            }
        }
        LayerElementMaterial: 0 {
            Version: 101
            Name: ""
            MappingInformationType: "AllSame"
            ReferenceInformationType: "IndexToDirect"
            Materials: *1 {
                a: 0
            }
        }
        Layer: 0 {
            Version: 100
            LayerElement:  {
                Type: "LayerElementUV"
                TypedIndex: 0
            }
            LayerElement:  {
                Type: "LayerElementMaterial"
                TypedIndex: 0
            }
        }
    }
    Model: 2000, "Model::Quad", "Mesh" {
        Version: 232
        Properties70:  {
            P: "Lcl Translation", "Lcl Translation", "", "A",0,0,0
        }
    }
    Material: 3000, "Material::wood", "" {
        Version: 102
        ShadingModel: "phong"
        Properties70:  {
            P: "DiffuseColor", "Color", "", "A",0.8,0.8,0.8
        }
    }${texture}
}
Connections:  {
    C: "OO", 2000, 0
    C: "OO", 1000, 2000
    C: "OO", 3000, 2000${textureLinks}
}
`))
}

// FBX's ASCII parser (three's FBXLoader) only understands TAB indentation, one tab
// per nesting level. The template above is written with 4 spaces per level so it
// stays readable; convert the leading spaces.
function tabify(text) {
  return text.replace(/^( +)/gm, (spaces) => '\t'.repeat(Math.floor(spaces.length / 4)))
}

export const OBJ_QUAD = (mtl = 'quad.mtl') => enc(`mtllib ${mtl}
o Quad
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 1
usemtl Wood
f 1/1/1 2/2/1 3/3/1 4/4/1
`)

export const MTL = (map = 'textures/diffuse.png') => enc(`newmtl Wood
Kd 0.8 0.8 0.8
map_Kd ${map}
`)

// glTF with an external .bin and an external image.
export function gltfWithExternals({ imageUri = 'tex/albedo.png', bufferUri = 'geometry.bin' } = {}) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1])
  const bin = new Uint8Array(positions.byteLength + uvs.byteLength)
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(uvs.buffer), positions.byteLength)
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Tri' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ uri: imageUri }],
    buffers: [{ uri: bufferUri, byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: uvs.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
  }
  return { gltf: enc(JSON.stringify(json)), bin }
}

export const ASCII_STL = enc(`solid tri
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
endsolid tri
`)

// An OBJ with several materials (usemtl groups), optionally naming an .mtl that
// does not exist in the download — the "detective" layout (Mixamo Fuse export).
export const OBJ_MULTI = (materials = ['Body', 'Hat'], mtl = 'missing.mtl') => {
  const lines = [`mtllib ${mtl}`]
  let v = 0
  for (const name of materials) {
    lines.push(`g ${name}`, `usemtl ${name}`)
    lines.push('v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'vt 0 0', 'vt 1 0', 'vt 1 1', 'vn 0 0 1')
    lines.push(`f ${v + 1}/${v + 1}/${v + 1} ${v + 2}/${v + 2}/${v + 1} ${v + 3}/${v + 3}/${v + 1}`)
    v += 3
  }
  return enc(lines.join('\n') + '\n')
}
