import { useStore } from '../store.js'
import { addLight, removeLight, selectLight, setLightColor, setLightIntensity, setLightCastShadow } from '../three/lights.js'
import EditableValue from './EditableValue.jsx'

// Side-panel section: add point lights, move them around the character, and
// adjust colour/brightness/shadows per light. Separate from the built-in key
// light (see the Material panel) — these are extra, freely placeable sources.
export default function LightsPanel() {
  const sceneLights = useStore((s) => s.sceneLights)
  const selectedLightId = useStore((s) => s.selectedLightId)
  const setSelectedLightId = useStore((s) => s.setSelectedLightId)
  const st = useStore.getState

  const selected = sceneLights.find((lt) => lt.id === selectedLightId) || null

  function onAdd() {
    const meta = addLight()
    st().addSceneLight(meta)
    selectLight(meta.id)
  }

  function onSelect(id) {
    const next = id === selectedLightId ? null : id
    setSelectedLightId(next)
    selectLight(next)
  }

  function onRemove(id) {
    removeLight(id)
    st().removeSceneLight(id)
  }

  function onColor(color) {
    if (!selected) return
    setLightColor(selected.id, color)
    st().setLightColor(selected.id, color)
  }

  function onIntensity(intensity) {
    if (!selected) return
    setLightIntensity(selected.id, intensity)
    st().setSceneLightIntensity(selected.id, intensity)
  }

  function onCastShadow(castShadow) {
    if (!selected) return
    setLightCastShadow(selected.id, castShadow)
    st().setLightCastShadow(selected.id, castShadow)
  }

  return (
    <div className="panel">
      <h2>Lights</h2>
      <p className="panel-hint">
        Add extra light sources and move them around the scene, on top of the
        main key light in the Material panel.
      </p>

      <button className="btn" onClick={onAdd} title="Place a light near the character">
        + Add light
      </button>

      {sceneLights.length > 0 && (
        <>
          <div className="obj-list" style={{ marginTop: 8 }}>
            {sceneLights.map((lt) => (
              <div
                key={lt.id}
                className={'obj-row' + (lt.id === selectedLightId ? ' selected' : '')}
                title={lt.name}
                onClick={() => onSelect(lt.id)}
              >
                <span className="obj-name">💡 {lt.name}</span>
                <button
                  className="obj-del"
                  title="Remove this light"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(lt.id)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {selected && (
            <div className="joint-controls">
              <label className="slider-row">
                <span className="slider-label">Color</span>
                <input
                  type="color"
                  value={selected.color}
                  onChange={(e) => onColor(e.target.value)}
                  style={{ width: 32, height: 24, padding: 0, border: 'none', background: 'none' }}
                />
              </label>

              <label className="slider-row">
                <span className="slider-label">Intensity</span>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={0.1}
                  value={selected.intensity}
                  onChange={(e) => onIntensity(Number(e.target.value))}
                />
                <EditableValue
                  value={selected.intensity}
                  min={0}
                  max={10}
                  onChange={onIntensity}
                  format={(v) => v.toFixed(1)}
                  label="Light intensity"
                />
              </label>

              <label className="morph-label" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={!!selected.castShadow}
                  onChange={(e) => onCastShadow(e.target.checked)}
                />
                Cast shadows
              </label>
            </div>
          )}

          <div className="pose-hint">
            Drag a light's gizmo to move it. Props/images can be set to ignore
            all lighting (flat, unshaded) or ignore shadows from the Objects
            panel.
          </div>
        </>
      )}
    </div>
  )
}