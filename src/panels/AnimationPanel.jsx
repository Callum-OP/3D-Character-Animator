import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import EditableValue from './EditableValue.jsx'
import {
  selectClip,
  selectEdit,
  play,
  pause,
  stop,
  setLoop as engineSetLoop,
  setSpeed as engineSetSpeed,
  beginBVHImport,
  applyBVHRetarget,
  cancelBVHImport,
  sampleClipToPose,
  bakeClipToTracks,
  trimClip,
  combineClips,
  clipFromTracks,
  addGeneratedClip,
  exportClipJSON,
  importClipJSON,
  renameClip,
} from '../three/animation.js'
import {
  listSavedClips,
  saveClipToLibrary,
  loadClipFromLibrary,
  deleteSavedClip,
} from '../three/clipLibrary.js'
import { getBoneQuaternion, getPosedBones, applyPose } from '../three/posing.js'
import { getCharacterRootTransform, getCurrentModel, getGroundY, scrubTimeline, playAllCharacters, stopAllCharacters } from '../three/scene.js'
import * as THREE from 'three'
import { simulateRagdollClip } from '../three/ragdoll.js'
import { getObjectRoots } from '../three/objects.js'

// Collect every keyframe time across joints, the character position, parts and
// cameras, with a count of what's keyed at each — for the overview/manage list.
function collectKeyframes(animData) {
  const map = new Map()
  const entry = (t) => {
    const e = map.get(t) || { time: t, joints: 0, pos: false, parts: 0, cameras: 0, morphs: 0, cut: null }
    map.set(t, e)
    return e
  }
  for (const keys of Object.values(animData.tracks || {})) {
    for (const k of keys) entry(k.time).joints++
  }
  for (const k of animData.root || []) entry(k.time).pos = true
  for (const keys of Object.values(animData.meshes || {})) {
    for (const k of keys) entry(k.time).parts++
  }
  for (const keys of Object.values(animData.cameras || {})) {
    for (const k of keys) entry(k.time).cameras++
  }
  for (const byName of Object.values(animData.morphs || {})) {
    for (const keys of Object.values(byName || {})) {
      for (const k of keys) entry(k.time).morphs++
    }
  }
  for (const k of animData.cuts || []) entry(k.time).cut = k.camera
  return [...map.values()].sort((a, b) => a.time - b.time)
}

// One-frame back/forward stepping on the fps grid, with a typeable frame
// number — so you can land exactly on "the next frame" instead of nudging a
// slider and guessing. `onChange` receives a time in seconds.
function FrameStepper({ time, duration, fps, onChange }) {
  const frame = Math.round(time * fps)
  const total = Math.max(0, Math.round(duration * fps))
  const toTime = (f) => Math.min(Math.max(f / fps, 0), duration || 0)
  return (
    <div className="frame-row">
      <button
        className="frame-btn"
        title={`Back one frame (1/${fps}s)`}
        onClick={() => onChange(toTime(frame - 1))}
        disabled={frame <= 0}
      >
        ◀
      </button>
      <span className="frame-label">
        Frame{' '}
        <EditableValue
          value={frame}
          min={0}
          max={total}
          onChange={(f) => onChange(toTime(Math.round(f)))}
          format={(f) => `${Math.round(f)}`}
          className="frame-num"
          label="Frame number"
        />{' '}
        / {total}
      </span>
      <button
        className="frame-btn"
        title={`Forward one frame (1/${fps}s)`}
        onClick={() => onChange(toTime(frame + 1))}
        disabled={frame >= total}
      >
        ▶
      </button>
    </div>
  )
}

