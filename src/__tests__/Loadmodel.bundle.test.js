import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { installImageStubs } from './helpers/imageStubs.js'
import { asciiFbx, OBJ_QUAD, OBJ_MULTI, MTL, gltfWithExternals, ASCII_STL, PNG_1PX, imageBytes } from './helpers/modelFixtures.js'
import { loadModel } from '../three/loadModel.js'
import { bundleModelFiles } from '../three/modelBundle.js'

let stubs
beforeAll(() => {
  stubs = installImageStubs()
})
afterAll(() => stubs.restore())
beforeEach(() => {
  stubs.blobs.clear()
  stubs.revoke.mockClear()
})

const zipFile = (files, name = 'pack.zip') => new File([zipSync(files, { level: 0 })], name)
const meshesOf = (parsed) => {
  const out = []
  parsed.root.traverse((o) => o.isMesh && out.push(o))
  return out
}
const firstMaterial = (parsed) => {
  const m = meshesOf(parsed)[0].material
  return Array.isArray(m) ? m[0] : m
}
// the bytes a texture's <img> was pointed at
const textureBytes = (material) => stubs.bytesOf(material.map.image.src)
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
const opts = { autoDecimate: false }

describe('FBX with its textures in a separate folder', () => {
  it('finds a texture named by an absolute Windows path on the artist\'s machine', async () => {
    const parsed = await loadModel(zipFile({ 'source/robot.fbx': asciiFbx(), 'textures/wood.png': PNG_1PX }), opts)
    const mat = firstMaterial(parsed)
    expect(mat.map).toBeTruthy()
    expect(same(await textureBytes(mat), PNG_1PX)).toBe(true) // the real file's bytes, not a placeholder
    expect(parsed.info.bundle).toMatchObject({ files: 2, texturesFound: 1, missingTextures: [], looseTexturesApplied: 0 })
  })

  it('also with the relative path alone (../textures/wood.png) and a different folder layout', async () => {
    const fbx = asciiFbx({ filename: 'wood.png', relative: '..\\textures\\wood.png' })
    const parsed = await loadModel(zipFile({ 'a/b/model.fbx': fbx, 'art/wood.png': PNG_1PX }), opts)
    expect(firstMaterial(parsed).map).toBeTruthy()
  })

  it('matches names regardless of letter case', async () => {
    const parsed = await loadModel(zipFile({ 'model.fbx': asciiFbx(), 'Textures/WOOD.PNG': PNG_1PX }), opts)
    expect(firstMaterial(parsed).map).toBeTruthy()
  })

  it('reports a texture that is referenced but missing from the folder, and still loads the model', async () => {
    const parsed = await loadModel(zipFile({ 'model.fbx': asciiFbx() }), opts)
    expect(meshesOf(parsed)).toHaveLength(1)
    expect(parsed.info.bundle.missingTextures.map((p) => p.toLowerCase())).toContain('wood.png')
    expect(parsed.info.bundle.texturesFound).toBe(0)
  })

  it('an FBX that never mentions a texture (like the skybox sample) gets the lone image applied', async () => {
    const parsed = await loadModel(zipFile({ 'source/sky.fbx': asciiFbx({ withTexture: false }), 'textures/sunroof.jpg': imageBytes(1) }), opts)
    const mat = firstMaterial(parsed)
    expect(mat.map).toBeTruthy()
    expect(same(await textureBytes(mat), imageBytes(1))).toBe(true)
    expect(mat.color.getHex()).toBe(0xffffff) // the grey default would otherwise dim the picture
    expect(mat.map.colorSpace).toBe('srgb')
    expect(parsed.info.bundle.looseTexturesApplied).toBe(1)
  })

  it('does not paste a normal map over a plain material', async () => {
    const parsed = await loadModel(zipFile({ 'sky.fbx': asciiFbx({ withTexture: false }), 'tex/sky_normal.png': imageBytes(2) }), opts)
    expect(firstMaterial(parsed).map).toBeFalsy()
    expect(parsed.info.bundle.looseTexturesApplied).toBe(0)
  })

  it('a texture the model DOES reference is not also treated as a loose one', async () => {
    const parsed = await loadModel(zipFile({ 'm.fbx': asciiFbx(), 'textures/wood.png': PNG_1PX, 'textures/spare.png': imageBytes(3) }), opts)
    expect(parsed.info.bundle.looseTexturesApplied).toBe(0)
    expect(same(await textureBytes(firstMaterial(parsed)), PNG_1PX)).toBe(true)
  })
})

