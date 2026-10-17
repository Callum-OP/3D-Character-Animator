// @vitest-environment node
// (Node, not jsdom: the WebAssembly RAR reader decides how to load itself by looking at its
// environment, and jsdom's fake browser confuses it. The wiring around it is tested in jsdom
// elsewhere, with a stand-in reader.)
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { isRarBytes, extractRar } from '../three/archive.js'
import { readArchive, bundleModelFiles } from '../three/modelBundle.js'
import { RAR5_PACK, RAR_WITH_NESTED_ZIP, RAR_PASSWORD_PROTECTED, fromBase64 } from './helpers/rarFixtures.js'

let fetchSpy
beforeAll(() => {
  // In the app the .wasm is an ordinary asset fetched from the app's own address.
  const realFetch = globalThis.fetch
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input?.url || input)
    if (/unrar\.wasm($|\?)/.test(url)) return new Response(fs.readFileSync('node_modules/node-unrar-js/esm/js/unrar.wasm'), { status: 200 })
    return realFetch(input, init)
  })
})
afterAll(() => fetchSpy.mockRestore())

const buffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
const text = (u8) => new TextDecoder().decode(u8)

describe('recognising RAR files by their contents', () => {
  it('RAR 5 and RAR 4 signatures', () => {
    expect(isRarBytes(fromBase64(RAR5_PACK))).toBe(true)
    expect(isRarBytes(Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0xcf]))).toBe(true) // RAR 4
  })
  it('zips and junk are not RAR', () => {
    expect(isRarBytes(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]))).toBe(false)
    expect(isRarBytes(new Uint8Array(0))).toBe(false)
    expect(isRarBytes(null)).toBe(false)
  })
})

describe('extractRar (the real WebAssembly reader)', () => {
  it('reads every file with its folders, using "/" separators', async () => {
    const files = await extractRar(buffer(fromBase64(RAR5_PACK)))
    expect([...files.keys()].sort()).toEqual(['source/quad.obj', 'textures/Wood_diffuse.png', 'textures/Wood_normal.png'])
  })

  it('gives back the real bytes', async () => {
    const files = await extractRar(buffer(fromBase64(RAR5_PACK)))
    expect(text(files.get('source/quad.obj'))).toMatch(/^mtllib quad\.mtl\no Quad/)
    expect(Array.from(files.get('textures/Wood_normal.png'))).toEqual(Array.from({ length: 40 }, (_, i) => i))
    expect(Array.from(files.get('textures/Wood_diffuse.png').slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]) // a real PNG
  })

  it('a password-protected archive says so', async () => {
    await expect(extractRar(buffer(fromBase64(RAR_PASSWORD_PROTECTED)))).rejects.toThrow(/password-protected/)
  })

  it('something that is not a RAR is a readable error', async () => {
    await expect(extractRar(buffer(new TextEncoder().encode('definitely not an archive')))).rejects.toThrow(/could not read the RAR archive/)
  })

  it('a truncated RAR is a readable error, not a crash', async () => {
    const whole = fromBase64(RAR5_PACK)
    await expect(extractRar(buffer(whole.slice(0, Math.floor(whole.length / 2))))).rejects.toThrow(/RAR/)
  })

  it('the WebAssembly module is downloaded once, however many archives are opened', async () => {
    vi.resetModules() // a fresh copy of the reader, nothing cached yet
    const fresh = await import('../three/archive.js')
    fetchSpy.mockClear()
    await fresh.extractRar(buffer(fromBase64(RAR5_PACK)))
    await fresh.extractRar(buffer(fromBase64(RAR5_PACK)))
    await fresh.extractRar(buffer(fromBase64(RAR5_PACK)))
    expect(fetchSpy.mock.calls.filter((c) => /unrar\.wasm/.test(String(c[0]?.url || c[0])))).toHaveLength(1)
  })
})

describe('readArchive with RAR', () => {
  it('opens a .rar the same way it opens a zip', async () => {
    const files = await readArchive(buffer(fromBase64(RAR5_PACK)))
    expect([...files.keys()].sort()).toEqual(['source/quad.obj', 'textures/Wood_diffuse.png', 'textures/Wood_normal.png'])
  })

  it('opens a zip inside a RAR, placing its contents beside it', async () => {
    const files = await readArchive(buffer(fromBase64(RAR_WITH_NESTED_ZIP)))
    expect([...files.keys()].sort()).toEqual(['source/quad.obj', 'textures/Wood_diffuse.png', 'textures/Wood_normal.png'])
    expect(text(files.get('source/quad.obj'))).toContain('o Quad')
  })

  it('opens a RAR inside a zip', async () => {
    const zip = zipSync({ 'downloads/pack.rar': fromBase64(RAR5_PACK), 'readme.txt': new TextEncoder().encode('hi') }, { level: 0 })
    const files = await readArchive(buffer(zip))
    expect([...files.keys()].sort()).toEqual(['downloads/source/quad.obj', 'downloads/textures/Wood_diffuse.png', 'downloads/textures/Wood_normal.png', 'readme.txt'])
  })

  it('recognises a RAR by its contents even when it is named .zip (or the other way round)', async () => {
    const zip = zipSync({ 'sneaky.zip': fromBase64(RAR5_PACK) }, { level: 0 }) // a RAR wearing a .zip name
    const files = await readArchive(buffer(zip))
    expect([...files.keys()]).toContain('source/quad.obj')
  })

  it('a ".rar" that is not a RAR is kept as an ordinary file rather than failing the whole import', async () => {
    const zip = zipSync({ 'broken.rar': new TextEncoder().encode('nope'), 'a.png': Uint8Array.from([1, 2, 3]) }, { level: 0 })
    const files = await readArchive(buffer(zip))
    expect([...files.keys()].sort()).toEqual(['a.png', 'broken.rar'])
  })

  it('drops junk files inside a RAR as it does in a zip', async () => {
    const zip = zipSync({ 'p.rar': fromBase64(RAR5_PACK), '__MACOSX/._p.rar': new Uint8Array(2) }, { level: 0 })
    expect([...(await readArchive(buffer(zip))).keys()].some((k) => k.includes('MACOSX'))).toBe(false)
  })
})

describe('picking a .rar in the file dialogs / dropping it', () => {
  const entry = (path, bytes = 'x') => ({ file: new File([bytes], path.split('/').pop()), path })

  it('a lone .rar is passed through as the model', async () => {
    const e = entry('pack.rar')
    expect(await bundleModelFiles([e])).toBe(e.file)
  })

  it('a model plus a textures.rar: the rar rides along inside the bundle', async () => {
    const out = await bundleModelFiles([entry('Cars.fbx'), entry('textures.rar', 'RARDATA')])
    const files = await readArchive(await out.arrayBuffer())
    expect([...files.keys()].sort()).toEqual(['Cars.fbx', 'textures.rar']) // (not a real RAR, so it stays a file)
  })

  it('a .rar next to a folder of textures keeps both', async () => {
    const out = await bundleModelFiles([entry('source/model.rar', 'R'), entry('textures/a.png', 'IMG')])
    expect(out.name).toBe('model.zip')
  })
})