// Side-panel section: play baked clips or author a simple in-app keyframe
// animation. Playback drives the bones, so it's mutually exclusive with posing —
// the engine suspends the gizmo while a clip is armed and restores the rest pose
// on Stop.
export default function AnimationPanel() {
  const modelInfo = useStore((s) => s.modelInfo)
  const selectedBoneName = useStore((s) => s.selectedBoneName)

  const playback = useStore((s) => s.playback)
  const source = useStore((s) => s.playbackSource)
  const activeClipName = useStore((s) => s.activeClipName)
  const loop = useStore((s) => s.loop)
  const speed = useStore((s) => s.speed)
  const duration = useStore((s) => s.duration)
  const currentTime = useStore((s) => s.currentTime)

  const animFps = useStore((s) => s.animFps)
  const animDuration = useStore((s) => s.animDuration)
  const insertTime = useStore((s) => s.insertTime)
  const animData = useStore((s) => s.animData)

  const importedClipNames = useStore((s) => s.importedClipNames)
  const characterOrder = useStore((s) => s.characterOrder)

  const st = useStore.getState // for imperative setters inside handlers
  const fileRef = useRef(null)
  const bvhRef = useRef(null)
  const clipFileRef = useRef(null)
  const [bvhMsg, setBvhMsg] = useState(null)
  const [savedClips, setSavedClips] = useState(() => listSavedClips())
  const [trimOpen, setTrimOpen] = useState(false)
  const [trimRange, setTrimRange] = useState([0, 0]) // [start, end] seconds
  const [toolsOpen, setToolsOpen] = useState(false) // collapses the less-common clip tools
  const [combineSel, setCombineSel] = useState([]) // clip names picked for Combine, in order
  const [bvhBusy, setBvhBusy] = useState(false)
  const [kfMsg, setKfMsg] = useState(null) // feedback after adding a keyframe
  const [blankFrames, setBlankFrames] = useState(4) // how many frames to insert
  const [ragdollMsg, setRagdollMsg] = useState(null) // feedback after a ragdoll bake
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameText, setRenameText] = useState('')
  // When a BVH is parsed, this holds the mapping editor state until the user
  // confirms (Retarget) or cancels: { name, sourceBones, targetBones, slots }.
  const [mapping, setMapping] = useState(null)

  // Space = play/pause, ←/→ = step one frame (the insert time while authoring
  // keyframes, otherwise the playhead). Re-registered every render so the
  // handler always closes over fresh state; ignored while typing in a field.
  useEffect(() => {
    function onKey(e) {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable)
        return
      if (!modelInfo) return
      if (e.key === ' ') {
        // Space is the transport toggle everywhere outside text fields — a
        // clicked button keeps focus, so blur it or its native Space activation
        // fires on keyup too. Buttons remain keyboard-activatable via Enter.
        e.preventDefault()
        if (tag === 'BUTTON') e.target.blur()
        onPauseToggle()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const dir = e.key === 'ArrowLeft' ? -1 : 1
        const step = (t, dur) =>
          Math.min(Math.max((Math.round(t * animFps) + dir) / animFps, 0), dur)
        if (source === 'edit' && playback === 'stopped') {
          e.preventDefault()
          st().setInsertTime(step(insertTime, animDuration))
        } else if (source === 'edit' || activeClipName) {
          e.preventDefault()
          onScrub(step(currentTime, source === 'edit' ? animDuration : duration))
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!modelInfo) return null

  const bakedNames = modelInfo.clipNames || []
  const clipNames = [...bakedNames, ...importedClipNames]
  const bones = modelInfo.bones || []
  const hasBones = bones.length > 0
  // The clip source is available if there are baked clips, imported mocap, OR a
  // skeleton to import mocap onto.
  const hasClips = clipNames.length > 0
  if (!hasClips && !hasBones) return null

  const displayDuration = source === 'edit' ? animDuration : duration
  const snap = (t) => Math.round(t * animFps) / animFps // to the fps grid
  const boneKeys = (selectedBoneName && animData.tracks[selectedBoneName]) || []
  const allKeyframes = collectKeyframes(animData)

  // --- transport handlers ---------------------------------------------------

  function onSourceChange(next) {
    stop()
    st().setPlayback('stopped')
    st().setCurrentTime(0)
    st().setPlaybackSource(next)
    if (next === 'clip' && activeClipName) {
      const d = selectClip(activeClipName, { loop, speed })
      st().setDuration(d)
      st().setPlayback('paused')
    } else if (next === 'edit') {
      st().setDuration(animDuration)
    }
  }

  function onClipChange(name) {
    st().setActiveClipName(name || null)
    stop()
    if (!name) {
      st().setPlayback('stopped')
      st().setDuration(0)
      return
    }
    const d = selectClip(name, { loop, speed })
    st().setDuration(d)
    st().setCurrentTime(0)
    st().setPlayback('paused')
  }

  function onPlay() {
    if (source === 'edit') {
      const d = selectEdit(animData, animDuration, { loop, speed })
      st().setDuration(d)
    } else if (playback === 'stopped' && activeClipName) {
      const d = selectClip(activeClipName, { loop, speed })
      st().setDuration(d)
    }
    play()
    st().setPlayback('playing')
  }

  function onPauseToggle() {
    if (playback === 'playing') {
      pause()
      st().setPlayback('paused')
    } else {
      onPlay()
    }
  }

  function onStop() {
    stop()
    st().setPlayback('stopped')
    st().setCurrentTime(0)
  }

  // Start every loaded character playing whatever it currently has selected
  // (this one's included) — lets several characters perform their own clips
  // at the same time.
  function onPlayAll() {
    const { started: n } = playAllCharacters()
    setKfMsg(
      n > 1
        ? `Playing ${n} characters.`
        : n === 1
          ? 'Only this character has a clip/animation selected — the others have nothing to play yet.'
          : 'Nothing to play — pick a clip or make an animation on at least one character first.',
    )
  }

  function onStopAll() {
    stopAllCharacters()
  }

  function onScrub(t) {
    // Arm the source if we're stopped so there's an action to evaluate.
    if (playback === 'stopped') {
      if (source === 'edit') {
        const d = selectEdit(animData, animDuration, { loop, speed })
        st().setDuration(d)
      } else if (activeClipName) {
        selectClip(activeClipName, { loop, speed })
      }
      st().setPlayback('paused')
    } else if (playback === 'playing') {
      pause()
      st().setPlayback('paused')
    }
    scrubTimeline(t)
    st().setCurrentTime(t)
  }

  function onLoop(v) {
    st().setLoop(v)
    engineSetLoop(v)
  }

  function onSpeed(v) {
    st().setSpeed(v)
    engineSetSpeed(v)
  }

  // --- keyframe handlers ----------------------------------------------------

  function onAddKey() {
    if (!selectedBoneName) return
    const quat = getBoneQuaternion(selectedBoneName)
    if (!quat) return
    const t = snap(insertTime)
    st().addKeyframe(selectedBoneName, t, quat)
    setKfMsg(
      `Saved “${selectedBoneName}” at ${t.toFixed(2)}s. Now move the time slider, change the pose, add another keyframe — then Play.`,
    )
  }

  function onKeyAll() {
    const posed = getPosedBones()
    if (!posed.length) {
      setKfMsg('Nothing to save — pose a joint (drag a ring) first, then add a keyframe.')
      return
    }
    const t = snap(insertTime)
    st().addKeyframesAtTime(posed, t)
    setKfMsg(`Saved ${posed.length} posed joint(s) at ${t.toFixed(2)}s.`)
  }

  // Insert N blank/hold frames at the insert time: every keyframe at or after
  // that point shifts later, opening a gap (a pause/hold) in the timeline
  // without disturbing the poses already either side of it.
  function onInsertBlank() {
    const n = Math.round(blankFrames)
    if (!n || n <= 0) return
    const t = snap(insertTime)
    st().insertBlankFrames(t, n)
    setKfMsg(
      `Inserted ${n} blank frame${n === 1 ? '' : 's'} (${(n / animFps).toFixed(2)}s) at ${t.toFixed(2)}s — everything after that time shifted later.`,
    )
  }

  // Keyframe the character's world placement (for root motion — walking toward a
  // wall, etc.). Move the character (Objects → the character entry), then key it.
  function onKeyPosition() {
    const tr = getCharacterRootTransform()
    if (!tr) return
    const t = snap(insertTime)
    st().addRootKeyframe(t, tr.pos, tr.quat)
    const n = (animData.root ? animData.root.filter((k) => k.time !== t).length : 0) + 1
    setKfMsg(
      `Saved the character's position at ${t.toFixed(2)}s (${n} total). Move the character in Objects at a different time and save again — it'll glide between them on Play.`,
    )
  }

  function onSaveAnim() {
    const json = {
      format: 'anim-v1',
      fps: animFps,
      duration: animDuration,
      tracks: animData.tracks,
      root: animData.root || [],
      meshes: animData.meshes || {},
      cameras: animData.cameras || {},
      cuts: animData.cuts || [],
      morphs: animData.morphs || {},
    }
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${modelInfo.name || 'animation'}.anim.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function onLoadAnim(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    file.text().then((text) => {
      try {
        const json = JSON.parse(text)
        if (json.format !== 'anim-v1') throw new Error('Not an anim-v1 file.')
        st().setAnimFps(json.fps || 24)
        st().setAnimDuration(json.duration || 2)
        st().setAnimData({
          tracks: json.tracks || {},
          root: json.root || [],
          meshes: json.meshes || {},
          cameras: json.cameras || {},
          cuts: json.cuts || [],
          morphs: json.morphs || {},
        })
      } catch (err) {
        console.warn('Failed to load animation:', err)
      }
    })
  }

  // --- mocap (BVH) + clip-to-pose/keyframes ---------------------------------

  async function onPickBVH(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setBvhBusy(true)
    setBvhMsg(null)
    try {
      stop()
      st().setPlayback('stopped')
      st().setCurrentTime(0)
      const result = await beginBVHImport(file) // parse + auto-guess mapping
      setMapping(result)
    } catch (err) {
      setBvhMsg(err.message || String(err))
    } finally {
      setBvhBusy(false)
    }
  }

  // Update one slot's target/source bone in the mapping editor.
  function setSlot(key, field, value) {
    setMapping((m) => ({
      ...m,
      slots: m.slots.map((s) => (s.key === key ? { ...s, [field]: value } : s)),
    }))
  }

  async function onRetarget() {
    setBvhBusy(true)
    try {
      const { name, matched, total } = await applyBVHRetarget(mapping.slots)
      st().addImportedClipName(name)
      st().setPlaybackSource('clip')
      st().setActiveClipName(name)
      const d = selectClip(name, { loop, speed })
      st().setDuration(d)
      st().setCurrentTime(0)
      st().setPlayback('paused')
      setMapping(null)
      setBvhMsg(`Imported "${name}" — retargeted ${matched} mapped bone(s).`)
    } catch (err) {
      setBvhMsg(err.message || String(err))
    } finally {
      setBvhBusy(false)
    }
  }

  function onCancelMapping() {
    cancelBVHImport()
    setMapping(null)
  }

  function onApplyFrameAsPose() {
    if (!activeClipName) return
    const map = sampleClipToPose(activeClipName, currentTime)
    if (!map) return
    stop()
    st().setPlayback('stopped')
    st().setCurrentTime(0)
    applyPose({ format: 'pose-v1', bones: map })
    setBvhMsg(`Applied frame @ ${currentTime.toFixed(2)}s as the current pose.`)
  }

  // Drop the character limply from whatever it looks like right now (a manual
  // pose, or a paused clip frame), bake the fall as a clip and play it.
  function onRagdoll() {
    if (playback === 'playing') {
      pause() // freeze the current frame — the fall starts from what's on screen
      st().setPlayback('paused')
    }
    const obstacles = []
    for (const root of getObjectRoots()) {
      if (!root.visible) continue
      root.updateWorldMatrix(true, true)
      root.traverse((obj) => {
        if (obj.isMesh) obstacles.push(new THREE.Box3().setFromObject(obj))
      })
    }

    const res = simulateRagdollClip(getCurrentModel(), {
      groundY: getGroundY(),
      fps: animFps,
      limits: st().limbLimits,
      obstacles,
    })
    if (!res) {
      setRagdollMsg('This model has no skeleton to ragdoll.')
      return
    }
    const name = addGeneratedClip(res.clip)
    st().addImportedClipName(name)
    st().setPlaybackSource('clip')
    st().setActiveClipName(name)
    const d = selectClip(name, { loop, speed })
    st().setDuration(d)
    st().setCurrentTime(0)
    play()
    st().setPlayback('playing')
    setRagdollMsg(`Flop! Saved as the clip “${name}” — replay it any time from the clip list.`)
  }

  function onBake() {
    if (!activeClipName) return
    const res = bakeClipToTracks(activeClipName, animFps, duration || undefined)
    if (!res) return
    st().setAnimData({ tracks: res.tracks })
    st().setAnimDuration(res.duration)
    onSourceChange('edit')
    setBvhMsg(`Baked ${Object.keys(res.tracks).length} moving track(s) to keyframes.`)
  }

  // Bridge back the other way: turn what you've keyframed in "Make your own"
  // into a real clip, so it immediately has the same Save/Export/Trim/Combine
  // tools as anything under "Play a clip".
  function onSaveAsClip() {
    const nameGuess = activeClipName ? `${activeClipName} (edited)` : 'My clip'
    const name = clipFromTracks(animData.tracks, animDuration, nameGuess)
    if (!name) return
    stop()
    armClip(name)
    setKfMsg(`Saved as the clip “${name}” — find it under Play a clip, with the same tools.`)
  }

  function onOpenRename() {
    setRenameText(activeClipName || '')
    setRenameOpen(true)
  }

  function onConfirmRename() {
    if (!activeClipName) return
    const finalName = renameClip(activeClipName, renameText)
    if (!finalName) {
      setBvhMsg("Clips built into the model file itself can't be renamed.")
      setRenameOpen(false)
      return
    }
    st().renameImportedClipName(activeClipName, finalName)
    st().setActiveClipName(finalName)
    setRenameOpen(false)
    setBvhMsg(finalName === activeClipName ? null : `Renamed to “${finalName}”.`)
  }

  // --- clip library (save-permanently / export / import) -------------------

  // Bring a freshly-registered clip (from import or the library) straight into
  // the transport, paused on frame 0 — mirrors what BVH retarget/ragdoll do.
  function armClip(name) {
    st().addImportedClipName(name)
    st().setPlaybackSource('clip')
    st().setActiveClipName(name)
    const d = selectClip(name, { loop, speed })
    st().setDuration(d)
    st().setCurrentTime(0)
    st().setPlayback('paused')
  }

  function onSaveToLibrary() {
    if (!activeClipName) return
    const json = exportClipJSON(activeClipName)
    if (!json) return
    const ok = saveClipToLibrary(activeClipName, json)
    setSavedClips(listSavedClips())
    setBvhMsg(
      ok
        ? `Saved “${activeClipName}” to your library — it'll still be here next time you open the app.`
        : `Couldn't save “${activeClipName}” — your browser's storage may be full.`,
    )
  }

  function onExportClip() {
    if (!activeClipName) return
    const json = exportClipJSON(activeClipName)
    if (!json) return
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${activeClipName}.clip.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  function onImportClipFile(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    file.text().then((text) => {
      try {
        const json = JSON.parse(text)
        const name = importClipJSON(json)
        if (!name) throw new Error('Load a model first.')
        armClip(name)
        setBvhMsg(`Imported “${name}”.`)
      } catch (err) {
        setBvhMsg(err.message || String(err))
      }
    })
  }

  function onLoadFromLibrary(name) {
    const json = loadClipFromLibrary(name)
    if (!json) return
    const finalName = importClipJSON(json)
    if (!finalName) return
    armClip(finalName)
    setBvhMsg(`Loaded “${finalName}” from your library.`)
  }

  function onDeleteFromLibrary(name) {
    deleteSavedClip(name)
    setSavedClips(listSavedClips())
  }

  // --- trim ------------------------------------------------------------------

  function onOpenTrim() {
    setTrimRange([0, duration || 0])
    setTrimOpen(true)
  }

  function onConfirmTrim() {
    if (!activeClipName) return
    const [start, end] = trimRange
    if (end <= start) {
      setBvhMsg('The trim end has to be after the start.')
      return
    }
    const newName = trimClip(activeClipName, animFps, start, end)
    if (!newName) return
    setTrimOpen(false)
    armClip(newName)
    setBvhMsg(
      `Created “${newName}” from ${start.toFixed(2)}s–${end.toFixed(2)}s. The original clip is untouched.`,
    )
  }

  // --- combine -----------------------------------------------------------

  function toggleCombineSel(name) {
    setCombineSel((sel) => (sel.includes(name) ? sel.filter((n) => n !== name) : [...sel, name]))
  }

  function onConfirmCombine() {
    if (combineSel.length < 2) return
    const newName = combineClips(combineSel, animFps)
    if (!newName) return
    setCombineSel([])
    armClip(newName)
    setBvhMsg(`Combined ${combineSel.length} clips into “${newName}”, in the order you picked them.`)
  }

  const playing = playback === 'playing'

  return (
    <div className="panel">
      <h2>Animate</h2>
      <p className="panel-hint">
        Play a ready-made animation or motion file, or make your own by posing and
        adding keyframes.
      </p>

      {/* Source selector */}
      <div className="seg">
        <button
          className={'seg-btn' + (source === 'clip' ? ' active' : '')}
          disabled={!hasClips && !hasBones}
          onClick={() => onSourceChange('clip')}
          title="Play a built-in animation or an imported motion file"
        >
          Play a clip
        </button>
        <button
          className={'seg-btn' + (source === 'edit' ? ' active' : '')}
          disabled={!hasBones}
          onClick={() => onSourceChange('edit')}
          title="Build your own animation from keyframes"
        >
          Make your own
        </button>
      </div>

      {/* Ragdoll: drop the character limply and keep the fall as a clip */}
      {hasBones && !mapping && (
        <>
          <div className="kf-actions" style={{ marginTop: 8 }}>
            <button
              className="btn secondary"
              onClick={onRagdoll}
              title="Let the character fall limply to the ground from its current pose — the fall is saved as a clip"
            >
              💥 Ragdoll to ground
            </button>
          </div>
          {ragdollMsg && <div className="pose-msg">{ragdollMsg}</div>}
        </>
      )}

      {source === 'clip' && !mapping && (
        <>
          {clipNames.length > 0 && (
            <select
              className="select"
              style={{ width: '100%', marginTop: 8 }}
              value={activeClipName || ''}
              onChange={(e) => onClipChange(e.target.value)}
            >
              <option value="">Select a clip…</option>
              {clipNames.map((name, i) => (
                <option key={i} value={name}>
                  {name || `(clip ${i + 1})`}
                </option>
              ))}
            </select>
          )}

          {activeClipName && importedClipNames.includes(activeClipName) && !renameOpen && (
            <button
              className="btn secondary"
              style={{ marginTop: 6 }}
              onClick={onOpenRename}
              title="Rename this clip"
            >
              ✏️ Rename
            </button>
          )}

          {renameOpen && (
            <div style={{ marginTop: 6 }}>
              <input
                className="select"
                style={{ width: '100%', fontSize: 13, padding: '8px 10px' }}
                value={renameText}
                autoFocus
                onFocus={(e) => e.target.select()}
                onChange={(e) => setRenameText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onConfirmRename()
                  if (e.key === 'Escape') setRenameOpen(false)
                }}
              />
              <div className="kf-actions" style={{ marginTop: 6 }}>
                <button className="btn" onClick={onConfirmRename}>
                  Save
                </button>
                <button className="btn secondary" onClick={() => setRenameOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {activeClipName && hasBones && (
            <div className="kf-actions" style={{ marginTop: 6 }}>
              <button
                className="btn secondary"
                onClick={onApplyFrameAsPose}
                title="Freeze the current frame as an editable pose"
              >
                Use as pose
              </button>
              <button
                className="btn secondary"
                onClick={onBake}
                title="Turn this clip into editable keyframes"
              >
                Edit keyframes
              </button>
            </div>
          )}

          <button
            className="btn secondary"
            style={{ marginTop: 8, width: '100%' }}
            onClick={() => setToolsOpen((v) => !v)}
          >
            🛠 Clip tools {toolsOpen ? '▲' : '▼'}
          </button>

          {toolsOpen && (
            <div style={{ marginTop: 4 }}>
              {hasBones && (
                <div className="kf-actions" style={{ marginTop: 8 }}>
                  <button
                    className="btn secondary"
                    onClick={() => bvhRef.current?.click()}
                    disabled={bvhBusy}
                  >
                    {bvhBusy ? 'Parsing…' : 'Import motion (.bvh)'}
                  </button>
                  <input
                    ref={bvhRef}
                    type="file"
                    accept=".bvh"
                    style={{ display: 'none' }}
                    onChange={onPickBVH}
                  />
                </div>
              )}

              {activeClipName && (
                <div className="kf-actions" style={{ marginTop: 6 }}>
                  <button
                    className="btn secondary"
                    onClick={onSaveToLibrary}
                    title="Keep this clip in your browser so it's here next time, even after reloading or switching models"
                  >
                    💾 Save clip
                  </button>
                  <button
                    className="btn secondary"
                    onClick={onExportClip}
                    title="Download this clip as a file to share or back up"
                  >
                    ⬇ Export clip
                  </button>
                  <button
                    className="btn secondary"
                    onClick={() => (trimOpen ? setTrimOpen(false) : onOpenTrim())}
                    title="Cut this clip down to a shorter range, saved as a new clip"
                  >
                    ✂ Trim
                  </button>
                </div>
              )}

              {trimOpen && activeClipName && (
                <div className="map-editor">
                  <div className="field-label" style={{ marginTop: 4 }}>
                    Trim “{activeClipName}”
                  </div>
                  <div className="map-hint">
                    Pick the range to keep — the rest is dropped. Saved as a new clip
                    named “{activeClipName} (trimmed)”; the original is untouched.
                  </div>
                  <label className="slider-row">
                    <span className="slider-label">Start</span>
                    <input
                      type="range"
                      min={0}
                      max={duration || 0}
                      step={1 / animFps}
                      value={trimRange[0]}
                      onChange={(e) =>
                        setTrimRange(([, end]) => [Math.min(Number(e.target.value), end), end])
                      }
                    />
                    <EditableValue
                      value={trimRange[0]}
                      min={0}
                      max={duration || 0}
                      onChange={(v) => setTrimRange(([, end]) => [Math.min(v, end), end])}
                      format={(v) => v.toFixed(2) + 's'}
                      label="Trim start (seconds)"
                    />
                  </label>
                  <label className="slider-row">
                    <span className="slider-label">End</span>
                    <input
                      type="range"
                      min={0}
                      max={duration || 0}
                      step={1 / animFps}
                      value={trimRange[1]}
                      onChange={(e) =>
                        setTrimRange(([start]) => [start, Math.max(Number(e.target.value), start)])
                      }
                    />
                    <EditableValue
                      value={trimRange[1]}
                      min={0}
                      max={duration || 0}
                      onChange={(v) => setTrimRange(([start]) => [start, Math.max(v, start)])}
                      format={(v) => v.toFixed(2) + 's'}
                      label="Trim end (seconds)"
                    />
                  </label>
                  <div className="kf-actions" style={{ marginTop: 8 }}>
                    <button className="btn" onClick={onConfirmTrim}>
                      Create trimmed clip
                    </button>
                    <button className="btn secondary" onClick={() => setTrimOpen(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="kf-actions" style={{ marginTop: 6 }}>
                <button
                  className="btn secondary"
                  onClick={() => clipFileRef.current?.click()}
                  title="Load a clip file exported from here (or by someone else)"
                >
                  ⬆ Import clip file
                </button>
                <input
                  ref={clipFileRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={onImportClipFile}
                />
              </div>

              {clipNames.length > 1 && (
                <>
                  <div className="field-label" style={{ marginTop: 10 }}>
                    Combine clips
                  </div>
                  <div className="kf-help">
                    Tick two or more, in the order you want them to play — they'll
                    be stitched into one new clip, back to back.
                  </div>
                  <div className="kf-list">
                    {clipNames.map((name, i) => {
                      const pos = combineSel.indexOf(name)
                      return (
                        <label key={i} className="kf-list-row" style={{ cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={pos !== -1}
                            onChange={() => toggleCombineSel(name)}
                            style={{ marginRight: 8 }}
                          />
                          <span className="kf-what">{name || `(clip ${i + 1})`}</span>
                          {pos !== -1 && <span className="kf-tag">{pos + 1}</span>}
                        </label>
                      )
                    })}
                  </div>
                  <div className="kf-actions" style={{ marginTop: 6 }}>
                    <button
                      className="btn secondary"
                      onClick={onConfirmCombine}
                      disabled={combineSel.length < 2}
                    >
                      Combine {combineSel.length > 1 ? `(${combineSel.length})` : ''}
                    </button>
                    {combineSel.length > 0 && (
                      <button className="btn secondary" onClick={() => setCombineSel([])}>
                        Clear selection
                      </button>
                    )}
                  </div>
                </>
              )}

              {savedClips.length > 0 && (
                <>
                  <div className="field-label" style={{ marginTop: 10 }}>
                    Saved clips ({savedClips.length})
                  </div>
                  <div className="kf-list">
                    {savedClips.map((s) => (
                      <div key={s.name} className="kf-list-row" title="Load into the clip list">
                        <span
                          className="kf-time"
                          style={{ cursor: 'pointer' }}
                          onClick={() => onLoadFromLibrary(s.name)}
                        >
                          {s.name}
                        </span>
                        <span className="kf-what" />
                        <button
                          className="kf-del"
                          title="Remove from your saved library"
                          onClick={(e) => {
                            e.stopPropagation()
                            onDeleteFromLibrary(s.name)
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {bvhMsg && <div className="pose-msg">{bvhMsg}</div>}
        </>
      )}

      {/* Mocap bone-mapping editor */}
      {mapping && (
        <div className="map-editor">
          <div className="field-label" style={{ marginTop: 8 }}>
            Map “{mapping.name}” bones → this rig
          </div>
          <div className="map-hint">
            Auto-guessed by body part. Fix any wrong rows (leave a row blank to
            skip it), then Retarget.
          </div>

          <div className="map-list">
            {mapping.slots.map((s) => (
              <div key={s.key} className="map-row">
                <span className="map-slot">{s.label}</span>
                <select
                  className="select select-sm"
                  title="Character bone"
                  value={s.target}
                  onChange={(e) => setSlot(s.key, 'target', e.target.value)}
                >
                  <option value="">— rig —</option>
                  {mapping.targetBones.map((b, i) => (
                    <option key={`${b}-${i}`} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                <select
                  className="select select-sm"
                  title="Mocap (BVH) bone"
                  value={s.source}
                  onChange={(e) => setSlot(s.key, 'source', e.target.value)}
                >
                  <option value="">— mocap —</option>
                  {mapping.sourceBones.map((b, i) => (
                    <option key={`${b}-${i}`} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="kf-actions" style={{ marginTop: 8 }}>
            <button className="btn" onClick={onRetarget} disabled={bvhBusy}>
              {bvhBusy ? 'Retargeting…' : 'Retarget'}
            </button>
            <button className="btn secondary" onClick={onCancelMapping} disabled={bvhBusy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Transport */}
      <div className="transport">
        <button className="btn" onClick={onPauseToggle}>
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button className="btn secondary" onClick={onStop} disabled={playback === 'stopped'}>
          ■ Stop
        </button>
      </div>

      {characterOrder.length > 1 && (
        <div className="transport" style={{ marginTop: 6 }}>
          <button
            className="btn secondary"
            onClick={onPlayAll}
            title="Play every loaded character's own selected clip/animation at the same time"
          >
            ▶ Play all ({characterOrder.length})
          </button>
          <button className="btn secondary" onClick={onStopAll}>
            ■ Stop all
          </button>
        </div>
      )}

      <div className="scrub-row">
        <input
          type="range"
          min={0}
          max={displayDuration || 0.0001}
          step={0.001}
          value={Math.min(currentTime, displayDuration || 0)}
          onChange={(e) => onScrub(Number(e.target.value))}
        />
        <EditableValue
          className="scrub-time"
          value={currentTime}
          min={0}
          max={displayDuration || 0}
          onChange={onScrub}
          format={(v) => `${v.toFixed(2)} / ${(displayDuration || 0).toFixed(2)}s`}
          label="Current time (seconds)"
        />
      </div>

      {displayDuration > 0 && (
        <FrameStepper
          time={Math.min(currentTime, displayDuration)}
          duration={displayDuration}
          fps={animFps}
          onChange={onScrub}
        />
      )}

      <div className="anim-opts">
        <label className="toggle-row" style={{ padding: 0 }}>
          <input type="checkbox" checked={loop} onChange={(e) => onLoop(e.target.checked)} />
          Loop
        </label>
        <label className="slider-row" style={{ flex: 1 }}>
          <span className="slider-label">Speed</span>
          <input
            type="range"
            min={0.1}
            max={2}
            step={0.1}
            value={speed}
            onChange={(e) => onSpeed(Number(e.target.value))}
          />
          <EditableValue
            value={speed}
            min={0.1}
            max={2}
            onChange={onSpeed}
            format={(v) => v.toFixed(1) + '×'}
            label="Playback speed"
          />
        </label>
      </div>

      {/* In-app keyframe editor */}
      {source === 'edit' && hasBones && (
        <div className="keyframe-editor">
          <div className="field-label" style={{ marginTop: 4 }}>
            Keyframes {playback !== 'stopped' && '(press Stop to edit)'}
          </div>
          <div className="kf-help">
            A keyframe is a snapshot at a moment in time. Pose the character, add a
            keyframe, move the time, pose differently, add another — <b>Play</b>{' '}
            smoothly blends between them.
          </div>

          <div className="kf-numbers">
            <label>
              Duration
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={animDuration}
                onChange={(e) => st().setAnimDuration(Math.max(0.1, Number(e.target.value)))}
              />
              s
            </label>
            <label>
              FPS
              <input
                type="number"
                min={1}
                step={1}
                value={animFps}
                onChange={(e) => st().setAnimFps(Math.max(1, Math.round(Number(e.target.value))))}
              />
            </label>
          </div>

          <label className="slider-row">
            <span className="slider-label">Insert at</span>
            <input
              type="range"
              min={0}
              max={animDuration}
              step={1 / animFps}
              value={insertTime}
              onChange={(e) => st().setInsertTime(Number(e.target.value))}
            />
            <EditableValue
              value={insertTime}
              min={0}
              max={animDuration}
              onChange={(v) => st().setInsertTime(v)}
              format={(v) => v.toFixed(2) + 's'}
              label="Insert keyframe at (seconds)"
            />
          </label>

          <FrameStepper
            time={insertTime}
            duration={animDuration}
            fps={animFps}
            onChange={(t) => st().setInsertTime(t)}
          />

          <div className="kf-actions" style={{ alignItems: 'center' }}>
            <input
              type="number"
              min={1}
              step={1}
              value={blankFrames}
              onChange={(e) => setBlankFrames(Math.max(1, Math.round(Number(e.target.value))))}
              className="text-input"
              style={{ width: 60 }}
              title="How many blank frames to insert"
            />
            <button
              className="btn secondary"
              onClick={onInsertBlank}
              title="Push every keyframe at or after the insert time later by this many frames, opening a hold/gap"
            >
              Insert blank frames
            </button>
          </div>

          <div className="kf-actions">
            <button
              className="btn secondary"
              onClick={onAddKey}
              disabled={!selectedBoneName}
              title="Save the currently-selected joint's rotation at this time"
            >
              Key selected joint
            </button>
            <button
              className="btn secondary"
              onClick={onKeyAll}
              title="Save every joint you've posed, at this time"
            >
              Key whole pose
            </button>
          </div>

          <button
            className="btn secondary"
            style={{ marginTop: 6 }}
            onClick={onKeyPosition}
            title="Save the character's world position at this time (move it in Objects first)"
          >
            Keyframe position {animData.root && animData.root.length ? `(${animData.root.length})` : ''}
          </button>

          {kfMsg && <div className="pose-msg">{kfMsg}</div>}

          {/* All keyframes: click a row to jump there (re-pose + re-key to edit),
              or delete it. The dot marks whichever the selected joint is keyed at. */}
          <div className="field-label" style={{ marginTop: 10 }}>
            All keyframes ({allKeyframes.length})
          </div>
          <div className="kf-list">
            {allKeyframes.length === 0 && (
              <div className="empty" style={{ padding: '6px 8px' }}>
                None yet — add keyframes above, then Play.
              </div>
            )}
            {allKeyframes.map((k) => {
              const hasSelBone =
                selectedBoneName &&
                (animData.tracks[selectedBoneName] || []).some(
                  (b) => Math.abs(b.time - k.time) < 1e-6,
                )
              return (
                <div
                  key={k.time}
                  className={'kf-list-row' + (Math.abs(k.time - insertTime) < 1e-4 ? ' active' : '')}
                  title="Jump here (then re-pose and re-key to edit)"
                  onClick={() => st().setInsertTime(k.time)}
                >
                  <span className="kf-time">{k.time.toFixed(2)}s</span>
                  <span className="kf-what">
                    {k.joints > 0 && (
                      <span className={'kf-tag' + (hasSelBone ? ' sel' : '')}>
                        {k.joints} joint{k.joints > 1 ? 's' : ''}
                      </span>
                    )}
                    {k.pos && <span className="kf-tag pos">position</span>}
                    {k.parts > 0 && (
                      <span className="kf-tag">
                        {k.parts} part{k.parts > 1 ? 's' : ''}
                      </span>
                    )}
                    {k.cameras > 0 && (
                      <span className="kf-tag pos">
                        {k.cameras} camera{k.cameras > 1 ? 's' : ''}
                      </span>
                    )}
                    {k.morphs > 0 && <span className="kf-tag">{k.morphs} shape key{k.morphs > 1 ? 's' : ''}</span>}
                    {k.cut && <span className="kf-tag pos">✂ {k.cut}</span>}
                  </span>
                  <button
                    className="kf-del"
                    title="Delete all keyframes at this time"
                    onClick={(e) => {
                      e.stopPropagation()
                      st().deleteAllAtTime(k.time)
                    }}
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>

          {selectedBoneName && boneKeys.length > 0 && (
            <button
              className="btn secondary"
              style={{ marginTop: 6 }}
              onClick={() => st().deleteKeyframe(selectedBoneName, snap(insertTime))}
              title={`Remove only ${selectedBoneName}'s keyframe at the current time`}
            >
              Delete “{selectedBoneName}” key here
            </button>
          )}

          <div className="kf-actions" style={{ marginTop: 8 }}>
            <button
              className="btn secondary"
              onClick={onSaveAsClip}
              title="Turn what you've keyframed into a playable clip, usable anywhere clips are — Play a clip, Save, Export, Trim, Combine"
            >
              🎬 Save as clip
            </button>
            <button className="btn secondary" onClick={onSaveAnim}>
              Save
            </button>
            <button className="btn secondary" onClick={() => fileRef.current?.click()}>
              Load
            </button>
            <button className="btn secondary" onClick={() => st().clearAnim()}>
              Clear
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={onLoadAnim}
            />
          </div>
        </div>
      )}
    </div>
  )
}