import { useRef, useState } from 'react'

// Pure math kept for a SINGLE before/after angle comparison (still exercised
// directly by the existing unit tests). NOTE: because atan2 only ever returns
// an angle in (-PI, PI], comparing just a start and end angle can't tell a
// 370-degree drag from a 10-degree one — that's a property of using absolute
// angles this way, not a bug. The dial itself no longer relies on this single
// comparison for tracking a live drag (see accumulateTurns below), so it no
// longer resets when the pointer goes all the way around the ring.
export function angleDeltaToValue(startAngle, currentAngle, startValue) {
  let delta = currentAngle - startAngle
  // normalise to [-PI, PI] so crossing the +/-180deg seam doesn't jump
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  // one full turn == roughly doubling/halving the size
  const factor = Math.pow(2, delta / (Math.PI * 2))
  return Math.max(0.01, startValue * factor)
}

// Normalises the SMALL step between two consecutive pointer samples to
// (-PI, PI]. Consecutive pointermove events are close together, so (unlike a
// single start-vs-end comparison) this step is never ambiguous, and summing
// many of these steps across a drag lets the dial track rotation PAST a
// single full turn — spin around twice and it keeps growing/shrinking
// instead of snapping back to where it started.
export function angleStepDelta(prevAngle, currentAngle) {
  let delta = currentAngle - prevAngle
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

// Convert accumulated turns (can be any size, positive or negative, not just
// +/-0.5) into a scale factor relative to the value captured at drag start.
export function turnsToFactor(turns, startValue) {
  return Math.max(0.01, startValue * Math.pow(2, turns))
}

// A circular drag handle for uniform resizing — similar to the resize ring
// in Blender/Clip Studio: drag anywhere around the dial and the object grows
// or shrinks the same amount on every side, instead of nudging one axis at a
// time. Dragging clockwise scales up; counter-clockwise scales down. Reports
// live value changes via onChange, and a single onCommit at the end of the
// drag (so it's one undo step, not one per pixel moved).
//
// `getValue` (preferred over `value` for the drag-start read) lets the
// caller hand back the CURRENT live value at the exact moment a drag starts —
// e.g. straight from the three.js object — rather than whatever value this
// component last rendered with. Without it, resizing via another control
// (the gizmo/UI widget) between drags wouldn't be visible yet on the next
// render, and starting a new drag from the dial would silently discard that
// change and resume from the stale number instead.
export default function RadialScale({ value, getValue, onChange, onDragStart, onCommit, label = 'Scale' }) {
  const dialRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  // turns: total accumulated rotation (in full turns) since the drag began —
  // unbounded, unlike a single wrapped angle delta.
  const startRef = useRef({ lastAngle: 0, turns: 0, value: 1 })

  function angleFromEvent(e) {
    const rect = dialRef.current.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    return Math.atan2(e.clientY - cy, e.clientX - cx)
  }

  function onPointerDown(e) {
    e.preventDefault()
    dialRef.current.setPointerCapture(e.pointerId)
    // Read the live value up front (synchronously) so a resize done via
    // another control just before this drag isn't lost — see getValue note
    // above. Falls back to the `value` prop if no getter was supplied.
    const startValue = getValue ? getValue() : value
    startRef.current = { lastAngle: angleFromEvent(e), turns: 0, value: startValue }
    onDragStart && onDragStart(startValue)
    setDragging(true)
  }

  function onPointerMove(e) {
    if (!dragging) return
    const angle = angleFromEvent(e)
    const step = angleStepDelta(startRef.current.lastAngle, angle)
    startRef.current.turns += step / (Math.PI * 2)
    startRef.current.lastAngle = angle
    onChange(turnsToFactor(startRef.current.turns, startRef.current.value))
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
        title="Drag around the ring to resize — clockwise to grow, counter-clockwise to shrink. Keep spinning past a full turn for more."
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