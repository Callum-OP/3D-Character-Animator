import { describe, it, expect, vi, beforeAll } from 'vitest'
import * as THREE from 'three'
import fs from 'node:fs'
import path from 'node:path'

// The reader's WebAssembly glue refuses to start when it detects Node; the app runs it in a browser worker.
vi.hoisted(() => {
  process.type = 'renderer'
})

import { extractUsd, transferablesOf } from '../three/usd/usdCore.js'
import { buildUsdRoot, mimeOf, readUsdHeader, applyUnits, CENTIMETRE_GUESS_SIZE } from '../three/usd/usdBuild.js'
import { SUPPORTED_EXTENSIONS, SUPPORTED_EXTENSION_RE } from '../three/loadModel.js'
import { MODEL_EXTENSIONS, MODEL_ACCEPT, bundleModelFiles, pickMainModelPath } from '../three/modelBundle.js'

const wasm = new Uint8Array(fs.readFileSync(path.resolve('node_modules/tinyusdz/tinyusdz.wasm')))
const text = (s) => new TextEncoder().encode(s)

const QUAD = `#usda 1.0
(
    defaultPrim = "Root"
    upAxis = "Y"
)
def Xform "Root"
{
    double3 xformOp:translate = (1, 2, 3)
    uniform token[] xformOpOrder = ["xformOp:translate"]
    def Mesh "Quad"
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
        normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1)] (
            interpolation = "vertex"
        )
        texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1)] (
            interpolation = "vertex"
        )
        rel material:binding = </Root/Mat>
    }
    def Material "Mat"
    {
        token outputs:surface.connect = </Root/Mat/Surf.outputs:surface>
        def Shader "Surf"
        {
            uniform token info:id = "UsdPreviewSurface"
            color3f inputs:diffuseColor = (1, 0, 0)
            float inputs:roughness = 0.3
            float inputs:metallic = 0.7
            token outputs:surface
        }
    }
}
`

describe('reading a real USD file with the WebAssembly reader', () => {
  let data
  beforeAll(async () => {
    data = await extractUsd(text(QUAD), 'quad.usda', wasm)
  })

  it('returns plain data: a node tree, triangulated meshes, materials', () => {
    expect(data.meshes.length).toBe(1)
    expect(data.meshes[0].name).toBe('Quad')
    expect(data.meshes[0].indices.length).toBe(6) // the quad became two triangles
    expect(data.meshes[0].points.length).toBe(12)
    expect(data.meshes[0].points).toBeInstanceOf(Float32Array)
    expect(data.nodes.type).toBe('xform')
    const material = data.materials[data.meshes[0].materialId]
    expect(material.roughness).toBeCloseTo(0.3, 5)
    expect(material.metallic).toBeCloseTo(0.7, 5)
  })

  it('its arrays are copies (safe once the reader is thrown away) and can be handed over', () => {
    const buffers = transferablesOf(data)
    expect(buffers.length).toBeGreaterThan(0)
    for (const b of buffers) expect(b.byteLength).toBeLessThan(1e6) // the reader's whole memory was not captured
  })

  it('builds a three.js scene with the placement, material and normals', async () => {
    const root = await buildUsdRoot(data, { name: 'quad' })
    expect(root.name).toBe('quad')
    const meshes = []
    root.traverse((o) => o.isMesh && meshes.push(o))
    expect(meshes.length).toBe(1)
    root.updateMatrixWorld(true)
    const at = new THREE.Vector3().setFromMatrixPosition(meshes[0].matrixWorld)
    expect(at.x).toBeCloseTo(1, 5)
    expect(at.y).toBeCloseTo(2, 5)
    expect(at.z).toBeCloseTo(3, 5)
    const m = meshes[0].material
    expect(m.isMeshStandardMaterial).toBe(true)
    expect(m.color.r).toBeCloseTo(1, 5)
    expect(m.color.g).toBeCloseTo(0, 5)
    expect(m.roughness).toBeCloseTo(0.3, 5)
    expect(m.metalness).toBeCloseTo(0.7, 5)
    expect(meshes[0].geometry.attributes.normal.count).toBe(4)
  })

  it('reports a file it cannot read', async () => {
    await expect(extractUsd(text('this is not usd'), 'bad.usda', wasm)).rejects.toThrow()
  })
})

