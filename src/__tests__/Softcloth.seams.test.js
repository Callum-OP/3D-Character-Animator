import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { initSoftCloth, disposeSoftCloth, syncSoftCloth, stepSoftCloth, getSoftEntry, makeSoftZone } from '../three/softcloth.js'

// A hood and its drawstrings are usually TWO parts. Whatever the cloth does to one, the place where
// they meet has to stay together: the strings must move in harmony with the hood they hang from.

let scene
beforeAll(() => {
  scene = new THREE.Scene()
  initSoftCloth({ requestRender: () => {} })
})

const NX = 24
const X = (c) => -0.5 + c / NX
const Y = (r) => 1.5 - (r * 1.2) / 32

function skinnedGrid(rows, cols, bones) {
  // rows/cols are inclusive index ranges of quads on the shared 24 x 32 grid
  const [r0, r1] = rows
  const [c0, c1] = cols
  const pos = []
  const idx = []
  const si = []
  const sw = []
  const node = new Map()
  const v = (r, c) => {
    const k = r * 100 + c
    if (!node.has(k)) {
      const y = Y(r)
      const t = Math.min(1, Math.max(0, (y - 0.3) / 1.2))
      pos.push(X(c), y, 0)
      si.push(0, 1, 0, 0)
      sw.push(1 - t, t, 0, 0)
      node.set(k, pos.length / 3 - 1)
    }
    return node.get(k)
  }
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const a = v(r, c)
      const b = v(r, c + 1)
      const d = v(r + 1, c)
      const e = v(r + 1, c + 1)
      idx.push(a, d, b, b, d, e)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(si), 4))
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(sw), 4))
  geo.setIndex(idx)
  return { geo, node }
}

function makeRig() {
  const root = new THREE.Group()
  const b0 = new THREE.Bone()
  const b1 = new THREE.Bone()
  b1.position.set(0, 1, 0)
  b0.add(b1)
  root.add(b0)
  const skeleton = new THREE.Skeleton([b0, b1])
  const hood = skinnedGrid([0, 8], [0, NX - 1], skeleton) // its bottom edge (node row 9) is where the string hangs
  const string = skinnedGrid([9, 31], [10, 13], skeleton) // hangs from the hood's row 9
  const hoodMesh = new THREE.SkinnedMesh(hood.geo, new THREE.MeshBasicMaterial())
  const stringMesh = new THREE.SkinnedMesh(string.geo, new THREE.MeshBasicMaterial())
  root.add(hoodMesh, stringMesh)
  root.updateMatrixWorld(true)
  hoodMesh.bind(skeleton)
  stringMesh.bind(skeleton)
  scene.add(root)
  return { root, b0, hoodMesh, stringMesh, hood, string }
}

const worldOf = (mesh, i) => mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld)

// the strings' top row against the hood's row where they join, over a lively walk
function joinGap(rig, hoodZones, stringZones, frames = 90) {
  const groups = [
    {
      meshes: [rig.hoodMesh, rig.stringMesh],
      overrides: {
        ...(hoodZones ? { [rig.hoodMesh.uuid]: { softZones: hoodZones } } : {}),
        ...(stringZones ? { [rig.stringMesh.uuid]: { softZones: stringZones } } : {}),
      },
    },
  ]
  syncSoftCloth(groups)
  const pairs = []
  for (let c = 10; c <= 14; c++) pairs.push([rig.hood.node.get(9 * 100 + c), rig.string.node.get(9 * 100 + c)])
  let gap = 0
  let moved = 0
  for (let f = 0; f < frames; f++) {
    const t = f / 60
    rig.b0.position.set(Math.sin(t * 12) * 0.12, 0.06 * Math.sin(t * 24), Math.sin(t * 12 + 1) * 0.1)
    rig.root.updateMatrixWorld(true)
    stepSoftCloth(1 / 60)
    for (const [h, s] of pairs) {
      gap = Math.max(gap, worldOf(rig.hoodMesh, h).distanceTo(worldOf(rig.stringMesh, s)))
    }
    moved = Math.max(moved, worldOf(rig.stringMesh, pairs[2][1]).y)
  }
  void moved
  return gap
}

let rig
beforeEach(() => {
  disposeSoftCloth()
  if (rig) scene.remove(rig.root)
  rig = makeRig()
})

const hoodSoft = (over = {}) => ({ ...makeSoftZone('soft', { kind: 'all' }, 'hood'), ...over })

