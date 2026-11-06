import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { initSoftCloth, disposeSoftCloth, syncSoftCloth, stepSoftCloth, getSoftEntry, makeSoftZone, setSoftOverlay } from '../three/softcloth.js'

// Swing physics: a piece hung from a hinge must react to the body's motion (inertia), settle when it
// stops, and never stretch the cloth it is joined to.

let scene
beforeAll(() => {
  scene = new THREE.Scene()
  initSoftCloth({ requestRender: () => {} })
})

function coat(noSlit = false) {
  const root = new THREE.Group()
  const nx = 24, ny = 32, W = 1, H = 1.2
  const pos = [], idx = [], si = [], sw = []
  const node = new Map()
  const addV = (x, y, z = 0) => { pos.push(x, y, z); const t = Math.min(1, Math.max(0, (y - 0.3) / 1.2)); si.push(0, 1, 0, 0); sw.push(1 - t, t, 0, 0); return pos.length / 3 - 1 }
  const X = (c) => -W / 2 + (c / nx) * W
  const Y = (r) => 1.5 - (r / ny) * H
  const sheet = (r, c) => { const k = r * 100 + c; if (!node.has(k)) node.set(k, addV(X(c), Y(r))); return node.get(k) }
  const inStrap = (r, c) => r >= 9 && r <= 31 && c >= 10 && c <= 13
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
    if (inStrap(r, c)) continue
    const a = sheet(r, c), b = sheet(r, c + 1), d = sheet(r + 1, c), e = sheet(r + 1, c + 1)
    idx.push(a, d, b, b, d, e)
  }
  const first = idx.length / 3
  const sn = new Map()
  const strapNode = (r, c) => {
    if (r === 9 || noSlit) return sheet(r, c)
    const k = r * 100 + c
    if (!sn.has(k)) sn.set(k, addV(X(c) + (c === 10 ? -0.0007 : c === 14 ? 0.0007 : 0), Y(r)))
    return sn.get(k)
  }
  for (let r = 9; r <= 31; r++) for (let c = 10; c <= 13; c++) {
    const a = strapNode(r, c), b = strapNode(r, c + 1), d = strapNode(r + 1, c), e = strapNode(r + 1, c + 1)
    idx.push(a, d, b, b, d, e)
  }
  const last = idx.length / 3 - 1
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(si), 4))
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(sw), 4))
  geo.setIndex(idx)
  const b0 = new THREE.Bone(); const b1 = new THREE.Bone(); b1.position.set(0, 1, 0); b0.add(b1); root.add(b0)
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial())
  root.add(mesh); root.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([b0, b1]))
  return { root, mesh, b0, tris: [[first, last]], idx }
}

function worldOf(mesh, geometry, i, out) {
  const saved = mesh.geometry
  mesh.geometry = geometry
  mesh.skeleton.update()
  mesh.getVertexPosition(i, out)
  out.applyMatrix4(mesh.matrixWorld)
  mesh.geometry = saved
  return out
}


// a small tab hanging at the chest of a character-sized body (so gravity and distances have a real scale)
function makeTab() {
  const root = new THREE.Group()
  const bone = new THREE.Bone()
  root.add(bone)
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.7, 0.3), new THREE.MeshBasicMaterial())
  body.position.y = 0.85
  root.add(body)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.02, 1.3, 0.16, 0.02, 1.3, 0.16, -0.02, 1.18, 0.16, 0.02, 1.18, 0.16]), 3))
  geo.setIndex([0, 2, 1, 1, 2, 3])
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(16), 4))
  const sw = new Float32Array(16)
  for (let i = 0; i < 4; i++) sw[4 * i] = 1
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial())
  root.add(mesh)
  root.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton([bone]))
  scene.add(root)
  return { root, mesh, bone }
}

