import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import {
  loadModelFile,
  disposeCurrentModel,
  setActiveCharacter,
  removeCharacter,
  getProjectData,
  applyProjectData,
} from '../three/scene.js'
import {
  hasFileSystemAccess,
  requestPersistentStorage,
  listRecentProjects,
  removeRecentProject,
  openRecentProject,
  openProjectFromDisk,
  openProjectFromFileObject,
  saveProjectToHandle,
  saveProjectAs,
} from '../three/projectStore.js'

// Combined side-panel section: everything to do with "where does my character
// come from" lives here.
//   1. A model file straight off disk (.glb/.gltf/.fbx) — any number of
//      characters can be loaded at once and switched between.
//   2. The project file itself (whole session — model, props, poses, style),
//      handled the way Blender / Clip Studio Paint handle documents: it
//      lives as a real file on disk, "Save" writes back to that same file,
//      and a Recent Projects list gives one-click access to what you had
//      open before. There's no separate in-browser save slot to keep track
//      of any more — a project either is a file on disk, or it hasn't been
//      saved yet.
export default function ProjectPanel() {
  const fileInputRef = useRef(null)
  const addFileInputRef = useRef(null)
  const openProjectInputRef = useRef(null)
  const modelInfo = useStore((s) => s.modelInfo)
  const loading = useStore((s) => s.loading)
  const loadError = useStore((s) => s.loadError)
  const characters = useStore((s) => s.characters)
  const characterOrder = useStore((s) => s.characterOrder)
  const activeCharacterId = useStore((s) => s.activeCharacterId)

  // Merge the active character's live (flattened) fields with the cached
  // snapshots of every inactive one, so the roster can show a name for each.
  const roster = characterOrder.map((id) => ({
    id,
    info: id === activeCharacterId ? modelInfo : characters[id]?.modelInfo,
  }))

  // The project currently "open" — mirrors Blender's notion of the current
  // .blend file. `handle` is the FileSystemFileHandle to write straight
  // back to on "Save" (null until you've opened or saved-as a real file,
  // or in browsers without File System Access support).
  const [current, setCurrent] = useState(null) // { name, handle }
  const [recents, setRecents] = useState([])
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const fsAccess = hasFileSystemAccess()

  async function refreshRecents() {
    try {
      setRecents(await listRecentProjects())
    } catch {
      /* IndexedDB unavailable (e.g. private mode) — leave the list empty */
    }
  }
  useEffect(() => {
    refreshRecents()
    // Ask the browser not to silently wipe our IndexedDB data (which now
    // only holds the recent-files list and, on supporting browsers, file
    // handles) under disk pressure. Best-effort — see the note in
    // projectStore.js.
    requestPersistentStorage()
  }, [])

  function onPickModel(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (file) loadModelFile(file).catch(() => {})
  }

  function onPickAddModel(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (file) loadModelFile(file, { addNew: true }).catch(() => {})
  }

  function confirmDeleteCharacter(id) {
    const info = roster.find((character) => character.id === id)?.info
    if (!window.confirm(`Are you sure you want to delete this character${info?.name ? ` "${info.name}"` : ''}?`)) return
    removeCharacter(id)
  }

  // ---- Open ----

  async function onOpen() {
    setBusy(true)
    setMsg(null)
    try {
      if (fsAccess) {
        const { record, handle, name } = await openProjectFromDisk()
        await applyProjectData(record)
        setCurrent({ name, handle })
        setMsg(`Opened “${name}”.`)
        refreshRecents()
      } else {
        openProjectInputRef.current?.click()
      }
    } catch (e) {
      if (e?.name !== 'AbortError') setMsg('Open failed: ' + (e.message || String(e)))
    } finally {
      setBusy(false)
    }
  }

  function onPickOpenFile(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (file) onOpenFileObject(file)
  }

  async function onOpenFileObject(file) {
    setBusy(true)
    setMsg(null)
    try {
      const { record, handle, name } = await openProjectFromFileObject(file)
      await applyProjectData(record)
      setCurrent({ name, handle })
      setMsg(`Opened “${name}”. This browser can't write back to disk automatically — "Save" will ask where to save.`)
      refreshRecents()
    } catch (e) {
      setMsg('Open failed: ' + (e.message || String(e)))
    } finally {
      setBusy(false)
    }
  }

  async function onOpenRecent(recent) {
    setBusy(true)
    setMsg(null)
    try {
      const { record, handle, name } = await openRecentProject(recent)
      await applyProjectData(record)
      setCurrent({ name, handle })
      setMsg(`Opened “${name}”.`)
      refreshRecents()
    } catch (e) {
      setMsg('Could not reopen that file: ' + (e.message || String(e)))
    } finally {
      setBusy(false)
    }
  }

  async function onRemoveRecent(id, e) {
    e.stopPropagation()
    try {
      await removeRecentProject(id)
      refreshRecents()
    } catch {
      /* ignore */
    }
  }

  // ---- Save / Save As ----

  async function onSave() {
    setBusy(true)
    setMsg(null)
    try {
      const data = getProjectData()
      if (current?.handle) {
        // Same spot on disk you opened/last saved to — no dialog, just like
        // Ctrl+S in Blender or Clip Studio Paint.
        const { name } = await saveProjectToHandle(current.handle, { name: current.name, ...data })
        setCurrent((c) => ({ ...c, name }))
        setMsg(`Saved “${name}”.`)
      } else {
        // Nothing open yet — first save always needs a location.
        const { handle, name } = await saveProjectAs(
          { name: current?.name || 'Untitled', ...data },
          current?.name
        )
        setCurrent({ name, handle })
        setMsg(`Saved “${name}”.`)
      }
      refreshRecents()
    } catch (e) {
      if (e?.name !== 'AbortError') setMsg('Save failed: ' + (e.message || String(e)))
    } finally {
      setBusy(false)
    }
  }

  async function onSaveAs() {
    setBusy(true)
    setMsg(null)
    try {
      const data = getProjectData()
      const { handle, name } = await saveProjectAs(
        { name: current?.name || 'Untitled', ...data },
        current?.name
      )
      setCurrent({ name, handle })
      setMsg(`Saved “${name}”.`)
      refreshRecents()
    } catch (e) {
      if (e?.name !== 'AbortError') setMsg('Save failed: ' + (e.message || String(e)))
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
          {loading ? 'Loading…' : modelInfo ? 'Replace active character (.glb / .gltf / .fbx)' : '＋ Load character (.glb / .gltf / .fbx)'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".glb,.gltf,.fbx,model/gltf-binary,model/gltf+json"
          style={{ display: 'none' }}
          onChange={onPickModel}
        />

        {modelInfo && (
          <>
            <button
              className="btn"
              style={{ marginTop: 8 }}
              onClick={() => addFileInputRef.current?.click()}
              disabled={loading}
            >
              {loading ? 'Loading…' : '＋ Add another character'}
            </button>
            <input
              ref={addFileInputRef}
              type="file"
              accept=".glb,.gltf,.fbx,model/gltf-binary,model/gltf+json"
              style={{ display: 'none' }}
              onChange={onPickAddModel}
            />
          </>
        )}

        {!modelInfo && !loadError && (
          <div className="dropzone">…or drag a file straight onto the viewport</div>
        )}
        {loadError && <div className="error">{loadError}</div>}

        {roster.length > 1 && (
          <div className="obj-list" style={{ marginTop: 10 }}>
            {roster.map(({ id, info }) => (
              <div
                key={id}
                className="obj-row"
                style={{ fontWeight: id === activeCharacterId ? 600 : 400, cursor: 'pointer' }}
                onClick={() => setActiveCharacter(id)}
              >
                <div className="obj-row-main">
                  <span className="obj-name">
                    {id === activeCharacterId ? '● ' : '○ '}
                    {info?.name || id}
                  </span>
                  <button
                    className="obj-del"
                    title="Delete character"
                    onClick={(e) => {
                      e.stopPropagation()
                      confirmDeleteCharacter(id)
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

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
            <button
              className="btn secondary btn-tiny"
              style={{ marginTop: 8 }}
              onClick={() => {
                if (!window.confirm('Are you sure you want to delete this character?')) return
                characterOrder.length > 1 ? removeCharacter(activeCharacterId) : disposeCurrentModel()
              }}
            >
              {characterOrder.length > 1 ? 'Remove active character' : 'Unload'}
            </button>
          </div>
        )}
      </div>

      {/* ---- Source 2: the project file ---- */}
      <div className="subpanel">
        <div className="subpanel-head">
          <span className="subpanel-title">Project</span>
          {current && <span className="subpanel-count" title={current.name}>{current.name}</span>}
        </div>
        <p className="panel-hint">
          A project remembers everything — model, props, images, poses and
          style — as one file on disk. Open picks a file up, Save writes
          straight back to it, Save As lets you pick a new spot.
          {!fsAccess && ' Your browser can open project files but can\'t write back to the same spot automatically, so Save will ask where to put the file each time.'}
        </p>

        <div className="proj-save" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={onOpen} disabled={busy}>
            {loading || busy ? 'Working…' : 'Open Project…'}
          </button>
          <input
            ref={openProjectInputRef}
            type="file"
            accept=".3dcp,application/json"
            style={{ display: 'none' }}
            onChange={onPickOpenFile}
          />
          <button className="btn" onClick={onSave} disabled={busy} title="Save back to the currently open file (or choose one, if none is open yet)">
            Save
          </button>
          <button className="btn secondary" onClick={onSaveAs} disabled={busy} title="Save to a new file / location">
            Save As…
          </button>
        </div>

        {msg && <div className="pose-msg">{msg}</div>}

        <div style={{ marginTop: 14 }}>
          <div className="subpanel-head">
            <span className="subpanel-title">Recent Projects</span>
            <span className="subpanel-count">{recents.length}</span>
          </div>

          {recents.length === 0 ? (
            <div className="empty" style={{ marginTop: 10 }}>
              Nothing opened or saved yet — projects you open or save will
              show up here for quick access.
            </div>
          ) : (
            <div className="proj-grid">
              {recents.map((r) => (
                <div
                  key={r.id}
                  className="proj-card"
                  title={savedLabel(r.savedAt)}
                  style={{ cursor: r.handle ? 'pointer' : 'default' }}
                  onClick={() => r.handle && onOpenRecent(r)}
                >
                  <div className="proj-card-thumb" aria-hidden="true">🧍</div>
                  <div className="proj-card-body">
                    <span className="proj-card-name">{r.name}</span>
                    <span className="proj-card-date">
                      {savedLabel(r.savedAt)}
                      {!r.handle && ' · reopen via "Open Project…"'}
                    </span>
                  </div>
                  <div className="proj-card-actions">
                    {r.handle && (
                      <button
                        className="btn btn-tiny"
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenRecent(r)
                        }}
                        disabled={busy}
                        title="Open this project"
                      >
                        Open
                      </button>
                    )}
                    <button
                      className="obj-del"
                      title="Remove from recent list (does not delete the file)"
                      onClick={(e) => onRemoveRecent(r.id, e)}
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
    </div>
  )
}

function savedLabel(savedAt) {
  if (!savedAt) return ''
  try {
    return new Date(savedAt).toLocaleString()
  } catch {
    return ''
  }
}