import { describe, it, expect } from 'vitest'
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { readBundle, classifyTexture, planExtraMaps, planLooseTextures, isColorImageCandidate } from '../three/modelBundle.js'
import { imageBytes } from './helpers/modelFixtures.js'

const zipBuffer = (files) => {
  const z = zipSync(files, { level: 0 })
  return z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength)
}
const text = (s) => new Uint8Array(new TextEncoder().encode(s))

describe('readBundle: zips inside zips', () => {
  it('opens a zip that holds another zip, placing the inner contents beside it', () => {
    const inner = zipSync({ 'detective.obj': text('OBJ') }, { level: 0 })
    const files = readBundle(zipBuffer({ 'source/detective.zip': inner, 'textures/a.png': imageBytes(1) }))
    expect([...files.keys()].sort()).toEqual(['source/detective.obj', 'textures/a.png'])
    expect(new TextDecoder().decode(files.get('source/detective.obj'))).toBe('OBJ')
  })

  it('keeps the inner zip\'s own folders', () => {
    const inner = zipSync({ 'mesh/model.obj': text('x'), 'mesh/model.mtl': text('y') }, { level: 0 })
    const files = readBundle(zipBuffer({ 'dl/pack.zip': inner }))
    expect([...files.keys()].sort()).toEqual(['dl/mesh/model.mtl', 'dl/mesh/model.obj'])
  })

  it('goes several levels deep', () => {
    const l3 = zipSync({ 'deep.obj': text('x') }, { level: 0 })
    const l2 = zipSync({ 'l3.zip': l3 }, { level: 0 })
    const files = readBundle(zipBuffer({ 'l2.zip': l2 }))
    expect([...files.keys()]).toEqual(['deep.obj'])
  })

  it('stops at a sensible depth rather than unpacking forever', () => {
    let z = zipSync({ 'bottom.obj': text('x') }, { level: 0 })
    for (let i = 0; i < 6; i++) z = zipSync({ [`z${i}.zip`]: z }, { level: 0 })
    const files = readBundle(zipBuffer({ 'top.zip': z }))
    expect([...files.keys()].some((k) => k.endsWith('bottom.obj'))).toBe(false) // beyond the cap: left as a file
    expect([...files.keys()].some((k) => k.endsWith('.zip'))).toBe(true)
  })

  it('a ".zip" that is not really a zip is kept as an ordinary file, not an error', () => {
    const files = readBundle(zipBuffer({ 'fake.zip': text('not a zip at all'), 'a.png': imageBytes(2) }))
    expect([...files.keys()].sort()).toEqual(['a.png', 'fake.zip'])
  })

  it('does not let an inner file overwrite one that is already there', () => {
    const inner = zipSync({ 'a.png': imageBytes(9) }, { level: 0 })
    const files = readBundle(zipBuffer({ 'src/a.png': imageBytes(1), 'src/pack.zip': inner }))
    expect(files.get('src/a.png')).toEqual(imageBytes(1))
  })

  it('still drops macOS junk, including inside nested zips', () => {
    const inner = zipSync({ 'a.obj': text('x'), '__MACOSX/._a.obj': text('j') }, { level: 0 })
    const files = readBundle(zipBuffer({ 'p.zip': inner, '.DS_Store': text('j') }))
    expect([...files.keys()]).toEqual(['a.obj'])
  })
})