const bottomOffset = (rig, entry) => worldOf(rig.mesh, rig.mesh.geometry, 2, new THREE.Vector3()).distanceTo(worldOf(rig.mesh, entry.orig, 2, new THREE.Vector3()))
function runTab(rig, frames, motion, opts = {}) {
  const zone = { ...makeSoftZone('swing', { kind: 'all' }, 'zip'), ...opts }
  syncSoftCloth([{ meshes: [rig.mesh], overrides: { [rig.mesh.uuid]: { softZones: [zone] } } }])
  const entry = getSoftEntry(rig.mesh)
  let peak = 0
  for (let f = 0; f < frames; f++) {
    motion(f)
    rig.root.updateMatrixWorld(true)
    stepSoftCloth(1 / 60)
    peak = Math.max(peak, bottomOffset(rig, entry))
  }
  return { entry, peak, last: bottomOffset(rig, entry) }
}

let rig
beforeEach(() => {
  disposeSoftCloth()
  if (rig) scene.remove(rig.root)
  rig = null
})

describe('swing physics: inertia', () => {
  it('a hanging piece is thrown about when the body speeds up and stops', () => {
    rig = makeTab()
    // the body lurches sideways 0.3 m in a quarter of a second, then stops dead
    const { peak } = runTab(rig, 90, (f) => {
      rig.root.position.x = f < 15 ? (0.3 * f) / 15 : 0.3
    })
    expect(peak).toBeGreaterThan(0.02) // a 12 cm tab: several centimetres of swing
  })

  it('"Body reaction" scales that response, and 0 leaves only gravity and the pose', () => {
    const lurch = (reaction) => {
      disposeSoftCloth()
      if (rig) scene.remove(rig.root)
      rig = makeTab()
      return runTab(rig, 60, (f) => (rig.root.position.x = f < 15 ? (0.3 * f) / 15 : 0.3), { reaction }).peak
    }
    const none = lurch(0)
    const normal = lurch(1)
    const lots = lurch(2)
    expect(none).toBeLessThan(0.002)
    expect(normal).toBeGreaterThan(none * 5)
    expect(lots).toBeGreaterThan(normal)
  })

  it('steady travel at a constant speed does not swing it, and a standing character is left alone', () => {
    rig = makeTab()
    const moving = runTab(rig, 90, (f) => (rig.root.position.x = f * 0.02))
    // a one-off start-up kick is fine, but it must have settled again
    expect(moving.last).toBeLessThan(0.01)
    disposeSoftCloth()
    scene.remove(rig.root)
    rig = makeTab()
    expect(runTab(rig, 120, () => {}).peak).toBeLessThan(1e-3)
  })

  it('settles back to the pose after the body stops', () => {
    rig = makeTab()
    const r = runTab(rig, 240, (f) => (rig.root.position.x = f < 15 ? (0.3 * f) / 15 : 0.3))
    expect(r.peak).toBeGreaterThan(0.02)
    expect(r.last).toBeLessThan(0.004)
  })

  it('a cut or teleport is not treated as motion', () => {
    rig = makeTab()
    const { peak } = runTab(rig, 60, (f) => {
      if (f === 20) rig.root.position.set(40, 0, -25)
    })
    expect(peak).toBeLessThan(0.005)
  })
})

