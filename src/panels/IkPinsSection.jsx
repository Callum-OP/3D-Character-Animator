import { useEffect, useState } from 'react'
import { useStore } from '../store.js'
import { classifyBone } from '../three/bvh.js'
import { addIkPin, removeIkPin, updateIkPin, snapIkMarkerToBone, attachIkMarker, setIkEnabledFor } from '../three/ikpins.js'
import EditableValue from './EditableValue.jsx'
import { FxCollapse, FxEditor, FxIntro, FxSection, FxItem, FxItemActions, FxField, FxCheck, FxHelp, FxButtons, FxEmpty } from './FxCards.jsx'

// A number box that keeps what you type until you press Enter or leave the field.
function NumField({ value, onCommit, label }) {
  const shown = Number(value.toFixed(3))
  const [draft, setDraft] = useState(String(shown))
  useEffect(() => setDraft(String(shown)), [shown])
  const commit = () => {
    const n = Number(draft)
    if (Number.isFinite(n) && n !== shown) onCommit(n)
    else setDraft(String(shown))
  }
  return (
    <label className="ik-num" title={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 6 }}>
      <span>{label}</span>
      <input
        type="number"
        step={0.01}
        value={draft}
        style={{ width: 64 }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  )
}

const ROLE_LABEL = { hand: 'Hand', foot: 'Foot' }

