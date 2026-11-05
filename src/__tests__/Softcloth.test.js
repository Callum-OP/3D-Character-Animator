import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  initSoftCloth,
  disposeSoftCloth,
  syncSoftCloth,
  stepSoftCloth,
  settleSoftCloth,
  resetSoftCloth,
  suspendSoftCloth,
  resumeSoftCloth,
  restoreSoftRest,
  getSoftEntry,
  isSoftClothMesh,
  makeSoftZone,
  zoneStructure,
  setSoftOverlay,
  SOFT_PRESETS,
} from '../three/softcloth.js'

let scene

beforeAll(() => {
  scene = new THREE.Scene()
  initSoftCloth({ requestRender: () => {} })
})

// A hanging sheet of cloth (7 x 9 vertices), skinned across two bones so every vertex has a blended skin matrix.
function makeSheet({ skinned = true, segments = [6, 8] } = {}) {
  const root = new THREE.Group()
  scene.add(root)
  const geo = new THREE.PlaneGeometry(1, 1.2, segments[0], segments[1])
  geo.translate(0, 0.9, 0) // y from 0.3 to 1.5
  let mesh
  let b0
  let b1
  if (skinned) {
    b0 = new THREE.Bone()
    b0.position.set(0, 0, 0)
    b1 = new THREE.Bone()
    b1.position.set(0, 1, 0)
    b0.add(b1)
    root.add(b0)
    const n = geo.getAttribute('position').count
    const si = new Uint16Array(n * 4)
    const sw = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      const y = geo.getAttribute('position').getY(i)
      const t = Math.min(1, Math.max(0, (y - 0.3) / 1.2))
      si[4 * i] = 0
      si[4 * i + 1] = 1
      sw[4 * i] = 1 - t
      sw[4 * i + 1] = t
    }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4))
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
    mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial())
    root.add(mesh)
    root.updateMatrixWorld(true)
    mesh.bind(new THREE.Skeleton([b0, b1]))
  } else {
    mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
    root.add(mesh)
  }
  root.updateMatrixWorld(true)
  return { root, mesh, b0, b1, geo }
}

const groupsFor = (mesh, zones) => [{ meshes: [mesh], overrides: zones ? { [mesh.uuid]: { softZones: zones } } : {} }]

// where the mesh draws vertex i right now, in world space (three's own CPU skinning)
function worldOf(mesh, geometry, i) {
  const saved = mesh.geometry
  mesh.geometry = geometry
  mesh.updateWorldMatrix(true, false)
  if (mesh.isSkinnedMesh) mesh.skeleton.update()
  const v = new THREE.Vector3()
  if (mesh.isSkinnedMesh) mesh.getVertexPosition(i, v)
  else v.fromBufferAttribute(geometry.getAttribute('position'), i)
  v.applyMatrix4(mesh.matrixWorld)
  mesh.geometry = saved
  return v
}

function play(rig, frames, move, dt = 1 / 60) {
  for (let f = 0; f < frames; f++) {
    if (move) move(f)
    rig.root.updateMatrixWorld(true)
    stepSoftCloth(dt)
  }
}

let rig
beforeEach(() => {
  disposeSoftCloth()
  if (rig) scene.remove(rig.root)
  rig = null
})

