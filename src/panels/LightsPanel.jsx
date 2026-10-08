import { useRef, useState } from 'react'
import { useStore } from '../store.js'
import {
  addLight,
  removeLight,
  selectLight,
  setLightColor,
  setLightIntensity,
  setLightCastShadow,
  setLightDirectional,
  getLightKeyValue,
  getLightTransform,
  setLightTransform,
  setLightVisible,
  snapshotLightTransform,
  setLightUniformScale,
  commitLightTransform,
} from '../three/lights.js'
import { applyModelMaterials } from '../three/scene.js'
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

  function onAdd() {
    const meta = addLight()
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

      <button className="btn" onClick={onAdd} title="Place a light near the character">
        + Add light
      </button>
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
                  {lt.directional ? '📐' : '💡'} {lt.name}
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
                label="Light size"
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
                  checked={!!selected.directional}
                  onChange={(e) => onDirectional(e.target.checked)}
                />
                Directional (parallel rays, no falloff)
              </label>
              <div className="radio-hint" style={{ marginTop: -2, marginBottom: 4 }}>
                {selected.directional
                  ? 'Aimed at the scene origin \u2014 drag it around to change the angle it shines from, like a sun or a rim/fill light.'
                  : 'Shines outward in every direction and fades with distance, like a lamp or bulb.'}
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