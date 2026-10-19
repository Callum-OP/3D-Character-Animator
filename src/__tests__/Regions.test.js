import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  toRanges, fromRanges, growRegion, applyRegionIds, ensureRegionGeometry, bakeRegionsForExport,
  regionVertexCount, isRegionCapable, triangleColor, getAdjacency, setRegionOverlay, withOverlaysHidden,
} from '../three/regions.js'
import { recordOriginalMaterials, applyMaterials } from '../three/materials.js'
import { applyRegionLooks } from '../three/surfaceMaterials.js'
import { buildPartsGroup } from '../three/extractParts.js'
import { useStore } from '../store.js'

// A row of unit quads (two triangles each) sharing edges; quad i samples texel i of a
// 1-pixel-tall texture, so its faces show exactly colors[i].
function quadRow(colors, { indexed = false } = {}) {
  const n = colors.length
  const pos = []
  const uv = []
  const idx = []
  for (let i = 0; i < n; i++) {
    const x0 = i, x1 = i + 1
    const u0 = i / n, u1 = (i + 1) / n
    const base = pos.length / 3
    pos.push(x0, 0, 0, x1, 0, 0, x1, 1, 0, x0, 1, 0)
    uv.push(u0, 0, u1, 0, u1, 1, u0, 1)
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(idx)
  const g = indexed ? geo : geo.toNonIndexed()
  const data = new Uint8Array(n * 4)
  colors.forEach((c, i) => data.set([c[0], c[1], c[2], 255], i * 4))
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat)
  tex.flipY = false
  tex.needsUpdate = true
  const mat = new THREE.MeshStandardMaterial({ map: tex })
  return new THREE.Mesh(g, mat)
}
const RED = [230, 20, 20], RED2 = [225, 40, 30], BLUE = [20, 20, 230], GREEN = [20, 200, 20]
const quadsOf = (tris) => [...new Set(tris.map((t) => Math.floor(t / 2)))].sort((a, b) => a - b)

describe('ranges', () => {
  it('round-trips and merges neighbours', () => {
    expect(toRanges([5, 3, 4, 9, 10, 1])).toEqual([[1, 1], [3, 5], [9, 10]])
    expect(fromRanges([[1, 1], [3, 5], [9, 10]])).toEqual([1, 3, 4, 5, 9, 10])
  })
})

describe('growRegion: stops where the colour ends', () => {
  it('colour mode follows connected faces of that colour and stops at a different colour', () => {
    const mesh = quadRow([RED, RED2, BLUE, RED, RED])
    expect(quadsOf(growRegion(mesh, 0, { mode: 'color', tolerance: 0.25 }))).toEqual([0, 1])
    expect(quadsOf(growRegion(mesh, 7, { mode: 'color', tolerance: 0.25 }))).toEqual([3, 4]) // other end, same colour, not connected
  })

  it('tolerance decides how different a colour may be', () => {
    const mesh = quadRow([RED, GREEN, BLUE])
    expect(quadsOf(growRegion(mesh, 0, { mode: 'color', tolerance: 0 }))).toEqual([0])
    expect(quadsOf(growRegion(mesh, 0, { mode: 'color', tolerance: 1 }))).toEqual([0, 1, 2])
  })

  it('"same colour everywhere" also takes the unconnected matches; "piece" takes everything connected; "face" just one', () => {
    const mesh = quadRow([RED, RED2, BLUE, RED, RED])
    expect(quadsOf(growRegion(mesh, 0, { mode: 'everywhere', tolerance: 0.25 }))).toEqual([0, 1, 3, 4])
    expect(quadsOf(growRegion(mesh, 0, { mode: 'piece' }))).toEqual([0, 1, 2, 3, 4])
    expect(growRegion(mesh, 3, { mode: 'face' })).toEqual([3])
  })

  it('works on an indexed mesh and treats vertices split along seams as connected', () => {
    const mesh = quadRow([RED, RED2, BLUE], { indexed: true })
    expect(quadsOf(growRegion(mesh, 0, { mode: 'color', tolerance: 0.25 }))).toEqual([0, 1])
    expect(getAdjacency(mesh.geometry).length).toBe(6)
  })

  it('reads colours from the ORIGINAL material when the live one is a stand-in', () => {
    const mesh = quadRow([RED, BLUE])
    const original = mesh.material
    mesh.material = new THREE.MeshToonMaterial({ color: 0xffffff }) // no texture
    const c = triangleColor(mesh, 0, [0, 0, 0], original)
    expect(c[0]).toBeGreaterThan(0.8)
    expect(c[2]).toBeLessThan(0.2)
  })

  it('a bad seed selects nothing', () => {
    expect(growRegion(quadRow([RED]), 99, { mode: 'color' })).toEqual([])
  })
})

