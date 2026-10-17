import { describe, it, expect } from 'vitest'
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js'
import {
  normalizeResourcePath,
  createResourceResolver,
  entriesFromFileList,
  collectDroppedFiles,
  bundleModelFiles,
  planLooseTextures,
  isColorImageCandidate,
  MODEL_ACCEPT,
} from '../three/modelBundle.js'

const file = (name, content = 'x', rel) => {
  const f = new File([content], name)
  if (rel) Object.defineProperty(f, 'webkitRelativePath', { value: rel })
  return f
}
const entry = (path, content = 'x') => ({ file: file(path.split('/').pop(), content), path })

describe('normalizeResourcePath', () => {
  it.each([
    ['textures/a.png', 'textures/a.png'],
    ['..\\textures\\a.png', 'textures/a.png'],
    ['C:\\Users\\me\\Desktop\\proj\\tex\\a.png', 'Users/me/Desktop/proj/tex/a.png'],
    ['./a.png', 'a.png'],
    ['a/b/../c/./d.png', 'a/c/d.png'],
    ['textures/a%20b.png', 'textures/a b.png'],
    ['textures/a.png?v=3#x', 'textures/a.png'],
    ['file:///tmp/x/a.png', 'tmp/x/a.png'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(normalizeResourcePath(input)).toBe(expected)
  })
})

describe('createResourceResolver: finding the file a model asked for', () => {
  const r = createResourceResolver([
    'source/model.fbx',
    'textures/Wood.PNG',
    'textures/metal/steel.jpg',
    'other/steel.jpg',
    'maps/stone.png',
  ])

  it('exact path, ignoring case', () => {
    expect(r.find('textures/wood.png')).toBe('textures/Wood.PNG')
  })
  it('a relative path from another folder ("../textures/…")', () => {
    expect(r.find('source/../textures/Wood.PNG')).toBe('textures/Wood.PNG')
  })
  it('an absolute path from the exporter\'s machine — falls back to the file name', () => {
    expect(r.find('C:\\Users\\artist\\Desktop\\project\\tex\\wood.png')).toBe('textures/Wood.PNG')
  })
  it('a trailing part of the path ("metal/steel.jpg")', () => {
    expect(r.find('metal/steel.jpg')).toBe('textures/metal/steel.jpg')
  })
  it('the same file name in two folders: prefers the one sharing the most path', () => {
    expect(r.find('x/metal/steel.jpg')).toBe('textures/metal/steel.jpg')
    expect(r.find('x/other/steel.jpg')).toBe('other/steel.jpg')
  })
  it('a different image type with the same name (.tga asked for, .png shipped)', () => {
    expect(r.find('maps/stone.tga')).toBe('maps/stone.png')
    expect(r.find('stone.psd')).toBe('maps/stone.png')
  })
  it('does NOT substitute a non-image for a missing texture', () => {
    expect(r.find('model.png')).toBeNull()
    expect(r.find('textures/missing.png')).toBeNull()
  })
  it('empty / junk requests find nothing', () => {
    expect(r.find('')).toBeNull()
    expect(r.find('..')).toBeNull()
  })
})

describe('gathering files', () => {
  it('a folder pick: paths come from webkitRelativePath, without the folder name itself', () => {
    const list = [
      file('a.fbx', 'x', 'Robot/source/a.fbx'),
      file('t.png', 'x', 'Robot/textures/t.png'),
    ]
    expect(entriesFromFileList(list).map((e) => e.path)).toEqual(['source/a.fbx', 'textures/t.png'])
  })

  it('several loose files picked together keep just their names', () => {
    expect(entriesFromFileList([file('a.obj'), file('a.mtl'), file('t.png')]).map((e) => e.path)).toEqual(['a.obj', 'a.mtl', 't.png'])
  })

  // webkitGetAsEntry-style fakes
  const fileEntry = (name, content = 'x') => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(new File([content], name)) })
  const dirEntry = (name, children, batch = 100) => ({
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let i = 0
      return {
        readEntries: (ok) => {
          const out = children.slice(i, i + batch)
          i += batch
          ok(out)
        },
      }
    },
  })
  const drop = (entries) => ({ items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })), files: [] })

  it('a dropped folder is walked recursively, and its own name is dropped from the paths', async () => {
    const dt = drop([dirEntry('Robot', [dirEntry('source', [fileEntry('a.fbx')]), dirEntry('textures', [fileEntry('t.png'), fileEntry('n.png')])])])
    const got = await collectDroppedFiles(dt)
    expect(got.map((e) => e.path).sort()).toEqual(['source/a.fbx', 'textures/n.png', 'textures/t.png'])
  })

  it('reads folders that need several readEntries batches (browsers return ~100 at a time)', async () => {
    const many = Array.from({ length: 7 }, (_, i) => fileEntry(`f${i}.png`))
    const got = await collectDroppedFiles(drop([dirEntry('D', many, 3)]))
    expect(got).toHaveLength(7)
  })

  it('several loose files dropped together', async () => {
    const got = await collectDroppedFiles(drop([fileEntry('a.obj'), fileEntry('a.mtl')]))
    expect(got.map((e) => e.path).sort()).toEqual(['a.mtl', 'a.obj'])
  })

  it('takes every item synchronously (DataTransfer is only readable during the drop event)', () => {
    let during = true
    const items = [fileEntry('a.fbx'), fileEntry('b.png')].map((e) => ({
      kind: 'file',
      webkitGetAsEntry: () => {
        expect(during).toBe(true)
        return e
      },
    }))
    const p = collectDroppedFiles({ items, files: [] })
    during = false
    return p
  })

  it('falls back to dataTransfer.files when the browser has no entry API', async () => {
    const got = await collectDroppedFiles({ items: [], files: [file('a.glb')] })
    expect(got.map((e) => e.path)).toEqual(['a.glb'])
  })
})

