import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { initDangle, setDangleConfig, clearDangle, stepDangleLive } from '../three/dangle.js'

// A pivot bone at (0.3, 1.2, 0) with a chain of bones hanging straight down from it.
function makeRig({ extraBones = false } = {}) {
  const root = new THREE.Group()
  const hips = new THREE.Bone()
  hips.name = 'hips'
  hips.position.set(0.3, 1.2, 0)
  root.add(hips)
  const bones = [hips]
  const chain = []
  let parent = hips
  for (let i = 0; i < 5; i++) {
    const b = new THREE.Bone()
    b.name = 'c' + i
    b.position.set(0, -0.1, 0)
    parent.add(b)
    parent = b
    bones.push(b)
    chain.push(b)
  }
  let leg = null
  if (extraBones) {
    const top = new THREE.Bone()
    top.name = 'legTop'
    top.position.set(0.305, 1.0, 0)
    const end = new THREE.Bone()
    end.name = 'legEnd'
    end.position.set(0, -0.6, 0)
    top.add(end)
    root.add(top)
    bones.push(top, end)
    leg = { top, end }
  }
  root.updateMatrixWorld(true)
  return { root, bones, chain, leg, hips, meshes: [] }
}

const sphere = (r, x, y, z) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 24), new THREE.MeshBasicMaterial())
  m.position.set(x, y, z)
  return m
}
const names = (rig) => rig.chain.map((b) => b.name)
const config = (rig, extra = {}) => [
  { id: 'a', name: 'chain', boneNames: names(rig), type: 'cloth', stiffness: 0.4, gravity: 0.35, damping: 0.55, ...extra },
]
function run(rig, frames, onFrame) {
  for (let f = 0; f < frames; f++) {
    onFrame?.(f)
    rig.root.updateMatrixWorld(true)
    stepDangleLive(1 / 60)
  }
  rig.root.updateMatrixWorld(true)
}
const worldPos = (b) => b.getWorldPosition(new THREE.Vector3())

beforeEach(() => {
  clearDangle(1)
  initDangle({ requestRender: () => {} })
})

