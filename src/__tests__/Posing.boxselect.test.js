import { describe, it, expect, beforeAll, vi } from 'vitest'
import * as THREE from 'three'
import { initPosing, setPoseModel, setPosingEnabled } from '../three/posing.js'

// Three bones spread across the screen: Hips center-bottom, A left, B right.
function makeRig() {
  const root = new THREE.Bone()
  root.name = 'Hips'
  const a = new THREE.Bone()
  a.name = 'A'
  a.position.set(-1, 1, 0)
  const b = new THREE.Bone()
  b.name = 'B'
  b.position.set(1, 1, 0)
  root.add(a)
  root.add(b)
  root.updateMatrixWorld(true)
  return { root, bones: [root, a, b] }
}

describe('bone box/marquee-select (Shift or Ctrl-drag)', () => {
  let canvas
  let onSelectMany

  beforeAll(() => {
    canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 })
    // jsdom doesn't implement the Pointer Capture API that TransformControls
    // (unrelatedly) calls on every pointer up/down — stub it out so those
    // calls no-op instead of throwing and spamming unrelated test failures.
    canvas.setPointerCapture = () => {}
    canvas.releasePointerCapture = () => {}
    canvas.hasPointerCapture = () => false

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 100)
    camera.position.set(0, 1, 5)
    camera.lookAt(0, 1, 0)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)

    onSelectMany = vi.fn()
    initPosing({
      scene,
      camera,
      renderer: { domElement: canvas },
      controls: { enabled: true, locked: false },
      requestRender: () => {},
      onSelect: () => {},
      onSelectMany,
    })
    setPosingEnabled(true)
    setPoseModel(makeRig())
  })

  function drag(x0, y0, x1, y1, mods) {
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x0, clientY: y0, button: 0, bubbles: true, ...mods }))
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x1, clientY: y1, button: 0, bubbles: true, ...mods }))
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: x1, clientY: y1, button: 0, bubbles: true, ...mods }))
  }

  it('Ctrl-drag over the whole rig selects every bone, replacing the selection', () => {
    drag(0, 0, 800, 600, { ctrlKey: true })
    expect(onSelectMany).toHaveBeenCalledWith(expect.arrayContaining(['Hips', 'A', 'B']), false)
  })

  it('Shift-drag over just the left bone selects only it, additively', () => {
    onSelectMany.mockClear()
    drag(0, 250, 300, 350, { shiftKey: true })
    const [names, additive] = onSelectMany.mock.calls.at(-1)
    expect(names).toEqual(['A'])
    expect(additive).toBe(true)
  })

  it('a tiny Ctrl-click (not a real drag) does not fire a box-select', () => {
    onSelectMany.mockClear()
    drag(400, 300, 401, 301, { ctrlKey: true })
    expect(onSelectMany).not.toHaveBeenCalled()
  })
})