import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'

// A drop-in replacement for TransformControls that can also show Move, Rotate and Resize TOGETHER ("combined").
//
// In the single modes ('translate' | 'rotate' | 'scale') it is exactly one ordinary TransformControls, so nothing
// about the existing gizmos changes. In 'combined' mode three of them are layered on the same object:
//
//   Move    longest   axis arrows + plane squares
//   Rotate  middle    the three axis rings, plus the grey outer ring that turns the object around the view
//   Resize  smallest  axis cubes + the centre cube
//
// The handles that would sit on top of each other are left out (the free-rotate sphere, Move's centre), and where
// two remaining handles still overlap, the smaller target wins (Resize, then Move, then Rotate), so every handle
// can be reached. Where a gizmo has no Resize (a bone, a camera), the combined tool is just Move + Rotate.
//
// Events (change, dragging-changed, objectChange, mouseDown, mouseUp) are forwarded from whichever layer is being
// used, so listeners written for TransformControls work unchanged. `activeMode` tells a listener which layer a
// drag belongs to.

const ALL = ['translate', 'rotate', 'scale']
const PRIORITY = ['scale', 'translate', 'rotate'] // who wins where handles overlap
const FORWARDED = ['change', 'dragging-changed', 'objectChange']

// Size of each layer relative to the gizmo's base size, times COMBINED_GROW for the whole tool. Rotate's outer ring
// (0.75 of its size) ends up outside the tips of Move's arrows (0.6 of its size), and Resize's cubes sit inside the
// axis rings.
const COMBINED_GROW = 1.15
const SIZES = { translate: 0.95 * COMBINED_GROW, rotate: 0.85 * COMBINED_GROW, scale: 0.42 * COMBINED_GROW }

// Without Resize (bones, cameras): Move's arrows end just inside Rotate's outer ring (0.6 x 0.99 against
// 0.75 x 0.9), and stick out only a little past the axis rings' fat hit area, which is where they are grabbed.
// The inside of the gizmo belongs to Rotate.
const SIZES_NO_SCALE = { translate: 0.99 * COMBINED_GROW, rotate: 0.9 * COMBINED_GROW }

// Without Resize (bones) the axis rings get a fatter invisible hit area, since they now win over Move's arrows.
const FAT_RING_TUBE = 0.12
const RING_PICKER_ROTATIONS = { X: [0, -Math.PI / 2, -Math.PI / 2], Y: [Math.PI / 2, 0, 0], Z: [0, 0, -Math.PI / 2] }

// Handles kept in combined mode (names inside three's gizmo). 'E' is the outer ring, 'XYZE' the free-rotate sphere.
const KEEP = {
  translate: ['X', 'Y', 'Z', 'XY', 'YZ', 'XZ'],
  rotate: ['X', 'Y', 'Z', 'E'],
  scale: ['X', 'Y', 'Z', 'XYZ'],
}

const OUTER_RING_COLOR = 0x8a8a8a

export class CombinedTransform extends THREE.EventDispatcher {
  // options.allowScale = false: the combined tool is Move + Rotate only (bones, cameras).
  constructor(camera, domElement, { allowScale = true } = {}) {
    super()
    this.isCombinedTransform = true
    this.domElement = domElement
    this._camera = camera
    this._allowScale = allowScale
    this._mode = 'translate'
    this._size = 1
    this._object = undefined
    this._partObjects = {} // per-layer attach targets (pose mode: Move drives an IK proxy, Rotate the bone)
    this._dragMode = null // which layer the current drag belongs to
    this._stash = {}

    this._parts = {}
    this._helper = new THREE.Group()
    this._helper.name = '(combined transform)'
    for (const mode of ALL) {
      const part = new TransformControls(camera, domElement)
      part.setMode(mode)
      for (const type of FORWARDED) part.addEventListener(type, (e) => this.dispatchEvent({ ...e, target: this }))
      part.addEventListener('mouseDown', () => {
        this._dragMode = mode
        this.dispatchEvent({ type: 'mouseDown', mode })
      })
      part.addEventListener('mouseUp', () => {
        this.dispatchEvent({ type: 'mouseUp', mode })
        this._dragMode = null
      })
      // Where handles of two layers overlap under the pointer, only the one that ranks higher reacts.
      const hover = part.pointerHover.bind(part)
      part.pointerHover = (pointer) => {
        hover(pointer)
        // Never take a handle away in the middle of a drag: the drag would stop and, with no axis left, the layer
        // would not report the end of it, so the edit would be missing from undo.
        if (this._mode !== 'combined' || part.axis === null || part.dragging) return
        const own = this._rank(mode, part.axis)
        const ray = part.getRaycaster()
        for (const other of ALL) {
          if (other === mode || !this._combinedModes().includes(other)) continue
          const rival = this._parts[other]
          if (!rival.object) continue
          const hit = firstPickerHit(rival, ray)
          if (hit && this._rank(other, hit.object.name) < own) {
            part.axis = null
            return
          }
        }
      }
      this._parts[mode] = part
      this._helper.add(part.getHelper())
    }

    this._layout()
  }

  // --- TransformControls surface ---------------------------------------------------------------------

  getHelper() {
    return this._helper
  }

  get camera() {
    return this._camera
  }

  set camera(camera) {
    this._camera = camera
    for (const mode of ALL) this._parts[mode].camera = camera
  }

  get mode() {
    return this._mode
  }

  set mode(mode) {
    this.setMode(mode)
  }

  setMode(mode) {
    this._mode = mode === 'combined' || ALL.includes(mode) ? mode : 'translate'
    this._layout()
  }

  get size() {
    return this._size
  }

