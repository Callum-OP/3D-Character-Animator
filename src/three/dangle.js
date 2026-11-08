import { useStore } from '../store.js'
import { pushSceneHistory } from './sceneHistory.js'
import { getHistorySequence, getHistoryEpoch } from './undoHistory.js'
import * as THREE from 'three'
import { CollisionProxy } from './collisionProxy.js'
import { applyWind } from './wind.js'

// ---------------------------------------------------------------------------
// Dangle bones (secondary-motion / "jiggle" physics)
//
// Lets a user mark a set of existing bones (hair strands, a ponytail, a cape
// tassel, dangly earrings, a chain accessory...) so they swing under gravity
// and inertia on top of whatever the mixer/pose is doing, instead of rigidly
// following the rig.
//
// No physics library: one lightweight verlet particle per dangled bone,
// representing where that bone's OWN rotation aims (its child bone, or a
// synthetic tip for a leaf bone). Each frame:
//   1. Read the bone's live pivot (its own current world position — driven
//      entirely by its actual parent, exactly as normal FK) and combine it
//      with a frozen rest-local rotation to get a "target" tip position —
//      i.e. where the tip would be with zero physics, under TODAY's parent
//      motion. This is what the spring pulls back toward, and it's why the
//      whole chain reacts to the body's live animated movement (a head bob,
//      a running stride) rather than some pose captured once at setup.
//   2. Integrate a free verlet particle (gravity, damping, spring-to-target),
//      then re-project it to the fixed rest distance from the pivot — bones
//      don't stretch.
//   3. Swing the bone's rotation from the target direction onto the physics
//      direction (same "shortest arc, applied on top of today's pose" trick
//      the ragdoll baker uses) and write it back as the bone's local quaternion.
//
// Parent bones are always processed before their dangled children (order is
// built once per chain), so a child's pivot already reflects its parent's
// physics this same frame — that's what lets motion propagate down a chain
// (root of a ponytail swings the whole tail, not just its own segment).
//
// This runs LIVE, every rendered frame during playback (see stepDangleLive),
// after the animation mixer and before the draw call — same slot cloth's
// stepClothLive occupies. It never touches bone.position, only bone.quaternion,
// so it composes safely with posing, IK, ragdoll and everything else that
// only reads/writes rotations.
// ---------------------------------------------------------------------------

const GRAVITY_MS2 = 9.8
const SUBSTEPS = 4
const MAX_DT = 1 / 30 // clamp a big frame hitch so the chain can't fling

// Per-character runtime. Keyed by character id (same ids scene.js's
// `characters` map uses), so each character's chains simulate independently
// and survive that character not being the currently-active one in the UI.
const runtimes = new Map() // id -> { model, chains: Map<chainId, RuntimeChain> }

let dg = { requestRender: null }

export function initDangle(refs) {
  dg.requestRender = refs.requestRender || null
}

function defaultConfig() {
  return { stiffness: 0.15, gravity: 1, damping: 0.8 }
}

function defaultsForType(type) {
  return type === 'cloth'
    ? { stiffness: 0.4, gravity: 0.35, damping: 0.55 }
    : defaultConfig()
}

// Build (or rebuild) the physics runtime for one character from its saved/
// edited chain configs. `chains` is the store's plain-data array:
// [{ id, name, boneNames, type, stiffness, gravity, damping, collideWithBones, collideWithMesh, collideWithSelf }]. Safe to call
// repeatedly (e.g. every store update) — it only rebuilds a chain when its
// bone list actually changed, and preserves in-flight particle motion for
// chains that didn't change so tweaking a slider mid-swing doesn't pop the pose.
export function setDangleConfig(id, model, enabled, chains) {
  if (!id || !model) return
  let rt = runtimes.get(id)
  if (!enabled || !chains || !chains.length) {
    if (rt) rt.chains.clear()
    if (rt) rt.enabled = !!enabled
    else runtimes.set(id, { model, enabled: !!enabled, chains: new Map() })
    return
  }
  if (!rt) {
    rt = { model, enabled: true, chains: new Map() }
    runtimes.set(id, rt)
  }
  rt.model = model
  rt.enabled = true

  const seen = new Set()
  const chainsBefore = [...rt.chains.keys()].join('|')
  for (const cfg of chains) {
    if (!cfg || !cfg.id || !cfg.boneNames || !cfg.boneNames.length) continue
    seen.add(cfg.id)
    const existing = rt.chains.get(cfg.id)
    const sameBones =
      existing && existing.boneNamesKey === cfg.boneNames.join('|')
    if (sameBones) {
      existing.params = paramsFrom(cfg)
      continue
    }
    const built = buildChain(model, cfg)
    if (built) rt.chains.set(cfg.id, built)
    else rt.chains.delete(cfg.id)
  }
  for (const existingId of [...rt.chains.keys()]) {
    if (!seen.has(existingId)) rt.chains.delete(existingId)
  }
  // Which bones are "moving cloth" decides which mesh faces and bones count as the body to hit.
  if ([...rt.chains.keys()].join('|') !== chainsBefore || rt.chains.size) {
    const key = [...rt.chains.values()].map((c) => c.boneNamesKey).join('#')
    if (key !== rt.chainKey) {
      rt.chainKey = key
      rt.version = (rt.version || 0) + 1
    }
  }
}

