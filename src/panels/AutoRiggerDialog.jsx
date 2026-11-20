import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { loadModel, disposeObject } from '../three/loadModel.js'
import { importModelAuto, exportRigSource } from '../three/scene.js'
import { getRigSources } from '../three/objects.js'
import { detectLandmarks } from '../three/autoRigDetect.js'
import { LANDMARKS, guessLandmarks, toPayload, validateLandmarks, moveLandmark, enforceMirror, createHistory } from '../three/autoRigMath.js'
import {
  summariseRigReport, autoRigBridge, estimateRigSeconds, etaSeconds, formatDuration, countVertices, loadSpeedFactor, saveSpeedFactor, collectWorldPositions,
} from '../three/autoRig.js'

// Bones drawn between landmarks so you can see the skeleton you are about to get.
const LINKS = [
  ['pelvis', 'spine'], ['spine', 'chest'], ['chest', 'upper_chest'], ['upper_chest', 'neck'], ['neck', 'head'], ['head', 'head_top'],
  ...['l', 'r'].flatMap((s) => [
    ['upper_chest', `${s}_shoulder`], [`${s}_shoulder`, `${s}_elbow`], [`${s}_elbow`, `${s}_wrist`], [`${s}_wrist`, `${s}_fingertip`],
    ['pelvis', `${s}_hip`], [`${s}_hip`, `${s}_knee`], [`${s}_knee`, `${s}_ankle`], [`${s}_ankle`, `${s}_toe`], [`${s}_toe`, `${s}_toe_tip`],
  ]),
]
const COLORS = { Centre: 0xffd24a, 'Left (+X)': 0x4aa8ff, 'Right (−X)': 0xff6a5a }
const MODEL_TYPES = '.glb,.gltf,.fbx,.obj,.ply'
const MIN_ZOOM = 0.15
const MAX_ZOOM = 12

// Desktop-only (the pipeline runs in the user's own Blender — see electron/BLENDER.md and autorig.cjs).
// Step 1 choose a model (a file, or something already in the scene), step 2 check/adjust the landmark
// markers in the front and side views, step 3 rig. The result is imported as a normal character.
export default function AutoRiggerDialog() {
  const open = useStore((s) => s.autoRiggerOpen)
  const setOpen = useStore((s) => s.setAutoRiggerOpen)
  if (!open) return null
  return <Dialog onClose={() => setOpen(false)} />
}