describe('swing physics: a piece joined to the mesh', () => {
  function stretchAndSwing(noSlit, motion, opts = {}) {
    rig = coat(noSlit)
    scene.add(rig.root)
    const zone = { ...makeSoftZone('swing', { kind: 'tris', tris: rig.tris, vertexCount: 0 }, 'tassel'), ...opts }
    syncSoftCloth([{ meshes: [rig.mesh], overrides: { [rig.mesh.uuid]: { softZones: [zone] } } }])
    const entry = getSoftEntry(rig.mesh)
    const n = rig.mesh.geometry.getAttribute('position').count
    const strap = new Set()
    for (let t = rig.tris[0][0]; t <= rig.tris[0][1]; t++) for (let k = 0; k < 3; k++) strap.add(rig.idx[3 * t + k])
    const edges = []
    for (let t = 0; t < rig.idx.length / 3; t++) for (let k = 0; k < 3; k++) edges.push([rig.idx[3 * t + k], rig.idx[3 * t + ((k + 1) % 3)]])
    let stretch = 0
    let swing = 0
    for (let f = 0; f < 96; f++) {
      motion(f / 60)
      rig.root.updateMatrixWorld(true)
      stepSoftCloth(1 / 60)
      if (f % 4) continue
      const clean = []
      const drawn = []
      for (let i = 0; i < n; i++) {
        clean.push(worldOf(rig.mesh, entry.orig, i, new THREE.Vector3()))
        drawn.push(worldOf(rig.mesh, rig.mesh.geometry, i, new THREE.Vector3()))
      }
      for (const [i, j] of edges) {
        const l0 = clean[i].distanceTo(clean[j])
        if (l0 > 1e-5) stretch = Math.max(stretch, Math.abs(drawn[i].distanceTo(drawn[j]) / l0 - 1))
      }
      for (const i of strap) swing = Math.max(swing, drawn[i].distanceTo(clean[i]))
    }
    return { stretch, swing }
  }
  const walkForward = (t) => rig.b0.position.set(0, 0.05 * Math.sin(t * 25), Math.sin(t * 12.5 + 1.2) * 0.12)
  const walkAll = (t) => {
    walkForward(t)
    rig.b0.position.x = Math.sin(t * 12.5) * 0.15
    rig.b0.rotation.y = Math.sin(t * 6) * 0.3
  }

  it('swings a long way out of its surface when the body moves, without stretching the cloth', () => {
    const r = stretchAndSwing(false, walkForward)
    expect(r.swing).toBeGreaterThan(0.15)
    expect(r.stretch).toBeLessThan(0.06)
  })

  it('swinging sideways inside its own surface is limited so it cannot shear', () => {
    const r = stretchAndSwing(false, walkAll)
    expect(r.swing).toBeGreaterThan(0.15)
    expect(r.stretch).toBeLessThan(0.12)
  })

  it('a patch joined along its sides moves less rather than tearing its join', () => {
    const r = stretchAndSwing(true, walkAll)
    expect(r.stretch).toBeLessThan(0.1)
  })
})

describe('swing pieces hang from the cloth as it is drawn', () => {
  // a bouncy soft hood-like area (the whole sheet) with a drawstring hanging from it
  function hoodAndString(motion, stringOpts = {}, hoodOpts = {}) {
    rig = coat(false)
    scene.add(rig.root)
    const sheetTris = [[0, rig.tris[0][0] - 1]]
    const hood = { ...makeSoftZone('soft', { kind: 'tris', tris: sheetTris, vertexCount: 0 }, 'hood'), ...hoodOpts }
    const string = { ...makeSoftZone('swing', { kind: 'tris', tris: rig.tris, vertexCount: 0 }, 'drawstring'), ...stringOpts }
    syncSoftCloth([{ meshes: [rig.mesh], overrides: { [rig.mesh.uuid]: { softZones: [string, hood] } } }]) // order must not matter
    const entry = getSoftEntry(rig.mesh)
    const pos = entry.orig.getAttribute('position')
    const hingeY = 1.5 - (9 * 1.2) / 32
    const hinge = []
    const held = []
    const strap = new Set()
    for (let t = rig.tris[0][0]; t <= rig.tris[0][1]; t++) for (let k = 0; k < 3; k++) strap.add(rig.idx[3 * t + k])
    for (const i of strap) {
      const y = pos.getY(i)
      if (Math.abs(y - hingeY) < 1e-4) hinge.push(i)
      else if (y > hingeY - 0.1) held.push(i)
    }
    const hingeSet = new Set(hinge)
    const edges = []
    for (let t = 0; t < rig.idx.length / 3; t++) for (let k = 0; k < 3; k++) edges.push([rig.idx[3 * t + k], rig.idx[3 * t + ((k + 1) % 3)]])
    const n = pos.count
    const off = (i) => worldOf(rig.mesh, rig.mesh.geometry, i, new THREE.Vector3()).sub(worldOf(rig.mesh, entry.orig, i, new THREE.Vector3()))
    let stretch = 0
    let heldGap = 0
    let hoodMove = 0
    let swing = 0
    for (let f = 0; f < 90; f++) {
      motion(f / 60)
      rig.root.updateMatrixWorld(true)
      stepSoftCloth(1 / 60)
      if (f % 3) continue
      const clean = []
      const drawn = []
      for (let i = 0; i < n; i++) {
        clean.push(worldOf(rig.mesh, entry.orig, i, new THREE.Vector3()))
        drawn.push(worldOf(rig.mesh, rig.mesh.geometry, i, new THREE.Vector3()))
      }
      for (const [i, j] of edges) {
        // the string itself and the join row below the hinge (the hood's own deformation is the hood's)
        if (!(strap.has(i) && !hingeSet.has(i)) && !(strap.has(j) && !hingeSet.has(j))) continue
        const l0 = clean[i].distanceTo(clean[j])
        if (l0 > 1e-5) stretch = Math.max(stretch, Math.abs(drawn[i].distanceTo(drawn[j]) / l0 - 1))
      }
      const hingeOff = new THREE.Vector3()
      for (const i of hinge) hingeOff.add(drawn[i].clone().sub(clean[i]))
      hingeOff.multiplyScalar(1 / hinge.length)
      hoodMove = Math.max(hoodMove, hingeOff.length())
      for (const i of held) heldGap = Math.max(heldGap, drawn[i].clone().sub(clean[i]).distanceTo(hingeOff))
      for (const i of strap) swing = Math.max(swing, drawn[i].distanceTo(clean[i]))
    }
    void off
    return { stretch, heldGap, hoodMove, swing }
  }
  const bob = (t) => rig.b0.position.set(0, 0.07 * Math.sin(t * 20), 0.1 * Math.sin(t * 10))

  it('the rigid top moves exactly with the hood it is attached to, with no lag or stretch', () => {
    const r = hoodAndString(bob, { holdTop: 0.15 }, { range: 0.05, gravity: 0.15 })
    expect(r.hoodMove).toBeGreaterThan(0.003) // the hood really is moving away from the pose
    expect(r.heldGap).toBeLessThan(0.002)
    expect(r.stretch).toBeLessThan(0.1)
    expect(r.swing).toBeGreaterThan(0.1)
  })

  it('"Rigid top" is a setting: a longer rigid top holds more of the string to the hood', () => {
    const short = hoodAndString(bob, { holdTop: 0 }, { range: 0.05, gravity: 0.15 })
    scene.remove(rig.root)
    disposeSoftCloth()
    const long = hoodAndString(bob, { holdTop: 0.3 }, { range: 0.05, gravity: 0.15 })
    expect(long.heldGap).toBeLessThanOrEqual(short.heldGap + 1e-6)
    expect(long.heldGap).toBeLessThan(0.002)
  })
})

