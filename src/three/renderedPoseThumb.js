import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { analyseHands, analyticHandPose, handPoseToBoneQuats, handPosesFromBVH, migrateHandPose, rigsForSide } from './handPose.js'
import { applyClipFrame, parsedBVHResolver, posedBoneBounds, representativeClipTime } from './poseThumb.js'
import { loadPresetPoseText, loadPresetText } from './poseLibraryPresets.js'
import { retargetLibraryPreview, retargetPreviewBVH } from './posePreviewRetarget.js'

const SIZE = 192
let runtimePromise
let renderQueue = Promise.resolve()

function normalizeName(name) {
  return String(name || '').replace(/^(mixamorig)?[:_\-.]*/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function findBone(root, sourceName) {
  if (!root || !sourceName) return null
  const exact = root.getObjectByName(sourceName) || root.getObjectByProperty('uuid', sourceName)
  if (exact) return exact
  const wanted = normalizeName(sourceName)
  let found = null
  root.traverse((object) => {
    if (!found && object.isBone) {
      const name = normalizeName(object.name)
      if (name === wanted || name.endsWith(wanted) || wanted.endsWith(name)) found = object
    }
  })
  return found
}

async function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = new Promise(async (resolve, reject) => {
      let renderer
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
      } catch (error) {
        reject(error)
        return
      }
      renderer.setSize(SIZE, SIZE, false)
      renderer.setPixelRatio(1)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.setClearColor(0x000000, 0)
      const scene = new THREE.Scene()
      scene.add(new THREE.HemisphereLight(0xffffff, 0x30343a, 2.4))
      const key = new THREE.DirectionalLight(0xffffff, 2.8)
      key.position.set(3, 5, 4)
      scene.add(key)
      const rim = new THREE.DirectionalLight(0xbad8ff, 1.25)
      rim.position.set(-4, 2, -3)
      scene.add(rim)
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100)
      try {
        const gltf = await new GLTFLoader().loadAsync('/models/Base_rigged.glb')
        const root = gltf.scene
        root.updateWorldMatrix(true, true)
        const bounds = new THREE.Box3().setFromObject(root)
        const size = bounds.getSize(new THREE.Vector3())
        const scale = 2 / Math.max(size.y, 0.001)
        root.scale.setScalar(scale)
        root.position.set(0, -bounds.min.y * scale, 0)
        root.updateWorldMatrix(true, true)
        const rest = []
        root.traverse((object) => {
          if (object.isBone) rest.push({
            object,
            position: object.position.clone(),
            quaternion: object.quaternion.clone(),
          })
        })
        scene.add(root)
        resolve({ renderer, scene, camera, root, rest })
      } catch (error) {
        renderer.dispose()
        reject(error)
      }
    })
  }
  return runtimePromise
}

function reset(runtime) {
  for (const item of runtime.rest) {
    item.object.position.copy(item.position)
    item.object.quaternion.copy(item.quaternion)
  }
  runtime.root.updateWorldMatrix(true, true)
}

function applyBoneTracks(root, tracks, sourceName = (name) => name) {
  for (const track of tracks) {
    const match = /^(.+)\.(quaternion|position)$/.exec(track.name)
    if (!match) continue
    const bone = findBone(root, sourceName(match[1]))
    if (!bone) continue
    const values = track.values
    if (match[2] === 'quaternion') bone.quaternion.set(values[0] || 0, values[1] || 0, values[2] || 0, values[3] ?? 1)
    else bone.position.set(values[0] || 0, values[1] || 0, values[2] || 0)
  }
}

