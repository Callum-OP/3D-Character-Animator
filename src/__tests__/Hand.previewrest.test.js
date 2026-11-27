// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { analyseHands, analyticHandPose, handPoseToBoneQuats, restQuatLookup } from '../three/handPose.js'

// The Pose Library previews and thumbnails load the shipped example character on their own, outside the scene, so
// they have to analyse its hands against the rest rotations the model really has. Assuming every bone is unrotated
// at rest turned the thumb the wrong way on the example character, so previews disagreed with the scene.
async function loadExample() {
  const file = fs.readFileSync('public/models/Base_rigged.glb')
  const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), '', resolve, reject,
  ))
  const bones = []
  gltf.scene.traverse((object) => { if (object.isBone) bones.push(object) })
  gltf.scene.updateWorldMatrix(true, true)
  const rest = bones.map((object) => ({ object, quaternion: object.quaternion.clone() }))
  return { bones, rest }
}

const angleTo = (array, quaternion) => new THREE.Quaternion().fromArray(array).angleTo(quaternion)

describe('hand previews on the example character', () => {
  it('restQuatLookup gives each bone its own rest rotation, as a copy', async () => {
    const { bones, rest } = await loadExample()
    const restOf = restQuatLookup(rest)
    const thumb = bones.find((bone) => bone.name === 'RightHandThumb1')
    expect(restOf(thumb).angleTo(thumb.quaternion)).toBeLessThan(1e-6)
    expect(restOf(thumb)).not.toBe(restOf(thumb))
    expect(restQuatLookup(null)(thumb).angleTo(new THREE.Quaternion())).toBe(0)
  })

  it('has hand bones that are not unrotated at rest (which is why the rest has to be passed in)', async () => {
    const { rest } = await loadExample()
    const rotated = rest.filter((item) => /Hand/.test(item.object.name) && item.quaternion.angleTo(new THREE.Quaternion()) > 0.01)
    expect(rotated.length).toBeGreaterThan(10)
  })

  it('a neutral hand pose leaves the fingers and thumb at rest when the real rest is used', async () => {
    const { bones, rest } = await loadExample()
    for (const side of ['L', 'R']) {
      const rig = analyseHands(bones, restQuatLookup(rest)).find((item) => item.side === side)
      expect(rig).toBeTruthy()
      const neutral = handPoseToBoneQuats(rig, analyticHandPose(rig, { curl: {}, spread: 0 }), 0)
      const moved = bones.filter((bone) => neutral[bone.name] && angleTo(neutral[bone.name], bone.quaternion) > 0.01)
      expect(moved.map((bone) => bone.name)).toEqual([])
    }
  })

  it('assuming unrotated bones does not (the thumb ends up about 40 degrees off)', async () => {
    const { bones } = await loadExample()
    const rig = analyseHands(bones, () => new THREE.Quaternion()).find((item) => item.side === 'R')
    const neutral = handPoseToBoneQuats(rig, analyticHandPose(rig, { curl: {}, spread: 0 }), 0)
    const thumb = bones.find((bone) => bone.name === 'RightHandThumb1')
    expect(angleTo(neutral.RightHandThumb1, thumb.quaternion)).toBeGreaterThan(0.5)
  })
})