function paramsFrom(cfg) {
  const type = cfg.type === 'cloth' ? 'cloth' : 'dangle'
  const d = defaultsForType(type)
  return {
    type,
    stiffness: THREE.MathUtils.clamp(cfg.stiffness ?? d.stiffness, 0, 1),
    gravity: THREE.MathUtils.clamp(cfg.gravity ?? d.gravity, 0, 3),
    damping: THREE.MathUtils.clamp(cfg.damping ?? d.damping, 0, 1),
    collideWithBones: cfg.collideWithBones === true,
    collideWithMesh: cfg.collideWithMesh === true,
    collideWithSelf: cfg.collideWithSelf === true,
    // Extra feel settings (same ideas as the mesh swing zones). The defaults reproduce the old behaviour.
    bounce: THREE.MathUtils.clamp(cfg.bounce ?? 1, 0, 2.5), // up/down looseness
    reaction: THREE.MathUtils.clamp(cfg.reaction ?? 0, 0, 1), // how much body movement is NOT carried along
    swingLimit: THREE.MathUtils.clamp(cfg.swingLimit ?? 180, 5, 180), // furthest swing, in degrees
    holdTop: THREE.MathUtils.clamp(cfg.holdTop ?? 0, 0, 0.8), // share of the chain (from the top) kept rigid
  }
}

// Turn a flat set of bone names into a parent-before-child forest of runtime
// nodes. A bone whose parent isn't ALSO in the set becomes a chain root
// (its pivot comes straight from that external, non-dangled parent bone —
// typically the head, shoulder, or wherever the accessory attaches). A leaf
// (no chain-child) gets a synthetic tip reusing its own rest offset, so every
// selected bone actually swings, including strand tips.
function buildChain(model, cfg) {
  const byName = new Map()
  for (const b of model.bones || []) byName.set(b.name, b)

  const boneSet = new Set(cfg.boneNames)
  const nodesByBone = new Map()
  for (const name of cfg.boneNames) {
    const bone = byName.get(name)
    if (!bone) continue
    nodesByBone.set(bone, { bone, name, children: [], physPos: null, physPrev: null, lastPivot: null })
  }
  if (!nodesByBone.size) return null

  // Wire up parent/child links within the selected set.
  const roots = []
  for (const node of nodesByBone.values()) {
    const parentBone = node.bone.parent && node.bone.parent.isBone ? node.bone.parent : null
    if (parentBone && nodesByBone.has(parentBone)) {
      nodesByBone.get(parentBone).children.push(node)
      node.parentNode = nodesByBone.get(parentBone)
    } else {
      node.parentNode = null
      node.parentBone = parentBone // external, undangled anchor (may be null for a root bone)
      roots.push(node)
    }
  }

  // Flatten to a parent-before-child processing order (BFS from each root).
  const order = []
  const queue = [...roots]
  while (queue.length) {
    const n = queue.shift()
    order.push(n)
    for (const c of n.children) queue.push(c)
  }
  if (!order.length) return null

  // How deep each bone sits in its chain (0 = the top), for the "rigid top" setting.
  let maxDepth = 0
  for (const node of order) {
    node.depth = node.parentNode ? node.parentNode.depth + 1 : 0
    if (node.depth > maxDepth) maxDepth = node.depth
  }
  for (const node of order) node.depthFrac = maxDepth > 0 ? node.depth / maxDepth : 1

  // Constant per-node data: the local offset toward this bone's own tip
  // (its first dangled child, or a synthetic tip reusing its own rest
  // offset for a leaf), and the frozen rest local rotation that physics
  // springs back toward.
  for (const node of order) {
    const tipChild = node.children[0]
    node.tipLocalOffset = (tipChild ? tipChild.bone.position : node.bone.position).clone()
    if (node.tipLocalOffset.lengthSq() < 1e-10) node.tipLocalOffset.set(0, -0.02, 0) // degenerate rig fallback
    node.tipLength = node.tipLocalOffset.length()
    node.restLocalQuat = node.bone.quaternion.clone()

    // Seed the physics particle at the current (rest) tip position so a
    // freshly-created or freshly-toggled chain doesn't pop on its first frame.
    const pivot = node.bone.getWorldPosition(new THREE.Vector3())
    const parentWorldQuat = node.bone.getWorldQuaternion(new THREE.Quaternion())
    const tip = pivot.clone().add(node.tipLocalOffset.clone().applyQuaternion(parentWorldQuat))
    node.physPos = tip
    node.physPrev = tip.clone()
    node.lastPivot = pivot
  }

  return {
    boneNamesKey: cfg.boneNames.join('|'),
    boneSet: new Set(order.map((node) => node.bone)),
    order,
    params: paramsFrom(cfg),
  }
}

// Snap every particle in a chain (or every chain of a character) back onto
// the current pose, killing any in-flight swing. Useful right after loading
// a project (so chains don't lurch into place from wherever they were saved)
// or after a hard pose change (teleport, reset pose).
export function resetDangle(id, chainId) {
  const rt = runtimes.get(id)
  if (!rt) return
  const targets = chainId ? [rt.chains.get(chainId)].filter(Boolean) : [...rt.chains.values()]
  for (const chain of targets) {
    for (const node of chain.order) {
      const pivot = node.bone.getWorldPosition(new THREE.Vector3())
      const parentWorldQuat = node.bone.getWorldQuaternion(new THREE.Quaternion())
      node.lastPivot.copy(pivot)
      const tip = pivot.add(node.tipLocalOffset.clone().applyQuaternion(parentWorldQuat))
      node.physPos.copy(tip)
      node.physPrev.copy(tip)
    }
  }
}

