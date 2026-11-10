import * as THREE from 'three'
import { useStore } from '../store.js'
import { pushSceneHistory } from './sceneHistory.js'
import { getHistorySequence, getHistoryEpoch } from './undoHistory.js'
import { classifyBone } from './bvh.js'
import { MAX_FLATTENERS, flatCount, flatPivot, flatUp, flatParams, flatMore } from './flattenerShader.js'

// ---------------------------------------------------------------------------
// Flattener (the character side)
//
// A flattener is attached to a BONE (normally the head). It flattens everything above its "chin
// line" toward the camera — see flattenerShader.js for how — and it moves with the bone, so the
// head keeps its flat look as it turns and as the animation plays.
//
// Settings live in the store per character (and are saved with the project):
//   { id, name, boneName, enabled, strength, start, falloff, thickness, shading,
//     headSize, pivotLocal, upLocal }
//   strength   0..1   how flat (0 = untouched)
//   start      the chin line, in head-heights above the head's centre (negative = below it)
//   falloff    how far below the chin line the effect fades out, in head-heights
//   thickness  how much depth is kept at full strength (0.04 = 4% of the original depth)
//   shading    how much of the flattening also goes into the lighting (1 = the face is lit like a flat plane)
//   shadingEdge  surfaces turned away from the camera keep their own lighting (a ramp this wide, in cos units)
//   keepScreen 0..1  0 = a true flatten, 1 = every point stays exactly where it is on screen (only depth + lighting change)
//   headSize / pivotLocal / upLocal: worked out from the model by "auto-fit", in the bone's own
//   units, so they follow the bone and survive the character being resized
//
// Each frame the numbers are put into the shared shader uniforms just before a mesh of that
// character is drawn (onBeforeRender) and cleared right after (onAfterRender): the outline pass
// draws the same mesh objects, so the outline is flattened too, and nothing else is affected.
// ---------------------------------------------------------------------------

const COALESCE_MS = 800

const k = { scene: null, requestRender: () => {}, guidesOn: false, visible: true }

// characterId -> { model, enabled, items: Map<id, item> }
// item = { cfg, bone, pivotLocal: Vector3, upLocal: Vector3, guide }
const runtimes = new Map()
const hooked = new WeakSet() // meshes whose draw is already hooked (a cloned mesh does not inherit the hook)

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _v = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)

export function initFlattener(refs) {
  k.scene = refs.scene
  k.requestRender = refs.requestRender || (() => {})
}

export function disposeFlattener() {
  for (const id of [...runtimes.keys()]) clearFlattener(id)
}

const clone = (v) => JSON.parse(JSON.stringify(v))

