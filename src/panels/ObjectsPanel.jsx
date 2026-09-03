import { useRef, useState } from 'react'
import { useStore } from '../store.js'
import {
  addObjectFile,
  addImageFile,
  removeObjectById,
  resetObjectById,
  setObjectVisibleById,
  setObjectStyleById,
  setObjectOutlineById,
  setObjectCastShadowById,
  setObjectAttachmentById,
  getSceneData,
  applySceneData,
} from '../three/scene.js'
import {
  getSelectedUniformScale,
  setSelectedUniformScale,
  snapshotObject,
  commitUniformScale,
} from '../three/objects.js'
import RadialScale from './RadialScale.jsx'

// Side-panel section: add props / backgrounds around the character, then move,
// rotate or resize the selected one. Objects are independent of the character —
// loading a new character leaves them in place.
const MODES = [
  { value: 'translate', label: 'Move' },
  { value: 'rotate', label: 'Rotate' },
  { value: 'scale', label: 'Resize' },
]

// Per-object Look override. 'auto' means "match the character's Look panel
// settings live" — everything else pins the prop to that style regardless of
// what the character is doing.
const STYLE_OPTIONS = [
  { value: 'auto', label: 'Match scene' },
  { value: 'unlit', label: 'Flat colour' },
  { value: 'toon', label: 'Cartoon' },
  { value: 'soft', label: 'Soft Anime' },
  { value: 'standard', label: 'Realistic' },
]

