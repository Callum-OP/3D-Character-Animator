import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { installImageStubs } from './helpers/imageStubs.js'
import { triangleGlb, asciiFbx, PNG_1PX } from './helpers/modelFixtures.js'
import { loadModel } from '../three/loadModel.js'
import { bundleModelFiles, describeBlendConversion, describeMissingFiles, MODEL_ACCEPT } from '../three/modelBundle.js'
import { BLEND_WEB_MESSAGE } from '../three/blendImport.js'

let stubs
beforeAll(() => {
  stubs = installImageStubs()
})
afterAll(() => stubs.restore())

const opts = { autoDecimate: false }
const blend = (name = 'Hero.blend') => new File([new Uint8Array(Buffer.from('BLENDER-v400fake'))], name)
const zipFile = (files, name = 'pack.zip') => new File([zipSync(files, { level: 0 })], name)
const meshCount = (parsed) => {
  let n = 0
  parsed.root.traverse((o) => o.isMesh && n++)
  return n
}

let convert
function installBridge(impl) {
  convert = vi.fn(impl || (async () => ({ ok: true, glb: triangleGlb(), warnings: [], blenderVersion: '4.0.2' })))
  window.animare = { blender: { convert, status: async () => ({ available: true }) } }
}
beforeEach(() => installBridge())
afterEach(() => {
  delete window.animare
})

describe('a .blend through the desktop app', () => {
  it('is converted by Blender, then loads like any glb', async () => {
    const parsed = await loadModel(blend(), opts)
    expect(meshCount(parsed)).toBe(1)
    expect(parsed.info.name).toBe('Hero')
    expect(parsed.info.convertedFrom).toBe('blend')
    expect(parsed.info.bundle).toMatchObject({ converted: 'blender', blenderVersion: '4.0.2', conversionWarnings: [] })
  })

  it('sends the .blend to Blender under its own name', async () => {
    await loadModel(blend('Hero.blend'), opts)
    const payload = convert.mock.calls[0][0]
    expect(payload.main).toBe('Hero.blend')
    expect(payload.files.map((f) => f.path)).toEqual(['Hero.blend'])
    expect(new TextDecoder().decode(payload.files[0].data)).toBe('BLENDER-v400fake')
  })

  it('a saved project keeps the converted .glb, not the .blend (so reopening never needs Blender)', async () => {
    const parsed = await loadModel(blend('Hero.blend'), opts)
    expect(parsed.persistFile).toBeInstanceOf(File)
    expect(parsed.persistFile.name).toBe('Hero.glb')
    expect(new Uint8Array(await parsed.persistFile.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x67, 0x6c, 0x54, 0x46]))
    // …and that file loads on its own, with no Blender involved
    delete window.animare
    const again = await loadModel(parsed.persistFile, opts)
    expect(meshCount(again)).toBe(1)
  })

  it('converts a File only once, however many times it is loaded (the import probes it first)', async () => {
    const f = blend()
    await loadModel(f, opts)
    await loadModel(f, opts)
    await loadModel(f, opts)
    expect(convert).toHaveBeenCalledTimes(1)
  })

  it('…but loads at the same moment share one conversion too', async () => {
    const f = blend()
    await Promise.all([loadModel(f, opts), loadModel(f, opts)])
    expect(convert).toHaveBeenCalledTimes(1)
  })

  it('a failed conversion is not cached: fix Blender and the same File can be retried', async () => {
    const f = blend()
    installBridge(async () => ({ ok: false, error: 'Blender could not convert this file.' }))
    await expect(loadModel(f, opts)).rejects.toThrow('Blender could not convert this file.')
    installBridge()
    const parsed = await loadModel(f, opts)
    expect(meshCount(parsed)).toBe(1)
  })

  it('Blender\'s own reason reaches the user', async () => {
    installBridge(async () => ({ ok: false, code: 'not-found', error: 'Blender was not found. Install it from blender.org, or choose its location in Settings.' }))
    await expect(loadModel(blend('x.blend'), opts)).rejects.toThrow(/Install it from blender\.org/)
  })

  it('warnings from the conversion are kept, and missing textures are picked out', async () => {
    installBridge(async () => ({ ok: true, glb: triangleGlb(), warnings: ['texture not found: wood.png', 'Skipped a node group'], blenderVersion: '4.0.2' }))
    const parsed = await loadModel(blend('Crate.blend'), opts)
    expect(parsed.info.bundle.conversionWarnings).toEqual(['texture not found: wood.png', 'Skipped a node group'])
    expect(parsed.info.bundle.missingTextures).toEqual(['wood.png'])
  })
})