// Restore the chain's authored pose and discard any live physics offset.
// Used after stopping playback, when the animation mixer has returned the rig
// to its non-simulated pose.
export function resetDanglePose(id) {
  const rt = runtimes.get(id)
  if (!rt) return
  for (const chain of rt.chains.values()) {
    for (const node of chain.order) {
      node.bone.quaternion.copy(node.restLocalQuat)
      node.bone.updateMatrix()
    }
  }
  rt.model.root?.updateMatrixWorld(true)
  resetDangle(id)
}

export function clearDangle(id) {
  const rt = runtimes.get(id)
  if (rt) for (const col of Object.values(rt.cols || {})) col.proxy?.dispose()
  runtimes.delete(id)
}

// --- scratch (avoid per-frame allocation) -----------------------------------
const _pivot = new THREE.Vector3()
const _parentWQ = new THREE.Quaternion()
const _targetWQ = new THREE.Quaternion()
const _targetTip = new THREE.Vector3()
const _vel = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _wind = new THREE.Vector3()
const _targetDir = new THREE.Vector3()
const _physDir = new THREE.Vector3()
const _qSwing = new THREE.Quaternion()
const _finalWQ = new THREE.Quaternion()
const _localQ = new THREE.Quaternion()
const _segmentPoint = new THREE.Vector3()
const _decPos = new THREE.Vector3()
const _decScale = new THREE.Vector3()
const _identity = new THREE.Matrix4()
const _identQ = new THREE.Quaternion()
const _axis = new THREE.Vector3()
const _qLimit = new THREE.Quaternion()
const ALL_OWN = 1 // a whole mesh that hangs off a dangling bone

// ---------------------------------------------------------------------------
// Collision
//
// Mesh collision used to raycast the real skinned meshes, which re-skins every vertex of the whole
// mesh for every ray (per bone, per sub-step) and ran at a frame every few seconds on a normal
// character. Now each character keeps ONE CollisionProxy: a decimated copy of the body that is
// re-posed (a couple of thousand vertices, not the whole mesh) and re-indexed once per frame, and
// every bone then does a few cheap nearest-triangle lookups against it.
//
// The push-out goes along the surface's outward normal: the triangle winding when it can be trusted
// (a normal body), otherwise the side the animated pose is on. Faces driven by the dangling bones
// are kept out of the same-mesh proxy to avoid a strand colliding with itself.
// ---------------------------------------------------------------------------

const COLLIDER_TRIANGLES = 2500
const COLLIDER_RECHECK_FRAMES = 15 // how often to notice a mesh being hidden or shown

function visibleInHierarchy(object) {
  for (let current = object; current; current = current.parent) {
    if (!current.visible) return false
  }
  return true
}

function danglingBoneSet(rt) {
  const set = new Set()
  for (const chain of rt.chains.values()) for (const bone of chain.boneSet) set.add(bone)
  return set
}

// Per vertex: is it driven mostly by a dangling bone? (ALL_OWN for a rigid mesh parented under one.)
function ownVertexFlags(mesh, boneSet) {
  if (mesh.isSkinnedMesh) {
    const geometry = mesh.geometry
    const skinIndex = geometry.getAttribute('skinIndex')
    const skinWeight = geometry.getAttribute('skinWeight')
    if (!skinIndex || !skinWeight || !mesh.skeleton) return null
    const bones = mesh.skeleton.bones
    const flags = new Uint8Array(skinIndex.count)
    let any = false
    for (let v = 0; v < flags.length; v++) {
      let best = 0
      let bestWeight = -1
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(v, k)
        if (w > bestWeight) {
          bestWeight = w
          best = k
        }
      }
      if (bestWeight > 0 && boneSet.has(bones[skinIndex.getComponent(v, best)])) {
        flags[v] = 1
        any = true
      }
    }
    return any ? flags : null
  }
  for (let parent = mesh.parent; parent; parent = parent.parent) {
    if (parent.isBone && boneSet.has(parent)) return ALL_OWN
  }
  return null
}

function meshColliderFor(rt, mode, maxTriangles) {
  if (!rt.cols) rt.cols = {}
  let col = rt.cols[mode]
  if (!col) col = rt.cols[mode] = { proxy: null, key: '', version: -1, checkedAt: -Infinity, own: new Map() }
  if (!col.proxy || col.version !== rt.version || rt.frame - col.checkedAt >= COLLIDER_RECHECK_FRAMES) {
    col.checkedAt = rt.frame
    const meshes = (rt.model.meshes || []).filter((mesh) => mesh.isMesh && visibleInHierarchy(mesh))
    const key = `${mode}:${maxTriangles}:${meshes.map((mesh) => mesh.uuid).join(',')}`
    if (!col.proxy || col.version !== rt.version || col.key !== key) {
      col.proxy?.dispose()
      col.own.clear()
      const boneSet = danglingBoneSet(rt)
      col.proxy = new CollisionProxy(meshes, {
        maxTriangles,
        pad: 0,
        includeTriangle: (mesh, face) => {
          let flags = col.own.get(mesh)
          if (flags === undefined) {
            flags = ownVertexFlags(mesh, boneSet)
            col.own.set(mesh, flags)
          }
          if (!flags) return mode === 'other'
          if (flags === ALL_OWN) return false
          const index = mesh.geometry.index
          let owned = 0
          for (let c = 0; c < 3; c++) owned += flags[index ? index.getX(face * 3 + c) : face * 3 + c]
          return mode === 'self' ? owned < 2 : false
        },
      })
      col.key = key
      col.version = rt.version
    }
  }
  return col.proxy.update(rt.frame)
}

