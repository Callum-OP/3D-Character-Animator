import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import { getProjectData, applyProjectData, clearProjectScene } from '../three/scene.js'
import {
  hasFileSystemAccess,
  listRecentProjects,
  openRecentProject,
  openProjectFromDisk,
  saveProjectToHandle,
  saveProjectAs,
} from '../three/projectStore.js'

// A VS Code-style menu row that sits above the viewport/sidebar and shares
// the same window-drag strip as the native minimize/maximize/close buttons
// (drawn by Electron's titleBarOverlay — see electron/main.cjs). The row
// itself is `-webkit-app-region: drag` so it still drags the window; each
// interactive bit (menu buttons, their dropdown items) is carved out with
// `no-drag`, exactly the pattern VS Code and Windows Terminal use.
//
// It reuses the exact same project-file functions as ProjectPanel.jsx and
// shares its "current open file" via the store's currentProject field, so
// opening from here and saving from the sidebar (or vice versa) stay in
// sync — there's only one place that actually owns the file I/O.
export default function TitleBar() {
  const [openMenu, setOpenMenu] = useState(null) // 'file' | 'help' | null
  const [recents, setRecents] = useState([])
  const [busy, setBusy] = useState(false)
  const rootRef = useRef(null)

  const current = useStore((s) => s.currentProject)
  const setCurrent = useStore((s) => s.setCurrentProject)
  const toggleHelp = useStore((s) => s.toggleHelp)
  const hasCharacter = useStore((s) => !!s.modelInfo)
  const sceneObjects = useStore((s) => s.sceneObjects)
  const hasSceneContent = hasCharacter || sceneObjects.length > 0
  const fsAccess = hasFileSystemAccess()
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    if (openMenu !== 'file') return
    listRecentProjects().then(setRecents).catch(() => setRecents([]))
  }, [openMenu])

  useEffect(() => {
    if (!msg) return
    const t = setTimeout(() => setMsg(null), 5000)
    return () => clearTimeout(t)
  }, [msg])

  // Close on outside click / Escape, same as any menu bar.
  useEffect(() => {
    if (!openMenu) return
    function onDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpenMenu(null)
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpenMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

  function toggleMenu(name) {
    setOpenMenu((m) => (m === name ? null : name))
  }

  async function withMenuClosed(fn) {
    setOpenMenu(null)
    setBusy(true)
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      if (e?.name !== 'AbortError') setMsg(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const onOpen = () =>
    withMenuClosed(async () => {
      if (!fsAccess) {
        setMsg('Use "Open Project…" in the sidebar — this browser needs the file-picker fallback there.')
        return
      }
      const { record, handle, name } = await openProjectFromDisk()
      await applyProjectData(record)
      setCurrent({ name, handle })
    })

  const onOpenRecentFile = (recent) =>
    withMenuClosed(async () => {
      const { record, handle, name } = await openRecentProject(recent)
      await applyProjectData(record)
      setCurrent({ name, handle })
    })

  const onSave = () =>
    withMenuClosed(async () => {
      const data = getProjectData()
      if (current?.handle) {
        const { name } = await saveProjectToHandle(current.handle, { name: current.name, ...data })
        setCurrent((c) => ({ ...c, name }))
      } else {
        const { handle, name } = await saveProjectAs({ name: current?.name || 'Untitled', ...data }, current?.name)
        setCurrent({ name, handle })
      }
    })

  const onSaveAs = () =>
    withMenuClosed(async () => {
      const data = getProjectData()
      const { handle, name } = await saveProjectAs({ name: current?.name || 'Untitled', ...data }, current?.name)
      setCurrent({ name, handle })
    })

  const onClear = () =>
    withMenuClosed(async () => {
      if (!window.confirm('Clear the current scene? Anything unsaved will be lost.')) return
      clearProjectScene()
      setCurrent(null)
    })

  return (
    <div className="titlebar" ref={rootRef}>
      <div className="titlebar-menu">
        <div className="titlebar-menu-item">
          <button
            className={'titlebar-menu-btn' + (openMenu === 'file' ? ' active' : '')}
            onClick={() => toggleMenu('file')}
            disabled={busy}
          >
            File
          </button>
          {openMenu === 'file' && (
            <div className="titlebar-dropdown" role="menu">
              <button role="menuitem" onClick={onOpen}>Open Project…</button>
              <button role="menuitem" onClick={onSave} disabled={!hasSceneContent && !current}>Save</button>
              <button role="menuitem" onClick={onSaveAs} disabled={!hasSceneContent && !current}>Save As…</button>
              <button role="menuitem" onClick={onClear} disabled={!hasSceneContent}>Clear</button>
              {recents.length > 0 && (
                <>
                  <div className="titlebar-dropdown-sep" />
                  <div className="titlebar-dropdown-label">Recent Projects</div>
                  {recents.map((r) => (
                    <button
                      key={r.id}
                      role="menuitem"
                      disabled={!r.handle}
                      title={r.handle ? r.name : `${r.name} — reopen via "Open Project…"`}
                      onClick={() => onOpenRecentFile(r)}
                    >
                      {r.name}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        <div className="titlebar-menu-item">
          <button
            className={'titlebar-menu-btn' + (openMenu === 'help' ? ' active' : '')}
            onClick={() => toggleMenu('help')}
          >
            Help
          </button>
          {openMenu === 'help' && (
            <div className="titlebar-dropdown" role="menu">
              <button role="menuitem" onClick={() => { setOpenMenu(null); toggleHelp() }}>Help &amp; Shortcuts (?)</button>
              <div className="titlebar-dropdown-sep" />
              <div className="titlebar-dropdown-label">Animare 3D Animator</div>
            </div>
          )}
        </div>
      </div>

      {/* Empty drag strip: lets the window be dragged from anywhere along the
          bar that isn't a menu button, and leaves clear space under the
          native minimize/maximize/close overlay on the right. */}
      <div className="titlebar-drag-fill" />

      {msg && <div className="titlebar-msg">{msg}</div>}
    </div>
  )
}