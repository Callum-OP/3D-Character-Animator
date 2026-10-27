import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import {
  initObjects, addObject, removeObject, applyAllObjectStyles, setObjectOutline, getObjectsForSave,
} from '../three/objects.js'
import { copyObjectById, pasteCopiedObject } from '../three/scene.js'
import { objectMenu } from '../panels/rowMenus.js'

let scene
beforeAll(() => {
  scene = new THREE.Scene()
  initObjects({
    scene, camera: new THREE.PerspectiveCamera(), renderer: { domElement: document.createElement('canvas') },
    controls: { enabled: true, locked: false }, requestRender: () => {}, getSceneScale: () => 2,
  })
})
beforeEach(() => {
  for (const o of [...useStore.getState().sceneObjects]) removeObject(o.id)
  useStore.setState({ sceneObjects: [], meshOverrides: {}, outlineEnabled: true })
})

function prop(name, file = null, meshes = 1) {
  const root = new THREE.Group()
  const made = []
  for (let i = 0; i < meshes; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    root.add(m)
    made.push(m)
  }
  const meta = addObject({ root }, name, 'glb', file)
  useStore.getState().addSceneObject(meta)
  return { id: meta.id, meshes: made, meta }
}
const style = (extra = {}) => ({
  mode: 'toon', toonSteps: 3, soften: 0, colorGrading: 'none', overrides: {},
  outlineWidth: 0.004, outlineColor: '#000000', outlineOpacity: 1, ...extra,
})
const params = (mesh) => mesh.material.userData.outlineParameters

describe('props are outlined by default, like the characters', () => {
  it('a new prop follows the style: no choice of its own', () => {
    const p = prop('Crate')
    expect(p.meta.outline).toBeNull()
    expect(useStore.getState().sceneObjects[0].outline).toBeNull()
  })

  it('is outlined whenever the style outlines things — no switching on needed', () => {
    const p = prop('Crate')
    applyAllObjectStyles(style())
    expect(params(p.meshes[0]).visible).toBe(true)
  })

  it('uses the same width, colour, opacity and softening as the character outline', () => {
    const p = prop('Crate')
    applyAllObjectStyles(style({ outlineWidth: 0.01, outlineColor: '#ff0000', outlineOpacity: 0.4, soften: 0.5 }))
    const o = params(p.meshes[0])
    expect(o.thickness).toBeCloseTo(0.005) // 0.01 softened by 50%
    expect(o.color).toEqual([1, 0, 0])
    expect(o.alpha).toBeCloseTo(0.4)
  })

  it('can be switched off for one prop, and the others keep theirs', () => {
    const a = prop('A')
    const b = prop('B')
    setObjectOutline(a.id, false)
    applyAllObjectStyles(style())
    expect(params(a.meshes[0]).visible).toBe(false)
    expect(params(b.meshes[0]).visible).toBe(true)
  })

  it('switching it off and back on, or back to "follow the style", works', () => {
    const p = prop('A')
    setObjectOutline(p.id, false)
    applyAllObjectStyles(style())
    expect(params(p.meshes[0]).visible).toBe(false)
    setObjectOutline(p.id, true)
    expect(params(p.meshes[0]).visible).toBe(true)
    setObjectOutline(p.id, false)
    setObjectOutline(p.id, null)
    expect(params(p.meshes[0]).visible).toBe(true)
  })

  it('a part switched off in the Parts panel stays off, and a part can be thinner', () => {
    const p = prop('Pair', null, 2)
    applyAllObjectStyles(style({ overrides: { [p.meshes[0].uuid]: { outline: false }, [p.meshes[1].uuid]: { outlineWidth: 0.001 } } }))
    expect(params(p.meshes[0]).visible).toBe(false)
    expect(params(p.meshes[1]).visible).toBe(true)
    expect(params(p.meshes[1]).thickness).toBeCloseTo(0.001)
  })

  it('what is drawn at all is still the style\'s own outline switch (applied to the whole renderer)', () => {
    // the per-prop flag never overrides the global one: it only says "not this one"
    const p = prop('A')
    applyAllObjectStyles(style())
    expect(params(p.meshes[0]).visible).toBe(true) // eligible; the renderer decides, from outlineEnabled
  })
})

describe('the choice is saved, and a copy keeps it', () => {
  it('writes only an explicit choice: off, on, or nothing for "follow the style"', () => {
    const auto = prop('Auto', new File(['x'], 'a.glb'))
    const off = prop('Off', new File(['x'], 'b.glb'))
    const on = prop('On', new File(['x'], 'c.glb'))
    setObjectOutline(off.id, false)
    setObjectOutline(on.id, true)
    const saved = getObjectsForSave()
    expect(saved.find((r) => r.name === 'Auto').outline).toBeUndefined()
    expect(saved.find((r) => r.name === 'Off').outline).toBe('off')
    expect(saved.find((r) => r.name === 'On').outline).toBe('on')
    expect(auto.id).toBeTruthy()
  })

  it('a copy of a prop with its outline switched off has it switched off too', () => {
    const p = prop('Crate')
    useStore.getState().setObjectOutline(p.id, false)
    setObjectOutline(p.id, false)
    copyObjectById(p.id)
    const pasted = pasteCopiedObject()
    expect(pasted.outline).toBe(false)
    expect(useStore.getState().sceneObjects.find((o) => o.id === pasted.id).outline).toBe(false)
  })

  it('a copy of an ordinary prop still follows the style', () => {
    const p = prop('Crate')
    copyObjectById(p.id)
    const pasted = pasteCopiedObject()
    expect(useStore.getState().sceneObjects.find((o) => o.id === pasted.id).outline).toBeNull()
  })
})

describe('the Ink outline entry in the object menu', () => {
  const entry = (outline) => ({ id: 1, name: 'Crate', kind: 'model', visible: true, outline, animationKey: 'k' })
  const item = (outline, outlineEnabled) => {
    const state = { ...useStore.getState(), sceneObjects: [entry(outline)], outlineEnabled }
    return objectMenu([entry(outline)], { boneNames: [] }, state).items.find((i) => i.id === 'outline')
  }
  it('is ticked by default when the style has outlines on, unticked when it does not', () => {
    expect(item(null, true).checked).toBe(true)
    expect(item(null, false).checked).toBe(false)
  })
  it('shows the prop\'s own choice when it has one', () => {
    expect(item(false, true).checked).toBe(false)
    expect(item(true, false).checked).toBe(true)
  })
})
