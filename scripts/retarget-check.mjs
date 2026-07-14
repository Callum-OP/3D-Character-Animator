// Headless retarget diagnostic: runs the app's actual BVH retarget pipeline
// (src/three/bvh.js) against a real GLB + BVH in Node and prints posture
// metrics, so retarget changes can be verified without clicking through the UI.
//
//   node scripts/retarget-check.mjs references/<model>.glb references/<clip>.bvh
//
// Textures are stripped from the GLB before parsing (no DOM in Node); geometry,
// skins and the node hierarchy are untouched, which is all retargeting needs.
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import {
  buildSlotMapping,
  buildNameMatch,
  mergeNames,
  retargetParsed,
} from '../src/three/bvh.js'

const [modelPath, bvhPath] = process.argv.slice(2)
if (!modelPath || !bvhPath) {
  console.error('usage: node scripts/retarget-check.mjs <model.glb> <clip.bvh>')
  process.exit(1)
}

// --- Load GLB (textures stripped so GLTFLoader works without a browser) -------
function stripTextures(glbBuf) {
  const jsonLen = glbBuf.readUInt32LE(12)
  const json = JSON.parse(glbBuf.slice(20, 20 + jsonLen).toString('utf8'))
  delete json.images
  delete json.textures
  delete json.samplers
  delete json.materials
  for (const mesh of json.meshes || [])
    for (const prim of mesh.primitives || []) delete prim.material
  let jsonStr = JSON.stringify(json)
  while (Buffer.byteLength(jsonStr) % 4) jsonStr += ' '
  const jsonBuf = Buffer.from(jsonStr)
  const rest = glbBuf.slice(20 + jsonLen) // remaining chunks (BIN) verbatim
  const out = Buffer.alloc(20 + jsonBuf.length + rest.length)
  glbBuf.copy(out, 0, 0, 12)
  out.writeUInt32LE(out.length, 8)
  out.writeUInt32LE(jsonBuf.length, 12)
  out.writeUInt32LE(0x4e4f534a, 16) // 'JSON'
  jsonBuf.copy(out, 20)
  rest.copy(out, 20 + jsonBuf.length)
  return out
}

const glb = stripTextures(fs.readFileSync(modelPath))
const gltf = await new Promise((resolve, reject) =>
  new GLTFLoader().parse(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '', resolve, reject),
)

// Collect refs the same way src/three/loadModel.js parseRoot does.
const root = gltf.scene
const skinnedMeshes = []
const boneSet = new Set()
root.traverse((o) => {
  if (o.isSkinnedMesh) {
    skinnedMeshes.push(o)
    if (o.skeleton) for (const b of o.skeleton.bones) boneSet.add(b)
  }
  if (o.isBone) boneSet.add(o)
})
const model = { root, skinnedMeshes, bones: [...boneSet] }
const scene = new THREE.Scene()
scene.add(root)
root.updateMatrixWorld(true)

// --- Load BVH ------------------------------------------------------------------
const bvh = new BVHLoader().parse(fs.readFileSync(bvhPath, 'utf8'))
const parsed = {
  skeleton: bvh.skeleton,
  clip: bvh.clip,
  bones: bvh.skeleton.bones.map((b) => b.name),
  name: path.basename(bvhPath, '.bvh'),
}

// --- Mapping (exactly what animation.js does) -----------------------------------
const targetNames = model.bones.map((b) => b.name)
const autoNames = buildNameMatch(targetNames, parsed.bones)
const slots = buildSlotMapping(targetNames, parsed.bones)
console.log('--- slot mapping (auto) ---')
for (const s of slots) console.log(`  ${s.label.padEnd(12)} ${(s.target || '—').padEnd(38)} <- ${s.source || '—'}`)
console.log(`--- name-match: ${Object.keys(autoNames).length} bones ---`)

const { names, hip } = mergeNames(autoNames, slots)

// --- Posture metric helpers ------------------------------------------------------
const wp = (obj) => obj.getWorldPosition(new THREE.Vector3())
function findBone(bones, name) {
  return bones.find((b) => b.name === name) || null
}
// Angle (deg) between two vectors.
const angle = (a, b) => THREE.MathUtils.radToDeg(a.angleTo(b))

