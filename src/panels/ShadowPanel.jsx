import { useStore } from '../store.js'
import EditableValue from './EditableValue.jsx'
import {
  DEFAULT_NIGHT,
  SHADOW_STYLES,
  SHADOW_QUALITY,
  DEFAULT_SHADOWS,
  MIN_SHADOW_SIZE,
  MAX_SHADOW_SIZE,
  detectShadowStyle,
  getShadowStyle,
} from '../three/shadowSettings.js'

// Every shadow control in one place (Look > Shadows). Pick a style for a one-click look, then
// fine-tune: the style buttons only ever set Light size / Contact-hardening / Darkness, so
// they are ordinary controls underneath and the highlighted style is worked out from them
// (touch a slider and no style is highlighted any more).

function Slider({ label, value, min, max, step, disabled, onChange, format, toInput, fromInput, title }) {
  return (
    <label className="slider-row" title={title}>
      <span className="slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <EditableValue
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={onChange}
        format={format}
        toInput={toInput}
        fromInput={fromInput}
        label={label}
      />
    </label>
  )
}

const percent = (v) => Math.round(v * 100) + '%'

export default function ShadowPanel() {
  const shadows = useStore((s) => s.shadows)
  const setShadows = useStore((s) => s.setShadows)
  const applyShadowStyle = useStore((s) => s.applyShadowStyle)

  const { enabled, quality, size, contact, darkness, tint, selfShadow } = shadows
  const real = quality !== 'blob'
  const adjustable = enabled && real
  const activeId = detectShadowStyle(shadows)
  const active = getShadowStyle(activeId)
  const qualityInfo = SHADOW_QUALITY.find((q) => q.id === quality) || SHADOW_QUALITY[3]
  const d = DEFAULT_SHADOWS
  const atDefault =
    enabled === d.enabled && selfShadow === d.selfShadow && quality === d.quality && size === d.size && contact === d.contact && darkness === d.darkness && tint === d.tint

  return (
    <div className="shadow-panel">
      <label className="toggle-row" title="Turn all shadows on or off">
        <input type="checkbox" checked={enabled} onChange={(e) => setShadows({ enabled: e.target.checked })} />
        Shadows
      </label>

      <div className="field">
        <label className="field-label">Style</label>
        <div className="preset-row">
          {SHADOW_STYLES.map((st) => (
            <button
              key={st.id}
              className={'preset-btn' + (activeId === st.id ? ' active' : '')}
              title={adjustable ? st.hint : 'Switch shadows on and pick a quality above Simple to use shadow styles'}
              aria-pressed={activeId === st.id}
              disabled={!adjustable}
              onClick={() => applyShadowStyle(st.id)}
            >
              {st.label}
            </button>
          ))}
        </div>
        <div className="radio-hint" style={{ marginTop: 2 }}>
          {!enabled
            ? 'Shadows are off.'
            : !real
              ? 'Simple shadows are a soft circle under the character. Choose Low or higher quality for real, styled shadows.'
              : active
                ? active.hint
                : 'Custom: adjusted by hand. Pick a style above to go back to a preset.'}
        </div>
      </div>

      <Slider
        label="Light size"
        min={MIN_SHADOW_SIZE}
        max={MAX_SHADOW_SIZE}
        step={0.5}
        value={size}
        disabled={!adjustable}
        onChange={(v) => setShadows({ size: v })}
        format={(v) => (v === 0 ? 'Sharp' : v.toFixed(1) + '°')}
        title="How big the light is. Small = crisp, hard-edged shadows (the real sun is about 0.5°); large = soft, wide shadows like a cloudy sky or a big softbox."
      />
      <Slider
        label="Darkness"
        min={0}
        max={1}
        step={0.05}
        value={darkness}
        disabled={!enabled}
        onChange={(v) => setShadows({ darkness: v })}
        format={percent}
        toInput={(v) => Math.round(v * 100)}
        fromInput={(v) => v / 100}
      />

      <label
        className="toggle-row"
        title="Like a real light: shadows are sharp where an object touches the surface and get softer the further they fall. Off = the same blur along the whole edge."
      >
        <input
          type="checkbox"
          checked={contact}
          disabled={!adjustable}
          onChange={(e) => setShadows({ contact: e.target.checked })}
        />
        Contact-hardening (sharp at contact, softer with distance)
      </label>

      <label
        className="toggle-row"
        title="Parts of one object shade each other: an arm shades the body, a chair leg shades the seat, a roof shades the room beneath it. Switch off for lighter shadows with fewer streaks or speckles on curved surfaces."
      >
        <input
          type="checkbox"
          checked={selfShadow}
          disabled={!adjustable}
          onChange={(e) => setShadows({ selfShadow: e.target.checked })}
        />
        Self-shadowing (parts of an object shade each other)
      </label>

      <label className="slider-row">
        <span className="slider-label">Colour</span>
        <input
          type="color"
          value={tint}
          disabled={!enabled}
          onChange={(e) => setShadows({ tint: e.target.value })}
          title="Tints the shadows (hue only; darkness is set above). White = neutral."
        />
        <button
          className="preset-btn"
          style={{ marginLeft: 6 }}
          disabled={!enabled || tint === DEFAULT_SHADOWS.tint}
          onClick={() => setShadows({ tint: DEFAULT_SHADOWS.tint })}
        >
          Reset
        </button>
      </label>

      <div className="field">
        <label className="field-label">Quality</label>
        <select
          className="select"
          value={quality}
          disabled={!enabled}
          onChange={(e) => setShadows({ quality: e.target.value })}
        >
          {SHADOW_QUALITY.map((q) => (
            <option key={q.id} value={q.id}>{q.label}</option>
          ))}
        </select>
        <div className="radio-hint">{qualityInfo.hint} Higher quality gives smoother, less blocky edges but costs GPU time.</div>
      </div>

      <button
        className="preset-btn"
        style={{ width: '100%', marginTop: 6 }}
        disabled={atDefault}
        onClick={() => setShadows({ ...DEFAULT_SHADOWS })}
        title="Back to realistic shadows at High quality"
      >
        Reset to realistic default
      </button>

      <div className="radio-hint" style={{ marginTop: 6 }}>
        The shadow direction follows the key light (the Light controls above). Per-object shadow switches are in
        Scene &gt; Objects, and extra lights have their own Cast shadows switch in Scene &gt; Lights.
      </div>
    </div>
  )
}

