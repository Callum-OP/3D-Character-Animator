import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store.js'
import {
  getMeshDelta,
  setMeshDelta,
  getMeshKeyValue,
  resetAllMeshes,
  getLinkedMorphTargets,
  getMeshIndex,
  getMeshByUuid,
  isObjectMesh,
} from '../three/meshedit.js'
import {
  getCurrentModel,
  requestRender,
  setMeshVisibleByUuid,

  setMeshesVisibleByUuids,
  extractPartsToObject,
  applyModelMaterials,
} from '../three/scene.js'
import { getObjectMeshesInfo } from '../three/objects.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import {
  FABRIC_PRESETS,
  isClothEnabled,
  enableCloth,
  disableCloth,
  resetCloth,
  setPinTool,
  setBrushSize,
  clearPins,
  saveVertexGroup,
  setClothPlaying,
  isClothPlaying,
  stepClothOnce,
  applyFabricPreset,
  setClothShrinkwrap,
  isClothShrinkwrap,
} from '../three/clothmod.js'
import EditableValue from './EditableValue.jsx'
import ColorControl from './ColorControl.jsx'
import MaterialEditor from './MaterialEditor.jsx'
import RegionEditor from './RegionEditor.jsx'
import DecimateEditor from './DecimateEditor.jsx'
import { useRowMenu, RowMenuButton } from './rowMenu.jsx'
import { partMenu, partTargets } from './rowMenus.js'
import LightFromPart from './LightFromPart.jsx'
import { withGlowRegion } from '../three/glowRegions.js'
import { recordOverrideEdit } from '../three/materialHistory.js'

// Side-panel section for Mesh mode: pick a part of the character (eyes, hair,
// clothing…) and move, rotate, resize or recolour it. Click a part in the
// viewport or in the list below; Shift/Ctrl-click adds more parts, and
// Shift/Ctrl-dragging a box in the viewport selects every part inside it.
// Values are offsets from where the part started, so 0 / 0° / 1× always means
// "untouched".
const MODES = [
  { value: 'translate', label: 'Move', title: 'Drag arrows to move the part (W)' },
  { value: 'rotate', label: 'Rotate', title: 'Drag rings to turn the part (E)' },
  { value: 'scale', label: 'Resize', title: 'Drag handles to resize the part (R)' },
]

const AXES = ['X', 'Y', 'Z']