// Keep the particle out of the surface, whichever way the contact comes (several points along
// its bone are tested, so a long bone cannot cut through a corner). Only the velocity INTO
// the surface is removed, so a strand slides along the body instead of sticking to it.
function contact(node, nx, ny, nz, push, leverage) {
  const move = push * leverage
  node.physPos.x += nx * move
  node.physPos.y += ny * move
  node.physPos.z += nz * move
  node.physPrev.x += nx * move
  node.physPrev.y += ny * move
  node.physPrev.z += nz * move
  const vx = node.physPos.x - node.physPrev.x
  const vy = node.physPos.y - node.physPrev.y
  const vz = node.physPos.z - node.physPrev.z
  const inward = vx * nx + vy * ny + vz * nz
  if (inward < 0) {
    node.physPrev.x += nx * inward
    node.physPrev.y += ny * inward
    node.physPrev.z += nz * inward
  }
}

function pushOutOfSurface(collider, node, point, radius, cells, leverage) {
  const q = collider.query(point.x, point.y, point.z, cells, radius * 4)
  if (!q) return false
  let nx = q.snx
  let ny = q.sny
  let nz = q.snz
  if (nx * nx + ny * ny + nz * nz < 1e-8) {
    nx = q.fnx
    ny = q.fny
    nz = q.fnz
  }
  if (collider.orientation) {
    const side = nx * q.fnx * collider.orientation + ny * q.fny * collider.orientation + nz * q.fnz * collider.orientation
    if (q.dist < 1e-6) {
      nx = q.fnx * collider.orientation
      ny = q.fny * collider.orientation
      nz = q.fnz * collider.orientation
    } else if (side < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
    }
  } else {
    if ((_targetTip.x - q.x) * nx + (_targetTip.y - q.y) * ny + (_targetTip.z - q.z) * nz < 0) {
      // No trustworthy winding (flat or open surface): stay on the side the animated pose is on.
      nx = -nx
      ny = -ny
      nz = -nz
    }
  }
  const signed = (point.x - q.x) * nx + (point.y - q.y) * ny + (point.z - q.z) * nz
  if (signed >= radius) return false
  contact(node, nx, ny, nz, radius - signed, leverage)
  return true
}

function collideWithSurface(collider, node, radius) {
  const cells = Math.min(3, Math.max(1, Math.ceil((radius * 2) / collider.cell)))
  let collided = pushOutOfSurface(collider, node, node.physPos, radius, cells, 1)
  // Sample along the bone so a long segment cannot slip through between its
  // tip and pivot. A correction near the pivot needs more tip leverage.
  _segmentPoint.copy(_pivot).lerp(node.physPos, 2 / 3)
  collided = pushOutOfSurface(collider, node, _segmentPoint, radius, cells, 1.5) || collided
  _segmentPoint.copy(_pivot).lerp(node.physPos, 1 / 3)
  collided = pushOutOfSurface(collider, node, _segmentPoint, radius, cells, 3) || collided
  return collided
}

// Every bone as a segment (its parent -> itself), read once per frame instead of once per bone per
// sub-step. A chain skips its own bones, the bones directly under them, and the bone it hangs from.
function prepareBoneSegments(rt) {
  const bones = rt.model.bones || []
  let seg = rt.seg
  if (!seg || seg.bones !== bones || seg.count !== bones.length || seg.version !== rt.version) {
    const indexOf = new Map()
    bones.forEach((bone, i) => indexOf.set(bone, i))
    const parentIndex = new Int32Array(bones.length)
    bones.forEach((bone, i) => {
      parentIndex[i] = bone.parent?.isBone && indexOf.has(bone.parent) ? indexOf.get(bone.parent) : -1
    })
    seg = rt.seg = {
      bones,
      count: bones.length,
      version: rt.version,
      indexOf,
      parentIndex,
      pos: new Float32Array(3 * bones.length),
    }
    for (const chain of rt.chains.values()) chain.skip = null
  }
  for (let i = 0; i < seg.count; i++) {
    const e = bones[i].matrixWorld.elements
    seg.pos[3 * i] = e[12]
    seg.pos[3 * i + 1] = e[13]
    seg.pos[3 * i + 2] = e[14]
  }
  for (const chain of rt.chains.values()) {
    if (chain.skip) continue
    const skip = (chain.skip = new Uint8Array(seg.count))
    for (let i = 0; i < seg.count; i++) {
      const bone = bones[i]
      if (chain.boneSet.has(bone) || (bone.parent && chain.boneSet.has(bone.parent)) || seg.parentIndex[i] < 0) skip[i] = 1
    }
    for (const node of chain.order) {
      if (node.parentBone && seg.indexOf.has(node.parentBone)) skip[seg.indexOf.get(node.parentBone)] = 1
    }
  }
}

