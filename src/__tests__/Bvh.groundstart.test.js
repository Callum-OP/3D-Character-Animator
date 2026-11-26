import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { initAnimation, setAnimationModel, selectClip, exportAnimationBVH, beginBVHImport, applyBVHRetarget, getImportedClipsData } from '../three/animation.js'

// Hips -> LeftUpLeg -> LeftFoot, RightUpLeg -> RightFoot. `height` is the standing hip height; legs scale with it.
function buildModel(height) {
  const root = new THREE.Group()
  const mk = (name, x, y) => {
    const b = new THREE.Bone()
    b.name = name
    b.position.set(x, y, 0)
    return b
  }
  const hips = mk('Hips', 0, height)
  const lUp = mk('LeftUpLeg', 0.1, -0.1 * height)
  const rUp = mk('RightUpLeg', -0.1, -0.1 * height)
  const lFoot = mk('LeftFoot', 0, -0.5 * height)
  const rFoot = mk('RightFoot', 0, -0.5 * height)
  hips.add(lUp, rUp)
  lUp.add(lFoot)
  rUp.add(rFoot)
  root.add(hips)
  const bones = [hips, lUp, rUp, lFoot, rFoot]
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  mesh.bind(new THREE.Skeleton(bones))
  root.add(mesh)
  root.updateMatrixWorld(true)
  return { root, bones, skinnedMeshes: [mesh], meshes: [], skeleton: mesh.skeleton, clips: [], info: {} }
}

const refs = { requestRender: () => {}, suspendPosing: () => {}, resumePosing: () => {}, onTime: () => {}, setContinuousRender: () => {} }

describe('BVH import start height', () => {
  it('starts the clip with the feet on the same ground the character stands on, whatever its proportions', async () => {
    // A clip authored on a short rig whose first frame has the hips raised and one thigh swung up.
    const source = buildModel(1)
    const q = (angle) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle).toArray()
    source.clips = [new THREE.AnimationClip('Step', 1, [
      new THREE.QuaternionKeyframeTrack('LeftUpLeg.quaternion', [0, 1], [...q(-0.9), ...q(0)]),
      new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 1.15, 0, 0, 1, 0]),
    ])]
    initAnimation(refs)
    setAnimationModel(source, 'ground-src')
    selectClip('Step')
    const text = exportAnimationBVH({ tracks: {}, root: [] }, 10, 1, 'Step', 'clip')

    // Import it onto a taller character standing with its feet at y = 0.
    const target = buildModel(1.6)
    target.bones[0].position.y = 1.6
    setAnimationModel(target, 'ground-tgt')
    const info = await beginBVHImport(new File([text], 'step.bvh'))
    const { name } = await applyBVHRetarget(info.slots)
    const saved = getImportedClipsData('ground-tgt').find((c) => c.clip.name === name)
    expect(saved).toBeTruthy()

    target.root.updateWorldMatrix(true, true)
    const restGround = Math.min(target.bones[3].matrixWorld.elements[13], target.bones[4].matrixWorld.elements[13])
    const mixer = new THREE.AnimationMixer(target.root)
    mixer.clipAction(THREE.AnimationClip.parse(saved.clip)).play()
    mixer.setTime(0)
    target.root.updateWorldMatrix(true, true)
    const startGround = Math.min(target.bones[3].matrixWorld.elements[13], target.bones[4].matrixWorld.elements[13])
    expect(startGround).toBeCloseTo(restGround, 3)
  })
})