describe('bundleModelFiles', () => {
  it('a single model file goes through untouched', async () => {
    const f = file('hero.fbx')
    expect(await bundleModelFiles([{ file: f, path: 'hero.fbx' }])).toBe(f)
  })

  it('a single zip goes through untouched', async () => {
    const f = file('pack.zip')
    expect(await bundleModelFiles([{ file: f, path: 'pack.zip' }])).toBe(f)
  })

  it('a single unsupported file is a readable error', async () => {
    await expect(bundleModelFiles([entry('notes.txt')])).rejects.toThrow(/Unsupported file "\.txt"/)
  })

  it('a model plus its textures becomes one zip named after the model, with the paths kept', async () => {
    const out = await bundleModelFiles([entry('source/robot.fbx', 'FBX'), entry('textures/body.png', 'IMG')])
    expect(out.name).toBe('robot.zip')
    const files = unzipSync(new Uint8Array(await out.arrayBuffer()))
    expect(Object.keys(files).sort()).toEqual(['source/robot.fbx', 'textures/body.png'])
    expect(new TextDecoder().decode(files['textures/body.png'])).toBe('IMG')
  })

  it('carries .mtl and .bin files too, and leaves unrelated files behind', async () => {
    const out = await bundleModelFiles([
      entry('a.obj'), entry('a.mtl'), entry('buf.bin'), entry('t.jpg'),
      entry('readme.txt'), entry('scene.blend'), entry('notes.md'),
    ])
    const names = Object.keys(unzipSync(new Uint8Array(await out.arrayBuffer()))).sort()
    expect(names).toEqual(['a.mtl', 'a.obj', 'buf.bin', 't.jpg'])
  })

  it('several models in one folder: prefers FBX over the rest, and only bundles that one', async () => {
    const out = await bundleModelFiles([entry('a.obj'), entry('b.fbx'), entry('c.glb'), entry('t.png')])
    const names = Object.keys(unzipSync(new Uint8Array(await out.arrayBuffer()))).sort()
    expect(names).toEqual(['b.fbx', 't.png'])
  })

  it('same format twice: takes the bigger file', async () => {
    const out = await bundleModelFiles([entry('small.fbx', 'x'), entry('big.fbx', 'xxxxxxxxxx'), entry('t.png')])
    expect(out.name).toBe('big.zip')
  })

  it('ignores macOS/Windows junk files', async () => {
    const out = await bundleModelFiles([entry('a.fbx'), entry('t.png'), entry('__MACOSX/._a.fbx'), entry('.DS_Store'), entry('Thumbs.db')])
    expect(Object.keys(unzipSync(new Uint8Array(await out.arrayBuffer()))).sort()).toEqual(['a.fbx', 't.png'])
  })

  it('images with no model → a clear error', async () => {
    await expect(bundleModelFiles([entry('a.png'), entry('b.png')])).rejects.toThrow(/No 3D model found/)
  })

  it('nothing at all → a clear error', async () => {
    await expect(bundleModelFiles([])).rejects.toThrow(/No files/)
  })

  it('a lone zip among only zips is used as the model', async () => {
    const z = file('pack.zip')
    expect(await bundleModelFiles([{ file: z, path: 'pack.zip' }, { file: file('other.zip'), path: 'other.zip' }])).toBe(z)
  })

  it('a zip beside textures (model packed inside it) keeps the textures: both go into one bundle', async () => {
    const out = await bundleModelFiles([entry('source/detective.zip', 'ZIP'), entry('textures/body_diffuse.png', 'IMG'), entry('readme.txt')])
    expect(out.name).toBe('detective.zip')
    const names = Object.keys(unzipSync(new Uint8Array(await out.arrayBuffer()))).sort()
    expect(names).toEqual(['source/detective.zip', 'textures/body_diffuse.png'])
  })

  it('a model plus a textures.zip: the zip rides along', async () => {
    const out = await bundleModelFiles([entry('a.fbx'), entry('textures.zip', 'ZIP')])
    expect(Object.keys(unzipSync(new Uint8Array(await out.arrayBuffer()))).sort()).toEqual(['a.fbx', 'textures.zip'])
  })

  it('a folder with only an unsupported 3D project file says what to do', async () => {
    await expect(bundleModelFiles([entry('scene.max'), entry('a.png')])).rejects.toThrow(/\.max.*Export it as \.fbx or \.glb/)
  })
})

