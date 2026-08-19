import { useStore } from '../store.js'
import EditableValue from './EditableValue.jsx'

// Side-panel section: viewport display toggles (grid, ground shadow, background,
// stats). Background defaults to transparent because rendered output is meant for
// dropping into 2D art.
export default function ViewPanel() {
  const showGrid = useStore((s) => s.showGrid)
  const showGround = useStore((s) => s.showGround)
  const showShadow = useStore((s) => s.showShadow)
  const shadowMapping = useStore((s) => s.shadowMapping)
  const shadowSoftness = useStore((s) => s.shadowSoftness)
  const shadowStrength = useStore((s) => s.shadowStrength)
  const solidBackground = useStore((s) => s.solidBackground)
  const backgroundColor = useStore((s) => s.backgroundColor)
  const showStats = useStore((s) => s.showStats)
  const setShowGrid = useStore((s) => s.setShowGrid)
  const setShowGround = useStore((s) => s.setShowGround)
  const setShowShadow = useStore((s) => s.setShowShadow)
  const setShadowMapping = useStore((s) => s.setShadowMapping)
  const setShadowSoftness = useStore((s) => s.setShadowSoftness)
  const setShadowStrength = useStore((s) => s.setShadowStrength)
  const setSolidBackground = useStore((s) => s.setSolidBackground)
  const setBackgroundColor = useStore((s) => s.setBackgroundColor)
  const setShowStats = useStore((s) => s.setShowStats)

  return (
    <div className="panel">
      <h2>Scene</h2>
      <p className="panel-hint">
        The background is see-through by default, so saved images layer cleanly
        into 2D art.
      </p>

      <label className="toggle-row">
        <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
        Show floor grid
      </label>

      <label className="toggle-row" title="A solid floor under the character (it's also what a ragdoll falls onto)">
        <input
          type="checkbox"
          checked={showGround}
          onChange={(e) => setShowGround(e.target.checked)}
        />
        Show ground
      </label>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={showShadow}
          onChange={(e) => setShowShadow(e.target.checked)}
        />
        Ground shadow
      </label>

      {showShadow && (
        <label className="toggle-row" style={{ paddingLeft: 22 }} title="Real cast shadows instead of a simple blob">
          <input
            type="checkbox"
            checked={shadowMapping}
            onChange={(e) => setShadowMapping(e.target.checked)}
          />
          Realistic shadows
        </label>
      )}

      {showShadow && shadowMapping && (
        <div style={{ paddingLeft: 22 }}>
          <label className="slider-row" title="How blurred the shadow's edge is — 0 is a crisp cut, higher is soft and diffused">
            <span className="slider-label">Softness</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={shadowSoftness}
              onChange={(e) => setShadowSoftness(Number(e.target.value))}
            />
            <EditableValue
              value={shadowSoftness}
              min={0}
              max={1}
              onChange={setShadowSoftness}
              format={(v) => Math.round(v * 100) + '%'}
              label="Shadow softness"
            />
          </label>

          <label className="slider-row" title="How dark the shadow is — 0 is barely visible, 1 is solid black">
            <span className="slider-label">Strength</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={shadowStrength}
              onChange={(e) => setShadowStrength(Number(e.target.value))}
            />
            <EditableValue
              value={shadowStrength}
              min={0}
              max={1}
              onChange={setShadowStrength}
              format={(v) => Math.round(v * 100) + '%'}
              label="Shadow strength"
            />
          </label>
        </div>
      )}

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={solidBackground}
          onChange={(e) => setSolidBackground(e.target.checked)}
        />
        Solid background colour
      </label>

      {solidBackground && (
        <label className="toggle-row">
          <input
            type="color"
            value={backgroundColor}
            onChange={(e) => setBackgroundColor(e.target.value)}
          />
          Background colour
        </label>
      )}

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={showStats}
          onChange={(e) => setShowStats(e.target.checked)}
        />
        Performance readout
      </label>
    </div>
  )
}