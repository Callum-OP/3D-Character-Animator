import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import * as THREE from 'three'
import {
  initMeshEdit,
  setMeshEditModel,
  setMeshEditEnabled,
  selectMeshes,
  getSelectedMeshUuids,
  getMeshDelta,
  simulateGroupDragForTest,
  resetMeshes,
  undo,
  redo,
  pickMeshUuidsInRect,
} from '../three/meshedit.js'
import { clearUndoHistory, getHistorySequence } from '../three/undoHistory.js'

// Orthographic camera straight down -Z over a 100x100 canvas: world x in
// [-10,10] maps to pixel x 0..100 and world y in [10,-10] to pixel y 0..100,
// so a part at world (wx, wy) sits at pixel ((wx+10)*5, (10-wy)*5).
//   A  world (-4, 0)  -> px (30, 50)   plain parent
//   B  world ( 4, 0)  -> px (70, 50)   parent ROTATED 90° about Z (different space)
//   C  world ( 0, 6)  -> px (50, 20)   plain parent
function build() {
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)

  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 })
  canvas.setPointerCapture = () => {}
  canvas.releasePointerCapture = () => {}
  canvas.hasPointerCapture = () => false

  const controls = { enabled: true, locked: false }
  const onSelect = vi.fn()
  const onSelectMany = vi.fn()
  initMeshEdit({ scene, camera, renderer: { domElement: canvas }, controls, requestRender: () => {}, onSelect, onSelectMany })

  const make = (name, parent, x, y) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial())
    mesh.name = name
    mesh.position.set(x, y, 0)
    parent.add(mesh)
    return mesh
  }
  const pa = new THREE.Group()
  const pb = new THREE.Group()
  pb.rotation.z = Math.PI / 2 // local (0,-4) -> world (4,0)
  const pc = new THREE.Group()
  scene.add(pa, pb, pc)
  const A = make('A', pa, -4, 0)
  const B = make('B', pb, 0, -4)
  const C = make('C', pc, 0, 6)
  scene.updateMatrixWorld(true)

  setMeshEditModel({ meshes: [A, B, C] })
  setMeshEditEnabled(true)
  return { scene, canvas, controls, onSelect, onSelectMany, A, B, C }
}

const worldPos = (mesh) => {
  mesh.updateWorldMatrix(true, false)
  return mesh.getWorldPosition(new THREE.Vector3())
}

