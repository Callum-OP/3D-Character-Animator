import * as THREE from 'three'

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

// Build (or rebuild) the physics runtime for one character from its saved/
// edited chain configs. `chains` is the store's plain-data array:
// [{ id, name, boneNames: [...], stiffness, gravity, damping }]. Safe to call
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
}

function paramsFrom(cfg) {
  const d = defaultConfig()
  return {
    stiffness: THREE.MathUtils.clamp(cfg.stiffness ?? d.stiffness, 0, 1),
    gravity: THREE.MathUtils.clamp(cfg.gravity ?? d.gravity, 0, 3),
    damping: THREE.MathUtils.clamp(cfg.damping ?? d.damping, 0, 1),
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
    nodesByBone.set(bone, { bone, name, children: [], physPos: null, physPrev: null })
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
  }

  return {
    boneNamesKey: cfg.boneNames.join('|'),
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
      const tip = pivot.add(node.tipLocalOffset.clone().applyQuaternion(parentWorldQuat))
      node.physPos.copy(tip)
      node.physPrev.copy(tip)
    }
  }
}

export function clearDangle(id) {
  runtimes.delete(id)
}

// --- scratch (avoid per-frame allocation) -----------------------------------
const _pivot = new THREE.Vector3()
const _parentWQ = new THREE.Quaternion()
const _targetWQ = new THREE.Quaternion()
const _targetTip = new THREE.Vector3()
const _vel = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _targetDir = new THREE.Vector3()
const _physDir = new THREE.Vector3()
const _qSwing = new THREE.Quaternion()
const _finalWQ = new THREE.Quaternion()
const _localQ = new THREE.Quaternion()

// Advance every enabled character's dangle chains by `dt` seconds. Call once
// per rendered frame, after the animation mixer has updated bone poses and
// before rendering.
export function stepDangleLive(dt) {
  if (!runtimes.size) return
  const clampedDt = Math.min(dt || 1 / 60, MAX_DT)
  const subDt = clampedDt / SUBSTEPS
  let touched = false

  for (const rt of runtimes.values()) {
    if (!rt.enabled || !rt.chains.size) continue
    for (const chain of rt.chains.values()) {
      const { stiffness, gravity, damping } = chain.params
      // Air-resistance style damping: fraction of velocity kept per substep.
      const velocityKeep = 0.86 + damping * 0.13 // 0 -> 0.86, 1 -> 0.99
      for (let s = 0; s < SUBSTEPS; s++) {
        for (const node of chain.order) {
          const parentWorldQuat = node.parentNode
            ? node.parentNode._finalWorldQuat
            : node.bone.parent
              ? node.bone.parent.getWorldQuaternion(_parentWQ)
              : _parentWQ.identity()

          node.bone.getWorldPosition(_pivot)
          _targetWQ.copy(parentWorldQuat).multiply(node.restLocalQuat)
          _targetTip.copy(node.tipLocalOffset).applyQuaternion(_targetWQ).add(_pivot)

          // Verlet integrate the free tip particle.
          _vel.copy(node.physPos).sub(node.physPrev).multiplyScalar(velocityKeep)
          node.physPrev.copy(node.physPos)
          node.physPos.add(_vel)
          node.physPos.y -= GRAVITY_MS2 * gravity * subDt * subDt
          // Spring back toward the animated target (recovery force / "stiffness").
          node.physPos.lerp(_targetTip, THREE.MathUtils.clamp(stiffness, 0, 1))
          // Rigid re-projection: the bone doesn't stretch.
          _dir.copy(node.physPos).sub(_pivot)
          if (_dir.lengthSq() > 1e-10) {
            _dir.setLength(node.tipLength)
            node.physPos.copy(_pivot).add(_dir)
          } else {
            node.physPos.copy(_targetTip)
          }

          // Swing the bone's rotation from "no physics" onto "where the
          // particle actually ended up", applied on top of today's pose.
          _targetDir.copy(_targetTip).sub(_pivot).normalize()
          _physDir.copy(node.physPos).sub(_pivot).normalize()
          _qSwing.setFromUnitVectors(_targetDir, _physDir)
          _finalWQ.copy(_targetWQ).premultiply(_qSwing)
          _localQ.copy(parentWorldQuat).invert().multiply(_finalWQ)
          node.bone.quaternion.copy(_localQ)

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