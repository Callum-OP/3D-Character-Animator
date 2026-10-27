import { useRef, useState } from 'react'
import { useStore } from '../store.js'
import {
  addObjectFile,
  addImageFile,
  removeObjectById,
  setObjectVisibleById,
  renameObjectById,
  getMeshUuidsForObject,
  applyModelMaterials,
} from '../three/scene.js'
import {
  getSelectedUniformScale,
  setSelectedUniformScale,
  snapshotObject,
  commitUniformScale,
  getObjectTransform,
  setObjectTransformWithUndo,
} from '../three/objects.js'
import RadialScale from './RadialScale.jsx'
import { MIN_UNIFORM_SCALE, clampUniformScale } from '../three/scaleLimits.js'
import TransformEditor from './TransformEditor.jsx'
import ColorControl from './ColorControl.jsx'
import { modelFileFromInput, MODEL_ACCEPT } from '../three/modelBundle.js'
import { useRowMenu, RowMenuButton, RowName } from './rowMenu.jsx'
import { objectMenu, objectTargets } from './rowMenus.js'

// Side-panel section: add props / backgrounds around the character, then move,
// rotate or resize the selected one. Objects are independent of the character —
// loading a new character leaves them in place.
const MODES = [
  { value: 'translate', label: 'Move' },
  { value: 'rotate', label: 'Rotate' },
  { value: 'scale', label: 'Resize' },
]