export default function MeshPanel() {
  const modelInfo = useStore((s) => s.modelInfo)
  const selectedMeshUuid = useStore((s) => s.selectedMeshUuid)
  const selectedMeshUuids = useStore((s) => s.selectedMeshUuids)
  const setSelectedMeshUuid = useStore((s) => s.setSelectedMeshUuid)
  const toggleMeshSelection = useStore((s) => s.toggleMeshSelection)
  const setMeshesColor = useStore((s) => s.setMeshesColor)
  const meshGizmoMode = useStore((s) => s.meshGizmoMode)
  const setMeshGizmoMode = useStore((s) => s.setMeshGizmoMode)
  const meshOverrides = useStore((s) => s.meshOverrides)
  const linkedShapeKeys = useStore((s) => s.linkedShapeKeys)
  const setLinkedShapeKeys = useStore((s) => s.setLinkedShapeKeys)
  const animData = useStore((s) => s.animData)
  const animFps = useStore((s) => s.animFps)
  const insertTime = useStore((s) => s.insertTime)
  useStore((s) => s.sceneObjects) // re-render the prop-parts list as props are added/removed
  const st = useStore.getState
  useStore((s) => s.meshVersion) // re-render on every mesh edit (gizmo drag, undo…)
  const [, setMorphVersion] = useState(0)
  const [extracting, setExtracting] = useState(false)
  const [extractMsg, setExtractMsg] = useState('')
  const [morphEntries, setMorphEntries] = useState([])
  const [morphValues, setMorphValues] = useState({})
  const [clothVersion, setClothVersion] = useState(0)
  const [pinTool, setPinToolState] = useState('add')
  const [brushSize, setBrushSizeState] = useState(3)
  const [fabricPreset, setFabricPreset] = useState('cotton')
  const [shrinkwrap, setShrinkwrapState] = useState(false)
  const rowMenu = useRowMenu()

  const currentModel = getCurrentModel()
  const meshes = modelInfo?.meshes || []
  const selectedMeta = meshes.find((mesh) => mesh.uuid === selectedMeshUuid) || null
  const characterMesh = selectedMeta
    ? currentModel?.meshes?.find((mesh) => mesh.uuid === selectedMeta.uuid) || null
    : null
  // Props are pickable in Mesh mode too (see meshedit.js's registerObjectMeshes) but
  // aren't part of the character's mesh list — fall back to a direct lookup so
  // clicking a prop's part (in the viewport, or the list below) still drives the
  // gizmo + these controls. isObjectMesh gates the character-only sections below
  // (cloth/morphs/keyframing) which don't apply to a standalone prop part.
  const objectMesh = !characterMesh && selectedMeshUuid ? getMeshByUuid(selectedMeshUuid) : null
  const selectedMesh = characterMesh || objectMesh
  const isPropPart = !!objectMesh && isObjectMesh(objectMesh)
  const selectedIndex = selectedMeta ? meshes.indexOf(selectedMeta) : -1
  const delta = selectedMesh ? getMeshDelta(selectedMesh.uuid) : null
  const keyCount = selectedIndex >= 0 ? (animData.meshes?.[selectedIndex] || []).length : 0
  const snap = (t) => Math.round(t * animFps) / animFps
  const objectPartGroups = getObjectMeshesInfo()
  const multi = selectedMeshUuids.length > 1
  // The colour controls edit EVERY selected part; what they show is the
  // primary (last-picked) part's current colour.
  const colorOverride = selectedMeshUuid ? meshOverrides[selectedMeshUuid] : null

  async function onExtract(removeOriginals, uuids = selectedMeshUuids) {
    setExtracting(true)
    try {
      const result = await extractPartsToObject(uuids, { removeOriginals })
      setExtractMsg(result.message)
      if (result.ok) setSelectedMeshUuid(null)
    } finally {
      setExtracting(false)
    }
  }

  function applyColor(patch) {
    if (!selectedMeshUuids.length) return
    recordOverrideEdit(selectedMeshUuids, () => setMeshesColor(selectedMeshUuids, patch))
    applyModelMaterials()
  }

  // Row click in the lists below: plain click selects just that part (or, if
  // it's the only one selected, deselects it); Shift/Ctrl/Cmd-click adds or
  // removes it from the selection — the same behaviour as the Objects panel.
  function onRowClick(e, uuid) {
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    if (additive) toggleMeshSelection(uuid, true)
    else if (selectedMeshUuids.length <= 1) setSelectedMeshUuid(uuid === selectedMeshUuid ? null : uuid)
    else setSelectedMeshUuid(uuid)
  }

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
      enableCloth(selectedMesh, others, { preset: fabricPreset, shrinkwrap })
    } else {
      disableCloth(selectedMesh.uuid)
      setClothPlaying(false)
    }
    bumpCloth()
  }

  function onFabricPreset(name) {
    setFabricPreset(name)
    if (selectedMesh && clothOn) applyFabricPreset(selectedMesh.uuid, name)
  }

  function onShrinkwrap(on) {
    setShrinkwrapState(on)
    if (selectedMesh && clothOn) setClothShrinkwrap(selectedMesh.uuid, on)
  }

  function onPinTool(tool) {
    setPinToolState(tool)
    setPinTool(tool)
  }

  function onBrushSize(n) {
    setBrushSizeState(n)
    setBrushSize(n)
  }

  function onKeyPart(uuid) {
    const index = meshes.findIndex((m) => m.uuid === uuid)
    if (index < 0) return
    const key = getMeshKeyValue(uuid)
    if (!key) return
    st().addMeshKeyframe(index, snap(insertTime), key)
  }

  // The menu for a part row. If the row is part of a multi-selection it acts on all of
  // them, otherwise on just that part (and right-clicking an unselected row selects it).
  function buildMenu(uuid) {
    if (!selectedMeshUuids.includes(uuid)) setSelectedMeshUuid(uuid)
    return partMenu(partTargets(uuid), {
      nameOf: (u) => meshes.find((m) => m.uuid === u)?.name || objectPartGroups.flatMap((g) => g.parts).find((x) => x.uuid === u)?.name,
      isCharacterPart: (u) => meshes.some((m) => m.uuid === u),
      keyPart: onKeyPart,
      extract: onExtract,
      extracting,
    })
  }

  // One row of a parts list: name, eye, ⋯. Same for the character's parts and for props.
  function renderPartRow(part) {
    const hidden = meshOverrides[part.uuid]?.visible === false
    return (
      <div
        key={part.uuid}
        className={'obj-row' + (selectedMeshUuids.includes(part.uuid) ? ' selected' : '') + (multi && part.uuid === selectedMeshUuid ? ' obj-row-primary' : '')}
        title={part.name}
        onClick={(e) => onRowClick(e, part.uuid)}
        onContextMenu={(e) => {
          const { items, run } = buildMenu(part.uuid)
          rowMenu.openAt(e, items, run)
        }}
      >
        <div className="obj-row-main">
          <span className="obj-name" style={hidden ? { opacity: 0.45 } : undefined}>
            {part.name}
          </span>
          <button
            className="obj-eye"
            title={hidden ? 'Show this part' : 'Hide this part'}
            onClick={(e) => {
              e.stopPropagation()
              // Eye on a part that's part of a multi-selection flips the
              // whole selection together.
              if (selectedMeshUuids.length > 1 && selectedMeshUuids.includes(part.uuid)) setMeshesVisibleByUuids(selectedMeshUuids, hidden)
              else setMeshVisibleByUuid(part.uuid, hidden)
            }}
          >
            {hidden ? '🙈' : '👁'}
          </button>
          <RowMenuButton
            label="Part options"
            onOpen={(e) => {
              const { items, run } = buildMenu(part.uuid)
              rowMenu.openFromButton(e, items, run)
            }}
          />
        </div>
      </div>
    )
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

  if (!modelInfo && objectPartGroups.length === 0) {
    return (
      <div className="panel">
        <h2>Parts</h2>
        <div className="empty">Load a character or object to edit its parts.</div>
      </div>
    )
  }

  return (
    <div className="panel">
      <h2>Parts</h2>
      <p className="panel-hint">
        Pick a part of the character or an object, then drag the gizmo to move, rotate or resize just that piece.
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
        <button className="btn secondary" onClick={() => performUndo(useStore.getState())} title="Undo the latest edit (Ctrl+Z)">
          Undo
        </button>
        <button className="btn secondary" onClick={() => performRedo(useStore.getState())} title="Redo the latest undone edit (Ctrl+Shift+Z)">
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

      <div className="obj-list" style={{ marginTop: 10 }}>
        {meshes.map((mesh) => renderPartRow(mesh))}
      </div>

      {objectPartGroups.map((group) => (
        <div key={group.objectId} className="obj-list" style={{ marginTop: 10 }}>
          <div className="joint-parent" style={{ marginBottom: 4 }} title={group.objectName}>
            {group.objectName}
          </div>
          {group.parts.map((part) => renderPartRow(part))}
        </div>
      ))}
      <p className="obj-row-hint">Right-click a part (or press ⋯) to hide it, reset it, frame it, key it or make it into an object.</p>
      {extractMsg && <div className="pose-msg">{extractMsg}</div>}
      {rowMenu.element}

      {multi && (
        <div className="joint-controls">
          <div className="pose-msg">
            {selectedMeshUuids.length} parts selected — drag the 3D gizmo to move, rotate or
            resize them together.
          </div>
        </div>
      )}

      {selectedMesh && delta && !multi && (
        <div className="joint-controls">
          <div className="joint-header">
            <span className="joint-name" title={selectedMesh.name}>
              {selectedMesh.name}
            </span>
            {keyCount > 0 && <span className="kf-tag">{keyCount} keys</span>}
            <RowMenuButton
              label="Part options"
              onOpen={(e) => {
                const { items, run } = buildMenu(selectedMesh.uuid)
                rowMenu.openFromButton(e, items, run)
              }}
            />
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

          {selectedMesh && morphEntries.length > 0 && !isPropPart && (
            <details className="joint-controls" style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer' }}>
                <span className="joint-name">Shape keys</span>{' '}
                <span className="joint-parent">{morphEntries.length}</span>
              </summary>
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
                        const t = snap(insertTime)
                        // Key every shape key on this mesh at its current
                        // value, not just this row — otherwise shapes that
                        // were keyed earlier (e.g. "Neutral" at the start)
                        // keep holding their old value forward through the
                        // whole clip once a later shape (e.g. "Angry"/
                        // "Shocked") gets its own single key, since a track
                        // with one key holds constant across the whole
                        // timeline. Snapshotting all of them here means the
                        // ones currently back at 0 actually get a 0-key too,
                        // so the expressions crossfade instead of stacking.
                        const allValues = morphEntries.map((e) => ({
                          morphName: e.name,
                          value: morphValues[e.idx] ?? 0,
                        }))
                        st().addMorphKeyframesAtTime(getMeshIndex(selectedMesh), allValues, t)
                        if (linkedShapeKeys) {
                          for (const { morphName: linkName, value } of allValues) {
                            for (const link of getLinkedMorphTargets(selectedMesh, linkName)) {
                              st().addMorphKeyframe(getMeshIndex(link.mesh), linkName, t, value)
                            }
                          }
                        }
                      }}
                      title={`Save all shape key values on “${selectedMesh.name}” at the current insert time (Key position in Animate also saves them for the whole character)`}
                    >
                      Key
                    </button>
                  </div>
                )
              })}
            </details>
          )}
        </div>
      )}

      {selectedMeshUuids.length > 0 && (
        <div className="joint-controls" style={{ marginTop: 10 }}>
          <div className="joint-header">
            <span className="joint-name">Colour (whole part)</span>
            <span className="joint-parent">
              {multi ? `${selectedMeshUuids.length} parts` : selectedMesh?.name}
            </span>
          </div>
          <ColorControl
            color={colorOverride?.color || null}
            solid={!!colorOverride?.solid}
            onChange={applyColor}
            onClear={() => applyColor({ color: null })}
          />
        </div>
      )}

      {selectedMeshUuids.length > 0 && (
        <details className="joint-controls" style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer' }}>
            <span className="joint-name">Turn into a light</span>{' '}
            <span className="joint-parent">glowing parts, headlights…</span>
          </summary>
        <LightFromPart
          uuids={selectedMeshUuids}
          label={selectedMeshUuids.length > 1 ? `Turn ${selectedMeshUuids.length} parts into lights` : 'Turn into a light'}
          onCreated={(result, { glow }) => {
            if (!glow) return
            // The part itself should look lit too: a whole-part glow region in the light's colour.
            const overrides = useStore.getState().meshOverrides
            const next = {}
            for (const item of result.items) {
              const mesh = getMeshByUuid(item.uuid)
              const regions = withGlowRegion(mesh, (overrides[item.uuid] && overrides[item.uuid].regions) || [], item.colour)
              if (regions) next[item.uuid] = regions
            }
            const uuids = Object.keys(next)
            if (!uuids.length) return
            recordOverrideEdit(uuids, () => uuids.forEach((u) => useStore.getState().setMeshRegions(u, next[u])))
            applyModelMaterials()
          }}
        />
        </details>
      )}

      {selectedMeshUuids.length === 1 && selectedMeshUuid && (
        <details className="joint-controls" style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer' }}>
            <span className="joint-name">Paint regions</span>{' '}
            <span className="joint-parent">headlights, windows, trim…</span>
          </summary>
          <RegionEditor
            meshUuid={selectedMeshUuid}
            resolveMesh={(uuid) => currentModel?.meshes?.find((m) => m.uuid === uuid) || getMeshByUuid(uuid)}
          />
        </details>
      )}

      {selectedMeshUuids.length > 0 && selectedMeshUuid && (
        <MaterialEditor
          selectedMeshUuids={selectedMeshUuids}
          primaryUuid={selectedMeshUuid}
          resolveMesh={(uuid) => currentModel?.meshes?.find((m) => m.uuid === uuid) || getMeshByUuid(uuid)}
        />
      )}

      {selectedMeshUuids.length > 0 && selectedMeshUuid && (
        <DecimateEditor
          selectedMeshUuids={selectedMeshUuids}
          primaryUuid={selectedMeshUuid}
          resolveMesh={(uuid) => currentModel?.meshes?.find((m) => m.uuid === uuid) || getMeshByUuid(uuid)}
        />
      )}

      {selectedMesh && !isPropPart && !multi && (
        <details className="joint-controls" style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer' }}>
            <span className="joint-name">Cloth</span>{' '}
            <span className="joint-parent">{clothOn ? 'on' : 'drape a cape, skirt, sash…'}</span>
          </summary>
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

              <label
                className="morph-label"
                style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, marginBottom: 4 }}
                title="Pull the cloth tight against the body instead of hanging loose — good for t-shirts, gloves, anything skin-tight rather than a cape or skirt."
              >
                <input
                  type="checkbox"
                  checked={clothOn ? isClothShrinkwrap(selectedMesh.uuid) : shrinkwrap}
                  onChange={(e) => onShrinkwrap(e.target.checked)}
                />
                Shrinkwrap to body
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
            </>
          )}
        </details>
      )}

      <div className="pose-hint">
        Click a part or a name to select, then drag the gizmo. Shift/Ctrl-click
        adds more parts; Shift/Ctrl-drag a box in the viewport to select every
        part inside it (Shift also keeps the current selection). W/E/R switch
        Move/Rotate/Resize · Esc deselects · Ctrl+Z undoes. Parts attached to the
        skeleton keep following it — an offset eye still turns with the head.
        Object parts don't have shape keys, cloth or keyframing, but move,
        rotate, resize, undo and reset all work the same way.
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