// A small colour picker row shared by the Parts panel (selected parts) and the
// Objects panel (a whole object): pick a colour, choose whether it tints the
// loaded texture or replaces it with a flat colour, or clear it again.
//
// Purely presentational — callers own where the colour is stored (the per-mesh
// override map, see store.setMeshesColor) and re-apply materials in onChange.
const DEFAULT_SWATCH = '#ffffff'

export default function ColorControl({ color, solid, onChange, onClear, label = 'Colour', stopClicks = false }) {
  const stop = stopClicks ? (e) => e.stopPropagation() : undefined
  return (
    <div className="color-control" onClick={stop}>
      <span className="color-control-label">{label}</span>
      <input
        type="color"
        className="color-control-swatch"
        aria-label={label}
        title="Pick a colour"
        value={color || DEFAULT_SWATCH}
        onChange={(e) => onChange({ color: e.target.value, solid: !!solid })}
      />
      <label
        className="color-control-solid"
        title="Off: the colour tints the existing texture. On: the texture is replaced by this flat colour."
      >
        <input
          type="checkbox"
          checked={!!solid}
          disabled={!color}
          onChange={(e) => onChange({ color, solid: e.target.checked })}
        />
        Replace texture
      </label>
      <button
        className="btn secondary color-control-reset"
        disabled={!color}
        onClick={onClear}
        title="Go back to the colours the model came with"
      >
        Reset colour
      </button>
    </div>
  )
}
