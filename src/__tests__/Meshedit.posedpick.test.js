import { describe, it, expect, beforeAll, vi } from 'vitest'
import * as THREE from 'three'
import { initMeshEdit, setMeshEditModel, setMeshEditEnabled, selectMesh } from '../three/meshedit.js'

// Regression test for: "mesh mode doesn't work while the character is
// posed". THREE.Mesh's built-in raycast tests against a SkinnedMesh's REST
// geometry, ignoring the skeleton entirely — so clicking a part that a bone
// has moved away from its rest position used to miss. meshedit.js now
// raycasts a posed proxy (rebuilt from applyBoneTransform) instead.
describe('mesh mode: click-to-select on a posed character', () => {
  let dom
  let picked

  beforeAll(() => {
    const scene = new THREE.Scene()

    // Orthographic camera looking straight down -Z; world x in [-10,10] maps
    // linearly onto NDC x in [-1,1], which keeps the click-position math simple.
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100)
    camera.position.set(0, 0, 10)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)

    dom = document.createElement('canvas')
    dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 })
    // jsdom doesn't implement pointer capture; TransformControls calls it on
    // pointerdown/up regardless of whether anything was actually grabbed.
    dom.setPointerCapture = () => {}
    dom.releasePointerCapture = () => {}
    const renderer = { domElement: dom }
    const controls = { enabled: true, locked: false }

    picked = null
    initMeshEdit({
      scene,
      camera,
      renderer,
      controls,
      requestRender: () => {},
      onSelect: (uuid) => {
        picked = uuid
      },
    })

    // A box, rigged to a single bone, bound while the bone sat at the origin
    // (identity bind pose) then moved 5 units on X — i.e. "posed". The
    // SkinnedMesh node itself never moves; only the skin deformation does,
    // exactly like an arm bending away from a T-pose.
    const bone = new THREE.Bone()
    bone.position.set(0, 0, 0)
    const skeleton = new THREE.Skeleton([bone])

    const geo = new THREE.BoxGeometry(2, 2, 2)
    const count = geo.attributes.position.count
    const skinIndices = []
    const skinWeights = []
    for (let i = 0; i < count; i += 1) {
      skinIndices.push(0, 0, 0, 0)
      skinWeights.push(1, 0, 0, 0)
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4))
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4))

    const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial())
    mesh.name = 'Arm'
    const root = new THREE.Group()
    root.add(bone)
    root.add(mesh)
    mesh.bind(skeleton)
    scene.add(root)

    // Pose: move the bone 5 units on X after binding.
    bone.position.set(5, 0, 0)
    scene.updateMatrixWorld(true)

    setMeshEditModel({ meshes: [mesh] })
    setMeshEditEnabled(true)
    mesh.__uuid = mesh.uuid
  })

  function clickAtWorldX(worldX) {
    // World x in [-10, 10] -> ndc in [-1, 1] -> client pixels over a 100x100 rect.
    const ndcX = worldX / 10
    const clientX = ((ndcX + 1) / 2) * 100
    const clientY = 50 // vertical centre; box is centred on Y
    dom.dispatchEvent(new MouseEvent('pointerdown', { clientX, clientY, button: 0 }))
    dom.dispatchEvent(new MouseEvent('pointerup', { clientX, clientY, button: 0 }))
  }

  it('selects the part where it is actually rendered (posed), not its rest position', () => {
    picked = null
    clickAtWorldX(5) // the box now visually sits at x=5
    expect(picked).toBeTruthy()
  })

  it('does not select at the old rest-pose location, which is now empty space', () => {
    selectMesh(null)
    picked = 'unset'
    clickAtWorldX(0) // nothing there any more — the box moved to x=5
    expect(picked).toBeNull()
  })
})