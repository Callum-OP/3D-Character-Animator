import { useRef, useState } from 'react'

// Pure math for the dial: given the angle (radians) the pointer started at
// and its current angle, return the new value. Separated from the pointer
// handlers so it can be unit-tested without simulating real pointer events
// (see src/__tests__/radialScale.math.test.js).
export function angleDeltaToValue(startAngle, currentAngle, startValue) {
  let delta = currentAngle - startAngle
  // normalise to [-PI, PI] so crossing the +/-180deg seam doesn't jump
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  // one full turn == roughly doubling/halving the size
  const factor = Math.pow(2, delta / (Math.PI * 2))
  return Math.max(0.01, startValue * factor)
}

// A circular drag handle for uniform resizing — similar to the resize ring
// in Blender/Clip Studio: drag anywhere around the dial and the object grows
// or shrinks the same amount on every side, instead of nudging one axis at a
// time. Dragging clockwise from the starting angle scales up; counter-
// clockwise scales down. Reports live value changes via onChange, and a
// single onCommit at the end of the drag (so it's one undo step, not one per
// pixel moved).
export default function RadialScale({ value, onChange, onDragStart, onCommit, label = 'Scale' }) {
  const dialRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const startRef = useRef({ angle: 0, value: 1 })

  function angleFromEvent(e) {
    const rect = dialRef.current.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    return Math.atan2(e.clientY - cy, e.clientX - cx)
  }

  function onPointerDown(e) {
    e.preventDefault()
    dialRef.current.setPointerCapture(e.pointerId)
    startRef.current = { angle: angleFromEvent(e), value }
    onDragStart && onDragStart()
    setDragging(true)
  }

  function onPointerMove(e) {
    if (!dragging) return
    const angle = angleFromEvent(e)
    onChange(angleDeltaToValue(startRef.current.angle, angle, startRef.current.value))
  }

  function onPointerUp(e) {
    if (!dragging) return
    setDragging(false)
    try {
      dialRef.current.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    onCommit && onCommit()
  }

  // Handle position: fixed dot at "top" that rotates with the accumulated
  // drag angle purely for visual feedback (angle resets each drag start).
  const knobAngle = dragging ? 0 : -Math.PI / 2
  const r = 24
  const hx = 28 + r * Math.cos(knobAngle)
  const hy = 28 + r * Math.sin(knobAngle)

  return (
    <div className="radial-scale">
      <div
        ref={dialRef}
        className="radial-scale-dial"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="Drag around the ring to resize — clockwise to grow, counter-clockwise to shrink"
      >
        <div className="radial-scale-ring" />
        <div className="radial-scale-handle" style={{ left: hx, top: hy, margin: 0 }} />
        <div className="radial-scale-center">⤢</div>
      </div>
      <div className="radial-scale-info">
        <div className="radial-scale-value">{value.toFixed(2)}×</div>
        <div className="radial-scale-label">{label} — drag the ring</div>
      </div>
    </div>
  )
}