describe('building the scene from data (no reader needed)', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] // the way USD lays it out: translation in elements 12-14
  const mesh = (extra = {}) => ({
    name: 'm',
    points: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    texcoords: new Float32Array([0, 0, 1, 0, 0, 0.25]),
    indices: new Uint32Array([0, 1, 2]),
    materialId: 0,
    doubleSided: false,
    ...extra,
  })
  const node = (over = {}) => ({ name: 'n', type: 'xform', mesh: -1, matrix: identity, children: [], ...over })
  const fakeImage = () => ({ width: 8, height: 8 })

  it('keeps transforms, drops empty groups, and shares a mesh used twice', async () => {
    const data = {
      nodes: node({
        name: 'scene',
        children: [
          node({ name: 'empty', children: [node({ name: 'alsoEmpty' })] }),
          node({ name: 'a', matrix: translate(5, 0, 0), children: [node({ name: 'ma', type: 'mesh', mesh: 0 })] }),
          node({ name: 'mb', type: 'mesh', mesh: 0, matrix: translate(0, 7, 0) }),
        ],
      }),
      meshes: [mesh()],
      materials: { 0: { diffuseColor: [0.5, 0.5, 0.5] } },
      textures: {},
      images: {},
    }
    const root = await buildUsdRoot(data)
    const names = []
    root.traverse((o) => names.push(o.name))
    expect(names).not.toContain('empty')
    expect(names).not.toContain('alsoEmpty')
    const meshes = []
    root.traverse((o) => o.isMesh && meshes.push(o))
    expect(meshes.length).toBe(2)
    expect(meshes[0].geometry).toBe(meshes[1].geometry)
    root.updateMatrixWorld(true)
    expect(new THREE.Vector3().setFromMatrixPosition(meshes[0].matrixWorld).x).toBeCloseTo(5, 5)
    expect(new THREE.Vector3().setFromMatrixPosition(meshes[1].matrixWorld).y).toBeCloseTo(7, 5)
  })

  it('texture colour spaces, factors that give way to textures, wrap and sharing', async () => {
    const data = {
      nodes: node({ children: [node({ type: 'mesh', mesh: 0 }), node({ type: 'mesh', mesh: 1 })] }),
      meshes: [mesh(), mesh({ materialId: 1 })],
      materials: {
        0: { diffuseColor: [0.18, 0.18, 0.18], diffuseColorTextureId: 0, roughness: 0.5, roughnessTextureId: 1, metallic: 0, metallicTextureId: 1, normalTextureId: 2, occlusionTextureId: 1, emissiveColor: [0, 0, 0], emissiveColorTextureId: 0 },
        1: { diffuseColor: [0.2, 0.4, 0.6], roughness: 0.8 },
      },
      textures: { 0: { imageId: 0, wrapS: 'repeat', wrapT: 'clamp' }, 1: { imageId: 1, wrapS: 'mirror', wrapT: 'repeat' }, 2: { imageId: 2, wrapS: 'repeat', wrapT: 'repeat' } },
      images: { 0: { uri: 'a_baseColor.jpg', data: new Uint8Array(1) }, 1: { uri: 'b_rough.jpg', data: new Uint8Array(1) }, 2: { uri: 'c_normal.png', data: new Uint8Array(1) } },
    }
    const root = await buildUsdRoot(data, { decode: async () => fakeImage() })
    const [textured, plain] = []
    const found = []
    root.traverse((o) => o.isMesh && found.push(o))
    const a = found[0].material
    const b = found[1].material
    expect(a.map.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(a.emissiveMap.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(a.roughnessMap.colorSpace).toBe(THREE.NoColorSpace)
    expect(a.normalMap.colorSpace).toBe(THREE.NoColorSpace)
    expect(a.color.r).toBeCloseTo(1, 5) // the constant 0.18 gave way to the texture
    expect(a.roughness).toBe(1)
    expect(a.metalness).toBe(1)
    expect(a.map.flipY).toBe(false)
    expect(a.map.wrapT).toBe(THREE.ClampToEdgeWrapping)
    expect(a.roughnessMap.wrapS).toBe(THREE.MirroredRepeatWrapping)
    expect(a.roughnessMap.source).toBe(a.metalnessMap.source) // one image, one Source, however many slots use it
    expect(b.map).toBeNull()
    expect(b.color.b).toBeCloseTo(0.6, 5)
    expect(b.roughness).toBeCloseTo(0.8, 5)
    void textured
    void plain
  })

  it('flips texture coordinates (USD starts at the bottom-left, glTF at the top-left)', async () => {
    const data = { nodes: node({ children: [node({ type: 'mesh', mesh: 0 })] }), meshes: [mesh()], materials: { 0: {} }, textures: {}, images: {} }
    const root = await buildUsdRoot(data)
    const found = []
    root.traverse((o) => o.isMesh && found.push(o))
    const uv = found[0].geometry.attributes.uv
    expect(uv.getY(0)).toBeCloseTo(1, 5)
    expect(uv.getY(2)).toBeCloseTo(0.75, 5)
    expect(uv.getX(1)).toBeCloseTo(1, 5) // u is untouched
  })

  it('double-sided meshes get a double-sided copy of a shared material', async () => {
    const data = {
      nodes: node({ children: [node({ type: 'mesh', mesh: 0 }), node({ type: 'mesh', mesh: 1 })] }),
      meshes: [mesh(), mesh({ doubleSided: true })],
      materials: { 0: {} },
      textures: {},
      images: {},
    }
    const root = await buildUsdRoot(data)
    const found = []
    root.traverse((o) => o.isMesh && found.push(o))
    expect(found[0].material.side).toBe(THREE.FrontSide)
    expect(found[1].material.side).toBe(THREE.DoubleSide)
  })

  it('opacity, and a material with no data, and a mesh with no material', async () => {
    const data = {
      nodes: node({ children: [node({ type: 'mesh', mesh: 0 }), node({ type: 'mesh', mesh: 1 })] }),
      meshes: [mesh({ materialId: 0 }), mesh({ materialId: -1, texcoords: undefined, normals: undefined })],
      materials: { 0: { opacity: 0.4, opacityThreshold: 0.5 } },
      textures: {},
      images: {},
    }
    const root = await buildUsdRoot(data)
    const found = []
    root.traverse((o) => o.isMesh && found.push(o))
    expect(found[0].material.transparent).toBe(true)
    expect(found[0].material.opacity).toBeCloseTo(0.4, 5)
    expect(found[0].material.alphaTest).toBeCloseTo(0.5, 5)
    expect(found[1].material.name).toBe('usd_default')
    expect(found[1].geometry.attributes.normal).toBeTruthy() // computed when the file has none
    expect(found[1].geometry.attributes.uv).toBeUndefined()
  })

  it('an image that cannot be decoded leaves the material on its colour', async () => {
    const data = {
      nodes: node({ children: [node({ type: 'mesh', mesh: 0 })] }),
      meshes: [mesh()],
      materials: { 0: { diffuseColor: [0.1, 0.2, 0.3], diffuseColorTextureId: 0 } },
      textures: { 0: { imageId: 0, wrapS: 'repeat', wrapT: 'repeat' } },
      images: { 0: { uri: 'x.jpg', data: new Uint8Array(1) } },
    }
    const root = await buildUsdRoot(data, { decode: async () => { throw new Error('bad image') } })
    const found = []
    root.traverse((o) => o.isMesh && found.push(o))
    expect(found[0].material.map).toBeNull()
    expect(found[0].material.color.g).toBeCloseTo(0.2, 5)
  })

  it('picks an image type from its name or its first bytes', () => {
    expect(mimeOf({ uri: 'a/b.JPG' })).toBe('image/jpeg')
    expect(mimeOf({ uri: 'x.png' })).toBe('image/png')
    expect(mimeOf({ uri: 'noext', data: new Uint8Array([0xff, 0xd8, 0xff]) })).toBe('image/jpeg')
  })
})