describe('soft cloth bounce', () => {
  function verticalSwing(bounce) {
    disposeSoftCloth()
    if (rig) scene.remove(rig.root)
    rig = coat(false)
    scene.add(rig.root)
    const zone = { ...makeSoftZone('soft', { kind: 'all' }, 'hood'), bounce }
    syncSoftCloth([{ meshes: [rig.mesh], overrides: { [rig.mesh.uuid]: { softZones: [zone] } } }])
    const entry = getSoftEntry(rig.mesh)
    const bottom = 800
    let peak = 0
    for (let f = 0; f < 120; f++) {
      rig.b0.position.y = 0.05 * Math.sin(f * 0.35)
      rig.root.updateMatrixWorld(true)
      stepSoftCloth(1 / 60)
      const dy = worldOf(rig.mesh, rig.mesh.geometry, bottom, new THREE.Vector3()).y - worldOf(rig.mesh, entry.orig, bottom, new THREE.Vector3()).y
      peak = Math.max(peak, Math.abs(dy))
    }
    return peak
  }
  it('more bounce means more up-and-down movement, less holds it firmly', () => {
    const firm = verticalSwing(0.2)
    const normal = verticalSwing(1)
    const loose = verticalSwing(2)
    expect(loose).toBeGreaterThan(normal)
    expect(normal).toBeGreaterThan(firm)
  })
})

describe('area highlight redraws', () => {
  it('asks for a new frame when the highlight is shown, changed AND removed (the viewport draws on demand)', () => {
    let frames = 0
    initSoftCloth({ requestRender: () => frames++ })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 2, 2), new THREE.MeshBasicMaterial())
    setSoftOverlay(mesh, [0, 1, 2])
    expect(frames).toBe(1)
    setSoftOverlay(mesh, [0])
    expect(frames).toBe(2)
    setSoftOverlay(mesh, null)
    expect(frames).toBe(3)
    setSoftOverlay(mesh, null)
    expect(frames).toBe(3)
    initSoftCloth({ requestRender: () => {} })
  })
})
