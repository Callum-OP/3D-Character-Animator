import { useState } from 'react'
import { useStore } from '../store.js'
import { applyModelMaterials } from '../three/scene.js'
import {
  SURFACE_CONTROLS,
  SURFACE_PRESETS,
  SURFACE_KEYS,
  presetPatch,
  hasLook,
  getMaterialSlots,
} from '../three/surfaceMaterials.js'
import ColorControl from './ColorControl.jsx'
import { recordOverrideEdit } from '../three/materialHistory.js'

// Edit ONE material of the selected part(s): recolour it, change how light reacts to it
// (glossy, metal, cloth, glass, glow…), or swap one colour inside its texture for another.
// The whole-part colour above is untouched; this sits on top of it. State lives in the
// per-mesh override map (store.setMeshesSlot), so it saves, loads and copies with the part.
//
// `resolveMesh(uuid)` returns the live mesh for a selected uuid (character or prop part).

const NO_SLOTS = []
const CLEAR_ALL = Object.fromEntries(['color', 'solid', 'replace', 'preset', ...SURFACE_KEYS].map((k) => [k, null]))
// Studio / Realistic use real PBR; Toon / Soft anime fake the same settings (see
// surfaceMaterials.js). Only Unlit (and a part set to Flat shading) ignores them.
const SURFACE_MODES = ['standard', 'realistic', 'toon', 'soft']

function Slider({ def, value, isSet, onChange, onReset }) {
  return (
    <label className="slider-row" title={def.hint || undefined}>
      <span className="slider-label">{def.label}</span>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span style={{ minWidth: 34, textAlign: 'right', opacity: isSet ? 1 : 0.55 }}>{Number(value).toFixed(2)}</span>
      <button
        type="button"
        className="btn secondary"
        style={{ padding: '0 6px', visibility: isSet ? 'visible' : 'hidden' }}
        title="Back to the model's own value"
        onClick={onReset}
      >
        ↺
      </button>
    </label>
  )
}