describe('dangle mesh collision (uses the cached collision surface, not raycasts)', () => {
  it('keeps the chain out of a body it hangs through, and without collision it goes through', () => {
    const centre = new THREE.Vector3(0.1, 0.8, 0)
    const radius = 0.3
    const minDistance = (rig) => Math.min(...rig.chain.slice(1).map((b) => worldPos(b).distanceTo(centre)))

    const free = makeRig()
    free.meshes = [sphere(radius, centre.x, centre.y, centre.z)]
    free.root.add(free.meshes[0])
    setDangleConfig(1, free, true, config(free, { collideWithMesh: false }))
    run(free, 60)
    expect(minDistance(free)).toBeLessThan(radius - 0.05) // the control really does pass through it

    clearDangle(1)
    const hit = makeRig()
    hit.meshes = [sphere(radius, centre.x, centre.y, centre.z)]
    hit.root.add(hit.meshes[0])
    setDangleConfig(1, hit, true, config(hit, { collideWithMesh: true }))
    run(hit, 60)
    expect(minDistance(hit)).toBeGreaterThan(radius - 0.012)
  })

  it('keeps pushing it out when the body moves into the chain', () => {
    const rig = makeRig()
    const body = sphere(0.3, -0.5, 0.8, 0)
    rig.meshes = [body]
    rig.root.add(body)
    setDangleConfig(1, rig, true, config(rig, { collideWithMesh: true }))
    let worst = Infinity
    run(rig, 90, (f) => {
      body.position.x = -0.5 + (f / 90) * 0.6 // slides in from the left until it overlaps the chain
      if (f > 5) worst = Math.min(worst, ...rig.chain.slice(1).map((b) => worldPos(b).distanceTo(body.position)))
    })
    // one frame of lag is allowed; it must never be deep inside
    expect(worst).toBeGreaterThan(0.3 - 0.04)
  })

  it('does not collide a chain with the mesh it is itself skinned to', () => {
    const build = (collide) => {
      clearDangle(1)
      const rig = makeRig()
      const geometry = new THREE.SphereGeometry(0.04, 16, 12).translate(0.3, 0.9, 0) // its surface is in reach of the chain
      const n = geometry.getAttribute('position').count
      geometry.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? 3 : 0)), 4)) // driven by c2
      geometry.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4))
      const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
      rig.root.add(mesh)
      rig.root.updateMatrixWorld(true)
      mesh.bind(new THREE.Skeleton(rig.bones))
      rig.meshes = [mesh]
      setDangleConfig(1, rig, true, config(rig, { collideWithMesh: collide }))
      run(rig, 60, (f) => {
        rig.hips.position.x = 0.3 + Math.sin(f * 0.2) * 0.1
      })
      return rig.chain.map((b) => b.quaternion.toArray()).flat()
    }
    const off = build(false)
    const on = build(true)
    for (let i = 0; i < off.length; i++) expect(on[i]).toBeCloseTo(off[i], 9)
  })

  it('does not collide a chain with a rigid mesh parented under one of its bones', () => {
    const build = (collide) => {
      clearDangle(1)
      const rig = makeRig()
      const attached = sphere(0.04, 0, 0, 0) // sits on the bone, its surface within reach of the chain
      rig.chain[2].add(attached)
      rig.meshes = [attached]
      rig.root.updateMatrixWorld(true)
      setDangleConfig(1, rig, true, config(rig, { collideWithMesh: collide }))
      run(rig, 60, (f) => {
        rig.hips.position.x = 0.3 + Math.sin(f * 0.2) * 0.1
      })
      return rig.chain.map((b) => b.quaternion.toArray()).flat()
    }
    const off = build(false)
    const on = build(true)
    for (let i = 0; i < off.length; i++) expect(on[i]).toBeCloseTo(off[i], 9)
  })

  it('stops colliding with a mesh that is hidden', () => {
    const centre = new THREE.Vector3(0.1, 0.8, 0)
    const rig = makeRig()
    const body = sphere(0.3, centre.x, centre.y, centre.z)
    rig.meshes = [body]
    rig.root.add(body)
    setDangleConfig(1, rig, true, config(rig, { collideWithMesh: true }))
    run(rig, 30)
    body.visible = false
    run(rig, 60) // it is noticed within a few frames
    const closest = Math.min(...rig.chain.slice(1).map((b) => worldPos(b).distanceTo(centre)))
    expect(closest).toBeLessThan(0.3 - 0.05)
  })
})

describe('dangle bone collision', () => {
  it('keeps the chain off another bone, and without collision it lies on it', () => {
    const distToLeg = (rig) => {
      const a = worldPos(rig.leg.top)
      const b = worldPos(rig.leg.end)
      const line = new THREE.Line3(a, b)
      const out = new THREE.Vector3()
      return Math.min(...rig.chain.slice(1, 4).map((bone) => line.closestPointToPoint(worldPos(bone), true, out).distanceTo(worldPos(bone))))
    }
    const free = makeRig({ extraBones: true })
    setDangleConfig(1, free, true, config(free, { collideWithBones: false }))
    run(free, 60)
    const radius = 0.1 * 0.12
    expect(distToLeg(free)).toBeLessThan(radius * 0.7)

    clearDangle(1)
    const hit = makeRig({ extraBones: true })
    setDangleConfig(1, hit, true, config(hit, { collideWithBones: true }))
    run(hit, 60)
    expect(distToLeg(hit)).toBeGreaterThan(radius * 0.95)
  })
})