describe('soft zones: building and cleaning up', () => {
  it('builds on a part, swaps in a private geometry and puts the original back when removed', () => {
    rig = makeSheet()
    const original = rig.mesh.geometry
    syncSoftCloth(groupsFor(rig.mesh, [makeSoftZone('soft', { kind: 'all' }, 'jacket')]))
    expect(isSoftClothMesh(rig.mesh)).toBe(true)
    const entry = getSoftEntry(rig.mesh)
    expect(rig.mesh.geometry).not.toBe(original)
    // every buffer but position is shared, so nothing is duplicated
    expect(rig.mesh.geometry.getAttribute('skinWeight')).toBe(original.getAttribute('skinWeight'))
    expect(rig.mesh.geometry.getAttribute('position')).not.toBe(original.getAttribute('position'))
    expect(entry.unionVerts.length).toBeGreaterThan(0)
    syncSoftCloth(groupsFor(rig.mesh, []))
    expect(isSoftClothMesh(rig.mesh)).toBe(false)
    expect(rig.mesh.geometry).toBe(original)
  })

  it('a disabled zone and a zone-less part do nothing', () => {
    rig = makeSheet()
    const zone = { ...makeSoftZone('soft', { kind: 'all' }), enabled: false }
    syncSoftCloth(groupsFor(rig.mesh, [zone]))
    expect(isSoftClothMesh(rig.mesh)).toBe(false)
    syncSoftCloth(groupsFor(rig.mesh, null))
    expect(isSoftClothMesh(rig.mesh)).toBe(false)
  })

  it('a part whose geometry is replaced by something else is rebuilt, not broken', () => {
    rig = makeSheet()
    syncSoftCloth(groupsFor(rig.mesh, [makeSoftZone('soft', { kind: 'all' })]))
    const first = getSoftEntry(rig.mesh)
    const replaced = rig.mesh.geometry.clone()
    rig.mesh.geometry = replaced
    syncSoftCloth(groupsFor(rig.mesh, [makeSoftZone('soft', { kind: 'all' })]))
    const second = getSoftEntry(rig.mesh)
    expect(second).not.toBe(first)
    expect(second.orig).toBe(replaced)
  })

  it('works with the preset values for every preset', () => {
    for (const mode of ['soft', 'swing']) {
      for (const preset of SOFT_PRESETS[mode]) {
        const zone = makeSoftZone(mode, { kind: 'all' }, preset.id)
        expect(zone.mode).toBe(mode)
        expect(zone.stiffness).toBeGreaterThan(0)
        expect(zone.preset).toBe(preset.id)
      }
    }
    expect(makeSoftZone('swing', { kind: 'all' }).lockTop).toBe(0)
    const hood = SOFT_PRESETS.soft.find((preset) => preset.id === 'hood').values
    expect(hood.damping).toBeLessThan(0.3)
    expect(hood.range).toBeGreaterThan(0.15)
  })

  it('enables picked-area blending by default and includes it in zone structure', () => {
    const zone = makeSoftZone('soft', { kind: 'tris', tris: [[0, 3]], vertexCount: 12 })
    expect(zone.blendOutside).toBe(true)
    expect(zone.outsideMode).toBe('connected')
    expect(zoneStructure({ ...zone, outsideMode: 'all' })).not.toBe(zoneStructure(zone))
    expect(zoneStructure({ ...zone, blendOutside: false })).not.toBe(zoneStructure(zone))
  })

  it('only the shape-changing settings rebuild a zone', () => {
    const a = makeSoftZone('soft', { kind: 'all' })
    expect(zoneStructure({ ...a, stiffness: 0.9, gravity: 0.1, amount: 0.5 })).toBe(zoneStructure(a))
    expect(zoneStructure({ ...a, lockTop: 0.5 })).not.toBe(zoneStructure(a))
    expect(zoneStructure({ ...a, blend: 0.9 })).not.toBe(zoneStructure(a))
  })
})