export default function ObjectsPanel() {
  const modelInfo = useStore((s) => s.modelInfo)
  const boneNames = modelInfo?.bones ? modelInfo.bones.map((b) => b.name) : []
  const sceneObjects = useStore((s) => s.sceneObjects)
  const selectedObjectId = useStore((s) => s.selectedObjectId)
  const selectedObjectIds = useStore((s) => s.selectedObjectIds)
  const objectMode = useStore((s) => s.objectMode)
  const setSelectedObjectId = useStore((s) => s.setSelectedObjectId)
  const toggleObjectSelection = useStore((s) => s.toggleObjectSelection)
  const setObjectMode = useStore((s) => s.setObjectMode)
  const multiSelected = selectedObjectIds.length > 1

  const fileRef = useRef(null)
  const imageRef = useRef(null)
  const sceneRef = useRef(null)
  const dragBeforeRef = useRef(null)
  const [msg, setMsg] = useState(null)
  const [scaleVal, setScaleVal] = useState(1)
  const [radialDragging, setRadialDragging] = useState(false)
  // Text under edit in the exact-size box. Kept separate from scaleVal so
  // typing "1." or "" mid-edit doesn't get clobbered by re-renders — only
  // committed (parsed + applied) on blur/Enter.
  const [scaleText, setScaleText] = useState(null)

  function onPick(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setMsg(null)
    addObjectFile(file).catch((err) => setMsg(err.message || String(err)))
  }

  function onPickImage(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setMsg(null)
    addImageFile(file).catch((err) => setMsg(err.message || String(err)))
  }

  function onSaveScene() {
    const blob = new Blob([JSON.stringify(getSceneData(), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'scene.scene.json'
    a.click()
    URL.revokeObjectURL(url)
    setMsg('Scene layout saved.')
  }

  function onLoadScene(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    file
      .text()
      .then((text) => {
        applySceneData(JSON.parse(text))
        setMsg('Scene layout applied.')
      })
      .catch((err) => setMsg(err.message || String(err)))
  }

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
    const v = Math.max(0.01, parsed)
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
        Add props, backgrounds and reference images to place around your character.
        Shift-click or Ctrl-click several in the list below to move, rotate or resize them all together.
        Attach a prop to a bone — like a gun in a hand — to make it follow that bone through posing and animation.
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
        accept=".glb,.gltf,.fbx,model/gltf-binary,model/gltf+json"
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

      <div className="kf-actions" style={{ marginTop: 6 }}>
        <button className="btn secondary" onClick={onSaveScene} title="Save the placement of everything">
          Save scene
        </button>
        <button
          className="btn secondary"
          onClick={() => sceneRef.current?.click()}
          title="Restore a saved layout (re-add the same files first)"
        >
          Load scene
        </button>
        <input
          ref={sceneRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={onLoadScene}
        />
      </div>

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

          {multiSelected && (
            <div className="pose-msg" style={{ marginTop: 10 }}>
              {selectedObjectIds.length} objects selected — drag the 3D gizmo to{' '}
              {objectMode === 'translate' ? 'move' : objectMode === 'rotate' ? 'rotate' : 'resize'} them all together.
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
                  min="0.01"
                  style={{ width: 80 }}
                  // Show whatever's mid-edit, else the live current scale —
                  // never a value stuck from before a ring drag or gizmo tweak.
                  value={scaleText ?? Number(getSelectedUniformScale(selectedObjectId).toFixed(2))}
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
            {sceneObjects.map((o) => (
              <div
                key={o.id}
                className={
                  'obj-row' +
                  (selectedObjectIds.includes(o.id) ? ' selected' : '') +
                  (multiSelected && o.id === selectedObjectId ? ' obj-row-primary' : '')
                }
                title={multiSelected ? o.name : o.name + ' (Shift/Ctrl-click to select more)'}
                onClick={(e) => {
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
                  <span className="obj-name">{o.isCharacter ? `${o.name} (character)` : o.name}</span>
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
                  {!o.isCharacter && (
                    <button
                      className="obj-del"
                      title="Remove"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeObjectById(o.id)
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>

                {(o.kind === 'model' || (!o.isCharacter && boneNames.length > 0)) && (
                  <div className="obj-row-controls">
                    {o.kind === 'model' && (
                      <>
                        <select
                          className="select"
                          style={{ fontSize: 11, padding: '2px 4px' }}
                          title="How this prop is shaded — 'Match scene' follows the character's Look panel"
                          value={o.style || 'auto'}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setObjectStyleById(o.id, e.target.value)}
                        >
                          {STYLE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        <button
                          className="obj-eye"
                          title={o.outline ? 'Ink outline on — click to turn off' : 'No ink outline — click to turn on'}
                          onClick={(e) => {
                            e.stopPropagation()
                            setObjectOutlineById(o.id, !o.outline)
                          }}
                        >
                          {o.outline ? '✏️' : '⬜'}
                        </button>
                        <button
                          className="obj-eye"
                          title={
                            o.castShadow === false
                              ? 'Shadows off — click to cast shadows'
                              : 'Casts shadows — click to ignore shadows'
                          }
                          onClick={(e) => {
                            e.stopPropagation()
                            setObjectCastShadowById(o.id, o.castShadow === false)
                          }}
                        >
                          {o.castShadow === false ? '🚫' : '🌑'}
                        </button>
                      </>
                    )}
                    {!o.isCharacter && boneNames.length > 0 && (
                      <select
                        className="select"
                        style={{ fontSize: 11, padding: '2px 4px' }}
                        title={
                          o.attachedBoneName
                            ? `Attached to "${o.attachedBoneName}" — follows that bone. Choose another bone, or "Not attached" to detach.`
                            : 'Attach this to a bone (e.g. a gun to a hand bone) so it follows posing and animation'
                        }
                        value={o.attachedBoneName || ''}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setObjectAttachmentById(o.id, e.target.value || null)}
                      >
                        <option value="">Not attached</option>
                        {boneNames.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {selectedObjectIds.length > 0 && (
            <button
              className="btn secondary"
              style={{ marginTop: 8 }}
              onClick={() => selectedObjectIds.forEach((id) => resetObjectById(id))}
              title={
                multiSelected
                  ? 'Reset every selected object back to the origin'
                  : sceneObjects.find((o) => o.id === selectedObjectId)?.attachedBoneName
                    ? 'Reset position (relative to the bone it’s attached to)'
                    : 'Reset position'
              }
            >
              {multiSelected ? `Reset position (${selectedObjectIds.length})` : 'Reset position'}
            </button>
          )}
        </>
      )}
    </div>
  )
}