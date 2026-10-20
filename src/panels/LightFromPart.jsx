import { useState } from 'react'
import { LIGHT_PRESETS } from '../three/lights.js'
import { createLightFromParts } from '../three/scene.js'

// "Make a light from this": puts a real light where the selected part(s) — or a painted region
// of one — sit, tinted to match, instead of placing one by hand. Shown in the Parts panel for
// parts and in the region editor for regions. See scene.js createLightFromParts.
export default function LightFromPart({ uuids, regionId = null, label, onCreated, children }) {
  const [presetId, setPresetId] = useState('glow')
  const [useColour, setUseColour] = useState(true)
  const [message, setMessage] = useState('')
  const preset = LIGHT_PRESETS.find((p) => p.id === presetId)

  function make() {
    const result = createLightFromParts(uuids, { regionId, presetId, useSurfaceColour: useColour })
    setMessage(result.message)
    if (result.ok && onCreated) onCreated(result)
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
      {children}
      <div className="radio-hint" style={{ marginTop: 4 }}>
        {message || (preset ? preset.hint + '. The light follows the object it is on.' : '')}
      </div>
    </div>
  )
}
