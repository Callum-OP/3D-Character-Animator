import { useEffect, useState } from 'react'
import { getProjectData, applyProjectData } from '../three/scene.js'
import {
  saveProject,
  listProjects,
  loadProjectRecord,
  deleteProject,
} from '../three/projectStore.js'

// Side-panel section: save the WHOLE session (model, props, reference images,
// pose/keyframe sequence and style settings) under a name, then load or delete
// saved projects later. Everything is stored in the browser via IndexedDB — the
// actual model/image files are kept, so a project reloads exactly as it was.
export default function ProjectPanel() {
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
    <div className="panel">
      <h2>Projects</h2>
      <p className="panel-hint">
        Save everything — model, objects, images, poses and style — under a name,
        then reload it any time. Stored in this browser.
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
          No saved projects yet.
        </div>
      ) : (
        <div className="obj-list">
          {projects.map((p) => (
            <div key={p.name} className="obj-row" title={savedLabel(p.savedAt)}>
              <span className="obj-name">{p.name}</span>
              <button
                className="btn secondary btn-tiny"
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
          ))}
        </div>
      )}
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