describe('region ids on the geometry', () => {
  it('marks exactly the region\'s faces (1-based), leaving the rest 0', () => {
    const mesh = quadRow([RED, RED, BLUE])
    const regions = [{ id: 'a', tris: [[0, 1]], vertexCount: regionVertexCount(mesh.geometry) }, { id: 'b', tris: [[4, 5]] }]
    expect(applyRegionIds(mesh, regions)).toBe(true)
    const ids = Array.from(mesh.geometry.getAttribute('regionId').array)
    expect(ids.slice(0, 6)).toEqual([1, 1, 1, 1, 1, 1])
    expect(ids.slice(6, 12)).toEqual([0, 0, 0, 0, 0, 0])
    expect(ids.slice(12, 18)).toEqual([2, 2, 2, 2, 2, 2])
  })

  it('unwraps an indexed mesh without reordering its faces', () => {
    const mesh = quadRow([RED, BLUE], { indexed: true })
    const before = mesh.geometry.index.getX(6) // first vertex of triangle 2
    const pos = mesh.geometry.attributes.position
    const expectX = pos.getX(before)
    ensureRegionGeometry(mesh)
    expect(mesh.geometry.index).toBeNull()
    expect(mesh.geometry.attributes.position.getX(6)).toBe(expectX)
  })

  it('ignores saved regions that no longer fit the geometry (re-imported / decimated)', () => {
    const mesh = quadRow([RED, BLUE])
    expect(applyRegionIds(mesh, [{ id: 'a', tris: [[0, 1]], vertexCount: 9999 }])).toBe(false)
  })

  it('leaves rigged and morphing parts alone', () => {
    const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    expect(isRegionCapable(skinned)).toBe(false)
    expect(isRegionCapable(quadRow([RED]))).toBe(true)
  })
})

describe('regions in the materials, every style', () => {
  const regionLook = { mode: 'solid', color: '#ff0000', glow: 2, glowColor: '#00ff00', roughness: 0.1, metalness: 0.9 }
  function setup() {
    const mesh = quadRow([RED, RED, BLUE])
    const original = mesh.material
    const model = { meshes: [mesh] }
    recordOriginalMaterials(model)
    const regions = [{ id: 'a', name: 'Lamp', tris: [[0, 1]], vertexCount: regionVertexCount(mesh.geometry), look: regionLook }]
    return { mesh, original, model, regions }
  }

  it.each(['unlit', 'toon', 'soft', 'standard', 'realistic'])('%s: the region look reaches the shader, the original stays pristine', (mode) => {
    const { mesh, original, model, regions } = setup()
    applyMaterials(model, { mode, overrides: { [mesh.uuid]: { regions } } })
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    expect(mat).not.toBe(original)
    expect(String(mat.customProgramCacheKey())).toContain('charanim-regions')
    const u = mat.userData.regionUniforms
    expect(u.rgColor.value[0].toArray()).toEqual([expect.closeTo(1, 3), 0, 0, 2]) // solid red
    expect(u.rgGlow.value[0].y).toBeCloseTo(1) // green glow
    expect(u.rgGlow.value[0].w).toBe(2)
    expect(u.rgSurf.value[0].x).toBeCloseTo(0.1)
    expect(u.rgSurf.value[0].y).toBeCloseTo(0.9)
    expect(String(original.customProgramCacheKey())).not.toContain('charanim-regions')
    expect(Array.from(mesh.geometry.getAttribute('regionId').array.slice(0, 6))).toEqual([1, 1, 1, 1, 1, 1])
  })

  it('removing the regions hands the original back (Studio), or switches the effect off if other edits keep the copy', () => {
    const { mesh, original, model, regions } = setup()
    applyMaterials(model, { mode: 'standard', overrides: { [mesh.uuid]: { regions } } })
    applyMaterials(model, { mode: 'standard', overrides: { [mesh.uuid]: {} } })
    expect(mesh.material).toBe(original)
    applyMaterials(model, { mode: 'standard', overrides: { [mesh.uuid]: { regions, color: '#00ff00' } } })
    const copy = mesh.material
    expect(copy.userData.regionUniforms.rgColor.value[0].w).toBe(2)
    applyMaterials(model, { mode: 'standard', overrides: { [mesh.uuid]: { color: '#00ff00' } } })
    expect(mesh.material).toBe(copy)
    expect(copy.userData.regionUniforms.rgColor.value[0].w).toBe(0)
    expect(copy.userData.regionUniforms.rgGlow.value[0].w).toBe(0)
  })

  it('saved regions that do not fit the mesh are ignored: nothing is painted', () => {
    const { mesh, original, model, regions } = setup()
    applyMaterials(model, { mode: 'standard', overrides: { [mesh.uuid]: { regions: [{ ...regions[0], vertexCount: 5 }] } } })
    expect(mesh.material).toBe(original)
  })

  it('injects the vertex + fragment code, chained after the other hooks', () => {
    const { mesh, model, regions } = setup()
    applyMaterials(model, { mode: 'toon', overrides: { [mesh.uuid]: { regions } } })
    const mat = mesh.material
    const sh = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <opaque_fragment>\n#include <dithering_fragment>',
    }
    mat.onBeforeCompile(sh, null)
    expect(sh.vertexShader).toContain('attribute float regionId;')
    expect(sh.vertexShader).toContain('vRegion = regionId;')
    expect(sh.fragmentShader).toContain('diffuseColor.rgb = rgC.rgb')
    expect(sh.fragmentShader).toContain('roughnessFactor = rgSurf')
    expect(sh.fragmentShader).toContain('outgoingLight += rgGlow')
    expect(sh.uniforms.rgColor.value).toHaveLength(8)
    expect(String(mat.customProgramCacheKey())).toContain('charanim-rim') // rim hook still there
  })

  it('applyRegionLooks with no regions is a no-op on a plain material', () => {
    const m = new THREE.MeshStandardMaterial()
    applyRegionLooks(m, null)
    expect(m.userData.regionUniforms).toBeUndefined()
  })
})

