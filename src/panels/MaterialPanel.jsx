import { useStore } from '../store.js'

// Side-panel section: material mode + key-light controls (Phase 2).
// Unlit shows raw Blender colours (no lighting), Toon adds stepped anime shading,
// Standard is the original PBR. The light sliders only affect Toon/Standard, so
// they're disabled in Unlit mode.
const MODES = [
  { value: 'unlit', label: 'Unlit', hint: 'Raw Blender colours, no lighting' },
  { value: 'toon', label: 'Toon', hint: 'Stepped anime shading' },
  { value: 'standard', label: 'Standard', hint: 'Original PBR lighting' },
]

const TOON_STEP_OPTIONS = [2, 3, 4, 5]

export default function MaterialPanel() {
  const materialMode = useStore((s) => s.materialMode)
  const toonSteps = useStore((s) => s.toonSteps)
  const lightIntensity = useStore((s) => s.lightIntensity)
  const lightAzimuth = useStore((s) => s.lightAzimuth)
  const lightElevation = useStore((s) => s.lightElevation)

  const outlineEnabled = useStore((s) => s.outlineEnabled)
  const outlineWidth = useStore((s) => s.outlineWidth)

  const setMaterialMode = useStore((s) => s.setMaterialMode)
  const setToonSteps = useStore((s) => s.setToonSteps)
  const setLightIntensity = useStore((s) => s.setLightIntensity)
  const setLightAzimuth = useStore((s) => s.setLightAzimuth)
  const setLightElevation = useStore((s) => s.setLightElevation)
  const setOutlineEnabled = useStore((s) => s.setOutlineEnabled)
  const setOutlineWidth = useStore((s) => s.setOutlineWidth)

  const lit = materialMode !== 'unlit' // lights only matter for toon/standard

  return (
    <div className="panel">
      <h2>Material</h2>

      <div className="radio-group">
        {MODES.map((m) => (
          <label key={m.value} className="radio-row" title={m.hint}>
            <input
              type="radio"
              name="material-mode"
              checked={materialMode === m.value}
              onChange={() => setMaterialMode(m.value)}
            />
            <span className="radio-label">{m.label}</span>
            <span className="radio-hint">{m.hint}</span>
          </label>
        ))}
      </div>

      {materialMode === 'toon' && (
        <div className="field">
          <label className="field-label">Shadow bands</label>
          <select
            className="select"
            value={toonSteps}
            onChange={(e) => setToonSteps(Number(e.target.value))}
          >
            {TOON_STEP_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}-step
              </option>
            ))}
          </select>
        </div>
      )}

      <div className={'light-controls' + (lit ? '' : ' disabled')}>
        <div className="field-label" style={{ marginTop: 4 }}>
          Key light {lit ? '' : '(unused in Unlit)'}
        </div>

        <Slider
          label="Intensity"
          min={0}
          max={5}
          step={0.1}
          value={lightIntensity}
          disabled={!lit}
          onChange={setLightIntensity}
          format={(v) => v.toFixed(1)}
        />
        <Slider
          label="Direction"
          min={-180}
          max={180}
          step={1}
          value={lightAzimuth}
          disabled={!lit}
          onChange={setLightAzimuth}
          format={(v) => v + '°'}
        />
        <Slider
          label="Height"
          min={0}
          max={90}
          step={1}
          value={lightElevation}
          disabled={!lit}
          onChange={setLightElevation}
          format={(v) => v + '°'}
        />
      </div>

      <div className="light-controls">
        <label className="toggle-row" style={{ padding: 0 }}>
          <input
            type="checkbox"
            checked={outlineEnabled}
            onChange={(e) => setOutlineEnabled(e.target.checked)}
          />
          Outline
        </label>

        <Slider
          label="Width"
          min={0.0005}
          max={0.02}
          step={0.0005}
          value={outlineWidth}
          disabled={!outlineEnabled}
          onChange={setOutlineWidth}
          // Screen-space thickness; show a friendly 1-decimal number rather than
          // the raw fraction (0.003 -> "3.0").
          format={(v) => (v * 1000).toFixed(1)}
        />
      </div>
    </div>
  )
}

// A labelled range input with a live numeric readout.
function Slider({ label, value, min, max, step, disabled, onChange, format }) {
  return (
    <label className="slider-row">
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
      <span className="slider-value">{format(value)}</span>
    </label>
  )
}
