import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { fitShadowExtents, needsRefit, collectFloorReceivers, probeFloor, probeFloorY } from '../three/shadowFit.js'
import { migrateAppSettings } from '../store.js'

const sphere = (x, y, z, r) => new THREE.Sphere(new THREE.Vector3(x, y, z), r)

describe('shadow camera fitting', () => {
  it('returns null when nothing casts', () => {
    expect(fitShadowExtents([])).toBeNull()
  })

  it('covers a prop that is far from the character (the old fixed ±3r box missed it)', () => {
    const character = sphere(0, 1, 0, 1)
    const farProp = sphere(12, 1, 0, 1)
    const fit = fitShadowExtents([character, farProp], { minHalf: 3 })
    // Every caster's full extent must lie inside the fitted square.
    for (const s of [character, farProp]) {
      expect(Math.abs(s.center.x - fit.center.x) + s.radius).toBeLessThanOrEqual(fit.half)
    }
  })

  it('respects the min and max extents', () => {
    expect(fitShadowExtents([sphere(0, 0, 0, 0.1)], { minHalf: 3 }).half).toBe(3)
    expect(fitShadowExtents([sphere(0, 0, 0, 500)], { maxHalf: 30 }).half).toBe(30)
  })

  it('only refits on a meaningful change', () => {
    const a = { center: new THREE.Vector3(0, 0, 0), half: 5 }
    expect(needsRefit(null, a)).toBe(true)
    expect(needsRefit(a, { center: new THREE.Vector3(0.05, 0, 0), half: 5.1 })).toBe(false)
    expect(needsRefit(a, { center: new THREE.Vector3(3, 0, 0), half: 5 })).toBe(true)
    expect(needsRefit(a, { center: new THREE.Vector3(0, 0, 0), half: 8 })).toBe(true)
    expect(needsRefit(a, null)).toBe(false)
  })
})

describe('floor probe (shadow receiver height)', () => {
  const floor = (y, size = 20) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(size, 0.2, size), new THREE.MeshBasicMaterial())
    m.position.y = y - 0.1 // top surface at y
    m.updateMatrixWorld(true)
    m.receiveShadow = true
    return m
  }

  it('finds a raised map under the character instead of the load-time ground', () => {
    const map = new THREE.Group()
    map.add(floor(3))
    map.updateMatrixWorld(true)
    const receivers = collectFloorReceivers([map])
    const y = probeFloorY(receivers, new THREE.Vector3(0, 3.02, 0), { startAbove: 0.45, fallback: 0 })
    expect(y).toBeCloseTo(3, 5)
  })

  it('still finds the floor while the character is jumping high above it', () => {
    const map = new THREE.Group()
    map.add(floor(1))
    map.updateMatrixWorld(true)
    expect(probeFloorY(collectFloorReceivers([map]), new THREE.Vector3(0, 6, 0), { fallback: 0 })).toBeCloseTo(1, 5)
  })

  it('is not fooled by a roof above the character', () => {
    const map = new THREE.Group()
    map.add(floor(0))
    map.add(floor(5))
    map.updateMatrixWorld(true)
    expect(probeFloorY(collectFloorReceivers([map]), new THREE.Vector3(0, 0.05, 0), { startAbove: 0.45, fallback: -9 })).toBeCloseTo(0, 5)
  })

  it('falls back when the character is off the map or there are no receivers', () => {
    const map = new THREE.Group()
    map.add(floor(3, 2))
    map.updateMatrixWorld(true)
    expect(probeFloorY(collectFloorReceivers([map]), new THREE.Vector3(50, 3, 0), { fallback: 0.25 })).toBe(0.25)
    expect(probeFloorY([], new THREE.Vector3(), { fallback: 0.5 })).toBe(0.5)
  })

  it('ignores hidden, skinned and non-receiving meshes', () => {
    const root = new THREE.Group()
    const hidden = floor(2)
    hidden.visible = false
    const noReceive = floor(3)
    noReceive.receiveShadow = false
    const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    const hiddenParent = new THREE.Group()
    hiddenParent.visible = false
    hiddenParent.add(floor(4))
    const good = floor(1)
    root.add(hidden, noReceive, skinned, hiddenParent, good)
    expect(collectFloorReceivers([root])).toEqual([good])
  })
})

describe('floor probe reports whether a real surface exists (so the stand-in plane can hide)', () => {
  const slab = (y, size) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(size, 0.2, size), new THREE.MeshBasicMaterial())
    m.position.y = y - 0.1
    m.receiveShadow = true
    m.updateMatrixWorld(true)
    return m
  }

  it('hit=true over a platform, hit=false once the character is off its edge', () => {
    const g = new THREE.Group()
    g.add(slab(2, 4))
    g.updateMatrixWorld(true)
    const receivers = collectFloorReceivers([g])
    expect(probeFloor(receivers, new THREE.Vector3(0, 2, 0), { fallback: 0 })).toEqual({ hit: true, y: expect.closeTo(2, 5) })
    expect(probeFloor(receivers, new THREE.Vector3(5, 2, 0), { fallback: 0 })).toEqual({ hit: false, y: 0 })
  })

  it('hit=false with no receivers at all', () => {
    expect(probeFloor([], new THREE.Vector3(), { fallback: 1 })).toEqual({ hit: false, y: 1 })
  })
})

describe('app settings migration', () => {
  it('drops the faint 0.15 shadow defaults saved by older versions', () => {
    const out = migrateAppSettings({ shadowStrength: 0.15, shadowSoftness: 0.15, showGrid: false })
    expect(out.shadowStrength).toBeUndefined()
    expect(out.shadowSoftness).toBeUndefined()
    expect(out.showGrid).toBe(false)
  })

  it('keeps values the user actually chose', () => {
    const out = migrateAppSettings({ shadowStrength: 0.7, shadowSoftness: 0.2 })
    expect(out.shadowStrength).toBe(0.7)
    expect(out.shadowSoftness).toBe(0.2)
  })

  it('does not touch settings already at the current version', () => {
    const out = migrateAppSettings({ settingsVersion: 2, shadowStrength: 0.15 })
    expect(out.shadowStrength).toBe(0.15)
  })
})