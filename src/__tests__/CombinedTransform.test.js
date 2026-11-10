import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import { CombinedTransform } from '../three/combinedTransform.js'

let camera, dom, target

function make(options) {
  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 5)
  camera.updateMatrixWorld(true)
  dom = document.createElement('canvas')
  const scene = new THREE.Scene()
  target = new THREE.Object3D()
  scene.add(target)
  const t = new CombinedTransform(camera, dom, options)
  scene.add(t.getHelper())
  return t
}

const names = (part, kind, mode) => [...new Set(part._gizmo[kind][mode].children.map((c) => c.name))].sort()
// Size of one gizmo unit on screen for a layer (camera 5 units away, 50 degree view), in world units
const unit = (part) => (5 * 1.9 * Math.tan((Math.PI * 25) / 180) * part.size) / 4
const attached = (t) => ['translate', 'rotate', 'scale'].filter((m) => t._parts[m].object)

describe('CombinedTransform single modes', () => {
  let t
  beforeEach(() => { t = make() })

  it('is one ordinary gizmo in each single mode', () => {
    t.attach(target)
    for (const mode of ['translate', 'rotate', 'scale']) {
      t.setMode(mode)
      expect(t.mode).toBe(mode)
      expect(attached(t)).toEqual([mode])
      expect(t.object).toBe(target)
      expect(t.activeMode).toBe(mode)
    }
    t.detach()
    expect(attached(t)).toEqual([])
    expect(t.object).toBeUndefined()
  })

  it('keeps every handle in the single modes', () => {
    t.setMode('rotate')
    expect(names(t._parts.rotate, 'gizmo', 'rotate')).toEqual(['E', 'X', 'XYZE', 'Y', 'Z'])
    expect(names(t._parts.translate, 'gizmo', 'translate')).toContain('XYZ')
  })
})