async function applyEntry(runtime, entry) {
  const { root } = runtime
  if (entry.kind === 'body') {
    if (entry.source === 'preset') {
      const { BVHLoader } = await import('three/examples/jsm/loaders/BVHLoader.js')
      const parsed = new BVHLoader().parse(await loadPresetPoseText(entry))
      const sourceName = parsedBVHResolver(parsed)
      applyBoneTracks(root, parsed.clip.tracks, sourceName)
    } else if (entry.data?.rig) {
      applyClipFrame(root, retargetLibraryPreview(entry, root), 0, (name) => findBone(root, name))
    } else {
      for (const [name, value] of Object.entries(entry.data?.bones || {})) {
        const bone = findBone(root, name)
        if (bone && value?.length >= 4) bone.quaternion.set(value[0], value[1], value[2], value[3])
      }
    }
  } else if (entry.kind === 'hand') {
    const bones = []
    root.traverse((object) => { if (object.isBone) bones.push(object) })
    const rigs = rigsForSide(analyseHands(bones, () => new THREE.Quaternion()), 'R')
    let poses
    if (entry.source === 'basic') {
      poses = Object.fromEntries(rigs.map((rig) => [rig.side, analyticHandPose(rig, entry)]))
    } else if (entry.source === 'preset') {
      const { BVHLoader } = await import('three/examples/jsm/loaders/BVHLoader.js')
      poses = handPosesFromBVH(new BVHLoader().parse(await loadPresetPoseText(entry)))
    } else {
      poses = Object.fromEntries(Object.entries(entry.data?.poses || {}).map(([side, pose]) => [side, migrateHandPose(pose)]))
    }
    for (const rig of rigs) {
      const pose = poses?.[rig.side] || poses?.L || poses?.R
      if (!pose) continue
      for (const [name, value] of Object.entries(handPoseToBoneQuats(rig, pose))) {
        const bone = root.getObjectByName(name)
        if (bone) bone.quaternion.set(value[0], value[1], value[2], value[3])
      }
    }
  } else if (entry.kind === 'animation') {
    let clip
    let resolver = null
    if (entry.source === 'preset') {
      clip = await retargetPreviewBVH(await loadPresetText(entry), root, entry.name)
    } else {
      const json = entry.data?.clip
      clip = entry.data?.rig ? retargetLibraryPreview(entry, root) : THREE.AnimationClip.parse(json?.clip || json)
    }
    applyClipFrame(root, clip, representativeClipTime(clip), (name) => findBone(root, resolver?.(name) || name))
  }
  root.updateWorldMatrix(true, true)
}

function frame(runtime, entry) {
  const { root, camera } = runtime
  root.updateWorldMatrix(true, true)
  if (entry.kind === 'hand') {
    const bones = []
    root.traverse((object) => { if (object.isBone) bones.push(object) })
    const rigs = analyseHands(bones, () => new THREE.Quaternion())
    const rig = rigs.find((item) => item.side === 'R') || rigs[0]
    const hand = rig?.hand
    const box = new THREE.Box3()
    const points = []
    if (hand) {
      hand.traverse((object) => {
        if (!object.isBone) return
        const point = object.getWorldPosition(new THREE.Vector3())
        points.push(point)
        box.expandByPoint(point)
      })
    }
    const center = box.isEmpty() ? new THREE.Vector3(0, 1.5, 0) : box.getCenter(new THREE.Vector3())
    const palmUp = rig?.frame
      ? new THREE.Vector3(0, 1, 0).applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()).multiply(rig.frame.handLocal))
      : new THREE.Vector3(0, 1, 0)
    const palmNormal = rig?.frame
      ? new THREE.Vector3(0, 0, 1).applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()).multiply(rig.frame.handLocal))
      : new THREE.Vector3(0, 0, 1)
    const palmRight = palmUp.clone().cross(palmNormal).normalize()
    let width = 0.15
    let height = 0.15
    for (const point of points) {
      const offset = point.clone().sub(center)
      width = Math.max(width, Math.abs(offset.dot(palmRight)))
      height = Math.max(height, Math.abs(offset.dot(palmUp)))
    }
    const half = Math.max(width, height) * 1.45
    camera.left = -half
    camera.right = half
    camera.top = half
    camera.bottom = -half
    camera.position.copy(center).add(palmNormal.multiplyScalar(Math.max(half * 3, 1)))
    camera.up.copy(palmUp)
    camera.lookAt(center)
  } else {
    const box = posedBoneBounds(root, entry.kind === 'animation' ? 0.16 : 0.12)
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const half = Math.max(size.y, size.x) * 0.56
    camera.left = -half
    camera.right = half
    camera.top = half
    camera.bottom = -half
    camera.position.set(center.x, center.y, center.z + Math.max(size.z, half) * 3)
    camera.up.set(0, 1, 0)
    camera.lookAt(center)
  }
  camera.updateProjectionMatrix()
}

async function capture(entry) {
  const runtime = await loadRuntime()
  reset(runtime)
  await applyEntry(runtime, entry)
  frame(runtime, entry)
  runtime.renderer.render(runtime.scene, runtime.camera)
  return new Promise((resolve, reject) => {
    runtime.renderer.domElement.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not capture thumbnail')), 'image/webp', 0.82)
  })
}

export function renderedPoseThumb(entry) {
  const next = renderQueue.then(() => capture(entry), () => capture(entry))
  renderQueue = next.catch(() => undefined)
  return next
}
