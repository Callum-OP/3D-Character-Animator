import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import EditableValue from './EditableValue.jsx'
import {
  selectClip,
  selectEdit,
  play,
  pause,
  stop,
  scrub,
  setLoop as engineSetLoop,
  setSpeed as engineSetSpeed,
  beginBVHImport,
  applyBVHRetarget,
  cancelBVHImport,
  sampleClipToPose,
  bakeClipToTracks,
} from '../three/animation.js'
import { getBoneQuaternion, getPosedBones, applyPose } from '../three/posing.js'
import { getCharacterRootTransform } from '../three/scene.js'

// Collect every keyframe time across all joints + the character position, with a
// count of what's keyed at each — for the overview/manage list.
function collectKeyframes(animData) {
  const map = new Map()
  for (const keys of Object.values(animData.tracks || {})) {
    for (const k of keys) {
      const e = map.get(k.time) || { time: k.time, joints: 0, pos: false }
      e.joints++
      map.set(k.time, e)
    }
  }
  for (const k of animData.root || []) {
    const e = map.get(k.time) || { time: k.time, joints: 0, pos: false }
    e.pos = true
    map.set(k.time, e)
  }
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

  const st = useStore.getState // for imperative setters inside handlers
  const fileRef = useRef(null)
  const bvhRef = useRef(null)
  const [bvhMsg, setBvhMsg] = useState(null)
  const [bvhBusy, setBvhBusy] = useState(false)
  const [kfMsg, setKfMsg] = useState(null) // feedback after adding a keyframe
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
      const d = selectEdit(animData.tracks, animData.root, animDuration, { loop, speed })
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

  function onScrub(t) {
    // Arm the source if we're stopped so there's an action to evaluate.
    if (playback === 'stopped') {
      if (source === 'edit') {
        const d = selectEdit(animData.tracks, animData.root, animDuration, { loop, speed })
        st().setDuration(d)
      } else if (activeClipName) {
        selectClip(activeClipName, { loop, speed })
      }
      st().setPlayback('paused')
    } else if (playback === 'playing') {
      pause()
      st().setPlayback('paused')
    }
    scrub(t)
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
        st().setAnimData({ tracks: json.tracks || {}, root: json.root || [] })
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

  function onBake() {
    if (!activeClipName) return
    const res = bakeClipToTracks(activeClipName, animFps, duration || undefined)
    if (!res) return
    st().setAnimData({ tracks: res.tracks })
    st().setAnimDuration(res.duration)
    onSourceChange('edit')
    setBvhMsg(`Baked ${Object.keys(res.tracks).length} moving track(s) to keyframes.`)
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
                  {mapping.targetBones.map((b) => (
                    <option key={b} value={b}>
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
                  {mapping.sourceBones.map((b) => (
                    <option key={b} value={b}>
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
