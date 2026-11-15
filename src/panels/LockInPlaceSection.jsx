import { memo, useState } from 'react'
import { useStore } from '../store.js'
import { lockBonesInPlace, unlockBones, unlockAll, limbBoneNames, isLockPin } from '../three/ikpins.js'

// Animate > More character tools: hold bones (feet, hands, anything) exactly where they are in the pose on screen,
// position and rotation, for the whole animation. Built on the IK pins, but needs no IK setup.
// memo: the Animate panel re-renders every playback frame, and this section's long bone <select> must not.
function LockInPlaceSection() {
  const modelInfo = useStore((s) => s.modelInfo)
  const ikPins = useStore((s) => s.ikPins)
  const selectedBoneName = useStore((s) => s.selectedBoneName)
  const selectedBoneNames = useStore((s) => s.selectedBoneNames)
  const [rotation, setRotation] = useState(true)
  const [pick, setPick] = useState('')
  const [msg, setMsg] = useState('')

  const bones = modelInfo?.bones || []
  const locks = (ikPins || []).filter(isLockPin)
  const selected = selectedBoneNames?.length ? selectedBoneNames : selectedBoneName ? [selectedBoneName] : []
  const feet = limbBoneNames('foot')
  const hands = limbBoneNames('hand')

  const run = (names, label) => {
    const r = lockBonesInPlace(names, { rotation })
    const n = r.locked + r.relocked
    setMsg(n ? `Locked ${label} (${n} bone${n === 1 ? '' : 's'}). Ctrl+Z undoes it.` : `Could not find ${label} on this character.`)
  }

  return (
    <section className="wind-controls" aria-label="Lock in place" style={{ marginBottom: 10 }}>
      <div className="wind-heading">
        <div>
          <strong>Lock in place</strong>
          <div className="wind-hint">
            Holds a bone exactly where it is in the pose you are looking at, for the whole animation. Scrub to the pose you want to keep,
            then lock. Feet stay planted instead of sliding or floating; the legs bend to keep up.
          </div>
        </div>
      </div>
      <label className="check-row" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' }}>
        <input type="checkbox" checked={rotation} onChange={(e) => setRotation(e.target.checked)} />
        <span>Lock rotation too (a foot stays flat and pointing the same way)</span>
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="btn secondary" disabled={!feet.length} onClick={() => run(feet, 'both feet')}>Lock both feet</button>
        <button type="button" className="btn secondary" disabled={!hands.length} onClick={() => run(hands, 'both hands')}>Lock both hands</button>
        <button type="button" className="btn secondary" disabled={!selected.length} onClick={() => run(selected, 'the selected bones')}>
          Lock selected bones{selected.length ? ` (${selected.length})` : ''}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Bone to lock" style={{ flex: 1, minWidth: 0 }}>
          <option value="">Choose any bone…</option>
          {bones.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
        </select>
        <button type="button" className="btn secondary" disabled={!pick} onClick={() => run([pick], pick)}>Lock</button>
      </div>
      {msg && <div className="pose-msg">{msg}</div>}
      {locks.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <strong>Locked ({locks.length})</strong>
          {locks.map((p) => (
            <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.boneName}>{p.boneName}{p.matchRotation ? '' : ' (position only)'}</span>
              <button type="button" className="btn secondary" title="Lock it at the pose on screen now" onClick={() => run([p.boneName], p.boneName)}>Re-lock here</button>
              <button type="button" className="btn secondary" aria-label={`Unlock ${p.boneName}`} onClick={() => unlockBones([p.boneName])}>Unlock</button>
            </div>
          ))}
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn secondary" onClick={() => { unlockAll(); setMsg('') }}>Unlock all</button>
          </div>
        </div>
      )}
    </section>
  )
}

export default memo(LockInPlaceSection)