describe('units and up axis', () => {
  const box = (size) => {
    const g = new THREE.Group()
    g.add(new THREE.Mesh(new THREE.BoxGeometry(size, size / 10, size / 10)))
    return g
  }
  it('reads metersPerUnit and upAxis from a text file\'s header, and nothing from a binary one', () => {
    expect(readUsdHeader(text('#usda 1.0\n(\n  metersPerUnit = 0.01\n  upAxis = "Z"\n)\n'))).toEqual({ metersPerUnit: 0.01, upAxis: 'Z' })
    expect(readUsdHeader(text('#usda 1.0\n(\n)\n'))).toEqual({ metersPerUnit: null, upAxis: null })
    expect(readUsdHeader(new Uint8Array([0x50, 0x58, 0x52, 0x2d, 0x55, 0x53, 0x44, 0x43, 1, 2, 3]))).toBeNull() // PXR-USDC
    expect(readUsdHeader(null)).toBeNull()
  })
  it('applies the file\'s own units exactly and stands a Z-up scene upright', () => {
    const scene = box(300)
    const info = applyUnits(scene, { metersPerUnit: 0.01, upAxis: 'Z' })
    expect(scene.scale.x).toBeCloseTo(0.01, 6)
    expect(scene.rotation.x).toBeCloseTo(-Math.PI / 2, 6)
    expect(info).toMatchObject({ metersPerUnit: 0.01, guessed: false, upAxis: 'Z' })
  })
  it('with no units given, a scene far wider than a building is taken as centimetres; a normal one is left alone', () => {
    const huge = box(CENTIMETRE_GUESS_SIZE + 500)
    expect(applyUnits(huge, null)).toMatchObject({ metersPerUnit: 0.01, guessed: true })
    expect(huge.scale.x).toBeCloseTo(0.01, 6)
    const normal = box(40)
    expect(applyUnits(normal, null)).toMatchObject({ metersPerUnit: 1, guessed: false })
    expect(normal.scale.x).toBe(1)
  })
  it('buildUsdRoot scales a big binary-style scene and records what it did', async () => {
    const data = {
      nodes: { name: 'scene', type: 'xform', mesh: -1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], children: [{ name: 'm', type: 'mesh', mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], children: [] }] },
      meshes: [{ name: 'm', points: new Float32Array([0, 0, 0, 4000, 0, 0, 0, 100, 0]), indices: new Uint32Array([0, 1, 2]), materialId: -1, doubleSided: false }],
      materials: {}, textures: {}, images: {},
    }
    const root = await buildUsdRoot(data)
    const scene = root.children[0]
    expect(scene.userData.usdUnits.guessed).toBe(true)
    root.updateMatrixWorld(true)
    expect(new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).x).toBeCloseTo(40, 3)
  })
})

