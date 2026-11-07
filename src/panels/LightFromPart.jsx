import { useState } from 'react'
import { LIGHT_PRESETS } from '../three/lights.js'
import { createLightFromParts } from '../three/scene.js'
import { FxEditor, FxSection, FxField, FxCheck, FxHelp, FxFooter } from './FxCards.jsx'

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
// defaultPresetId: which light type the dropdown starts on. It starts on Soft glow everywhere;
// a specific type (e.g. the car headlight) is only ever picked by the person, never assumed.
//
// onCreated(result, { glow }) lets the caller make the surface glow too (parts and regions each
// do that their own way).
export default function LightFromPart({ uuids, regionId = null, label, onCreated, defaultPresetId = 'glow' }) {
  const [presetId, setPresetId] = useState(defaultPresetId)
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
    <FxEditor style={{ marginTop: 6 }}>
      <FxSection title={label} label="Make a light">
        <FxField label="Light type">
          <select aria-label="Light type" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
            {LIGHT_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.directional ? '🔦' : '💡'} {p.label}
              </option>
            ))}
          </select>
        </FxField>
        {preset && <FxHelp>{message || preset.hint + '. The light follows the object it is on.'}</FxHelp>}

        <FxCheck checked={useColour} onChange={setUseColour} title="Tint the light to match the colour of the part">
          Use the part&apos;s colour
        </FxCheck>
        <FxCheck checked={glow} onChange={setGlow} title="Also make the part itself glow, so it looks lit as well as casting light">
          Turn the part itself into a light (glows)
        </FxCheck>

        {preset && preset.directional && (
          <details className="fx-more">
            <summary>Aim (if the beam points the wrong way)</summary>
            <FxField label="Aim by" title="How the direction is worked out">
              <select aria-label="How to aim the beam" value={aimMode} onChange={(e) => setAimMode(e.target.value)}>
                {AIM_MODES.map((m) => (
                  <option key={m.id} value={m.id} title={m.hint}>{m.label}</option>
                ))}
              </select>
            </FxField>
            <FxCheck checked={flip} onChange={setFlip}>Flip it round (180°)</FxCheck>
            <label className="slider-row" title="Turn the beam left or right from the detected direction, 0-360 degrees">
              <span className="slider-label">Turn (yaw)</span>
              <input type="range" min={0} max={360} step={1} value={yaw} onChange={(e) => setYaw(num(e.target.value, 0, 360))} />
              <input type="number" aria-label="Yaw degrees" min={0} max={360} step={1} value={yaw} onChange={(e) => setYaw(num(e.target.value, 0, 360))} style={{ width: 56 }} />
            </label>
            <label className="slider-row" title="Tilt the beam up (positive) or down (negative)">
              <span className="slider-label">Tilt (pitch)</span>
              <input type="range" min={-90} max={90} step={1} value={pitch} onChange={(e) => setPitch(num(e.target.value, -90, 90))} />
              <input type="number" aria-label="Pitch degrees" min={-90} max={90} step={1} value={pitch} onChange={(e) => setPitch(num(e.target.value, -90, 90))} style={{ width: 56 }} />
            </label>
            <FxHelp>These adjust the detected direction. After making the light you can also set its exact world direction in the Lights tab.</FxHelp>
          </details>
        )}

        <FxFooter>
          <button
            className="btn secondary"
            onClick={make}
            disabled={!uuids.length}
            title="Place a light on the selected part, tinted to match, aimed the way its surface faces"
          >
            💡 Make light
          </button>
        </FxFooter>
      </FxSection>
    </FxEditor>
  )
}