describe('accept string', () => {
  it('lists every format, the zip, and the loose files that can ride along', () => {
    for (const ext of ['fbx', 'glb', 'gltf', 'obj', 'dae', 'stl', 'ply', 'zip', 'mtl', 'png', 'jpg', 'tga']) {
      expect(MODEL_ACCEPT).toContain('.' + ext)
    }
  })
})

describe('planLooseTextures: images the model never mentions', () => {
  const mat = (id, names, textured = false) => ({ id, names, textured })

  it('the example skybox: one plain material, one image → applied', () => {
    expect(planLooseTextures([mat(0, ['__DEFAULT', 'Sphere'])], ['textures/sunroof_city_6k.jpg'])).toEqual([
      { id: 0, path: 'textures/sunroof_city_6k.jpg' },
    ])
  })

  it('one image, several plain materials, nothing textured → all get it', () => {
    expect(planLooseTextures([mat(0, ['a']), mat(1, ['b'])], ['atlas.png'])).toHaveLength(2)
  })

  it('a lone image that is named after one material goes to that material only', () => {
    expect(planLooseTextures([mat(0, ['Body']), mat(1, ['Mystery'])], ['tex/detective_Body_diffuse.png'])).toEqual([
      { id: 0, path: 'tex/detective_Body_diffuse.png' },
    ])
  })

  it('one image but the model is already partly textured → only a lone plain material gets it', () => {
    expect(planLooseTextures([mat(0, ['skin'], true), mat(1, ['glass']), mat(2, ['metal'])], ['extra.png'])).toEqual([])
    expect(planLooseTextures([mat(0, ['skin'], true), mat(1, ['glass'])], ['extra.png'])).toEqual([{ id: 1, path: 'extra.png' }])
  })

  it('several images: matched by name, ignoring "diffuse/albedo/color" suffixes and case', () => {
    const plan = planLooseTextures(
      [mat(0, ['Body', 'Torso']), mat(1, ['Head_mat']), mat(2, ['Mystery'])],
      ['tex/body_diffuse.png', 'tex/HEAD_albedo.jpg', 'tex/unrelated.png'],
    )
    expect(plan).toEqual([{ id: 0, path: 'tex/body_diffuse.png' }, { id: 1, path: 'tex/HEAD_albedo.jpg' }])
  })

  it('several images and nothing matches by name → nothing is guessed', () => {
    expect(planLooseTextures([mat(0, ['x']), mat(1, ['y'])], ['a.png', 'b.png'])).toEqual([])
  })

  it('never offers normal / roughness / AO / etc. maps as a colour texture', () => {
    for (const n of ['body_normal.png', 'Body_Roughness.png', 'body_ao.png', 'body_metallic.png', 'body_emissive.png', 'body_height.png', 'body_opacity.png']) {
      expect(isColorImageCandidate(n)).toBe(false)
    }
    expect(isColorImageCandidate('body_diffuse.png')).toBe(true)
    expect(isColorImageCandidate('sunroof_city_6k.jpg')).toBe(true)
    expect(planLooseTextures([mat(0, ['body'])], ['body_normal.png'])).toEqual([])
  })

  it('non-images are never candidates', () => {
    expect(isColorImageCandidate('model.fbx')).toBe(false)
  })

  it('no plain materials or no images → nothing to do', () => {
    expect(planLooseTextures([mat(0, ['a'], true)], ['x.png'])).toEqual([])
    expect(planLooseTextures([mat(0, ['a'])], [])).toEqual([])
  })
})