function Dialog({ onClose }) {
  const bridge = autoRigBridge()
  const canvasRef = useRef(null)
  const inputRef = useRef(null)
  const three = useRef(null) // { renderer, scene, camera, markers, lines, axisLine, root, box }
  const drag = useRef(null) // { id } | { pan: true, x, y }
  const lmRef = useRef(null)
  const dragStart = useRef(null)
  const history = useRef(createHistory())
  const viewState = useRef({ zoom: 1, pan: new THREE.Vector3() })
  const sourceRef = useRef(null) // { name, getData: async () => Uint8Array }
  const [, bump] = useState(0) // re-render after history / view changes
  const [landmarks, setLandmarks] = useState(null)
  const [axisX, setAxisX] = useState(0)
  const [selected, setSelected] = useState('pelvis')
  const [mirror, setMirror] = useState(true)
  const [view, setView] = useState('front')
  const [symmetry, setSymmetry] = useState('auto')
  const [busy, setBusy] = useState(null) // null | 'loading' | 'rigging'
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)
  const [hadBones, setHadBones] = useState(false)
  const [placeNotes, setPlaceNotes] = useState([])
  const detectedRef = useRef(null) // the auto-placed markers (what "Reset" returns to)
  const [sources, setSources] = useState(() => getRigSources())
  const [sceneId, setSceneId] = useState('')
  const [fileName, setFileName] = useState(null)
  const [verts, setVerts] = useState(0)
  const [progress, setProgress] = useState(null) // { frac, label }
  const [startedAt, setStartedAt] = useState(0)
  const [now, setNow] = useState(0)

  const hasModel = !!landmarks
  const problems = useMemo(() => (landmarks ? validateLandmarks(landmarks) : []), [landmarks])
  const speed = useMemo(() => loadSpeedFactor(), [])

  function commit(next) {
    lmRef.current = next
    setLandmarks(next)
  }

  // ---- three.js preview (renders on demand only) ----
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined // web build: no desktop bridge, so no preview canvas
    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    } catch {
      setError('The 3D preview could not start (WebGL is unavailable).')
      return undefined
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0x666677, 1.6))
    const key = new THREE.DirectionalLight(0xffffff, 1.4)
    key.position.set(1, 2, 3)
    scene.add(key)
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100)
    three.current = { renderer, scene, camera, markers: new Map(), lines: null, axisLine: null, root: null, box: null }
    return () => {
      const t = three.current
      if (t?.root) disposeObject(t.root)
      t?.markers.forEach((m) => {
        m.geometry.dispose()
        m.material.dispose()
      })
      for (const l of [t?.lines, t?.axisLine]) {
        l?.geometry.dispose()
        l?.material.dispose()
      }
      renderer.dispose()
      three.current = null
    }
  }, [])

  function frame() {
    const t = three.current
    if (!t || !t.box) return
    const canvas = canvasRef.current
    const w = canvas.clientWidth || 600
    const h = canvas.clientHeight || 600
    t.renderer.setSize(w, h, false)
    const { min, max } = t.box
    const H = max[1] - min[1]
    const { zoom, pan } = viewState.current
    const c = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2).add(pan)
    const half = (H * 0.62) / zoom
    const aspect = w / h
    const cam = t.camera
    cam.left = -half * aspect
    cam.right = half * aspect
    cam.top = half
    cam.bottom = -half
    cam.near = -100 * H
    cam.far = 100 * H
    if (view === 'front') cam.position.set(c.x, c.y, c.z + 10 * H)
    else cam.position.set(c.x + 10 * H, c.y, c.z)
    cam.up.set(0, 1, 0)
    cam.lookAt(c)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld(true)
  }

  function draw() {
    const t = three.current
    if (!t) return
    frame()
    if (landmarks && t.box) {
      const H = t.box.max[1] - t.box.min[1]
      for (const l of LANDMARKS) {
        let m = t.markers.get(l.id)
        if (!m) {
          m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: COLORS[l.group], depthTest: false, transparent: true }))
          m.renderOrder = 10
          t.scene.add(m)
          t.markers.set(l.id, m)
        }
        const p = landmarks[l.id]
        m.position.set(p[0], p[1], p[2])
        m.scale.setScalar((H * (l.id === selected ? 0.016 : 0.011)) / Math.sqrt(viewState.current.zoom)) // stay readable when zoomed
        m.material.opacity = l.id === selected ? 1 : 0.8
      }
      const pts = []
      for (const [a, b] of LINKS) pts.push(...landmarks[a], ...landmarks[b])
      if (!t.lines) {
        t.lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.6 }))
        t.lines.renderOrder = 9
        t.lines.frustumCulled = false
        t.scene.add(t.lines)
      }
      t.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      // the middle line centre markers are locked to while Mirror is on
      if (!t.axisLine) {
        t.axisLine = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd24a, depthTest: false, transparent: true, opacity: 0.35 }))
        t.axisLine.renderOrder = 8
        t.axisLine.frustumCulled = false
        t.scene.add(t.axisLine)
      }
      const zMid = (t.box.min[2] + t.box.max[2]) / 2
      t.axisLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute([axisX, t.box.min[1] - H, zMid, axisX, t.box.max[1] + H, zMid], 3))
      t.axisLine.visible = mirror && view === 'front'
    }
    t.renderer.render(t.scene, t.camera)
  }
  useEffect(draw, [landmarks, selected, view, hasModel, busy, mirror, axisX])
  useEffect(() => {
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })

  // ---- zoom (wheel, to the cursor) ----
  function toWorld(ev) {
    const t = three.current
    const r = canvasRef.current.getBoundingClientRect()
    const ndc = new THREE.Vector3(((ev.clientX - r.left) / r.width) * 2 - 1, -(((ev.clientY - r.top) / r.height) * 2 - 1), 0)
    return { world: ndc.clone().unproject(t.camera), r }
  }
  function zoomBy(factor, ev) {
    const t = three.current
    if (!t?.box) return
    const vs = viewState.current
    const before = ev ? toWorld(ev).world : null
    vs.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vs.zoom * factor))
    frame()
    if (before) vs.pan.add(before.sub(toWorld(ev).world)) // keep the point under the cursor still
    draw()
    bump((n) => n + 1)
  }
  function fitView() {
    viewState.current.zoom = 1
    viewState.current.pan.set(0, 0, 0)
    draw()
    bump((n) => n + 1)
  }
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const onWheel = (ev) => {
      if (!three.current?.box) return
      ev.preventDefault()
      zoomBy(Math.exp(-ev.deltaY * 0.0015), ev)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  })

  // ---- undo / redo ----
  function undo() {
    if (!lmRef.current) return
    const prev = history.current.undo(lmRef.current)
    if (prev) commit(prev)
    bump((n) => n + 1)
  }
  function redo() {
    if (!lmRef.current) return
    const next = history.current.redo(lmRef.current)
    if (next) commit(next)
    bump((n) => n + 1)
  }
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      let handled = true
      if (mod && k === 'z' && !e.shiftKey) undo()
      else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) redo()
      else if (!mod && (k === '+' || k === '=')) zoomBy(1.25)
      else if (!mod && (k === '-' || k === '_')) zoomBy(0.8)
      else if (!mod && k === '0') fitView()
      else handled = false
      if (handled) {
        e.preventDefault()
        e.stopImmediatePropagation() // the app's own undo/redo must not also fire behind the dialog
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // ---- getting a model in ----
  function installPreview(root, box, count, name, getData, hasSkeleton) {
    const t = three.current
    if (!t) throw new Error('The 3D preview is not available.')
    if (t.root) {
      t.scene.remove(t.root)
      disposeObject(t.root)
    }
    t.root = root
    t.scene.add(root)
    t.box = box
    sourceRef.current = { name, getData }
    viewState.current.zoom = 1
    viewState.current.pan.set(0, 0, 0)
    history.current.clear()
    setAxisX((box.min[0] + box.max[0]) / 2)
    setHadBones(!!hasSkeleton)
    setVerts(count)
    setFileName(name)
    setSelected('pelvis')
    // markers read off the mesh itself (neck, crotch, ankles, hands ...), with the proportion guess as backup
    let start = guessLandmarks(box)
    let notes = []
    let axis = (box.min[0] + box.max[0]) / 2
    try {
      const det = detectLandmarks(collectWorldPositions(root, THREE))
      start = det.landmarks
      notes = det.notes
      if (Number.isFinite(det.centreX)) axis = det.centreX
    } catch {
      notes = ['could not analyse the mesh; markers placed from proportions']
    }
    setAxisX(axis)
    start = mirror ? enforceMirror(start, axis) : start
    detectedRef.current = start
    setPlaceNotes(notes)
    commit(start)
  }

  async function onPickFile(e) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setError(null)
    setDone(null)
    setSceneId('')
    setBusy('loading')
    try {
      const parsed = await loadModel(f, { autoDecimate: false })
      parsed.root.updateMatrixWorld(true)
      const b = new THREE.Box3().setFromObject(parsed.root)
      installPreview(parsed.root, { min: b.min.toArray(), max: b.max.toArray() }, countVertices(parsed.root), f.name, async () => new Uint8Array(await f.arrayBuffer()), parsed.info?.bones?.length)
    } catch (err) {
      setError(err?.message || String(err))
    } finally {
      setBusy(null)
    }
  }

  async function onPickScene(id) {
    const picked = sources.find((source) => `${source.kind}:${String(source.id)}` === id)
    setSceneId(picked ? `${picked.kind}:${String(picked.id)}` : '')
    if (!picked) return
    const sourceId = picked.id
    setError(null)
    setDone(null)
    setBusy('loading')
    try {
      const src = await exportRigSource(sourceId)
      // flat translucent preview: shows the joints through the body, and avoids copying the scene's materials
      src.group.traverse((o) => {
        if (o.isMesh) {
          o.material?.dispose?.()
          o.material = new THREE.MeshStandardMaterial({ color: 0xb8b8c4, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
        }
      })
      const label = picked?.name || 'scene object'
      installPreview(src.group, src.box, countVertices(src.group), `${label}.glb`, async () => src.data, picked?.kind === 'character')
    } catch (err) {
      setError(err?.message || String(err))
      setSceneId('')
    } finally {
      setBusy(null)
    }
  }

  // ---- placing / dragging markers (front view sets X,Y — side view sets Z,Y) ----
  function applyPoint(id, world) {
    const to = view === 'front' ? { x: world.x, y: world.y } : { z: world.z, y: world.y }
    commit(moveLandmark(lmRef.current, id, to, { mirror, axisX }))
  }
  function onPointerDown(ev) {
    if (!lmRef.current) return
    if (ev.button === 1 || ev.button === 2) {
      // middle / right drag pans
      drag.current = { pan: true, x: ev.clientX, y: ev.clientY }
      canvasRef.current.setPointerCapture(ev.pointerId)
      return
    }
    if (ev.button !== 0) return
    const { world, r } = toWorld(ev)
    const t = three.current
    // nearest marker on screen within 14px grabs it; otherwise the selected one jumps here
    let best = null
    let bestD = 14
    for (const l of LANDMARKS) {
      const p = new THREE.Vector3(...lmRef.current[l.id]).project(t.camera)
      const d = Math.hypot(((p.x + 1) / 2) * r.width - (ev.clientX - r.left), ((1 - p.y) / 2) * r.height - (ev.clientY - r.top))
      if (d < bestD) {
        bestD = d
        best = l.id
      }
    }
    const id = best || selected
    setSelected(id)
    drag.current = { id }
    dragStart.current = lmRef.current
    canvasRef.current.setPointerCapture(ev.pointerId)
    applyPoint(id, world)
  }
  function onPointerMove(ev) {
    const d = drag.current
    if (!d) return
    if (d.pan) {
      const before = toWorld({ clientX: d.x, clientY: d.y }).world
      const after = toWorld(ev).world
      viewState.current.pan.add(before.sub(after))
      d.x = ev.clientX
      d.y = ev.clientY
      draw()
      return
    }
    applyPoint(d.id, toWorld(ev).world)
  }
  function onPointerUp(ev) {
    const d = drag.current
    drag.current = null
    try {
      canvasRef.current.releasePointerCapture(ev.pointerId)
    } catch {
      /* not captured */
    }
    if (d && !d.pan && dragStart.current && dragStart.current !== lmRef.current) {
      history.current.push(dragStart.current) // one undo step per drag, not per mouse move
      bump((n) => n + 1)
    }
    dragStart.current = null
  }

  function onToggleMirror(on) {
    setMirror(on)
    if (on && lmRef.current) {
      history.current.push(lmRef.current)
      commit(enforceMirror(lmRef.current, axisX))
      bump((n) => n + 1)
    }
  }
  function onReset() {
    history.current.push(lmRef.current)
    const g = detectedRef.current || guessLandmarks(three.current.box)
    commit(mirror ? enforceMirror(g, axisX) : g)
    bump((n) => n + 1)
  }

  // ---- rigging ----
  useEffect(() => {
    if (busy !== 'rigging') return undefined
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [busy])

  async function onRig() {
    setError(null)
    setDone(null)
    if (problems.length) {
      setError(problems.join('\n'))
      return
    }
    const src = sourceRef.current
    setProgress({ frac: 0, label: 'Starting Blender' })
    setStartedAt(Date.now())
    setNow(Date.now())
    setBusy('rigging')
    const off = bridge.onProgress ? bridge.onProgress((p) => setProgress(p)) : null
    const t0 = Date.now()
    try {
      const data = await src.getData()
      const res = await bridge.run({
        input: { name: src.name, data },
        landmarks: toPayload(landmarks),
        bbox: three.current.box,
        options: { mirror: symmetry },
      })
      if (!res?.ok) throw new Error(res?.error || 'Rigging failed.')
      const rigged = new File([res.glb], src.name.replace(/\.[^.]+$/, '') + '_rigged.glb', { type: 'model/gltf-binary' })
      await importModelAuto(rigged)
      saveSpeedFactor(verts, (Date.now() - t0) / 1000)
      setDone(summariseRigReport(res.report))
    } catch (err) {
      setError(err?.message || String(err))
    } finally {
      if (off) off()
      setProgress(null)
      setBusy(null)
    }
  }

  const groups = useMemo(() => {
    const g = {}
    for (const l of LANDMARKS) (g[l.group] ||= []).push(l)
    return g
  }, [])

  const estimate = hasModel ? estimateRigSeconds(verts, speed) : null
  const elapsed = busy === 'rigging' ? Math.max(0, (now - startedAt) / 1000) : 0
  const eta = progress ? etaSeconds(progress.frac, elapsed) : null
  const h = history.current

  return (
    <div className="help-backdrop" onClick={() => !busy && onClose()}>
      <div className="help-modal autorig-modal" onClick={(e) => e.stopPropagation()}>
        <button className="help-close" title="Close" onClick={onClose} disabled={busy === 'rigging'}>×</button>
        <h2>Auto Rigger</h2>
        {!bridge ? (
          <p className="autorig-note">
            The Auto Rigger runs on your own computer using Blender, so it is only available in the desktop app. Install the desktop version
            and Blender (blender.org) to use it. Nothing is uploaded anywhere.
          </p>
        ) : (
          <>
            <p className="help-intro">
              Pick a model (a file, or something already in your scene), drag the markers onto its joints in the front and side views, then rig.
              It gets a humanoid skeleton and skin weights and comes back as a normal character. Needs Blender 2.80+.
            </p>
            <input ref={inputRef} type="file" accept={MODEL_TYPES} style={{ display: 'none' }} onChange={onPickFile} />
            <div className="autorig-source">
              <label className="autorig-check">
                From the scene{' '}
                <select value={sceneId} onMouseDown={() => setSources(getRigSources())} onChange={(e) => onPickScene(e.target.value)} disabled={!!busy}>
                  <option value="">{sources.length ? 'Choose a character or object…' : 'Nothing in the scene yet'}</option>
                  {sources.map((s) => (
                    <option key={`${s.kind}:${String(s.id)}`} value={`${s.kind}:${String(s.id)}`}>{s.name} ({s.kind})</option>
                  ))}
                </select>
              </label>
              <span className="autorig-or">or</span>
              <button className="btn secondary" onClick={() => inputRef.current?.click()} disabled={!!busy}>Choose a file…</button>
              {fileName && <span className="autorig-file">{fileName}</span>}
            </div>
            <div className="autorig-grid">
              <div className="autorig-stage">
                <div className="autorig-viewbar">
                  <div className="autorig-seg">
                    <button className={'btn secondary' + (view === 'front' ? ' active' : '')} onClick={() => setView('front')}>Front (X, Y)</button>
                    <button className={'btn secondary' + (view === 'side' ? ' active' : '')} onClick={() => setView('side')}>Side (Z, Y)</button>
                  </div>
                  <div className="autorig-seg">
                    <button className="btn secondary" title="Zoom out (−)" onClick={() => zoomBy(0.8)} disabled={!hasModel}>−</button>
                    <button className="btn secondary" title="Zoom in (+)" onClick={() => zoomBy(1.25)} disabled={!hasModel}>+</button>
                    <button className="btn secondary" title="Fit to window (0)" onClick={fitView} disabled={!hasModel}>Fit</button>
                  </div>
                  <div className="autorig-seg">
                    <button className="btn secondary" title="Undo (Ctrl+Z)" onClick={undo} disabled={!h.canUndo()}>Undo</button>
                    <button className="btn secondary" title="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!h.canRedo()}>Redo</button>
                  </div>
                  <label className="autorig-check"><input type="checkbox" checked={mirror} onChange={(e) => onToggleMirror(e.target.checked)} /> Mirror left ↔ right</label>
                </div>
                <canvas
                  ref={canvasRef}
                  className="autorig-canvas"
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onContextMenu={(e) => e.preventDefault()}
                />
                {!hasModel && <div className="autorig-empty">Choose a model from the scene or a file (.glb .gltf .fbx .obj .ply)</div>}
                {hasModel && <div className="autorig-hint">Wheel: zoom · right/middle-drag: pan · Ctrl+Z: undo{mirror ? ' · centre markers stay on the middle line' : ''}</div>}
              </div>
              <div className="autorig-side">
                {landmarks && (
                  <>
                    <div className="autorig-list">
                      {Object.entries(groups).map(([g, items]) => (
                        <div key={g}>
                          <div className="autorig-group">{g}</div>
                          {items.map((l) => (
                            <button key={l.id} className={'autorig-item' + (selected === l.id ? ' active' : '')} onClick={() => setSelected(l.id)}>
                              <span className="autorig-dot" style={{ background: '#' + COLORS[l.group].toString(16).padStart(6, '0') }} />
                              {l.label}
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                    <button className="btn secondary" onClick={onReset} disabled={!!busy}>Reset markers to guess</button>
                    <label className="autorig-check">
                      Symmetry{' '}
                      <select value={symmetry} onChange={(e) => setSymmetry(e.target.value)}>
                        <option value="auto">Auto (only if the mesh is symmetric)</option>
                        <option value="on">Always</option>
                        <option value="off">Off</option>
                      </select>
                    </label>
                  </>
                )}
              </div>
            </div>
            {hadBones && <p className="autorig-note">This model already has a skeleton. It is replaced by the new one.</p>}
            {hasModel && <p className="autorig-note">Markers were placed from the shape of the mesh. Check them in both views, especially the ankles and wrists.{placeNotes.length ? ' Note: ' + placeNotes.join('; ') + '.' : ''}</p>}
            {problems.length > 0 && <pre className="autorig-problems">{problems.join('\n')}</pre>}
            {error && <pre className="autorig-error">{error}</pre>}
            {done && <pre className="autorig-done">{done}</pre>}
            {busy === 'rigging' && progress && (
              <div className="autorig-progress">
                <div className="autorig-bar"><div className="autorig-bar-fill" style={{ width: `${Math.round(progress.frac * 100)}%` }} /></div>
                <div className="autorig-progress-text">
                  {progress.label} · {Math.round(progress.frac * 100)}% · {formatDuration(elapsed)} elapsed
                  {eta != null ? ` · about ${formatDuration(eta)} left` : ' · estimating…'}
                </div>
              </div>
            )}
            <div className="autorig-actions">
              {estimate && !busy && (
                <span className="autorig-estimate">
                  {verts.toLocaleString()} vertices: roughly {formatDuration(estimate.low)}–{formatDuration(estimate.high)}
                </span>
              )}
              <button className="btn" onClick={onRig} disabled={!hasModel || !!busy}>
                {busy === 'rigging' ? 'Rigging…' : busy === 'loading' ? 'Loading…' : 'Rig character'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
