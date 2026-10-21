import { useState } from 'react'
import { LIGHT_PRESETS } from '../three/lights.js'
import { createLightFromParts } from '../three/scene.js'

const AIM_MODES = [
  { id: 'smart', label: 'Smart (recommended)', hint: 'Out of the side of the object the part sits on, using the surface direction when it agrees' },
  { id: 'surface', label: 'Surface direction', hint: 'The way the part\'s own faces point' },
  { id: 'face', label: 'Away from the object\'s centre', hint: 'Out of the side of the whole object the part is on, like a car\'s front or back' },
]

// "Make a light from this": puts a real light where the selected part(s) — or a painted region
// of one — sit, tinted to match, instead of placing one by hand. Cone lights are aimed
// automatically; if one still points the wrong way, flip it or dial in an exact yaw / pitch here
// (or change it afterwards in the Lights tab). Shown in the Parts panel for parts and in the
// region editor for regions. See scene.js createLightFromParts.
//
// onCreated(result, { glow }) lets the caller make the surface glow too (parts and regions each
// do that their own way).
export default function LightFromPart({ uuids, regionId = null, label, onCreated }) {
  const [presetId, setPresetId] = useState('glow')
  const [useColour, setUseColour] = useState(true)
  const [glow, setGlow] = useState(true)
  const [aimMode, setAimMode] = useState('smart')
  const [flip, setFlip] = useState(false)
  const [yaw, setYaw] = useState(0)
  const [pitch, setPitch] = useState(0)
  const [message, setMessage] = useState('')
  const preset = LIGHT_PRESETS.find((p) => p.id === presetId)
  const num = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0))

  function make() {
    const result = createLightFromParts(uuids, {
      regionId,
      presetId,
      useSurfaceColour: useColour,
      aimMode,
      aim: preset && preset.directional ? { flip, yaw, pitch } : null,
    })
    setMessage(result.message)
    if (result.ok && onCreated) onCreated(result, { glow })
  }

  return (
    <div style={{ marginTop: 10 }}>
      <label className="field-label">{label}</label>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="select" aria-label="Light type" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
          {LIGHT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.directional ? '🔦' : '💡'} {p.label}
            </option>
          ))}
        </select>
        <button
          className="btn secondary"
          onClick={make}
          disabled={!uuids.length}
          title="Place a light on the selected part, tinted to match, aimed the way its surface faces"
        >
          💡 Make light
        </button>
      </div>

      <label className="color-control-solid" style={{ display: 'block', marginTop: 4 }} title="Tint the light to match the colour of the part">
        <input type="checkbox" checked={useColour} onChange={(e) => setUseColour(e.target.checked)} /> Use the part&apos;s colour
      </label>
      <label className="color-control-solid" style={{ display: 'block', marginTop: 2 }} title="Also make the part itself glow, so it looks lit as well as casting light">
        <input type="checkbox" checked={glow} onChange={(e) => setGlow(e.target.checked)} /> Turn the part itself into a light (glows)
      </label>

      {preset && preset.directional && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer' }}>Aim (if the beam points the wrong way)</summary>
          <div style={{ marginTop: 6 }}>
            <label className="slider-row" title="How the direction is worked out">
              <span className="slider-label">Aim by</span>
              <select className="select" aria-label="How to aim the beam" value={aimMode} onChange={(e) => setAimMode(e.target.value)}>
                {AIM_MODES.map((m) => (
                  <option key={m.id} value={m.id} title={m.hint}>{m.label}</option>
                ))}
              </select>
            </label>
            <label className="color-control-solid" style={{ display: 'block', marginTop: 4 }}>
              <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /> Flip it round (180°)
            </label>
            <label className="slider-row" title="Turn the beam left or right from the detected direction, 0-360 degrees">
              <span className="slider-label">Turn (yaw)</span>
              <input type="range" min={0} max={360} step={1} value={yaw} onChange={(e) => setYaw(num(e.target.value, 0, 360))} />
              <input type="number" aria-label="Yaw degrees" min={0} max={360} step={1} value={yaw} onChange={(e) => setYaw(num(e.target.value, 0, 360))} style={{ width: 56 }} />°
            </label>
            <label className="slider-row" title="Tilt the beam up (positive) or down (negative)">
              <span className="slider-label">Tilt (pitch)</span>
              <input type="range" min={-90} max={90} step={1} value={pitch} onChange={(e) => setPitch(num(e.target.value, -90, 90))} />
              <input type="number" aria-label="Pitch degrees" min={-90} max={90} step={1} value={pitch} onChange={(e) => setPitch(num(e.target.value, -90, 90))} style={{ width: 56 }} />°
            </label>
            <div className="radio-hint">These adjust the detected direction. After making the light you can also set its exact world direction in the Lights tab.</div>
          </div>
        </details>
      )}

      <div className="radio-hint" style={{ marginTop: 4 }}>
        {message || (preset ? preset.hint + '. The light follows the object it is on.' : '')}
      </div>
    </div>
  )
}
