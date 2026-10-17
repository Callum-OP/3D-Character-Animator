import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { blenderPath, blenderModule, buildBlendFixtures } from './helpers/blendFixtures.js'

// These run the REAL Blender — the point is to prove the conversion script works with
// Blender's actual glTF exporter, which a fake can't. If no Blender (2.80+) is installed
// on the machine running the tests they are skipped, not failed.
const { getVersion, isVersionSupported, convertBlend } = blenderModule

function glbJson(buf) {
  expect(buf.toString('latin1', 0, 4)).toBe('glTF')
  const len = buf.readUInt32LE(12)
  return JSON.parse(buf.toString('utf8', 20, 20 + len))
}

describe.skipIf(!blenderPath)('real Blender: .blend → glb', () => {
  let dir
  const load = (name, withTextures = false) => {
    const files = [{ path: name, data: fs.readFileSync(path.join(dir, name)) }]
    if (withTextures) files.push({ path: 'textures/checker.png', data: fs.readFileSync(path.join(dir, 'textures/checker.png')) })
    return files
  }
  const convert = (name, withTextures = false) => convertBlend({ blenderPath, files: load(name, withTextures), main: name })

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animare-real-'))
    buildBlendFixtures(dir)
  }, 180000)
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('is a Blender this converter accepts', async () => {
    expect(isVersionSupported(await getVersion(blenderPath))).toBe(true)
  })

  it('a textured, modified crate: modifier applied, texture embedded, hidden helper left out', async () => {
    const { glb, warnings } = await convert('crate.blend', true)
    const j = glbJson(glb)
    expect(j.nodes.map((n) => n.name)).toEqual(['Crate']) // the hidden helper is not exported
    expect(j.meshes[0].primitives[0].attributes).toHaveProperty('TEXCOORD_0')
    expect(j.accessors[j.meshes[0].primitives[0].attributes.POSITION].count).toBeGreaterThan(24) // subdivision applied (a plain cube has 24)
    expect(j.materials[0].pbrMetallicRoughness).toHaveProperty('baseColorTexture')
    expect(j.images).toHaveLength(1)
    expect(j.images[0].mimeType).toBe('image/png')
    expect(j.images[0]).toHaveProperty('bufferView') // embedded in the .glb, not a separate file
    expect(warnings).toEqual([])
  }, 120000)

  it('the same crate WITHOUT its texture file: still converts, and the missing texture is reported', async () => {
    const { glb, warnings } = await convert('crate.blend', false)
    expect(glbJson(glb).images ?? []).toHaveLength(0)
    expect(warnings).toContain('texture not found: checker.png')
  }, 120000)

  describe('files made with older / Cycles-style shaders and artist-machine texture paths', () => {
    const byName = (j) => Object.fromEntries(j.materials.map((m) => [m.name, m]))
    const near = (a, b, eps = 0.05) => a.every((v, i) => Math.abs(v - b[i]) < eps)
    const withTextures = (folder) => {
      const files = load('legacy.blend')
      files.push({ path: folder + 'checker.png', data: fs.readFileSync(path.join(dir, 'textures/checker.png')) })
      return files
    }

    it('keeps every plain colour (these used to export as default white)', async () => {
      const { glb } = await convertBlend({ blenderPath, files: withTextures('art/Textures/'), main: 'legacy.blend' })
      const m = byName(glbJson(glb))
      expect(near(m.DiffuseRed.pbrMetallicRoughness.baseColorFactor, [0.8, 0.1, 0.1, 1])).toBe(true)
      expect(near(m.MixGreen.pbrMetallicRoughness.baseColorFactor, [0.1, 0.6, 0.1, 1])).toBe(true) // the transparent half is ignored
      expect(m.GlossyBlue.pbrMetallicRoughness.metallicFactor ?? 1).toBe(1) // (glTF omits the default, 1)
      expect(m.DiffuseRed.pbrMetallicRoughness.metallicFactor).toBe(0) // plain colours are not metal
      expect(near(m.GlossyBlue.pbrMetallicRoughness.baseColorFactor, [0.2, 0.4, 0.9, 1])).toBe(true)
      expect(m.EmissionOrange.emissiveFactor).toBeDefined()
      expect(near(m.EmissionOrange.emissiveFactor, [1, 0.5, 0], 0.1)).toBe(true)
    }, 120000)

    it('finds textures by NAME wherever they are in the folder, whatever path or letter-case the file remembers', async () => {
      const { glb, warnings } = await convertBlend({ blenderPath, files: withTextures('art/Textures/'), main: 'legacy.blend' })
      const j = glbJson(glb)
      const m = byName(j)
      expect(m.TexMac.pbrMetallicRoughness).toHaveProperty('baseColorTexture') // saved as //../../../Unity/…/CHECKER.png
      expect(m.TexWin.pbrMetallicRoughness).toHaveProperty('baseColorTexture') // saved as C:\Users\me\Desktop\…\checker.png
      expect(j.images.length).toBeGreaterThanOrEqual(1)
      expect(j.images.every((i) => 'bufferView' in i)).toBe(true) // embedded
      expect(warnings).toEqual([])
    }, 120000)

    it('works with the textures loose beside the .blend too', async () => {
      const { glb } = await convertBlend({ blenderPath, files: withTextures(''), main: 'legacy.blend' })
      expect(byName(glbJson(glb)).TexMac.pbrMetallicRoughness).toHaveProperty('baseColorTexture')
    }, 120000)

    it('a texture that really is not there is reported, but the colours still come through', async () => {
      const { glb, warnings } = await convert('legacy.blend')
      expect(warnings).toEqual(expect.arrayContaining([expect.stringMatching(/texture not found: (CHECKER|checker)\.png/i)]))
      expect(near(byName(glbJson(glb)).DiffuseRed.pbrMetallicRoughness.baseColorFactor, [0.8, 0.1, 0.1, 1])).toBe(true)
    }, 120000)
  })

  it('a rigged, animated character keeps its skin and animation', async () => {
    const j = glbJson((await convert('rig.blend')).glb)
    expect(j.skins).toHaveLength(1)
    expect(j.meshes[0].primitives[0].attributes).toHaveProperty('JOINTS_0')
    expect(j.meshes[0].primitives[0].attributes).toHaveProperty('WEIGHTS_0')
    expect(j.animations.map((a) => a.name)).toEqual(['Wave'])
    expect(j.animations[0].channels.length).toBeGreaterThan(0)
    expect(j.nodes.map((n) => n.name)).toEqual(expect.arrayContaining(['Root', 'Arm', 'Body']))
  }, 120000)

  it('shape keys (face morphs) survive — which is why modifiers are not applied for them', async () => {
    const j = glbJson((await convert('shapekeys.blend')).glb)
    expect(j.meshes[0].primitives[0].targets).toHaveLength(1)
  }, 120000)

  it('a file with nothing to export gets a clear reason', async () => {
    await expect(convert('empty.blend')).rejects.toThrow(/no meshes or armatures to export/)
  }, 120000)

  it('does not choke on a file that is not a .blend', async () => {
    const files = [{ path: 'fake.blend', data: Buffer.from('this is not a blend file') }]
    await expect(convertBlend({ blenderPath, files, main: 'fake.blend' })).rejects.toThrow(/could not convert/)
  }, 120000)

  describe('a hostile file (Python that runs when the file is opened)', () => {
    const marker = () => path.join(dir, 'PWNED_TEXT')

    it('would really run if auto-run were on — so the test below means something', () => {
      fs.rmSync(marker(), { force: true })
      spawnSync(blenderPath, ['-b', '--factory-startup', '--enable-autoexec', path.join(dir, 'evil.blend'), '--python-expr', 'print(1)'], { timeout: 60000 })
      expect(fs.existsSync(marker())).toBe(true)
      fs.rmSync(marker(), { force: true })
    }, 120000)

    it('is converted WITHOUT running its scripts', async () => {
      fs.rmSync(marker(), { force: true })
      const { glb } = await convert('evil.blend')
      expect(glbJson(glb).nodes.length).toBeGreaterThan(0) // it still converted fine
      expect(fs.existsSync(marker())).toBe(false)
    }, 120000)
  })

  it('cleans up after itself', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animare-root-'))
    await convertBlend({ blenderPath, files: load('rig.blend'), main: 'rig.blend', tmpRoot: root })
    expect(fs.readdirSync(root)).toEqual([])
    fs.rmSync(root, { recursive: true, force: true })
  }, 120000)
})