describe('writing regions to a file (bake)', () => {
  it('regroups faces so each region is its own material, keeping every triangle', () => {
    const mesh = quadRow([RED, RED, BLUE, RED])
    const base = mesh.material
    const regions = [
      { id: 'a', tris: [[0, 1]], vertexCount: 24, look: { mode: 'solid', color: '#ff0000', glow: 2, glowColor: '#00ff00' } },
      { id: 'b', tris: [[4, 5]], vertexCount: 24, look: { mode: 'tint', color: '#808080', roughness: 0.1, metalness: 1 } },
    ]
    const baked = bakeRegionsForExport(mesh, regions, base)
    expect(baked.geometry.attributes.position.count).toBe(24)
    expect(baked.geometry.groups.map((g) => [g.start, g.count])).toEqual([[0, 12], [12, 6], [18, 6]]) // the rest (quads 1 and 3), region a, region b
    expect(baked.material).toHaveLength(3)
    expect(baked.material[0]).toBe(base)
    expect(baked.material[1].color.getHexString()).toBe('ff0000')
    expect(baked.material[1].map).toBeNull() // solid colour replaces the texture
    expect(baked.material[1].emissive.getHexString()).toBe('00ff00')
    expect(baked.material[1].emissiveIntensity).toBe(2)
    expect(baked.material[2].map).toBe(base.map) // tint keeps it
    expect(baked.material[2].metalness).toBe(1)
    expect(baked.geometry.getAttribute('regionId')).toBeUndefined()
    // the first group is the faces that belong to no region: quads 2 and 3 (triangles 4,5 are region b, so 6,7)
    const px = (geo, tri) => geo.attributes.position.getX(tri * 3)
    expect(px(baked.geometry, 0)).toBe(px(mesh.geometry, 2)) // quad 1 is in region a; the rest start at triangle 2
  })

  it('does nothing for a mesh with several material groups, or saved regions that do not fit', () => {
    const mesh = quadRow([RED, BLUE])
    expect(bakeRegionsForExport(mesh, [{ id: 'a', tris: [[0, 0]], vertexCount: 12, look: {} }], [mesh.material])).toBeNull()
    expect(bakeRegionsForExport(mesh, [{ id: 'a', tris: [[0, 0]], vertexCount: 3, look: {} }], mesh.material)).toBeNull()
  })

  it('goes into an extracted object: the parts group uses the baked geometry and materials', () => {
    const mesh = quadRow([RED, BLUE])
    mesh.updateMatrixWorld(true)
    const regions = [{ id: 'a', tris: [[0, 1]], vertexCount: 12, look: { mode: 'solid', color: '#00ff00' } }]
    const { group } = buildPartsGroup([mesh], () => mesh.material, 'Car', (m) => bakeRegionsForExport(m, regions, m.material))
    expect(Array.isArray(group.children[0].material)).toBe(true)
    expect(group.children[0].geometry.groups.length).toBeGreaterThan(0)
  })
})

describe('highlight overlay', () => {
  it('is a child that is never clickable and is hidden while exporting', async () => {
    const mesh = quadRow([RED, BLUE])
    setRegionOverlay(mesh, [0, 1])
    const overlay = mesh.children.find((c) => c.userData.isRegionOverlay)
    expect(overlay).toBeTruthy()
    const hits = []
    overlay.raycast(new THREE.Raycaster(), hits)
    expect(hits).toHaveLength(0)
    let during = null
    await withOverlaysHidden(() => { during = overlay.visible })
    expect(during).toBe(false)
    expect(overlay.visible).toBe(true)
    setRegionOverlay(mesh, null)
    expect(mesh.children.some((c) => c.userData.isRegionOverlay)).toBe(false)
  })
})

describe('store', () => {
  it('setMeshRegions stores and clears a mesh\'s regions without disturbing its other overrides', () => {
    useStore.getState().setMeshesColor(['m9'], { color: '#ff0000' })
    useStore.getState().setMeshRegions('m9', [{ id: 'a', tris: [[0, 0]], look: {} }])
    expect(useStore.getState().meshOverrides.m9.regions).toHaveLength(1)
    expect(useStore.getState().meshOverrides.m9.color).toBe('#ff0000')
    useStore.getState().setMeshRegions('m9', [])
    expect(useStore.getState().meshOverrides.m9.regions).toBeUndefined()
  })
})
