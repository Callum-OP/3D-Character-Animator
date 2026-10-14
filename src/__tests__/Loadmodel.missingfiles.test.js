import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { installImageStubs } from './helpers/imageStubs.js'
import { asciiFbx, OBJ_QUAD, OBJ_MULTI, MTL, PNG_1PX } from './helpers/modelFixtures.js'
import { loadModel } from '../three/loadModel.js'
import { describeMissingFiles } from '../three/modelBundle.js'
import { useStore } from '../store.js'

let stubs
beforeAll(() => {
  stubs = installImageStubs()
})
afterAll(() => stubs.restore())

const opts = { autoDecimate: false }
const file = (bytes, name) => new File([bytes], name)

describe('a lone model file that refers to files it was not given', () => {
  it('an FBX naming a texture reports it (by file name, from the artist\'s absolute path)', async () => {
    const parsed = await loadModel(file(asciiFbx(), 'Cars.fbx'), opts)
    expect(parsed.info.bundle.missingTextures.map((p) => p.split('/').pop())).toEqual(['wood.png'])
    expect(parsed.info.bundle.missingFiles).toEqual([])
  })

  it('an FBX with no texture references reports nothing missing (it is just untextured)', async () => {
    const parsed = await loadModel(file(asciiFbx({ withTexture: false }), 'Train.fbx'), opts)
    expect(parsed.info.bundle.missingTextures).toEqual([])
    expect(describeMissingFiles(parsed.info.name, parsed.info.bundle)).toBeNull()
  })

  it('an OBJ naming an .mtl that is not there reports the .mtl', async () => {
    const parsed = await loadModel(file(OBJ_QUAD('SM5_Train.mtl'), 'Train.obj'), opts)
    expect(parsed.info.bundle.missingFiles).toEqual(['SM5_Train.mtl'])
  })

  it('an OBJ whose .mtl IS supplied reports nothing missing', async () => {
    const zipped = await import('three/examples/jsm/libs/fflate.module.js')
    const z = zipped.zipSync({ 'quad.obj': OBJ_QUAD(), 'quad.mtl': MTL('t.png'), 't.png': PNG_1PX }, { level: 0 })
    const parsed = await loadModel(file(z, 'quad.zip'), opts)
    expect(parsed.info.bundle.missingFiles).toEqual([])
    expect(parsed.info.bundle.missingTextures).toEqual([])
  })

  it('the same FBX supplied WITH its texture reports nothing missing', async () => {
    const zipped = await import('three/examples/jsm/libs/fflate.module.js')
    const z = zipped.zipSync({ 'a/cars.fbx': asciiFbx(), 'textures/wood.png': PNG_1PX }, { level: 0 })
    const parsed = await loadModel(file(z, 'cars.zip'), opts)
    expect(parsed.info.bundle.missingTextures).toEqual([])
    expect(describeMissingFiles('cars', parsed.info.bundle)).toBeNull()
  })

  it('a lone FBX still loads and keeps its geometry', async () => {
    const parsed = await loadModel(file(asciiFbx(), 'Cars.fbx'), opts)
    let meshes = 0
    parsed.root.traverse((o) => o.isMesh && meshes++)
    expect(meshes).toBe(1)
    expect(parsed.info.format).toBe('fbx')
    expect(parsed.info.name).toBe('Cars')
  })

  it('missing multi-material OBJ (the detective with no textures folder) lists the .mtl', async () => {
    const parsed = await loadModel(file(OBJ_MULTI(['Body', 'Hat'], 'detective.mtl'), 'detective.obj'), opts)
    expect(parsed.info.bundle.missingFiles).toEqual(['detective.mtl'])
  })
})

describe('describeMissingFiles', () => {
  it('nothing missing → no message', () => {
    expect(describeMissingFiles('X', { missingTextures: [], missingFiles: [] })).toBeNull()
    expect(describeMissingFiles('X', undefined)).toBeNull()
  })

  it('one texture: singular wording, shows the file name only', () => {
    const msg = describeMissingFiles('Cars', { missingTextures: ['textures/color_1024x1024.jpg'], missingFiles: [] })
    expect(msg).toContain('Imported "Cars"')
    expect(msg).toContain('1 texture (color_1024x1024.jpg)')
    expect(msg).toContain("wasn't included")
    expect(msg).toMatch(/folder or \.zip/)
  })

  it('several textures: plural, with duplicates collapsed and a long list shortened', () => {
    const msg = describeMissingFiles('M', { missingTextures: ['a.png', 'x/a.png', 'b.png', 'c.png', 'd.png', 'e.png'], missingFiles: [] })
    expect(msg).toContain('5 textures (a.png, b.png, c.png and 2 more)')
    expect(msg).toContain("weren't included")
  })

  it('a missing material file is mentioned, together with textures when both', () => {
    expect(describeMissingFiles('T', { missingTextures: [], missingFiles: ['T.mtl'] })).toContain('its material file (T.mtl)')
    const both = describeMissingFiles('T', { missingTextures: ['a.png'], missingFiles: ['T.mtl'] })
    expect(both).toContain('1 texture (a.png) and its material file (T.mtl)')
    expect(both).toContain("weren't included")
  })
})

describe('the notice in the store', () => {
  beforeEach(() => useStore.setState({ loadNotice: null, loading: false }))

  it('is set, shown until dismissed, and cleared when the next import starts', () => {
    useStore.getState().setLoadNotice('careful')
    expect(useStore.getState().loadNotice).toBe('careful')
    useStore.getState().setLoading(false)
    expect(useStore.getState().loadNotice).toBe('careful') // finishing a load doesn't clear it
    useStore.getState().setLoading(true)
    expect(useStore.getState().loadNotice).toBeNull()
  })

  it('can be dismissed', () => {
    useStore.getState().setLoadNotice('x')
    useStore.getState().setLoadNotice(null)
    expect(useStore.getState().loadNotice).toBeNull()
  })
})
