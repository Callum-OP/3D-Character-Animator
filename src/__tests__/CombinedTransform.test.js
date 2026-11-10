import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import { CombinedTransform } from '../three/combinedTransform.js'
import { useStore } from '../store.js'

let camera, dom, target

function make(options) {
  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 5)
  camera.updateMatrixWorld(true)
  dom = document.createElement('canvas')
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 800 })
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
      expect(attached(t)).toEqual(mode === 'scale' ? ['rotate', 'scale'] : [mode])
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

  it('the outer ring defaults to Resize and clears the other layers', () => {
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
    expect(t.activeMode).toBe('scale')
    expect(t._parts.translate.axis).toBe(null)
    expect(t._parts.scale.axis).toBe(null)
  })

  it.each(['scale', 'combined'])('resizes proportionally in %s mode and reports a single scale drag', (mode) => {
    const t = make()
    target.scale.set(2, 1, 0.5)
    t.attach(target)
    t.setMode(mode)
    t.getHelper().updateMatrixWorld(true)
    const part = t._parts.rotate
    const radius = 0.75 * unit(part)
    const start = pointerAt(radius)
    for (const layer of ['scale', 'translate', 'rotate']) t._parts[layer].pointerHover(start)
    expect(part.axis).toBe('E')
    const events = []
    t.addEventListener('mouseDown', (e) => events.push(['down', e.mode, t.activeMode]))
    t.addEventListener('objectChange', () => events.push(['change', t.activeMode]))
    t.addEventListener('mouseUp', (e) => events.push(['up', e.mode, t.activeMode]))
    part.pointerDown({ ...start, button: 0 })
    part.pointerMove({ ...pointerAt(radius * 1.5), button: -1 })
    target.scale.toArray().forEach((value, i) => expect(value).toBeCloseTo([3, 1.5, 0.75][i]))
    part.pointerMove({ ...pointerAt(radius * 0.5), button: -1 })
    target.scale.toArray().forEach((value, i) => expect(value).toBeCloseTo([1, 0.5, 0.25][i]))
    part.pointerUp({ ...start, button: 0 })
    expect(events).toEqual([['down', 'scale', 'scale'], ['change', 'scale'], ['change', 'scale'], ['up', 'scale', 'scale']])
    t.dispose()
  })

  it('switches the combined outer ring to rotation without changing the Resize tool', () => {
    const t = make()
    t.attach(target)
    t.setMode('combined')
    useStore.getState().setTransformOuterRing('rotate')
    t.getHelper().updateMatrixWorld(true)
    const part = t._parts.rotate
    const r = 0.75 * unit(part)
    part.pointerHover(pointerAt(r))
    expect(t.activeMode).toBe('rotate')
    part.pointerDown({ ...pointerAt(r), button: 0 })
    const p = new THREE.Vector3(0, r, 0).project(camera)
    part.pointerMove({ x: p.x, y: p.y, button: -1 })
    part.pointerUp({ x: p.x, y: p.y, button: 0 })
    expect(target.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(1)
    expect(target.scale.toArray()).toEqual([1, 1, 1])
    t.setMode('scale')
    t.getHelper().updateMatrixWorld(true)
    part.pointerHover(pointerAt(0.75 * unit(part)))
    expect(part.axis).toBe('E')
    expect(t._outerResizes()).toBe(true)
    useStore.getState().setTransformOuterRing('resize')
    t.dispose()
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
  const pointerAtXY = (x, y) => {
    const p = new THREE.Vector3(x, y, 0).project(camera)
    return { x: p.x, y: p.y }
  }
  const setup = () => {
    const t = make({ allowScale: false })
    t.attach(target)
    t.setMode('combined')
    t.getHelper().updateMatrixWorld(true)
    return t
  }
  const hover = (t, p) => {
    for (const mode of ['rotate', 'translate']) t._parts[mode].pointerHover(p)
  }
  const rawHits = (t, p) => {
    const ray = new THREE.Raycaster()
    ray.setFromCamera(p, camera)
    return {
      move: ray.intersectObject(t._parts.translate._gizmo.picker.translate, true).length > 0,
      rings: ray.intersectObject(t._parts.rotate._gizmo.picker.rotate, true).filter((h) => h.object.name !== 'E').length > 0,
      outer: ray.intersectObject(t._parts.rotate._gizmo.picker.rotate, true).some((h) => h.object.name === 'E'),
    }
  }

  it("Move's arrows end inside the outer ring, not past it", () => {
    const t = setup()
    expect(0.6 * unit(t._parts.translate)).toBeLessThan(0.75 * unit(t._parts.rotate))
  })

  it('the inside of the gizmo turns the bone: where an axis ring and a Move handle overlap, Rotate wins', () => {
    const t = setup()
    let contested = null
    for (let x = 0.05; x <= 0.9 && !contested; x += 0.01) {
      const p = pointerAtXY(x, 0.01)
      const hits = rawHits(t, p)
      if (hits.move && hits.rings) contested = p
    }
    expect(contested).not.toBe(null)
    hover(t, contested)
    expect(t._parts.rotate.axis).not.toBe(null)
    expect(t._parts.rotate.axis).not.toBe('E')
    expect(t._parts.translate.axis).toBe(null)
  })

  it('Move can still be grabbed out on its arrows, past the axis rings', () => {
    const t = setup()
    let grabbed = null
    for (let x = 0.2; x <= 0.9; x += 0.01) {
      for (const y of [0, 0.03, 0.06, 0.09]) {
        const p = pointerAtXY(x, y)
        hover(t, p)
        if (t._parts.translate.axis !== null && t._parts.rotate.axis === null) grabbed = { x, p }
        t._parts.translate.axis = null
        t._parts.rotate.axis = null
      }
    }
    expect(grabbed).not.toBe(null)
    expect(grabbed.x).toBeGreaterThan(0.3 * unit(t._parts.translate))
  })

  it('the grey outer ring can be grabbed where there is no arrow, and gives way to a Move arrow where they touch', () => {
    const t = setup()
    const r = 0.75 * unit(t._parts.rotate)
    const away = pointerAtXY(r * Math.SQRT1_2, r * Math.SQRT1_2) // 45 degrees, between the arrows
    hover(t, away)
    expect(t._parts.rotate.axis).toBe('E')
    expect(t._parts.translate.axis).toBe(null)

    let touching = null
    for (let x = 0.3; x <= 1 && !touching; x += 0.005) {
      for (const y of [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.12]) {
        const hits = rawHits(t, pointerAtXY(x, y))
        if (hits.move && hits.outer && !hits.rings) { touching = pointerAtXY(x, y); break }
      }
    }
    expect(touching).not.toBe(null)
    if (touching) {
      hover(t, touching)
      expect(t._parts.translate.axis).not.toBe(null)
      expect(t._parts.rotate.axis).toBe(null)
    }
  })

  it('the axis rings get a fatter hit area for bones only, and it is put back afterwards', () => {
    const bone = make({ allowScale: false })
    const full = make()
    const size = (t) => {
      const g = t._parts.rotate._gizmo.picker.rotate.children.find((c) => c.name === 'Z').geometry
      g.computeBoundingBox()
      return g.boundingBox.getSize(new THREE.Vector3()).length()
    }
    bone.setMode('combined')
    full.setMode('combined')
    expect(size(bone)).toBeGreaterThan(size(full))
    const before = size(bone)
    bone.setMode('rotate')
    expect(size(bone)).toBeLessThan(before) // the normal ring again
  })
})
