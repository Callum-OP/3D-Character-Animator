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
  mirrorClip,
  combineClips,
  clipFromTracks,
  addGeneratedClip,
  exportClipJSON,
  importClipJSON,
  renameClip,
  describeClipBoneMismatch,
  updateRootMotionTrack,
  getClipEditKeys,
  rebakeClipFromKeys,
  markClipKeysAdopted,
  isClipKeysAdopted,
} from '../three/animation.js'
import { runWithoutHistoryCapture } from '../three/undoHistory.js'
import {
  listRecentClips,
  removeRecentClip,
  openRecentClip,
  openClipFromDisk,
  openClipFromFileObject,
  saveClipAs,
  hasFileSystemAccess as hasClipFileSystemAccess,
} from '../three/clipLibrary.js'
import { getBoneQuaternion, getPosedBones, applyPose, setPosingEnabled } from '../three/posing.js'
import { getCurrentModel, getGroundY, scrubTimeline, playAllCharacters, stopAllCharacters, pauseAllCharacters, resumeAllCharacters } from '../three/scene.js'
import * as THREE from 'three'
import { simulateRagdollClip } from '../three/ragdoll.js'
import {
  getObjectRoots,
  getObjectRootById,
  startObjectAnimation,
  pauseObjectAnimation,
  resumeObjectAnimation,
  isObjectAnimationPaused,
  stopObjectAnimation,
  scrubObjectAnimation,
} from '../three/objects.js'

// Collect every keyframe time across joints, the character position, parts and
// cameras, with a count of what's keyed at each — for the overview/manage list.
// True if a captured root-motion track actually goes anywhere (beyond float
// noise) — used to tell "this clip really does walk" apart from "there was
// nothing to preserve".
function rootTravels(keys) {
  if (!keys || keys.length < 2) return false
  const first = keys[0].pos
  let maxDist = 0
  for (const k of keys) {
    const d = Math.hypot(k.pos[0] - first[0], k.pos[1] - first[1], k.pos[2] - first[2])
    if (d > maxDist) maxDist = d
  }
  return maxDist > 0.01
}

function sampleRootKey(keys, time) {
  if (!keys?.length) return null
  if (time <= keys[0].time) return keys[0]
  if (time >= keys[keys.length - 1].time) return keys[keys.length - 1]
  let index = 0
  while (index < keys.length - 1 && keys[index + 1].time < time) index++
  const first = keys[index]
  const second = keys[index + 1]
  const alpha = (time - first.time) / (second.time - first.time || 1)
  const quat = new THREE.Quaternion(...first.quat).slerp(new THREE.Quaternion(...second.quat), alpha)
  return {
    time,
    pos: first.pos.map((value, axis) => value + (second.pos[axis] - value) * alpha),
    quat: quat.toArray(),
  }
}

function mergeRootMotionTracks(existing, baked) {
  if (!baked?.length) return existing || []
  const bakedKeys = [...baked].sort((a, b) => a.time - b.time)
  if (!existing?.length) return bakedKeys
  const existingKeys = [...existing].sort((a, b) => a.time - b.time)
  const times = [...new Set([...existingKeys, ...bakedKeys].map((key) => key.time))].sort((a, b) => a - b)
  const bakedStart = bakedKeys[0].pos
  return times.map((time) => {
    const original = sampleRootKey(existingKeys, time)
    const motion = sampleRootKey(bakedKeys, time)
    return {
      time,
      pos: original
        ? original.pos.map((value, axis) => value + motion.pos[axis] - bakedStart[axis])
        : motion.pos,
      quat: original?.quat || motion.quat,
    }
  })
}

function captureCurrentPose() {
  return (getCurrentModel()?.bones || []).map((bone) => ({
    name: bone.name,
    quat: bone.quaternion.toArray(),
    pos: bone.position.toArray(),
  }))
}

// True if a mesh/morph track map has at least one non-empty entry.
// `nested` = true for morph maps ({ meshIndex: { morphName: keys[] } }),
// false for plain mesh transform maps ({ meshIndex: keys[] }).
function hasAny(tracks, nested = false) {
  if (!tracks) return false
  return Object.values(tracks).some((v) =>
    nested ? v && Object.values(v).some((keys) => keys && keys.length) : v && v.length,
  )
}

