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
  const performanceMode = useStore((s) => s.performanceMode)
  const performanceBackgroundObjects = useStore((s) => s.performanceBackgroundObjects)
  const performanceLowPoly = useStore((s) => s.performanceLowPoly)
  const performanceResolution = useStore((s) => s.performanceResolution)
  const performanceEffects = useStore((s) => s.performanceEffects)
  const autoDecimate = useStore((s) => s.autoDecimate)
  const setShowGrid = useStore((s) => s.setShowGrid)
  const setShowGround = useStore((s) => s.setShowGround)
  const setShowShadow = useStore((s) => s.setShowShadow)
  const setShadowMapping = useStore((s) => s.setShadowMapping)
  const setShadowSoftness = useStore((s) => s.setShadowSoftness)
  const setShadowStrength = useStore((s) => s.setShadowStrength)
  const setSolidBackground = useStore((s) => s.setSolidBackground)
  const setBackgroundColor = useStore((s) => s.setBackgroundColor)
  const setShowStats = useStore((s) => s.setShowStats)
  const setPerformanceMode = useStore((s) => s.setPerformanceMode)
  const setPerformanceBackgroundObjects = useStore((s) => s.setPerformanceBackgroundObjects)
  const setPerformanceLowPoly = useStore((s) => s.setPerformanceLowPoly)
  const setPerformanceResolution = useStore((s) => s.setPerformanceResolution)
  const setPerformanceEffects = useStore((s) => s.setPerformanceEffects)
  const setAutoDecimate = useStore((s) => s.setAutoDecimate)

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
            <span className="slider-label">Ground shadow edge softness</span>
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

      <label
        className="toggle-row"
        title="Slightly lower viewport resolution for a barely noticeable performance improvement"
      >
        <input
          type="checkbox"
          checked={performanceMode}
          onChange={(e) => setPerformanceMode(e.target.checked)}
        />
        Performance mode
      </label>
      <p className="panel-hint">
        Enable extra performance controls for heavy scenes. These affect the viewport only.
      </p>

      {performanceMode && (
        <div style={{ paddingLeft: 22 }}>
          <label
            className="toggle-row"
            title="Lower the entire viewport resolution for a stronger performance boost"
          >
            <input
              type="checkbox"
              checked={performanceLowPoly}
              onChange={(e) => setPerformanceLowPoly(e.target.checked)}
            />
            Lower viewport resolution
          </label>

          {performanceLowPoly && (
            <label className="toggle-row" style={{ paddingLeft: 22 }} title="Choose the viewport render resolution">
              <span>Resolution</span>
              <select
                className="select select-sm"
                value={performanceResolution}
                onChange={(e) => setPerformanceResolution(Number(e.target.value))}
              >
                <option value={0.5}>50%</option>
                <option value={0.67}>67%</option>
                <option value={0.75}>75%</option>
                <option value={0.85}>85%</option>
              </select>
            </label>
          )}

          <label
            className="toggle-row"
            title="Hide distant props and background meshes; character models stay visible"
          >
            <input
              type="checkbox"
              checked={performanceBackgroundObjects}
              onChange={(e) => setPerformanceBackgroundObjects(e.target.checked)}
            />
            Simplify distant meshes (characters unaffected)
          </label>

          <label
            className="toggle-row"
            title="Disable real shadows and outline rendering in the viewport"
          >
            <input
              type="checkbox"
              checked={performanceEffects}
              onChange={(e) => setPerformanceEffects(e.target.checked)}
            />
            Reduce expensive effects
          </label>
        </div>
      )}

      <label className="toggle-row" title="Reduce very dense static meshes during import. Animated meshes and morph-target meshes are preserved.">
        <input
          type="checkbox"
          checked={autoDecimate}
          onChange={(e) => setAutoDecimate(e.target.checked)}
        />
        Optimize heavy meshes on import
      </label>
      <p className="panel-hint">
        Static meshes are reduced in stages at 150k, 500k and 1m vertices. Existing models are not changed.
      </p>
    </div>
  )
}