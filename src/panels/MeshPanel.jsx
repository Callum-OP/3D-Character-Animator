import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store.js'
import {
  getMeshDelta,
  setMeshDelta,
  getMeshKeyValue,
  resetMesh,
  resetAllMeshes,
  undo,
  redo,
  getLinkedMorphTargets,
  getMeshIndex,
} from '../three/meshedit.js'
import {
  getCurrentModel,
  requestRender,
  bakeClothAnimation,
  hasBakedTimeline,
  clearBakedTimeline,
} from '../three/scene.js'
import {
  FABRIC_PRESETS,
  isClothEnabled,
  enableCloth,
  disableCloth,
  bakeCloth,
  resetCloth,
  setPinTool,
  setBrushSize,
  clearPins,
  saveVertexGroup,
  setClothPlaying,
  isClothPlaying,
  stepClothOnce,
  applyFabricPreset,
} from '../three/clothmod.js'
import { getClipDuration } from '../three/animation.js'
import EditableValue from './EditableValue.jsx'

// Side-panel section for Mesh mode: pick a part of the character (eyes, hair,
// clothing…) and move, rotate or resize it. Click a part in the viewport or in
// the list below; values are offsets from where the part started, so 0 / 0° /
// 1× always means "untouched".
const MODES = [
  { value: 'translate', label: 'Move', title: 'Drag arrows to move the part (W)' },
  { value: 'rotate', label: 'Rotate', title: 'Drag rings to turn the part (E)' },
  { value: 'scale', label: 'Resize', title: 'Drag handles to resize the part (R)' },
]

const AXES = ['X', 'Y', 'Z']