describe('the folder → bundle → load round trip', () => {
  it('a dropped folder is packed and then loads with its textures', async () => {
    const asFile = (bytes, name) => new File([bytes], name)
    const bundled = await bundleModelFiles([
      { file: asFile(asciiFbx(), 'robot.fbx'), path: 'source/robot.fbx' },
      { file: asFile(PNG_1PX, 'wood.png'), path: 'textures/wood.png' },
    ])
    expect(bundled.name).toBe('robot.zip')
    const parsed = await loadModel(bundled, opts)
    expect(parsed.info.name).toBe('robot')
    expect(parsed.info.format).toBe('fbx')
    expect(firstMaterial(parsed).map).toBeTruthy()
  })

  it('what comes out is a self-contained single File (so project save / reload keeps working)', async () => {
    const bundled = await bundleModelFiles([
      { file: new File([asciiFbx()], 'robot.fbx'), path: 'robot.fbx' },
      { file: new File([PNG_1PX], 'wood.png'), path: 'wood.png' },
    ])
    // a second load from the very same File — what reopening a saved project does
    const again = await loadModel(new File([await bundled.arrayBuffer()], bundled.name), opts)
    expect(firstMaterial(again).map).toBeTruthy()
  })

  it('a .zip is named after the zip when loaded, and reports the model format inside it', async () => {
    const parsed = await loadModel(zipFile({ 'source/x.fbx': asciiFbx(), 'textures/wood.png': PNG_1PX }, 'free-skybox-pack.zip'), opts)
    expect(parsed.info.name).toBe('free-skybox-pack')
    expect(parsed.info.format).toBe('fbx')
  })
})

describe('OBJ + MTL', () => {
  const objFiles = (extra = {}) => ({ 'quad.obj': OBJ_QUAD(), 'quad.mtl': MTL('textures/diffuse.png'), 'textures/diffuse.png': PNG_1PX, ...extra })

  it('applies the .mtl material and finds its texture in the folder', async () => {
    const parsed = await loadModel(zipFile(objFiles()), opts)
    const mat = firstMaterial(parsed)
    expect(mat.name).toBe('Wood')
    expect(same(await textureBytes(mat), PNG_1PX)).toBe(true)
  })

  it('finds the texture even when the .mtl points at it with a path from another machine', async () => {
    const parsed = await loadModel(zipFile(objFiles({ 'quad.mtl': MTL('C:\\Users\\me\\Desktop\\textures\\diffuse.png') })), opts)
    expect(firstMaterial(parsed).map).toBeTruthy()
  })

  it('uses the only .mtl in the bundle even if the OBJ names a different one', async () => {
    const parsed = await loadModel(zipFile(objFiles({ 'quad.obj': OBJ_QUAD('somewhere_else.mtl') })), opts)
    expect(firstMaterial(parsed).map).toBeTruthy()
  })

  it('an OBJ on its own (no materials) still loads', async () => {
    const parsed = await loadModel(new File([OBJ_QUAD('missing.mtl')], 'solo.obj'), opts)
    expect(meshesOf(parsed)).toHaveLength(1)
    expect(parsed.info.format).toBe('obj')
    expect(parsed.info.name).toBe('solo')
  })
})

describe('glTF with external files', () => {
  it('loads the .bin and the image from beside the .gltf', async () => {
    const { gltf, bin } = gltfWithExternals()
    const parsed = await loadModel(zipFile({ 'scene.gltf': gltf, 'geometry.bin': bin, 'tex/albedo.png': PNG_1PX }), opts)
    expect(meshesOf(parsed)).toHaveLength(1)
    expect(meshesOf(parsed)[0].geometry.attributes.position.count).toBe(3)
    const mat = firstMaterial(parsed)
    expect(mat.map).toBeTruthy()
  })

  it('finds them in different folders from where the .gltf names them', async () => {
    const { gltf, bin } = gltfWithExternals()
    const parsed = await loadModel(zipFile({ 'model/scene.gltf': gltf, 'model/buffers/geometry.bin': bin, 'images/albedo.png': PNG_1PX }), opts)
    expect(meshesOf(parsed)[0].geometry.attributes.position.count).toBe(3)
    expect(firstMaterial(parsed).map).toBeTruthy()
  })
})

