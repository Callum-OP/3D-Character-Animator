import { useStore } from '../store.js'
import { MAX_FLATTENERS } from '../three/flattenerShader.js'
import {
  addFlattener,
  removeFlattener,
  updateFlattener,
  refitFlattener,
  findHeadBoneName,
  setFlattenerEnabled,
} from '../three/flattener.js'
import EditableValue from './EditableValue.jsx'
import { FxCollapse, FxEditor, FxIntro, FxSection, FxItem, FxItemActions, FxCheck, FxHelp, FxButtons, FxEmpty } from './FxCards.jsx'

function Slider({ label, hint, value, min, max, step, onChange, format }) {
  return (
    <label className="slider-row">
      <span className="slider-label" title={hint}>
        {label}
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <EditableValue value={value} min={min} max={max} onChange={onChange} format={format} label={label} />
    </label>
  )
}

// Pose panel section: flatten a head (or any part carried by a bone) toward the camera, the 2D
// anime look. Everything above the chin line is squashed flat from the camera's point of view
// (the model stays fully 3D), fading out below it so the neck and hair blend in.
export default function FlattenerSection() {
  const modelInfo = useStore((s) => s.modelInfo)
  const flattenerEnabled = useStore((s) => s.flattenerEnabled)
  const flatteners = useStore((s) => s.flatteners)
  const showGuide = useStore((s) => s.showFlattenerGuide)
  const setShowGuide = useStore((s) => s.setShowFlattenerGuide)
  const selectedBoneName = useStore((s) => s.selectedBoneName)
  const activeCharacterId = useStore((s) => s.activeCharacterId)

  const boneNames = (modelInfo?.bones || []).map((b) => b.name)
  const headBone = findHeadBoneName(boneNames)
  const full = flatteners.length >= MAX_FLATTENERS
  const pct = (v) => `${Math.round(v * 100)}%`

  return (
    <FxCollapse title="Flattener" hint={flatteners.length ? `${flatteners.length} flattener${flatteners.length === 1 ? '' : 's'}` : 'flatten a head toward camera'}>
    <FxEditor style={{ marginTop: 0 }} aria-label="Flattener">
      <FxIntro eyebrow="FLATTENER" title="Flatten a head toward the camera" note="Follows the bone · works from any camera">
        Flattens a head toward the camera for the flat, 2D anime look. The model stays fully 3D; from the camera everything above
        the chin line is squashed flat and lit like a flat plane (no cheek or nose shading), fading out below the line so the neck
        and hair blend in. Add it to the head bone, then adjust the chin line (switch on &quot;Show chin line&quot; to see it). It is
        most visible with a toon / anime Lighting style and the head turned a little.
      </FxIntro>

      <div className="fx-effects fx-toggle">
        <FxCheck checked={flattenerEnabled} onChange={(v) => setFlattenerEnabled(activeCharacterId, v)}>
          Enable flattener
        </FxCheck>
        <FxCheck checked={showGuide} onChange={setShowGuide}>
          Show chin line
        </FxCheck>
      </div>

      {flatteners.length > 0 && (
        <FxSection step="STEP 1" title="Flatteners on this character" count={flatteners.length} countLabel={`${flatteners.length} flatteners`} label="Flatteners">
          {flatteners.map((f) => (
            <FxItem key={f.id} title={f.name} disabled={!f.enabled} pills={[`${pct(f.strength)} flat`]}>
              <FxItemActions
                left={
                  <FxCheck checked={f.enabled} onChange={(v) => updateFlattener(f.id, { enabled: v })}>
                    On
                  </FxCheck>
                }
              >
                <button
                  className="btn secondary"
                  onClick={() => refitFlattener(f.id)}
                  title="Work the head's centre, size and chin line out again from the mesh (do this after changing the character or its pose a lot)"
                >
                  Auto-fit
                </button>
                <button className="btn secondary danger" onClick={() => removeFlattener(f.id)} title="Remove this flattener" aria-label="Remove this flattener">
                  ×
                </button>
              </FxItemActions>

              <Slider
                label="Strength"
                hint="How flat. 0% = untouched, 100% = flattened as far as the Keep depth setting allows."
                value={f.strength}
                min={0}
                max={1}
                step={0.01}
                format={pct}
                onChange={(v) => updateFlattener(f.id, { strength: v })}
              />
              <Slider
                label="Chin line"
                hint="Where the flattening starts, measured from the middle of the head. Everything above this is fully flattened. Lower it to include the jaw and neck, raise it to flatten only the top of the head."
                value={f.start}
                min={-1.4}
                max={0.8}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(v) => updateFlattener(f.id, { start: v })}
              />
              <Slider
                label="Falloff"
                hint="How far below the chin line the flattening fades out. Bigger = a softer blend into the neck and hair."
                value={f.falloff}
                min={0.02}
                max={1.2}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(v) => updateFlattener(f.id, { falloff: v })}
              />
              <Slider
                label="Flatten shading"
                hint="How much the lighting is flattened too. 100% = the face is lit like a flat drawing, with no cheek, nose or brow shading. This is most of the anime look. Lower it to keep some of the 3D shading."
                value={f.shading ?? 1}
                min={0}
                max={1}
                step={0.01}
                format={pct}
                onChange={(v) => updateFlattener(f.id, { shading: v })}
              />
              <Slider
                label="Shading edge"
                hint="Surfaces turned away from the camera (the sides of the head, hair cards that face backwards) keep their own lighting; this is how wide the blend into the flattened lighting is. Raise it if the hair or the sides of the face show dark or semi-transparent looking patches; 0 flattens the lighting of everything facing the camera."
                value={f.shadingEdge ?? 0.15}
                min={0}
                max={0.8}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(v) => updateFlattener(f.id, { shadingEdge: v })}
              />
              <Slider
                label="Keep screen shape"
                hint="0% = a true flatten (the outline of the hair and head shifts a little as the depth is squashed). 100% = every point stays exactly where it was on screen and only the lighting and depth change. Raise it if the hair layers separate and show the dark parts underneath."
                value={f.keepScreen ?? 0}
                min={0}
                max={1}
                step={0.01}
                format={pct}
                onChange={(v) => updateFlattener(f.id, { keepScreen: v })}
              />
              <Slider
                label="Keep depth"
                hint="How much of the original depth is left at full strength. Keep a little (a few %) so the front of the head still sorts in front of the back."
                value={f.thickness}
                min={0}
                max={0.4}
                step={0.005}
                format={pct}
                onChange={(v) => updateFlattener(f.id, { thickness: v })}
              />
            </FxItem>
          ))}
        </FxSection>
      )}

      <FxSection step={flatteners.length > 0 ? 'STEP 2' : 'STEP 1'} title="Add a flattener" label="Add a flattener">
        <FxHelp>
          {headBone ? 'Usually it goes on the head bone. Use the selected bone for anything else that should flatten.' : 'No head bone was recognised: select a bone and use "Add to selected bone".'}
        </FxHelp>
        <FxButtons>
          <button
            className="btn secondary"
            disabled={!headBone || full}
            onClick={() => addFlattener(headBone)}
            title={headBone ? `Flatten everything above the chin, on "${headBone}"` : 'No head bone was recognised — select a bone and use the other button'}
          >
            Add to head
          </button>
          <button
            className="btn secondary"
            disabled={!selectedBoneName || full}
            onClick={() => addFlattener(selectedBoneName)}
            title="Add a flattener on the selected bone"
          >
            Add to selected bone
          </button>
        </FxButtons>
        {flatteners.length === 0 && <FxEmpty>No flattener yet.</FxEmpty>}
      </FxSection>
    </FxEditor>
    </FxCollapse>
  )
}
