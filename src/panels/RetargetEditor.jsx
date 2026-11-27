import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import { setPosingEnabled } from '../three/posing.js'

// The bone-mapping editor: one row per body part, with the character's bone and the source animation's bone for it.
// Shared by the Animate panel (importing a BVH) and the Pose Library (retargeting a saved or preset entry by hand).
//
//   mapping   { name, sourceBones, targetBones, slots } - slots are { key, label, target, source, guessed }
//   onChange  receives an updater, like a React setState: onChange((m) => ({ ...m, slots: ... }))
//   onApply   called with the edited slots when the user confirms
//   onCancel  called when they back out
//
// It owns the "Pick" flow too: arm a row, then click the bone on the character in the viewport.
export default function RetargetEditor({
  mapping,
  onChange,
  onApply,
  onCancel,
  busy = false,
  applyLabel = 'Retarget',
  busyLabel = 'Retargeting…',
  sourceLabel = 'mocap',
}) {
  const selectedBoneName = useStore((s) => s.selectedBoneName)
  const mode = useStore((s) => s.mode)
  // Which row (by key) is waiting for a click on a bone dot in the viewport.
  const [pickingSlotKey, setPickingSlotKey] = useState(null)
  // selectedBoneName at the moment picking was armed, so a stale / already-selected bone isn't grabbed.
  const pickBaselineRef = useRef(null)
  const armedKeyRef = useRef(null)

  function setSlot(key, field, value) {
    onChange((m) => ({ ...m, slots: m.slots.map((s) => (s.key === key ? { ...s, [field]: value } : s)) }))
  }

  // If a bone is already selected (e.g. the user cycled to the right one by clicking it a few times first), use that
  // straight away instead of making them click it again. Otherwise turn on bone picking in the viewport (even if the
  // app isn't in Bone/Pose mode) so the dots are visible and clickable; the effect below catches the selection.
  function onStartPickTarget(key) {
    if (selectedBoneName) {
      setSlot(key, 'target', selectedBoneName)
      return
    }
    pickBaselineRef.current = selectedBoneName
    setPickingSlotKey(key)
    setPosingEnabled(true)
  }

  function onCancelPickTarget() {
    setPickingSlotKey(null)
    setPosingEnabled(mode === 'bone')
  }

  // While a row is armed, a change in the picked bone assigns it, then bone picking goes back to what the app's mode
  // dictates.
  useEffect(() => {
    if (!pickingSlotKey) return
    if (!selectedBoneName || selectedBoneName === pickBaselineRef.current) return
    setSlot(pickingSlotKey, 'target', selectedBoneName)
    setPickingSlotKey(null)
    setPosingEnabled(mode === 'bone')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBoneName])

  // Esc cancels an armed pick without assigning anything.
  useEffect(() => {
    if (!pickingSlotKey) return undefined
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancelPickTarget()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickingSlotKey])

  // Closing the editor while a pick is still armed mustn't leave bone picking forced on.
  useEffect(() => () => {
    if (armedKeyRef.current) setPosingEnabled(useStore.getState().mode === 'bone')
  }, [])

  armedKeyRef.current = pickingSlotKey
  const armed = mapping.slots.find((s) => s.key === pickingSlotKey)

  return (
    <div className="map-editor">
      <div className="field-label" style={{ marginTop: 8 }}>
        Map “{mapping.name}” bones → this rig
      </div>
      <div className="map-hint">
        Auto-guessed by body part. Fix any wrong rows (leave a row blank to skip it), then {applyLabel}. If the rig has
        generic bone names, use <strong>Pick</strong> and click the bone on the character instead of hunting through
        the dropdown.
        {mapping.slots.some((s) => s.guessed) && (
          <>
            {' '}Rows marked <strong>~guess</strong> have no usable bone names (in the {sourceLabel} file, the character
            rig, or both), so they were guessed from the skeleton's shape instead — check these carefully.
          </>
        )}
      </div>

      {armed && (
        <div className="map-hint map-hint-active">
          Click a bone dot on the character to assign it to “{armed.label}”.{' '}
          <button className="btn secondary" onClick={onCancelPickTarget}>
            Cancel
          </button>
        </div>
      )}

      <div className="map-list">
        {mapping.slots.map((s) => (
          <div key={s.key} className={s.guessed ? 'map-row map-row-guessed' : 'map-row'}>
            <span className="map-slot">
              {s.label}
              {s.guessed && (
                <span className="map-guessed-badge" title="Guessed from bone position, not name">
                  {' '}~guess
                </span>
              )}
            </span>
            <span className="map-target-cell">
              <select
                className="select select-sm"
                title="Character bone"
                value={s.target}
                onChange={(e) => setSlot(s.key, 'target', e.target.value)}
              >
                <option value="">— rig —</option>
                {mapping.targetBones.map((b, i) => (
                  <option key={`${b}-${i}`} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              <button
                className={'map-pick-btn' + (pickingSlotKey === s.key ? ' active' : '')}
                onClick={() => (pickingSlotKey === s.key ? onCancelPickTarget() : onStartPickTarget(s.key))}
                title="If a bone is already selected, assigns it. Otherwise, click here then click the bone on the character."
              >
                ⌖
              </button>
            </span>
            <select
              className="select select-sm"
              title={sourceLabel === 'mocap' ? 'Mocap (BVH) bone' : 'Source bone'}
              value={s.source}
              onChange={(e) => setSlot(s.key, 'source', e.target.value)}
            >
              <option value="">— {sourceLabel} —</option>
              {mapping.sourceBones.map((b, i) => (
                <option key={`${b}-${i}`} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="kf-actions" style={{ marginTop: 8 }}>
        <button className="btn" onClick={() => onApply(mapping.slots)} disabled={busy}>
          {busy ? busyLabel : applyLabel}
        </button>
        <button className="btn secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  )
}
