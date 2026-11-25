import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { loadModel } from '../three/loadModel.js'
import { installImageStubs } from './helpers/imageStubs.js'
import { initObjects } from '../three/objects.js'
import { initPosing } from '../three/posing.js'
import { initMeshEdit } from '../three/meshedit.js'
import { __seedCharacterForTest, __setViewCameraRefsForTest, applyProjectData } from '../three/scene.js'
import { useStore } from '../store.js'
import { initAnimation } from '../three/animation.js'

describe('reloading a project with a clip selected', () => {
  it('restores the clip length so Play is enabled straight away', async () => {
    const data = new Float32Array([0, 1, 0, 0, 0, 1, 0, 0])
    const gltf = {
      asset: { version: '2.0' }, scenes: [{ nodes: [0] }], scene: 0, nodes: [{ name: 'Root' }],
      buffers: [{ uri: `data:application/octet-stream;base64,${Buffer.from(data.buffer).toString('base64')}`, byteLength: data.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }, { buffer: 0, byteOffset: 8, byteLength: 24 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] }, { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' }],
      animations: [{ name: 'Walk', samplers: [{ input: 0, output: 1 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }],
    }
    const file = new File([JSON.stringify(gltf)], 'actor.gltf')
    const stubs = installImageStubs()
    try {
      const model = await loadModel(file, { autoDecimate: false })
      const refs0 = { requestRender: () => {}, suspendPosing: () => {}, resumePosing: () => {}, onTime: () => {}, setContinuousRender: () => {}, onEnded: () => {} }
      initAnimation(refs0)
      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera()
      const controls = { enabled: true, locked: false, target: new THREE.Vector3(), update: () => {} }
      const refs = { scene, camera, controls, renderer: { domElement: document.createElement('canvas') }, requestRender: () => {} }
      initObjects(refs); initPosing(refs); initMeshEdit(refs)
      __setViewCameraRefsForTest(camera, controls)
      __seedCharacterForTest('seed', model, scene)
      await applyProjectData({ format: 'project-v2', characters: [{ blob: file, fileName: file.name, isActive: true, playbackSource: 'clip', activeClipName: 'Walk' }] })
      const s = useStore.getState()
      expect(s.activeClipName).toBe('Walk')
      expect(s.playbackSource).toBe('clip')
      expect(s.duration).toBeGreaterThan(0)
    } finally { stubs.restore() }
  })
})