  set size(size) {
    this.setSize(size)
  }

  setSize(size) {
    this._size = size
    this._layout()
  }

  setSpace(space) {
    for (const mode of ALL) this._parts[mode].setSpace(space)
  }

  setRotationSnap(value) {
    for (const mode of ALL) this._parts[mode].setRotationSnap(value)
  }

  setTranslationSnap(value) {
    for (const mode of ALL) this._parts[mode].setTranslationSnap(value)
  }

  setScaleSnap(value) {
    for (const mode of ALL) this._parts[mode].setScaleSnap(value)
  }

  get enabled() {
    return this._enabledOverride !== false
  }

  set enabled(value) {
    this._enabledOverride = !!value
    this._layout()
  }

  get object() {
    return this._object ?? Object.values(this._partObjects)[0]
  }

  get dragging() {
    return ALL.some((mode) => this._parts[mode].dragging)
  }

  // The layer the current drag belongs to (or, between drags, the single mode in use).
  get activeMode() {
    if (this._dragMode) return this._dragMode
    if (this._mode !== 'combined') return this._mode
    return ALL.find((mode) => this._parts[mode].axis !== null && this._combinedModes().includes(mode)) || null
  }

  // The handle under the pointer, or null.
  get axis() {
    for (const mode of this._activeModes()) if (this._parts[mode].axis !== null) return this._parts[mode].axis
    return null
  }

  set axis(value) {
    const modes = this._activeModes()
    if (modes.length) this._parts[modes[0]].axis = value
  }

  attach(object) {
    this._object = object
    this._partObjects = {}
    this._syncAttach()
    return this
  }

  // Give one layer its own target (e.g. Move drives an invisible IK target while Rotate turns the bone itself).
  attachPart(mode, object) {
    this._partObjects[mode] = object
    this._syncAttach()
    return this
  }

  detach() {
    this._object = undefined
    this._partObjects = {}
    this._syncAttach()
    return this
  }

  dispose() {
    for (const mode of ALL) {
      this._prune(mode, false) // hand the clashing handles back so they are disposed with the layer
      this._parts[mode].dispose()
    }
  }

  // --- layout ----------------------------------------------------------------------------------------

  // Who wins where handles overlap (lower wins). With Resize present the smallest target wins: Resize, Move, then
  // Rotate. Without it (bones) the axis rings win over Move's arrows, so the inside of the gizmo turns the bone, and
  // the outer ring comes last so it never covers the arrow tips.
  _rank(mode, handle) {
    if (this._allowScale) return PRIORITY.indexOf(mode)
    if (mode === 'rotate') return handle === 'E' ? 2 : 0
    return 1
  }

  _combinedModes() {
    return this._allowScale ? ALL : ['translate', 'rotate']
  }

  _activeModes() {
    return this._mode === 'combined' ? this._combinedModes() : [this._mode]
  }

  _layout() {
    const combined = this._mode === 'combined'
    const modes = this._activeModes()
    const sizes = this._allowScale ? SIZES : SIZES_NO_SCALE
    for (const mode of ALL) {
      const part = this._parts[mode]
      const on = modes.includes(mode)
      this._prune(mode, combined && on)
      part.size = this._size * (combined && on ? sizes[mode] : 1)
      part.enabled = on && this._enabledOverride !== false
    }
    this._syncAttach()
  }

  _syncAttach() {
    const modes = this._activeModes()
    for (const mode of ALL) {
      const part = this._parts[mode]
      const target = this._partObjects[mode] ?? this._object
      if (modes.includes(mode) && target) part.attach(target)
      else part.detach()
    }
  }

  // Take the handles that clash out of a layer for combined mode, and put them back afterwards. The outer ring of
  // Rotate is also turned grey there, so it reads as the frame around everything.
  _prune(mode, on) {
    const gizmo = this._parts[mode]._gizmo
    if (on) {
      if (this._stash[mode]) return
      const keep = new Set(KEEP[mode])
      const stash = []
      for (const group of [gizmo.gizmo[mode], gizmo.picker[mode]]) {
        for (const child of [...group.children]) {
          if (keep.has(child.name)) {
            if (mode === 'rotate' && !this._allowScale && group === gizmo.picker[mode] && RING_PICKER_ROTATIONS[child.name]) {
              const geometry = new THREE.TorusGeometry(0.5, FAT_RING_TUBE, 4, 24)
              geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...RING_PICKER_ROTATIONS[child.name])))
              stash.push({ child, geometry: child.geometry, fat: geometry })
              child.geometry = geometry
            }
            if (mode === 'rotate' && child.name === 'E' && group === gizmo.gizmo[mode] && child.material) {
              const original = child.material
              const grey = original.clone()
              grey.color.setHex(OUTER_RING_COLOR)
              grey._color = grey.color.clone() // what three restores after a hover highlight
              grey._opacity = original._opacity ?? original.opacity
              child.material = grey
              stash.push({ child, material: original, grey })
            }
            continue
          }
          stash.push({ group, child })
          group.remove(child)
        }
      }
      this._stash[mode] = stash
    } else if (this._stash[mode]) {
      for (const item of this._stash[mode]) {
        if (item.group) item.group.add(item.child)
        else if (item.fat) {
          item.child.geometry = item.geometry
          item.fat.dispose()
        } else {
          item.child.material = item.material
          item.grey.dispose()
        }
      }
      this._stash[mode] = null
    }
  }
}

function firstPickerHit(part, raycaster) {
  const picker = part._gizmo.picker[part.mode]
  return raycaster.intersectObject(picker, true).find((hit) => hit.object.visible) || null
}
