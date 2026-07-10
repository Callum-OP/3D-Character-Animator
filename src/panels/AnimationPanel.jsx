import { useRef, useState } from 'react'
import { useStore } from '../store.js'
import {
  selectClip,
  selectEdit,
  play,
  pause,
  stop,
  scrub,
  setLoop as engineSetLoop,
  setSpeed as engineSetSpeed,
  importBVH,
  sampleClipToPose,
  bakeClipToTracks,
} from '../three/animation.js'
import { getBoneQuaternion, getPosedBones, applyPose } from '../three/posing.js'

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
      const d = selectEdit(animData.tracks, animDuration, { loop, speed })
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
        const d = selectEdit(animData.tracks, animDuration, { loop, speed })
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
    if (quat) st().addKeyframe(selectedBoneName, snap(insertTime), quat)
  }

  function onKeyAll() {
    const posed = getPosedBones()
    if (posed.length) st().addKeyframesAtTime(posed, snap(insertTime))
  }

  function onSaveAnim() {
    const json = {
      format: 'anim-v1',
      fps: animFps,
      duration: animDuration,
      tracks: animData.tracks,
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
        st().setAnimData({ tracks: json.tracks || {} })
      } catch (err) {
        console.warn('Failed to load animation:', err)
      }
    })
  }

  // --- mocap (BVH) + clip-to-pose/keyframes ---------------------------------

  async function onImportBVH(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setBvhBusy(true)
    setBvhMsg('Retargeting mocap…')
    try {
      stop()
      st().setPlayback('stopped')
      st().setCurrentTime(0)
      const { name, matched, total } = await importBVH(file)
      st().addImportedClipName(name)
      st().setPlaybackSource('clip')
      st().setActiveClipName(name)
      const d = selectClip(name, { loop, speed })
      st().setDuration(d)
      st().setCurrentTime(0)
      st().setPlayback('paused')
      setBvhMsg(`Imported "${name}" — matched ${matched}/${total} bones.`)
    } catch (err) {
      setBvhMsg(err.message || String(err))
    } finally {
      setBvhBusy(false)
    }
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
      <h2>Animation</h2>

      {/* Source selector */}
      <div className="seg">
        <button
          className={'seg-btn' + (source === 'clip' ? ' active' : '')}
          disabled={!hasClips && !hasBones}
          onClick={() => onSourceChange('clip')}
        >
          Clip / mocap
        </button>
        <button
          className={'seg-btn' + (source === 'edit' ? ' active' : '')}
          disabled={!hasBones}
          onClick={() => onSourceChange('edit')}
        >
          In-app
        </button>
      </div>

      {source === 'clip' && (
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
                {bvhBusy ? 'Importing…' : 'Import mocap (.bvh)'}
              </button>
              <input
                ref={bvhRef}
                type="file"
                accept=".bvh"
                style={{ display: 'none' }}
                onChange={onImportBVH}
              />
            </div>
          )}

          {activeClipName && hasBones && (
            <div className="kf-actions" style={{ marginTop: 6 }}>
              <button className="btn secondary" onClick={onApplyFrameAsPose}>
                Frame → pose
              </button>
              <button className="btn secondary" onClick={onBake}>
                Bake → keys
              </button>
            </div>
          )}

          {bvhMsg && <div className="pose-msg">{bvhMsg}</div>}
        </>
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
        <span className="scrub-time">
          {currentTime.toFixed(2)} / {(displayDuration || 0).toFixed(2)}s
        </span>
      </div>

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
          <span className="slider-value">{speed.toFixed(1)}×</span>
        </label>
      </div>

      {/* In-app keyframe editor */}
      {source === 'edit' && hasBones && (
        <div className="keyframe-editor">
          <div className="field-label" style={{ marginTop: 4 }}>
            Keyframes {playback !== 'stopped' && '(Stop to edit)'}
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
            <span className="slider-value">{insertTime.toFixed(2)}s</span>
          </label>

          <div className="kf-actions">
            <button className="btn secondary" onClick={onAddKey} disabled={!selectedBoneName}>
              Key bone
            </button>
            <button className="btn secondary" onClick={onKeyAll}>
              Key all posed
            </button>
          </div>

          {/* Marker strip for the selected bone's keyframes */}
          <div className="kf-strip-label">
            {selectedBoneName ? `Keys: ${selectedBoneName}` : 'Select a bone to see its keys'}
          </div>
          <div className="kf-strip">
            {boneKeys.map((k, i) => (
              <button
                key={i}
                className={'kf-marker' + (Math.abs(k.time - insertTime) < 1e-4 ? ' active' : '')}
                style={{ left: `${(k.time / (animDuration || 1)) * 100}%` }}
                title={`${k.time.toFixed(2)}s — click to jump, right-click to delete`}
                onClick={() => st().setInsertTime(k.time)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  st().deleteKeyframe(selectedBoneName, k.time)
                }}
              />
            ))}
          </div>

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