export default function ObjectsPanel() {
  const modelInfo = useStore((s) => s.modelInfo)
  const boneNames = modelInfo?.bones ? modelInfo.bones.map((b) => b.name) : []
  const sceneObjects = useStore((s) => s.sceneObjects)
  const selectedObjectId = useStore((s) => s.selectedObjectId)
  const selectedObjectIds = useStore((s) => s.selectedObjectIds)
  const objectMode = useStore((s) => s.objectMode)
  const meshOverrides = useStore((s) => s.meshOverrides)
  const characterRoster = useStore((s) => s.characters)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const setMeshesColor = useStore((s) => s.setMeshesColor)
  const setSelectedObjectId = useStore((s) => s.setSelectedObjectId)
  const toggleObjectSelection = useStore((s) => s.toggleObjectSelection)
  const setObjectMode = useStore((s) => s.setObjectMode)
  const multiSelected = selectedObjectIds.length > 1

  const fileRef = useRef(null)
  const imageRef = useRef(null)
  const dragBeforeRef = useRef(null)
  const [msg, setMsg] = useState(null)
  const [scaleVal, setScaleVal] = useState(1)
  const [radialDragging, setRadialDragging] = useState(false)
  // Text under edit in the exact-size box. Kept separate from scaleVal so
  // typing "1." or "" mid-edit doesn't get clobbered by re-renders — only
  // committed (parsed + applied) on blur/Enter.
  const [scaleText, setScaleText] = useState(null)
  const [keyAttachmentAtPlayhead, setKeyAttachmentAtPlayhead] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const rowMenu = useRowMenu()

  // The menu for a row. If the row is part of a multi-selection it acts on all of them,
  // otherwise on just that row (and right-clicking an unselected row selects it first,
  // the same as right-clicking in the 3D view).
  function buildMenu(o) {
    if (!selectedObjectIds.includes(o.id)) setSelectedObjectId(o.id)
    return objectMenu(objectTargets(o), {
      boneNames,
      keyAtPlayhead: keyAttachmentAtPlayhead,
      setKeyAtPlayhead: setKeyAttachmentAtPlayhead,
      startRename: setRenamingId,
      notify: setMsg,
    })
  }
  const openRowMenu = (e, o) => {
    const { items, run } = buildMenu(o)
    rowMenu.openAt(e, items, run)
  }
  const openRowMenuFromButton = (e, o) => {
    const { items, run } = buildMenu(o)
    rowMenu.openFromButton(e, items, run)
  }

  function onPick(e) {
    const picked = Array.from(e.target.files || [])
    e.target.value = ''
    if (!picked.length) return
    setMsg(null)
    modelFileFromInput(picked)
      .then((file) => addObjectFile(file))
      .catch((err) => setMsg(err.message || String(err)))
  }

  function onPickImage(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setMsg(null)
    addImageFile(file).catch((err) => setMsg(err.message || String(err)))
  }

  // Colour: recolours every part of each selected model/character (images have
  // no meshes, so they're skipped). Stored per mesh in the same override map as
  // the Parts panel's colour, so the two always agree.
  const colourTargets = sceneObjects.filter(
    (o) => selectedObjectIds.includes(o.id) && o.kind !== 'image' && getMeshUuidsForObject(o).length > 0,
  )
  const colourPrimary = colourTargets.find((o) => o.id === selectedObjectId) || colourTargets[0] || null
  const colourSource = colourPrimary
    ? (colourPrimary.isCharacter && colourPrimary.id !== activeCharacterId
        ? characterRoster[colourPrimary.id]?.meshOverrides || {}
        : meshOverrides)
    : {}
  const colourOverride = colourPrimary
    ? getMeshUuidsForObject(colourPrimary).map((uuid) => colourSource[uuid]).find((ov) => ov && ov.color) || null
    : null

  function applyObjectColor(patch) {
    for (const o of colourTargets) {
      setMeshesColor(getMeshUuidsForObject(o), patch, o.isCharacter ? o.id : null)
    }
    applyModelMaterials()
  }

  function confirmDeleteObject(object) {
    if (!window.confirm(`Are you sure you want to delete this${object.isCharacter ? ' character' : ' object'}?`)) return
    removeObjectById(object.id)
  }

  // Scene layout used to have its own "Save scene" / "Load scene" buttons
  // here, downloading just a JSON of object positions with no actual model
  // files, so "loading" a saved scene silently produced empty placeholders
  // unless you'd re-added every prop by hand first. The whole scene (models,
  // props, images and their placement) is captured properly by the Project
  // panel's Save/Open now — that's the one place a full layout is saved.

  // Commit whatever's typed in the exact-size box: parse, clamp, apply, and
  // push one undo step (mirrors the ring's onCommit) — then clear the edit
  // buffer so the input goes back to reflecting the live value.
  function commitExactScale(e) {
    const raw = e.target.value
    setScaleText(null)
    const parsed = parseFloat(raw)
    if (!selectedObjectId || !dragBeforeRef.current || !Number.isFinite(parsed)) {
      dragBeforeRef.current = null
      return
    }
    const v = clampUniformScale(parsed)
    setSelectedUniformScale(selectedObjectId, v)
    setScaleVal(v)
    commitUniformScale(selectedObjectId, dragBeforeRef.current)
    dragBeforeRef.current = null
  }

  // Step through the objects (wraps around).
  function cycle(dir) {
    if (sceneObjects.length === 0) return
    const i = sceneObjects.findIndex((o) => o.id === selectedObjectId)
    const next = ((i < 0 ? 0 : i + dir) + sceneObjects.length) % sceneObjects.length
    setSelectedObjectId(sceneObjects[next].id)
  }

  return (
    <div className="panel">
      <h2>Objects</h2>
      <p className="panel-hint">
        Add and arrange props, backgrounds, and reference images around your character.
      </p>

      <div className="kf-actions">
        <button className="btn" onClick={() => fileRef.current?.click()}>
          + Add object
        </button>
        <button
          className="btn"
          onClick={() => imageRef.current?.click()}
          title="Add a reference image as a movable plane (e.g. a pose to copy)"
        >
          + Add image
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={MODEL_ACCEPT}
        multiple
        style={{ display: 'none' }}
        onChange={onPick}
      />
      <input
        ref={imageRef}
        type="file"
        accept="image/*,.png,.jpg,.jpeg,.webp,.gif"
        style={{ display: 'none' }}
        onChange={onPickImage}
      />

      {msg && <div className="pose-msg">{msg}</div>}

      {sceneObjects.length === 0 ? (
        <div className="empty" style={{ marginTop: 10 }}>
          No objects yet — add a prop or background above.
        </div>
      ) : (
        <>
          <div className="seg" style={{ marginTop: 10 }} title="What the gizmo does when you drag it">
            {MODES.map((m) => (
              <button
                key={m.value}
                className={'seg-btn' + (objectMode === m.value ? ' active' : '')}
                onClick={() => setObjectMode(m.value)}
              >
                {m.label}
              </button>
            ))}
          </div>

          {!multiSelected && selectedObjectId != null && getObjectTransform(selectedObjectId) && (
            <TransformEditor
              label={sceneObjects.find((object) => object.id === selectedObjectId)?.name || 'Object'}
              transform={getObjectTransform(selectedObjectId)}
              readTransform={() => getObjectTransform(selectedObjectId)}
              onCommit={(transform) => setObjectTransformWithUndo(selectedObjectId, transform)}
            />
          )}

          {multiSelected && (
            <div className="pose-msg" style={{ marginTop: 10 }}>
              {selectedObjectIds.length} objects selected — drag the 3D gizmo to{' '}
              {objectMode === 'translate' ? 'move' : objectMode === 'rotate' ? 'rotate' : 'resize'} them all together.
            </div>
          )}

          {colourTargets.length > 0 && (
            <div className="joint-controls" style={{ marginTop: 10 }}>
              <div className="joint-header">
                <span className="joint-name">Colour</span>
                <span className="joint-parent">
                  {colourTargets.length > 1 ? `${colourTargets.length} objects` : colourTargets[0].name}
                </span>
              </div>
              <ColorControl
                color={colourOverride?.color || null}
                solid={!!colourOverride?.solid}
                onChange={applyObjectColor}
                onClear={() => applyObjectColor({ color: null })}
              />
            </div>
          )}

          {objectMode === 'scale' && selectedObjectId && !multiSelected && (
            <div style={{ marginTop: 10 }}>
              <RadialScale
                // While dragging, show the live value being dragged. Otherwise
                // always read straight from the object rather than trusting
                // the last-known scaleVal — that number can go stale the
                // moment the exact-size box (or the 3D gizmo) changes the
                // scale without going through this dial.
                value={radialDragging ? scaleVal : getSelectedUniformScale(selectedObjectId)}
                // Always hand the dial the CURRENT live scale at the instant
                // a drag starts, not whatever this component last rendered
                // with — this is the actual fix for "resizing with the exact
                // box/gizmo first, then using the ring, undoes that change".
                getValue={() => getSelectedUniformScale(selectedObjectId)}
                label="Uniform resize"
                onDragStart={(v) => {
                  dragBeforeRef.current = snapshotObject(selectedObjectId)
                  setScaleVal(v)
                  setScaleText(null)
                  setRadialDragging(true)
                }}
                onChange={(v) => {
                  setScaleVal(v)
                  setSelectedUniformScale(selectedObjectId, v)
                }}
                onCommit={() => {
                  commitUniformScale(selectedObjectId, dragBeforeRef.current)
                  dragBeforeRef.current = null
                  setRadialDragging(false)
                }}
              />

              <div className="scale-exact" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <label htmlFor="scale-exact-input" style={{ fontSize: 11, opacity: 0.8 }}>
                  Exact size
                </label>
                <input
                  id="scale-exact-input"
                  className="text-input"
                  type="number"
                  step="0.01"
                  min={MIN_UNIFORM_SCALE}
                  style={{ width: 80 }}
                  // Show whatever's mid-edit, else the live current scale —
                  // never a value stuck from before a ring drag or gizmo tweak.
                  value={scaleText ?? Number(getSelectedUniformScale(selectedObjectId).toFixed(4))}
                  title="Type an exact uniform scale factor and press Enter"
                  onFocus={() => {
                    // Snapshot for undo the moment editing starts, same as
                    // the ring's onDragStart, so typing a value is one undo
                    // step just like dragging is.
                    dragBeforeRef.current = snapshotObject(selectedObjectId)
                  }}
                  onChange={(e) => setScaleText(e.target.value)}
                  onBlur={commitExactScale}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur()
                    } else if (e.key === 'Escape') {
                      setScaleText(null)
                      dragBeforeRef.current = null
                      e.currentTarget.blur()
                    }
                  }}
                />
                <span style={{ fontSize: 11, opacity: 0.6 }}>×</span>
              </div>
            </div>
          )}

          <div className="obj-cycle">
            <button className="btn secondary" onClick={() => cycle(-1)} disabled={multiSelected} title="Previous object">
              ‹
            </button>
            <span className="obj-count">
              {multiSelected
                ? `${selectedObjectIds.length} selected`
                : selectedObjectId
                  ? `${sceneObjects.findIndex((o) => o.id === selectedObjectId) + 1} / ${sceneObjects.length}`
                  : `${sceneObjects.length} object${sceneObjects.length > 1 ? 's' : ''}`}
            </span>
            <button className="btn secondary" onClick={() => cycle(1)} disabled={multiSelected} title="Next object">
              ›
            </button>
          </div>

          <div className="obj-list">
            {sceneObjects.map((o) => {
              // Small status marks for anything that differs from the default, so a row still
              // tells you what's been changed without a button for every setting. The menu
              // (right-click, or ⋯) is where they're switched.
              const flags = []
              if (o.outline === false) flags.push(['⭕', 'Ink outline switched off for this object'])
              if (o.castShadow === false) flags.push(['🚫', 'Does not cast shadows'])
              if (o.nightImmune) flags.push(['☀️', 'Ignores Night mode (stays in daylight)'])
              if (o.shadowImmune) flags.push(['🔆', 'Never shadowed by other objects'])
              if (o.rimImmune) flags.push(['✨', 'Ignores rim lighting'])
              return (
                <div
                  key={o.id}
                  className={
                    'obj-row' +
                    (selectedObjectIds.includes(o.id) ? ' selected' : '') +
                    (multiSelected && o.id === selectedObjectId ? ' obj-row-primary' : '')
                  }
                  title={multiSelected ? o.name : o.name + ' (Shift/Ctrl-click to select more)'}
                  onContextMenu={(e) => openRowMenu(e, o)}
                  onClick={(e) => {
                    if (e.detail > 1) return // the second click of a double-click (rename) shouldn't toggle again
                    const additive = e.shiftKey || e.ctrlKey || e.metaKey
                    if (!additive && selectedObjectIds.length <= 1) {
                      // Plain click, nothing already multi-selected: keep the old
                      // "click again to deselect" toggle behaviour.
                      setSelectedObjectId(o.id === selectedObjectId ? null : o.id)
                    } else {
                      toggleObjectSelection(o.id, additive)
                    }
                  }}
                >
                  <div className="obj-row-main">
                    <RowName
                      editing={renamingId === o.id}
                      value={o.name}
                      onCommit={(name) => {
                        renameObjectById(o.id, name)
                        setRenamingId(null)
                      }}
                      onCancel={() => setRenamingId(null)}
                      onDoubleClick={() => setRenamingId(o.id)}
                    >
                      {o.name}
                    </RowName>
                    {o.isCharacter && <span className="obj-sub">character</span>}
                    {o.attachedToObjectId != null && (
                      <span className="obj-sub" title="Attached to another object — it follows it">
                        ⛓ {sceneObjects.find((p) => p.id === o.attachedToObjectId)?.name}
                      </span>
                    )}
                    {o.attachedBoneName && (
                      <span className="obj-sub" title={`Attached to the "${o.attachedBoneName}" bone`}>
                        → {o.attachedBoneName}
                      </span>
                    )}
                    {flags.length > 0 && (
                      <span className="obj-flags">
                        {flags.map(([icon, why]) => (
                          <span key={icon} title={why}>
                            {icon}
                          </span>
                        ))}
                      </span>
                    )}
                    <button
                      className="obj-eye"
                      title={o.visible === false ? 'Show' : 'Hide'}
                      onClick={(e) => {
                        e.stopPropagation()
                        setObjectVisibleById(o.id, o.visible === false)
                      }}
                    >
                      {o.visible === false ? '🙈' : '👁'}
                    </button>
                    <RowMenuButton onOpen={(e) => openRowMenuFromButton(e, o)} />
                    <button
                      className="obj-del"
                      title={o.isCharacter ? 'Delete character (Ctrl+Z to undo)' : 'Remove'}
                      onClick={(e) => {
                        e.stopPropagation()
                        confirmDeleteObject(o)
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          <p className="obj-row-hint">
            Right-click an object (or press ⋯) to rename, duplicate, change its look and shadows, attach it to a bone and more.
          </p>
          {rowMenu.element}
        </>
      )}
    </div>
  )
}