export default function MaterialEditor({ selectedMeshUuids, primaryUuid, resolveMesh }) {
  const meshOverrides = useStore((s) => s.meshOverrides)
  const setMeshesSlot = useStore((s) => s.setMeshesSlot)
  const materialMode = useStore((s) => s.materialMode)
  const setMaterialMode = useStore((s) => s.setMaterialMode)
  const [slotChoice, setSlotChoice] = useState(0) // a slot index, or 'all'
  const [presetColour, setPresetColour] = useState(true)
  const [clipboard, setClipboard] = useState(null)

  const primary = resolveMesh(primaryUuid)
  const slots = primary ? getMaterialSlots(primary) : NO_SLOTS
  if (!primary || !slots.length) return null

  const multiSlot = slots.length > 1
  const choice = slotChoice === 'all' || slotChoice < slots.length ? slotChoice : 0
  const shownIndex = choice === 'all' ? 0 : choice
  const info = slots[shownIndex]
  const look = (meshOverrides[primaryUuid] && meshOverrides[primaryUuid].slots && meshOverrides[primaryUuid].slots[shownIndex]) || {}

  // Every (mesh, material) the edit applies to.
  const targets = []
  for (const uuid of selectedMeshUuids) {
    const mesh = resolveMesh(uuid)
    const count = mesh ? getMaterialSlots(mesh).length : 0
    if (choice === 'all') for (let i = 0; i < count; i++) targets.push({ uuid, slot: i })
    else if (choice < count) targets.push({ uuid, slot: choice })
  }

  function edit(patch) {
    if (!targets.length) return
    recordOverrideEdit(targets.map((t) => t.uuid), () => setMeshesSlot(targets, patch))
    applyModelMaterials()
  }

  const surfaceEdited = SURFACE_KEYS.some((k) => look[k] != null && k !== 'opacity')
  const needsStudio = surfaceEdited && !SURFACE_MODES.includes(materialMode)
  const replace = look.replace || null
  const patchReplace = (p) => edit({ replace: { range: 0.4, softness: 0.4, from: '#ff0000', to: '#0000ff', ...replace, ...p } })

  async function pickFromScreen() {
    try {
      const res = await new window.EyeDropper().open()
      patchReplace({ from: res.sRGBHex })
    } catch {
      /* cancelled */
    }
  }

  const title = choice === 'all' ? `All ${slots.length} materials` : info.name

  return (
    <details className="joint-controls" style={{ marginTop: 10 }}>
      <summary style={{ cursor: 'pointer' }}>
        <span className="joint-name">Change material type</span>{' '}
        <span className="joint-parent">{selectedMeshUuids.length > 1 ? `${selectedMeshUuids.length} parts · ` : ''}{title}</span>
      </summary>
      <div style={{ marginTop: 8 }}>

      {multiSlot && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {slots.map((s, i) => (
            <button
              key={i}
              className={`btn ${choice === i ? '' : 'secondary'}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
              title={s.name}
              onClick={() => setSlotChoice(i)}
            >
              <span style={{ width: 11, height: 11, borderRadius: 3, background: s.color, border: '1px solid #888' }} />
              {s.name}
            </button>
          ))}
          <button className={`btn ${choice === 'all' ? '' : 'secondary'}`} onClick={() => setSlotChoice('all')} title="Edit every material on the part at once">
            All
          </button>
        </div>
      )}

      <ColorControl
        label="Material colour"
        color={look.color || null}
        solid={!!look.solid}
        onChange={(p) => edit(p)}
        onClear={() => edit({ color: null })}
      />

      <div className="joint-header" style={{ marginTop: 8 }}>
        <span className="joint-name">Surface</span>
        <span className="joint-parent">how light reacts to it</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {Object.entries(SURFACE_PRESETS).map(([id, p]) => (
          <button
            key={id}
            className={`btn ${(look.preset || 'original') === id ? '' : 'secondary'}`}
            title={p.title || p.label}
            onClick={() => edit(presetPatch(id, { color: look.color || info.color }, { withColor: presetColour }))}
          >
            {p.label}
          </button>
        ))}
      </div>
      <label className="color-control-solid" style={{ marginTop: 6, display: 'block' }} title="Metals like gold and copper bring their own colour with them">
        <input type="checkbox" checked={presetColour} onChange={(e) => setPresetColour(e.target.checked)} /> Metal presets also set the colour
      </label>

      {needsStudio && (
        <div style={{ margin: '8px 0', padding: 6, borderRadius: 6, background: 'rgba(255,170,0,0.15)', fontSize: 12 }}>
          Surface changes don't show in Unlit mode (it ignores lighting).{' '}
          <button className="btn secondary" onClick={() => setMaterialMode('toon')}>Switch to Toon</button>{' '}
          <button className="btn secondary" onClick={() => setMaterialMode('standard')}>Switch to Studio</button>
        </div>
      )}

      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer' }}>Fine tune</summary>
        <div style={{ marginTop: 6 }}>
          {SURFACE_CONTROLS.map((def) => (
            <Slider
              key={def.key}
              def={def}
              value={look[def.key] != null ? look[def.key] : info.base[def.key]}
              isSet={look[def.key] != null}
              onChange={(v) => edit({ [def.key]: v, preset: null })}
              onReset={() => edit({ [def.key]: null, preset: null })}
            />
          ))}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
            <label className="color-control-solid">
              Glow colour{' '}
              <input
                type="color"
                className="color-control-swatch"
                value={look.emissive || info.emissive}
                onChange={(e) => edit({ emissive: e.target.value, emissiveIntensity: look.emissiveIntensity != null ? look.emissiveIntensity : 1.5, preset: null })}
              />
            </label>
            <label className="color-control-solid">
              Sheen colour{' '}
              <input
                type="color"
                className="color-control-swatch"
                value={look.sheenColor || '#ffffff'}
                onChange={(e) => edit({ sheenColor: e.target.value, sheen: look.sheen != null ? look.sheen : 0.8, preset: null })}
              />
            </label>
          </div>
        </div>
      </details>

      <details style={{ marginTop: 8 }} open={!!replace}>
        <summary style={{ cursor: 'pointer' }}>Replace a colour in the texture</summary>
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
            Swap one colour for another everywhere it appears on this material, keeping the shading. Works with
            white, black and grey too.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label className="color-control-solid">
              Replace{' '}
              <input type="color" className="color-control-swatch" value={replace?.from || '#ff0000'} onChange={(e) => patchReplace({ from: e.target.value })} />
            </label>
            {typeof window !== 'undefined' && 'EyeDropper' in window && (
              <button className="btn secondary" title="Click any colour on screen, e.g. on the model" onClick={pickFromScreen}>
                Pick from screen
              </button>
            )}
            <label className="color-control-solid">
              with{' '}
              <input type="color" className="color-control-swatch" value={replace?.to || '#0000ff'} onChange={(e) => patchReplace({ to: e.target.value })} />
            </label>
          </div>
          {replace && (
            <>
              <Slider
                def={{ key: 'range', label: 'Range', min: 0, max: 1, step: 0.01, hint: 'How different a colour can be and still be replaced' }}
                value={replace.range != null ? replace.range : 0.4}
                isSet={false}
                onChange={(v) => patchReplace({ range: v })}
                onReset={() => {}}
              />
              <Slider
                def={{ key: 'softness', label: 'Edge softness', min: 0, max: 1, step: 0.01, hint: 'Blend the edge of the replaced area' }}
                value={replace.softness != null ? replace.softness : 0.4}
                isSet={false}
                onChange={(v) => patchReplace({ softness: v })}
                onReset={() => {}}
              />
              <button className="btn secondary" onClick={() => edit({ replace: null })}>
                Remove colour replace
              </button>
            </>
          )}
        </div>
      </details>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        <button className="btn secondary" disabled={!hasLook(look)} onClick={() => setClipboard({ ...look })} title="Copy this material's look">
          Copy look
        </button>
        <button
          className="btn secondary"
          disabled={!clipboard}
          onClick={() => edit({ ...CLEAR_ALL, ...clipboard })}
          title="Paste the copied look onto the selected material(s)"
        >
          Paste look
        </button>
        <button
          className="btn secondary"
          disabled={!hasLook(look)}
          onClick={() => edit(CLEAR_ALL)}
          title="Remove every change to the selected material(s)"
        >
          Reset material
        </button>
      </div>
      </div>
    </details>
  )
}