function collideWithOtherBones(seg, chain, node, radius) {
  let collided = false
  const radiusSq = radius * radius
  const pos = seg.pos
  const skip = chain.skip
  let px = node.physPos.x
  let py = node.physPos.y
  let pz = node.physPos.z
  for (let i = 0; i < seg.count; i++) {
    if (skip[i]) continue
    px = node.physPos.x
    py = node.physPos.y
    pz = node.physPos.z
    const a = 3 * seg.parentIndex[i]
    const b = 3 * i
    const abx = pos[b] - pos[a]
    const aby = pos[b + 1] - pos[a + 1]
    const abz = pos[b + 2] - pos[a + 2]
    const lenSq = abx * abx + aby * aby + abz * abz
    if (lenSq < 1e-10) continue
    let t = ((px - pos[a]) * abx + (py - pos[a + 1]) * aby + (pz - pos[a + 2]) * abz) / lenSq
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const cx = pos[a] + abx * t
    const cy = pos[a + 1] + aby * t
    const cz = pos[a + 2] + abz * t
    let dx = node.physPos.x - cx
    let dy = node.physPos.y - cy
    let dz = node.physPos.z - cz
    const distSq = dx * dx + dy * dy + dz * dz
    if (distSq >= radiusSq) continue
    collided = true
    if (distSq < 1e-10) {
      dx = _dir.x
      dy = _dir.y
      dz = _dir.z
      if (dx * dx + dy * dy + dz * dz < 1e-10) {
        dx = 0
        dy = 1
        dz = 0
      }
    }
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
    contact(node, dx / distance, dy / distance, dz / distance, radius - distance, 1)
  }
  return collided
}

// Keep collision corrections on the bone's fixed-length sphere. Moving the
// previous position by the same amount preserves the Verlet velocity.
function projectTipLength(node) {
  _dir.copy(node.physPos).sub(_pivot)
  if (_dir.lengthSq() < 1e-10) return
  _dir.setLength(node.tipLength)
  const dx = _pivot.x + _dir.x - node.physPos.x
  const dy = _pivot.y + _dir.y - node.physPos.y
  const dz = _pivot.z + _dir.z - node.physPos.z
  node.physPos.x += dx
  node.physPos.y += dy
  node.physPos.z += dz
  node.physPrev.x += dx
  node.physPrev.y += dy
  node.physPrev.z += dz
}

