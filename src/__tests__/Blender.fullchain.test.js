import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { installImageStubs } from './helpers/imageStubs.js'
import { blenderPath, blenderModule, buildBlendFixtures } from './helpers/blendFixtures.js'
import { loadModel } from '../three/loadModel.js'
import { bundleModelFiles, describeMissingFiles } from '../three/modelBundle.js'

// The whole chain on real files: a genuine .blend → the app's loader → the desktop
// bridge (here wired straight to the real converter and the real Blender) → glTF →
// the app's glTF loader. Skipped when Blender isn't installed.
describe.skipIf(!blenderPath)('real .blend files through the whole import pipeline', () => {
  let dir
  let stubs

  beforeAll(() => {
    stubs = installImageStubs()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animare-chain-'))
    buildBlendFixtures(dir)
    // The renderer talks to the main process over IPC; here it calls the same code directly.
    window.animare = {
      blender: {
        convert: async ({ main, files }) => {
          try {
            const { glb, warnings } = await blenderModule.convertBlend({ blenderPath, files, main })
            return { ok: true, glb, warnings, blenderVersion: 'test' }
          } catch (err) {
            return { ok: false, code: 'failed', error: err.message }
          }
        },
      },
    }
  }, 180000)
  afterAll(() => {
    delete window.animare
    stubs.restore()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const read = (name) => new File([fs.readFileSync(path.join(dir, name))], name)
  const opts = { autoDecimate: false }

  it('a rigged, animated .blend arrives as a character: bones, skin and its animation clip', async () => {
    const parsed = await loadModel(read('rig.blend'), opts)
    expect(parsed.info.name).toBe('rig')
    expect(parsed.info.boneCount).toBeGreaterThanOrEqual(2)
    expect(parsed.info.bones.map((b) => b.name)).toEqual(expect.arrayContaining(['Root', 'Arm']))
    expect(parsed.info.clipNames).toEqual(['Wave'])
    expect(parsed.info.meshCount).toBe(1)
  }, 120000)

  it('a textured .blend picks its texture up from a folder beside it, embedded in the result', async () => {
    const files = {
      'Crate.blend': new Uint8Array(fs.readFileSync(path.join(dir, 'crate.blend'))),
      'textures/checker.png': new Uint8Array(fs.readFileSync(path.join(dir, 'textures/checker.png'))),
    }
    const zip = new File([zipSync(files, { level: 0 })], 'crate-pack.zip')
    const parsed = await loadModel(zip, opts)
    let mat = null
    parsed.root.traverse((o) => o.isMesh && (mat = o.material))
    expect(mat.map).toBeTruthy()
    expect(parsed.info.bundle.conversionWarnings).toEqual([])
    expect(parsed.info.bundle.missingTextures).toEqual([])
  }, 120000)

  it('the same crate on its own: loads, and the app says which texture it could not find', async () => {
    const parsed = await loadModel(read('crate.blend'), opts)
    expect(parsed.info.bundle.missingTextures).toEqual(['checker.png'])
    expect(describeMissingFiles(parsed.info.name, parsed.info.bundle)).toContain('1 texture (checker.png)')
  }, 120000)

  it('a dropped folder (blend + texture) goes through bundling and conversion', async () => {
    const bundled = await bundleModelFiles([
      { file: read('crate.blend'), path: 'crate.blend' },
      { file: new File([fs.readFileSync(path.join(dir, 'textures/checker.png'))], 'checker.png'), path: 'textures/checker.png' },
    ])
    const parsed = await loadModel(bundled, opts)
    let mat = null
    parsed.root.traverse((o) => o.isMesh && (mat = o.material))
    expect(mat.map).toBeTruthy()
  }, 120000)

  it('the hidden helper object in the file is not in the model', async () => {
    const parsed = await loadModel(read('crate.blend'), opts)
    const names = []
    parsed.root.traverse((o) => o.isMesh && names.push(o.name))
    expect(names).toHaveLength(1)
    expect(names[0]).not.toMatch(/helper/i)
  }, 120000)

  it('a file with nothing to show is a readable error, not a crash', async () => {
    await expect(loadModel(read('empty.blend'), opts)).rejects.toThrow(/no meshes or armatures to export/)
  }, 120000)

  it('the converted file kept for saving loads on its own, with no Blender at all', async () => {
    const parsed = await loadModel(read('rig.blend'), opts)
    const saved = parsed.persistFile
    delete window.animare
    const again = await loadModel(saved, opts)
    expect(again.info.clipNames).toEqual(['Wave'])
    expect(again.info.boneCount).toBeGreaterThanOrEqual(2)
  }, 120000)
})
