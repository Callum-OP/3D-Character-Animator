import { useStore } from '../store.js'
import EditableValue from './EditableValue.jsx'
import {
  TEXTURE_LOOK_PRESETS,
  DETAIL_OPTIONS,
  COLOUR_OPTIONS,
  BAND_OPTIONS,
  PIXEL_OPTIONS,
  FINISH_OPTIONS,
  BUMP_OPTIONS,
  SCOPE_OPTIONS,
  isTextureLookActive,
} from '../three/textureLookOptions.js'

// Look > Material. Changes what the surfaces themselves are made of — textures, colours and
// finish — where Look > Lighting changes how they are lit. The two work together: switch on
// Noir lighting AND Noir textures, or keep cartoon lighting but flatten a detailed floor to one
// plain colour.
export default function MaterialLookPanel() {
  const look = useStore((s) => s.materialLook)
  const setLook = useStore((s) => s.setMaterialLook)
  const applyPreset = useStore((s) => s.applyMaterialLookPreset)
  const active = isTextureLookActive(look)

  const select = (label, key, options, hint, numeric = false) => (
    <label className="field standalone-control">
      <span className="field-label">{label}</span>
      <select
        className="select"
        aria-label={label}
        value={look[key]}
        onChange={(e) => setLook({ [key]: numeric ? Number(e.target.value) : e.target.value })}
        title={options.find((o) => o.value === look[key])?.hint}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={o.value} title={o.hint}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <span className="radio-hint">{hint}</span>}
    </label>
  )

  return (
    <div className="panel">
      <h2>Material</h2>
      <p className="panel-hint">
        Change the surfaces themselves — textures, colours and finish. It works alongside the Lighting tab, so you can combine them.
      </p>

      <div className="field">
        <label className="field-label">Material presets</label>
        <div className="preset-row" style={{ flexWrap: 'wrap' }}>
          {TEXTURE_LOOK_PRESETS.map((p) => (
            <button
              key={p.id}
              className={'preset-btn' + (look.preset === p.id ? ' active' : '')}
              title={p.hint}
              aria-pressed={look.preset === p.id}
              onClick={() => applyPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="radio-hint" style={{ marginTop: 2 }}>
          One-click starting points — every setting they change is a normal control below.
        </div>
      </div>

      {select('Apply to', 'scope', SCOPE_OPTIONS)}
      {select('Texture detail', 'detail', DETAIL_OPTIONS, 'Flat colour turns each textured surface into one plain colour — its own average.')}
      {select('Colours', 'colour', COLOUR_OPTIONS, 'Changes the texture colours, not the lighting — the textures stay.')}
      {select('Colour tones', 'bands', BAND_OPTIONS, 'Fewer tones look more like paint or print.', true)}
      {select('Pixel size', 'pixels', PIXEL_OPTIONS, 'Chunky, low-resolution textures.', true)}
      {select('Surface finish', 'finish', FINISH_OPTIONS, 'Shine. Shows in Studio and Realistic lighting.')}
      {select('Bumps', 'bumps', BUMP_OPTIONS, 'Surface relief from normal / bump maps.')}

      <label className="slider-row">
        <span className="slider-label">Strength</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={look.strength}
          onChange={(e) => setLook({ strength: Number(e.target.value) })}
        />
        <EditableValue
          value={look.strength}
          min={0}
          max={1}
          onChange={(v) => setLook({ strength: v })}
          format={(v) => Math.round(v * 100) + '%'}
          toInput={(v) => Math.round(v * 100)}
          fromInput={(v) => v / 100}
          label="Strength"
        />
      </label>

      <div className="kf-actions" style={{ marginTop: 8 }}>
        <button className="btn secondary" disabled={!active && look.preset === 'original'} onClick={() => applyPreset('original')}>
          Back to original materials
        </button>
      </div>
      <div className="radio-hint" style={{ marginTop: 6 }}>
        Shown in the viewport and in rendered images and videos. Exported model files keep the model&apos;s own materials.
      </div>
    </div>
  )
}