// Advance every enabled character's dangle chains by `dt` seconds. Call once
// per rendered frame, after the animation mixer has updated bone poses and
// before rendering.
export function stepDangleLive(dt) {
  if (!runtimes.size) return
  const clampedDt = Math.min(dt || 1 / 60, MAX_DT)
  const subDt = clampedDt / SUBSTEPS
  applyWind(_wind)
  let touched = false

  for (const rt of runtimes.values()) {
    if (!rt.enabled || !rt.chains.size) continue
    rt.frame = (rt.frame || 0) + 1
    let needsMeshCollision = false
    let needsBoneCollision = false
    let needsSelfCollision = false
    for (const chain of rt.chains.values()) {
      if (chain.params.collideWithMesh) needsMeshCollision = true
      if (chain.params.collideWithBones) needsBoneCollision = true
      if (chain.params.collideWithSelf) needsSelfCollision = true
    }
    let collider = null
    let selfCollider = null
    if (needsMeshCollision || needsBoneCollision || needsSelfCollision) rt.model.root?.updateMatrixWorld(true)
    const proxyBudget = needsMeshCollision && needsSelfCollision ? Math.floor(COLLIDER_TRIANGLES / 2) : COLLIDER_TRIANGLES
    if (needsMeshCollision) collider = meshColliderFor(rt, 'other', proxyBudget)
    if (needsSelfCollision) selfCollider = meshColliderFor(rt, 'self', proxyBudget)
    if (needsBoneCollision) prepareBoneSegments(rt)
    for (const chain of rt.chains.values()) {
      const { stiffness, gravity, damping, collideWithBones, collideWithMesh, collideWithSelf, bounce, reaction, swingLimit, holdTop } = chain.params
      const carry = 1 - reaction
      const limitRad = THREE.MathUtils.degToRad(swingLimit)
      // Exponential damping keeps the response consistent at different frame rates.
      const velocityKeep = Math.exp(-damping * 6 * subDt)
      const springFactor = 1 - Math.exp(-stiffness * 40 * subDt)
      // What the chain hangs from does not move during the frame, so bring it up to date once. Inside
      // the chain each bone's world matrix is then built from its parent's as it is processed,
      // instead of re-walking the whole skeleton above it on every call.
      for (const node of chain.order) if (!node.parentNode) node.bone.parent?.updateWorldMatrix(true, false)
      for (let s = 0; s < SUBSTEPS; s++) {
        for (const node of chain.order) {
          const parent = node.bone.parent
          const parentWorld = parent ? parent.matrixWorld : _identity
          let parentWorldQuat
          if (node.parentNode) {
            parentWorldQuat = node.parentNode._finalWorldQuat
          } else if (parent) {
            parentWorld.decompose(_decPos, _parentWQ, _decScale)
            parentWorldQuat = _parentWQ
          } else {
            parentWorldQuat = _parentWQ.identity()
          }

          _pivot.copy(node.bone.position).applyMatrix4(parentWorld)
          // Carry the simulation with a translating attachment instead of leaving it behind.
          _vel.copy(_pivot).sub(node.lastPivot)
          _vel.multiplyScalar(carry)
          node.physPos.add(_vel)
          node.physPrev.add(_vel)
          node.lastPivot.copy(_pivot)
          _targetWQ.copy(parentWorldQuat).multiply(node.restLocalQuat)
          _targetTip.copy(node.tipLocalOffset).applyQuaternion(_targetWQ).add(_pivot)

          // Verlet integrate the free tip particle.
          _vel.copy(node.physPos).sub(node.physPrev).multiplyScalar(velocityKeep)
          _vel.y *= bounce
          node.physPrev.copy(node.physPos)
          node.physPos.add(_vel)
          node.physPos.y -= GRAVITY_MS2 * gravity * subDt * subDt
          node.physPos.addScaledVector(_wind, subDt * subDt)
          // Spring back toward the animated target (recovery force / "stiffness").
          node.physPos.lerp(_targetTip, springFactor)
          // Rigid re-projection: the bone doesn't stretch.
          _dir.copy(node.physPos).sub(_pivot)
          if (_dir.lengthSq() > 1e-10) {
            _dir.setLength(node.tipLength)
            node.physPos.copy(_pivot).add(_dir)
          } else {
            node.physPos.copy(_targetTip)
          }
          const collisionRadius = node.tipLength * 0.12
          // Collision and fixed bone length are competing constraints. Alternate
          // them a bounded number of times so projection cannot undo the push-out.
          for (let pass = 0; pass < 2; pass++) {
            let collided = false
            if (collideWithMesh && collider) collided = collideWithSurface(collider, node, collisionRadius) || collided
            if (collideWithSelf && selfCollider) collided = collideWithSurface(selfCollider, node, collisionRadius) || collided
            if (collideWithBones && chain.skip) collided = collideWithOtherBones(rt.seg, chain, node, collisionRadius) || collided
            if (!collided) break
            projectTipLength(node)
          }
          _dir.copy(node.physPos).sub(_pivot)
          if (_dir.lengthSq() > 1e-10) {
            _dir.setLength(node.tipLength)
            node.physPos.copy(_pivot).add(_dir)
          }

          // Swing the bone's rotation from "no physics" onto "where the
          // particle actually ended up", applied on top of today's pose.
          _targetDir.copy(_targetTip).sub(_pivot).normalize()
          _physDir.copy(node.physPos).sub(_pivot).normalize()
          _qSwing.setFromUnitVectors(_targetDir, _physDir)
          // Swing limit and rigid top both shrink the swing; the particle follows so it does not wind up.
          let swingScale = 1
          if (holdTop > 0) swingScale = THREE.MathUtils.clamp((node.depthFrac - holdTop * 0.999) / (1 - holdTop * 0.999), 0, 1)
          const angle = _targetDir.angleTo(_physDir)
          if (swingScale < 1 || angle > limitRad) {
            const wanted = Math.min(angle * swingScale, limitRad)
            if (angle > 1e-6) {
              _axis.crossVectors(_targetDir, _physDir)
              if (_axis.lengthSq() > 1e-12) {
                _axis.normalize()
                _qSwing.copy(_qLimit.setFromAxisAngle(_axis, wanted))
                _physDir.copy(_targetDir).applyQuaternion(_qSwing)
                node.physPos.copy(_pivot).addScaledVector(_physDir, node.tipLength)
              }
            }
          }
          _finalWQ.copy(_targetWQ).premultiply(_qSwing)
          _localQ.copy(parentWorldQuat).invert().multiply(_finalWQ)
          node.bone.quaternion.copy(_localQ)
          node.bone.updateMatrix()
          node.bone.matrixWorld.multiplyMatrices(parentWorld, node.bone.matrix)

          // Cache this node's resolved world rotation for its own dangled
          // children (processed right after it, since `order` is parent-first).
          if (!node._finalWorldQuat) node._finalWorldQuat = new THREE.Quaternion()
          node._finalWorldQuat.copy(_finalWQ)
        }
      }
      touched = true
    }
  }

  if (touched && dg.requestRender) dg.requestRender()
}

// Descendant bone names of `rootName` (inclusive), for the "add selected bone
// + everything hanging off it" convenience action. Stops at (doesn't cross)
// bones that aren't real skeleton bones. `maxBones` guards against
// accidentally sweeping in a huge chunk of the rig from a high-up selection.
export function collectDescendantBoneNames(model, rootName, maxBones = 40) {
  const byName = new Map()
  for (const b of model.bones || []) byName.set(b.name, b)
  const root = byName.get(rootName)
  if (!root) return []
  const out = []
  const stack = [root]
  while (stack.length && out.length < maxBones) {
    const b = stack.pop()
    out.push(b.name)
    for (const c of b.children) if (c.isBone && byName.has(c.name)) stack.push(c)
  }
  return out
}

// ---------------------------------------------------------------------------
// Editing the dangle chains as undo steps
//
// The panel edits go through these: adding / removing a chain, a slider, the master switch. A
// slider drag (many quick edits of the same chain's same settings) is ONE step. The store is the
// source of truth; the physics is told right away, so a character that is not the active one is
// undone correctly too.
// ---------------------------------------------------------------------------

const COALESCE_MS = 800
const cloneData = (v) => JSON.parse(JSON.stringify(v))
let lastEdit = null