function collectKeyframes(animData) {
  const map = new Map()
  const entry = (t) => {
    const e = map.get(t) || { time: t, joints: 0, pos: false, parts: 0, cameras: 0, lights: 0, morphs: 0, cut: null }
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
  for (const keys of Object.values(animData.lights || {})) {
    for (const k of keys) entry(k.time).lights++
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

function ObjectMovementEditor({ onScrub, onCharacterKeyframe, onCharacterTrackChange }) {
  const allSceneObjects = useStore((s) => s.sceneObjects)
  const selectedObjectId = useStore((s) => s.selectedObjectId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const objectAnimData = useStore((s) => s.objectAnimData)
  const duration = useStore((s) => s.objectAnimDuration)
  const time = useStore((s) => s.objectAnimTime)
  const playing = useStore((s) => s.objectAnimPlaying)
  const autoKey = useStore((s) => s.objectAutoKeyMovement)
  const fps = useStore((s) => s.animFps)
  const loop = useStore((s) => s.loop)
  const modelInfo = useStore((s) => s.modelInfo)
  const animData = useStore((s) => s.animData)
  const currentTime = useStore((s) => s.currentTime)
  const playback = useStore((s) => s.playback)
  const source = useStore((s) => s.playbackSource)
  const animDuration = useStore((s) => s.animDuration)
  const autoKeyMovement = useStore((s) => s.autoKeyMovement)
  const rippleRootEdit = useStore((s) => s.rippleRootEdit)
  const selected =
    allSceneObjects.find((object) => object.id === selectedObjectId) ||
    (!selectedObjectId && modelInfo
      ? allSceneObjects.find((object) => object.isCharacter && object.characterId === activeCharacterId)
      : null)
  const isCharacter = !!selected?.isCharacter
  const keys = selected?.animationKey ? objectAnimData[selected.animationKey] || [] : []
  const characterKeys = animData.root || []
  const characterTime = Math.min(currentTime, source === 'edit' ? animDuration : duration)
  const characterPlaying = playback === 'playing'
  const [message, setMessage] = useState('')
  const st = useStore.getState

  function onKeyframe() {
    const root = selected && getObjectRootById(selected.id)
    if (!root) return
    const keyTime = Math.round((isCharacter ? characterTime : time) * fps) / fps
    if (isCharacter) {
      const key = {
        time: keyTime,
        pos: root.position.toArray(),
        quat: root.quaternion.toArray(),
      }
      if (onCharacterKeyframe) onCharacterKeyframe(key)
      else st().addRootKeyframe(keyTime, key.pos, key.quat, rippleRootEdit)
      setMessage(`Saved ${selected.name}'s position at ${keyTime.toFixed(2)}s.`)
      return
    }
    if (!selected.animationKey) return
    st().addObjectTransformKeyframe(selected.animationKey, keyTime, {
      position: root.position.toArray(),
      quaternion: root.quaternion.toArray(),
      scale: root.scale.toArray(),
    })
    setMessage(`Saved ${selected.name} at ${keyTime.toFixed(2)}s. Add another key at a different time to create a smooth transition.`)
  }

  function onPlay() {
    if (playing) {
      pauseObjectAnimation()
      return
    }
    if (!startObjectAnimation()) setMessage('Add at least one object keyframe before playing.')
  }

  if (isCharacter) {
    return (
      <div className="movement-track">
        <div className="movement-heading">Character movement</div>
        <p className="panel-hint">
          Move the character in the scene and key its position at the current character playhead.
        </p>

        <div className="kf-actions">
          <button className="btn secondary" onClick={onKeyframe} disabled={!selected || characterPlaying}>
            Key position{characterKeys.length ? ` (${characterKeys.length})` : ''}
          </button>
          <button
            className="btn secondary"
            onClick={() => st().setRippleRootEdit(!rippleRootEdit)}
            aria-pressed={rippleRootEdit}
            title="When you change a position key, carry that change forward to later position keys."
          >
            {rippleRootEdit ? '✓ ' : ''}Carry edits forward
          </button>
        </div>

        <label className="toggle-row" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={autoKeyMovement}
            onChange={(event) => st().setAutoKeyMovement(event.target.checked)}
          />
          Auto-key when moving the character
        </label>

        {characterKeys.length > 0 && (
          <div className="kf-list" style={{ marginTop: 8 }}>
            {characterKeys.map((key) => (
              <div
                key={key.time}
                className={'kf-list-row' + (Math.abs(key.time - characterTime) < 1e-4 ? ' active' : '')}
                title="Select this position on the timeline"
                role="button"
                tabIndex={0}
                onClick={() => onScrub(key.time)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onScrub(key.time)
                  }
                }}
              >
                <span onClick={(event) => event.stopPropagation()}>
                  <EditableValue
                    value={key.time}
                    min={0}
                    max={source === 'edit' ? animDuration : duration}
                    onChange={(nextTime) => {
                      const snappedTime = Math.round(nextTime * fps) / fps
                      st().moveRootKeyframe(key.time, snappedTime)
                      onCharacterTrackChange?.(snappedTime)
                    }}
                    format={(value) => `${value.toFixed(2)}s`}
                    className="kf-time"
                    label={`Position key time, currently ${key.time.toFixed(2)} seconds`}
                  />
                </span>
                <span className="kf-what">{selected.name} position</span>
                <button
                  className="kf-del"
                  title="Delete this position keyframe"
                  onClick={(event) => {
                    event.stopPropagation()
                    st().deleteRootKeyframe(key.time)
                    onCharacterTrackChange?.(characterTime)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {message && <div className="pose-msg">{message}</div>}
      </div>
    )
  }

  return (
    <div className="panel movement-panel">
      <div className="movement-heading">Object movement</div>
      <p className="panel-hint">
        Move the selected object, set a time, and key its position. Playback smoothly transitions between keys.
      </p>

      <div className="kf-numbers">
        <label>
          Duration
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={duration}
            onChange={(event) => st().setObjectAnimDuration(Math.max(0.1, Number(event.target.value)))}
          />
          s
        </label>
      </div>

      <label className="slider-row">
        <span className="slider-label">Time</span>
        <input
          type="range"
          min={0}
          max={duration}
          step={1 / fps}
          value={Math.min(time, duration)}
          disabled={playing}
          onChange={(event) => scrubObjectAnimation(Number(event.target.value))}
        />
        <EditableValue
          value={time}
          min={0}
          max={duration}
          onChange={scrubObjectAnimation}
          format={(value) => value.toFixed(2) + 's'}
          label="Animation time"
        />
      </label>

      <div className="kf-actions">
        <button className="btn secondary" onClick={() => scrubObjectAnimation(0)} disabled={playing}>Start</button>
        <button className="btn secondary" onClick={() => scrubObjectAnimation(duration)} disabled={playing}>End</button>
        <button className="btn secondary" onClick={onKeyframe} disabled={!selected || playing}>
          Key selected object{keys.length ? ` (${keys.length})` : ''}
        </button>
      </div>

      <div className="kf-actions" style={{ marginTop: 8 }}>
        <button className="btn" onClick={onPlay} disabled={!playing && !Object.values(objectAnimData).some((track) => track.length)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button className="btn secondary" onClick={stopObjectAnimation}>Stop</button>
        <label className="toggle-row" style={{ flex: '0 0 auto', margin: 0 }}>
          <input type="checkbox" checked={loop} onChange={(event) => st().setLoop(event.target.checked)} />
          Loop
        </label>
      </div>

      <label className="toggle-row" style={{ marginTop: 8 }} title="Save a keyframe automatically whenever you finish moving the selected object.">
        <input type="checkbox" checked={autoKey} onChange={(event) => st().setObjectAutoKeyMovement(event.target.checked)} />
        Auto-key when moving objects
      </label>

      {keys.length > 0 && (
        <div className="kf-list" style={{ marginTop: 8 }}>
          {keys.map((key) => (
            <div key={key.time} className={'kf-list-row' + (Math.abs(key.time - time) < 1e-4 ? ' active' : '')}>
              <button className="kf-time" onClick={() => scrubObjectAnimation(key.time)}>{key.time.toFixed(2)}s</button>
              <span className="kf-what">{selected.name}</span>
              <button className="kf-del" title="Delete this keyframe" onClick={() => st().deleteObjectTransformKeyframe(selected.animationKey, key.time)}>×</button>
            </div>
          ))}
        </div>
      )}

      {message && <div className="pose-msg">{message}</div>}
    </div>
  )
}

// Side-panel section: play baked clips or author a simple in-app keyframe
// animation. Playback drives the bones, so it's mutually exclusive with posing —
// the engine suspends the gizmo while a clip is armed and restores the rest pose
// on Stop.
export default function AnimationPanel() {
  const modelInfo = useStore((s) => s.modelInfo)
  const sceneObjects = useStore((s) => s.sceneObjects)
  const selectedObjectId = useStore((s) => s.selectedObjectId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
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
  const objectAnimData = useStore((s) => s.objectAnimData)
  const hasObjectAnimation = Object.values(objectAnimData || {}).some((keys) => keys && keys.length)
  const objectAnimPlaying = useStore((s) => s.objectAnimPlaying)
  // Anything at all running (the active character, or object motion). Other
  // characters' playing state isn't in the store, but Play all / Pause all
  // start and stop them together with the active one.
  const anythingPlaying = playback === 'playing' || objectAnimPlaying

  const st = useStore.getState // for imperative setters inside handlers
  const bvhRef = useRef(null)
  const clipFileRef = useRef(null)
  const [bvhMsg, setBvhMsg] = useState(null)
  const [clipBoneWarning, setClipBoneWarning] = useState(null) // set when a selected/imported clip doesn't match this model's bones
  const [recentClips, setRecentClips] = useState([])
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
  // "Keep original movement" — when baking a clip (e.g. mocap) to editable
  // keyframes, also carry over the root/hip's world travel so a walk clip
  // doesn't end up walking on the spot once it's editable.
  const [preserveMotion, setPreserveMotion] = useState(true)
  // When a BVH is parsed, this holds the mapping editor state until the user
  // confirms (Retarget) or cancels: { name, sourceBones, targetBones, slots }.
  const [mapping, setMapping] = useState(null)
  // Which mapping slot (by key) is waiting for a click on a bone dot in the
  // viewport — set by the "Pick" button next to a slot's rig-bone dropdown.
  // Lets generic/renamed rigs be mapped by clicking the bone you can SEE
  // (the neck, a wrist...) instead of hunting for its name in the dropdown.
  const [pickingSlotKey, setPickingSlotKey] = useState(null)
  const mode = useStore((s) => s.mode)
  const pickBaselineRef = useRef(null) // selectedBoneName at the moment picking was armed, so we don't grab a stale/already-selected bone
  const selectedSceneObject =
    sceneObjects.find((object) => object.id === selectedObjectId) ||
    (!selectedObjectId && modelInfo
      ? sceneObjects.find((object) => object.isCharacter && object.characterId === activeCharacterId)
      : null)
  const hasCharacterSelected = selectedSceneObject ? !!selectedSceneObject.isCharacter : !!modelInfo

  useEffect(() => {
    refreshRecentClips()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Space = play/pause, ←/→ = step the shared character playhead. Re-registered every render so the
  // handler always closes over fresh state; ignored while typing in a field.
  useEffect(() => {
    function onKey(e) {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable)
        return
      if (!modelInfo || !hasCharacterSelected) return
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
          onScrub(step(currentTime, animDuration))
        } else if (source === 'edit' || activeClipName) {
          e.preventDefault()
          onScrub(step(currentTime, source === 'edit' ? animDuration : duration))
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // While a slot is armed, a change in the picked bone (from clicking a dot
  // in the viewport) assigns it as that slot's rig-bone target, then hands
  // bone-picking back to whatever the app's normal mode dictates.
  //
  // These three effects must run on every render, even when nothing is
  // loaded — see the comment on the early returns just below for why moving
  // them here (above both `if (!modelInfo) return null` and `if (!hasClips
  // && !hasBones) return null`) is not just tidiness but a correctness fix:
  // conditionally skipping hooks after an early return is a rules-of-hooks
  // violation (React error #300, "rendered fewer hooks than expected") the
  // moment this component re-renders with modelInfo flipping from set to
  // null on the SAME mounted instance — exactly what happens on Clear, and
  // during a project reload's brief moment with no character loaded yet.
  // AnimationPanel stays mounted across both (unlike BonePanel/MeshPanel,
  // which unmount via their own Accordion's `mode === …` condition in
  // App.jsx), so it's the one place in this file that previously called
  // hooks after a conditional return. See Titlebar.blackscreen.test.js.
  useEffect(() => {
    if (!pickingSlotKey) return
    if (!selectedBoneName || selectedBoneName === pickBaselineRef.current) return
    setSlot(pickingSlotKey, 'target', selectedBoneName)
    setPickingSlotKey(null)
    setPosingEnabled(mode === 'bone')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBoneName])

  // Esc cancels an armed pick without assigning anything.
  useEffect(() => {
    if (!pickingSlotKey) return
    function onKey(e) {
      if (e.key === 'Escape') onCancelPickTarget()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickingSlotKey])

  // Leaving the mapping editor (Retarget/Cancel) while a pick is still armed
  // shouldn't leave bone-picking force-enabled behind.
  useEffect(() => {
    if (!mapping && pickingSlotKey) {
      setPickingSlotKey(null)
      setPosingEnabled(mode === 'bone')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping])

  useEffect(() => {
    if (!modelInfo || !hasCharacterSelected || source !== 'edit' || Math.abs(insertTime - currentTime) <= 1e-6) return
    if (playback === 'playing') {
      st().setInsertTime(currentTime)
    } else {
      if (playback === 'stopped') {
        const editDuration = selectEdit(animData, animDuration, { loop, speed })
        st().setDuration(editDuration)
        st().setPlayback('paused')
      }
      scrubTimeline(insertTime)
      st().setCurrentTime(insertTime)
    }
  }, [currentTime, insertTime, playback, source, st, modelInfo, hasCharacterSelected, animData, animDuration, loop, speed])
  if (!modelInfo || !hasCharacterSelected) {
    return selectedSceneObject ? <ObjectMovementEditor onScrub={onScrub} /> : null
  }

  const bakedNames = modelInfo.clipNames || []
  const clipNames = [...bakedNames, ...importedClipNames]
  const bones = modelInfo.bones || []
  const hasBones = bones.length > 0
  // The clip source is available if there are baked clips, imported mocap, OR a
  // skeleton to import mocap onto.
  const hasClips = clipNames.length > 0
  if (!hasClips && !hasBones) {
    return selectedSceneObject ? <ObjectMovementEditor onScrub={onScrub} /> : null
  }

  const displayDuration = source === 'edit' ? animDuration : duration
  const snap = (t) => Math.round(t * animFps) / animFps // to the fps grid
  const boneKeys = (selectedBoneName && animData.tracks[selectedBoneName]) || []
  const allKeyframes = collectKeyframes(animData)

  // --- transport handlers ---------------------------------------------------

  // A clip made with "Save as clip" remembers the keyframes it was built from.
  // Selecting it loads those keys back into the editor (position keys list,
  // delete/move/add) so edits rebuild the clip rather than only touching a
  // live overlay while the baked clip keeps its old pose. Returns true when the
  // editor now mirrors the clip's keys. Never silently throws away unsaved
  // keyframes: if the editor holds different ones, it asks first.
  function adoptClipKeys(name) {
    const keys = name ? getClipEditKeys(name) : null
    if (!keys) {
      markClipKeysAdopted(null)
      return false
    }
    const cur = st().animData
    const fingerprint = (tracks, root) => JSON.stringify([tracks || {}, root || []])
    if (fingerprint(cur.tracks, cur.root) !== fingerprint(keys.tracks, keys.root)) {
      const hasCurrent = Object.keys(cur.tracks || {}).length > 0 || (cur.root || []).length > 0
      if (
        hasCurrent &&
        !window.confirm(
          `“${name}” remembers its own keyframes. Load them into the editor? This replaces the keyframes currently in “Edit keyframes” (they are not saved as a clip).`,
        )
      ) {
        markClipKeysAdopted(null)
        return false
      }
      runWithoutHistoryCapture(() => {
        st().setAnimData({ ...cur, tracks: keys.tracks, root: keys.root })
      })
    }
    markClipKeysAdopted(name)
    return true
  }

  // Rebuild the selected (remembered-keys) clip from the editor's current keys.
  function rebakeAdoptedClip(minDuration = 0) {
    if (!activeClipName || !isClipKeysAdopted(activeClipName)) return false
    const store = st()
    const duration = Math.max(getClipEditKeys(activeClipName)?.duration || 0, minDuration)
    const ok = rebakeClipFromKeys(activeClipName, {
      tracks: store.animData.tracks,
      root: store.animData.root,
      duration,
    })
    if (ok) store.setDuration(duration)
    return ok
  }

  function onSourceChange(next) {
    stop()
    st().setPlayback('stopped')
    st().setCurrentTime(0)
    if (next === 'edit') st().setInsertTime(0)
    st().setPlaybackSource(next)
    if (next === 'clip' && activeClipName) {
      adoptClipKeys(activeClipName)
      const d = selectClip(activeClipName, { loop, speed }, st().animData)
      st().setDuration(d)
      st().setPlayback('paused')
      setClipBoneWarning(describeClipBoneMismatch(activeClipName))
    } else if (next === 'edit') {
      st().setDuration(animDuration)
    }
  }

  function onClipChange(name) {
    st().setActiveClipName(name || null)
    stop()
    if (!name) {
      st().setPlaybackSource('clip')
      st().setPlayback('stopped')
      st().setDuration(0)
      setClipBoneWarning(null)
      return
    }
    st().setPlaybackSource('clip')
    adoptClipKeys(name)
    const d = selectClip(name, { loop, speed }, st().animData)
    st().setDuration(d)
    st().setCurrentTime(0)
    st().setPlayback('paused')
    setClipBoneWarning(describeClipBoneMismatch(name))
  }

  function onPlay() {
    if (source === 'edit') {
      const d = selectEdit(animData, animDuration, { loop, speed })
      st().setDuration(d)
    } else if (!activeClipName) {
      return
    } else if (playback === 'stopped') {
      const d = selectClip(activeClipName, { loop, speed }, animData)
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
    st().setInsertTime(0)
  }

  // Start every loaded character playing whatever it currently has selected
  // (this one's included) — lets several characters perform their own clips
  // at the same time.
  function onPlayAll() {
    const store = useStore.getState()
    // Paused part-way (via Pause all)? Pick up where everything left off
    // rather than restarting every clip from 0.
    const charactersResumed = store.playback === 'paused' ? resumeAllCharacters() : 0
    const objectResumed = isObjectAnimationPaused() ? (resumeObjectAnimation() > 0 ? 1 : 0) : 0
    if (charactersResumed + objectResumed > 0) {
      setKfMsg('Resumed all animation.')
      return
    }
    const { started: charactersStarted } = playAllCharacters()
    const objectTracks = Object.values(store.objectAnimData || {}).filter((keys) => keys && keys.length)
    const objectStarted = objectTracks.length > 0 ? (startObjectAnimation() > 0 ? 1 : 0) : 0
    const started = charactersStarted + objectStarted
    setKfMsg(
      started > 1
        ? `Playing ${started} active animation tracks.`
        : started === 1
          ? 'Playing the current scene animation.'
          : 'Nothing to play — pick a clip or create object motion first.',
    )
  }

  function onPauseAll() {
    pauseAllCharacters()
    pauseObjectAnimation()
    setKfMsg('Paused all animation.')
  }

  function onStopAll() {
    stopAllCharacters()
    stopObjectAnimation()
  }

  function onScrub(t) {
    // Arm the source if we're stopped so there's an action to evaluate.
    if (playback === 'stopped') {
      if (source === 'edit') {
        const d = selectEdit(animData, animDuration, { loop, speed })
        st().setDuration(d)
      } else if (activeClipName) {
        selectClip(activeClipName, { loop, speed }, animData)
      }
      st().setPlayback('paused')
    } else if (playback === 'playing') {
      pause()
      st().setPlayback('paused')
    }
    scrubTimeline(t)
    st().setCurrentTime(t)
    if (source === 'edit') st().setInsertTime(t)
  }

  function refreshCharacterAtTime(time) {
    const store = st()
    if (source === 'edit') {
      selectEdit(store.animData, store.animDuration, { loop, speed })
    } else if (activeClipName) {
      selectClip(activeClipName, { loop, speed }, store.animData)
    } else {
      return
    }
    scrubTimeline(time)
    store.setCurrentTime(time)
    store.setPlayback('paused')
  }

  function onCharacterKeyframe({ time, pos, quat }) {
    if (source === 'clip' && activeClipName) {
      if (isClipKeysAdopted(activeClipName)) {
        // The clip remembers its keys: add to them and rebuild the clip (a key
        // past the end lengthens it) instead of converting it to a bake.
        st().addRootKeyframe(time, pos, quat, st().rippleRootEdit)
        st().addKeyframesAtTime(captureCurrentPose(), time)
        rebakeAdoptedClip(time)
        updateRootMotionTrack(st().animData.root)
        refreshCharacterAtTime(time)
        return
      }
      onBake({ keyPosition: { time, pos, quat }, time })
      return
    }
    st().addRootKeyframe(time, pos, quat, st().rippleRootEdit)
    st().addKeyframesAtTime(captureCurrentPose(), time)
    updateRootMotionTrack(st().animData.root)
    refreshCharacterAtTime(time)
  }

  // Called after position keys are deleted or moved. Position keys carry a
  // full-body pose key at the same time, so the baked playback clip must be
  // REBUILT from the store every time — merely re-sampling the old clip (what
  // this did unless playback was fully stopped) left the deleted pose baked
  // in, so the character still changed pose there with no key shown.
  function onCharacterTrackChange(time) {
    if (st().playback === 'playing') {
      pause()
      st().setPlayback('paused')
    }
    const store = st()
    if (source === 'edit') {
      selectEdit(store.animData, store.animDuration, { loop, speed })
    } else if (activeClipName) {
      // A saved clip bakes its poses into the clip itself, so the clip has to
      // be rebuilt from the edited keys — re-selecting the old one would keep
      // the deleted pose.
      rebakeAdoptedClip()
      selectClip(activeClipName, { loop, speed }, st().animData)
    }
    store.setPlayback('paused')
    updateRootMotionTrack(st().animData.root)
    scrubTimeline(time)
    st().setCurrentTime(time)
    if (source === 'edit') st().setInsertTime(time)
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

  // Raw "download the whole keyframe timeline as anim-v1 JSON" / "load one
  // back" buttons used to live here, as a second way to save the same work
  // "Save as clip" already covers. That's now the one path: turn what
  // you've keyframed into a clip, then use Open Clip / Save Clip As on it
  // like anything else under "Play a clip".

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

  // Arm "click a bone on the character" for one slot's rig-bone target — or,
  // if a bone is already selected (e.g. the user cycled to the right one by
  // clicking it a few times first), use that immediately instead of making
  // them click it again. Turns on bone picking in the viewport (even if the
  // app isn't currently in Bone/Pose mode) so the dots are visible and
  // clickable; the effect below catches the resulting selection.
  function onStartPickTarget(key) {
    if (selectedBoneName) {
      setSlot(key, 'target', selectedBoneName)
      return
    }
    pickBaselineRef.current = selectedBoneName
    setPickingSlotKey(key)
    setPosingEnabled(true)
  }

  function onCancelPickTarget() {
    setPickingSlotKey(null)
    setPosingEnabled(mode === 'bone')
  }

  // While a slot is armed, a change in the picked bone (from clicking a dot
  // in the viewport) assigns it as that slot's rig-bone target, then hands
  // bone-picking back to whatever the app's normal mode dictates. (Moved
  // above the early returns near the top of the component — see the comment
  // there for why.)

  async function onRetarget() {
    setBvhBusy(true)
    try {
      const { name, matched, total } = await applyBVHRetarget(mapping.slots)
      st().addImportedClipName(name)
      st().setPlaybackSource('clip')
      st().setActiveClipName(name)
      const d = selectClip(name, { loop, speed }, animData)
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
    const d = selectClip(name, { loop, speed }, animData)
    st().setDuration(d)
    st().setCurrentTime(0)
    play()
    st().setPlayback('playing')
    setRagdollMsg(`Flop! Saved as the clip “${name}” — replay it any time from the clip list.`)
  }

  function onBake({ keyPosition = null, time = currentTime } = {}) {
    if (!activeClipName) return
    const res = bakeClipToTracks(activeClipName, animFps, duration || undefined, preserveMotion)
    if (!res) return
    // Guard against a capture that found no real travel (e.g. a clip with no
    // position data to preserve) silently wiping out root keys the user
    // already set up by hand — only treat the bake as "kept the movement"
    // when it actually moved by a meaningful amount.
    const gotRoot = preserveMotion && res.root && res.root.length > 1 && rootTravels(res.root)
    // Layer clip travel over authored character placement rather than
    // replacing the user's position keys with the baked clip's path.
    const nextData = {
      ...animData,
      tracks: res.tracks,
      root: gotRoot ? mergeRootMotionTracks(animData.root, res.root) : animData.root,
    }
    const editDuration = Math.max(res.duration, ...collectKeyframes(nextData).map((key) => key.time))
    const editTime = Math.min(time, editDuration)
    stop()
    st().setAnimData(nextData)
    st().setAnimDuration(editDuration)
    st().setPlaybackSource('edit')
    st().setPlayback('stopped')
    const editClipDuration = selectEdit(nextData, editDuration, { loop, speed })
    st().setDuration(editClipDuration)
    st().setPlayback('paused')
    scrubTimeline(editTime)
    st().setCurrentTime(editTime)
    st().setInsertTime(editTime)

    if (keyPosition) {
      st().addRootKeyframe(keyPosition.time, keyPosition.pos, keyPosition.quat, st().rippleRootEdit)
      st().addKeyframesAtTime(captureCurrentPose(), keyPosition.time)
      const keyedData = st().animData
      updateRootMotionTrack(keyedData.root)
      selectEdit(keyedData, editDuration, { loop, speed })
      scrubTimeline(keyPosition.time)
      st().setCurrentTime(keyPosition.time)
      st().setInsertTime(keyPosition.time)
    }

    setBvhMsg(
      keyPosition
        ? `Baked the clip and saved its current pose and character position at ${keyPosition.time.toFixed(2)}s.`
        : gotRoot
        ? `Baked ${Object.keys(res.tracks).length} moving track(s) to keyframes, plus its original movement (${res.root.length} root key(s)) — it'll still walk forward.`
        : preserveMotion
          ? `Baked ${Object.keys(res.tracks).length} moving track(s) to keyframes. No root/hip travel was found in this clip to carry over.`
          : `Baked ${Object.keys(res.tracks).length} moving track(s) to keyframes.`,
    )
  }

  function onEditKeyframes() {
    if (source === 'edit') return
    if (activeClipName) {
      onBake()
      return
    }
    onSourceChange('edit')
  }

  function onNewAnimation() {
    if (allKeyframes.length && !window.confirm('Start a new animation? This clears the current editable keyframes but keeps your clips.')) {
      return
    }
    if (playback !== 'stopped') stop()
    st().clearAnim()
    st().setPlaybackSource('edit')
    st().setActiveClipName(null)
    st().setAnimDuration(2)
    st().setCurrentTime(0)
    st().setInsertTime(0)
    const emptyData = useStore.getState().animData
    const d = selectEdit(emptyData, 2, { loop, speed })
    st().setDuration(d)
    st().setPlayback('paused')
    setKfMsg('New animation ready. Pose the character at the playhead, then add a keyframe.')
  }

  // Bridge back the other way: turn what you've keyframed in "Make your own"
  // into a real clip, so it immediately has the same Save/Export/Trim/Combine
  // tools as anything under "Play a clip".
  function onSaveAsClip() {
    const nameGuess = activeClipName ? `${activeClipName} (edited)` : 'My clip'
    // Carry animData.root (hand-keyed position keys, or a preserveMotion
    // bake's captured travel) into the saved clip itself — otherwise it only
    // exists as a live overlay tied to this editing session and gets lost
    // the moment the clip is saved to a file and reopened later (see
    // clipFromTracks).
    // Mesh-transform (Mesh mode) and shape-key (morph) edits ride along too —
    // see clipFromTracks — so they come back if this clip is reopened later,
    // including on a different character (whatever meshes/morphs it doesn't
    // have are just skipped).
    const name = clipFromTracks(animData.tracks, animDuration, nameGuess, animData.root, animData.meshes, animData.morphs)
    if (!name) return
    const extra = []
    if (hasAny(animData.meshes)) extra.push('mesh edits')
    if (hasAny(animData.morphs, true)) extra.push('shape keys')
    stop()
    armClip(name)
    setKfMsg(
      extra.length
        ? `Saved as the clip “${name}” (including ${extra.join(' and ')}) — find it under Play a clip, with the same tools.`
        : `Saved as the clip “${name}” — find it under Play a clip, with the same tools.`,
    )
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

  // --- clip files (Open Clip / Save Clip As / Recent Clips) -----------------
  //
  // One file-based flow, matching the Project panel: a clip is a real file
  // on disk, "Save Clip As…" writes it out, "Open Clip…" reads one back in,
  // and Recent Clips is a quick-access list of the last few (with real file
  // handles where the browser supports them, so reopening doesn't need a
  // picker). This replaces the old three-button spread of a browser-only
  // "library" plus a separate download/upload pair.

  // Bring a freshly-registered clip (from a file) straight into the
  // transport, paused on frame 0 — mirrors what BVH retarget/ragdoll do.
  function armClip(name) {
    st().addImportedClipName(name)
    st().setPlaybackSource('clip')
    st().setActiveClipName(name)
    adoptClipKeys(name)
    const d = selectClip(name, { loop, speed }, st().animData)
    st().setDuration(d)
    st().setCurrentTime(0)
    st().setPlayback('paused')
    setClipBoneWarning(describeClipBoneMismatch(name))
  }

  async function refreshRecentClips() {
    try {
      setRecentClips(await listRecentClips())
    } catch {
      /* IndexedDB unavailable (e.g. private mode) — leave the list empty */
    }
  }

  async function onSaveClipAs() {
    if (!activeClipName) return
    const json = exportClipJSON(activeClipName)
    if (!json) return
    try {
      const { name } = await saveClipAs(json, activeClipName)
      setBvhMsg(`Saved “${name}”.`)
      refreshRecentClips()
    } catch (err) {
      if (err?.name !== 'AbortError') setBvhMsg('Save failed: ' + (err.message || String(err)))
    }
  }

  async function onOpenClip() {
    try {
      if (hasClipFileSystemAccess()) {
        const { json, name } = await openClipFromDisk()
        const clipName = importClipJSON(json)
        if (!clipName) throw new Error('Load a model first.')
        armClip(clipName)
        setBvhMsg(`Opened “${name}”.`)
        refreshRecentClips()
      } else {
        clipFileRef.current?.click()
      }
    } catch (err) {
      if (err?.name !== 'AbortError' && err?.message !== 'FILE_SYSTEM_ACCESS_UNAVAILABLE') {
        setBvhMsg('Open failed: ' + (err.message || String(err)))
      }
    }
  }

  function onImportClipFile(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    openClipFromFileObject(file)
      .then(({ json, name }) => {
        const clipName = importClipJSON(json)
        if (!clipName) throw new Error('Load a model first.')
        armClip(clipName)
        setBvhMsg(`Opened “${name}”.`)
        refreshRecentClips()
      })
      .catch((err) => setBvhMsg(err.message || String(err)))
  }

  async function onOpenRecentClip(recent) {
    try {
      const { json, name } = await openRecentClip(recent)
      const clipName = importClipJSON(json)
      if (!clipName) throw new Error('Load a model first.')
      armClip(clipName)
      setBvhMsg(`Opened “${name}”.`)
      refreshRecentClips()
    } catch (err) {
      setBvhMsg('Could not reopen that file: ' + (err.message || String(err)))
    }
  }

  async function onRemoveRecentClip(id, e) {
    e.stopPropagation()
    try {
      await removeRecentClip(id)
      refreshRecentClips()
    } catch {
      /* ignore */
    }
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

    // --- mirror ------------------------------------------------------------

  function onMirrorClip() {
    if (!activeClipName) return
    const newName = mirrorClip(activeClipName, animFps)
    if (!newName) {
      setBvhMsg("Couldn't mirror that clip.")
      return
    }
    armClip(newName)
    setBvhMsg(`Created “${newName}” — the whole clip flipped left ↔ right. The original clip is untouched.`)
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
    <>
    <div className="panel">
      <h2>Character animation</h2>
      <p className="panel-hint">
        Play a clip as-is, edit its poses, or start a new animation. Character movement is a separate track on the same playhead.
      </p>

      <div className="seg">
        <button
          className={'seg-btn' + (source === 'clip' ? ' active' : '')}
          disabled={!hasClips}
          onClick={() => onSourceChange('clip')}
          title="Choose and play a built-in or imported motion clip"
        >
          Play a clip
        </button>
        <button
          className={'seg-btn' + (source === 'edit' ? ' active' : '')}
          disabled={!hasBones || (source === 'clip' && playing)}
          onClick={onEditKeyframes}
          title={activeClipName ? 'Convert the selected clip to editable keyframes; the original clip remains available' : 'Create or edit motion using keyframes'}
        >
          Edit keyframes
        </button>
      </div>

      <div className="clip-source-row">
        <select
          className="select"
          value={activeClipName || ''}
          onChange={(e) => onClipChange(e.target.value)}
          aria-label="Character motion clip"
        >
          <option value="">Choose a motion clip…</option>
          {clipNames.map((name, i) => (
            <option key={i} value={name}>
              {name || `(clip ${i + 1})`}
            </option>
          ))}
        </select>
        {hasBones && (
          <button className="btn secondary" onClick={() => bvhRef.current?.click()} disabled={bvhBusy}>
            {bvhBusy ? 'Importing…' : 'Import BVH…'}
          </button>
        )}
        <button className="btn secondary" onClick={onOpenClip}>Open clip…</button>
        <input ref={bvhRef} type="file" accept=".bvh" style={{ display: 'none' }} onChange={onPickBVH} />
        <input
          ref={clipFileRef}
          type="file"
          accept=".3dclip,.json,application/json"
          style={{ display: 'none' }}
          onChange={onImportClipFile}
        />
      </div>

      {source === 'edit' && hasBones && (
        <div className="kf-actions" style={{ marginTop: 8 }}>
          <button className="btn secondary" onClick={onNewAnimation}>
            New animation
          </button>
        </div>
      )}

      {selectedSceneObject && (
        <ObjectMovementEditor
          onScrub={onScrub}
          onCharacterKeyframe={onCharacterKeyframe}
          onCharacterTrackChange={onCharacterTrackChange}
        />
      )}

      {source === 'clip' && !mapping && (
        <>
          {clipBoneWarning && activeClipName && (
            <div className="pose-msg pose-msg-warn">⚠ {clipBoneWarning}</div>
          )}

          <button
            className="btn secondary"
            style={{ marginTop: 8, width: '100%' }}
            onClick={() => setToolsOpen((v) => !v)}
          >
            🛠 Manage clips {toolsOpen ? '▲' : '▼'}
          </button>

          {toolsOpen && (
            <div style={{ marginTop: 4 }}>
              {activeClipName && importedClipNames.includes(activeClipName) && !renameOpen && (
                <button className="btn secondary" style={{ marginTop: 6 }} onClick={onOpenRename} title="Rename this clip">
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
                    <button className="btn" onClick={onConfirmRename}>Save</button>
                    <button className="btn secondary" onClick={() => setRenameOpen(false)}>Cancel</button>
                  </div>
                </div>
              )}

              {activeClipName && (
                <div className="kf-actions" style={{ marginTop: 6 }}>
                  <button
                    className="btn secondary"
                    onClick={onSaveClipAs}
                    title="Save this clip to a file on disk — pick where, same as Save Project As"
                  >
                    💾 Save Clip As…
                  </button>
                  <button
                    className="btn secondary"
                    onClick={() => (trimOpen ? setTrimOpen(false) : onOpenTrim())}
                    title="Cut this clip down to a shorter range, saved as a new clip"
                  >
                    ✂ Trim
                  </button>
                  <button
                    className="btn secondary"
                    onClick={onMirrorClip}
                    title="Flip the whole clip left ↔ right, frame by frame, saved as a new clip"
                  >
                    ⇄ Mirror clip
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

              {recentClips.length > 0 && (
                <>
                  <div className="field-label" style={{ marginTop: 10 }}>
                    Recent Clips ({recentClips.length})
                  </div>
                  <div className="kf-list">
                    {recentClips.map((r) => (
                      <div
                        key={r.id}
                        className="kf-list-row"
                        title={r.handle ? 'Open this clip' : 'No file handle in this browser — use "Open Clip…"'}
                      >
                        <span
                          className="kf-time"
                          style={{ cursor: r.handle ? 'pointer' : 'default' }}
                          onClick={() => r.handle && onOpenRecentClip(r)}
                        >
                          {r.name}
                        </span>
                        <span className="kf-what" />
                        <button
                          className="kf-del"
                          title="Remove from this list (does not delete the file)"
                          onClick={(e) => onRemoveRecentClip(r.id, e)}
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

      {hasBones && !mapping && (
        <details className="anim-disclosure" style={{ marginTop: 8 }}>
          <summary>More character tools</summary>
          <div className="anim-disclosure-content">
            {source === 'clip' && activeClipName && (
              <>
                <button className="btn secondary" style={{ marginTop: 6 }} onClick={onApplyFrameAsPose} title="Freeze the current frame as an editable pose">
                  Use as pose
                </button>
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12 }}
                  title="Also carry over the clip's original forward/side movement as position keyframes when editing."
                >
                  <input
                    type="checkbox"
                    checked={preserveMotion}
                    onChange={(e) => setPreserveMotion(e.target.checked)}
                  />
                  Keep original movement when editing
                </label>
              </>
            )}
            {!mapping && (
              <>
                <button
                  className="btn secondary"
                  style={{ marginTop: 8 }}
                  onClick={onRagdoll}
                  title="Let the character fall limply to the ground from its current pose — the fall is saved as a clip"
                >
                  💥 Ragdoll to ground
                </button>
                {ragdollMsg && <div className="pose-msg">{ragdollMsg}</div>}
              </>
            )}
          </div>
        </details>
      )}

      {/* Mocap bone-mapping editor */}
      {mapping && (
        <div className="map-editor">
          <div className="field-label" style={{ marginTop: 8 }}>
            Map “{mapping.name}” bones → this rig
          </div>
          <div className="map-hint">
            Auto-guessed by body part. Fix any wrong rows (leave a row blank to
            skip it), then Retarget. If the rig has generic bone names, use{' '}
            <strong>Pick</strong> and click the bone on the character instead
            of hunting through the dropdown.
            {mapping.slots.some((s) => s.guessed) && (
              <>
                {' '}Rows marked <strong>~guess</strong> have no usable bone
                names (in the mocap file, the character rig, or both), so
                they were guessed from the skeleton's shape instead — check
                these carefully.
              </>
            )}
          </div>

          {pickingSlotKey && (
            <div className="map-hint map-hint-active">
              Click a bone dot on the character to assign it to “
              {mapping.slots.find((s) => s.key === pickingSlotKey)?.label}”.{' '}
              <button className="btn secondary" onClick={onCancelPickTarget}>
                Cancel
              </button>
            </div>
          )}

          <div className="map-list">
            {mapping.slots.map((s) => (
              <div key={s.key} className={s.guessed ? 'map-row map-row-guessed' : 'map-row'}>
                <span className="map-slot">
                  {s.label}
                  {s.guessed && (
                    <span className="map-guessed-badge" title="Guessed from bone position, not name">
                      {' '}~guess
                    </span>
                  )}
                </span>
                <span className="map-target-cell">
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
                  <button
                    className={'map-pick-btn' + (pickingSlotKey === s.key ? ' active' : '')}
                    onClick={() => (pickingSlotKey === s.key ? onCancelPickTarget() : onStartPickTarget(s.key))}
                    title="If a bone is already selected, assigns it. Otherwise, click here then click the bone on the character."
                  >
                    ⌖
                  </button>
                </span>
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
        <button className="btn" onClick={onPauseToggle} disabled={source === 'clip' && !activeClipName}>
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button className="btn secondary" onClick={onStop} disabled={playback === 'stopped'}>
          ■ Stop
        </button>
      </div>

      {(characterOrder.length > 0 || hasObjectAnimation) && (
        <div className="transport" style={{ marginTop: 6 }}>
          <button
            className="btn secondary"
            onClick={anythingPlaying ? onPauseAll : onPlayAll}
            title={
              anythingPlaying
                ? 'Pause every loaded character and any object motion (Play all resumes)'
                : 'Play every loaded character and any keyed object motion at the same time'
            }
          >
            {anythingPlaying ? '❚❚ Pause all' : '▶ Play all'}
            {characterOrder.length > 0 ? ` (${characterOrder.length})` : ''}
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
            style={{ marginTop: 8 }}
            onClick={onSaveAsClip}
            title="Save the animation you created or edited as a new reusable clip."
          >
            Save as clip…
          </button>

          <details className="anim-disclosure">
            <summary>Advanced keyframe tools</summary>
            <div className="anim-disclosure-content">
              <label className="anim-fps-field">
                Frames per second
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={animFps}
                  onChange={(e) => st().setAnimFps(Math.max(1, Math.round(Number(e.target.value))))}
                />
              </label>

              <div className="kf-actions" style={{ alignItems: 'center', marginTop: 8 }}>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={blankFrames}
                  onChange={(e) => setBlankFrames(Math.max(1, Math.round(Number(e.target.value))))}
                  className="text-input"
                  style={{ width: 60 }}
                  title="How many blank frames to insert"
                  aria-label="Blank frames to insert"
                />
                <button
                  className="btn secondary"
                  onClick={onInsertBlank}
                  title="Push every keyframe at or after the insert time later by this many frames, opening a hold/gap"
                >
                  Insert blank frames
                </button>
              </div>

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
                      className={'kf-list-row' + (Math.abs(k.time - currentTime) < 1e-4 ? ' active' : '')}
                      title="Jump here (then re-pose and re-key to edit)"
                      onClick={() => onScrub(k.time)}
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
                        {k.lights > 0 && (
                          <span className="kf-tag pos">
                            {k.lights} light{k.lights > 1 ? 's' : ''}
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
                          onCharacterTrackChange(st().currentTime)
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
                  onClick={() => {
                    st().deleteKeyframe(selectedBoneName, snap(currentTime))
                    onCharacterTrackChange(st().currentTime)
                  }}
                  title={`Remove only ${selectedBoneName}'s keyframe at the current time`}
                >
                  Delete “{selectedBoneName}” key here
                </button>
              )}

              <div className="kf-actions" style={{ marginTop: 8 }}>
                <button className="btn secondary" onClick={() => st().clearAnim()}>
                  Clear
                </button>
              </div>
            </div>
          </details>
        </div>
      )}
    </div>
    </>
  )
}