describe('dangle motion is unchanged when collision is off', () => {
  it('matches the values the pre-optimisation implementation produced', () => {
    const root = new THREE.Group()
    const bones = []
    const mk = (n, parent, x, y, z) => {
      const b = new THREE.Bone()
      b.name = n
      b.position.set(x, y, z)
      ;(parent || root).add(b)
      bones.push(b)
      return b
    }
    const hips = mk('hips', null, 0, 1, 0)
    const spine = mk('spine', hips, 0, 0.2, 0)
    const chest = mk('chest', spine, 0, 0.2, 0)
    const cape = []
    let p = chest
    for (let i = 0; i < 6; i++) {
      p = mk('c' + i, p, 0, -0.07, -0.05)
      cape.push('c' + i)
    }
    const hair = []
    let q = chest
    for (let i = 0; i < 4; i++) {
      q = mk('h' + i, q, 0.05, 0.06, 0)
      hair.push('h' + i)
    }
    root.updateMatrixWorld(true)
    setDangleConfig(1, { root, bones, meshes: [] }, true, [
      { id: 'a', name: 'cape', boneNames: cape, type: 'cloth', stiffness: 0.4, gravity: 0.35, damping: 0.55 },
      { id: 'b', name: 'hair', boneNames: hair, type: 'dangle', stiffness: 0.15, gravity: 1, damping: 0.8 },
    ])
    let sample
    for (let f = 0; f <= 54; f++) {
      hips.position.x = Math.sin(f * 0.2) * 0.3
      hips.position.z = Math.cos(f * 0.13) * 0.2
      spine.quaternion.setFromEuler(new THREE.Euler(0, Math.sin(f * 0.25) * 0.8, Math.sin(f * 0.1) * 0.2))
      root.updateMatrixWorld(true)
      stepDangleLive(1 / 60)
      if (f === 54) sample = ['c0', 'c1', 'c2'].flatMap((n) => bones.find((b) => b.name === n).quaternion.toArray())
    }
    const golden = [-0.007004558, 0.011832723, -0.016565813, 0.999768221, -0.00272728, 0.008281224, -0.011593713, 0.999894779, 0.004723901, 0.010104644, -0.014146502, 0.999837716]
    golden.forEach((v, i) => expect(sample[i]).toBeCloseTo(v, 7))
  })
})

describe('dangle collision performance', () => {
  it('a 50,000-triangle skinned body does not slow the frame down', () => {
    const root = new THREE.Group()
    const bones = []
    let parent = null
    for (let i = 0; i < 40; i++) {
      const b = new THREE.Bone()
      b.name = 's' + i
      b.position.set(0, i ? 0.045 : 0, 0)
      if (parent) parent.add(b)
      else root.add(b)
      parent = b
      bones.push(b)
    }
    const cape = []
    let cp = bones[30]
    for (let i = 0; i < 10; i++) {
      const b = new THREE.Bone()
      b.name = 'cp' + i
      b.position.set(0, -0.05, i ? 0 : -0.14)
      cp.add(b)
      cp = b
      bones.push(b)
      cape.push(b.name)
    }
    const geometry = new THREE.CylinderGeometry(0.12, 0.12, 1.8, 120, 210, false).translate(0, 0.9, 0)
    const n = geometry.getAttribute('position').count
    const si = new Uint16Array(n * 4)
    const sw = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      const f = Math.min(38.999, Math.max(0, geometry.getAttribute('position').getY(i) / 0.045))
      const k = Math.floor(f)
      si[4 * i] = k
      si[4 * i + 1] = k + 1
      sw[4 * i] = 1 - (f - k)
      sw[4 * i + 1] = f - k
    }
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4))
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4))
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
    root.add(mesh)
    root.updateMatrixWorld(true)
    mesh.bind(new THREE.Skeleton(bones))
    expect(geometry.index.count / 3).toBeGreaterThan(50000)

    setDangleConfig(1, { root, bones, meshes: [mesh] }, true, [
      { id: 'a', name: 'cape', boneNames: cape, type: 'cloth', collideWithMesh: true, collideWithBones: true },
    ])
    for (let f = 0; f < 5; f++) {
      root.updateMatrixWorld(true)
      stepDangleLive(1 / 60)
    }
    let total = 0
    const frames = 30
    for (let f = 0; f < frames; f++) {
      bones[0].position.x = Math.sin(f * 0.3) * 0.05
      root.updateMatrixWorld(true)
      const t0 = performance.now()
      stepDangleLive(1 / 60)
      total += performance.now() - t0
    }
    // Raycasting this body took over two seconds a frame. The cached surface takes a few ms; the limit
    // is far looser than that so a slow machine does not make it flaky, while still catching a return
    // to per-frame work on the whole mesh.
    expect(total / frames).toBeLessThan(60)
  }, 30000)
})