function readDangle(characterId) {
  const s = useStore.getState()
  const src = s.activeCharacterId === characterId ? s : s.characters[characterId] || {}
  return { enabled: src.dangleEnabled !== false, chains: src.dangleChains || [] }
}

function writeDangle(characterId, value) {
  useStore.setState((s) => {
    if (s.activeCharacterId === characterId) return { dangleEnabled: value.enabled, dangleChains: value.chains }
    const c = s.characters[characterId]
    if (!c) return {}
    return { characters: { ...s.characters, [characterId]: { ...c, dangleEnabled: value.enabled, dangleChains: value.chains } } }
  })
  const rt = runtimes.get(characterId)
  if (rt) setDangleConfig(characterId, rt.model, value.enabled, value.chains)
  if (dg.requestRender) dg.requestRender()
}

// Change a character's dangle settings and record it. `mutate` gets a copy of { enabled, chains } and
// returns the new one.
export function editDangle(characterId, mutate, { key = null, discrete = false } = {}) {
  const before = cloneData(readDangle(characterId))
  const next = mutate(cloneData(before))
  if (!next || JSON.stringify(before) === JSON.stringify(next)) return
  writeDangle(characterId, next)

  const now = Date.now()
  if (discrete) lastEdit = null
  if (
    key &&
    lastEdit &&
    lastEdit.key === key &&
    lastEdit.characterId === characterId &&
    lastEdit.epoch === getHistoryEpoch() &&
    lastEdit.seq === getHistorySequence() &&
    now - lastEdit.time < COALESCE_MS
  ) {
    lastEdit.after = cloneData(next)
    lastEdit.time = now
    return
  }
  const rec = { key, characterId, before, after: cloneData(next), time: now, seq: 0, epoch: getHistoryEpoch() }
  pushSceneHistory(
    () => {
      lastEdit = null // an edit straight after an undo must not merge into the step that was just undone
      writeDangle(characterId, cloneData(rec.before))
    },
    () => {
      lastEdit = null
      writeDangle(characterId, cloneData(rec.after))
    },
  )
  rec.seq = getHistorySequence()
  lastEdit = discrete ? null : rec
}

const activeId = () => useStore.getState().activeCharacterId

export function setDangleEnabledUndoable(enabled) {
  editDangle(activeId(), (d) => ({ ...d, enabled: !!enabled }), { discrete: true })
}