describe('mesh mode: multi-select, box-select and group gizmo', () => {
  let ctx

  function drag(x0, y0, x1, y1, mods) {
    const o = { button: 0, bubbles: true, ...mods }
    ctx.canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x0, clientY: y0, ...o }))
    ctx.canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x1, clientY: y1, ...o }))
    ctx.canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: x1, clientY: y1, ...o }))
  }

  beforeAll(() => {
    ctx = build()
  })

  beforeEach(() => {
    ctx.onSelect.mockClear()
    ctx.onSelectMany.mockClear()
    ctx.controls.enabled = true
    selectMeshes([])
    ctx.A.visible = ctx.B.visible = ctx.C.visible = true
    // Every test starts from parts at rest and an empty undo history, so none
    // depends on what an earlier one dragged around.
    resetMeshes([ctx.A.uuid, ctx.B.uuid, ctx.C.uuid])
    clearUndoHistory()
  })

  describe('clicking', () => {
    it('a plain click reports the part, not additive', () => {
      drag(70, 50, 70, 50, {})
      expect(ctx.onSelect).toHaveBeenCalledWith(ctx.B.uuid, false)
    })

    it('Shift-click and Ctrl-click report additive picks', () => {
      drag(30, 50, 30, 50, { shiftKey: true })
      expect(ctx.onSelect).toHaveBeenLastCalledWith(ctx.A.uuid, true)
      drag(30, 50, 30, 50, { ctrlKey: true })
      expect(ctx.onSelect).toHaveBeenLastCalledWith(ctx.A.uuid, true)
    })

    it('a Shift-click on empty space does NOT clear the selection being built, a plain one does', () => {
      drag(90, 90, 90, 90, { shiftKey: true })
      expect(ctx.onSelect).not.toHaveBeenCalled()
      drag(90, 90, 90, 90, {})
      expect(ctx.onSelect).toHaveBeenCalledWith(null, false)
    })

    it('a shaky Shift-click (a pixel or two of jitter) is still a click, not a box', () => {
      drag(30, 50, 32, 51, { shiftKey: true })
      expect(ctx.onSelectMany).not.toHaveBeenCalled()
      expect(ctx.onSelect).toHaveBeenCalledWith(ctx.A.uuid, true)
    })
  })

  describe('box-select', () => {
    it('Shift-drag selects every part whose centre is inside the box, additively', () => {
      drag(0, 0, 60, 60, { shiftKey: true }) // covers A (30,50) and C (50,20), not B (70,50)
      const [uuids, additive] = ctx.onSelectMany.mock.calls.at(-1)
      expect([...uuids].sort()).toEqual([ctx.A.uuid, ctx.C.uuid].sort())
      expect(additive).toBe(true)
      expect(ctx.onSelect).not.toHaveBeenCalled()
    })

    it('Ctrl-drag replaces instead of adding', () => {
      drag(0, 0, 100, 100, { ctrlKey: true })
      const [uuids, additive] = ctx.onSelectMany.mock.calls.at(-1)
      expect(uuids).toHaveLength(3)
      expect(additive).toBe(false)
    })

    it('uses the part centre, so a box that only clips a big part does not grab it', () => {
      // Box covers just the right-hand edge of A's 2x2 body (px x 35..40) but not its centre.
      drag(36, 40, 45, 60, { shiftKey: true })
      expect(ctx.onSelectMany.mock.calls.at(-1)[0]).toEqual([])
    })

    it('skips hidden parts', () => {
      ctx.C.visible = false
      drag(0, 0, 100, 100, { shiftKey: true })
      const uuids = ctx.onSelectMany.mock.calls.at(-1)[0]
      expect(uuids).not.toContain(ctx.C.uuid)
      expect(uuids).toHaveLength(2)
    })

    it('does not leave orbit disabled once the drag is over', () => {
      drag(0, 0, 60, 60, { shiftKey: true })
      expect(ctx.controls.enabled).toBe(true)
    })

    it('pickMeshUuidsInRect agrees with the pointer path', () => {
      expect(pickMeshUuidsInRect(0, 0, 60, 60, 100, 100).sort()).toEqual([ctx.A.uuid, ctx.C.uuid].sort())
    })
  })

  describe('selection state and highlights', () => {
    it('selects several parts, last one primary, and draws one highlight box per part', () => {
      selectMeshes([ctx.A.uuid, ctx.B.uuid])
      expect(getSelectedMeshUuids()).toEqual([ctx.A.uuid, ctx.B.uuid])
      const boxes = () => ctx.scene.children.filter((c) => c.type === 'BoxHelper')
      expect(boxes()).toHaveLength(2)
      selectMeshes([ctx.C.uuid])
      expect(boxes()).toHaveLength(1)
      selectMeshes([])
      expect(boxes()).toHaveLength(0)
    })

    it('ignores unknown uuids and duplicates', () => {
      selectMeshes([ctx.A.uuid, 'nope', ctx.A.uuid])
      expect(getSelectedMeshUuids()).toEqual([ctx.A.uuid])
    })
  })

  describe('group gizmo', () => {
    it('moves every selected part together, including one under a rotated parent', () => {
      selectMeshes([ctx.A.uuid, ctx.B.uuid])
      const a0 = worldPos(ctx.A)
      const b0 = worldPos(ctx.B)
      const c0 = worldPos(ctx.C)
      expect(simulateGroupDragForTest((pivot) => pivot.position.add(new THREE.Vector3(1, 2, 0)))).toBe(true)
      expect(worldPos(ctx.A).distanceTo(a0.clone().add(new THREE.Vector3(1, 2, 0)))).toBeLessThan(1e-4)
      expect(worldPos(ctx.B).distanceTo(b0.clone().add(new THREE.Vector3(1, 2, 0)))).toBeLessThan(1e-4)
      expect(worldPos(ctx.C).distanceTo(c0)).toBeLessThan(1e-6) // unselected: untouched
    })

    it('rotates the group about its centroid, preserving the parts\' arrangement', () => {
      selectMeshes([ctx.A.uuid, ctx.B.uuid]) // centroid is the origin
      simulateGroupDragForTest((pivot) => pivot.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2))
      expect(worldPos(ctx.A).distanceTo(new THREE.Vector3(0, -4, 0))).toBeLessThan(1e-4)
      expect(worldPos(ctx.B).distanceTo(new THREE.Vector3(0, 4, 0))).toBeLessThan(1e-4)
    })

    it('scales the group about its centroid', () => {
      selectMeshes([ctx.A.uuid, ctx.B.uuid])
      simulateGroupDragForTest((pivot) => pivot.scale.set(2, 2, 2))
      expect(worldPos(ctx.A).distanceTo(new THREE.Vector3(-8, 0, 0))).toBeLessThan(1e-4)
      expect(worldPos(ctx.B).distanceTo(new THREE.Vector3(8, 0, 0))).toBeLessThan(1e-4)
      expect(getMeshDelta(ctx.A.uuid).scale[0]).toBeCloseTo(2)
    })

    it('a whole group drag is ONE undo step, and redo re-applies it', () => {
      selectMeshes([ctx.A.uuid, ctx.B.uuid])
      const a0 = worldPos(ctx.A)
      const b0 = worldPos(ctx.B)
      simulateGroupDragForTest((pivot) => pivot.position.x += 3)
      undo()
      expect(worldPos(ctx.A).distanceTo(a0)).toBeLessThan(1e-4)
      expect(worldPos(ctx.B).distanceTo(b0)).toBeLessThan(1e-4)
      redo()
      expect(worldPos(ctx.A).x).toBeCloseTo(a0.x + 3)
      expect(worldPos(ctx.B).x).toBeCloseTo(b0.x + 3)
      undo() // leave everything at rest for the next test
    })

    it('a press-and-release that moves nothing adds no undo entry', () => {
      selectMeshes([ctx.A.uuid, ctx.B.uuid])
      const before = getHistorySequence()
      simulateGroupDragForTest(() => {})
      expect(getHistorySequence()).toBe(before)
    })

    it('"Reset selected" puts them all back as one undo step', () => {
      selectMeshes([ctx.A.uuid, ctx.B.uuid])
      const a0 = worldPos(ctx.A)
      const b0 = worldPos(ctx.B)
      simulateGroupDragForTest((pivot) => pivot.position.y += 2)
      resetMeshes([ctx.A.uuid, ctx.B.uuid])
      expect(worldPos(ctx.A).distanceTo(a0)).toBeLessThan(1e-4)
      expect(worldPos(ctx.B).distanceTo(b0)).toBeLessThan(1e-4)
      undo() // undoes the reset (back to moved)…
      expect(worldPos(ctx.A).y).toBeCloseTo(a0.y + 2)
      undo() // …then the move
      expect(worldPos(ctx.A).distanceTo(a0)).toBeLessThan(1e-4)
    })

    it('with a single part selected there is no group drag (normal single gizmo path)', () => {
      selectMeshes([ctx.A.uuid])
      expect(simulateGroupDragForTest(() => {})).toBe(false)
    })
  })
})
