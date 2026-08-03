import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import { loadModelFile, disposeCurrentModel, getProjectData, applyProjectData } from '../three/scene.js'
import {
  saveProject,
  listProjects,
  loadProjectRecord,
  deleteProject,
} from '../three/projectStore.js'

// Combined side-panel section: everything to do with "where does my character
// come from" lives here. Two clear, always-visible sources to load from:
//   1. A model file straight off disk (.glb/.gltf/.fbx)
//   2. A previously saved project (whole session — model, props, poses, style)
// Previously these were two separate panels; merging them means there's one
// obvious place to look when you want to get a character on screen.
export default function ProjectPanel() {
  const fileInputRef = useRef(null)
  const modelInfo = useStore((s) => s.modelInfo)
  const loading = useStore((s) => s.loading)
  const loadError = useStore((s) => s.loadError)

  const [name, setName] = useState('')
  const [projects, setProjects] = useState([])
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      setProjects(await listProjects())
    } catch {
      /* IndexedDB unavailable (e.g. private mode) — leave the list empty */
    }
  }
  useEffect(() => {
    refresh()
  }, [])

  function onPickModel(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (file) loadModelFile(file).catch(() => {})
  }

  async function onSave() {
    const n = name.trim()
    if (!n) {
      setMsg('Type a name for this project first.')
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const data = getProjectData()
      await saveProject({ name: n, savedAt: Date.now(), ...data })
      setMsg(`Saved “${n}”.`)
      refresh()
    } catch (e) {
      setMsg('Save failed: ' + (e.message || String(e)))
    } finally {
      setBusy(false)
    }
  }

  async function onLoad(n) {
    setBusy(true)
    setMsg(null)
    try {
      const rec = await loadProjectRecord(n)
      if (!rec) {
        setMsg('That project could not be found.')
        return
      }
      await applyProjectData(rec)
      setName(n)
      setMsg(`Loaded “${n}”.`)
    } catch (e) {
      setMsg('Load failed: ' + (e.message || String(e)))
    } finally {
      setBusy(false)
    }
  }

  async function onDelete(n) {
    setBusy(true)
    try {
      await deleteProject(n)
      if (name === n) setName('')
      refresh()
    } catch (e) {
      setMsg('Delete failed: ' + (e.message || String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel-stack">
      {/* ---- Source 1: a model file ---- */}
      <div className="subpanel">
        <div className="subpanel-head">
          <span className="subpanel-title">Load from a file</span>
          <span className="subpanel-dot" />
        </div>

        <button
          className="btn load-cta"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading}
        >
          {loading ? 'Loading…' : modelInfo ? 'Replace character (.glb / .gltf / .fbx)' : '＋ Load character (.glb / .gltf / .fbx)'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".glb,.gltf,.fbx,model/gltf-binary,model/gltf+json"
          style={{ display: 'none' }}
          onChange={onPickModel}
        />

        {!modelInfo && !loadError && (
          <div className="dropzone">…or drag a file straight onto the viewport</div>
        )}
        {loadError && <div className="error">{loadError}</div>}

        {modelInfo && (
          <div className="model-card">
            <div className="info-row">
              <span className="label">Name</span>
              <span className="value">{modelInfo.name}</span>
            </div>
            <div className="model-card-stats">
              {modelInfo.format && <span className="chip">{modelInfo.format.toUpperCase()}</span>}
              <span className="chip">{modelInfo.meshCount} mesh{modelInfo.meshCount === 1 ? '' : 'es'}</span>
              <span className="chip">{modelInfo.boneCount} bones</span>
              <span className="chip">{modelInfo.clipNames.length} clips</span>
            </div>
            <button className="btn secondary btn-tiny" style={{ marginTop: 8 }} onClick={() => disposeCurrentModel()}>
              Unload
            </button>
          </div>
        )}
      </div>

      {/* ---- Source 2: saved projects ---- */}
      <div className="subpanel">
        <div className="subpanel-head">
          <span className="subpanel-title">Saved projects</span>
          <span className="subpanel-count">{projects.length}</span>
        </div>
        <p className="panel-hint">
          A project remembers everything — model, props, images, poses and style —
          so it reloads exactly how you left it. Saved in this browser.
        </p>

        <div className="proj-save">
          <input
            className="text-input"
            type="text"
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSave()
            }}
          />
          <button className="btn" onClick={onSave} disabled={busy}>
            Save all
          </button>
        </div>

        {msg && <div className="pose-msg">{msg}</div>}

        {projects.length === 0 ? (
          <div className="empty" style={{ marginTop: 10 }}>
            No saved projects yet — save your current session above once you
            have a character you like.
          </div>
        ) : (
          <div className="proj-grid">
            {projects.map((p) => (
              <div key={p.name} className="proj-card" title={savedLabel(p.savedAt)}>
                <div className="proj-card-thumb" aria-hidden="true">🧍</div>
                <div className="proj-card-body">
                  <span className="proj-card-name">{p.name}</span>
                  <span className="proj-card-date">{savedLabel(p.savedAt)}</span>
                </div>
                <div className="proj-card-actions">
                  <button
                    className="btn btn-tiny"
                    onClick={() => onLoad(p.name)}
                    disabled={busy}
                    title="Replace the current session with this project"
                  >
                    Load
                  </button>
                  <button
                    className="obj-del"
                    title="Delete this project"
                    onClick={() => onDelete(p.name)}
                    disabled={busy}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function savedLabel(savedAt) {
  if (!savedAt) return ''
  try {
    return 'Saved ' + new Date(savedAt).toLocaleString()
  } catch {
    return ''
  }
}