describe('a drawstring part and the hood part it hangs from', () => {
  it('a swinging string stays joined to a bouncing hood', () => {
    const gap = joinGap(rig, [hoodSoft()], [makeSoftZone('swing', { kind: 'all' }, 'drawstring')])
    expect(gap).toBeLessThan(0.005)
  })

  it('a soft-cloth string stays joined to a bouncing soft-cloth hood (whole parts on both)', () => {
    const gap = joinGap(rig, [hoodSoft()], [makeSoftZone('soft', { kind: 'all' }, 'jacket')])
    expect(gap).toBeLessThan(0.005)
  })

  it('soft cloth on only the bottom of the string never moves its top away from a still hood', () => {
    const tris = []
    const nTris = rig.stringMesh.geometry.index.count / 3
    for (let t = Math.floor(nTris / 2); t < nTris; t++) tris.push([t, t])
    const zone = { ...makeSoftZone('soft', { kind: 'tris', tris, vertexCount: 0 }, 'hood') }
    const gap = joinGap(rig, null, [zone])
    expect(gap).toBeLessThan(0.002)
  })

  it('a string with "hangs from its top end" keeps its top on a still hood (nothing to hang from, still held)', () => {
    const zone = { ...makeSoftZone('swing', { kind: 'all' }, 'drawstring') }
    expect(zone.hangs).toBe(true)
    const gap = joinGap(rig, null, [zone])
    expect(gap).toBeLessThan(0.001)
  })

  it('a small loose piece (not set to hang) still swings as one rigid piece', () => {
    const zone = { ...makeSoftZone('swing', { kind: 'all' }, 'zip') }
    expect(zone.hangs).toBe(false)
    const gap = joinGap(rig, null, [zone])
    expect(gap).toBeGreaterThan(0.001) // the corners of the top edge turn with the piece
  })

  it('the same holds when hood and strings are ONE part but separate pieces (not joined by shared vertices)', () => {
    scene.remove(rig.root)
    disposeSoftCloth()
    const root = new THREE.Group()
    const b0 = new THREE.Bone()
    const b1 = new THREE.Bone()
    b1.position.set(0, 1, 0)
    b0.add(b1)
    root.add(b0)
    const skeleton = new THREE.Skeleton([b0, b1])
    const hood = skinnedGrid([0, 8], [0, NX - 1], skeleton) // its bottom edge (node row 9) is where the string hangs
    const string = skinnedGrid([9, 31], [10, 13], skeleton)
    const nHood = hood.geo.index.count / 3
    const nString = string.geo.index.count / 3
    const geo = mergeGeometries([hood.geo, string.geo])
    const posAttr = geo.getAttribute('position')
    const hoodVerts = hood.geo.getAttribute('position').count
    for (let v = hoodVerts; v < posAttr.count; v++) posAttr.setZ(v, posAttr.getZ(v) + 0.0005) // 0.5 mm apart: not welded
    const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial())
    root.add(mesh)
    root.updateMatrixWorld(true)
    mesh.bind(skeleton)
    scene.add(root)
    rig = { root }
    const hoodZone = { ...makeSoftZone('soft', { kind: 'tris', tris: [[0, nHood - 1]], vertexCount: 0 }, 'hood'), range: 0.08 }
    const stringZone = makeSoftZone('swing', { kind: 'tris', tris: [[nHood, nHood + nString - 1]], vertexCount: 0 }, 'drawstring')
    syncSoftCloth([{ meshes: [mesh], overrides: { [mesh.uuid]: { softZones: [hoodZone, stringZone] } } }])
    const pairs = []
    for (let c = 10; c <= 14; c++) pairs.push([hood.node.get(9 * 100 + c), hoodVerts + string.node.get(9 * 100 + c)])
    let gap = 0
    for (let f = 0; f < 90; f++) {
      const t = f / 60
      b0.position.set(Math.sin(t * 12) * 0.12, 0.06 * Math.sin(t * 24), Math.sin(t * 12 + 1) * 0.1)
      root.updateMatrixWorld(true)
      stepSoftCloth(1 / 60)
      for (const [h, s] of pairs) gap = Math.max(gap, worldOf(mesh, h).distanceTo(worldOf(mesh, s)))
    }
    expect(gap).toBeLessThan(0.005)
  })

  it('the string keeps its shape (no stretching) while it swings from a bouncing hood', () => {
    const groups = [
      {
        meshes: [rig.hoodMesh, rig.stringMesh],
        overrides: {
          [rig.hoodMesh.uuid]: { softZones: [hoodSoft()] },
          [rig.stringMesh.uuid]: { softZones: [makeSoftZone('swing', { kind: 'all' }, 'drawstring')] },
        },
      },
    ]
    syncSoftCloth(groups)
    const entry = getSoftEntry(rig.stringMesh)
    const idx = rig.stringMesh.geometry.index
    const n = rig.stringMesh.geometry.getAttribute('position').count
    const clean = (i) => {
      const saved = rig.stringMesh.geometry
      rig.stringMesh.geometry = entry.orig
      rig.stringMesh.skeleton.update()
      const p = rig.stringMesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(rig.stringMesh.matrixWorld)
      rig.stringMesh.geometry = saved
      return p
    }
    let stretch = 0
    let swing = 0
    for (let f = 0; f < 90; f++) {
      const t = f / 60
      rig.b0.position.set(Math.sin(t * 12) * 0.12, 0.06 * Math.sin(t * 24), Math.sin(t * 12 + 1) * 0.1)
      rig.root.updateMatrixWorld(true)
      stepSoftCloth(1 / 60)
      if (f % 3) continue
      const c = []
      const d = []
      for (let i = 0; i < n; i++) {
        c.push(clean(i))
        d.push(worldOf(rig.stringMesh, i))
      }
      for (let t3 = 0; t3 < idx.count / 3; t3++) {
        for (let k = 0; k < 3; k++) {
          const a = idx.getX(3 * t3 + k)
          const b = idx.getX(3 * t3 + ((k + 1) % 3))
          const l0 = c[a].distanceTo(c[b])
          if (l0 > 1e-5) stretch = Math.max(stretch, Math.abs(d[a].distanceTo(d[b]) / l0 - 1))
        }
      }
      for (let i = 0; i < n; i++) swing = Math.max(swing, d[i].distanceTo(c[i]))
    }
    expect(swing).toBeGreaterThan(0.05)
    expect(stretch).toBeLessThan(0.12)
  })

  it('finds the hood even when it is a sparse, low-poly part with few vertices near the string', () => {
    // a hood whose vertices are 12 cm apart: the string top sits between them
    scene.remove(rig.root)
    disposeSoftCloth()
    const root = new THREE.Group()
    const b0 = new THREE.Bone()
    const b1 = new THREE.Bone()
    b1.position.set(0, 1, 0)
    b0.add(b1)
    root.add(b0)
    const skeleton = new THREE.Skeleton([b0, b1])
    const hoodGeo = new THREE.PlaneGeometry(1, 0.34, 8, 2).translate(0, 1.33, 0)
    const hn = hoodGeo.getAttribute('position').count
    hoodGeo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(4 * hn).map((_, i) => (i % 4 === 1 ? 1 : 0)), 4))
    const w = new Float32Array(4 * hn)
    for (let i = 0; i < hn; i++) w[4 * i] = 1
    hoodGeo.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4))
    const string = skinnedGrid([9, 31], [10, 13], skeleton)
    const hoodMesh = new THREE.SkinnedMesh(hoodGeo, new THREE.MeshBasicMaterial())
    const stringMesh = new THREE.SkinnedMesh(string.geo, new THREE.MeshBasicMaterial())
    root.add(hoodMesh, stringMesh)
    root.updateMatrixWorld(true)
    hoodMesh.bind(skeleton)
    stringMesh.bind(skeleton)
    scene.add(root)
    rig = { root }
    syncSoftCloth([
      {
        meshes: [hoodMesh, stringMesh],
        overrides: {
          [hoodMesh.uuid]: { softZones: [hoodSoft()] },
          [stringMesh.uuid]: { softZones: [makeSoftZone('swing', { kind: 'all' }, 'drawstring')] },
        },
      },
    ])
    const zr = [...getSoftEntry(stringMesh).zones.values()][0]
    expect(zr.comps[0].hingeLinks.every(Boolean)).toBe(true)
  })

  it('"Pull the join together" closes a gap between the parts, and leaves it alone when off', () => {
    const run = (closeGap) => {
      scene.remove(rig.root)
      disposeSoftCloth()
      rig = makeRig()
      const pos = rig.string.geo.getAttribute('position')
      for (let v = 0; v < pos.count; v++) pos.setY(v, pos.getY(v) - 0.025) // the strings end 2.5 cm short of the hood
      rig.root.updateMatrixWorld(true)
      rig.stringMesh.bind(rig.stringMesh.skeleton)
      return joinGap(rig, [hoodSoft()], [{ ...makeSoftZone('swing', { kind: 'all' }, 'drawstring'), closeGap }])
    }
    expect(run(false)).toBeGreaterThan(0.02) // the gap in the model is kept
    expect(run(true)).toBeLessThan(0.005) // closed
  })
})