// Night mode: a dark wash over the whole scene, as if a huge object were covering it. Objects
// and characters can opt out with the 🌙 button on their row in the Objects list.
export function NightPanel() {
  const night = useStore((s) => s.night)
  const setNight = useStore((s) => s.setNight)
  const { enabled, strength, tint } = night
  return (
    <div className="shadow-panel">
      <label className="toggle-row" title="Darken the whole scene, lit or flat">
        <input type="checkbox" checked={enabled} onChange={(e) => setNight({ enabled: e.target.checked })} />
        Night mode
      </label>
      <Slider
        label="Strength"
        min={0}
        max={1}
        step={0.05}
        value={strength}
        disabled={!enabled}
        onChange={(v) => setNight({ strength: v })}
        format={percent}
        toInput={(v) => Math.round(v * 100)}
        fromInput={(v) => v / 100}
        title="How dark the night is. 100% is pitch black."
      />
      <label className="slider-row">
        <span className="slider-label">Colour</span>
        <input
          type="color"
          value={tint}
          disabled={!enabled}
          onChange={(e) => setNight({ tint: e.target.value })}
          title="The colour cast of the night (hue only; strength is set above)."
        />
        <button
          className="preset-btn"
          style={{ marginLeft: 6 }}
          disabled={!enabled || tint === DEFAULT_NIGHT.tint}
          onClick={() => setNight({ tint: DEFAULT_NIGHT.tint })}
        >
          Reset
        </button>
      </label>
      <div className="radio-hint" style={{ marginTop: 4 }}>
        Darkens everything in the scene, including flat-coloured models and the background. To keep something lit
        (a lamp, the hero), press its 🌙 button in the Objects list. Night mode is saved with the project.
      </div>
    </div>
  )
}
