import { useStore } from '../store.js'

// Side-panel section: viewport display toggles (grid, background).
// Background defaults to transparent because rasterized output is meant for
// compositing into 2D art (see Plan.md).
export default function ViewPanel() {
  const showGrid = useStore((s) => s.showGrid)
  const solidBackground = useStore((s) => s.solidBackground)
  const backgroundColor = useStore((s) => s.backgroundColor)
  const setShowGrid = useStore((s) => s.setShowGrid)
  const setSolidBackground = useStore((s) => s.setSolidBackground)
  const setBackgroundColor = useStore((s) => s.setBackgroundColor)

  return (
    <div className="panel">
      <h2>View</h2>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={showGrid}
          onChange={(e) => setShowGrid(e.target.checked)}
        />
        Show grid
      </label>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={solidBackground}
          onChange={(e) => setSolidBackground(e.target.checked)}
        />
        Solid background
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
    </div>
  )
}