describe('other formats', () => {
  it('STL', async () => {
    const parsed = await loadModel(new File([ASCII_STL], 'part.stl'), opts)
    expect(meshesOf(parsed)).toHaveLength(1)
    expect(meshesOf(parsed)[0].geometry.attributes.position.count).toBe(3)
    expect(parsed.info.format).toBe('stl')
  })

  it('STL inside a zip', async () => {
    const parsed = await loadModel(zipFile({ 'part.stl': ASCII_STL }), opts)
    expect(meshesOf(parsed)).toHaveLength(1)
  })

  it('PLY', async () => {
    const ply = new Uint8Array(new TextEncoder().encode(
      'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n',
    ))
    const parsed = await loadModel(new File([ply], 'part.ply'), opts)
    expect(meshesOf(parsed)).toHaveLength(1)
    expect(parsed.info.format).toBe('ply')
  })
})

describe('errors and clean-up', () => {
  it('a zip with no model in it says so', async () => {
    await expect(loadModel(zipFile({ 'readme.txt': PNG_1PX, 'a.png': PNG_1PX }), opts)).rejects.toThrow(/no 3D model found inside the archive/)
  })

  it('a file that is not really a zip is a readable error', async () => {
    await expect(loadModel(new File(['definitely not a zip'], 'broken.zip'), opts)).rejects.toThrow(/could not read the archive/)
  })

  it('a corrupt model inside a zip is reported, not swallowed', async () => {
    await expect(loadModel(zipFile({ 'bad.obj': new Uint8Array(0), 'bad.fbx': imageBytes(4) }), opts)).rejects.toThrow(/Failed to load model/)
  })

  it('every blob URL it created is released once loading is done', async () => {
    await loadModel(zipFile({ 'source/robot.fbx': asciiFbx(), 'textures/wood.png': PNG_1PX }), opts)
    expect(stubs.blobs.size).toBeGreaterThan(0)
    expect(stubs.revoke.mock.calls.length).toBe(stubs.blobs.size)
  })

  it('and also when loading fails', async () => {
    await loadModel(zipFile({ 'bad.fbx': imageBytes(5), 'textures/wood.png': PNG_1PX }), opts).catch(() => {})
    expect(stubs.revoke.mock.calls.length).toBe(stubs.blobs.size)
  })
})

// ---------------------------------------------------------------------------
// The "detective" download layout: source/model.zip (a zip INSIDE the zip) next
// to a textures/ folder of per-material sets, and an OBJ that names an .mtl which
// isn't there at all.
// ---------------------------------------------------------------------------
describe('nested zip + missing .mtl + per-material texture sets', () => {
  const sets = (names, extra = {}) => {
    const out = {}
    let seed = 10
    for (const n of names) for (const role of ['diffuse', 'normal', 'specular', 'gloss']) out[`textures/detective_${n}_${role}.png`] = imageBytes(seed++)
    return { ...out, 'textures/internal_ground_ao_texture.jpeg': imageBytes(99), ...extra }
  }
  const nestedLayout = (names = ['Body', 'Hat']) => {
    const inner = zipSync({ 'detective.obj': OBJ_MULTI(names, 'detective.mtl') }, { level: 0 })
    return { 'source/detective.zip': inner, ...sets(names) }
  }
  const byName = (parsed) => {
    const out = {}
    parsed.root.traverse((o) => {
      if (o.isMesh) for (const m of [].concat(o.material)) out[m.name] = m
    })
    return out
  }

  it('opens the zip inside the zip and builds the materials from the texture names', async () => {
    const parsed = await loadModel(zipFile(nestedLayout(), 'detective.zip'), opts)
    expect(parsed.info.format).toBe('obj')
    expect(meshesOf(parsed)).toHaveLength(2)
    const mats = byName(parsed)
    expect(Object.keys(mats).sort()).toEqual(['Body', 'Hat'])
  })

  it('each material gets ITS OWN diffuse, normal and specular map (checked by the bytes loaded)', async () => {
    const files = nestedLayout()
    const parsed = await loadModel(zipFile(files, 'detective.zip'), opts)
    const mats = byName(parsed)
    for (const n of ['Body', 'Hat']) {
      expect(same(await stubs.bytesOf(mats[n].map.image.src), files[`textures/detective_${n}_diffuse.png`])).toBe(true)
      expect(same(await stubs.bytesOf(mats[n].normalMap.image.src), files[`textures/detective_${n}_normal.png`])).toBe(true)
      expect(same(await stubs.bytesOf(mats[n].specularMap.image.src), files[`textures/detective_${n}_specular.png`])).toBe(true)
      expect(mats[n].color.getHex()).toBe(0xffffff)
    }
  })

  it('colour pictures are sRGB, the data maps (normal, specular) are not', async () => {
    const parsed = await loadModel(zipFile(nestedLayout(), 'detective.zip'), opts)
    const { Body } = byName(parsed)
    expect(Body.map.colorSpace).toBe('srgb')
    expect(Body.normalMap.colorSpace).not.toBe('srgb')
    expect(Body.specularMap.colorSpace).not.toBe('srgb')
  })

  it('leaves the unrelated ambient-occlusion image and the gloss maps unused, and reports counts', async () => {
    const parsed = await loadModel(zipFile(nestedLayout(), 'detective.zip'), opts)
    expect(parsed.info.bundle).toMatchObject({ looseTexturesApplied: 2, extraMapsApplied: 4, missingTextures: [] })
    const { Body } = byName(parsed)
    expect(Body.aoMap).toBeFalsy()
  })

  it('works when the zip-in-a-zip arrives as an unpacked folder (dropped from disk)', async () => {
    const files = nestedLayout()
    const entries = Object.entries(files).map(([path, bytes]) => ({ file: new File([bytes], path.split('/').pop()), path }))
    const bundled = await bundleModelFiles(entries)
    expect(bundled.name).toBe('detective.zip')
    const parsed = await loadModel(bundled, opts)
    expect(byName(parsed).Body.map).toBeTruthy()
    expect(byName(parsed).Hat.normalMap).toBeTruthy()
  })

  it('a material with no matching images stays plain; the others are still textured', async () => {
    const inner = zipSync({ 'm.obj': OBJ_MULTI(['Body', 'Mystery']) }, { level: 0 })
    const parsed = await loadModel(zipFile({ 'source/m.zip': inner, ...sets(['Body']) }), opts)
    const mats = byName(parsed)
    expect(mats.Body.map).toBeTruthy()
    expect(mats.Mystery.map).toBeFalsy()
    expect(mats.Mystery.normalMap).toBeFalsy()
  })
})

