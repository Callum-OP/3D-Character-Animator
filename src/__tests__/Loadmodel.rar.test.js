import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { installImageStubs } from './helpers/imageStubs.js'
import { asciiFbx, OBJ_MULTI, PNG_1PX, imageBytes } from './helpers/modelFixtures.js'
import { __setRarExtractorForTest } from '../three/archive.js'
import { loadModel, SUPPORTED_EXTENSIONS } from '../three/loadModel.js'
import { bundleModelFiles, MODEL_ACCEPT } from '../three/modelBundle.js'

// The wiring around RAR (loadModel → archive reader → bundle logic), with a stand-in for the
// WebAssembly reader — which is tested for real in Archive.rar.test.js (Node environment).
let stubs
beforeAll(() => {
  stubs = installImageStubs()
})
afterAll(() => stubs.restore())

// A file that LOOKS like a RAR to the app (real signature) and carries a key to the contents
// the stand-in reader should return for it.
const registry = new Map()
let counter = 0
function fakeRar(contents) {
  const id = ++counter
  registry.set(id, contents)
  return Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00, id])
}
beforeEach(() => {
  __setRarExtractorForTest(async (buf) => {
    const bytes = new Uint8Array(buf)
    const contents = registry.get(bytes[bytes.length - 1])
    if (contents instanceof Error) throw contents
    return new Map(Object.entries(contents))
  })
})
afterEach(() => __setRarExtractorForTest(null))

const opts = { autoDecimate: false }
const meshes = (parsed) => {
  const out = []
  parsed.root.traverse((o) => o.isMesh && out.push(o))
  return out
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

describe('.rar files', () => {
  it('are accepted by every picker and by the loader', () => {
    expect(MODEL_ACCEPT).toContain('.rar')
    expect(SUPPORTED_EXTENSIONS).toContain('rar')
  })

  it('a .rar holding a model and its textures loads with the textures applied', async () => {
    const rar = new File([fakeRar({ 'source/m.obj': OBJ_MULTI(['Body', 'Hat']), 'textures/detective_Body_diffuse.png': PNG_1PX, 'textures/detective_Hat_diffuse.png': imageBytes(5) })], 'pack.rar')
    const parsed = await loadModel(rar, opts)
    expect(parsed.info.name).toBe('pack')
    const byName = Object.fromEntries(meshes(parsed).map((m) => [m.material.name, m.material]))
    expect(same(await stubs.bytesOf(byName.Body.map.image.src), PNG_1PX)).toBe(true)
    expect(same(await stubs.bytesOf(byName.Hat.map.image.src), imageBytes(5))).toBe(true)
  })

  it('a model and a separate textures .rar, picked together (the Cars FBX + its textures)', async () => {
    const tex = new File([fakeRar({ 'textures/wood.png': PNG_1PX })], 'textures.rar')
    const fbx = new File([asciiFbx()], 'Cars.fbx') // references ..\textures\wood.png
    const bundled = await bundleModelFiles([
      { file: fbx, path: 'Cars.fbx' },
      { file: tex, path: 'textures.rar' },
    ])
    const parsed = await loadModel(bundled, opts)
    expect(meshes(parsed)[0].material.map).toBeTruthy()
    expect(parsed.info.bundle.missingTextures).toEqual([])
  })

  it('a model whose textures sit in a .rar loaded from inside a zip', async () => {
    const { zipSync } = await import('three/examples/jsm/libs/fflate.module.js')
    const zip = new File([zipSync({ 'a/Cars.fbx': asciiFbx(), 'a/textures.rar': fakeRar({ 'wood.png': PNG_1PX }) }, { level: 0 })], 'cars.zip')
    const parsed = await loadModel(zip, opts)
    expect(meshes(parsed)[0].material.map).toBeTruthy()
  })

  it('without the textures .rar, the missing texture is reported (not silently plain)', async () => {
    const parsed = await loadModel(new File([asciiFbx()], 'Cars.fbx'), opts)
    expect(parsed.info.bundle.missingTextures.map((p) => p.split('/').pop())).toEqual(['wood.png'])
  })
})

describe('when a .rar cannot be read', () => {
  it('a password-protected one says so', async () => {
    const rar = new File([fakeRar(new Error('This RAR archive is password-protected, which is not supported.'))], 'locked.rar')
    await expect(loadModel(rar, opts)).rejects.toThrow('Failed to load model: This RAR archive is password-protected, which is not supported.')
  })

  it('a corrupt one is explained', async () => {
    const rar = new File([fakeRar(new Error('could not read the RAR archive (ERAR_BAD_DATA)'))], 'broken.rar')
    await expect(loadModel(rar, opts)).rejects.toThrow(/Failed to load model: could not read the RAR archive/)
  })

  it('a file named .rar that is not an archive at all is a readable error', async () => {
    await expect(loadModel(new File(['just some text'], 'fake.rar'), opts)).rejects.toThrow(/could not read the archive/)
  })

  it('a .rar with no model in it', async () => {
    const rar = new File([fakeRar({ 'textures/a.png': PNG_1PX, 'readme.txt': Uint8Array.from([1]) })], 'textures.rar')
    await expect(loadModel(rar, opts)).rejects.toThrow(/no 3D model found inside the archive/)
  })
})
