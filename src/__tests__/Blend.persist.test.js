import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'
import { installImageStubs } from './helpers/imageStubs.js'
import { triangleGlb } from './helpers/modelFixtures.js'
import { initObjects, getObjectsForSave } from '../three/objects.js'
import { addObjectFile, __setViewCameraRefsForTest } from '../three/scene.js'

// What a saved project keeps for an object imported from a .blend: the converted .glb.
let stubs
beforeAll(() => {
  stubs = installImageStubs()
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera()
  initObjects({ scene, camera, renderer: { domElement: document.createElement('canvas') }, controls: { enabled: true, locked: false }, requestRender: () => {} })
  __setViewCameraRefsForTest(camera, { target: new THREE.Vector3(), update() {} })
})
afterAll(() => stubs.restore())
beforeEach(() => {
  window.animare = { blender: { convert: vi.fn(async () => ({ ok: true, glb: triangleGlb(), warnings: [], blenderVersion: '4.0.2' })) } }
})
afterEach(() => {
  delete window.animare
})

describe('saving an object imported from a .blend', () => {
  it('the project stores the converted .glb, not the .blend — so reopening needs no Blender', async () => {
    const meta = await addObjectFile(new File([new Uint8Array(Buffer.from('BLENDER-v400'))], 'Hero.blend'))
    const saved = getObjectsForSave({}).find((o) => o.name === meta.name)
    expect(saved.fileName).toBe('Hero.glb')
    const head = new Uint8Array(await saved.blob.arrayBuffer()).slice(0, 4)
    expect(Array.from(head)).toEqual([0x67, 0x6c, 0x54, 0x46]) // 'glTF'
  })

  it('and the saved file reopens by itself', async () => {
    const meta = await addObjectFile(new File([new Uint8Array(Buffer.from('BLENDER-v400'))], 'Again.blend'))
    const saved = getObjectsForSave({}).find((o) => o.name === meta.name)
    delete window.animare
    const meta2 = await addObjectFile(new File([saved.blob], saved.fileName))
    expect(meta2.name).toBe('Again')
  })
})
