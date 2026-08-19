import { useStore } from '../store.js'
import EditableValue from './EditableValue.jsx'

// Side-panel section: material mode + key-light controls.
// Unlit shows raw Blender colours (no lighting), Cartoon adds stepped anime
// shading, Soft Anime adds a smooth painterly ramp + optional rim glow,
// Standard is the original PBR. The light sliders only affect
// Cartoon/Soft/Standard, so they're disabled in Unlit mode.
const MODES = [
  { value: 'unlit', label: 'Flat colour', hint: 'Exact colours, no lighting' },
  { value: 'toon', label: 'Cartoon', hint: 'Hard-edged anime cel shading' },
  { value: 'soft', label: 'Soft Anime', hint: 'Smooth, gentle anime shading' },
  { value: 'standard', label: 'Realistic', hint: 'Full 3D PBR lighting' },
]

const TOON_STEP_OPTIONS = [2, 3, 4, 5]
const SHADING_OPTIONS = [
  { value: 'full', label: 'Full' },
  { value: 'soft', label: 'Soft' },
  { value: 'flat', label: 'Flat' },
]

// Friendly one-click light directions (azimuth°, elevation°).
const LIGHT_PRESETS = [
  { label: 'Front', az: 0, el: 20 },
  { label: 'Side', az: 75, el: 30 },
  { label: 'Rim', az: 155, el: 45 },
  { label: 'Top', az: 15, el: 80 },
]

// ---------------------------------------------------------------------------
// Style presets — one-click bundles of material mode + lighting + outline +
// rim light, tuned for different model styles. These exist because the raw
// sliders are powerful but fiddly to combine well; picking a preset gets you
// most of the way there, and every field it sets is still a normal slider
// underneath, so it's just a starting point, not a locked-in look.
// Deliberately DON'T touch envLightingEnabled's off-by-default meaning for
// Unlit/Cartoon/Soft styles (it only matters in Realistic) or per-mesh
// overrides, so switching styles never clobbers a model-specific fix.
// ---------------------------------------------------------------------------
export const STYLE_PRESETS = [
  {
    label: 'Flat Colour',
    hint: 'Exact Blender colours, no shading at all.',
    config: {
      materialMode: 'unlit',
      outlineEnabled: false,
      softenEnabled: false,
      rimSoftEnabled: false,
      rimHardEnabled: false,
    },
  },
  {
    label: 'Crisp Cel',
    hint: 'Bold 2–3 tone manga-style bands with a solid ink outline and a hard rim line.',
    config: {
      materialMode: 'toon',
      toonSteps: 2,
      softenEnabled: false,
      outlineEnabled: true,
      outlineWidth: 0.003,
      rimSoftEnabled: false,
      rimHardEnabled: true,
      rimHardIntensity: 0.9,
      rimHardWidth: 0.3,
      rimLightColor: '#ffffff',
      lightIntensity: 2.2,
      lightAzimuth: 35,
      lightElevation: 45,
    },
  },
  {
    label: 'Soft Anime',
    hint: 'Gentle, airbrushed shading with a soft glow at the edges — a good default for most anime-style models.',
    config: {
      materialMode: 'soft',
      softenEnabled: true,
      softenAmount: 0.3,
      outlineEnabled: true,
      outlineWidth: 0.0015,
      rimSoftEnabled: true,
      rimSoftIntensity: 0.5,
      rimSoftWidth: 0.5,
      rimHardEnabled: false,
      rimLightColor: '#fff2d8',
      lightIntensity: 1.8,
      lightAzimuth: 25,
      lightElevation: 55,
    },
  },
  {
    label: 'Painterly',
    hint: 'Very soft, almost hand-painted shading with no hard outline — good for rounder, softer character designs.',
    config: {
      materialMode: 'soft',
      softenEnabled: true,
      softenAmount: 0.55,
      outlineEnabled: false,
      rimSoftEnabled: true,
      rimSoftIntensity: 0.25,
      rimSoftWidth: 0.65,
      rimHardEnabled: false,
      rimLightColor: '#ffe9c7',
      lightIntensity: 1.5,
      lightAzimuth: 20,
      lightElevation: 50,
    },
  },
  {
    label: 'Toy / Figure',
    hint: 'Bright, even product-shot lighting so the model reads clearly from every angle.',
    config: {
      materialMode: 'standard',
      envLightingEnabled: true,
      envLightingIntensity: 0.8,
      outlineEnabled: true,
      outlineWidth: 0.0015,
      lightIntensity: 1.8,
      lightAzimuth: 35,
      lightElevation: 50,
    },
  },
  {
    label: 'Realistic Studio',
    hint: 'Softer key light plus all-round fill, so PBR/realistic models don\u2019t get harsh, uncanny shadows across the face.',
    config: {
      materialMode: 'standard',
      envLightingEnabled: true,
      envLightingIntensity: 1.0,
      outlineEnabled: false,
      lightIntensity: 1.4,
      lightAzimuth: 30,
      lightElevation: 40,
    },
  },
  {
    label: 'Cinematic',
    hint: 'Moody single-source side lighting with strong falloff, for dramatic renders and screenshots.',
    config: {
      materialMode: 'standard',
      envLightingEnabled: true,
      envLightingIntensity: 0.35,
      outlineEnabled: false,
      lightIntensity: 2.6,
      lightAzimuth: 110,
      lightElevation: 35,
    },
  },
  {
    label: 'Ink Outline',
    hint: 'Flat colour with a heavy ink line and zero shading \u2014 clean manga-panel look.',
    config: {
      materialMode: 'unlit',
      outlineEnabled: true,
      outlineWidth: 0.01,
      softenEnabled: false,
      rimSoftEnabled: false,
      rimHardEnabled: false,
    },
  },
]

