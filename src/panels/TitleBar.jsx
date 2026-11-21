import { PRIVACY_POLICY_URL } from '../links.js'
import { autoRigAvailable } from '../three/autoRig.js'
import { openAccordion } from './Accordion.jsx'
import { MODEL_FORMATS, saveImagePNG, saveFramesZip, saveBVH, saveSceneModel } from '../three/exportActions.js'
import { switchToClip, switchToEditAnimation } from '../three/clipSwitch.js'
import SaveErrorDialog from './SaveErrorDialog.jsx'
import { confirmDiscardUnsaved, markProjectSaveFailed } from '../three/projectDirty.js'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import {
  getProjectData,
  applyProjectData,
  clearProjectScene,
  importModelAuto,
  importBVHAuto,
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
  openProjectFromPath,
  saveProjectToHandle,
  saveProjectAs,
} from '../three/projectStore.js'
import { pickFileWithInput } from '../three/fsAccess.js'
import { importProjectFromFile } from '../three/importProject.js'
import { modelFileFromInput, MODEL_ACCEPT } from '../three/modelBundle.js'
import { play, pause, stop, selectClip, selectEdit, setLoop as engineSetLoop, setSpeed as engineSetSpeed } from '../three/animation.js'
import { runExportShot, canRecordVideo } from '../three/exportShot.js'
import {
  getPose,
  applyPose,
  resetPose,
} from '../three/posing.js'
import { startObjectAnimation, stopObjectAnimation } from '../three/objects.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { addLightAndSelect, addCameraAndSelect } from '../three/addSceneItems.js'
import {
  canCopyCurrentEdit,
  canPasteCurrentEdit,
  copyCurrentEdit,
  pasteCurrentEdit,
  toggleCurrentVisibility,
} from '../three/editClipboard.js'

const SPEEDS = [0.25, 0.5, 1, 1.5, 2]

