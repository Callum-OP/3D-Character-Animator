import { useRef, useState } from 'react'
import { useStore } from '../store.js'
import {
  addLight,
  removeLight,
  selectLight,
  setLightColor,
  setLightIntensity,
  setLightCastShadow,
  setLightRange,
  setLightCone,
  applyLightPreset,
  LIGHT_PRESETS,
  MIN_LIGHT_RANGE,
  MAX_LIGHT_RANGE,
  setLightDirectional,
  getLightKeyValue,
  getLightTransform,
  setLightTransform,
  setLightVisible,
  snapshotLightTransform,
  setLightUniformScale,
  commitLightTransform,
} from '../three/lights.js'
import { applyModelMaterials, attachLightToObject } from '../three/scene.js'
import EditableValue from './EditableValue.jsx'
import TransformEditor from './TransformEditor.jsx'
import RadialScale from './RadialScale.jsx'
import { copySceneItem, hasSceneClipboard, pasteSceneItem } from '../three/sceneClipboard.js'

// Side-panel section: add point lights, move them around the character, and
// adjust colour/brightness/shadows per light. Separate from the built-in key
// light (see the Material panel) — these are extra, freely placeable sources.
// Position + colour + intensity can be keyframed on the same timeline as the
// character/cameras — key it at two times and it glides between them on Play.
export default function LightsPanel() {
  const sceneLights = useStore((s) => s.sceneLights)
  const sceneObjects = useStore((s) => s.sceneObjects)
  const lightAttachments = useStore((s) => s.lightAttachments)
  const sceneClipboardType = useStore((s) => s.sceneClipboardType)
  const selectedLightId = useStore((s) => s.selectedLightId)
  const setSelectedLightId = useStore((s) => s.setSelectedLightId)
  const rimFollowLight = useStore((s) => s.rimFollowLight)
  const rimFollowLightId = useStore((s) => s.rimFollowLightId)
  const animData = useStore((s) => s.animData)
  const animFps = useStore((s) => s.animFps)
  const insertTime = useStore((s) => s.insertTime)
  const setMode = useStore((s) => s.setMode)
  const st = useStore.getState
  const scaleBefore = useRef(null)
  const [scaleDragging, setScaleDragging] = useState(false)
  const [scaleValue, setScaleValue] = useState(1)

  const selected = sceneLights.find((lt) => lt.id === selectedLightId) || null
  const keyCount = selected ? (animData.lights?.[selected.name] || []).length : 0

  function onAdd(presetId = null) {
    let meta = addLight()
    if (presetId) {
      const shape = applyLightPreset(meta.id, presetId)
      if (shape) meta = { ...meta, ...shape }
    }
    st().addSceneLight(meta)
    selectLight(meta.id)
    setMode('object')
  }

  function onSelect(id) {
    const next = id === selectedLightId ? null : id
    setSelectedLightId(next)
    selectLight(next)
    if (next != null) setMode('object')
  }

  function onRemove(id) {
    removeLight(id)
    if (rimFollowLightId === id) {
      st().setRimFollowLight(false)
      st().setRimFollowLightId(null)
      applyModelMaterials()
    }
  }

  function onPasteLight() {
    const pasted = pasteSceneItem('light')
    if (pasted) setMode('object')
  }

  function onVisibility(id, visible) {
    setLightVisible(id, visible)
  }

  function onColor(color) {
    if (!selected) return
    setLightColor(selected.id, color)
    st().setLightColor(selected.id, color)
  }

  function onIntensity(intensity) {
    if (!selected) return
    setLightIntensity(selected.id, intensity)
    st().setPropLightIntensity(selected.id, intensity)
  }

  // Log-scaled sliders: what matters is the order of magnitude (a candle vs a floodlight).
  const logToSlider = (v, min, max) => Math.log(v / min) / Math.log(max / min)
  const sliderToLog = (t, min, max) => min * Math.pow(max / min, t)
  const MIN_INTENSITY = 0.01
  const MAX_INTENSITY = 300

  function onRange(t) {
    if (!selected) return
    const range = Math.round(sliderToLog(t, MIN_LIGHT_RANGE, MAX_LIGHT_RANGE) * 100) / 100
    setLightRange(selected.id, range)
    st().patchSceneLight(selected.id, { range })
  }

  function onCone(patch) {
    if (!selected) return
    setLightCone(selected.id, patch)
    st().patchSceneLight(selected.id, patch)
  }

  function onPreset(presetId) {
    if (!selected || !presetId) return
    const meta = applyLightPreset(selected.id, presetId)
    if (meta) st().patchSceneLight(selected.id, meta)
  }

  function onCastShadow(castShadow) {
    if (!selected) return
    setLightCastShadow(selected.id, castShadow)
    st().setLightCastShadow(selected.id, castShadow)
  }

  function onDirectional(directional) {
    if (!selected) return
    setLightDirectional(selected.id, directional)
    st().setLightDirectional(selected.id, directional)
  }

  // Save this light's position/colour/intensity at the Animate panel's
  // insert time. Key it at two different times and it glides between them
  // during playback, same idea as "Key camera" in the Cameras panel.
  function onKeyLight() {
    if (!selected) return
    const key = getLightKeyValue(selected.id)
    if (!key) return
    const t = Math.round(insertTime * animFps) / animFps // snap to the fps grid
    st().addLightKeyframe(selected.name, t, {
      pos: key.pos,
      quat: key.quat,
      scale: key.scale,
      color: key.color,
      intensity: key.intensity,
    })
  }

  // Toggle whether this light drives the character's rim-light colour +
  // direction (see the Rim light section of the Look panel). Only one light
  // can drive it at a time — picking a different one just swaps which.
  function onFollowRim(id) {
    const next = rimFollowLight && rimFollowLightId === id
    st().setRimFollowLight(!next)
    st().setRimFollowLightId(!next ? id : null)
    applyModelMaterials()
  }

  return (
    <div className="panel">
      <h2>Lights</h2>
      <p className="panel-hint">
        Add and position extra lights alongside the main key light.
      </p>

      <button className="btn" onClick={() => onAdd()} title="Place a light near the character">
        + Add light
      </button>
      <select
        className="select"
        aria-label="Add a light from a preset"
        style={{ marginLeft: 6 }}
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value)
        }}
      >
        <option value="">+ Add from preset…</option>
        {LIGHT_PRESETS.map((p) => (
          <option key={p.id} value={p.id} title={p.hint}>
            {p.directional ? '🔦' : '💡'} {p.label}
          </option>
        ))}
      </select>
      <button
        className="btn secondary"
        style={{ marginTop: 6 }}
        onClick={onPasteLight}
        disabled={sceneClipboardType !== 'light' || !hasSceneClipboard('light')}
        title="Paste a copied light"
      >
        Paste light
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
                <span className="obj-name">
                  {lt.directional ? '🔦' : '💡'} {lt.name}
                  {rimFollowLight && rimFollowLightId === lt.id && (
                    <span title="Driving the rim light" style={{ marginLeft: 6 }}>🎯</span>
                  )}
                  {(animData.lights?.[lt.name] || []).length > 0 && (
                    <span className="kf-tag" style={{ marginLeft: 6 }}>
                      {(animData.lights?.[lt.name] || []).length} keys
                    </span>
                  )}
                </span>
                <button
                  className="obj-eye"
                  title={lt.visible === false ? 'Show light' : 'Hide light'}
                  onClick={(e) => {
                    e.stopPropagation()
                    onVisibility(lt.id, lt.visible === false)
                  }}
                >
                  {lt.visible === false ? '🙈' : '👁'}
                </button>
              </div>
            ))}
          </div>

          {selected && (
            <div className="joint-controls">
              <TransformEditor
                label={selected.name}
                transform={getLightTransform(selected.id)}
                readTransform={() => getLightTransform(selected.id)}
                onCommit={(transform) => setLightTransform(selected.id, transform)}
              />
              <RadialScale
                value={scaleDragging ? scaleValue : (getLightTransform(selected.id)?.scale[0] || 1)}
                getValue={() => getLightTransform(selected.id)?.scale[0] || 1}
                label="Source size"
                onDragStart={(value) => {
                  scaleBefore.current = snapshotLightTransform(selected.id)
                  setScaleValue(value)
                  setScaleDragging(true)
                }}
                onChange={(value) => {
                  setScaleValue(value)
                  setLightUniformScale(selected.id, value)
                }}
                onCommit={() => {
                  commitLightTransform(selected.id, scaleBefore.current)
                  scaleBefore.current = null
                  setScaleDragging(false)
                }}
              />
              <div className="radio-hint" style={{ marginTop: 2, marginBottom: 4 }}>
                How big the light itself is — shown as a ghost sphere while selected. A bigger source
                gives softer shadow edges (when Cast shadows is on). It does not change how far the light reaches.
              </div>

              <label className="slider-row" title="Turn this light into a ready-made one: bulb, floodlight, headlight, status LED…">
                <span className="slider-label">Preset</span>
                <select
                  className="select"
                  aria-label="Light preset"
                  value=""
                  onChange={(e) => onPreset(e.target.value)}
                >
                  <option value="">Choose a preset…</option>
                  {LIGHT_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.directional ? '🔦' : '💡'} {p.label} — {p.hint}
                    </option>
                  ))}
                </select>
              </label>

              <label className="slider-row">
                <span className="slider-label">Color</span>
                <input
                  type="color"
                  value={selected.color}
                  onChange={(e) => onColor(e.target.value)}
                  style={{ width: 32, height: 24, padding: 0, border: 'none', background: 'none' }}
                />
              </label>

              <label className="slider-row" title="Brightness at one unit away. Bigger lights with a longer range need more.">
                <span className="slider-label">Intensity</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.002}
                  value={Math.min(1, Math.max(0, logToSlider(Math.max(selected.intensity, MIN_INTENSITY), MIN_INTENSITY, MAX_INTENSITY)))}
                  onChange={(e) => onIntensity(Math.round(sliderToLog(Number(e.target.value), MIN_INTENSITY, MAX_INTENSITY) * 100) / 100)}
                />
                <EditableValue
                  value={selected.intensity}
                  min={0}
                  max={MAX_INTENSITY}
                  onChange={onIntensity}
                  format={(v) => (v < 10 ? v.toFixed(2) : v.toFixed(1))}
                  label="Light intensity"
                />
              </label>

              <label className="slider-row" title="How far the light reaches: it fades out smoothly and is gone at this distance, and its shadows fade with it. A bulb is a few units; a floodlight tens.">
                <span className="slider-label">Range</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.002}
                  value={logToSlider(selected.range ?? 7.5, MIN_LIGHT_RANGE, MAX_LIGHT_RANGE)}
                  onChange={(e) => onRange(Number(e.target.value))}
                />
                <EditableValue
                  value={selected.range ?? 7.5}
                  min={MIN_LIGHT_RANGE}
                  max={MAX_LIGHT_RANGE}
                  onChange={(v) => {
                    setLightRange(selected.id, v)
                    st().patchSceneLight(selected.id, { range: v })
                  }}
                  format={(v) => (v < 10 ? v.toFixed(2) : v.toFixed(1))}
                  label="Light range"
                />
              </label>

              <label className="morph-label" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={!!selected.directional}
                  onChange={(e) => onDirectional(e.target.checked)}
                />
                Directional (a cone aimed one way)
              </label>
              <div className="radio-hint" style={{ marginTop: -2, marginBottom: 4 }}>
                {selected.directional
                  ? 'A beam like a torch, headlight or floodlight. It starts aimed at the scene origin; use the rotate gizmo to point it, and the outline shows the cone while it is selected.'
                  : 'Shines outward in every direction, like a bulb or a lamp.'}
              </div>
              {selected.directional && (
                <>
                  <label className="slider-row" title="Width of the beam (half-angle)">
                    <span className="slider-label">Cone angle</span>
                    <input
                      type="range"
                      min={3}
                      max={89}
                      step={1}
                      value={selected.angle ?? 45}
                      onChange={(e) => onCone({ angle: Number(e.target.value) })}
                    />
                    <span style={{ minWidth: 36, textAlign: 'right' }}>{Math.round(selected.angle ?? 45)}°</span>
                  </label>
                  <label className="slider-row" title="How soft the edge of the beam is: 0 is a hard spotlight edge, 1 fades from the very centre">
                    <span className="slider-label">Edge softness</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={selected.penumbra ?? 0.35}
                      onChange={(e) => onCone({ penumbra: Number(e.target.value) })}
                    />
                    <span style={{ minWidth: 36, textAlign: 'right' }}>{(selected.penumbra ?? 0.35).toFixed(2)}</span>
                  </label>
                </>
              )}


              <label className="morph-label" style={{ display: 'block', marginTop: 6 }}>
                Attach to
                <select
                  className="select"
                  aria-label="Attach light to object"
                  style={{ marginLeft: 6 }}
                  value={lightAttachments[selected.id] ?? ''}
                  onChange={(e) => attachLightToObject(selected.id, e.target.value === '' ? null : Number(e.target.value))}
                >
                  <option value="">Nothing (free-standing)</option>
                  {sceneObjects.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="radio-hint" style={{ marginTop: 2, marginBottom: 4 }}>
                {lightAttachments[selected.id] != null
                  ? 'Follows that object when it moves, rotates or is animated. Its position below is now relative to the object.'
                  : 'Pick a prop or character and this light will ride along with it, staying where it is for now.'}
              </div>

              <label className="morph-label" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={!!selected.castShadow}
                  onChange={(e) => onCastShadow(e.target.checked)}
                />
                Cast shadows
              </label>

              <label className="morph-label" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <input
                  type="checkbox"
                  checked={rimFollowLight && rimFollowLightId === selected.id}
                  onChange={() => onFollowRim(selected.id)}
                />
                Drive the rim light's colour + direction
              </label>

              <div className="kf-actions" style={{ marginTop: 6 }}>
                <button
                  className="btn secondary"
                  onClick={onKeyLight}
                  title="Save this light's position/colour/intensity at the Animate panel's insert time — key it at two times and it glides between them"
                >
                  Key light{keyCount ? ` (${keyCount})` : ''}
                </button>
              </div>

              {/* Copy / Remove live down here, away from the row's quick toggles,
                  with Remove pushed to the far side so it can't be hit by accident. */}
              <div
                className="light-danger-zone"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 16,
                  paddingTop: 10,
                  borderTop: '1px solid var(--panel-border)',
                }}
              >
                <button
                  className="btn secondary"
                  style={{ flex: '0 0 auto' }}
                  title={`Copy ${selected.name}`}
                  onClick={() => copySceneItem('light', selected.id)}
                >
                  ⧉ Copy light
                </button>
                <button
                  className="btn secondary"
                  style={{ flex: '0 0 auto', color: '#ff6b6b', borderColor: '#ff6b6b' }}
                  title={`Remove ${selected.name}`}
                  onClick={() => onRemove(selected.id)}
                >
                  Remove light
                </button>
              </div>
            </div>
          )}

          <div className="pose-hint">
            Drag a light's gizmo to move, rotate, or resize it. Props can be styled (flat, cartoon,
            soft anime, realistic) or set to ignore shadows from the Objects
            panel. A light set to drive the rim light overrides the manual
            colour/direction in the Look panel. <b>Key light</b> animates a light's position, colour,
            and intensity over time - key it at two positions and it glides
            between them during playback.
          </div>
        </>
      )}
    </div>
  )
}