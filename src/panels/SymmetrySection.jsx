import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { FxEditor, FxIntro, FxSection, FxField, FxCheck, FxHelp, FxButtons, FxPicking } from './FxCards.jsx'
import { getCurrentModel } from '../three/scene.js'
import { setFacePickHandler } from '../three/meshedit.js'
import { setPartRigHighlight, trisFromClick, resizeSelection } from '../three/partRig.js'
import { applySymmetry, planSymmetry, describeSymmetryFrame, getSymmetryEntries, isSymmetryCapable } from '../three/meshSymmetry.js'

const MODES = [
  { id: 'piece', label: 'Whole piece', hint: 'Click once: selects the whole connected piece (an arm that is its own piece).' },
  { id: 'brush', label: 'Brush', hint: 'Click to paint a patch on the surface — for an arm or leg that is joined to the body. Click again to add more.' },
  { id: 'color', label: 'Same colour', hint: 'Selects the connected faces that keep the colour you clicked.' },
  { id: 'face', label: 'Single face', hint: 'One face at a time, for fine tuning.' },
]

const sideLabel = (s) => (s === 'right' ? 'right' : 'left')

export default function SymmetrySection({ meshUuid, resolveMesh, partsList = [], labelFor }) {
  const [side, setSide] = useState('left') // 'left' | 'right' | 'auto' (the side of the picked faces)
  const [scope, setScope] = useState('whole') // 'whole' | 'faces'
  const [otherUuid, setOtherUuid] = useState('')
  const [tris, setTris] = useState([])
  const [picking, setPicking] = useState(false)
  const [mode, setMode] = useState('piece')
  const [erase, setErase] = useState(false)
  const [brushPct, setBrushPct] = useState(6)
  const [tolerance, setTolerance] = useState(0.25)
  const [customCentre, setCustomCentre] = useState(false)
  const [centreText, setCentreText] = useState('0')
  const [summary, setSummary] = useState(null)
  const [message, setMessage] = useState('')
  const [version, setVersion] = useState(0)

  const model = getCurrentModel()
  const mesh = resolveMesh(meshUuid)
  const other = otherUuid ? resolveMesh(otherUuid) : null
  const capable = isSymmetryCapable(mesh)
  const ref = useRef({})
  ref.current = { mesh, mode, erase, brushPct, tolerance, model }

  useEffect(() => {
    setTris([])
    setPicking(false)
    setMessage('')
    setOtherUuid('')
  }, [meshUuid])

  const frame = capable && model ? describeSymmetryFrame(model, mesh) : null
  const centreValue = customCentre ? Number(centreText) : null
  const effectiveSide = scope === 'faces' && side !== 'left' && side !== 'right' ? 'auto' : side === 'auto' ? (scope === 'faces' ? 'auto' : 'left') : side
  const spec = { kind: 'symmetrise', sourceSide: effectiveSide, tris: scope === 'faces' ? tris : [], centre: Number.isFinite(centreValue) ? centreValue : null }

  // click in the viewport -> faces
  useEffect(() => {
    if (!picking) return undefined
    setFacePickHandler((hit) => {
      const r = ref.current
      if (!hit) return setMessage('Click on the part you want to copy from.')
      if (!r.mesh || hit.uuid !== r.mesh.uuid) return setMessage('Click on the part you selected.')
      const box = new THREE.Box3().setFromObject(r.model.root)
      const height = Math.max(box.max.y - box.min.y, 0.01)
      const picked = trisFromClick(r.mesh, hit, { mode: r.mode, tolerance: r.tolerance, radius: (height * r.brushPct) / 100 })
      setMessage('')
      setTris((cur) => {
        if (r.erase) {
          const drop = new Set(picked)
          return cur.filter((t) => !drop.has(t))
        }
        return Array.from(new Set([...cur, ...picked]))
      })
    }, { allowSkinned: true })
    return () => setFacePickHandler(null)
  }, [picking])

  // pink highlight of the picked faces
  useEffect(() => {
    if (mesh) setPartRigHighlight(mesh, scope === 'faces' ? tris : [])
    return () => { if (mesh) setPartRigHighlight(mesh, null) }
  }, [tris, scope, meshUuid])

  useEffect(() => () => setFacePickHandler(null), [])

  // how well the two sides line up (follows every change of settings)
  useEffect(() => {
    if (!capable || !model) return undefined
    const dense = mesh.geometry.attributes.position.count > 40000 || (other && other.geometry.attributes.position.count > 40000)
    if (dense) {
      setSummary({ dense: true }) // matching a very dense part takes a couple of seconds: only do it when asked
      return undefined
    }
    const timer = setTimeout(() => {
      const plan = planSymmetry(model, mesh, spec, other)
      setSummary(plan.ok ? { pairs: plan.stats.pairs, unmatched: plan.stats.unmatched } : { error: plan.reason })
    }, 300)
    return () => clearTimeout(timer)
  }, [meshUuid, otherUuid, side, scope, tris, customCentre, centreText, version])

  if (!mesh) return null
  if (!capable) return <div className="radio-hint" style={{ marginTop: 10 }}>This part has no surface to mirror.</div>

  const entries = getSymmetryEntries(model).filter((e) => e.meshIndex === model.meshes.indexOf(mesh) || e.targetIndex === model.meshes.indexOf(mesh))

  function done(res, what) {
    if (!res.ok) return setMessage(res.reason)
    setTris([])
    setPicking(false)
    setVersion((v) => v + 1)
    const s = res.stats || {}
    const extra = [
      s.keptForRig ? `${s.keptForRig} point${s.keptForRig === 1 ? '' : 's'} on added rig bones were left alone` : '',
      s.influencesOnUnpairedBones ? `${s.influencesOnUnpairedBones} weights are on bones with no opposite` : '',
    ].filter(Boolean).join('; ')
    setMessage(`${what}${extra ? ` (${extra})` : ''}. Ctrl+Z undoes it.`)
  }

  function onMirror() {
    done(applySymmetry(model, mesh, { kind: 'mirror', centre: spec.centre }), `Mirrored ${mesh.name || 'the part'}`)
  }

  function onSymmetrise() {
    const from = effectiveSide === 'auto' ? 'the picked faces' : `the ${sideLabel(effectiveSide)} side`
    done(applySymmetry(model, mesh, spec, { targetMesh: other }), `The other side now matches ${from}`)
  }

  const canSymmetrise = (scope === 'whole' || tris.length > 0) && summary && !summary.error

  return (
    <FxEditor>
      <FxIntro eyebrow="MODELLING" title="Mirror and symmetrise" note="Keeps skin weights and rigs · Ctrl+Z undoes">
        Flip a part to the other side, or make one side match the other (a long arm, a different hand). Skin weights move onto the opposite-side bones, so the rig keeps working. Bones are not moved.
      </FxIntro>

      <FxSection step="MIRROR" title="Flip this part left ↔ right" label="Mirror part">
        <FxButtons wide>
          <button className="btn fx-btn-main" onClick={onMirror} title="Reflect the whole part across the centre line and swap its left/right skin weights, as Mirror does for a pose">
            Mirror part
          </button>
        </FxButtons>
      </FxSection>

      <FxSection step="SYMMETRISE" title="Make one side match the other" label="Symmetrise">
        <FxField label="Copy from" title="The side that stays as it is; the other side is changed to match it">
          <select value={side} onChange={(e) => setSide(e.target.value)} aria-label="Side to copy from">
            <option value="left">The left side</option>
            <option value="right">The right side</option>
            {scope === 'faces' && <option value="auto">The side of the picked faces</option>}
          </select>
        </FxField>
        <FxField label="What to copy" title="The whole side of the part, or only the faces you pick (one arm, one leg)">
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value)
              if (e.target.value === 'faces') setSide('auto')
              else if (side === 'auto') setSide('left')
            }}
            aria-label="What to copy"
          >
            <option value="whole">The whole side</option>
            <option value="faces">Only picked faces</option>
          </select>
        </FxField>

        {scope === 'faces' && (
          <>
            <FxButtons wide>
              <button className={`btn fx-btn-main ${picking ? '' : 'secondary'}`} onClick={() => { setPicking((v) => !v); setMessage('') }}>
                {picking ? 'Picking: click the part…' : 'Pick faces'}
              </button>
              <button className="btn secondary danger" disabled={!tris.length} onClick={() => setTris([])} title="Forget every picked face">Clear</button>
            </FxButtons>
            <FxButtons wide>
              <button className="btn secondary" disabled={!tris.length} onClick={() => setTris((cur) => resizeSelection(mesh, cur, 1))} title="Add one ring of faces around the selection">Grow</button>
              <button className="btn secondary" disabled={!tris.length} onClick={() => setTris((cur) => resizeSelection(mesh, cur, -1))} title="Take one ring of faces off the selection">Shrink</button>
            </FxButtons>
            {picking && (
              <FxPicking>
                <FxHelp>{MODES.find((m) => m.id === mode)?.hint}</FxHelp>
                <FxField label="Select">
                  <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="How a click picks faces">
                    {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </FxField>
                {mode === 'brush' && (
                  <label className="slider-row" title="Brush size as a share of the character's height">
                    <span className="slider-label">Brush</span>
                    <input type="range" min={1} max={40} step={1} value={brushPct} onChange={(e) => setBrushPct(Number(e.target.value))} />
                    <span className="slider-value">{brushPct}%</span>
                  </label>
                )}
                {mode === 'color' && (
                  <label className="slider-row" title="How far a colour may drift from the one you clicked">
                    <span className="slider-label">Tolerance</span>
                    <input type="range" min={0} max={1} step={0.01} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} />
                    <span className="slider-value">{Math.round(tolerance * 100)}%</span>
                  </label>
                )}
                <FxCheck checked={erase} onChange={setErase}>Remove from selection instead</FxCheck>
              </FxPicking>
            )}
          </>
        )}

        {partsList.length > 0 && (
          <FxField label="The other side is in" title="Pick another part when the left and right sides are separate parts (two arms)">
            <select value={otherUuid} onChange={(e) => setOtherUuid(e.target.value)} aria-label="Part holding the other side">
              <option value="">This same part</option>
              {partsList.map((p) => <option key={p.uuid} value={p.uuid}>{labelFor ? labelFor(p) : p.name}</option>)}
            </select>
          </FxField>
        )}

        <details className="fx-more">
          <summary>Centre line</summary>
          <FxHelp>
            {frame ? `Found at X = ${frame.centre.toFixed(3)} from the Left/Right bones. ` : ''}
            Only change this if the two sides do not line up.
          </FxHelp>
          <FxCheck checked={customCentre} onChange={setCustomCentre}>Set it myself</FxCheck>
          {customCentre && (
            <FxField label="Centre X">
              <input type="number" step="0.01" value={centreText} onChange={(e) => setCentreText(e.target.value)} aria-label="Centre line X" />
            </FxField>
          )}
        </details>

        <FxButtons wide>
          <button className="btn fx-btn-main" disabled={!canSymmetrise} onClick={onSymmetrise}>Symmetrise</button>
        </FxButtons>

        <FxHelp>
          {scope === 'faces' && !tris.length
            ? 'Nothing picked yet. Press Pick faces, then click the part in the viewport.'
            : summary
              ? summary.dense
                ? 'This part is very dense, so the match is only worked out when you press Symmetrise (a few seconds).'
                : summary.error
                ? summary.error
                : `${summary.pairs} point${summary.pairs === 1 ? '' : 's'} on the other side will change.` +
                  (summary.unmatched ? ` ${summary.unmatched} have no partner and stay as they are.` : '')
              : 'Checking the two sides…'}
        </FxHelp>
      </FxSection>

      {message && <FxHelp>{message}</FxHelp>}
      {entries.length > 0 && <FxHelp>{entries.length} mirror / symmetrise edit{entries.length === 1 ? '' : 's'} applied to this part (saved with the project).</FxHelp>}
    </FxEditor>
  )
}
