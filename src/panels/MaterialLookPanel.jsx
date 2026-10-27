import { useMemo, useState } from 'react'
import { useStore } from '../store.js'
import { countBumpMappedMaterials } from '../three/scene.js'
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
  const materialMode = useStore((s) => s.materialMode)
  const sceneObjects = useStore((s) => s.sceneObjects)
  const modelInfo = useStore((s) => s.modelInfo)
  const adjusted = look.contrast !== 0 || look.brightness !== 0 || look.saturation !== 0 || look.tintAmount !== 0
  const [adjustOpen] = useState(adjusted) // starts open if a look with adjustments is already set
  // What a control needs in order to show anything, so a setting that can't do anything here says so
  // (in the label) rather than looking broken.
  const bumpMapped = useMemo(() => countBumpMappedMaterials(), [sceneObjects, modelInfo])
  const noEffect = {
    finish: materialMode === 'unlit' && look.finish !== 'hatch' ? 'no shine in Flat colour lighting' : null,
    bumps: bumpMapped === 0 ? 'no bump maps in this scene' : materialMode === 'unlit' ? 'no effect in Flat colour lighting' : null,
  }

  // Each dropdown shows just its title and the chosen option; what it does (and what the chosen
  // option does) appears as a tooltip when you hover over it, so the panel stays uncluttered.
  const select = (label, key, options, hint, numeric = false) => {
    const current = options.find((o) => o.value === look[key])
    const tip = [hint, current && current.hint, noEffect[key] && 'Nothing to show right now: ' + noEffect[key] + '.'].filter(Boolean).join(' — ')
    return (
      <label className="field standalone-control material-look-field" title={tip || undefined}>
        <span className="field-label">
          {label}
          {noEffect[key] && <span className="material-look-note"> — {noEffect[key]}</span>}
        </span>
        <select
          className="select"
          aria-label={label}
          value={look[key]}
          onChange={(e) => setLook({ [key]: numeric ? Number(e.target.value) : e.target.value })}
        >
          {options.map((o) => (
            <option key={String(o.value)} value={o.value} title={o.hint}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    )
  }

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
      </div>

      {select('Apply to', 'scope', SCOPE_OPTIONS)}
      {select('Texture detail', 'detail', DETAIL_OPTIONS, 'Flat colour turns each textured surface into one plain colour — its own average.')}
      {look.detail === 'regions' && (
        <label
          className="slider-row"
          title="How different two colours must be to stay separate. Low: only very obvious changes survive (a window on a wall). High: subtler ones do too."
        >
          <span className="slider-label">Shape sensitivity</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={look.separation}
            onChange={(e) => setLook({ separation: Number(e.target.value) })}
          />
          <EditableValue
            value={look.separation}
            min={0}
            max={1}
            onChange={(v) => setLook({ separation: v })}
            format={(v) => Math.round(v * 100) + '%'}
            toInput={(v) => Math.round(v * 100)}
            fromInput={(v) => v / 100}
            label="Shape sensitivity"
          />
        </label>
      )}
      {select('Colours', 'colour', COLOUR_OPTIONS, 'Changes the texture colours, not the lighting — the textures stay.')}
      <details className="material-look-adjust" open={adjustOpen}>
        <summary title="Contrast, brightness, saturation and a tint colour, on top of the choices above">Adjust colour{adjusted ? ' •' : ''}</summary>
        <AdjustSlider label="Contrast" value={look.contrast} onChange={(v) => setLook({ contrast: v })} title="Less contrast is flatter and greyer; more is punchier" />
        <AdjustSlider label="Brightness" value={look.brightness} onChange={(v) => setLook({ brightness: v })} />
        <AdjustSlider label="Saturation" value={look.saturation} onChange={(v) => setLook({ saturation: v })} title="Left: towards no colour. Right: richer colour" />
        <label className="slider-row" title="Repaint everything in one colour while keeping the light and dark of the textures. Pick a colour, then set how much.">
          <span className="slider-label">Tint</span>
          <input
            type="color"
            className="color-control-swatch"
            aria-label="Tint colour"
            value={look.tint}
            onChange={(e) => setLook({ tint: e.target.value, ...(look.tintAmount === 0 ? { tintAmount: 0.5 } : {}) })}
          />
          <input
            type="range"
            aria-label="Tint amount"
            min={0}
            max={1}
            step={0.05}
            value={look.tintAmount}
            onChange={(e) => setLook({ tintAmount: Number(e.target.value) })}
          />
          <EditableValue
            value={look.tintAmount}
            min={0}
            max={1}
            onChange={(v) => setLook({ tintAmount: v })}
            format={(v) => Math.round(v * 100) + '%'}
            toInput={(v) => Math.round(v * 100)}
            fromInput={(v) => v / 100}
            label="Tint amount"
          />
        </label>
        <div className="kf-actions" style={{ marginTop: 6 }}>
          <button
            className="btn secondary"
            disabled={!adjusted && look.tint === '#ffffff'}
            onClick={() => setLook({ contrast: 0, brightness: 0, saturation: 0, tint: '#ffffff', tintAmount: 0 })}
          >
            Reset adjustments
          </button>
        </div>
      </details>
      {select('Colour tones', 'bands', BAND_OPTIONS, 'Fewer tones look more like paint or print.', true)}
      {select('Pixel size', 'pixels', PIXEL_OPTIONS, 'Chunky, low-resolution textures.', true)}
      {select('Surface finish', 'finish', FINISH_OPTIONS, 'Shine. Shows in Studio and Realistic lighting.')}
      {select('Bumps', 'bumps', BUMP_OPTIONS, 'Surface relief from normal / bump maps.')}

      <label className="slider-row" title="How much of the look is applied: 0% is the model's own materials, 100% is the full look">
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
      <div className="radio-hint" style={{ marginTop: 10 }}>
        Shown in the viewport and in rendered images and videos. Exported model files keep the model&apos;s own materials.
      </div>
    </div>
  )
}

// A -100% .. +100% slider (0 = leave as it is).
function AdjustSlider({ label, value, onChange, title }) {
  return (
    <label className="slider-row" title={title}>
      <span className="slider-label">{label}</span>
      <input type="range" aria-label={label} min={-1} max={1} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <EditableValue
        value={value}
        min={-1}
        max={1}
        onChange={onChange}
        format={(v) => (v > 0 ? '+' : '') + Math.round(v * 100) + '%'}
        toInput={(v) => Math.round(v * 100)}
        fromInput={(v) => v / 100}
        label={label}
      />
    </label>
  )
}
