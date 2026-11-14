import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { makeClipNamesUnique } from '../three/clipNames.js'
import { loadModel } from '../three/loadModel.js'
import { installImageStubs } from './helpers/imageStubs.js'
import { initObjects } from '../three/objects.js'
import { initPosing } from '../three/posing.js'
import { initMeshEdit } from '../three/meshedit.js'
import { __seedCharacterForTest, __setViewCameraRefsForTest, applyProjectData, getProjectData } from '../three/scene.js'
import { useStore } from '../store.js'
import {
  addGeneratedClip, exportClipJSON, getImportedClipsData, importClipJSON,
  initAnimation, restoreImportedClips, selectClip, setAnimationModel,
} from '../three/animation.js'

const clip = (name, duration) => new THREE.AnimationClip(name, duration, [])

describe('clip names', () => {
  it('makes baked names unique without stealing names already present later in the model', () => {
    const clips = [clip('Walk', 1), clip('Walk', 2), clip('Walk 2', 3), clip('', 4), clip('', 5)]
    makeClipNamesUnique(clips)
    expect(clips.map((c) => c.name)).toEqual(['Walk', 'Walk 3', 'Walk 2', 'Clip', 'Clip 2'])
  })

  it('loads duplicate model clips and preserves legacy project selections across saves', async () => {
    const data = new Float32Array([0, 1, 0, 0, 0, 1, 0, 0])
    const gltf = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      scene: 0,
      nodes: [{ name: 'Root' }],
      buffers: [{ uri: `data:application/octet-stream;base64,${Buffer.from(data.buffer).toString('base64')}`, byteLength: data.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }, { buffer: 0, byteOffset: 8, byteLength: 24 }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
        { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
      ],
      animations: [0, 1].map(() => ({
        name: 'Walk',
        samplers: [{ input: 0, output: 1 }],
        channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
      })),
    }
    const file = new File([JSON.stringify(gltf)], 'actor.gltf')
    const stubs = installImageStubs()
    try {
      const model = await loadModel(file, { autoDecimate: false })
      expect(model.info.clipNames).toEqual(['Walk', 'Walk 2'])
      expect(model.originalClipNames).toEqual(['Walk', 'Walk'])
      initAnimation({ requestRender: () => {}, suspendPosing: () => {}, resumePosing: () => {}, onTime: () => {} })
      setAnimationModel(model, 'loaded-clip-names')
      expect(selectClip('Walk')).toBe(1)
      expect(selectClip('Walk 2')).toBe(1)

      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera()
      const controls = { enabled: true, locked: false, target: new THREE.Vector3(), update: () => {} }
      const refs = { scene, camera, controls, renderer: { domElement: document.createElement('canvas') }, requestRender: () => {} }
      initObjects(refs)
      initPosing(refs)
      initMeshEdit(refs)
      __setViewCameraRefsForTest(camera, controls)
      __seedCharacterForTest('seed', model, scene)
      const saved = {
        format: 'project-v2',
        characters: [{
          blob: file, fileName: file.name, isActive: true, playbackSource: 'clip',
          activeClipName: 'Walk 2',
          importedClips: [clip('Walk 2', 2).toJSON(), clip('Walk 2', 3).toJSON()],
          importedClipNames: ['Walk 2', 'Walk 2'],
        }],
      }
      await applyProjectData(saved)
      expect(useStore.getState().importedClipNames).toEqual(['Walk 2 2', 'Walk 2 3'])
      expect(useStore.getState().activeClipName).toBe('Walk 2 2')
      expect(selectClip('Walk 2 2')).toBe(2)
      expect(selectClip('Walk 2 3')).toBe(3)

      await applyProjectData(getProjectData())
      expect(useStore.getState().importedClipNames).toEqual(['Walk 2 2', 'Walk 2 3'])
      expect(useStore.getState().activeClipName).toBe('Walk 2 2')
    } finally {
      stubs.restore()
    }
  })

  it('restores legacy duplicates and keeps imported clips individually selectable and persistent', () => {
    initAnimation({ requestRender: () => {}, suspendPosing: () => {}, resumePosing: () => {}, onTime: () => {} })
    setAnimationModel({ root: new THREE.Group(), bones: [], clips: [clip('Walk', 1)] }, 'clip-names')
    const saved = [clip('Walk', 2), clip('Walk', 3), clip('Walk 2', 4)].map((c) => c.toJSON())
    const restored = restoreImportedClips('clip-names', saved)
    expect(restored.map((c) => c.name)).toEqual(['Walk 3', 'Walk 4', 'Walk 2'])
    expect(selectClip('Walk 3')).toBe(2)
    expect(selectClip('Walk 4')).toBe(3)
    expect(selectClip('Walk 2')).toBe(4)
    expect(getImportedClipsData('clip-names').map((c) => c.clip.name)).toEqual(['Walk 3', 'Walk 4', 'Walk 2'])
    expect(importClipJSON(exportClipJSON('Walk 2'))).toBe('Walk 2 2')
    expect(addGeneratedClip(clip('Walk', 5))).toBe('Walk 5')
  })
})