describe('a .blend in a folder or zip with its textures', () => {
  it('sends the textures along, keeping their folders (so //textures/wood.png resolves)', async () => {
    await loadModel(zipFile({ 'scene/Crate.blend': new Uint8Array(Buffer.from('BLEND')), 'scene/textures/wood.png': PNG_1PX }, 'crate-pack.zip'), opts)
    const payload = convert.mock.calls[0][0]
    expect(payload.main).toBe('scene/Crate.blend')
    expect(payload.files.map((f) => f.path).sort()).toEqual(['scene/Crate.blend', 'scene/textures/wood.png'])
  })

  it('a dropped folder is bundled with its textures and a linked library, then converted', async () => {
    const entry = (path, bytes = 'x') => ({ file: new File([bytes], path.split('/').pop()), path })
    const bundled = await bundleModelFiles([entry('Crate.blend', 'BLEND'), entry('lib/props.blend', 'LIB'), entry('textures/wood.png', 'IMG'), entry('notes.txt')])
    expect(bundled.name).toBe('Crate.zip')
    await loadModel(bundled, opts)
    expect(convert.mock.calls[0][0].files.map((f) => f.path).sort()).toEqual(['Crate.blend', 'lib/props.blend', 'textures/wood.png'])
  })

  it('names the model after the zip, and still keeps the converted glb for saving', async () => {
    const parsed = await loadModel(zipFile({ 'a/Crate.blend': new Uint8Array(1) }, 'cool-crate.zip'), opts)
    expect(parsed.info.name).toBe('cool-crate')
    expect(parsed.persistFile.name).toBe('cool-crate.glb')
  })

  it('a folder with both a .blend and an .fbx uses the .fbx — no Blender needed', async () => {
    const entry = (path, bytes) => ({ file: new File([bytes], path.split('/').pop()), path })
    const bundled = await bundleModelFiles([entry('scene.blend', 'BLEND'), entry('scene.fbx', asciiFbx({ withTexture: false })), entry('t.png', PNG_1PX)])
    const parsed = await loadModel(bundled, opts)
    expect(parsed.info.format).toBe('fbx')
    expect(convert).not.toHaveBeenCalled()
  })

  it('a .blend and nothing else in the folder is accepted (not "no model found")', async () => {
    const out = await bundleModelFiles([{ file: new File(['x'], 'a.blend'), path: 'a.blend' }, { file: new File(['x'], 't.png'), path: 't.png' }])
    expect(out.name).toBe('a.zip')
  })
})

describe('in the browser build (no desktop app, so no Blender)', () => {
  beforeEach(() => delete window.animare)

  it('explains why, and what to do instead', async () => {
    await expect(loadModel(blend(), opts)).rejects.toThrow(BLEND_WEB_MESSAGE)
    expect(BLEND_WEB_MESSAGE).toMatch(/desktop app/)
    expect(BLEND_WEB_MESSAGE).toMatch(/glTF 2\.0/)
  })

  it('same for a .blend inside a zip', async () => {
    await expect(loadModel(zipFile({ 'a.blend': new Uint8Array(1) }), opts)).rejects.toThrow(BLEND_WEB_MESSAGE)
  })

  it('other formats are untouched', async () => {
    const parsed = await loadModel(new File([asciiFbx({ withTexture: false })], 'quad.fbx'), opts)
    expect(meshCount(parsed)).toBe(1)
  })
})

describe('accepting .blend files', () => {
  it('file pickers offer .blend', () => {
    expect(MODEL_ACCEPT).toContain('.blend')
  })
})

describe('what the user is told', () => {
  const bundle = (conversionWarnings) => ({ converted: 'blender', conversionWarnings })

  it('nothing after a clean conversion', () => {
    expect(describeBlendConversion('Hero', bundle([]))).toBeNull()
    expect(describeBlendConversion('Hero', undefined)).toBeNull()
    expect(describeBlendConversion('Hero', { converted: undefined })).toBeNull()
  })

  it('warnings are listed (and shortened)', () => {
    expect(describeBlendConversion('Hero', bundle(['one']))).toBe('Converted "Hero" with Blender, with a warning: one.')
    expect(describeBlendConversion('Hero', bundle(['a', 'b', 'c', 'd', 'e']))).toBe('Converted "Hero" with Blender, with warnings: a; b; c (and 2 more).')
  })

  it('a missing texture is explained once — by the missing-files message, not twice', () => {
    const b = { ...bundle(['texture not found: wood.png']), missingTextures: ['wood.png'], missingFiles: [] }
    expect(describeBlendConversion('Crate', b)).toBeNull()
    expect(describeMissingFiles('Crate', b)).toContain('1 texture (wood.png)')
  })
})
