import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import {
  getProjectData,
  applyProjectData,
  clearProjectScene,
  importModelAuto,
  importBVHAuto,
  exportPNG,
  exportSceneModel,
} from '../three/scene.js'
import {
  hasFileSystemAccess,
  listRecentProjects,
  openRecentProject,
  openProjectFromDisk,
  saveProjectToHandle,
  saveProjectAs,
} from '../three/projectStore.js'
import { exportAnimationBVH } from '../three/animation.js'
import { runExportShot, canRecordVideo } from '../three/exportShot.js'
import {
  undo,
  redo,
  getPose,
  applyPose,
  resetPose,
} from '../three/posing.js'
import { undo as undoObject, redo as redoObject } from '../three/objects.js'
import { undo as undoMeshEdit, redo as redoMeshEdit } from '../three/meshedit.js'
import { resolveUndoTarget } from '../three/undoPriority.js'

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
// sync — there's only one place that actually owns the file I/O. Likewise
// video export shares exportShot.js with the Export panel.
export default function TitleBar() {
  const [openMenu, setOpenMenu] = useState(null) // 'file' | 'edit' | 'help' | null
  const [fileView, setFileView] = useState('root') // 'root' | 'import' | 'export'
  const [recents, setRecents] = useState([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const rootRef = useRef(null)
  const modelInputRef = useRef(null)
  const bvhInputRef = useRef(null)

  const current = useStore((s) => s.currentProject)
  const setCurrent = useStore((s) => s.setCurrentProject)
  const toggleHelp = useStore((s) => s.toggleHelp)
  const hasCharacter = useStore((s) => !!s.modelInfo)
  const sceneObjects = useStore((s) => s.sceneObjects)
  const hasSceneContent = hasCharacter || sceneObjects.length > 0
  const fsAccess = hasFileSystemAccess()
  const exportScale = useStore((s) => s.exportScale)
  const exportPoseMode = 'baked' // matches the Export panel's default; adjust there for other modes
  const mode = useStore((s) => s.mode)
  const poseClipboard = useStore((s) => s.poseClipboard)
  const setPoseClipboard = useStore((s) => s.setPoseClipboard)
  const canRecord = canRecordVideo()

  useEffect(() => {
    if (openMenu !== 'file') return
    listRecentProjects().then(setRecents).catch(() => setRecents([]))
  }, [openMenu])

  useEffect(() => {
    if (openMenu !== 'file') setFileView('root')
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

  // ---- File: Open / Save / Save As / Clear / Recent ----

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

  // ---- File > Import As ----
  // One picker for models: whichever file is chosen, importModelAuto (in
  // scene.js) decides character-vs-prop by whether the file has a skeleton,
  // so there's nothing to ask the user up front.
  function onPickImportModel() {
    setOpenMenu(null)
    modelInputRef.current?.click()
  }
  function onImportModelFile(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    withMenuClosed(async () => {
      const { kind, name } = await importModelAuto(file)
      setMsg(kind === 'character' ? `Imported "${name}" as a new character.` : `Imported "${name}" as an object.`)
    })
  }

  // BVH always targets the active character, using the same auto-guessed
  // bone mapping the Animate panel's mapping editor starts from (see
  // beginBVHImport/applyBVHRetarget in animation.js) — no manual mapping
  // step here, so this is best for a rig that already matches common bone
  // naming. For fine control over the mapping, use Animate > Import BVH.
  function onPickImportBVH() {
    setOpenMenu(null)
    bvhInputRef.current?.click()
  }
  function onImportBVHFile(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    withMenuClosed(async () => {
      const { name, matched, total } = await importBVHAuto(file)
      setMsg(`Imported "${name}" (${matched}/${total} bones auto-matched) and selected it as the active clip.`)
    })
  }

  // ---- File > Export As ----

  const name = useStore.getState().modelInfo?.name || 'render'

  const onExportPNG = () =>
    withMenuClosed(async () => {
      exportPNG(exportScale, name)
      setMsg(`Saved a ${exportScale}× PNG.`)
    })

  const onExportModel = (format) =>
    withMenuClosed(async () => {
      const result = await exportSceneModel(format, name, exportPoseMode)
      setMsg(result.message)
    })

  const onExportBVH = () =>
    withMenuClosed(async () => {
      const s = useStore.getState()
      const text = exportAnimationBVH(s.animData, s.animFps, s.animDuration, s.activeClipName, s.playbackSource)
      if (!text) {
        setMsg('Nothing to export — make an in-app animation first.')
        return
      }
      const blob = new Blob([text], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${name}.bvh`
      a.click()
      URL.revokeObjectURL(url)
      setMsg('Animation exported as .bvh.')
    })

  const onExportVideo = () =>
    withMenuClosed(async () => {
      runExportShot({ record: true, name, onStatus: setMsg })
    })

  // ---- Edit: Undo/Redo (context-aware, same priority as Ctrl+Z in the
  // viewport) + pose Copy/Paste/Cut. Object/mesh-level copy-paste isn't
  // built yet — only pose copy/paste exists today (see BonePanel), so those
  // are the ones exposed here for now. ----

  function onUndo() {
    setOpenMenu(null)
    const target = resolveUndoTarget(useStore.getState())
    if (target === 'object') undoObject()
    else if (target === 'mesh') undoMeshEdit()
    else undo()
  }

  function onRedo() {
    setOpenMenu(null)
    const target = resolveUndoTarget(useStore.getState())
    if (target === 'object') redoObject()
    else if (target === 'mesh') redoMeshEdit()
    else redo()
  }

  function onCopyPose() {
    setOpenMenu(null)
    setPoseClipboard(getPose())
    setMsg('Pose copied.')
  }

  function onPastePose() {
    setOpenMenu(null)
    if (!poseClipboard) return
    const { applied, missing } = applyPose(poseClipboard)
    setMsg(`Pasted ${applied} bone(s)` + (missing.length ? `, ${missing.length} skipped.` : '.'))
  }

  function onCutPose() {
    setOpenMenu(null)
    setPoseClipboard(getPose())
    resetPose()
    setMsg('Pose cut (copied, then reset to rest).')
  }

  const poseToolsAvailable = hasCharacter && mode === 'bone'

  return (
    <div className="titlebar" ref={rootRef}>
      <input ref={modelInputRef} type="file" accept=".glb,.gltf,.fbx" style={{ display: 'none' }} onChange={onImportModelFile} />
      <input ref={bvhInputRef} type="file" accept=".bvh" style={{ display: 'none' }} onChange={onImportBVHFile} />

      <div className="titlebar-brand">
        <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="titlebar-logo" />
      </div>

      <div className="titlebar-menu">
        <div className="titlebar-menu-item">
          <button
            className={'titlebar-menu-btn' + (openMenu === 'file' ? ' active' : '')}
            onClick={() => toggleMenu('file')}
            disabled={busy}
          >
            File
          </button>
          {openMenu === 'file' && fileView === 'root' && (
            <div className="titlebar-dropdown" role="menu">
              <button role="menuitem" onClick={onOpen}>Open Project…</button>
              <button role="menuitem" onClick={onSave} disabled={!hasSceneContent && !current}>Save</button>
              <button role="menuitem" onClick={onSaveAs} disabled={!hasSceneContent && !current}>Save As…</button>
              <button role="menuitem" onClick={onClear} disabled={!hasSceneContent}>Clear</button>
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={() => setFileView('import')}>Import As… ▸</button>
              <button role="menuitem" onClick={() => setFileView('export')} disabled={!hasSceneContent}>Export As… ▸</button>
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
          {openMenu === 'file' && fileView === 'import' && (
            <div className="titlebar-dropdown" role="menu">
              <button role="menuitem" onClick={() => setFileView('root')}>◂ Back</button>
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={onPickImportModel} title="Rigged files (with bones) come in as a new character; everything else as an object">
                Import Model… (.glb/.gltf/.fbx)
              </button>
              <button role="menuitem" onClick={onPickImportBVH} disabled={!hasCharacter} title={hasCharacter ? 'Applies to the active character, using the best-guess bone mapping' : 'Load a character first'}>
                Import Animation… (.bvh)
              </button>
            </div>
          )}
          {openMenu === 'file' && fileView === 'export' && (
            <div className="titlebar-dropdown" role="menu">
              <button role="menuitem" onClick={() => setFileView('root')}>◂ Back</button>
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={onExportPNG}>Image (.png)</button>
              <button role="menuitem" onClick={() => onExportModel('glb')}>Scene model (.glb)</button>
              <button role="menuitem" onClick={() => onExportModel('gltf')}>Scene model (.gltf)</button>
              <button role="menuitem" onClick={onExportBVH}>Animation (.bvh)</button>
              <button role="menuitem" onClick={onExportVideo} disabled={!canRecord} title={canRecord ? undefined : 'Not supported in this browser'}>
                Video (.webm)
              </button>
              <div className="titlebar-dropdown-sep" />
              <div className="titlebar-dropdown-label">Three.js can't write .fbx — export .glb and re-export from Blender if you need it</div>
            </div>
          )}
        </div>

        <div className="titlebar-menu-item">
          <button
            className={'titlebar-menu-btn' + (openMenu === 'edit' ? ' active' : '')}
            onClick={() => toggleMenu('edit')}
          >
            Edit
          </button>
          {openMenu === 'edit' && (
            <div className="titlebar-dropdown" role="menu">
              <button role="menuitem" onClick={onUndo}>Undo</button>
              <button role="menuitem" onClick={onRedo}>Redo</button>
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={onCopyPose} disabled={!poseToolsAvailable} title={poseToolsAvailable ? "Copy the active character's current pose" : 'Switch to Pose mode with a character loaded'}>
                Copy Pose
              </button>
              <button role="menuitem" onClick={onCutPose} disabled={!poseToolsAvailable}>Cut Pose</button>
              <button role="menuitem" onClick={onPastePose} disabled={!poseToolsAvailable || !poseClipboard}>Paste Pose</button>
              <div className="titlebar-dropdown-sep" />
              <div className="titlebar-dropdown-label">Object/mesh copy-paste isn't built yet</div>
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