export default function MaterialPanel() {
  const modelInfo = useStore((s) => s.modelInfo)
  const materialMode = useStore((s) => s.materialMode)
  const toonSteps = useStore((s) => s.toonSteps)
  const lightIntensity = useStore((s) => s.lightIntensity)
  const lightAzimuth = useStore((s) => s.lightAzimuth)
  const lightElevation = useStore((s) => s.lightElevation)
  const envLightingEnabled = useStore((s) => s.envLightingEnabled)
  const envLightingIntensity = useStore((s) => s.envLightingIntensity)

  const outlineEnabled = useStore((s) => s.outlineEnabled)
  const outlineWidth = useStore((s) => s.outlineWidth)
  const softenEnabled = useStore((s) => s.softenEnabled)
  const softenAmount = useStore((s) => s.softenAmount)
  const meshOverrides = useStore((s) => s.meshOverrides)
  const rimLightColor = useStore((s) => s.rimLightColor)
  const rimSideOnly = useStore((s) => s.rimSideOnly)
  const rimSoftEnabled = useStore((s) => s.rimSoftEnabled)
  const rimSoftIntensity = useStore((s) => s.rimSoftIntensity)
  const rimSoftWidth = useStore((s) => s.rimSoftWidth)
  const rimHardEnabled = useStore((s) => s.rimHardEnabled)
  const rimHardIntensity = useStore((s) => s.rimHardIntensity)
  const rimHardWidth = useStore((s) => s.rimHardWidth)
  const rimFollowLight = useStore((s) => s.rimFollowLight)
  const rimFollowLightId = useStore((s) => s.rimFollowLightId)
  const sceneLights = useStore((s) => s.sceneLights)
  const followedLightName = sceneLights.find((lt) => lt.id === rimFollowLightId)?.name

  const setMaterialMode = useStore((s) => s.setMaterialMode)
  const setToonSteps = useStore((s) => s.setToonSteps)
  const setLightIntensity = useStore((s) => s.setLightIntensity)
  const setLightAzimuth = useStore((s) => s.setLightAzimuth)
  const setLightElevation = useStore((s) => s.setLightElevation)
  const setEnvLightingEnabled = useStore((s) => s.setEnvLightingEnabled)
  const setEnvLightingIntensity = useStore((s) => s.setEnvLightingIntensity)
  const setOutlineEnabled = useStore((s) => s.setOutlineEnabled)
  const setOutlineWidth = useStore((s) => s.setOutlineWidth)
  const setSoftenEnabled = useStore((s) => s.setSoftenEnabled)
  const setSoftenAmount = useStore((s) => s.setSoftenAmount)
  const setRimLightColor = useStore((s) => s.setRimLightColor)
  const setRimSideOnly = useStore((s) => s.setRimSideOnly)
  const setRimSoftEnabled = useStore((s) => s.setRimSoftEnabled)
  const setRimSoftIntensity = useStore((s) => s.setRimSoftIntensity)
  const setRimSoftWidth = useStore((s) => s.setRimSoftWidth)
  const setRimHardEnabled = useStore((s) => s.setRimHardEnabled)
  const setRimHardIntensity = useStore((s) => s.setRimHardIntensity)
  const setRimHardWidth = useStore((s) => s.setRimHardWidth)
  const setRimFollowLight = useStore((s) => s.setRimFollowLight)
  const setRimFollowLightId = useStore((s) => s.setRimFollowLightId)
  const setMeshOutline = useStore((s) => s.setMeshOutline)
  const setMeshShading = useStore((s) => s.setMeshShading)
  const setMeshVisible = useStore((s) => s.setMeshVisible)
  const applyStylePreset = useStore((s) => s.applyStylePreset)

  const lit = materialMode !== 'unlit' // lights only matter for toon/soft/standard
  const rimCapable = materialMode === 'toon' || materialMode === 'soft'
  const meshes = modelInfo?.meshes || []

  function applyLightPreset(p) {
    setLightAzimuth(p.az)
    setLightElevation(p.el)
  }

  return (
    <div className="panel">
      <h2>Look</h2>
      <p className="panel-hint">Choose how the character is shaded and outlined.</p>

      <div className="field">
        <label className="field-label">Style presets</label>
        <div className="preset-row" style={{ flexWrap: 'wrap' }}>
          {STYLE_PRESETS.map((p) => (
            <button
              key={p.label}
              className="preset-btn"
              title={p.hint}
              onClick={() => applyStylePreset(p.config)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="radio-hint" style={{ marginTop: 2 }}>
          One-click starting points — every setting they change is still a normal
          control below, so feel free to tweak after picking one.
        </div>
      </div>

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

      <div className={'light-controls' + (rimCapable ? '' : ' disabled')}>
        <div className="field-label" style={{ marginTop: 0 }}>
          Rim light {rimCapable ? '' : '(only affects Cartoon / Soft Anime)'}
        </div>

        <label className="toggle-row" style={{ padding: 0 }}>
          <input
            type="checkbox"
            checked={rimSoftEnabled}
            disabled={!rimCapable}
            onChange={(e) => setRimSoftEnabled(e.target.checked)}
          />
          Soft glow
        </label>
        <Slider
          label="Strength"
          min={0}
          max={1.5}
          step={0.05}
          value={rimSoftIntensity}
          disabled={!rimCapable || !rimSoftEnabled}
          onChange={setRimSoftIntensity}
          format={(v) => v.toFixed(2)}
        />
        <Slider
          label="Width"
          min={0}
          max={1}
          step={0.05}
          value={rimSoftWidth}
          disabled={!rimCapable || !rimSoftEnabled}
          onChange={setRimSoftWidth}
          format={(v) => Math.round(v * 100) + '%'}
          toInput={(v) => Math.round(v * 100)}
          fromInput={(v) => v / 100}
        />

        <label className="toggle-row" style={{ padding: 0, marginTop: 6 }}>
          <input
            type="checkbox"
            checked={rimHardEnabled}
            disabled={!rimCapable}
            onChange={(e) => setRimHardEnabled(e.target.checked)}
          />
          Hard line
        </label>
        <Slider
          label="Strength"
          min={0}
          max={1.5}
          step={0.05}
          value={rimHardIntensity}
          disabled={!rimCapable || !rimHardEnabled}
          onChange={setRimHardIntensity}
          format={(v) => v.toFixed(2)}
        />
        <Slider
          label="Width"
          min={0}
          max={1}
          step={0.05}
          value={rimHardWidth}
          disabled={!rimCapable || !rimHardEnabled}
          onChange={setRimHardWidth}
          format={(v) => Math.round(v * 100) + '%'}
          toInput={(v) => Math.round(v * 100)}
          fromInput={(v) => v / 100}
        />

        <label className="slider-row" style={{ marginTop: 6 }}>
          <span className="slider-label">Colour</span>
          <input
            type="color"
            value={rimLightColor}
            disabled={!rimCapable || (!rimSoftEnabled && !rimHardEnabled) || rimFollowLight}
            onChange={(e) => setRimLightColor(e.target.value)}
          />
        </label>
        {rimFollowLight && (
          <div className="radio-hint" style={{ marginTop: -2 }}>
            Following {followedLightName || 'a scene light'}'s colour + direction (set in the Lights
            panel).{' '}
            <button
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                color: 'var(--accent, #7dd3fc)',
                textDecoration: 'underline',
                cursor: 'pointer',
                font: 'inherit',
              }}
              onClick={() => {
                setRimFollowLight(false)
                setRimFollowLightId(null)
              }}
            >
              Stop following
            </button>
          </div>
        )}

        <label className="toggle-row" style={{ padding: 0, marginTop: 4 }}>
          <input
            type="checkbox"
            checked={rimSideOnly}
            disabled={!rimCapable || (!rimSoftEnabled && !rimHardEnabled)}
            onChange={(e) => setRimSideOnly(e.target.checked)}
          />
          Directional (light side only)
        </label>

        <div className="radio-hint" style={{ marginTop: 2 }}>
          {rimCapable
            ? 'Soft and Hard are independent \u2014 turn on either, or both. Width controls how far each reaches in from the silhouette. Directional limits the glow to just the side of the character the key light is coming from (e.g. a light from the right only lights the right edge), which reads as calmer than the default all-round rim. To use a placed light instead of the key light, mark it "drive the rim light" in the Lights panel.'
            : 'Only affects Cartoon / Soft Anime modes.'}
        </div>
      </div>

      <div className={'light-controls' + (lit ? '' : ' disabled')}>
        <div className="field-label" style={{ marginTop: 4 }}>
          Light {lit ? '' : '(only affects Cartoon / Soft Anime / Realistic)'}
        </div>

        <div className="preset-row">
          {LIGHT_PRESETS.map((p) => (
            <button
              key={p.label}
              className="preset-btn"
              disabled={!lit}
              onClick={() => applyLightPreset(p)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <Slider
          label="Brightness"
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

      <div className={'light-controls' + (materialMode === 'standard' ? '' : ' disabled')}>
        <label className="toggle-row" style={{ padding: 0 }}>
          <input
            type="checkbox"
            checked={envLightingEnabled}
            disabled={materialMode !== 'standard'}
            onChange={(e) => setEnvLightingEnabled(e.target.checked)}
          />
          Studio environment lighting
        </label>

        <Slider
          label="Strength"
          min={0}
          max={2}
          step={0.05}
          value={envLightingIntensity}
          disabled={materialMode !== 'standard' || !envLightingEnabled}
          onChange={setEnvLightingIntensity}
          format={(v) => v.toFixed(2)}
        />
        <div className="radio-hint" style={{ marginTop: 2 }}>
          {materialMode === 'standard'
            ? 'Soft all-round studio fill (like Blender\u2019s Material Preview) so the character reads well from every angle, even without extra lights.'
            : 'Only affects Realistic mode.'}
        </div>
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
          // the raw fraction (0.003 -> "3.0"), and let typed values use the same
          // scale.
          format={(v) => (v * 1000).toFixed(1)}
          toInput={(v) => v * 1000}
          fromInput={(v) => v / 1000}
        />
      </div>

      <div className="light-controls">
        <label className="toggle-row" style={{ padding: 0 }}>
          <input
            type="checkbox"
            checked={softenEnabled}
            onChange={(e) => setSoftenEnabled(e.target.checked)}
          />
          Soften shading
        </label>

        <Slider
          label="Amount"
          min={0}
          max={1}
          step={0.05}
          value={softenAmount}
          disabled={!softenEnabled}
          onChange={setSoftenAmount}
          format={(v) => Math.round(v * 100) + '%'}
          toInput={(v) => Math.round(v * 100)}
          fromInput={(v) => v / 100}
        />
        <div className="radio-hint" style={{ marginTop: 2 }}>
          Lifts toon shadows and thins the outline everywhere.
        </div>
      </div>

      {meshes.length > 0 && (
        <div className="light-controls">
          <div className="field-label">Parts (hide, outline or flatten the face, etc.)</div>
          <div className="mesh-row mesh-head">
            <span>Part</span>
            <span title="Show / hide this part">Show</span>
            <span title="Outline this part">Line</span>
            <span title="Shading (Flat = no lighting)">Shade</span>
          </div>
          <div className="mesh-list">
            {meshes.map((m) => {
              const ov = meshOverrides[m.uuid] || {}
              const visible = ov.visible !== false
              const outlineOn = ov.outline !== false
              const shading = ov.shading || 'full'
              return (
                <div key={m.uuid} className={'mesh-row' + (visible ? '' : ' mesh-hidden')}>
                  <span className="mesh-name" title={m.name}>
                    {m.name}
                  </span>
                  <label className="mesh-cell" title="Show / hide this part">
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={(e) => setMeshVisible(m.uuid, e.target.checked)}
                    />
                  </label>
                  <label className="mesh-cell" title="Draw an outline around this part">
                    <input
                      type="checkbox"
                      checked={outlineOn}
                      disabled={!visible}
                      onChange={(e) => setMeshOutline(m.uuid, e.target.checked)}
                    />
                  </label>
                  <select
                    className="select select-sm"
                    value={shading}
                    disabled={!visible}
                    title="Shading for this part (Flat = no lighting)"
                    onChange={(e) => setMeshShading(m.uuid, e.target.value)}
                  >
                    {SHADING_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// A labelled range input with a click-to-edit numeric readout.
function Slider({ label, value, min, max, step, disabled, onChange, format, toInput, fromInput }) {
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