describe('classifyTexture: what kind of map is this image, and whose is it?', () => {
  it.each([
    // the detective download
    ['textures/detective_Body_diffuse.png', 'diffuse', 'detectivebody'],
    ['textures/detective_Body_normal.png', 'normal', 'detectivebody'],
    ['textures/detective_Body_specular.png', 'specular', 'detectivebody'],
    ['textures/detective_Body_gloss.png', 'gloss', 'detectivebody'],
    ['textures/internal_ground_ao_texture.jpeg', 'ao', 'internalground'],
    // other conventions
    ['Body_BaseColor.png', 'diffuse', 'body'],
    ['Body_base_color.png', 'diffuse', 'body'],
    ['Body_Albedo.tga', 'diffuse', 'body'],
    ['Body_Normal.png', 'normal', 'body'],
    ['Body_nrm.png', 'normal', 'body'],
    ['Body_Roughness.png', 'roughness', 'body'],
    ['Body_Metallic.png', 'metalness', 'body'],
    ['Body_AmbientOcclusion.png', 'ao', 'body'],
    ['Body_ambient_occlusion.png', 'ao', 'body'],
    ['Body_Emissive.png', 'emissive', 'body'],
    ['normal_body.png', 'normal', 'body'],
    // game-engine one-letter suffixes
    ['T_Hero_Body_D.png', 'diffuse', 'herobody'],
    ['T_Hero_Body_N.png', 'normal', 'herobody'],
    ['T_Hero_Body_S.png', 'specular', 'herobody'],
    ['T_Hero_Body_R.png', 'roughness', 'herobody'],
    ['T_Hero_Body_M.png', 'metalness', 'herobody'],
    // version numbers after the role word
    ['Body_normal_01.png', 'normal', 'body'],
    // not colour maps, and not applied
    ['Body_height.png', 'other', 'body'],
    ['Body_opacity.png', 'other', 'body'],
    ['Body_ORM.png', 'other', 'body'],
  ])('%s → %s (%s)', (file, role, base) => {
    expect(classifyTexture(file)).toMatchObject({ role, base })
  })

  it('an image that names no role is treated as a plain colour picture', () => {
    expect(classifyTexture('textures/sunroof_city_6k.jpg')).toMatchObject({ role: 'diffuse', explicit: false, base: 'sunroofcity' })
  })

  it('a role-less single letter is not mistaken for a role ("d.png" alone is just a name)', () => {
    expect(classifyTexture('d.png').explicit).toBe(false)
  })

  it('takes the material name from the folder when each material has its own texture folder', () => {
    expect(classifyTexture('textures/Body/diffuse.png')).toMatchObject({ role: 'diffuse', base: 'body' })
    expect(classifyTexture('textures/Hat/normal.png')).toMatchObject({ role: 'normal', base: 'hat' })
  })

  it('only colour pictures are colour candidates', () => {
    expect(isColorImageCandidate('x_diffuse.png')).toBe(true)
    expect(isColorImageCandidate('x_normal.png')).toBe(false)
    expect(isColorImageCandidate('x_gloss.png')).toBe(false)
    expect(isColorImageCandidate('x_ao.png')).toBe(false)
    expect(isColorImageCandidate('x.fbx')).toBe(false)
  })
})

describe('planLooseTextures with a whole set of materials (the detective)', () => {
  const mats = ['Body', 'Bottom', 'Eyewear', 'Glove', 'Hat', 'Shoes', 'Top'].map((n, i) => ({ id: i, names: [n, 'mesh_' + n], textured: false }))
  const images = [
    ...mats.flatMap((m) => ['diffuse', 'normal', 'specular', 'gloss'].map((r) => `textures/detective_${m.names[0]}_${r}.png`)),
    'textures/internal_ground_ao_texture.jpeg',
  ]

  it('gives every material its own diffuse picture', () => {
    const plan = planLooseTextures(mats, images)
    expect(plan).toHaveLength(7)
    for (const { id, path } of plan) expect(path).toBe(`textures/detective_${mats[id].names[0]}_diffuse.png`)
  })

  it('"Top" is not confused with "Bottom"/"Hat"; "Body" not with "Bottom"', () => {
    const plan = Object.fromEntries(planLooseTextures(mats, images).map((p) => [mats[p.id].names[0], p.path]))
    expect(plan.Top).toContain('_Top_')
    expect(plan.Bottom).toContain('_Bottom_')
    expect(plan.Body).toContain('_Body_')
  })
})

describe('planExtraMaps: normal / specular / etc. by material name', () => {
  const mat = (id, name, has = {}) => ({ id, names: [name], textured: true, has })

  it('matches each map to the material it is named after', () => {
    const plan = planExtraMaps(
      [mat(0, 'Body'), mat(1, 'Hat')],
      ['t/detective_Body_normal.png', 't/detective_Body_specular.png', 't/detective_Hat_normal.png', 't/detective_Hat_gloss.png'],
    )
    expect(plan).toContainEqual({ id: 0, role: 'normal', path: 't/detective_Body_normal.png' })
    expect(plan).toContainEqual({ id: 0, role: 'specular', path: 't/detective_Body_specular.png' })
    expect(plan).toContainEqual({ id: 1, role: 'normal', path: 't/detective_Hat_normal.png' })
    expect(plan).toHaveLength(3) // gloss isn't applied
  })

  it('skips a map the material already has', () => {
    expect(planExtraMaps([mat(0, 'Body', { normal: true })], ['Body_normal.png', 'Body_roughness.png'])).toEqual([
      { id: 0, role: 'roughness', path: 'Body_roughness.png' },
    ])
  })

  it('never guesses: an image named after nothing in the model is left alone', () => {
    expect(planExtraMaps([mat(0, 'Body')], ['internal_ground_ao_texture.jpeg', 'Wall_normal.png'])).toEqual([])
  })

  it('prefers the closer name when two materials could claim an image', () => {
    const plan = planExtraMaps([mat(0, 'Top'), mat(1, 'DetectiveTop')], ['detective_Top_normal.png'])
    expect(plan.find((p) => p.id === 1)).toBeTruthy()
  })

  it('ignores colour maps, gloss and "other" maps', () => {
    expect(planExtraMaps([mat(0, 'Body')], ['Body_diffuse.png', 'Body_gloss.png', 'Body_height.png', 'Body_opacity.png'])).toEqual([])
  })
})