describe('soft cloth: following the pose', () => {
  it('couples matching vertices across linked mesh seams', () => {
    const first = makeSheet({ skinned: false })
    const second = makeSheet({ skinned: false })
    second.root.position.x = 1
    second.root.updateMatrixWorld(true)
    const a = { ...makeSoftZone('soft', { kind: 'all' }), couplingGroup: 'joined', couplingMode: 'seams', gravity: 0.1 }
    const b = { ...makeSoftZone('soft', { kind: 'all' }), couplingGroup: 'joined', couplingMode: 'seams', gravity: 0.9 }
    syncSoftCloth([{
      meshes: [first.mesh, second.mesh],
      overrides: { [first.mesh.uuid]: { softZones: [a] }, [second.mesh.uuid]: { softZones: [b] } },
    }])
    const entryA = getSoftEntry(first.mesh)
    const entryB = getSoftEntry(second.mesh)
    for (let frame = 0; frame < 60; frame++) stepSoftCloth(1 / 60)
    const positionsB = new Map()
    for (const site of entryB.zones.get(b.id).aff) {
      const key = `${entryB.T0[3 * site].toFixed(4)},${entryB.T0[3 * site + 1].toFixed(4)}`
      positionsB.set(key, site)
    }
    let pairs = 0
    for (const site of entryA.zones.get(a.id).aff) {
      if (Math.abs(entryA.T0[3 * site] - 0.5) > 1e-4) continue
      const key = `${entryA.T0[3 * site].toFixed(4)},${entryA.T0[3 * site + 1].toFixed(4)}`
      const other = positionsB.get(key)
      if (other === undefined) continue
      expect(entryA.siteD.slice(3 * site, 3 * site + 3)).toEqual(entryB.siteD.slice(3 * other, 3 * other + 3))
      pairs++
    }
    expect(pairs).toBeGreaterThan(0)
  })

  it('gives linked meshes the same displacement in shared rigid mode', () => {
    const first = makeSheet({ skinned: false })
    const second = makeSheet({ skinned: false })
    second.root.position.x = 1
    second.root.updateMatrixWorld(true)
    const a = { ...makeSoftZone('soft', { kind: 'all' }), couplingGroup: 'joined', couplingMode: 'rigid', gravity: 0.1 }
    const b = { ...makeSoftZone('soft', { kind: 'all' }), couplingGroup: 'joined', couplingMode: 'rigid', gravity: 0.9 }
    syncSoftCloth([{
      meshes: [first.mesh, second.mesh],
      overrides: { [first.mesh.uuid]: { softZones: [a] }, [second.mesh.uuid]: { softZones: [b] } },
    }])
    const entries = [getSoftEntry(first.mesh), getSoftEntry(second.mesh)]
    for (let frame = 0; frame < 60; frame++) stepSoftCloth(1 / 60)
    const firstZone = entries[0].zones.values().next().value
    const firstSite = firstZone.aff[0]
    const displacement = [...entries[0].siteD.slice(3 * firstSite, 3 * firstSite + 3)]
    let sites = 0
    for (const entry of entries) {
      const zone = entry.zones.values().next().value
      for (const site of zone.aff) {
        expect([...entry.siteD.slice(3 * site, 3 * site + 3)]).toEqual(displacement)
        sites++
      }
    }
    expect(sites).toBeGreaterThan(0)
  })

  it('a vertex always lands exactly where the spring wants it — through skinning, rotation and scale', () => {
    rig = makeSheet()
    const zone = { ...makeSoftZone('soft', { kind: 'all' }, 'hem'), lockTop: 0.2, range: 0.2, gravity: 0.6 }
    syncSoftCloth(groupsFor(rig.mesh, [zone]))
    const entry = getSoftEntry(rig.mesh)
    rig.root.scale.setScalar(1.7) // a scaled model
    play(rig, 40, (f) => {
      rig.b0.position.x = Math.sin(f * 0.3) * 0.4
      rig.b0.quaternion.setFromAxisAngle(new THREE.Vector3(0.3, 1, 0.2).normalize(), Math.sin(f * 0.2) * 0.6)
      rig.b1.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.sin(f * 0.25) * 0.5)
    })
    expect(entry.live).toBe(true)
    // expected = the clean skinned position + the offset the zone worked out for that vertex's site
    let worst = 0
    let moved = 0
    const n = rig.mesh.geometry.getAttribute('position').count
    for (let i = 0; i < n; i++) {
      const drawn = worldOf(rig.mesh, rig.mesh.geometry, i)
      const clean = worldOf(rig.mesh, entry.orig, i)
      const s = entry.sites.siteOf[i]
      const expected = clean.clone().add(new THREE.Vector3(entry.siteD[3 * s], entry.siteD[3 * s + 1], entry.siteD[3 * s + 2]))
      worst = Math.max(worst, drawn.distanceTo(expected))
      if (drawn.distanceTo(clean) > 1e-4) moved++
    }
    expect(moved).toBeGreaterThan(10)
    expect(worst).toBeLessThan(2e-4)
  })

  it('lags behind a sudden move and then settles back onto the pose', () => {
    rig = makeSheet()
    const zone = { ...makeSoftZone('soft', { kind: 'all' }, 'hem'), lockTop: 0, range: 0.4, gravity: 0, stiffness: 0.3 }
    syncSoftCloth(groupsFor(rig.mesh, [zone]))
    const entry = getSoftEntry(rig.mesh)
    play(rig, 10) // still
    const bottom = 0 // a vertex at the very bottom of the sheet
    // yank the whole body to the side over a few frames
    play(rig, 6, (f) => {
      rig.b0.position.x = (f + 1) * 0.06
    })
    const clean = worldOf(rig.mesh, entry.orig, bottom)
    const drawn = worldOf(rig.mesh, rig.mesh.geometry, bottom)
    expect(drawn.x).toBeLessThan(clean.x - 0.01) // it is behind where the body put it
    // stay still: it catches up
    play(rig, 240)
    const later = worldOf(rig.mesh, rig.mesh.geometry, bottom)
    const laterClean = worldOf(rig.mesh, entry.orig, bottom)
    expect(later.distanceTo(laterClean)).toBeLessThan(0.01)
  })

  it('never wanders further than the range, however hard the motion', () => {
    rig = makeSheet()
    const zone = { ...makeSoftZone('soft', { kind: 'all' }), lockTop: 0, range: 0.05, gravity: 1, stiffness: 0.1, damping: 0.1 }
    syncSoftCloth(groupsFor(rig.mesh, [zone]))
    const entry = getSoftEntry(rig.mesh)
    play(rig, 120, (f) => {
      rig.b0.position.x = Math.sin(f * 0.5) * 1.5
      rig.b0.position.y = Math.cos(f * 0.7) * 0.8
    })
    const size = entry.zones.values().next().value.size
    let worst = 0
    for (let s = 0; s < entry.sites.count; s++) worst = Math.max(worst, Math.hypot(entry.siteD[3 * s], entry.siteD[3 * s + 1], entry.siteD[3 * s + 2]))
    expect(worst).toBeLessThanOrEqual(0.05 * size + 1e-4)
  })

  it('the locked top band stays on the body and the free part moves more the further it is from it', () => {
    rig = makeSheet()
    const zone = { ...makeSoftZone('soft', { kind: 'all' }, 'hem'), lockTop: 0.25, blend: 0.8, range: 0.3 }
    syncSoftCloth(groupsFor(rig.mesh, [zone]))
    const entry = getSoftEntry(rig.mesh)
    play(rig, 30, (f) => {
      rig.b0.position.x = Math.sin(f * 0.4) * 0.5
    })
    const offsetAt = (row) => {
      // vertices of one row of the sheet (row 0 = top because PlaneGeometry starts at the top)
      let sum = 0
      for (let c = 0; c <= 6; c++) {
        const v = row * 7 + c
        const s = entry.sites.siteOf[v]
        sum += Math.hypot(entry.siteD[3 * s], entry.siteD[3 * s + 1], entry.siteD[3 * s + 2])
      }
      return sum / 7
    }
    expect(offsetAt(0)).toBeLessThan(1e-6) // top row: locked
    expect(offsetAt(8)).toBeGreaterThan(offsetAt(3)) // bottom moves more than near the lock
    expect(offsetAt(3)).toBeGreaterThanOrEqual(0)
  })

  it('an area of faces moves, and everything outside it is exactly as it was', () => {
    rig = makeSheet()
    // faces of the lower-left block: triangles of the first columns of the bottom 3 rows
    const tris = []
    const cols = 6
    for (let row = 5; row < 8; row++) for (let c = 0; c < 3; c++) {
      const quad = row * cols + c
      tris.push(2 * quad, 2 * quad + 1)
    }
    const zone = { ...makeSoftZone('soft', { kind: 'tris', tris: tris.map((t) => [t, t]), vertexCount: 6 * 6 * 8 }, 'hem'), blend: 0.3, range: 0.3, blendOutside: false }
    syncSoftCloth(groupsFor(rig.mesh, [zone]))
    const entry = getSoftEntry(rig.mesh)
    play(rig, 30, (f) => {
      rig.b0.position.x = Math.sin(f * 0.4) * 0.5
    })
    const inside = new Set()
    for (const t of tris) for (let k = 0; k < 3; k++) inside.add(entry.index.getX(3 * t + k))
    let insideMoved = 0
    const rest = entry.rest
    const now = rig.mesh.geometry.getAttribute('position').array
    for (let v = 0; v < entry.nVerts; v++) {
      const changed = Math.abs(now[3 * v] - rest[3 * v]) + Math.abs(now[3 * v + 1] - rest[3 * v + 1]) + Math.abs(now[3 * v + 2] - rest[3 * v + 2]) > 1e-7
      if (!inside.has(v)) expect(changed).toBe(false)
      else if (changed) insideMoved++
    }
    expect(insideMoved).toBeGreaterThan(0)
  })

  it('blends picked-area motion into nearby unselected vertices and can extend it across the mesh', () => {
    rig = makeSheet({ skinned: false })
    const tris = []
    const cols = 6
    for (let row = 5; row < 8; row++) for (let c = 0; c < 3; c++) {
      const quad = row * cols + c
      tris.push(2 * quad, 2 * quad + 1)
    }
    const area = { kind: 'tris', tris: tris.map((t) => [t, t]), vertexCount: 6 * 6 * 8 }
    const zone = { ...makeSoftZone('soft', area, 'hem'), outsideRange: 0.45, range: 0.3 }
    syncSoftCloth(groupsFor(rig.mesh, [zone]))
    let entry = getSoftEntry(rig.mesh)
    let runtime = entry.zones.get(zone.id)
    const selected = new Set()
    for (const t of tris) for (let k = 0; k < 3; k++) selected.add(entry.index.getX(3 * t + k))
    const connectedOutside = [...runtime.aff].filter((site) => !selected.has(entry.sites.rep[site]))
    expect(connectedOutside.length).toBeGreaterThan(0)
    expect(connectedOutside.length).toBeLessThan(entry.sites.count - selected.size)

    play(rig, 30, (f) => {
      rig.mesh.rotation.z = Math.sin(f * 0.4) * 0.3
    })
    expect(connectedOutside.some((site) => Math.hypot(...entry.siteD.slice(3 * site, 3 * site + 3)) > 1e-5)).toBe(true)

    const allZone = { ...zone, outsideMode: 'all' }
    syncSoftCloth(groupsFor(rig.mesh, [allZone]))
    entry = getSoftEntry(rig.mesh)
    runtime = entry.zones.get(zone.id)
    expect(runtime.aff.length).toBeGreaterThan(connectedOutside.length)
    expect([...runtime.aff].some((site) => !selected.has(entry.sites.rep[site]) && runtime.weight[runtime.local[site]] > 0)).toBe(true)
  })

  it('lets Swing influence unselected vertices without making them part of its rigid pendulum', () => {
    rig = makeSheet()
    const tris = []
    const cols = 6
    for (let row = 5; row < 8; row++) for (let c = 0; c < 3; c++) {
      const quad = row * cols + c
      tris.push(2 * quad, 2 * quad + 1)
    }
    const zone = makeSoftZone('swing', { kind: 'tris', tris: tris.map((t) => [t, t]), vertexCount: 6 * 6 * 8 }, 'tassel')
    syncSoftCloth(groupsFor(rig.mesh, [zone]))
    const entry = getSoftEntry(rig.mesh)
    const runtime = entry.zones.get(zone.id)
    const component = runtime.comps[0]

    expect(zone.blendOutside).toBe(true)
    expect(component.blendMembers.length).toBeGreaterThan(0)
    expect(component.members.every((i) => runtime.core[runtime.aff[i]])).toBe(true)
    expect(component.blendMembers.every((i) => !runtime.core[runtime.aff[i]])).toBe(true)

    play(rig, 35, (f) => {
      rig.b0.position.x = Math.sin(f * 0.4) * 0.4
    })
    expect(component.blendMembers.some((i) => Math.hypot(...entry.siteD.slice(3 * runtime.aff[i], 3 * runtime.aff[i] + 3)) > 1e-5)).toBe(true)
  })

  it('vertices that share a place (a UV seam) stay together', () => {
    rig = makeSheet()
    // weld test: duplicate the geometry's vertices so every position exists twice
    const g = rig.geo
    const pos = g.getAttribute('position')
    const n = pos.count
    const dup = new Float32Array(n * 6)
    dup.set(pos.array.subarray(0, n * 3), 0)
    dup.set(pos.array.subarray(0, n * 3), n * 3)
    const si = g.getAttribute('skinIndex').array
    const sw = g.getAttribute('skinWeight').array
    const g2 = new THREE.BufferGeometry()
    g2.setAttribute('position', new THREE.BufferAttribute(dup, 3))
    g2.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array([...si, ...si]), 4))
    g2.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array([...sw, ...sw]), 4))
    const idx = Array.from(g.index.array)
    g2.setIndex([...idx, ...idx.map((i) => i + n)])
    rig.mesh.geometry = g2
    syncSoftCloth(groupsFor(rig.mesh, [{ ...makeSoftZone('soft', { kind: 'all' }, 'hem'), range: 0.3 }]))
    play(rig, 25, (f) => {
      rig.b0.position.x = Math.sin(f * 0.5) * 0.5
    })
    for (let v = 0; v < n; v += 5) {
      const a = worldOf(rig.mesh, rig.mesh.geometry, v)
      const b = worldOf(rig.mesh, rig.mesh.geometry, v + n)
      expect(a.distanceTo(b)).toBeLessThan(1e-6)
    }
  })

  it('works on a part that is not skinned (a prop) and follows its own movement', () => {
    rig = makeSheet({ skinned: false })
    syncSoftCloth(groupsFor(rig.mesh, [{ ...makeSoftZone('soft', { kind: 'all' }, 'hem'), lockTop: 0.2, range: 0.3 }]))
    const entry = getSoftEntry(rig.mesh)
    play(rig, 30, (f) => {
      rig.mesh.position.x = Math.sin(f * 0.4) * 0.6
      rig.mesh.rotation.z = Math.sin(f * 0.3) * 0.3
    })
    let moved = 0
    const n = rig.mesh.geometry.getAttribute('position').count
    for (let i = 0; i < n; i++) {
      const drawn = worldOf(rig.mesh, rig.mesh.geometry, i)
      const clean = worldOf(rig.mesh, entry.orig, i)
      const s = entry.sites.siteOf[i]
      const expected = clean.clone().add(new THREE.Vector3(entry.siteD[3 * s], entry.siteD[3 * s + 1], entry.siteD[3 * s + 2]))
      expect(drawn.distanceTo(expected)).toBeLessThan(2e-4)
      if (drawn.distanceTo(clean) > 1e-4) moved++
    }
    expect(moved).toBeGreaterThan(5)
  })
})