export default function MeshPanel() {
  const modelInfo = useStore((s) => s.modelInfo)
  const selectedMeshUuid = useStore((s) => s.selectedMeshUuid)
  const setSelectedMeshUuid = useStore((s) => s.setSelectedMeshUuid)
  const meshGizmoMode = useStore((s) => s.meshGizmoMode)
  const setMeshGizmoMode = useStore((s) => s.setMeshGizmoMode)
  const meshOverrides = useStore((s) => s.meshOverrides)
  const setMeshVisible = useStore((s) => s.setMeshVisible)
  const linkedShapeKeys = useStore((s) => s.linkedShapeKeys)
  const setLinkedShapeKeys = useStore((s) => s.setLinkedShapeKeys)
  const animData = useStore((s) => s.animData)
  const animFps = useStore((s) => s.animFps)
  const insertTime = useStore((s) => s.insertTime)
  const st = useStore.getState
  useStore((s) => s.meshVersion) // re-render on every mesh edit (gizmo drag, undo…)
  const [, setMorphVersion] = useState(0)
  const [morphEntries, setMorphEntries] = useState([])
  const [morphValues, setMorphValues] = useState({})
  const [clothVersion, setClothVersion] = useState(0)
  const [pinTool, setPinToolState] = useState('add')
  const [brushSize, setBrushSizeState] = useState(3)
  const [fabricPreset, setFabricPreset] = useState('cotton')
  const [bakeFps, setBakeFps] = useState(24)
  const [bakeStatus, setBakeStatus] = useState('')

  const currentModel = getCurrentModel()
  const meshes = modelInfo?.meshes || []
  const selectedMeta = meshes.find((mesh) => mesh.uuid === selectedMeshUuid) || null
  const selectedMesh = selectedMeta
    ? currentModel?.meshes?.find((mesh) => mesh.uuid === selectedMeta.uuid) || null
    : null
  const selectedIndex = selectedMeta ? meshes.indexOf(selectedMeta) : -1
  const delta = selectedMesh ? getMeshDelta(selectedMesh.uuid) : null
  const keyCount = selectedIndex >= 0 ? (animData.meshes?.[selectedIndex] || []).length : 0
  const snap = (t) => Math.round(t * animFps) / animFps

  function forceRerender() {
    setMorphVersion((v) => v + 1)
  }

  const clothOn = selectedMesh ? isClothEnabled(selectedMesh.uuid) : false

  function bumpCloth() {
    setClothVersion((v) => v + 1)
  }

  function onToggleCloth(on) {
    if (!selectedMesh || !currentModel) return
    if (on) {
      const others = currentModel.meshes.filter((mesh) => mesh !== selectedMesh && mesh.visible)
      enableCloth(selectedMesh, others, { preset: fabricPreset })
    } else {
      disableCloth(selectedMesh.uuid)
      setClothPlaying(false)
    }
    bumpCloth()
  }

  function onBakeCloth() {
    if (!selectedMesh) return
    bakeCloth(selectedMesh.uuid)
    bumpCloth()
  }

  function onFabricPreset(name) {
    setFabricPreset(name)
    if (selectedMesh && clothOn) applyFabricPreset(selectedMesh.uuid, name)
  }

  function onPinTool(tool) {
    setPinToolState(tool)
    setPinTool(tool)
  }

  function onBrushSize(n) {
    setBrushSizeState(n)
    setBrushSize(n)
  }

  function onBakeToAnimation() {
    if (!selectedMesh) return
    setBakeStatus('Baking… this may take a moment')
    // Runs synchronously (it's a physics loop, not I/O), so give the status
    // text a tick to actually paint before the tab locks up briefly.
    setTimeout(() => {
      const result = bakeClothAnimation(selectedMesh.uuid, bakeFps)
      setBakeStatus(result.ok ? `Baked ${result.frameCount} frames — cloth will now follow the animation.` : result.reason)
      bumpCloth()
    }, 30)
  }

  function onClearBakedAnimation() {
    if (!selectedMesh) return
    clearBakedTimeline(selectedMesh.uuid)
    setBakeStatus('')
    bumpCloth()
  }

  function onKeyPart() {
    if (selectedIndex < 0 || !selectedMesh) return
    const key = getMeshKeyValue(selectedMesh.uuid)
    if (!key) return
    const t = snap(insertTime)
    st().addMeshKeyframe(selectedIndex, t, key)
  }

  useEffect(() => {
    if (!selectedMesh || !selectedMesh.morphTargetInfluences) {
      setMorphEntries([])
      setMorphValues({})
      return
    }

    const dictionary = selectedMesh.morphTargetDictionary || {}
    const namesByIndex = new Map(
      Object.entries(dictionary).map(([name, idx]) => [Number(idx), name]),
    )
    const positionMorphs = selectedMesh.geometry?.morphAttributes?.position || []
    const entries = Array.from(selectedMesh.morphTargetInfluences, (_, idx) => ({
      idx,
      name:
        namesByIndex.get(idx) ||
        positionMorphs[idx]?.name ||
        `Shape key ${idx + 1}`,
    }))
    setMorphEntries(entries)

    const values = {}
    for (let i = 0; i < selectedMesh.morphTargetInfluences.length; i += 1) {
      values[i] = selectedMesh.morphTargetInfluences[i]
    }
    setMorphValues(values)
  }, [
    selectedMesh?.uuid,
    selectedMesh?.morphTargetInfluences?.length,
    selectedMesh?.morphTargetDictionary,
    selectedMesh?.geometry?.morphAttributes?.position?.length,
  ])

  if (!modelInfo) {
    return (
      <div className="panel">
        <h2>Parts</h2>
        <div className="empty">Load a character to edit its parts.</div>
      </div>
    )
  }

  return (
    <div className="panel">
      <h2>Parts</h2>
      <p className="panel-hint">
        Click a part of the character (eyes, hair, clothing…) then drag the gizmo
        to move, rotate or resize just that piece.
      </p>

      <div className="seg" title="What the gizmo does when you drag it">
        {MODES.map((mo) => (
          <button
            key={mo.value}
            className={'seg-btn' + (meshGizmoMode === mo.value ? ' active' : '')}
            title={mo.title}
            onClick={() => setMeshGizmoMode(mo.value)}
          >
            {mo.label}
          </button>
        ))}
      </div>

      <div className="kf-actions" style={{ marginTop: 8 }}>
        <button className="btn secondary" onClick={undo} title="Undo the last part edit (Ctrl+Z)">
          Undo
        </button>
        <button className="btn secondary" onClick={redo} title="Redo it (Ctrl+Shift+Z)">
          Redo
        </button>
        <button
          className="btn secondary"
          onClick={resetAllMeshes}
          title="Put every part back where it started"
        >
          Reset all
        </button>
      </div>

      {selectedMesh && delta && (
        <div className="joint-controls">
          <div className="joint-header">
            <span className="joint-name" title={selectedMesh.name}>
              {selectedMesh.name}
            </span>
          </div>

          <XformRow
            label="Move"
            values={delta.offset}
            format={(v) => v.toFixed(2)}
            onChange={(offset) => setMeshDelta(selectedMesh.uuid, { offset })}
          />
          <XformRow
            label="Rotate"
            values={delta.rotation}
            format={(v) => Math.round(v) + '°'}
            onChange={(rotation) => setMeshDelta(selectedMesh.uuid, { rotation })}
          />
          <XformRow
            label="Resize"
            values={delta.scale}
            format={(v) => v.toFixed(2) + '×'}
            onChange={(scale) => setMeshDelta(selectedMesh.uuid, { scale })}
          />

          {selectedMesh && morphEntries.length > 0 && (
            <div className="joint-controls" style={{ marginTop: 8 }}>
              <div className="joint-header">
                <span className="joint-name">Shape keys</span>
                <span className="joint-parent">{selectedMesh.name}</span>
              </div>
              <label
                className="morph-label"
                style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}
                title="When on, moving a shape key also moves same-named shape keys on other nearby parts of this character (e.g. separate teeth/eyes/eyebrows meshes). Turn off to edit only this mesh, or once you have several characters loaded and don't want them to affect each other."
              >
                <input
                  type="checkbox"
                  checked={linkedShapeKeys}
                  onChange={(e) => setLinkedShapeKeys(e.target.checked)}
                />
                Link matching shape keys on nearby parts
              </label>
              {morphEntries.map(({ idx, name }) => {
                const value = morphValues[idx] ?? 0
                return (
                  <div key={`${selectedMesh.uuid}-${idx}`} className="morph-row">
                    <label className="morph-label">{name}</label>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={value}
                      onChange={(e) => {
                        const nextValue = Math.min(1, Math.max(0, parseFloat(e.target.value)))
                        if (!Number.isFinite(nextValue)) return
                        selectedMesh.morphTargetInfluences[idx] = nextValue
                        setMorphValues((prev) => ({ ...prev, [idx]: nextValue }))
                        if (linkedShapeKeys) {
                          for (const link of getLinkedMorphTargets(selectedMesh, name)) {
                            link.mesh.morphTargetInfluences[link.idx] = nextValue
                          }
                        }
                        requestRender()
                      }}
                    />
                    <span className="morph-value">{value.toFixed(2)}</span>
                    <button
                      className="btn secondary"
                      onClick={() => {
                        const currentValue = morphValues[idx] ?? 0
                        const t = snap(insertTime)
                        st().addMorphKeyframe(getMeshIndex(selectedMesh), name, t, currentValue)
                        if (linkedShapeKeys) {
                          for (const link of getLinkedMorphTargets(selectedMesh, name)) {
                            st().addMorphKeyframe(getMeshIndex(link.mesh), name, t, currentValue)
                          }
                        }
                      }}
                      title={`Save “${name}” at the current insert time`}
                    >
                      Key
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          <div className="kf-actions" style={{ marginTop: 6 }}>
            <button
              className="btn secondary"
              onClick={() => resetMesh(selectedMesh.uuid)}
              title="Put only this part back where it started"
            >
              Reset this part
            </button>
            <button
              className="btn secondary"
              onClick={onKeyPart}
              title="Save this part's position/rotation/size at the Animate panel's insert time — key it at two times and it animates between them"
            >
              Key part{keyCount ? ` (${keyCount})` : ''}
            </button>
          </div>
        </div>
      )}

      {selectedMesh && (
        <div className="joint-controls" style={{ marginTop: 10 }}>
          <div className="joint-header">
            <span className="joint-name">Cloth</span>
            <span className="joint-parent">{selectedMesh.name}</span>
          </div>
          <label
            className="morph-label"
            style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}
            title="Drape this mesh (a cape, skirt, sash…) against the rest of the character using its current pose. Re-pose, then toggle off/on to redrape against the new pose."
          >
            <input type="checkbox" checked={clothOn} onChange={(e) => onToggleCloth(e.target.checked)} />
            Enable cloth simulation
          </label>

          {clothOn && (
            <>
              <label className="field">
                <span>Fabric</span>
                <select value={fabricPreset} onChange={(e) => onFabricPreset(e.target.value)}>
                  {Object.keys(FABRIC_PRESETS).map((name) => (
                    <option key={name} value={name}>
                      {name[0].toUpperCase() + name.slice(1)}
                    </option>
                  ))}
                </select>
              </label>

              <div className="kf-actions" style={{ marginTop: 4 }}>
                <button
                  className="btn"
                  onClick={() => {
                    setClothPlaying(!isClothPlaying())
                    bumpCloth()
                  }}
                >
                  {isClothPlaying() ? '❚❚ Pause' : '▶ Drape'}
                </button>
                <button className="btn secondary" onClick={() => stepClothOnce()}>
                  ⤼ Step
                </button>
                <button
                  className="btn secondary"
                  onClick={() => {
                    resetCloth(selectedMesh.uuid)
                    bumpCloth()
                  }}
                >
                  ↺ Reset
                </button>
              </div>

              <div className="pose-hint" style={{ marginTop: 6 }}>
                Pins hold cloth to the body (e.g. a collar or waistband) and
                move with it once saved — starts pinned along the top edge;
                use the brush to add/remove pins, then save the group.
              </div>
              <div className="kf-actions" style={{ marginTop: 4 }}>
                <button
                  className={'btn secondary' + (pinTool === 'add' ? ' active' : '')}
                  onClick={() => onPinTool('add')}
                >
                  📌 Pin
                </button>
                <button
                  className={'btn secondary' + (pinTool === 'del' ? ' active' : '')}
                  onClick={() => onPinTool('del')}
                >
                  ✂ Unpin
                </button>
                <button
                  className="btn secondary"
                  onClick={() => {
                    saveVertexGroup(selectedMesh.uuid)
                    setPinToolState(null)
                    bumpCloth()
                  }}
                >
                  💾 Save Vertex Group
                </button>
              </div>
              <label className="slider-row">
                <span className="slider-label">Brush size</span>
                <input
                  type="range"
                  min={1}
                  max={12}
                  step={1}
                  value={brushSize}
                  onChange={(e) => onBrushSize(Number(e.target.value))}
                />
                <span>{brushSize}</span>
              </label>
              <button
                className="btn secondary"
                onClick={() => {
                  clearPins(selectedMesh.uuid)
                  bumpCloth()
                }}
              >
                Clear all pins
              </button>

              <div className="kf-actions" style={{ marginTop: 8 }}>
                <button
                  className="btn"
                  onClick={onBakeCloth}
                  title="Write the current drape into this mesh's own geometry and turn cloth off — it becomes a normal static part again"
                >
                  ✓ Bake drape
                </button>
              </div>

              <div className="joint-header" style={{ marginTop: 10 }}>
                <span className="joint-name">Physics during animation</span>
              </div>
              <div className="pose-hint">
                Runs the drape once across the whole clip — re-posing and
                re-colliding at each sampled frame — then caches the result so
                it plays back at animation speed. Re-bake after changing the
                pose, timing, or fabric.
              </div>
              <label className="slider-row">
                <span className="slider-label">Sample rate</span>
                <input
                  type="range"
                  min={8}
                  max={60}
                  step={1}
                  value={bakeFps}
                  onChange={(e) => setBakeFps(Number(e.target.value))}
                />
                <span>{bakeFps} fps</span>
              </label>
              <div className="kf-actions" style={{ marginTop: 4 }}>
                <button
                  className="btn"
                  onClick={onBakeToAnimation}
                  disabled={!getClipDuration()}
                  title={getClipDuration() ? 'Bake cloth physics across the current clip' : 'Load or select an animation clip first'}
                >
                  🎬 Bake to animation
                </button>
                {selectedMesh && hasBakedTimeline(selectedMesh.uuid) && (
                  <button className="btn secondary" onClick={onClearBakedAnimation}>
                    Clear baked animation
                  </button>
                )}
              </div>
              {bakeStatus && <div className="status" style={{ marginTop: 4 }}>{bakeStatus}</div>}
            </>
          )}
        </div>
      )}

      <div className="obj-list" style={{ marginTop: 10 }}>
        {meshes.map((mesh) => {
          const hidden = meshOverrides[mesh.uuid]?.visible === false
          return (
            <div
              key={mesh.uuid}
              className={'obj-row' + (mesh.uuid === selectedMeshUuid ? ' selected' : '')}
              title={mesh.name}
              onClick={() =>
                setSelectedMeshUuid(mesh.uuid === selectedMeshUuid ? null : mesh.uuid)
              }
            >
              <span className="obj-name" style={hidden ? { opacity: 0.45 } : undefined}>
                {mesh.name}
              </span>
              <button
                className="obj-eye"
                title={hidden ? 'Show this part' : 'Hide this part'}
                onClick={(e) => {
                  e.stopPropagation()
                  setMeshVisible(mesh.uuid, hidden)
                }}
              >
                {hidden ? '🙈' : '👁'}
              </button>
            </div>
          )
        })}
      </div>

      <div className="pose-hint">
        Click a part or a name to select, then drag the gizmo. W/E/R switch
        Move/Rotate/Resize · Esc deselects · Ctrl+Z undoes. Parts attached to the
        skeleton keep following it — an offset eye still turns with the head.
      </div>
    </div>
  )
}

// One transform row: a label and three click-to-type axis values.
function XformRow({ label, values, format, onChange }) {
  return (
    <div className="xform-row">
      <span className="xform-label">{label}</span>
      {AXES.map((axis, i) => (
        <EditableValue
          key={axis}
          className="xform-value"
          label={`${label} ${axis}`}
          value={values[i]}
          format={format}
          onChange={(v) => {
            const next = values.slice()
            next[i] = v
            onChange(next)
          }}
        />
      ))}
    </div>
  )
}