describe('CombinedTransform combined mode', () => {
  it('layers Move, Rotate and Resize on the same object with the clashing handles left out', () => {
    const t = make()
    t.attach(target)
    t.setMode('combined')
    expect(attached(t)).toEqual(['translate', 'rotate', 'scale'])
    expect(names(t._parts.translate, 'gizmo', 'translate')).toEqual(['X', 'XY', 'XZ', 'Y', 'YZ', 'Z'])
    expect(names(t._parts.rotate, 'gizmo', 'rotate')).toEqual(['E', 'X', 'Y', 'Z']) // axis rings + the outer ring
    expect(names(t._parts.rotate, 'picker', 'rotate')).toEqual(['E', 'X', 'Y', 'Z']) // no free-rotate sphere to click through
    expect(names(t._parts.scale, 'gizmo', 'scale')).toEqual(['X', 'XYZ', 'Y', 'Z'])
    // Move is the longest, Resize the smallest
    expect(t._parts.scale.size).toBeLessThan(t._parts.rotate.size)
    expect(t._parts.rotate.size).toBeLessThanOrEqual(t._parts.translate.size)
    // Rotate's outer ring (0.75 of its size) stays outside the tips of Move's arrows (0.6 of its size)
    expect(0.75 * t._parts.rotate.size).toBeGreaterThan(0.6 * t._parts.translate.size)
  })

  it('makes the outer rotate ring grey, and puts everything back when leaving combined mode', () => {
    const t = make()
    t.setMode('combined')
    const ring = t._parts.rotate._gizmo.gizmo.rotate.children.find((c) => c.name === 'E')
    expect(ring.material.color.getHex()).toBe(0x8a8a8a)
    const greyMaterial = ring.material
    t.setMode('rotate')
    const back = t._parts.rotate._gizmo.gizmo.rotate.children.find((c) => c.name === 'E')
    expect(back.material).not.toBe(greyMaterial)
    expect(back.material.color.getHex()).not.toBe(0x8a8a8a)
    expect(names(t._parts.rotate, 'gizmo', 'rotate')).toEqual(['E', 'X', 'XYZE', 'Y', 'Z'])
    expect(names(t._parts.translate, 'gizmo', 'translate')).toContain('XYZ')
    expect(names(t._parts.scale, 'picker', 'scale').length).toBeGreaterThan(4)
  })

  it('without Resize (bones, cameras) the combined tool is Move + Rotate', () => {
    const t = make({ allowScale: false })
    t.attach(target)
    t.setMode('combined')
    expect(attached(t)).toEqual(['translate', 'rotate'])
  })

  it('lets each layer drive its own target (bone: Move drives the IK target, Rotate the bone)', () => {
    const t = make({ allowScale: false })
    const bone = new THREE.Object3D()
    const proxy = new THREE.Object3D()
    t.setMode('combined')
    t.attach(bone)
    t.attachPart('translate', proxy)
    expect(t._parts.rotate.object).toBe(bone)
    expect(t._parts.translate.object).toBe(proxy)
  })

  it('forwards events and says which layer a drag belongs to', () => {
    const t = make({ allowScale: false })
    t.attach(target)
    t.setMode('combined')
    const seen = []
    t.addEventListener('mouseDown', (e) => seen.push(['down', e.mode, t.activeMode]))
    t.addEventListener('objectChange', () => seen.push(['change', t.activeMode]))
    t.addEventListener('mouseUp', (e) => seen.push(['up', e.mode, t.activeMode]))
    t._parts.rotate.dispatchEvent({ type: 'mouseDown' })
    t._parts.rotate.dispatchEvent({ type: 'objectChange' })
    t._parts.rotate.dispatchEvent({ type: 'mouseUp' })
    expect(seen).toEqual([['down', 'rotate', 'rotate'], ['change', 'rotate'], ['up', 'rotate', 'rotate']])
    expect(t.activeMode).toBe(null) // between drags, nothing grabbed
    t._parts.translate.dispatchEvent({ type: 'mouseDown' })
    expect(t.activeMode).toBe('translate')
    t._parts.translate.dispatchEvent({ type: 'mouseUp' })
  })

  // Camera 5 units away, so a world point on the X axis maps straight to a pointer position. With the combined
  // sizes, Resize's cube covers x up to about 0.25, Move's arrow runs from about 0.3 to 0.55, and Rotate's outer
  // ring sits at about 0.6.
  const pointerAt = (x) => {
    const p = new THREE.Vector3(x, 0, 0).project(camera)
    return { x: p.x, y: p.y }
  }

  it('where handles overlap, the smaller target wins: Resize cube over the Move arrow', () => {
    const t = make()
    t.attach(target)
    t.setMode('combined')
    t.getHelper().updateMatrixWorld(true)
    const pointer = pointerAt(0.1)
    t._parts.translate.pointerHover(pointer)
    // Move's arrow really is under that spot too ...
    const ray = t._parts.translate.getRaycaster()
    expect(ray.intersectObject(t._parts.translate._gizmo.picker.translate, true).length).toBeGreaterThan(0)
    // ... but the Resize cube takes it
    t._parts.scale.pointerHover(pointer)
    expect(t._parts.scale.axis).toBe('X')
    expect(t._parts.translate.axis).toBe(null)
  })

  it('a Move arrow is still reachable further out than the Resize cubes', () => {
    const t = make()
    t.attach(target)
    t.setMode('combined')
    t.getHelper().updateMatrixWorld(true)
    const pointer = pointerAt(0.42)
    t._parts.scale.pointerHover(pointer)
    t._parts.translate.pointerHover(pointer)
    expect(t._parts.scale.axis).toBe(null)
    expect(t._parts.translate.axis).toBe('X')
  })

  it('the outer ring is the Rotate layer: it turns the object around the view and clears the other layers', () => {
    const t = make()
    t.attach(target)
    t.setMode('combined')
    t.getHelper().updateMatrixWorld(true)
    const rotate = t._parts.rotate
    const ring = rotate._gizmo.picker.rotate.children.find((c) => c.name === 'E')
    const pointer = pointerAt(0.75 * unit(t._parts.rotate)) // on the outer ring, beyond the end of the Move arrows
    for (const mode of ['scale', 'translate', 'rotate']) t._parts[mode].pointerHover(pointer)
    expect(ring).toBeTruthy()
    expect(rotate.axis).toBe('E')
    expect(t._parts.translate.axis).toBe(null)
    expect(t._parts.scale.axis).toBe(null)
  })

  // Camera 5 units away; see pointerAt above for the layout this relies on
  const ringPoint = (t) => {
    const picker = t._parts.rotate._gizmo.picker.rotate.children.find((c) => c.name === 'Z')
    const pos = picker.geometry.attributes.position
    const v = new THREE.Vector3()
    for (let i = 0; i < pos.count; i += 3) {
      v.fromBufferAttribute(pos, i).applyMatrix4(picker.matrixWorld)
      const p = v.clone().project(camera)
      for (const mode of ['scale', 'translate', 'rotate']) t._parts[mode].pointerHover({ x: p.x, y: p.y })
      if (t._parts.rotate.axis === 'Z') return { x: p.x, y: p.y }
    }
    return null
  }

  it('a drag on an inner rotate ring is never taken away mid-drag, so its end is reported (undo)', () => {
    const t = make()
    t.attach(target)
    t.setMode('combined')
    t.getHelper().updateMatrixWorld(true)
    const start = ringPoint(t)
    expect(start).not.toBe(null)
    const events = []
    t.addEventListener('mouseDown', (e) => events.push('down:' + e.mode))
    t.addEventListener('mouseUp', (e) => events.push('up:' + e.mode))
    t._parts.rotate.pointerDown({ ...start, button: 0 })
    expect(t._parts.rotate.dragging).toBe(true)
    // drag across the Move arrow and the Resize cube: nothing may steal the handle
    for (const x of [0.1, 0.2, 0.4]) {
      const p = pointerAt(x)
      for (const mode of ['scale', 'translate', 'rotate']) t._parts[mode].pointerHover(p)
      expect(t._parts.rotate.axis).toBe('Z')
    }
    t._parts.rotate.pointerUp({ ...pointerAt(0.4), button: 0 })
    expect(events).toEqual(['down:rotate', 'up:rotate'])
  })
})