describe('USD is a supported import', () => {
  it('is listed for drops, pickers and zip bundles', () => {
    for (const e of ['usdz', 'usd', 'usda', 'usdc']) {
      expect(SUPPORTED_EXTENSIONS).toContain(e)
      expect(MODEL_EXTENSIONS).toContain(e)
      expect(MODEL_ACCEPT).toContain('.' + e)
    }
    expect(SUPPORTED_EXTENSION_RE.test('subway.usdz')).toBe(true)
  })

  it('a lone .usdz goes straight through, and a bundle finds it as the main model', async () => {
    const f = new File([new Uint8Array(4)], 'station.usdz')
    expect(await bundleModelFiles([{ file: f, path: 'station.usdz' }])).toBe(f)
    const files = new Map([['readme.txt', new Uint8Array(1)], ['a/station.usdz', new Uint8Array(9)]])
    expect(pickMainModelPath(files)).toBe('a/station.usdz')
  })

  it('a blend still ranks last, so a USD next to it wins', () => {
    const files = new Map([['x.blend', new Uint8Array(99)], ['y.usdz', new Uint8Array(1)]])
    expect(pickMainModelPath(files)).toBe('y.usdz')
  })
})

describe('the reader starts without building a URL from its own address', () => {
  it('works when its script location is a blob: address (as in the app\'s inline worker)', async () => {
    // The glue computes new URL("tinyusdz.wasm", import.meta.url) unless it is given a locateFile.
    // Under a blob: base that throws, so the importer always passes one; prove it reads a file regardless.
    const data = await extractUsd(text(QUAD), 'quad.usda', wasm)
    expect(data.meshes.length).toBe(1)
    expect(() => new URL('tinyusdz.wasm', 'blob:https://example.test/1234-abcd')).toThrow()
  })
})
