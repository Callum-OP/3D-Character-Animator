import { useEffect, useMemo, useRef, useState } from 'react'
import './PoseFinder.css'
import { useStore } from '../store.js'
import { confirmDialog } from '../dialogs.js'
import { importBVHAuto, scrubTimeline } from '../three/scene.js'
import { lockBonesInPlace, limbBoneNames } from '../three/ikpins.js'
import { openVideo, openImage, seekTo, makeCropper } from '../three/poseFinder/videoFrames.js'
import { runPoseFinder } from '../three/poseFinder/run.js'
import { defaultBox } from '../three/poseFinder/cropMath.js'
import { POSE_PRESETS } from '../three/poseFinder/presets.js'

const gb = (b) => (b / 1e9).toFixed(2)
const fmtEta = (s) => (!Number.isFinite(s) ? '' : s > 90 ? `${Math.round(s / 60)} min left` : `${Math.round(s)} s left`)

// Video -> motion capture. Desktop (Electron) only: the model runs locally through onnxruntime-node.
export default function PoseFinderPanel({ onClose }) {
  const pose = typeof window !== 'undefined' ? window.animare?.pose : null
  const hasCharacter = useStore((s) => !!s.modelInfo)

  const [status, setStatus] = useState(null)
  const [accepted, setAccepted] = useState(false)
  const [dl, setDl] = useState(null) // { received, total }
  const [uninstalling, setUninstalling] = useState(false)
  const [modelError, setModelError] = useState('')
  const [engineMsg, setEngineMsg] = useState('')
  const [compute, setCompute] = useState('auto')
  const [preset, setPreset] = useState('standing')

  const [src, setSrc] = useState(null) // { kind, video | image, width, height, duration, name, close }
  const [box, setBox] = useState(null)
  const [range, setRange] = useState([0, 0])
  const [sampleFps, setSampleFps] = useState(10)
  const [outFps, setOutFps] = useState(30)
  const [smoothing, setSmoothing] = useState('medium')
  const [footLock, setFootLock] = useState(true)
  const [levelCamera, setLevelCamera] = useState(true)
  const [posture, setPosture] = useState('auto')
  const [levelFeet, setLevelFeet] = useState(true)
  const [limitJoints, setLimitJoints] = useState(true)
  const [lowerArms, setLowerArms] = useState('slight')
  const [ground, setGround] = useState('strict')
  const [groundReference, setGroundReference] = useState('feet')
  const [lockFeet, setLockFeet] = useState(false)

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null) // { bvh, name, warnings }
  const [notice, setNotice] = useState('')
  const [live, setLive] = useState(null) // { i, valid, reason, source }
  const [hasDiag, setHasDiag] = useState(false)
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const modelViewRef = useRef(null)
  const diagRef = useRef(null)

  const stageRef = useRef(null)
  const overlayRef = useRef(null)
  const dragRef = useRef(null)
  const abortRef = useRef(null)
  const mediaHostRef = useRef(null)

  function choosePreset(value) {
    const s = POSE_PRESETS[value].settings
    setPreset(value)
    setSampleFps(s.sampleFps); setOutFps(s.outFps); setSmoothing(s.smoothing)
    setFootLock(s.footLock); setLevelCamera(s.levelCamera); setPosture(s.posture)
    setLevelFeet(s.levelFeet); setLimitJoints(s.limitJoints); setLowerArms(s.lowerArms)
    setGround(s.ground); setGroundReference(s.groundReference); setLockFeet(s.lockFeet)
  }

  const refresh = async () => { if (pose) setStatus(await pose.status()) }
  useEffect(() => { refresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => (pose ? pose.onDownloadProgress(setDl) : undefined), []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !running) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, onClose])
  useEffect(() => () => { abortRef.current?.abort() }, [])
  useEffect(() => () => { src?.close?.() }, [src])

  // mount the video or image into the stage
  useEffect(() => {
    const host = mediaHostRef.current
    if (!host || !src) return
    host.innerHTML = ''
    const media = src.kind === 'image' ? src.image : src.video
    if (src.kind === 'video') media.controls = false
    media.style.cssText = 'width:100%;max-height:52vh;object-fit:contain;display:block'
    host.appendChild(media)
  }, [src])
  useEffect(() => {
    const overlay = overlayRef.current
    if (!overlay || !src) return
    const update = () => {
      const { width, height } = overlay.getBoundingClientRect()
      setStageSize({ width, height })
    }
    update()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    observer?.observe(overlay)
    window.addEventListener('resize', update)
    return () => { observer?.disconnect(); window.removeEventListener('resize', update) }
  }, [src])

  // ---- engine setup ----
  async function onDownload() {
    setError(''); setDl({ received: 0, total: status?.expectedBytes || 0 })
    const r = await pose.download()
    setDl(null)
    if (!r.ok) setError(r.error)
    await refresh()
  }

  async function onUninstall() {
    if (!confirmDialog('Uninstall the Pose Finder model? You will need to download it again to analyse videos or images. Existing animations and videos will not be deleted.')) return
    setModelError('')
    setUninstalling(true)
    try {
      const r = await pose.uninstall()
      if (!r.ok) throw new Error(r.error)
      setAccepted(false)
      setStatus((s) => s && { ...s, modelReady: false, modelBytes: 0, loaded: false, provider: null })
      await refresh()
    } catch (err) {
      setModelError(err.message || String(err))
    } finally {
      setUninstalling(false)
    }
  }

  // ---- video/image + box ----
  async function onPickMedia(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(''); setResult(null)
    try {
      const kind = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name) ? 'image' : 'video'
      const media = kind === 'image' ? await openImage(file) : await openVideo(file)
      setSrc({ ...media, kind, name: file.name })
      setBox(defaultBox(media.width, media.height))
      setRange([0, media.duration])
      if (kind === 'video') await seekTo(media.video, 0)
    } catch (err) { setError(err.message || String(err)) }
  }

  const toImage = (ev) => {
    const r = overlayRef.current.getBoundingClientRect()
    // The preview is letterboxed (object-fit: contain): map through the displayed picture rectangle.
    const scale = Math.min(r.width / src.width, r.height / src.height)
    const dw = src.width * scale, dh = src.height * scale
    const ox = (r.width - dw) / 2, oy = (r.height - dh) / 2
    return { x: (ev.clientX - r.left - ox) / scale, y: (ev.clientY - r.top - oy) / scale, scale, ox, oy }
  }
  const onDown = (ev) => {
    if (!src || running) return
    overlayRef.current.setPointerCapture(ev.pointerId)
    const p = toImage(ev)
    dragRef.current = { x: p.x, y: p.y }
  }
  const onMove = (ev) => {
    const d = dragRef.current
    if (!d) return
    const p = toImage(ev)
    const clampX = (x) => Math.max(0, Math.min(src.width, x)), clampY = (y) => Math.max(0, Math.min(src.height, y))
    setBox({ x1: clampX(Math.min(d.x, p.x)), y1: clampY(Math.min(d.y, p.y)), x2: clampX(Math.max(d.x, p.x)), y2: clampY(Math.max(d.y, p.y)) })
  }
  const onUp = () => { dragRef.current = null }

  const boxStyle = useMemo(() => {
    if (!src || !box) return null
    const r = stageSize
    if (!r.width) return null
    const scale = Math.min(r.width / src.width, r.height / src.height)
    const ox = (r.width - src.width * scale) / 2, oy = (r.height - src.height * scale) / 2
    return { left: ox + box.x1 * scale, top: oy + box.y1 * scale, width: (box.x2 - box.x1) * scale, height: (box.y2 - box.y1) * scale }
  }, [src, box, stageSize])

  async function previewAt(t) { if (src?.kind === 'video' && !running) { try { await seekTo(src.video, t) } catch (_) { /* ignore */ } } }

  // ---- run ----
  const showModelView = (rgba, kp2d, box, crop) => {
    const cv = modelViewRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength)), 512, 512), 0, 0)
  }

  async function onRun() {
    setError(''); setResult(null); setNotice(''); setLive(null)
    const ac = new AbortController()
    abortRef.current = ac
    setRunning(true)
    setProgress({ done: 0, total: 1 })
    diagRef.current = { app: '3D Character Animator Pose Finder', settings: { preset, compute, sampleFps, outFps, smoothing, footLock, levelCamera, posture, levelFeet, limitJoints, lowerArms, ground, groundReference, lockFeet, range, source: src && { kind: src.kind, name: src.name, width: src.width, height: src.height, duration: src.duration }, box }, frames: [], provider: null, error: null }
    setHasDiag(true)
    const cropper = makeCropper()
    const source = {
      width: src.width, height: src.height, duration: src.duration,
      staticPose: src.kind === 'image',
      frameAt: async (t, crop) => {
        const media = src.kind === 'image' ? src.image : src.video
        if (src.kind === 'video') await seekTo(media, t)
        return cropper(media, crop)
      },
    }
    const onFrame = (f) => {
      showModelView(f.rgba)
      setLive({ i: f.i, valid: f.valid, reason: f.reason, source: f.source })
      const d = diagRef.current
      if (f.i < 3 || f.i % 10 === 0) {
        const cv = modelViewRef.current
        d.frames.push({ i: f.i, t: +f.t.toFixed(3), valid: f.valid, reason: f.reason || null, trackedVia: f.source, box: f.box, kp2dHead: Array.from(f.kp2d?.slice(0, 16) || []), crop: cv ? cv.toDataURL('image/jpeg', 0.7) : null })
      }
    }
    let loaded = false
    try {
      let pref = compute
      for (let attemptNo = 0; attemptNo < 2; attemptNo++) {
        const lr = await pose.load(pref)
        if (!lr.ok) throw new Error(lr.error)
        loaded = true
        diagRef.current.provider = lr.provider
        await refresh()
        try {
          const r = await runPoseFinder({
            source, engine: pose, box, startTime: range[0], endTime: range[1], sampleFps, outFps, smoothing, footLock,
            signal: ac.signal, onProgress: setProgress, onFrame, clean: { levelCamera, posture, levelFeet, limitJoints, lowerArms, ground, groundReference, lockFeet, contactMode: ground === 'strict' ? 'ground' : (POSE_PRESETS[preset].settings.contactMode || 'ground'), motionProfile: POSE_PRESETS[preset].settings.motionProfile },
          })
          diagRef.current.solved = { shoulderLowerDeg: r.solved.info.shoulderLowerDeg, armLowerDeg: r.solved.info.armLowerDeg, groundLocked: r.solved.info.groundLocked, tiltDeg: r.solved.info.tiltDeg, slouchDeg: r.solved.info.slouchDeg, limitDeg: r.solved.info.limitDeg, footLevelDeg: r.solved.info.footLevelDeg, variationDeg: r.solved.info.variationDeg, convention: r.solved.info.convention, scale: r.solved.info.scale, warnings: r.solved.info.warnings }
          setResult({ bvh: r.bvh, name: src.name.replace(/\.[^.]+$/, '') + '-pose', warnings: r.solved.info.warnings, info: r.solved.info, fps: r.solved.fps })
          break
        } catch (err) {
          // The very first frame was garbage on the GPU: Adreno/DirectML drivers can do that. Retry once on the CPU.
          if (err.name === 'BadOutputError' && lr.provider === 'dml' && attemptNo === 0) {
            setNotice(`The GPU returned unusable output (${err.reason}). Switching to the CPU and trying again…`)
            pref = 'cpu'
            continue
          }
          throw err
        }
      }
    } catch (err) {
      if (diagRef.current) diagRef.current.error = err.message || String(err)
      if (!/Cancelled/.test(err.message)) setError(err.message || String(err))
    } finally {
      try {
        if (loaded) {
          await pose.unload()
          await refresh()
        }
      } catch (err) {
        setError((previous) => `${previous ? `${previous} ` : ''}Could not unload the pose model: ${err.message || String(err)}`)
      } finally {
        setRunning(false); setProgress(null); abortRef.current = null
      }
    }
  }

  function onSaveDiagnostics() {
    const blob = new Blob([JSON.stringify(diagRef.current, null, 1)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = 'pose-finder-diagnostics.json'; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }

  const fileFor = () => new File([result.bvh], `${result.name || 'pose'}.bvh`, { type: 'text/plain' })
  async function onAdd() {
    setError(''); setNotice('')
    try {
      const { name, matched, total } = await importBVHAuto(fileFor(), { preserveFootRest: true })
      let lockNote = ''
      if (result.info.feetLocked) {
        // frame 0 is the neutral reference frame, so the first real pose is one frame in
        scrubTimeline(1 / (result.fps || 30))
        const r = lockBonesInPlace(limbBoneNames('foot'), { rotation: true })
        lockNote = r.locked + r.relocked ? ' Both feet are locked at their first-pose position and rotation (Animate > More character tools > Lock in place); saving the clip or exporting a BVH keeps the lock.' : ' No feet were found to lock.'
      }
      setNotice(`Added "${name}" to the active character (${matched}/${total} bones matched) and selected it as the active clip.${lockNote}`)
    } catch (err) { setError(err.message || String(err)) }
  }
  function onDownloadBVH() {
    const f = fileFor()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(f); a.download = f.name; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }

  const ready = status?.ortOk && status?.modelReady
  const validBox = box && box.x2 - box.x1 >= 8 && box.y2 - box.y1 >= 8
  const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0
  const estFrames = src ? Math.floor((range[1] - range[0]) * sampleFps) + 1 : 0

  return (
    <div className="pf-backdrop" onClick={() => !running && onClose()}>
      <div className="pf-dialog" role="dialog" aria-modal="true" aria-label="Pose Finder" onClick={(e) => e.stopPropagation()}>
        <div className="pf-head">
          <div>
            <span className="pf-eyebrow">Video/image to mocap</span>
            <h2>Pose Finder</h2>
          </div>
          <button className="icon-btn danger" title="Close (Esc)" aria-label="Close Pose Finder" disabled={running} onClick={onClose}>×</button>
        </div>

        {!pose && <div className="pf-card"><p className="pf-dim">Pose Finder runs a large AI model on your own computer, so it is only available in the desktop app.</p></div>}

        {pose && (
          <>
            <div className="pf-card">
              <h3>1. Pose model</h3>
              <p className="pf-dim">Pose Finder uses Meta’s SAM 3D Body (the ViT-H body decoder, ONNX conversion by gok11). The model runs locally on your device and videos and images are processed there. Analysing frames can use a lot of RAM and, when using the GPU, GPU memory.</p>
              {status && <p className="pf-dim">The model takes {gb(status.expectedBytes)} GB of disk space. It is downloaded once and kept on this device.</p>}
              {!status && <p className="pf-dim">Checking…</p>}
              {status && !status.ortOk && <div className="pf-err">The model runtime could not start: {status.ortError || 'onnxruntime-node is missing'}</div>}
              {status?.ortOk && !status.modelReady && (
                <>
                  <label className="pf-check">
                    <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
                    <span>I accept the <a href={status.licenseUrl} target="_blank" rel="noreferrer">SAM License</a> (commercial use allowed; no military or weapons use; trade controls apply).</span>
                  </label>
                  <div className="pf-row">
                    <button className="btn" disabled={!accepted || !!dl || uninstalling} onClick={onDownload}>Download model</button>
                    {dl && <button className="btn secondary" onClick={() => pose.cancelDownload()}>Cancel</button>}
                    {dl && <span className="pf-dim">{gb(dl.received)} / {gb(dl.total || status.expectedBytes)} GB</span>}
                  </div>
                  {dl && <div className="pf-bar"><div style={{ width: `${Math.round((dl.received / (dl.total || status.expectedBytes)) * 100)}%` }} /></div>}
                </>
              )}
              {status?.modelReady && (
                <div className="pf-row">
                  <span className="pf-ok">Model ready</span>
                  {status.provider && <span className="pf-dim">last used: {status.provider}</span>}
                </div>
              )}
              {(status?.modelReady || status?.modelBytes > 0) && (
                <div className="pf-row">
                  <button className="btn secondary" disabled={running || !!dl || uninstalling} onClick={onUninstall}>
                    {uninstalling ? 'Uninstalling…' : 'Uninstall model'}
                  </button>
                </div>
              )}
              {modelError && <div className="pf-err" role="alert">{modelError}</div>}
            </div>

            <div className="pf-card">
              <h3>2. Video or image and person</h3>
              <div className="pf-row">
                <input type="file" accept="video/*,image/*" disabled={running} onChange={onPickMedia} />
                {src && <span className="pf-dim">{src.width}×{src.height}{src.kind === 'video' ? `, ${src.duration.toFixed(1)} s` : ', still image'}</span>}
              </div>
              {src && (
                <>
                  <p className="pf-dim">Drag on the picture to draw a box around the person. The box then follows them in a video. For an image, Pose Finder makes a static pose clip.</p>
                  <div className="pf-stage" ref={stageRef}>
                    <div ref={mediaHostRef} />
                    <div className="pf-overlay" ref={overlayRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
                      {boxStyle && <div style={{ position: 'absolute', ...boxStyle, border: '2px solid var(--accent)', boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)', pointerEvents: 'none' }} />}
                    </div>
                  </div>
                  {src.kind === 'video' && <div className="pf-grid">
                    <label className="pf-field">Start: {range[0].toFixed(1)} s
                      <input type="range" min="0" max={src.duration} step="0.1" value={range[0]} disabled={running}
                        onChange={(e) => { const v = Math.max(0, Math.min(+e.target.value, range[1] - 0.2)); setRange([v, range[1]]); previewAt(v) }} />
                    </label>
                    <label className="pf-field">End: {range[1].toFixed(1)} s
                      <input type="range" min="0" max={src.duration} step="0.1" value={range[1]} disabled={running}
                        onChange={(e) => { const v = Math.min(src.duration, Math.max(+e.target.value, range[0] + 0.2)); setRange([range[0], v]) }} />
                    </label>
                  </div>}
                  <div className="pf-row"><button className="btn secondary" disabled={running} onClick={() => setBox(defaultBox(src.width, src.height))}>Reset box</button></div>
                </>
              )}
            </div>

            <div className="pf-card">
              <h3>3. Choose your motion</h3>
              <div className="pf-primary-settings">
                <label className="pf-field">Motion preset
                  <select value={preset} disabled={running} onChange={(e) => choosePreset(e.target.value)}>
                    {Object.entries(POSE_PRESETS).map(([key, p]) => <option key={key} value={key}>{p.label}</option>)}
                  </select>
                </label>
                <p className="pf-dim">{POSE_PRESETS[preset].description}</p>
                <label className="pf-toggle">
                  <input type="checkbox" checked={ground === 'strict'} disabled={running} onChange={(e) => {
                    const on = e.target.checked
                    setGround(on ? 'strict' : 'natural'); setFootLock(on); setLevelFeet(on)
                    if (!on) setLockFeet(false)
                  }} />
                  <span><strong>Keep feet on the ground</strong><small>Grounds the lowest foot and holds detected planted feet level and still. Turn off for jumps, flips, falling or lying down.</small></span>
                </label>
              </div>
              <details className="pf-details">
                <summary>Advanced settings</summary>
                <p className="pf-dim">Presets set these options for you. Changes apply the next time you find poses; choosing a preset resets them.</p>
                <button className="btn secondary" disabled={running} onClick={() => choosePreset(preset)}>Reset to {POSE_PRESETS[preset].label}</button>
                <div className="pf-grid">
                <label className="pf-field">Compute
                  <select value={compute} disabled={running} onChange={(e) => setCompute(e.target.value)}>
                    <option value="auto">Auto</option>
                    <option value="cpu">CPU only</option>
                    {status?.platform === 'win32' && <option value="dml">GPU (DirectML)</option>}
                  </select>
                </label>
                <label className="pf-field">Analyse frames at
                  <select value={sampleFps} disabled={running} onChange={(e) => setSampleFps(+e.target.value)}>
                    <option value={5}>5 per second (fastest)</option>
                    <option value={10}>10 per second</option>
                    <option value={15}>15 per second</option>
                    <option value={30}>30 per second (slowest, most detail)</option>
                  </select>
                </label>
                <label className="pf-field">Clip frame rate
                  <select value={outFps} disabled={running} onChange={(e) => setOutFps(+e.target.value)}>
                    <option value={24}>24</option><option value={30}>30</option><option value={60}>60</option>
                  </select>
                </label>
                <label className="pf-field">Smoothing
                  <select value={smoothing} disabled={running} onChange={(e) => setSmoothing(e.target.value)}>
                    <option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                  </select>
                </label>
                <label className="pf-field">Straighten slouch
                  <select value={posture} disabled={running} onChange={(e) => setPosture(e.target.value)}>
                    <option value="off">Off</option><option value="auto">Auto (keeps natural curve)</option><option value="strong">Strong (fully upright)</option>
                  </select>
                </label>
                <label className="pf-field">Ground reference
                  <select value={groundReference} disabled={running || ground === 'strict'} onChange={(e) => setGroundReference(e.target.value)}>
                    <option value="feet">Feet</option>
                    <option value="body">Lowest tracked body point</option>
                  </select>
                </label>
                <label className="pf-field">Lower shoulders and arms
                  <select value={lowerArms} disabled={running} onChange={(e) => setLowerArms(e.target.value)}>
                    <option value="off">Off</option><option value="slight">Default (reference pose)</option><option value="more">More</option>
                  </select>
                </label>
                <label className="pf-check" style={{ alignSelf: 'end' }}>
                  <input type="checkbox" checked={footLock} disabled={running} onChange={(e) => setFootLock(e.target.checked)} />
                  <span>Foot lock (stops planted feet sliding)</span>
                </label>
                <label className="pf-check" style={{ alignSelf: 'end' }}>
                  <input type="checkbox" checked={levelFeet} disabled={running || !footLock} onChange={(e) => setLevelFeet(e.target.checked)} />
                  <span>Level planted feet with the ground</span>
                </label>
                <label className="pf-check" style={{ alignSelf: 'end' }}>
                  <input type="checkbox" checked={levelCamera} disabled={running} onChange={(e) => setLevelCamera(e.target.checked)} />
                  <span>Correct camera tilt</span>
                </label>
                <label className="pf-check" style={{ alignSelf: 'end' }}>
                  <input type="checkbox" checked={limitJoints} disabled={running} onChange={(e) => setLimitJoints(e.target.checked)} />
                  <span>Keep fingers, elbows, knees, neck in human range</span>
                </label>
                <label className="pf-check" style={{ alignSelf: 'end' }}>
                  <input type="checkbox" checked={lockFeet} disabled={running} onChange={(e) => setLockFeet(e.target.checked)} />
                  <span>Pin both feet at their first position and rotation (for movement on the spot, not walking). Baked into the BVH.</span>
                </label>
              </div>
              </details>
              <p className="pf-dim">Each analysed frame takes a few seconds on a laptop CPU. {src ? `This will analyse about ${src.kind === 'image' ? 2 : estFrames} frames.` : ''} Frames in between are interpolated.</p>
              <div className="pf-row">
                {!running && <button className="btn" disabled={!ready || !src || !validBox || uninstalling || !!dl} onClick={onRun}>Find poses</button>}
                {running && <button className="btn secondary" onClick={() => abortRef.current?.abort()}>Cancel</button>}
                {running && progress && <span className="pf-dim">{progress.done} / {progress.total} frames {fmtEta(progress.etaSec)}</span>}
              </div>
              {running && <div className="pf-bar"><div style={{ width: `${pct}%` }} /></div>}
              <div className="pf-row" style={{ alignItems: 'flex-start', display: running || live ? 'flex' : 'none' }}>
                <div>
                  <canvas ref={modelViewRef} width={512} height={512} style={{ width: 160, height: 160, borderRadius: 6, background: '#000' }} />
                  <div className="pf-dim">What the model sees</div>
                </div>
                {live && (
                  <p className="pf-dim" style={{ margin: 0 }}>
                    Frame {live.i + 1}: {live.valid ? 'pose found' : `no usable pose (${live.reason})`}.<br />
                    {live.source ? `Following the person via ${live.source === 'kp2d' ? 'the 2D keypoints' : 'the 3D projection'}.` : 'Tracking box held in place.'}<br />
                    If this picture is not the person, the box is wrong — stop and redraw it.
                  </p>
                )}
              </div>
              {hasDiag && !running && <details className="pf-details"><summary>Troubleshooting</summary><div className="pf-row"><button className="btn secondary" onClick={onSaveDiagnostics}>Save diagnostics</button><span className="pf-dim">Includes images seen by the model and run settings; share only if you are comfortable doing so.</span></div></details>}
            </div>

            {error && <div className="pf-err">{error}</div>}

            {result && (
              <div className="pf-card">
                <h3>4. Result</h3>
                <p className="pf-dim">This result uses the settings from the last run. After changing settings, select Find poses again to update it.</p>
                {result.warnings.map((w) => <div className="pf-warn" key={w}>{w}</div>)}
                {result.info && (
                  <p className="pf-dim">
                    Cleaned up: camera tilt {result.info.tiltDeg.toFixed(0)}°, slouch removed {result.info.slouchDeg.toFixed(0)}°, foot levelling up to {result.info.footLevelDeg.toFixed(0)}°, joints pulled back into range by up to {result.info.limitDeg.toFixed(0)}°, shoulder baseline lowered {result.info.shoulderLowerDeg.toFixed(0)}°, arm baseline lowered {result.info.armLowerDeg.toFixed(0)}°{result.info.groundLocked ? ', lowest foot kept on the ground' : ''}{result.info.feetLocked ? ', both feet held in place' : ''}.
                  </p>
                )}
                <div className="pf-grid">
                  <label className="pf-field">Clip name
                    <input type="text" value={result.name} onChange={(e) => setResult({ ...result, name: e.target.value })} />
                  </label>
                </div>
                <div className="pf-row">
                  <button className="btn" disabled={!hasCharacter} onClick={onAdd} title={hasCharacter ? '' : 'Load a character first'}>Add to active character</button>
                  <button className="btn secondary" onClick={onDownloadBVH}>Download BVH</button>
                </div>
                {!hasCharacter && <p className="pf-dim">Load a character to apply it, or download the BVH.</p>}
                {notice && <p className="pf-ok">{notice}</p>}
                <p className="pf-dim">The clip starts with one neutral reference frame (the BVH importer treats the first frame as the rest pose).</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