describe('CombinedTransform without Resize (bones)', () => {
  const pointerAt = (x) => {
    const p = new THREE.Vector3(x, 0, 0).project(camera)
    return { x: p.x, y: p.y }
  }

  it('the inside of the gizmo turns the bone: Rotate wins over Move, and Move keeps the long arrows', () => {
    const t = make({ allowScale: false })
    t.attach(target)
    t.setMode('combined')
    t.getHelper().updateMatrixWorld(true)
    // find a spot where both rotate and move have a handle: rotate must take it
    const rotatePicker = t._parts.rotate._gizmo.picker.rotate
    let contested = null
    for (let x = 0.05; x <= 0.6 && !contested; x += 0.01) {
      const p = pointerAt(x)
      const ray = new THREE.Raycaster()
      ray.setFromCamera(p, camera)
      const moveHit = ray.intersectObject(t._parts.translate._gizmo.picker.translate, true).length > 0
      const turnHit = ray.intersectObject(rotatePicker, true).length > 0
      if (moveHit && turnHit) contested = p
    }
    expect(contested).not.toBe(null)
    t._parts.translate.pointerHover(contested)
    t._parts.rotate.pointerHover(contested)
    expect(t._parts.rotate.axis).not.toBe(null)
    expect(t._parts.translate.axis).toBe(null)
    // out on the arrow tip, Move still works
    const tip = pointerAt(0.55 * unit(t._parts.translate)) // out on the arrow, past the outer ring
    t._parts.rotate.pointerHover(tip)
    t._parts.translate.pointerHover(tip)
    expect(t._parts.translate.axis).toBe('X')
  })

  it('the axis rings get a fatter hit area for bones only, and it is put back afterwards', () => {
    const bone = make({ allowScale: false })
    const full = make()
    const tube = (t) => t._parts.rotate._gizmo.picker.rotate.children.find((c) => c.name === 'Z').geometry.boundingBox ?? null
    const size = (t) => {
      const g = t._parts.rotate._gizmo.picker.rotate.children.find((c) => c.name === 'Z').geometry
      g.computeBoundingBox()
      return g.boundingBox.getSize(new THREE.Vector3()).length()
    }
    bone.setMode('combined')
    full.setMode('combined')
    expect(tube).toBeTypeOf('function')
    expect(size(bone)).toBeGreaterThan(size(full))
    const before = size(bone)
    bone.setMode('rotate')
    expect(size(bone)).toBeLessThan(before) // the normal ring again
  })
})