export function newFlattenerId() {
  return `flat_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
}

// ---------------------------------------------------------------------------
// Store access + undo
// ---------------------------------------------------------------------------

function readItems(characterId) {
  const s = useStore.getState()
  if (s.activeCharacterId === characterId) return s.flatteners || []
  return s.characters[characterId]?.flatteners || []
}

function readEnabled(characterId) {
  const s = useStore.getState()
  if (s.activeCharacterId === characterId) return s.flattenerEnabled !== false
  return s.characters[characterId]?.flattenerEnabled !== false
}

export function writeFlatteners(characterId, items) {
  useStore.setState((s) => {
    if (s.activeCharacterId === characterId) return { flatteners: items }
    const c = s.characters[characterId]
    if (!c) return {}
    return { characters: { ...s.characters, [characterId]: { ...c, flatteners: items } } }
  })
}

function syncCharacter(characterId) {
  const rt = runtimes.get(characterId)
  if (!rt) return
  setFlattenerConfig(characterId, rt.model, readEnabled(characterId), readItems(characterId))
}

let last = null

// Change a character's flatteners and record ONE undo step; edits with the same `key` in quick
// succession (a slider drag) merge into one.
export function editFlatteners(characterId, mutate, { key = null } = {}) {
  const before = clone(readItems(characterId))
  const next = mutate(clone(before))
  if (!next || JSON.stringify(before) === JSON.stringify(next)) return
  writeFlatteners(characterId, next)
  syncCharacter(characterId)

  const now = Date.now()
  if (
    key &&
    last &&
    last.key === key &&
    last.characterId === characterId &&
    last.epoch === getHistoryEpoch() &&
    last.seq === getHistorySequence() &&
    now - last.time < COALESCE_MS
  ) {
    last.after = clone(next)
    last.time = now
    return
  }
  const rec = { key, characterId, before, after: clone(next), time: now, seq: 0, epoch: getHistoryEpoch() }
  pushSceneHistory(
    () => {
      last = null // an edit straight after an undo must not merge into the step that was just undone
      writeFlatteners(characterId, clone(rec.before))
      syncCharacter(characterId)
    },
    () => {
      last = null
      writeFlatteners(characterId, clone(rec.after))
      syncCharacter(characterId)
    },
  )
  rec.seq = getHistorySequence()
  last = rec
}

export function updateFlattener(id, patch, { key = null } = {}) {
  const characterId = ownerOf(id)
  if (characterId == null) return
  editFlatteners(characterId, (items) => items.map((it) => (it.id === id ? { ...it, ...patch } : it)), {
    key: key || `${id}:${Object.keys(patch).join(',')}`,
  })
}

function ownerOf(id) {
  for (const [characterId, rt] of runtimes) if (rt.items.has(id)) return characterId
  return null
}

function findBone(model, name) {
  if (!model || !name) return null
  const fromList = (model.bones || []).find((b) => b.name === name)
  if (fromList) return fromList
  const found = model.root ? model.root.getObjectByName(name) : null
  return found && found.isBone ? found : null
}

// ---------------------------------------------------------------------------
// Auto-fit: find the head's centre, size and chin line from the mesh
// ---------------------------------------------------------------------------

const DEFAULT_START = -0.45
const DEFAULT_FALLOFF = 0.25
const DEFAULT_EDGE = 0.15

// Which way is "up" for the part this bone carries, in the bone's own space. The bone's child
// that points most upward (a head bone points at the top of the head) tells us; otherwise
// straight up in the world.
function upDirectionFor(bone, outLocal) {
  bone.updateWorldMatrix(true, false)
  bone.matrixWorld.decompose(_p, _q, _s)
  const bonePos = _p.clone()
  const boneQuat = _q.clone()
  let best = null
  let bestDot = 0.3
  for (const child of bone.children) {
    if (!child.isBone) continue
    child.updateWorldMatrix(true, false)
    child.getWorldPosition(_v)
    const dir = _v.clone().sub(bonePos)
    if (dir.lengthSq() < 1e-12) continue
    dir.normalize()
    const d = dir.dot(_up)
    if (d > bestDot) {
      bestDot = d
      best = dir
    }
  }
  const world = best || _up.clone()
  return outLocal.copy(world).applyQuaternion(boneQuat.invert()).normalize()
}

function descendantsOf(bone) {
  const set = new Set()
  bone.traverse((o) => {
    if (o.isBone) set.add(o)
  })
  return set
}

const percentile = (sorted, f) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(f * (sorted.length - 1))))]

// Work out the geometry settings for a flattener on `bone`: head centre, head size, up, and a
// sensible chin line, from the vertices that mostly follow this bone (and the bones under it).
export function fitFlattener(model, bone) {
  bone.updateWorldMatrix(true, false)
  bone.matrixWorld.decompose(_p, _q, _s)
  const boneMatrix = bone.matrixWorld.clone()
  const boneScale = (Math.abs(_s.x) + Math.abs(_s.y) + Math.abs(_s.z)) / 3 || 1
  const upLocal = upDirectionFor(bone, new THREE.Vector3())
  const upWorld = upLocal.clone().applyQuaternion(_q.clone()).normalize()
  const bonePos = _p.clone()
  const group = descendantsOf(bone)

  const heights = []
  const centroid = new THREE.Vector3()
  let count = 0
  const meshes = (model.meshes || []).filter((m) => m.isSkinnedMesh && m.skeleton)
  for (const mesh of meshes) {
    const indices = new Set()
    mesh.skeleton.bones.forEach((b, i) => {
      if (group.has(b)) indices.add(i)
    })
    if (!indices.size) continue
    const index = mesh.geometry.getAttribute('skinIndex')
    const weight = mesh.geometry.getAttribute('skinWeight')
    const position = mesh.geometry.getAttribute('position')
    if (!index || !weight || !position) continue
    mesh.updateWorldMatrix(true, false)
    mesh.skeleton.update()
    const stride = Math.max(1, Math.floor(position.count / 20000))
    for (let i = 0; i < position.count; i += stride) {
      let w = 0
      for (let c = 0; c < 4; c++) if (indices.has(index.getComponent(i, c))) w += weight.getComponent(i, c)
      if (w < 0.5) continue
      mesh.getVertexPosition(i, _v)
      _v.applyMatrix4(mesh.matrixWorld)
      heights.push(_v.clone().sub(bonePos).dot(upWorld))
      centroid.add(_v)
      count++
    }
  }

  if (count >= 8) {
    centroid.multiplyScalar(1 / count)
    heights.sort((a, b) => a - b)
    const top = percentile(heights, 0.98)
    const bottom = percentile(heights, 0.02)
    const chin = percentile(heights, 0.1)
    const centreHeight = centroid.clone().sub(bonePos).dot(upWorld)
    const headHeight = Math.max(top - bottom, 1e-6)
    const start = Math.min(-0.1, Math.max(-0.8, (chin - centreHeight) / headHeight))
    return {
      headSize: headHeight / boneScale,
      pivotLocal: centroid.clone().applyMatrix4(boneMatrix.clone().invert()).toArray(),
      upLocal: upLocal.toArray(),
      start,
      fitted: true,
    }
  }
  // no skinned vertices follow this bone (rigid parts, or an odd rig): a size from the model
  const rough = Math.max(0.05, (model.radius || 1) * 0.25)
  return { headSize: rough / boneScale, pivotLocal: [0, rough / boneScale, 0], upLocal: upLocal.toArray(), start: DEFAULT_START, fitted: false }
}

// ---------------------------------------------------------------------------
// Adding / removing / refitting
// ---------------------------------------------------------------------------

export function addFlattener(boneName, { characterId = useStore.getState().activeCharacterId } = {}) {
  const rt = runtimes.get(characterId)
  const bone = rt ? findBone(rt.model, boneName) : null
  if (!bone) return null
  if (readItems(characterId).length >= MAX_FLATTENERS) return null
  const fit = fitFlattener(rt.model, bone)
  const item = {
    id: newFlattenerId(),
    name: boneName,
    boneName,
    enabled: true,
    strength: 1,
    start: fit.start,
    falloff: DEFAULT_FALLOFF,
    thickness: 0.04,
    shading: 1,
    shadingEdge: DEFAULT_EDGE,
    keepScreen: 0,
    headSize: fit.headSize,
    pivotLocal: fit.pivotLocal,
    upLocal: fit.upLocal,
  }
  editFlatteners(characterId, (items) => [...items, item])
  return item
}

// The master switch, as one undo step.
function writeEnabledField(characterId, enabled) {
  useStore.setState((s) => {
    if (s.activeCharacterId === characterId) return { flattenerEnabled: enabled }
    const c = s.characters[characterId]
    if (!c) return {}
    return { characters: { ...s.characters, [characterId]: { ...c, flattenerEnabled: enabled } } }
  })
  const rt = runtimes.get(characterId)
  if (rt) rt.enabled = enabled
  k.requestRender()
}

export function setFlattenerEnabled(characterId, enabled) {
  const before = readEnabled(characterId)
  const after = enabled !== false
  if (before === after) return
  last = null
  writeEnabledField(characterId, after)
  pushSceneHistory(
    () => writeEnabledField(characterId, before),
    () => writeEnabledField(characterId, after),
  )
}

export function removeFlattener(id) {
  const characterId = ownerOf(id)
  if (characterId == null) return
  editFlatteners(characterId, (items) => items.filter((it) => it.id !== id))
}

// Work the head centre / size / chin line out again (after the character or the pose changed).
export function refitFlattener(id) {
  const characterId = ownerOf(id)
  const rt = characterId != null ? runtimes.get(characterId) : null
  const item = rt && rt.items.get(id)
  if (!item || !item.bone) return
  const fit = fitFlattener(rt.model, item.bone)
  updateFlattener(id, { headSize: fit.headSize, pivotLocal: fit.pivotLocal, upLocal: fit.upLocal, start: fit.start }, { key: null })
}

// The bone a "head" flattener usually goes on: the rig's head bone, if it can be recognised.
export function findHeadBoneName(boneNames) {
  for (const name of boneNames || []) {
    const slot = classifyBone(name)
    if (slot && slot.split('.')[0] === 'head') return name
  }
  return null
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export function setFlattenerConfig(characterId, model, enabled, items) {
  if (!characterId || !model) return
  let rt = runtimes.get(characterId)
  if (!rt) {
    rt = { model, enabled: enabled !== false, items: new Map() }
    runtimes.set(characterId, rt)
  }
  rt.model = model
  rt.enabled = enabled !== false
  const list = Array.isArray(items) ? items : []
  const wanted = new Set(list.map((it) => it.id))
  for (const [id, item] of [...rt.items]) {
    if (!wanted.has(id)) {
      disposeGuide(item)
      rt.items.delete(id)
    }
  }
  for (const cfg of list) {
    let item = rt.items.get(cfg.id)
    if (!item) {
      item = { cfg, bone: null, pivotLocal: new THREE.Vector3(), upLocal: new THREE.Vector3(0, 1, 0), guide: null }
      rt.items.set(cfg.id, item)
    }
    item.cfg = cfg
    if (!item.bone || item.bone.name !== cfg.boneName) item.bone = findBone(model, cfg.boneName)
    item.pivotLocal.fromArray(cfg.pivotLocal || [0, 0, 0])
    item.upLocal.fromArray(cfg.upLocal || [0, 1, 0]).normalize()
  }
  if (list.length) bindMeshes(characterId, model)
  k.requestRender()
}

export function clearFlattener(characterId) {
  const rt = runtimes.get(characterId)
  if (!rt) return
  for (const item of rt.items.values()) disposeGuide(item)
  runtimes.delete(characterId)
  k.requestRender()
}

export function setFlattenerEnabledFor(characterId, enabled) {
  const rt = runtimes.get(characterId)
  if (rt) rt.enabled = !!enabled
  k.requestRender()
}

// Hook every mesh of the character so its flattener numbers are in the shader exactly while it is drawn.
//
// The outline effect draws every mesh a second time, and for that pass it REPLACES the mesh's
// onBeforeRender with its own (and puts the old one back afterwards). A plain function here would be
// swapped out, the outline would be drawn without the flattener and show up as a dark ghost of the
// unflattened shape. So onBeforeRender is an accessor: whatever is assigned to it runs AFTER ours, and
// putting our own function back restores what was there before.
function bindMeshes(characterId, model) {
  for (const mesh of model.meshes || []) {
    mesh.userData.flattenerCharacter = characterId
    if (hooked.has(mesh)) continue
    hooked.add(mesh)
    const base = mesh.onBeforeRender
    let inner = base
    const composite = function onBeforeRender(...args) {
      fillUniforms(this)
      inner.apply(this, args)
    }
    Object.defineProperty(mesh, 'onBeforeRender', {
      configurable: true,
      enumerable: true,
      get: () => composite,
      set: (fn) => {
        // our own function handed back (the outline effect restoring what it read): back to the original
        inner = fn === composite || typeof fn !== 'function' ? base : fn
      },
    })
    const after = mesh.onAfterRender
    mesh.onAfterRender = function onAfterRender(...args) {
      after.apply(this, args)
      flatCount.value = 0
    }
  }
}

// Called by materials.js when the character's parts are (re)styled, to pick up meshes that appeared.
export function refreshFlattenerMeshes(characterId, model) {
  const rt = runtimes.get(characterId)
  if (rt && rt.items.size) bindMeshes(characterId, model || rt.model)
}

// An aid mesh drawn over a character mesh (the body-part highlight) gets that mesh's flattening,
// so it lands exactly on the flattened surface instead of on the unflattened shape.
export function followFlattener(overlay, source) {
  overlay.onBeforeRender = function onBeforeRender() {
    fillUniforms(source)
  }
  overlay.onAfterRender = function onAfterRender() {
    flatCount.value = 0
  }
}

function fillUniforms(mesh) {
  flatCount.value = 0
  if (mesh.userData.flatOff) return
  const rt = runtimes.get(mesh.userData.flattenerCharacter)
  if (!rt || !rt.enabled) return
  let n = 0
  for (const item of rt.items.values()) {
    const cfg = item.cfg
    if (n >= MAX_FLATTENERS) break
    if (!cfg.enabled || !(cfg.strength > 0) || !item.bone) continue
    item.bone.matrixWorld.decompose(_p, _q, _s)
    const scale = (Math.abs(_s.x) + Math.abs(_s.y) + Math.abs(_s.z)) / 3 || 1
    const size = Math.max(1e-9, (cfg.headSize || 1) * scale)
    flatPivot.value[n].copy(item.pivotLocal).applyMatrix4(item.bone.matrixWorld)
    flatUp.value[n].copy(item.upLocal).applyQuaternion(_q).normalize()
    flatParams.value[n].set(
      Math.min(1, Math.max(0, cfg.strength)),
      (cfg.start ?? DEFAULT_START) * size,
      Math.max(1e-5, (cfg.falloff ?? DEFAULT_FALLOFF) * size),
      Math.min(1, Math.max(0, cfg.thickness ?? 0.04)),
    )
    flatMore.value[n].set(
      Math.min(1, Math.max(0, cfg.shading ?? 1)),
      mesh.userData.flatShade === 0 ? 0 : 1,
      Math.min(1, Math.max(0, cfg.keepScreen ?? 0)),
      Math.min(1, Math.max(0, cfg.shadingEdge ?? DEFAULT_EDGE)),
    )
    n++
  }
  flatCount.value = n
}

// ---------------------------------------------------------------------------
// Guide: the chin line drawn in the viewport so it can be placed by eye
// ---------------------------------------------------------------------------

export function setFlattenerGuideVisible(visible) {
  k.guidesOn = !!visible
  if (!k.guidesOn) for (const rt of runtimes.values()) for (const item of rt.items.values()) if (item.guide) item.guide.visible = false
  k.requestRender()
}

export function setFlattenerGuidesAllowed(allowed) {
  k.visible = !!allowed
  if (!allowed) for (const rt of runtimes.values()) for (const item of rt.items.values()) if (item.guide) item.guide.visible = false
}

function makeGuide() {
  const group = new THREE.Group()
  group.name = 'flattener-guide'
  const ring = (color, opacity) => {
    const pts = []
    for (let i = 0; i <= 48; i++) pts.push(new THREE.Vector3(Math.cos((i / 48) * Math.PI * 2), 0, Math.sin((i / 48) * Math.PI * 2)))
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }),
    )
    line.renderOrder = 998
    line.material.userData.outlineParameters = { visible: false }
    return line
  }
  group.userData.chin = ring(0x38e8ff, 0.95) // everything above this is flattened fully
  group.userData.fade = ring(0x38e8ff, 0.35) // ...fading out down to here
  group.add(group.userData.chin, group.userData.fade)
  return group
}

function disposeGuide(item) {
  if (!item.guide) return
  if (item.guide.parent) item.guide.parent.remove(item.guide)
  item.guide.traverse((o) => {
    if (o.geometry) o.geometry.dispose()
    if (o.material) o.material.dispose()
  })
  item.guide = null
}

// Once per rendered frame (only does work while the guide is switched on).
export function updateFlattenerGuides() {
  if (!k.scene) return
  if (!k.guidesOn || !k.visible) return
  for (const rt of runtimes.values()) {
    for (const item of rt.items.values()) {
      const cfg = item.cfg
      const show = rt.enabled && cfg.enabled && item.bone
      if (!show) {
        if (item.guide) item.guide.visible = false
        continue
      }
      if (!item.guide) {
        item.guide = makeGuide()
        k.scene.add(item.guide)
      }
      item.bone.updateWorldMatrix(true, false)
      item.bone.matrixWorld.decompose(_p, _q, _s)
      const scale = (Math.abs(_s.x) + Math.abs(_s.y) + Math.abs(_s.z)) / 3 || 1
      const size = (cfg.headSize || 1) * scale
      const up = item.upLocal.clone().applyQuaternion(_q).normalize()
      const centre = item.pivotLocal.clone().applyMatrix4(item.bone.matrixWorld)
      const quat = new THREE.Quaternion().setFromUnitVectors(_up, up)
      const g = item.guide
      g.visible = true
      g.position.copy(centre)
      g.quaternion.copy(quat)
      const radius = size * 0.6
      g.userData.chin.position.set(0, (cfg.start ?? DEFAULT_START) * size, 0)
      g.userData.chin.scale.setScalar(radius)
      g.userData.fade.position.set(0, ((cfg.start ?? DEFAULT_START) - (cfg.falloff ?? DEFAULT_FALLOFF)) * size, 0)
      g.userData.fade.scale.setScalar(radius)
    }
  }
}

export function getFlattenerRuntime(characterId) {
  return runtimes.get(characterId) || null
}
