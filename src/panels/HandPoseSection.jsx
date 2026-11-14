import { useRef, useState } from 'react'
import { FINGERS } from '../three/handPose.js'
import { beginHandAdjust, setHandCurl, endHandAdjust, saveCurrentHandPose } from '../three/poseLibraryActions.js'

const LABELS = { thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky' }
const ZERO = { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 }

// Open <-> fist sliders for the left hand, right hand or both: one slider for the whole hand, one per finger, and a
// spread slider. Dragging shows the change live and lands as ONE undo step when released. The sliders set the
// fingers from rest (they replace whatever the fingers were doing).
export default function HandPoseSection({ onMessage, compact = false }) {
  const [side, setSide] = useState('both')
  const [curl, setCurl] = useState(ZERO)
  const [spread, setSpread] = useState(0)
  const active = useRef(false)

  const run = (fn) => {
    try {
      fn()
    } catch (e) {
      onMessage?.(e.message || String(e))
    }
  }
  const begin = () => {
    if (active.current) return
    run(() => {
      beginHandAdjust(side)
      active.current = true
    })
  }
  const end = () => {
    if (!active.current) return
    active.current = false
    endHandAdjust()
  }
  const apply = (nextCurl, nextSpread) => {
    begin()
    setCurl(nextCurl)
    setSpread(nextSpread)
    run(() => setHandCurl(side, nextCurl, nextSpread))
  }
  const release = { onPointerUp: end, onKeyUp: end, onBlur: end }
  const master = Math.round((Object.values(curl).reduce((a, b) => a + b, 0) / FINGERS.length) * 100)

  return (
    <div className="hand-controls">
      <div className="seg" role="group" aria-label="Which hand">
        {[['L', 'Left'], ['R', 'Right'], ['both', 'Both']].map(([key, label]) => (
          <button key={key} className={'seg-btn' + (side === key ? ' active' : '')} onClick={() => { end(); setSide(key) }}>
            {label}
          </button>
        ))}
      </div>
      <label className="hand-slider hand-slider-main">
        <span>Open ↔ Fist</span>
        <input
          type="range" min="0" max="100" value={master} aria-label="Open to fist"
          onPointerDown={begin} onKeyDown={begin} {...release}
          onChange={(e) => { const v = Number(e.target.value) / 100; apply({ thumb: v, index: v, middle: v, ring: v, pinky: v }, spread) }}
        />
        <b>{master}%</b>
      </label>
      {!compact && FINGERS.map((f) => (
        <label className="hand-slider" key={f}>
          <span>{LABELS[f]}</span>
          <input
            type="range" min="0" max="100" value={Math.round(curl[f] * 100)} aria-label={`${LABELS[f]} curl`}
            onPointerDown={begin} onKeyDown={begin} {...release}
            onChange={(e) => apply({ ...curl, [f]: Number(e.target.value) / 100 }, spread)}
          />
          <b>{Math.round(curl[f] * 100)}%</b>
        </label>
      ))}
      <label className="hand-slider">
        <span>Spread</span>
        <input
          type="range" min="0" max="100" value={Math.round(spread * 100)} aria-label="Finger spread"
          onPointerDown={begin} onKeyDown={begin} {...release}
          onChange={(e) => apply(curl, Number(e.target.value) / 100)}
        />
        <b>{Math.round(spread * 100)}%</b>
      </label>
      <div className="hand-actions">
        <button className="btn secondary" onClick={() => apply(ZERO, 0)}>Open hand</button>
        {(side === 'L' || side === 'R') && (
          <button
            className="btn secondary"
            title="Save this hand's current pose to the Pose Library"
            onClick={() => saveCurrentHandPose(side).then((e) => onMessage?.(`Saved “${e.name}” to the library.`)).catch((e) => onMessage?.(e.message))}
          >
            📚 Save hand
          </button>
        )}
      </div>
    </div>
  )
}