// Pose panel section: hold hands, feet or any chosen limb on a marker while an animation plays.
// The marker is fixed in the world or attached to a scene object (so it follows that object).
export default function IkPinsSection() {
  const modelInfo = useStore((s) => s.modelInfo)
  const ikEnabled = useStore((s) => s.ikEnabled)
  const ikPins = useStore((s) => s.ikPins)
  const selectedIkPinId = useStore((s) => s.selectedIkPinId)
  const showIkMarkers = useStore((s) => s.showIkMarkers)
  const setIkEnabled = useStore((s) => s.setIkEnabled)
  const setShowIkMarkers = useStore((s) => s.setShowIkMarkers)
  const setSelectedIkPinId = useStore((s) => s.setSelectedIkPinId)
  const selectedBoneName = useStore((s) => s.selectedBoneName)
  const selectedBoneNames = useStore((s) => s.selectedBoneNames)
  const sceneObjects = useStore((s) => s.sceneObjects)
  const activeCharacterId = useStore((s) => s.activeCharacterId)

  const bones = modelInfo?.bones || []
  const pinnedBones = new Set(ikPins.map((p) => p.boneName))
  const picked = selectedBoneNames.length ? selectedBoneNames : selectedBoneName ? [selectedBoneName] : []
  const attachable = sceneObjects.filter((o) => o.id !== activeCharacterId)

  // The first bone the rig has for each hand / foot slot (hand.L, hand.R, foot.L, foot.R).
  const limbTips = {}
  for (const b of bones) {
    const slot = classifyBone(b.name)
    const role = slot ? slot.split('.')[0] : null
    if ((role === 'hand' || role === 'foot') && !limbTips[slot]) limbTips[slot] = b.name
  }
  const handNames = Object.keys(limbTips).filter((s) => s.startsWith('hand')).map((s) => limbTips[s])
  const footNames = Object.keys(limbTips).filter((s) => s.startsWith('foot')).map((s) => limbTips[s])

  const pinAll = (names) => names.filter((n) => !pinnedBones.has(n)).forEach((n) => addIkPin(n))

  return (
    <FxCollapse title="IK pins" hint={ikPins.length ? `${ikPins.length} pin${ikPins.length === 1 ? '' : 's'}` : 'hold limbs on markers'}>
    <FxEditor style={{ marginTop: 0 }} aria-label="IK pins">
      <FxIntro eyebrow="IK PINS" title="Keep limbs on a marker" note="Runs during playback · paused or scrubbed frames show the clean pose">
        Keep a hand, foot or any limb connected to a marker while the animation plays. Fix the marker in the world, or attach
        it to an object so the limb follows that object when it moves. Select a bone above to pin it, or pin both hands or
        both feet in one go. Drag the marker in the viewport (Move / Rotate) to place it.
      </FxIntro>

      <div className="fx-effects fx-toggle">
        <FxCheck
          checked={ikEnabled}
          onChange={(v) => {
            setIkEnabled(v)
            setIkEnabledFor(activeCharacterId, v)
          }}
        >
          Enable IK pins
        </FxCheck>
        <FxCheck checked={showIkMarkers} onChange={setShowIkMarkers}>
          Show markers
        </FxCheck>
      </div>

      {ikPins.length > 0 && (
        <FxSection step="STEP 1" title="Pins on this character" count={ikPins.length} countLabel={`${ikPins.length} pins`} label="IK pins">
          {ikPins.map((pin) => {
            const slot = classifyBone(pin.boneName) || ''
            const role = ROLE_LABEL[slot.split('.')[0]]
            const attached = pin.attachObjectId != null
            const stale = attached && !sceneObjects.some((o) => o.id === pin.attachObjectId)
            return (
              <FxItem
                key={pin.id}
                title={pin.name}
                disabled={!pin.enabled}
                pills={[...(role ? [role] : []), attached ? 'On object' : 'Fixed']}
                onSummaryClick={() => setSelectedIkPinId(pin.id)}
              >
                <FxItemActions
                  left={
                    <FxCheck checked={pin.enabled} onChange={(v) => updateIkPin(pin.id, { enabled: v })}>
                      On
                    </FxCheck>
                  }
                >
                  <button className="btn secondary" onClick={() => setSelectedIkPinId(pin.id)} title="Show the move / rotate gizmo on this marker">
                    Select marker
                  </button>
                  <button className="btn secondary" onClick={() => snapIkMarkerToBone(pin.id)} title="Move the marker onto where the bone is right now">
                    Marker to bone
                  </button>
                  <button className="btn secondary" onClick={() => removeIkPin(pin.id)} title="Remove this IK pin" aria-label="Remove this IK pin">
                    ×
                  </button>
                </FxItemActions>

                <label className="slider-row">
                  <span className="slider-label" title="How strongly the limb is held on the marker. 0 = just the animation, 1 = fully on the marker.">
                    Strength
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={pin.weight}
                    onChange={(e) => updateIkPin(pin.id, { weight: Number(e.target.value) })}
                  />
                  <EditableValue
                    value={pin.weight}
                    min={0}
                    max={1}
                    onChange={(v) => updateIkPin(pin.id, { weight: v })}
                    format={(v) => v.toFixed(2)}
                    label="Strength"
                  />
                </label>

                <label className="slider-row">
                  <span className="slider-label" title="How many bones above the tip bend to reach the marker. 2 = a normal arm or leg (elbow / knee). More = the shoulder or spine joins in.">
                    Bones moved
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={6}
                    step={1}
                    value={pin.chainLength}
                    onChange={(e) => updateIkPin(pin.id, { chainLength: Number(e.target.value) })}
                  />
                  <span className="slider-value">{pin.chainLength}</span>
                </label>

                <FxCheck
                  checked={pin.matchRotation}
                  onChange={(v) => updateIkPin(pin.id, { matchRotation: v })}
                  title="Turn the hand / foot to the marker's orientation (rotate the marker to aim it)"
                >
                  Match marker rotation
                </FxCheck>

                <FxField label="Marker on">
                  <select
                    value={attached ? String(pin.attachObjectId) : ''}
                    onChange={(e) => attachIkMarker(pin.id, e.target.value === '' ? null : Number(e.target.value))}
                  >
                    <option value="">World (fixed in place)</option>
                    {stale && <option value={String(pin.attachObjectId)}>(missing object)</option>}
                    {attachable.map((o) => (
                      <option key={o.id} value={String(o.id)}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </FxField>

                {!attached && (
                  <div style={{ marginTop: 8 }}>
                    {['X', 'Y', 'Z'].map((axis, i) => (
                      <NumField
                        key={axis}
                        label={axis}
                        value={pin.position[i]}
                        onCommit={(n) => updateIkPin(pin.id, { position: pin.position.map((v, j) => (j === i ? n : v)) })}
                      />
                    ))}
                  </div>
                )}
                {attached && <FxHelp>Move the marker with the gizmo; it stays at that spot on the object.</FxHelp>}
              </FxItem>
            )
          })}
        </FxSection>
      )}

      <FxSection step={ikPins.length > 0 ? 'STEP 2' : 'STEP 1'} title="Add a pin" label="Add an IK pin">
        <FxHelp>
          {picked.length ? `${picked.length} bone${picked.length === 1 ? '' : 's'} selected.` : 'Select a bone above to pin it, or pin both hands or both feet at once.'}
        </FxHelp>
        <FxButtons>
          <button
            className="btn secondary"
            disabled={!picked.length || picked.every((n) => pinnedBones.has(n))}
            onClick={() => pinAll(picked)}
            title="Pin the selected bone(s) where they are now"
          >
            Pin selected bone
          </button>
          <button className="btn secondary" disabled={!handNames.length} onClick={() => pinAll(handNames)} title="Pin both hands where they are now">
            Pin hands
          </button>
          <button className="btn secondary" disabled={!footNames.length} onClick={() => pinAll(footNames)} title="Pin both feet where they are now">
            Pin feet
          </button>
        </FxButtons>
        {ikPins.length === 0 && <FxEmpty>No IK pins yet.</FxEmpty>}
      </FxSection>
    </FxEditor>
    </FxCollapse>
  )
}