describe('playing and stopping', () => {
  it('resets only the selected effect', () => {
    rig = makeSheet()
    const first = makeSoftZone('soft', { kind: 'all' }, 'jacket')
    const second = makeSoftZone('soft', { kind: 'all' }, 'sleeves')
    syncSoftCloth(groupsFor(rig.mesh, [first, second]))
    play(rig, 2)

    const entry = getSoftEntry(rig.mesh)
    expect(entry.zones.get(first.id).ready).toBe(true)
    expect(entry.zones.get(second.id).ready).toBe(true)

    resetSoftCloth(rig.mesh, first.id)

    expect(entry.zones.get(first.id).ready).toBe(false)
    expect(entry.zones.get(second.id).ready).toBe(true)
  })

  it('a still frame (paused, scrubbed, posed) is always the clean pose', () => {
    rig = makeSheet()
    syncSoftCloth(groupsFor(rig.mesh, [{ ...makeSoftZone('soft', { kind: 'all' }, 'hem'), range: 0.3 }]))
    const entry = getSoftEntry(rig.mesh)
    play(rig, 20, (f) => {
      rig.b0.position.x = Math.sin(f * 0.5) * 0.5
    })
    expect(entry.live).toBe(true)
    settleSoftCloth()
    expect(entry.live).toBe(false)
    const now = rig.mesh.geometry.getAttribute('position').array
    expect(Array.from(now)).toEqual(Array.from(entry.rest))
  })

  it('a jump in the animation does not fling the cloth', () => {
    rig = makeSheet()
    const zone = { ...makeSoftZone('soft', { kind: 'all' }, 'hem'), lockTop: 0, range: 0.2 }
    syncSoftCloth(groupsFor(rig.mesh, [zone]))
    const entry = getSoftEntry(rig.mesh)
    play(rig, 10)
    rig.b0.position.x = 25 // a scrub / cut to somewhere far away
    play(rig, 1)
    let worst = 0
    for (let s = 0; s < entry.sites.count; s++) worst = Math.max(worst, Math.hypot(entry.siteD[3 * s], entry.siteD[3 * s + 1], entry.siteD[3 * s + 2]))
    expect(worst).toBeLessThan(0.05)
  })

  it('exports see the clean pose: suspend writes it, resume brings the effect back', () => {
    rig = makeSheet()
    syncSoftCloth(groupsFor(rig.mesh, [{ ...makeSoftZone('soft', { kind: 'all' }, 'hem'), range: 0.3 }]))
    const entry = getSoftEntry(rig.mesh)
    play(rig, 20, (f) => {
      rig.b0.position.x = Math.sin(f * 0.5) * 0.5
    })
    suspendSoftCloth()
    expect(Array.from(rig.mesh.geometry.getAttribute('position').array)).toEqual(Array.from(entry.rest))
    play(rig, 3, (f) => {
      rig.b0.position.x = 0.2 * f
    }) // suspended: no effect written
    expect(Array.from(rig.mesh.geometry.getAttribute('position').array)).toEqual(Array.from(entry.rest))
    resumeSoftCloth()
    play(rig, 10, (f) => {
      rig.b0.position.x = Math.sin(f * 0.5) * 0.5
    })
    expect(Array.from(rig.mesh.geometry.getAttribute('position').array)).not.toEqual(Array.from(entry.rest))
    restoreSoftRest()
    expect(Array.from(rig.mesh.geometry.getAttribute('position').array)).toEqual(Array.from(entry.rest))
  })
})

