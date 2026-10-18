import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { recordOriginalMaterials, applyMaterials, restoreOriginalMaterials, disposeGeneratedMaterials } from '../three/materials.js'
import { APP_MATERIAL_KEYS, stripAppMaterialData, sanitizeLoadedMaterials, withExportSafeMaterials } from '../three/materialUserData.js'

// The userData a model exported from the app carries (taken from a real export):
// Colors became hex numbers, Vector3 a plain object, and the shader's uniform map came too.
function exportedUserData() {
  return {
    rimLightInstalled: true,
    rimColor: 16777215,
    rimLightDir: { x: 0.4, y: 0.7, z: 0.58 },
    rimSoftIntensity: 0.1,
    rimSoftWidth: 0.5,
    rimHardIntensity: 0.1,
    rimHardWidth: 0.3,
    rimSideOnly: 1,
    ambientOcclusionStrength: 0.15,
    backlightColor: 16777215,
    backlightFalloff: 0.2,
    colorGrading: 0,
    shadowStrength: 0.3,
    outlineParameters: { thickness: 0.003, color: [0, 0, 0], alpha: 1, visible: false, keepAlive: false },
    rimUniforms: { diffuse: { value: 16777215 }, opacity: { value: 1 } },
    unrelated: 'keep me',
  }
}

function makeModel(userData) {
  const material = new THREE.MeshStandardMaterial({ color: 0x88aa66 })
  if (userData) material.userData = userData
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material)
  const root = new THREE.Group()
  root.add(mesh)
  return { root, meshes: [mesh], material }
}

const rimLight = {
  color: '#ffffff',
  direction: new THREE.Vector3(0.3, 0.6, 0.7),
  sideOnly: true,
  soft: { enabled: true, intensity: 0.1, width: 0.5 },
  hard: { enabled: true, intensity: 0.1, width: 0.3 },
}
const cinematic = {
  mode: 'standard', colorGrading: 'cinematic', backlightColor: '#ffffff', backlightFalloff: 0.2,
  ambientOcclusionStrength: 0.15, shadowStrength: 0.3, rimLight,
}

describe('materials carrying stale app state from an exported file', () => {
  it('Standard mode + Cinematic no longer throws "backlightColor.set is not a function"', () => {
    const model = makeModel(exportedUserData())
    recordOriginalMaterials(model)
    expect(() => applyMaterials(model, cinematic)).not.toThrow()
    const u = model.material.userData
    expect(u.backlightColor.isColor).toBe(true)
    expect(u.rimColor.isColor).toBe(true)
    expect(u.rimLightDir.isVector3).toBe(true)
    expect(String(model.material.customProgramCacheKey())).toContain('charanim-rim') // hook really installed
    expect(u.unrelated).toBe('keep me')
  })

  it('also works when a styled material is cloned (e.g. pasting a character)', () => {
    const first = makeModel()
    recordOriginalMaterials(first)
    applyMaterials(first, cinematic) // installs the rim hook on the original
    const copy = new THREE.Mesh(first.meshes[0].geometry, first.material.clone()) // userData gets JSON-copied
    const model = { root: new THREE.Group(), meshes: [copy] }
    recordOriginalMaterials(model)
    expect(() => applyMaterials(model, cinematic)).not.toThrow()
    expect(copy.material.userData.backlightColor.isColor).toBe(true)
  })

  it('still works in every other mode with polluted userData', () => {
    for (const mode of ['unlit', 'toon', 'soft', 'standard']) {
      const model = makeModel(exportedUserData())
      recordOriginalMaterials(model)
      expect(() => applyMaterials(model, { ...cinematic, mode })).not.toThrow()
      restoreOriginalMaterials(model)
      disposeGeneratedMaterials(model)
    }
  })
})

describe('materialUserData helpers', () => {
  it('stripAppMaterialData removes only the app keys', () => {
    const m = new THREE.MeshStandardMaterial()
    m.userData = exportedUserData()
    stripAppMaterialData(m)
    for (const key of APP_MATERIAL_KEYS) expect(m.userData).not.toHaveProperty(key)
    expect(m.userData.unrelated).toBe('keep me')
  })

  it('sanitizeLoadedMaterials scrubs every material under a root, including multi-material meshes', () => {
    const root = new THREE.Group()
    const a = new THREE.MeshStandardMaterial()
    const b = new THREE.MeshStandardMaterial()
    a.userData = exportedUserData()
    b.userData = exportedUserData()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), [a, b]))
    sanitizeLoadedMaterials(root)
    expect(a.userData.rimLightInstalled).toBeUndefined()
    expect(b.userData.backlightColor).toBeUndefined()
    expect(a.userData.unrelated).toBe('keep me')
  })

  it('withExportSafeMaterials hides the keys during the export and restores the live state after', async () => {
    const model = makeModel(exportedUserData())
    const live = model.material.userData
    let seen
    await withExportSafeMaterials(model.root, async () => {
      seen = { ...model.material.userData }
    })
    for (const key of APP_MATERIAL_KEYS) expect(seen).not.toHaveProperty(key)
    expect(seen.unrelated).toBe('keep me')
    expect(model.material.userData).toBe(live) // the very same live object is back
    expect(model.material.userData.rimLightInstalled).toBe(true)
  })

  it('restores the live state even if the export fails', async () => {
    const model = makeModel(exportedUserData())
    const live = model.material.userData
    await expect(withExportSafeMaterials(model.root, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(model.material.userData).toBe(live)
  })

  it('a real GLTF export no longer contains the app state, and a re-import is clean', async () => {
    const model = makeModel()
    recordOriginalMaterials(model)
    applyMaterials(model, { ...cinematic, mode: 'toon' }) // toon materials carry the full rim userData
    const styled = model.meshes[0].material
    expect(styled.userData.rimLightInstalled).toBe(true)
    const json = await withExportSafeMaterials(model.root, () => new Promise((resolve, reject) => {
      new GLTFExporter().parse(model.root, resolve, reject, { binary: false })
    }))
    const text = JSON.stringify(json)
    for (const key of APP_MATERIAL_KEYS) expect(text).not.toContain(`"${key}"`)
    expect(styled.userData.rimLightInstalled).toBe(true) // live state untouched
    // And a file that DOES still contain the keys (exported by an older version) imports cleanly.
    json.materials[0].extras = exportedUserData()
    const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(JSON.stringify(json), '', resolve, reject))
    sanitizeLoadedMaterials(gltf.scene)
    const imported = { root: gltf.scene, meshes: [] }
    gltf.scene.traverse((o) => { if (o.isMesh) imported.meshes.push(o) })
    recordOriginalMaterials(imported)
    expect(() => applyMaterials(imported, cinematic)).not.toThrow()
  })
})