export function addDangleChainUndoable(name, boneNames, type = 'dangle', group = null) {
  const cloth = type === 'cloth'
  editDangle(
    activeId(),
    (d) => ({
      ...d,
      chains: [
        ...d.chains,
        {
          id: `dangle_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          name,
          boneNames,
          type: cloth ? 'cloth' : 'dangle',
          stiffness: cloth ? 0.4 : 0.15,
          gravity: cloth ? 0.35 : 1,
          damping: cloth ? 0.55 : 0.8,
          collideWithBones: false,
          collideWithMesh: false,
          collideWithSelf: false,
          ...(group?.id ? { groupId: group.id, groupName: group.name || name } : {}),
        },
      ],
    }),
    { discrete: true },
  )
}

export function groupDangleChainsByRig(chains, rigs) {
  const entries = (rigs || []).map((rig) => ({
    id: rig.id,
    name: rig.label || 'Added bones',
    bones: new Set(rig.boneNames || []),
  }))
  const sections = []
  const grouped = new Map()
  for (const chain of chains || []) {
    let rig = entries.find((entry) => entry.id === chain.groupId)
    if (!rig) {
      const chainBones = new Set(chain.boneNames || [])
      let bestOverlap = 0
      for (const entry of entries) {
        let overlap = 0
        for (const name of chainBones) if (entry.bones.has(name)) overlap++
        if (overlap > bestOverlap) {
          rig = entry
          bestOverlap = overlap
        }
      }
    }
    if (!rig && !chain.groupId) {
      // Old chains with no group id: match by name, but only when exactly one rig could own the name.
      const byName = entries.filter((entry) => chain.name === entry.name || chain.name.startsWith(`${entry.name} `))
      if (byName.length === 1) rig = byName[0]
    }
    if (!rig) {
      sections.push({ id: chain.id, chains: [chain] })
      continue
    }
    let section = grouped.get(rig.id)
    if (!section) {
      section = { id: rig.id, groupId: rig.id, name: rig.name, chains: [] }
      grouped.set(rig.id, section)
      sections.push(section)
    }
    section.chains.push(chain)
  }
  return sections
}

// The chains that belong to one Add bones rig. A chain's group id (or the rig bones it uses) decides this;
// the name is only a last resort for old chains, and never when another rig could own the same name.
export function getDangleChainsForRig(chains, rig, allRigs = []) {
  if (!rig?.id) return []
  const rigBones = new Set(rig.boneNames || [])
  const others = (allRigs || []).filter((other) => other.id !== rig.id)
  const usesBones = (chain, bones) => (chain.boneNames || []).some((name) => bones.has(name))
  return (chains || []).filter((chain) => {
    if (chain.groupId) return chain.groupId === rig.id
    if (usesBones(chain, rigBones)) return true
    if (others.some((other) => usesBones(chain, new Set(other.boneNames || [])))) return false
    const named = (entry) => chain.name === entry.label || (chain.name || '').startsWith(`${entry.label} `)
    return named(rig) && !others.some(named)
  })
}

// Recreate one default dangle chain for each rig that already has dangle
// chains. Hand-made chains are left untouched; the replacements follow the
// rig's current descendants rather than any possibly stale saved bone list.
export function rebuildRigChainsUndoable(rigs, descend) {
  const entries = (rigs || []).filter((rig) => rig?.id)
  if (!entries.length || typeof descend !== 'function') return 0

  const before = readDangle(activeId())
  const replacements = new Map()
  let count = 0
  for (const rig of entries) {
    const owned = getDangleChainsForRig(before.chains, rig, entries)
    if (!owned.length) continue

    const boneNames = [...new Set((rig.rootBoneNames || []).flatMap((root) => descend(root) || []))]
    if (!boneNames.length) continue
    const id = `dangle_${Date.now()}_${Math.floor(Math.random() * 1000)}`
    replacements.set(owned[0].id, {
      id,
      name: rig.label || 'Added bones',
      boneNames,
      type: 'dangle',
      stiffness: 0.15,
      gravity: 1,
      damping: 0.8,
      collideWithBones: false,
      collideWithMesh: false,
      collideWithSelf: false,
      groupId: rig.id,
      groupName: rig.label || 'Added bones',
    })
    for (const chain of owned.slice(1)) replacements.set(chain.id, null)
    count++
  }
  if (!replacements.size) return 0

  editDangle(
    activeId(),
    (d) => ({
      ...d,
      chains: d.chains.flatMap((chain) => {
        if (!replacements.has(chain.id)) return [chain]
        const replacement = replacements.get(chain.id)
        return replacement ? [replacement] : []
      }),
    }),
    { discrete: true },
  )
  return count
}

// After an Add bones rig is renamed or rebuilt: put its chains in a group of their own under the new name,
// point them at the rebuilt bones (the bone names come from the rig name) and rename "Old 1" to "New 1".
export function regroupRigChainsUndoable(chainIds, group, oldRig, newRig, descend) {
  const ids = new Set(chainIds || [])
  if (!ids.size || !group?.id || !oldRig || !newRig) return
  const oldBones = oldRig.boneNames || []
  const newBones = newRig.boneNames || []
  const oldRoots = oldRig.rootBoneNames || []
  const newRoots = newRig.rootBoneNames || []
  const sameShape = oldBones.length === newBones.length
  const renamed = new Map()
  if (sameShape) oldBones.forEach((n, i) => renamed.set(n, newBones[i]))
  const oldLabel = oldRig.label || ''
  const newLabel = newRig.label || group.name || ''
  editDangle(
    activeId(),
    (d) => ({
      ...d,
      chains: d.chains.flatMap((chain) => {
        if (!ids.has(chain.id)) return [chain]
        let boneNames
        if (sameShape) {
          boneNames = (chain.boneNames || []).map((n) => renamed.get(n) ?? n)
        } else {
          const set = new Set()
          oldRoots.forEach((root, i) => {
            if (newRoots[i] && (chain.boneNames || []).includes(root)) descend(newRoots[i]).forEach((n) => set.add(n))
          })
          boneNames = [...set]
          if (!boneNames.length) return [] // the piece this chain belonged to is gone
        }
        let name = chain.name
        if (oldLabel && name === oldLabel) name = newLabel
        else if (oldLabel && (name || '').startsWith(`${oldLabel} `)) name = `${newLabel}${name.slice(oldLabel.length)}`
        return [{ ...chain, name, boneNames, groupId: group.id, groupName: group.name || newLabel }]
      }),
    }),
    { discrete: true },
  )
}

export function removeDangleChainUndoable(chainId) {
  editDangle(activeId(), (d) => ({ ...d, chains: d.chains.filter((c) => c.id !== chainId) }), { discrete: true })
}

export function updateDangleChainUndoable(chainId, patch) {
  editDangle(activeId(), (d) => ({ ...d, chains: d.chains.map((c) => (c.id === chainId ? { ...c, ...patch } : c)) }), {
    key: `${chainId}:${Object.keys(patch).join(',')}`,
  })
}

// Change one setting on several chains at once (a whole group). Slider drags merge into one undo step.
export function updateDangleChainsUndoable(chainIds, patch) {
  const ids = new Set(chainIds || [])
  if (!ids.size) return
  editDangle(activeId(), (d) => ({ ...d, chains: d.chains.map((c) => (ids.has(c.id) ? { ...c, ...patch } : c)) }), {
    key: `group:${[...ids].join(',')}:${Object.keys(patch).join(',')}`,
  })
}

export function groupDangleChainsUndoable(chainIds, group) {
  const ids = new Set(chainIds || [])
  if (!ids.size || !group?.id) return
  editDangle(
    activeId(),
    (d) => ({
      ...d,
      chains: d.chains.map((chain) => ids.has(chain.id)
        ? { ...chain, groupId: group.id, groupName: group.name || chain.name }
        : chain),
    }),
    { discrete: true },
  )
}

export function setAllDangleCollisionsUndoable(enabled) {
  const collide = !!enabled
  editDangle(
    activeId(),
    (d) => ({
      ...d,
      chains: d.chains.map((chain) => ({
        ...chain,
        collideWithBones: collide,
        collideWithMesh: collide,
        collideWithSelf: collide,
      })),
    }),
    { discrete: true },
  )
}