describe('swing: a separate piece hanging from a point', () => {
  // a small quad (a zip pull) hanging at (0, 1, 0) from a body bone; its own vertices, joined to nothing
  function makePull() {
    const root = new THREE.Group()
    scene.add(root)
    const bone = new THREE.Bone()
    root.add(bone)
    const geo = new THREE.BufferGeometry()
    // a tab 0.05 wide, 0.12 long, hanging down from y = 1
    const verts = [-0.025, 1, 0, 0.025, 1, 0, -0.025, 0.88, 0, 0.025, 0.88, 0]
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    geo.setIndex([0, 2, 1, 1, 2, 3])
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(16), 4))
    const sw = new Float32Array(16)
    for (let i = 0; i < 4; i++) sw[4 * i] = 1
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
    const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial())
    root.add(mesh)
    root.updateMatrixWorld(true)
    mesh.bind(new THREE.Skeleton([bone]))
    return { root, mesh, b0: bone }
  }

  it('swings as ONE rigid piece: its shape never changes', () => {
    rig = makePull()
    syncSoftCloth(groupsFor(rig.mesh, [makeSoftZone('swing', { kind: 'all' }, 'zip')]))
    const entry = getSoftEntry(rig.mesh)
    const before = [0, 1, 2, 3].map((i) => worldOf(rig.mesh, entry.orig, i))
    const d01 = before[0].distanceTo(before[1])
    const d03 = before[0].distanceTo(before[3])
    let maxMove = 0
    for (let f = 0; f < 40; f++) {
      play(rig, 1, () => {
        rig.b0.position.x = Math.sin(f * 0.5) * 0.4
        rig.b0.position.z = Math.cos(f * 0.4) * 0.2
      })
      const now = [0, 1, 2, 3].map((i) => worldOf(rig.mesh, rig.mesh.geometry, i))
      const clean = [0, 1, 2, 3].map((i) => worldOf(rig.mesh, entry.orig, i))
      // rigid: every distance inside the piece is what it was
      expect(now[0].distanceTo(now[1])).toBeCloseTo(d01, 3)
      expect(now[0].distanceTo(now[3])).toBeCloseTo(d03, 3)
      maxMove = Math.max(maxMove, ...now.map((p, i) => p.distanceTo(clean[i])))
    }
    expect(maxMove).toBeGreaterThan(1e-4) // and it did move
  })

  it('does not turn a whole-part translation into a false swing', () => {
    rig = makePull()
    syncSoftCloth(groupsFor(rig.mesh, [makeSoftZone('swing', { kind: 'all' }, 'zip')]))
    const entry = getSoftEntry(rig.mesh)
    rig.root.position.set(3, 0, -2)
    play(rig, 1)

    for (let i = 0; i < 4; i++) {
      const clean = worldOf(rig.mesh, entry.orig, i)
      const drawn = worldOf(rig.mesh, rig.mesh.geometry, i)
      expect(drawn.distanceTo(clean)).toBeLessThan(1e-3)
    }
  })

  it('hangs from its top: the top barely moves, the bottom swings out', () => {
    rig = makePull()
    syncSoftCloth(groupsFor(rig.mesh, [{ ...makeSoftZone('swing', { kind: 'all' }, 'tassel'), stiffness: 0.05 }]))
    const entry = getSoftEntry(rig.mesh)
    let topMax = 0
    let bottomMax = 0
    play(rig, 60, (f) => {
      rig.b0.position.x = Math.sin(f * 0.45) * 0.5
      const top = worldOf(rig.mesh, rig.mesh.geometry, 0).distanceTo(worldOf(rig.mesh, entry.orig, 0))
      const bottom = worldOf(rig.mesh, rig.mesh.geometry, 2).distanceTo(worldOf(rig.mesh, entry.orig, 2))
      topMax = Math.max(topMax, top)
      bottomMax = Math.max(bottomMax, bottom)
    })
    expect(bottomMax).toBeGreaterThan(0)
    expect(bottomMax).toBeGreaterThan(topMax)
  })

  it('uses the upper edge of a picked region as its swing attachment', () => {
    rig = makeSheet({ skinned: false })
    const pos = rig.mesh.geometry.getAttribute('position')
    const index = rig.mesh.geometry.index
    const tris = []
    for (let t = 0; t < index.count / 3; t++) {
      const y = (pos.getY(index.getX(3 * t)) + pos.getY(index.getX(3 * t + 1)) + pos.getY(index.getX(3 * t + 2))) / 3
      const x = (pos.getX(index.getX(3 * t)) + pos.getX(index.getX(3 * t + 1)) + pos.getX(index.getX(3 * t + 2))) / 3
      if (y < 0.9 && Math.abs(x) < 0.35) tris.push([t, t])
    }
    const zone = makeSoftZone('swing', { kind: 'tris', tris, vertexCount: pos.count }, 'tassel')
    syncSoftCloth(groupsFor(rig.mesh, [zone]))
    const entry = getSoftEntry(rig.mesh)
    const runtime = entry.zones.get(zone.id)
    const component = runtime.comps[0]
    const attachmentYs = [...component.attach].map((i) => entry.T0[3 * runtime.anchors[i] + 1])
    expect(component.attach.length).toBeGreaterThan(0)
    expect(component.attach.length).toBeLessThan(runtime.anchors.length)
    expect(Math.min(...attachmentYs)).toBeGreaterThan(0.89)
  })

  it('never swings past its limit', () => {
    rig = makePull()
    syncSoftCloth(groupsFor(rig.mesh, [{ ...makeSoftZone('swing', { kind: 'all' }, 'tassel'), swingLimit: 20, stiffness: 0.02, damping: 0.05 }]))
    const entry = getSoftEntry(rig.mesh)
    let worst = 0
    play(rig, 120, (f) => {
      rig.b0.position.x = Math.sin(f * 0.6) * 1.2
      const clean = [0, 1, 2, 3].map((i) => worldOf(rig.mesh, entry.orig, i))
      const now = [0, 1, 2, 3].map((i) => worldOf(rig.mesh, rig.mesh.geometry, i))
      // the piece's own axis (top midpoint -> bottom midpoint) turned by at most the limit
      const axis = (p) => p[2].clone().add(p[3]).sub(p[0].clone().add(p[1])).normalize()
      worst = Math.max(worst, axis(clean).angleTo(axis(now)))
    })
    expect(worst).toBeLessThanOrEqual(THREE.MathUtils.degToRad(20) + 0.02)
  })
})

describe('area highlight', () => {
  it('draws a highlight that follows the skeleton for a skinned part, and removes it again', () => {
    rig = makeSheet()
    syncSoftCloth(groupsFor(rig.mesh, [makeSoftZone('soft', { kind: 'all' })]))
    setSoftOverlay(rig.mesh, [0, 1, 2])
    const overlay = rig.mesh.parent.children.find((c) => c.userData.isSoftOverlay)
    expect(overlay).toBeTruthy()
    expect(overlay.isSkinnedMesh).toBe(true)
    setSoftOverlay(rig.mesh, null)
    expect(rig.mesh.parent.children.some((c) => c.userData.isSoftOverlay)).toBe(false)
  })
})
