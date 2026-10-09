import { PRIVACY_POLICY_URL } from '../links.js'
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
  setObjectVisibleById,
  playAllCharacters,
  stopAllCharacters,
  startGlobalClock,
  getAllTimelineDuration,
} from '../three/scene.js'
import {
  hasFileSystemAccess,
  listRecentProjects,
  openRecentProject,
  openProjectFromDisk,
  openProjectFromFileObject,
  saveProjectToHandle,
  saveProjectAs,
} from '../three/projectStore.js'
import { pickFileWithInput } from '../three/fsAccess.js'
import { exportAnimationBVH, play, pause, stop, selectClip, selectEdit } from '../three/animation.js'
import { runExportShot, canRecordVideo } from '../three/exportShot.js'
import {
  getPose,
  applyPose,
  resetPose,
} from '../three/posing.js'
import { startObjectAnimation, stopObjectAnimation } from '../three/objects.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import {
  canCopyCurrentEdit,
  canPasteCurrentEdit,
  copyCurrentEdit,
  pasteCurrentEdit,
  toggleCurrentVisibility,
} from '../three/editClipboard.js'

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
export default function TitleBar({ onOpenSettings }) {
  const [openMenu, setOpenMenu] = useState(null) // 'file' | 'edit' | 'animation' | 'help' | null
  const [fileView, setFileView] = useState('root') // 'root' | 'import' | 'export'
  const [recents, setRecents] = useState([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const rootRef = useRef(null)
  const modelInputRef = useRef(null)
  const bvhInputRef = useRef(null)

  const current = useStore((s) => s.currentProject)
  const setCurrent = useStore((s) => s.setCurrentProject)
  const setLastProjectSave = useStore((s) => s.setLastProjectSave)
  const toggleHelp = useStore((s) => s.toggleHelp)
  const hasCharacter = useStore((s) => !!s.modelInfo)
  const sceneObjects = useStore((s) => s.sceneObjects)
  const hasObjectAnimation = useStore(
    (s) =>
      Object.values(s.objectAnimData || {}).some((keys) => keys && keys.length) ||
      Object.values(s.objectAttachmentData || {}).some((track) => track?.keys?.length),
  )
  const hasSceneContent = hasCharacter || sceneObjects.length > 0
  const fsAccess = hasFileSystemAccess()
  const exportScale = useStore((s) => s.exportScale)
  const exportPoseMode = 'baked' // matches the Export panel's default; adjust there for other modes
  const mode = useStore((s) => s.mode)
  const selectedObjectId = useStore((s) => s.selectedObjectId)
  const selectedMeshUuid = useStore((s) => s.selectedMeshUuid)
  const meshOverrides = useStore((s) => s.meshOverrides)
  const poseClipboard = useStore((s) => s.poseClipboard)
  const setPoseClipboard = useStore((s) => s.setPoseClipboard)
  const playback = useStore((s) => s.playback)
  const playbackSource = useStore((s) => s.playbackSource)
  const activeClipName = useStore((s) => s.activeClipName)
  const loop = useStore((s) => s.loop)
  const speed = useStore((s) => s.speed)
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

  // ---- File: New Project / Open / Save / Save As / Recent ----

  const onOpen = () =>
    withMenuClosed(async () => {
      let opened
      if (fsAccess) {
        try {
          opened = await openProjectFromDisk()
        } catch (e) {
          // Picker refused by the browser (e.g. embedded on itch.io): use a plain file chooser.
          if (e?.message !== 'FILE_SYSTEM_ACCESS_UNAVAILABLE') throw e
        }
      }
      if (!opened) {
        const file = await pickFileWithInput('.3dcp,application/json')
        if (!file) return
        opened = await openProjectFromFileObject(file)
      }
      await applyProjectData(opened.record)
      setCurrent({ name: opened.name, handle: opened.handle })
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
        const { name, savedAt } = await saveProjectToHandle(current.handle, { name: current.name, ...data })
        setCurrent((c) => ({ ...c, name }))
        setLastProjectSave({ name, savedAt })
      } else {
        const { handle, name, savedAt } = await saveProjectAs({ name: current?.name || 'Untitled', ...data }, current?.name)
        setCurrent({ name, handle })
        setLastProjectSave({ name, savedAt })
      }
    })

  const onSaveAs = () =>
    withMenuClosed(async () => {
      const data = getProjectData()
      const { handle, name, savedAt } = await saveProjectAs({ name: current?.name || 'Untitled', ...data }, current?.name)
      setCurrent({ name, handle })
      setLastProjectSave({ name, savedAt })
    })

  const onNewProject = () =>
    withMenuClosed(async () => {
      if (!window.confirm('Start a new project? Anything unsaved will be lost.')) return
      clearProjectScene()
      setCurrent(null)
    })

  function onPlay() {
    setOpenMenu(null)
    const s = useStore.getState()
    if (playbackSource === 'edit') {
      s.setDuration(selectEdit(s.animData, s.animDuration, { loop, speed }))
    } else if (playback === 'stopped' && activeClipName) {
      s.setDuration(selectClip(activeClipName, { loop, speed }, s.animData))
    }
    play()
    s.setPlayback('playing')
  }

  function onPause() {
    setOpenMenu(null)
    pause()
    useStore.getState().setPlayback('paused')
  }

  function onStop() {
    setOpenMenu(null)
    stop()
    useStore.getState().setPlayback('stopped')
    useStore.getState().setCurrentTime(0)
  }

  function onPlayAll() {
    setOpenMenu(null)
    const store = useStore.getState()
    const reachedFirstClipEnd =
      store.stopAtFirstClipEnd &&
      store.playback === 'paused' &&
      store.globalTime >= getAllTimelineDuration({ stopAtFirstClipEnd: true }) - 1e-3
    if (reachedFirstClipEnd) {
      stopAllCharacters()
      stopObjectAnimation()
    }
    const { started: charactersStarted, minDuration } = playAllCharacters({
      stopAtFirstClipEnd: store.stopAtFirstClipEnd,
    })
    const objectStarted = startObjectAnimation() > 0 ? 1 : 0
    const started = charactersStarted + objectStarted
    if (started > 0) {
      startGlobalClock(true, {
        duration: store.stopAtFirstClipEnd && charactersStarted ? minDuration : undefined,
        stopAtFirstClipEnd: store.stopAtFirstClipEnd,
      })
    }
    setMsg(started ? `Playing ${started} active animation track${started === 1 ? '' : 's'} across the scene.` : 'Nothing to play — select a clip or create object motion first.')
  }

  function onStopAll() {
    setOpenMenu(null)
    stopAllCharacters()
    stopObjectAnimation()
  }

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
      const size = exportPNG(exportScale, name)
      setMsg(size ? `Saved a ${size.width}×${size.height} PNG.` : 'Could not save the image right now.')
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

  // ---- Edit: shared undo/redo history and mode-aware copy/paste. ----

  function onUndo() {
    setOpenMenu(null)
    performUndo(useStore.getState())
  }

  function onRedo() {
    setOpenMenu(null)
    performRedo(useStore.getState())
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

  function onCopyCurrentEdit() {
    setOpenMenu(null)
    const copied = copyCurrentEdit()
    if (copied) {
      const label = copied === 'pose'
        ? 'Pose'
        : copied === 'mesh'
          ? 'Mesh transform'
          : copied === 'character'
            ? 'Character'
            : copied === 'camera'
              ? 'Camera'
              : copied === 'light'
                ? 'Light'
                : 'Object'
      setMsg(`${label} copied.`)
    }
  }

  function onPasteCurrentEdit() {
    setOpenMenu(null)
    const pasted = pasteCurrentEdit()
    if (!pasted) return
    if (pasted.type === 'pose') {
      const { applied, missing } = pasted.result
      setMsg(`Pasted ${applied} bone(s)` + (missing.length ? `, ${missing.length} skipped.` : '.'))
    } else if (pasted.type === 'object') {
      setMsg(`Pasted "${pasted.result.name}".`)
    } else if (pasted.type === 'character') {
      setMsg(`Pasted "${pasted.result.name}".`)
    } else if (pasted.type === 'camera' || pasted.type === 'light') {
      setMsg(`Pasted "${pasted.result.name}".`)
    } else {
      setMsg('Mesh transform pasted.')
    }
  }

  function onToggleAllVisibility() {
    setOpenMenu(null)
    const visible = anyObjectHidden
    for (const entry of sceneObjects) setObjectVisibleById(entry.id, visible)
  }

  const visibilityObject = sceneObjects.find((entry) => entry.id === selectedObjectId)
  const visibilityAvailable = mode === 'mesh'
    ? !!selectedMeshUuid
    : mode === 'object' && !!visibilityObject
  const currentVisible = mode === 'mesh'
    ? meshOverrides[selectedMeshUuid]?.visible !== false
    : visibilityObject?.visible !== false
  const anyObjectHidden = sceneObjects.some((entry) => entry.visible === false)
  const editCopyAvailable = canCopyCurrentEdit()
  const editPasteAvailable = canPasteCurrentEdit()

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
              <button role="menuitem" onClick={onNewProject} disabled={!hasSceneContent && !current}>New Project</button>
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={onOpen}>Open Project…</button>
              <button role="menuitem" onClick={onSave} disabled={!hasSceneContent && !current}>Save</button>
              <button role="menuitem" onClick={onSaveAs} disabled={!hasSceneContent && !current}>Save As…</button>
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
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={() => { setOpenMenu(null); onOpenSettings?.() }}>Settings</button>
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
              {poseToolsAvailable ? (
                <>
                  <button role="menuitem" onClick={onCopyPose}>Copy Pose</button>
                  <button role="menuitem" onClick={onCutPose}>Cut Pose</button>
                  <button role="menuitem" onClick={onPastePose} disabled={!poseClipboard}>Paste Pose</button>
                </>
              ) : (
                <>
                  <button role="menuitem" onClick={onCopyCurrentEdit} disabled={!editCopyAvailable}>
                    {mode === 'object'
                      ? (sceneObjects.find((entry) => entry.id === selectedObjectId)?.isCharacter ? 'Copy Character' : 'Copy Object')
                      : mode === 'mesh' ? 'Copy Mesh Transform' : 'Copy'}
                  </button>
                  <button role="menuitem" onClick={onPasteCurrentEdit} disabled={!editPasteAvailable}>
                    {mode === 'object' ? 'Paste Object or Character' : mode === 'mesh' ? 'Paste Mesh Transform' : 'Paste'}
                  </button>
                </>
              )}
              {visibilityAvailable && (
                <>
                  <div className="titlebar-dropdown-sep" />
                  <button
                    role="menuitem"
                    title={`${currentVisible ? 'Hide' : 'Unhide'} selected ${mode === 'mesh' ? 'mesh part' : 'object'} (H)`}
                    onClick={() => {
                      setOpenMenu(null)
                      toggleCurrentVisibility()
                    }}
                  >
                    {currentVisible ? 'Hide' : 'Unhide'}
                  </button>
                </>
              )}
              {sceneObjects.length > 0 && (
                <button role="menuitem" onClick={onToggleAllVisibility}>
                  {anyObjectHidden ? 'Unhide All' : 'Hide All'}
                </button>
              )}
            </div>
          )}
        </div>
        
        <div className="titlebar-menu-item">
          <button
            className={'titlebar-menu-btn' + (openMenu === 'animation' ? ' active' : '')}
            onClick={() => toggleMenu('animation')}
          >
            Animation
          </button>
          {openMenu === 'animation' && (
            <div className="titlebar-dropdown" role="menu">
              <button role="menuitem" onClick={onPlay} disabled={!hasCharacter}>Play</button>
              <button role="menuitem" onClick={onPlayAll} disabled={!hasCharacter && !hasObjectAnimation}>Play All</button>
              <button role="menuitem" onClick={onPause} disabled={!hasCharacter || playback !== 'playing'}>Pause</button>
              <button role="menuitem" onClick={onStop} disabled={!hasCharacter}>Stop</button>
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={onStopAll} disabled={!hasCharacter && !hasObjectAnimation}>Stop All</button>
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
              <button
                role="menuitem"
                onClick={() => { setOpenMenu(null); window.open(PRIVACY_POLICY_URL, '_blank', 'noopener,noreferrer') }}
              >
                Privacy Policy
              </button>
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