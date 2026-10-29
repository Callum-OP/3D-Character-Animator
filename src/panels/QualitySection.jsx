import { useStore } from '../store.js'
import { QUALITY_PRESETS, getQualityPreset } from '../three/qualityPresets.js'

// The main performance control: one choice for how much memory and GPU time the app may use
// (see three/qualityPresets.js). The finer controls (performance mode, import texture limit, edge
// smoothing) are under "Advanced performance" below it.

export default function QualitySection() {
  const qualityPreset = useStore((s) => s.qualityPreset)
  const setQualityPreset = useStore((s) => s.setQualityPreset)
  const preset = getQualityPreset(qualityPreset)

  return (
    <div className="quality-section">
      <h3 style={{ margin: '12px 0 4px' }}>Quality</h3>
      <div role="group" aria-label="Quality" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {QUALITY_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`btn ${p.id === preset.id ? '' : 'secondary'}`}
            aria-pressed={p.id === preset.id}
            onClick={() => setQualityPreset(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="panel-hint" style={{ marginTop: 6 }}>
        {preset.hint}
      </p>
    </div>
  )
}
