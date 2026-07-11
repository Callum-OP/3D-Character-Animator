import { useStore } from '../store.js'

// Side-panel section: viewport display toggles (grid, ground shadow, background,
// stats). Background defaults to transparent because rendered output is meant for
// dropping into 2D art.
export default function ViewPanel() {
  const showGrid = useStore((s) => s.showGrid)
  const showShadow = useStore((s) => s.showShadow)
  const solidBackground = useStore((s) => s.solidBackground)
  const backgroundColor = useStore((s) => s.backgroundColor)
  const showStats = useStore((s) => s.showStats)
  const setShowGrid = useStore((s) => s.setShowGrid)
  const setShowShadow = useStore((s) => s.setShowShadow)
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

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={showShadow}
          onChange={(e) => setShowShadow(e.target.checked)}
        />
        Ground shadow
      </label>

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