// Posture snapshot from a set of named key bones (uses world positions).
function posture(get) {
  const hips = get('hips')
  const head = get('head')
  const upL = get('upperArm.L')
  const loL = get('lowerArm.L')
  const upR = get('upperArm.R')
  const loR = get('lowerArm.R')
  const thL = get('upperLeg.L')
  const thR = get('upperLeg.R')
  const out = {}
  if (hips && head) out.upTilt = angle(head.clone().sub(hips), new THREE.Vector3(0, 1, 0)).toFixed(1)
  if (upL && loL) out.armL = angle(loL.clone().sub(upL), new THREE.Vector3(0, -1, 0)).toFixed(1)
  if (upR && loR) out.armR = angle(loR.clone().sub(upR), new THREE.Vector3(0, -1, 0)).toFixed(1)
  if (thL && thR) {
    const across = thL.clone().sub(thR).normalize() // left-to-right axis
    out.hipsYaw = THREE.MathUtils.radToDeg(Math.atan2(across.z, across.x)).toFixed(1)
  }
  if (hips) out.hipsY = hips.y.toFixed(3)
  return out
}

// Key-bone getter for the TARGET rig via the confirmed slot mapping.
const slotTarget = Object.fromEntries(slots.map((s) => [s.key, s.target]))
function targetGet(key) {
  const b = slotTarget[key] && findBone(model.bones, slotTarget[key])
  return b ? wp(b) : null
}
// For the hips metric prefer the pelvis-ish mapped bone
function targetGetKey(key) {
  if (key === 'hips') {
    const b = slotTarget.hips && findBone(model.bones, slotTarget.hips)
    return b ? wp(b) : null
  }
  return targetGet(key)
}

// Key-bone getter for the SOURCE skeleton.
const slotSource = Object.fromEntries(slots.map((s) => [s.key, s.source]))
function sourceGet(key) {
  const b = slotSource[key] && findBone(bvh.skeleton.bones, slotSource[key])
  return b ? wp(b) : null
}

// Pose the BVH skeleton at frame i (same way retargetParsed does).
const srcByName = new Map(bvh.skeleton.bones.map((b) => [b.name, b]))
const srcTracks = []
const srcPosTracks = []
for (const tr of bvh.clip.tracks) {
  const mq = /^(.+)\.quaternion$/.exec(tr.name)
  if (mq && srcByName.has(mq[1])) srcTracks.push({ bone: srcByName.get(mq[1]), values: tr.values })
  const mp = /^(.+)\.position$/.exec(tr.name)
  if (mp && srcByName.has(mp[1])) srcPosTracks.push({ bone: srcByName.get(mp[1]), values: tr.values })
}
const times = bvh.clip.tracks.find((t) => /\.quaternion$/.test(t.name)).times
function poseSource(i) {
  for (const { bone, values } of srcTracks) {
    const o = i * 4
    bone.quaternion.set(values[o], values[o + 1], values[o + 2], values[o + 3])
  }
  for (const { bone, values } of srcPosTracks) {
    const o = i * 3
    bone.position.set(values[o], values[o + 1], values[o + 2])
  }
  bvh.skeleton.bones[0].updateWorldMatrix(false, true)
}

// --- Rest posture (before retarget) ----------------------------------------------
console.log('\n--- target rest posture ---')
console.log(posture(targetGetKey))

// --- Retarget (the app's code path) ------------------------------------------------
const { clip, matched, total } = retargetParsed(parsed, model, names, hip, 'test')
console.log(`\nretargeted: ${matched}/${total} bones mapped`)

console.log('\n--- target posture AFTER retarget returns (should equal rest) ---')
root.updateMatrixWorld(true)
console.log(posture(targetGetKey))

// --- Play and compare ---------------------------------------------------------------
const mixer = new THREE.AnimationMixer(model.root)
const action = mixer.clipAction(clip)
action.setLoop(THREE.LoopOnce, 0)
action.clampWhenFinished = true
action.play()

const frames = [0, Math.floor(times.length / 4), Math.floor(times.length / 2), times.length - 1]
for (const f of frames) {
  mixer.setTime(times[f])
  root.updateMatrixWorld(true)
  poseSource(f)
  console.log(`\n=== frame ${f} (t=${times[f].toFixed(2)}s) ===`)
  console.log('  source:', posture(sourceGet))
  console.log('  target:', posture(targetGetKey))
}

// BVH root translation range (what a rotation-only retarget drops).
const posTrack = bvh.clip.tracks.find((t) => /\.position$/.test(t.name))
if (posTrack) {
  const v = posTrack.values
  let min = [Infinity, Infinity, Infinity]
  let max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < v.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], v[i + k])
      max[k] = Math.max(max[k], v[i + k])
    }
  console.log('\nBVH hip translation range (dropped by rotation-only retarget):')
  console.log(`  X ${(max[0] - min[0]).toFixed(1)}  Y ${(max[1] - min[1]).toFixed(1)}  Z ${(max[2] - min[2]).toFixed(1)}`)
}