describe('other folder / naming styles', () => {
  const mats = (parsed) => {
    const out = {}
    parsed.root.traverse((o) => o.isMesh && [].concat(o.material).forEach((m) => (out[m.name] = m)))
    return out
  }

  it('game-engine suffixes (T_Body_D / _N / _S)', async () => {
    const parsed = await loadModel(zipFile({
      'm.obj': OBJ_MULTI(['Body', 'Hat']),
      'Textures/T_Body_D.png': imageBytes(1), 'Textures/T_Body_N.png': imageBytes(2), 'Textures/T_Body_S.png': imageBytes(3),
      'Textures/T_Hat_D.png': imageBytes(4),
    }), opts)
    const m = mats(parsed)
    expect(m.Body.map && m.Body.normalMap && m.Body.specularMap).toBeTruthy()
    expect(m.Hat.map).toBeTruthy()
    expect(m.Hat.normalMap).toBeFalsy()
  })

  it('one folder per material (textures/Body/diffuse.png)', async () => {
    const parsed = await loadModel(zipFile({
      'm.obj': OBJ_MULTI(['Body', 'Hat']),
      'textures/Body/diffuse.png': imageBytes(1), 'textures/Body/normal.png': imageBytes(2),
      'textures/Hat/diffuse.png': imageBytes(3),
    }), opts)
    const m = mats(parsed)
    expect(same(await stubs.bytesOf(m.Body.map.image.src), imageBytes(1))).toBe(true)
    expect(same(await stubs.bytesOf(m.Hat.map.image.src), imageBytes(3))).toBe(true)
    expect(m.Body.normalMap).toBeTruthy()
  })

  it('an .mtl that gives the colour but no normal map: a normal map in the folder still gets added', async () => {
    const parsed = await loadModel(zipFile({
      'quad.obj': OBJ_QUAD(),
      'quad.mtl': MTL('textures/Wood_diffuse.png'),
      'textures/Wood_diffuse.png': PNG_1PX,
      'textures/Wood_normal.png': imageBytes(7),
    }), opts)
    const wood = mats(parsed).Wood
    expect(same(await textureBytes(wood), PNG_1PX)).toBe(true) // from the .mtl
    expect(wood.normalMap).toBeTruthy() // from the folder
    expect(parsed.info.bundle.looseTexturesApplied).toBe(0)
    expect(parsed.info.bundle.extraMapsApplied).toBe(1)
  })

  it('does not overwrite a map the model already has', async () => {
    const parsed = await loadModel(zipFile({
      'quad.obj': OBJ_QUAD(), 'quad.mtl': MTL('textures/Wood_diffuse.png'),
      'textures/Wood_diffuse.png': PNG_1PX, 'textures/Wood_diffuse_alt.png': imageBytes(8),
    }), opts)
    expect(same(await textureBytes(mats(parsed).Wood), PNG_1PX)).toBe(true)
  })
})
