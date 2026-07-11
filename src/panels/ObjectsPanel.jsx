import { useRef, useState } from 'react'
import { useStore } from '../store.js'
import {
  addObjectFile,
  removeObjectById,
  resetObjectById,
  getSceneData,
  applySceneData,
} from '../three/scene.js'

// Side-panel section: add props / backgrounds around the character, then move,
// rotate or resize the selected one. Objects are independent of the character —
// loading a new character leaves them in place.
const MODES = [
  { value: 'translate', label: 'Move' },
  { value: 'rotate', label: 'Rotate' },
  { value: 'scale', label: 'Resize' },
]

export default function ObjectsPanel() {
  const sceneObjects = useStore((s) => s.sceneObjects)
  const selectedObjectId = useStore((s) => s.selectedObjectId)
  const objectMode = useStore((s) => s.objectMode)
  const setSelectedObjectId = useStore((s) => s.setSelectedObjectId)
  const setObjectMode = useStore((s) => s.setObjectMode)

  const fileRef = useRef(null)
  const sceneRef = useRef(null)
  const [msg, setMsg] = useState(null)

  function onPick(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setMsg(null)
    addObjectFile(file).catch((err) => setMsg(err.message || String(err)))
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
        Add props and backgrounds to place around your character.
      </p>

      <button className="btn" onClick={() => fileRef.current?.click()}>
        + Add object
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".glb,.gltf,.fbx,model/gltf-binary,model/gltf+json"
        style={{ display: 'none' }}
        onChange={onPick}
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

          <div className="obj-cycle">
            <button className="btn secondary" onClick={() => cycle(-1)} title="Previous object">
              ‹
            </button>
            <span className="obj-count">
              {selectedObjectId
                ? `${sceneObjects.findIndex((o) => o.id === selectedObjectId) + 1} / ${sceneObjects.length}`
                : `${sceneObjects.length} object${sceneObjects.length > 1 ? 's' : ''}`}
            </span>
            <button className="btn secondary" onClick={() => cycle(1)} title="Next object">
              ›
            </button>
          </div>

          <div className="obj-list">
            {sceneObjects.map((o) => (
              <div
                key={o.id}
                className={'obj-row' + (o.id === selectedObjectId ? ' selected' : '')}
                title={o.name}
                onClick={() => setSelectedObjectId(o.id === selectedObjectId ? null : o.id)}
              >
                <span className="obj-name">
                  {o.isCharacter ? `${o.name} (character)` : o.name}
                </span>
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
            ))}
          </div>

          {selectedObjectId && (
            <button
              className="btn secondary"
              style={{ marginTop: 8 }}
              onClick={() => resetObjectById(selectedObjectId)}
            >
              Reset position
            </button>
          )}
        </>
      )}
    </div>
  )
}