// A dropdown row with a title and a one-line description under it, so a menu explains itself.
function RichItem({ title, desc, onClick, disabled, tip }) {
  return (
    <button role="menuitem" className="titlebar-rich" onClick={onClick} disabled={disabled} title={tip}>
      <span className="titlebar-rich-title">{title}</span>
      {desc && <span className="titlebar-rich-desc">{desc}</span>}
    </button>
  )
}

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
export default function TitleBar({ onOpenSettings, onOpenPoseFinder }) {
  const [openMenu, setOpenMenu] = useState(null) // 'file' | 'edit' | 'animation' | 'tools' | 'help' | null
  const [fileView, setFileView] = useState('root') // 'root' | 'import' | 'export'
  const [animView, setAnimView] = useState('root') // 'root' | 'clips' | 'speed'
  const [recents, setRecents] = useState([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const rootRef = useRef(null)
  const modelInputRef = useRef(null)
  const modelFolderInputRef = useRef(null)
  const bvhInputRef = useRef(null)

  const current = useStore((s) => s.currentProject)
  const setCurrent = useStore((s) => s.setCurrentProject)
  const setLastProjectSave = useStore((s) => s.setLastProjectSave)
  const importedClipNames = useStore((s) => s.importedClipNames)
  const bakedClipNames = useStore((s) => s.modelInfo?.clipNames)
  const videoFormat = useStore((s) => s.exportVideoFormat)
  const canQuit = typeof window !== 'undefined' && !!window.animare?.quit
  const poseFinderAvailable = typeof window !== 'undefined' && !!window.animare?.pose
  const toggleHelp = useStore((s) => s.toggleHelp)
  const setAutoRiggerOpen = useStore((s) => s.setAutoRiggerOpen)
  const openPoseLibrary = useStore((s) => s.openPoseLibrary)
  const closePoseLibrary = useStore((s) => s.closePoseLibrary)
  const poseLibraryTab = useStore((s) => s.poseLibraryTab)
  const lastPoseLibraryTab = useStore((s) => s.lastPoseLibraryTab)
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

  // Desktop build: load a .3dcp the OS opened us with (double-click / "Open with"),
  // both at launch and while the app is already running.
  useEffect(() => {
    const native = typeof window !== 'undefined' ? window.animare : null
    if (!native?.isElectron || !native.takePendingOpenFile) return
    let cancelled = false
    const openPath = async (filePath) => {
      if (!filePath || cancelled) return
      if (!(await confirmDiscardUnsaved('open another project'))) return
      setBusy(true)
      setMsg(null)
      try {
        const opened = await openProjectFromPath(filePath)
        if (cancelled) return
        await applyProjectData(opened.record)
        setCurrent({ name: opened.name, handle: opened.handle })
      } catch (e) {
        setMsg(e?.message || String(e))
      } finally {
        setBusy(false)
      }
    }
    const off = native.onOpenFile?.(openPath)
    native.takePendingOpenFile().then(openPath).catch(() => {})
    return () => {
      cancelled = true
      off?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (openMenu !== 'file') return
    listRecentProjects().then(setRecents).catch(() => setRecents([]))
  }, [openMenu])

  useEffect(() => {
    if (openMenu !== 'file') setFileView('root')
    if (openMenu !== 'animation') setAnimView('root')
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

  async function withMenuClosed(fn, saving = false) {
    setOpenMenu(null)
    setBusy(true)
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      if (e?.name !== 'AbortError') {
        if (saving) {
          markProjectSaveFailed()
          setSaveError(e)
        }
        else setMsg(e.message || String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  // ---- File: New Project / Open / Save / Save As / Recent ----

  const onOpen = () =>
    withMenuClosed(async () => {
      if (!(await confirmDiscardUnsaved('open another project'))) return
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

  const onImportProject = () =>
    withMenuClosed(async () => {
      const result = await importProjectFromFile()
      if (result) setMsg(result.message)
    })

  const onOpenRecentFile = (recent) =>
    withMenuClosed(async () => {
      if (!(await confirmDiscardUnsaved('open another project'))) return
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
    }, true)

  const onSaveAs = () =>
    withMenuClosed(async () => {
      const data = getProjectData()
      const { handle, name, savedAt } = await saveProjectAs({ name: current?.name || 'Untitled', ...data }, current?.name)
      setCurrent({ name, handle })
      setLastProjectSave({ name, savedAt })
    }, true)

  const onNewProject = () =>
    withMenuClosed(async () => {
      if (!(await confirmDiscardUnsaved('start a new project'))) return
      clearProjectScene()
      setCurrent(null)
    })

  function onPlay() {
    setOpenMenu(null)
    const s = useStore.getState()
    if (playbackSource === 'edit') {
      s.setDuration(selectEdit(s.animData, s.animDuration, { loop, speed }))
    } else if (playback === 'stopped' && activeClipName) {
      s.setDuration(selectClip(activeClipName, { loop, speed, inPlace: s.removeClipMovement }, s.animData))
    }
    if (play()) s.setPlayback('playing')
    else {
      s.setPlayback('paused')
      setMsg('This clip has one pose frame, so there is nothing to play.')
    }
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
  function onPickImportModelFolder() {
    setOpenMenu(null)
    modelFolderInputRef.current?.click()
  }
  // Handles a single file, several files picked together (a model + its textures)
  // and a picked folder — all packed into one file by modelFileFromInput.
  function onImportModelFile(e) {
    const picked = Array.from(e.target.files || []) // copy before the input is cleared
    e.target.value = ''
    if (!picked.length) return
    withMenuClosed(async () => {
      const file = await modelFileFromInput(picked)
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
      setMsg(saveImagePNG(name).message)
    })

  const onExportModel = (format) =>
    withMenuClosed(async () => {
      const result = await saveSceneModel(format, name)
      setMsg(result.message)
    })

  const onExportBVH = () =>
    withMenuClosed(async () => {
      setMsg(saveBVH(name).message)
    })

  const onExportFrames = () =>
    withMenuClosed(async () => {
      const result = await saveFramesZip(name, (frame, total) => {
        setMsg(frame ? `Saving animation frames… ${frame} of ${total}` : `Preparing ${total} animation frames…`)
      })
      setMsg(result.message)
    })

  // Video follows the Export panel's saved settings (size, frame rate, quality, format, camera).
  const onExportVideo = (record) =>
    withMenuClosed(async () => {
      runExportShot({ record, name, onStatus: setMsg })
    })

  function onMoreExportOptions() {
    setOpenMenu(null)
    openAccordion('export')
  }

  // ---- Animation: loop, speed, clip list ----

  function onToggleLoop() {
    const next = !loop
    useStore.getState().setLoop(next)
    engineSetLoop(next)
  }

  function onSetSpeed(value) {
    useStore.getState().setSpeed(value)
    engineSetSpeed(value)
    setAnimView('root')
  }

  function onPickClip(clipName) {
    setOpenMenu(null)
    if (clipName == null) {
      switchToEditAnimation({ loop, speed })
      return
    }
    const warning = switchToClip(clipName, { loop, speed })
    if (warning) setMsg(warning)
  }

  function onManageClips() {
    setOpenMenu(null)
    openAccordion('animate')
    useStore.getState().setManageClipsRequested(true)
  }

  // File > Quit does what the window's X does: the main process asks the page first, so unsaved
  // work gets the same "Save changes?" box.
  function onQuit() {
    setOpenMenu(null)
    window.animare?.quit?.()
  }

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

  function onAddLight() {
    setOpenMenu(null)
    addLightAndSelect()
  }

  function onAddCamera() {
    setOpenMenu(null)
    addCameraAndSelect()
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
      <input ref={modelInputRef} type="file" accept={MODEL_ACCEPT} multiple style={{ display: 'none' }} onChange={onImportModelFile} />
      <input ref={modelFolderInputRef} type="file" webkitdirectory="" directory="" multiple style={{ display: 'none' }} onChange={onImportModelFile} />
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
              <button role="menuitem" onClick={onImportProject} title="Add another project's characters, objects and animations to this one">Import Project…</button>
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
              {canQuit && (
                <>
                  <div className="titlebar-dropdown-sep" />
                  <button role="menuitem" onClick={onQuit} title="Close the app (asks to save first if there are unsaved changes)">Quit</button>
                </>
              )}
            </div>
          )}
          {openMenu === 'file' && fileView === 'import' && (
            <div className="titlebar-dropdown" role="menu">
              <button role="menuitem" onClick={() => setFileView('root')}>◂ Back</button>
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={onPickImportModel} title="Rigged files (with bones) come in as a new character; everything else as an object">
                Import Model… (.fbx .glb .gltf .obj .dae .stl .ply .usdz .blend .zip .rar)
              </button>
              <button role="menuitem" onClick={onPickImportModelFolder} title="Pick a model's folder — its textures and materials come along">
                Import Model Folder…
              </button>
              <button role="menuitem" onClick={onPickImportBVH} disabled={!hasCharacter} title={hasCharacter ? 'Applies to the active character, using the best-guess bone mapping' : 'Load a character first'}>
                Import Animation… (.bvh)
              </button>
            </div>
          )}
          {openMenu === 'file' && fileView === 'export' && (
            <div className="titlebar-dropdown titlebar-dropdown-tall" role="menu">
              <button role="menuitem" onClick={() => setFileView('root')}>◂ Back</button>
              <div className="titlebar-dropdown-sep" />
              <div className="titlebar-dropdown-label">Video</div>
              <button role="menuitem" onClick={() => onExportVideo(true)} disabled={!canRecord} title={canRecord ? 'Records the whole animation using the Export panel’s size, frame rate and quality' : 'Not supported in this browser'}>
                Record video ({videoFormat === 'mp4' ? '.mp4' : '.webm'})
              </button>
              <button role="menuitem" onClick={() => onExportVideo(false)} title="Plays the animation exactly as the video would look — nothing is saved">Preview video</button>
              <div className="titlebar-dropdown-label">Image</div>
              <button role="menuitem" onClick={onExportPNG}>Current view (.png)</button>
              <button role="menuitem" onClick={onExportFrames} title="Every animation frame as a numbered PNG in one zip">All animation frames (.zip)</button>
              <div className="titlebar-dropdown-label">Mocap</div>
              <button role="menuitem" onClick={onExportBVH}>Animation (.bvh)</button>
              <div className="titlebar-dropdown-label">3D model</div>
              {MODEL_FORMATS.map((f) => (
                <button key={f.value} role="menuitem" onClick={() => onExportModel(f.value)} title={f.hint}>
                  Scene model ({'.' + f.ext}){f.value === 'glb' ? ' — recommended' : ''}
                </button>
              ))}
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={onMoreExportOptions} title="Size, frame rate, quality, pose and material options live in the Export section of the side panel">More export options…</button>
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
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={onAddLight}>Add Light</button>
              <button role="menuitem" onClick={onAddCamera}>Add Camera</button>
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
          {openMenu === 'animation' && animView === 'root' && (
            <div className="titlebar-dropdown" role="menu">
              <button role="menuitem" onClick={onPlay} disabled={!hasCharacter}>Play</button>
              <button role="menuitem" onClick={onPause} disabled={!hasCharacter || playback !== 'playing'}>Pause</button>
              <button role="menuitem" onClick={onStop} disabled={!hasCharacter}>Stop</button>
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={onPlayAll} disabled={!hasCharacter && !hasObjectAnimation}>Play All</button>
              <button role="menuitem" onClick={onStopAll} disabled={!hasCharacter && !hasObjectAnimation}>Stop All</button>
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={onToggleLoop} disabled={!hasCharacter}>{loop ? '✓ ' : ''}Loop</button>
              <button role="menuitem" onClick={() => setAnimView('speed')} disabled={!hasCharacter}>Speed: {speed}× ▸</button>
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={() => setAnimView('clips')} disabled={!hasCharacter}>Clips ▸</button>
              <button role="menuitem" onClick={onManageClips} disabled={!hasCharacter} title="Open the clip tools in the Animate section: rename, trim, mirror, combine, delete">Manage clips…</button>
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={() => { setOpenMenu(null); bvhInputRef.current?.click() }} disabled={!hasCharacter} title={hasCharacter ? 'Applies to the active character, using the best-guess bone mapping' : 'Load a character first'}>Import animation (.bvh)…</button>
              <button role="menuitem" onClick={onExportBVH} disabled={!hasCharacter}>Export animation (.bvh)</button>
            </div>
          )}
          {openMenu === 'animation' && animView === 'speed' && (
            <div className="titlebar-dropdown" role="menu">
              <button role="menuitem" onClick={() => setAnimView('root')}>◂ Back</button>
              <div className="titlebar-dropdown-sep" />
              {SPEEDS.map((v) => (
                <button key={v} role="menuitem" onClick={() => onSetSpeed(v)}>{speed === v ? '✓ ' : ''}{v}×{v === 1 ? ' (normal)' : ''}</button>
              ))}
            </div>
          )}
          {openMenu === 'animation' && animView === 'clips' && (
            <div className="titlebar-dropdown titlebar-dropdown-tall" role="menu">
              <button role="menuitem" onClick={() => setAnimView('root')}>◂ Back</button>
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={() => onPickClip(null)} title="The character's own keyframe animation, edited in the Animate section">
                {playbackSource === 'edit' ? '✓ ' : ''}Editable animation (keyframes)
              </button>
              {[...(bakedClipNames || []), ...importedClipNames].length > 0 && <div className="titlebar-dropdown-label">Clips on this character</div>}
              {[...(bakedClipNames || []), ...importedClipNames].map((clipName) => (
                <button key={clipName} role="menuitem" onClick={() => onPickClip(clipName)} title={clipName}>
                  {playbackSource === 'clip' && activeClipName === clipName ? '✓ ' : ''}{clipName}
                </button>
              ))}
              <div className="titlebar-dropdown-sep" />
              <button role="menuitem" onClick={onManageClips}>Manage clips…</button>
            </div>
          )}
        </div>

        <div className="titlebar-menu-item">
          <button
            className={'titlebar-menu-btn' + (poseLibraryTab ? ' active' : '')}
            onClick={() => { setOpenMenu(null); if (poseLibraryTab) closePoseLibrary(); else openPoseLibrary(lastPoseLibraryTab) }}
          >
            Pose Library
          </button>
        </div>

        <div className="titlebar-menu-item">
          <button
            className={'titlebar-menu-btn' + (openMenu === 'tools' ? ' active' : '')}
            onClick={() => toggleMenu('tools')}
          >
            Tools
          </button>
          {openMenu === 'tools' && (
            <div className="titlebar-dropdown titlebar-dropdown-wide" role="menu">
              <div className="titlebar-dropdown-label">Motion</div>
              <RichItem
                title="Pose Finder…"
                desc={poseFinderAvailable ? 'Turn a video into a mocap clip' : 'Turn a video into a mocap clip · desktop app only'}
                onClick={() => { setOpenMenu(null); onOpenPoseFinder?.() }}
              />
              <div className="titlebar-dropdown-sep" />
              <div className="titlebar-dropdown-label">Rigging</div>
              <RichItem
                title="Rig a character…"
                desc={autoRigAvailable() ? 'Add a skeleton and skin weights to a model' : 'Add a skeleton and skin weights · desktop app + Blender needed'}
                onClick={() => { setOpenMenu(null); setAutoRiggerOpen(true) }}
              />
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
      <SaveErrorDialog error={saveError} onClose={() => setSaveError(null)} />
    </div>
  )
}