import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { useStore } from '../store.js'
import { listPresets, presetThumb, loadPresetPoseText, loadPresetText } from '../three/poseLibraryPresets.js'
import {
  listEntries, deleteEntry, renameEntry, exportLibraryJSON, importLibraryJSON, isPersistent,
  getRenderedThumb, putRenderedThumb,
} from '../three/poseLibraryStore.js'
import {
  applyBodyEntry, applyHandEntry, applyAnimationEntry,
  saveCurrentBodyPose, saveCurrentHandPose, saveClipToLibrary, backfillAnimationThumb, BASIC_HANDS,
} from '../three/poseLibraryActions.js'
import { analyseHands, analyticHandPose, handPoseToBoneQuats, handPosesFromBVH, rigsForSide, migrateHandPose } from '../three/handPose.js'
import {
  applyClipFrame, basicHandThumb, parsedBVHResolver, posedBoneBounds, representativeClipTime,
} from '../three/poseThumb.js'
import { animationClipFromJSON, retargetPreviewBVH } from '../three/posePreviewRetarget.js'
import HandPoseSection from './HandPoseSection.jsx'
import { confirmDialog } from '../dialogs.js'

const TABS = [['body', 'Body'], ['hand', 'Hand'], ['animation', 'Animation']]
const EMPTY = {
  body: 'No body presets yet. Drop .bvh files into src/poseLibrary/body/ and rebuild, or save your own from the Pose panel.',
  hand: 'No hand presets yet. Drop .bvh files into src/poseLibrary/hand/ and rebuild, or save a hand from the Pose panel.',
  animation: 'No animation presets yet. Drop .bvh files into src/poseLibrary/animation/ and rebuild, or save a clip from Animate.',
}

function Thumb({ thumb, image, animation, hand = false }) {
  if (image) return <img className="pl-thumb pl-thumb-model" src={image} alt="" />
  if (!thumb || !thumb.segs?.length) {
    return animation
      ? <svg className="pl-thumb pl-thumb-model" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="22" fill="#2f3339"/><path d="M43 34 L43 66 L68 50 Z" fill="#dfe4e9"/></svg>
      : <div className="pl-thumb pl-thumb-empty">…</div>
  }
  return (
    <svg className="pl-thumb pl-thumb-model" viewBox="0 0 100 100" aria-hidden="true">
      {thumb.segs.map(([x1, y1, x2, y2], i) => (
        <line
          key={i}
          x1={x1}
          y1={100 - y1}
          x2={x2}
          y2={100 - y2}
          stroke="#aeb5bd"
          strokeWidth={hand ? 5.2 : 7.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {hand && thumb.segs.length > 0 && (
        <circle
          cx={thumb.segs.reduce((sum, [, , x2]) => sum + x2, 0) / thumb.segs.length}
          cy={100 - thumb.segs.reduce((sum, [, , , y2]) => sum + y2, 0) / thumb.segs.length}
          r="3.2"
          fill="#dfe4e9"
        />
      )}
      {animation && <circle cx="82" cy="82" r="11" fill="#e8863a"/>}
      {animation && <path d="M79 76 L79 88 L88 82 Z" fill="#fff"/>}
    </svg>
  )
}

function normalizePreviewBoneName(name) {
  return String(name || '')
    .replace(/^(mixamorig)?[:_\-.]*/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
}

function findPreviewBone(root, sourceName) {
  if (!root || !sourceName) return null
  const exact = root.getObjectByName(sourceName)
  if (exact) return exact
  const source = normalizePreviewBoneName(sourceName)
  let found = null
  root.traverse((object) => {
    if (found || !object.isBone) return
    const name = normalizePreviewBoneName(object.name)
    if (name === source || name.endsWith(source) || source.endsWith(name)) found = object
  })
  return found
}

function PosePreview({ tab, entry, side, strength, handAdjust, previewVersion }) {
  const hostRef = useRef(null)
  const previewRef = useRef(null)
  const [status, setStatus] = useState('Loading example model…')
  const [ready, setReady] = useState(false)
  const tabRef = useRef(tab)
  const sideRef = useRef(side)
  const handAdjustRef = useRef(handAdjust)
  tabRef.current = tab
  sideRef.current = side
  handAdjustRef.current = handAdjust

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const scene = new THREE.Scene()
    scene.background = null
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100)
    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch {
      setStatus('3D preview unavailable')
      return undefined
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setClearColor(0x000000, 0)
    renderer.domElement.className = 'pl-preview-canvas'
    host.appendChild(renderer.domElement)

    scene.add(new THREE.HemisphereLight(0xffffff, 0x30343a, 2.2))
    const key = new THREE.DirectionalLight(0xffffff, 2.6)
    key.position.set(3, 5, 4)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0xbad8ff, 1.2)
    rim.position.set(-4, 2, -3)
    scene.add(rim)

    let disposed = false
    let frame = 0
    let root = null
    let rest = null

    const resize = () => {
      const rect = host.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      renderer.setSize(rect.width, rect.height, false)
      const aspect = rect.width / rect.height
      camera.left = -1 * aspect
      camera.right = 1 * aspect
      camera.top = 1
      camera.bottom = -1
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    new GLTFLoader().load(
      '/models/Base_rigged.glb',
      (gltf) => {
        if (disposed) return
        root = gltf.scene
        root.updateWorldMatrix(true, true)
        const bounds = new THREE.Box3().setFromObject(root)
        const size = bounds.getSize(new THREE.Vector3())
        const height = Math.max(size.y, 0.001)
        const scale = 2 / height
        root.scale.setScalar(scale)
        root.position.set(0, -bounds.min.y * scale, 0)
        root.updateWorldMatrix(true, true)
        scene.add(root)
        rest = []
        root.traverse((object) => {
          if (object.isBone) rest.push({
            object,
            position: object.position.clone(),
            quaternion: object.quaternion.clone(),
            scale: object.scale.clone(),
          })
        })
        previewRef.current = { root, rest, resetPose, framePreview, camera, scene }
        setStatus('')
        framePreview()
        setReady(true)
      },
      undefined,
      () => setStatus('Could not load example model'),
    )

    const resetPose = () => {
      if (!rest) return
      for (const item of rest) {
        item.object.position.copy(item.position)
        item.object.quaternion.copy(item.quaternion)
        item.object.scale.copy(item.scale)
      }
      if (root) root.updateWorldMatrix(true, true)
    }

    const framePreview = () => {
      if (!root) return
      root.updateWorldMatrix(true, true)
      const activeTab = tabRef.current
      const activeSide = sideRef.current
      if (activeTab === 'hand') {
        const wantedSide = activeSide === 'L' ? 'LeftHand' : activeSide === 'R' ? 'RightHand' : 'RightHand'
        const hand = findPreviewBone(root, wantedSide) || root.getObjectByName(wantedSide)
        const tipNames = activeSide === 'L'
          ? ['LeftHandThumb4', 'LeftHandIndex4', 'LeftHandMiddle4', 'LeftHandRing4', 'LeftHandPinky4']
          : ['RightHandThumb4', 'RightHandIndex4', 'RightHandMiddle4', 'RightHandRing4', 'RightHandPinky4']
        const tips = tipNames.map((name) => findPreviewBone(root, name)?.getWorldPosition(new THREE.Vector3())).filter(Boolean)
        const handPosition = hand ? hand.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3()
        const fingerCenter = tips.length
          ? tips.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / tips.length)
          : handPosition.clone().add(new THREE.Vector3(0, 0.18, 0))
        const wristToFingers = fingerCenter.clone().sub(handPosition)
        const target = handPosition.clone().lerp(fingerCenter, 0.55)

        const rect = host.getBoundingClientRect()
        const aspect = rect.width && rect.height ? rect.width / rect.height : 1
        const rigBones = []
        root.traverse((object) => { if (object.isBone) rigBones.push(object) })
        const rigs = analyseHands(rigBones, () => new THREE.Quaternion())
        const rig = rigs.find((item) => item.side === activeSide) || rigs.find((item) => item.side === 'R') || rigs[0]

        let palmNormal = new THREE.Vector3(0, 0, 1)
        let palmUp = wristToFingers.clone().normalize()
        if (rig?.frame) {
          const worldFrame = rig.hand.getWorldQuaternion(new THREE.Quaternion()).multiply(rig.frame.handLocal)
          palmNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(worldFrame).normalize()
          palmUp = new THREE.Vector3(0, 1, 0).applyQuaternion(worldFrame).normalize()
        }
        const palmRight = palmUp.clone().cross(palmNormal).normalize()

        const points = [handPosition, fingerCenter, ...tips]
        let halfWidth = 0.12
        let halfHeight = 0.12
        for (const point of points) {
          const local = point.clone().sub(target)
          halfWidth = Math.max(halfWidth, Math.abs(local.dot(palmRight)))
          halfHeight = Math.max(halfHeight, Math.abs(local.dot(palmUp)))
        }
        const margin = 1.28
        halfWidth *= margin
        halfHeight *= margin
        if (halfHeight * aspect > halfWidth) halfWidth = halfHeight * aspect
        else halfHeight = halfWidth / aspect

        camera.left = -halfWidth
        camera.right = halfWidth
        camera.top = halfHeight
        camera.bottom = -halfHeight
        camera.position.copy(target).add(palmNormal.multiplyScalar(Math.max(halfWidth, halfHeight) * 2))
        camera.up.copy(palmUp)
        camera.lookAt(target)
        camera.updateProjectionMatrix()
      } else {
        const bounds = posedBoneBounds(root)
        if (bounds.isEmpty()) return
        const center = bounds.getCenter(new THREE.Vector3())
        const size = bounds.getSize(new THREE.Vector3())
        const rectNow = host.getBoundingClientRect()
        const aspect = rectNow.width && rectNow.height ? rectNow.width / rectNow.height : 1
        const halfHeight = Math.max(size.y * 0.58, (size.x / 2) / aspect * 1.12)
        camera.left = -halfHeight * aspect
        camera.right = halfHeight * aspect
        camera.top = halfHeight
        camera.bottom = -halfHeight
        camera.up.set(0, 1, 0)
        camera.position.set(center.x + size.x * 0.08, center.y, size.y * 2.2)
        camera.lookAt(center)
        camera.updateProjectionMatrix()
      }
    }

    previewRef.current = { root: null, rest: null, resetPose, framePreview, camera, scene }
    const render = () => {
      if (disposed) return
      const preview = previewRef.current
      const animation = preview?.animation
      if (animation?.running && animation.clip) {
        const elapsed = (performance.now() - animation.startedAt) / 1000
        if (elapsed <= animation.clip.duration) {
          preview.resetPose()
          applyClipFrame(preview.root, animation.clip, elapsed, animation.resolveTarget)
          preview.framePreview()
        } else {
          animation.running = false
          preview.resetPose()
          applyClipFrame(preview.root, animation.clip, representativeClipTime(animation.clip), animation.resolveTarget)
          preview.framePreview()
        }
      }
      renderer.render(scene, camera)
      frame = requestAnimationFrame(render)
    }
    frame = requestAnimationFrame(render)

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      scene.traverse((object) => {
        if (object.geometry) object.geometry.dispose()
        if (object.material) {
          const materials = Array.isArray(object.material) ? object.material : [object.material]
          for (const material of materials) material.dispose()
        }
      })
      renderer.dispose()
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement)
      previewRef.current = null
    }
  }, [])

  useEffect(() => {
    const preview = previewRef.current
    if (!preview?.root || !preview.resetPose) return
    preview.resetPose()
    preview.animation = null
    let cancelled = false

    const apply = async () => {
      if (!entry) {
        setStatus('')
        preview.framePreview()
        return
      }
      setStatus('')
      try {
        if (tab === 'hand' && handAdjustRef.current) {
          const bones = []
          preview.root.traverse((object) => { if (object.isBone) bones.push(object) })
          const identity = () => new THREE.Quaternion()
          const adjust = handAdjustRef.current
          const rigs = rigsForSide(analyseHands(bones, identity), adjust.side)
          for (const rig of rigs) {
            for (const [boneName, value] of Object.entries(handPoseToBoneQuats(
              rig,
              analyticHandPose(rig, { curl: adjust.curl, spread: adjust.spread }),
            ))) {
              const bone = preview.root.getObjectByName(boneName)
              if (bone) bone.quaternion.set(value[0], value[1], value[2], value[3])
            }
          }
        } else if (tab === 'body') {
          if (entry.source === 'preset') {
            const { BVHLoader } = await import('three/examples/jsm/loaders/BVHLoader.js')
            const text = await loadPresetPoseText(entry)
            if (cancelled) return
            const parsed = new BVHLoader().parse(text)
            const sourceName = parsedBVHResolver(parsed)
            for (const track of parsed.clip.tracks) {
              const match = /^(.+)\.(quaternion|position)$/.exec(track.name)
              if (!match) continue
              const bone = findPreviewBone(preview.root, sourceName(match[1]))
              if (!bone) continue
              if (match[2] === 'quaternion') {
                const values = track.values
                bone.quaternion.set(values[0] || 0, values[1] || 0, values[2] || 0, values[3] ?? 1)
              } else if (match[2] === 'position') {
                const values = track.values
                bone.position.set(values[0] || 0, values[1] || 0, values[2] || 0)
              }
            }
          } else if (entry.data?.bones) {
            for (const [name, value] of Object.entries(entry.data.bones)) {
              const bone = findPreviewBone(preview.root, name)
              if (bone && value?.length >= 4) bone.quaternion.set(value[0], value[1], value[2], value[3])
            }
          }
        } else if (tab === 'hand') {
          const bones = []
          preview.root.traverse((object) => { if (object.isBone) bones.push(object) })
          const identity = () => new THREE.Quaternion()
          let poses = null
          if (entry.source === 'basic') {
            const rigs = rigsForSide(analyseHands(bones, identity), side)
            for (const rig of rigs) {
              for (const [boneName, value] of Object.entries(handPoseToBoneQuats(rig, analyticHandPose(rig, entry), strength / 100))) {
                const bone = preview.root.getObjectByName(boneName)
                if (bone) bone.quaternion.set(value[0], value[1], value[2], value[3])
              }
            }
          } else if (entry.source === 'preset') {
            const { BVHLoader } = await import('three/examples/jsm/loaders/BVHLoader.js')
            const text = await loadPresetPoseText(entry)
            if (cancelled) return
            const parsed = new BVHLoader().parse(text)
            poses = handPosesFromBVH(parsed)
          } else {
            poses = Object.fromEntries(Object.entries(entry.data?.poses || {}).map(([key, pose]) => [key, migrateHandPose(pose)]))
          }
          if (poses) {
            preview.root.updateWorldMatrix(true, true)
            const rigs = rigsForSide(analyseHands(bones, identity), side)
            for (const rig of rigs) {
              const pose = poses[rig.side] || poses.R || poses.L
              if (!pose) continue
              for (const [boneName, value] of Object.entries(handPoseToBoneQuats(rig, pose, strength / 100))) {
                const bone = preview.root.getObjectByName(boneName)
                if (bone) bone.quaternion.set(value[0], value[1], value[2], value[3])
              }
            }
          }
        } else if (tab === 'animation') {
          let clip
          let entryResolver = null
          if (entry.source === 'preset') {
            const text = await loadPresetText(entry)
            if (cancelled) return
            clip = await retargetPreviewBVH(text, preview.root, entry.name)
            if (cancelled) return
          } else {
            clip = animationClipFromJSON(entry.data?.clip)
          }
          if (clip) {
            const resolveTarget = (name) => findPreviewBone(preview.root, entryResolver?.(name) || name)
            const applied = applyClipFrame(preview.root, clip, 0, resolveTarget)
            if (!applied) throw new Error('No animation bones matched the example rig')
            preview.root.updateWorldMatrix(true, true)
            preview.framePreview()
            preview.animation = {
              clip,
              running: true,
              startedAt: performance.now(),
              resolveTarget,
            }
          }
        }
      } catch (error) {
        if (!cancelled) setStatus(`Could not preview this ${tab} (${error?.message || 'invalid data'})`)
      }
      if (cancelled) return
      preview.root.updateWorldMatrix(true, true)
      preview.framePreview()
    }
    apply()
    return () => { cancelled = true }
  }, [ready, tab, entry, side, strength, handAdjust, previewVersion])

  return (
    <div className="pl-preview" aria-label="Example character pose preview">
      {status && <div className="pl-preview-status">{status}</div>}
      <div className="pl-preview-host" ref={hostRef} />
    </div>
  )
}

function Card({ entry, rendered, onApply, onDelete, onRename, onPreview }) {
  const [thumb, setThumb] = useState(entry.thumb || null)
  const [image, setImage] = useState(null)
  const ref = useRef(null)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (entry.thumb || entry.source !== 'preset') return undefined
    let live = true
    const load = () => presetThumb(entry).then((t) => live && setThumb(t))
    if (typeof IntersectionObserver === 'undefined') { load(); return () => { live = false } }
    const io = new IntersectionObserver((hits) => { if (hits[0].isIntersecting) { io.disconnect(); load() } })
    if (ref.current) io.observe(ref.current)
    return () => { live = false; io.disconnect() }
  }, [entry])
  useEffect(() => {
    let live = true
    let objectUrl = null
    if (!rendered) {
      setImage(null)
      return undefined
    }
    const show = (blob) => {
      if (!live || !blob) return
      objectUrl = URL.createObjectURL(blob)
      setImage(objectUrl)
    }
    const load = async () => {
      try {
        const cached = await getRenderedThumb(entry.id)
        if (cached) {
          show(cached)
          return
        }
        const { renderedPoseThumb } = await import('../three/renderedPoseThumb.js')
        const blob = await renderedPoseThumb(entry)
        if (!live) return
        await putRenderedThumb(entry.id, blob)
        show(blob)
      } catch {
        if (live) setImage(null)
      }
    }
    let io
    if (typeof IntersectionObserver === 'undefined') load()
    else {
      io = new IntersectionObserver((hits) => {
        if (hits[0].isIntersecting) {
          io.disconnect()
          load()
        }
      })
      if (ref.current) io.observe(ref.current)
    }
    return () => {
      live = false
      io?.disconnect()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [entry, rendered])
  const duration = thumb?.duration ?? entry.data?.clip?.clip?.duration
  return (
    <div className="pl-card" ref={ref} onMouseEnter={() => onPreview?.(entry)} onFocus={() => onPreview?.(entry)}>
      <button className="pl-card-main" onClick={() => onApply(entry)} title={`Apply “${entry.name}”`}>
        <Thumb thumb={thumb} image={image} animation={entry.kind === 'animation'} hand={entry.kind === 'hand'} />
        {editing ? (
          <input
            className="pl-rename" autoFocus defaultValue={entry.name}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') { onRename(entry, e.currentTarget.value); setEditing(false) }
              if (e.key === 'Escape') setEditing(false)
            }}
            onBlur={() => setEditing(false)}
          />
        ) : <span className="pl-name">{entry.name}</span>}
        <span className="pl-sub">
          {entry.source === 'preset' ? (entry.category || 'Preset') : 'Mine'}
          {duration ? ` · ${duration.toFixed(1)}s` : ''}
        </span>
      </button>
      {entry.source === 'mine' && (
        <span className="pl-card-tools">
          <button title="Rename" onClick={() => setEditing(true)}>✎</button>
          <button title="Delete" className="danger" onClick={() => onDelete(entry)}>×</button>
        </span>
      )}
    </div>
  )
}

export default function PoseLibrary() {
  const tab = useStore((s) => s.poseLibraryTab)
  const open = useStore((s) => s.openPoseLibrary)
  const close = useStore((s) => s.closePoseLibrary)
  const activeClipName = useStore((s) => s.activeClipName)
  const hasCharacter = useStore((s) => !!s.modelInfo)
  const [mine, setMine] = useState([])
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('all')
  const [category, setCategory] = useState('all')
  const [keepHands, setKeepHands] = useState(true)
  const [side, setSide] = useState('both')
  const [strength, setStrength] = useState(100)
  const [msg, setMsg] = useState(null)
  const [saveName, setSaveName] = useState('')
  const [manage, setManage] = useState(false)
  const fileRef = useRef(null)
  const [previewEntry, setPreviewEntry] = useState(null)
  const [handAdjust, setHandAdjust] = useState(null)
  const [renderedCards, setRenderedCards] = useState(false)
  const [previewVersion, setPreviewVersion] = useState(0)

  const refresh = useCallback(async () => {
    const all = await listEntries()
    const updated = await Promise.all(all.map(backfillAnimationThumb))
    setMine(updated.map((entry) => ({ ...entry, source: 'mine' })))
  }, [])
  useEffect(() => { if (tab) refresh() }, [tab, refresh])
  useEffect(() => { setCategory('all'); setQuery('') }, [tab])
  useEffect(() => {
    if (!tab) return undefined
    const onKey = (e) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, close])

  const items = useMemo(() => {
    if (!tab) return []
    const presets = listPresets(tab)
    const basics = tab === 'hand' ? BASIC_HANDS.map((b) => ({
      ...b,
      source: 'basic',
      kind: 'hand',
      category: 'Basic',
      thumb: basicHandThumb(b),
    })) : []
    return [...mine.filter((e) => e.kind === tab), ...basics, ...presets]
  }, [tab, mine])
  const categories = useMemo(() => [...new Set(items.map((i) => i.category).filter(Boolean))], [items])
  const q = query.trim().toLowerCase()
  const shown = items.filter((i) =>
    (source === 'all' || (source === 'mine' ? i.source === 'mine' : i.source !== 'mine')) &&
    (category === 'all' || i.category === category) &&
    (!q || i.name.toLowerCase().includes(q) || (i.category || '').toLowerCase().includes(q)))
  useEffect(() => {
    setHandAdjust(null)
    setPreviewEntry(shown[0] || null)
  }, [tab, category, source, q])

  if (!tab) return null

  const run = async (fn) => {
    try { setMsg(await fn()) } catch (e) { setMsg(e.message || String(e)) }
  }
  const onApply = (entry) => run(async () => {
    if (!hasCharacter) throw new Error('Load a character first.')
    if (tab === 'body') {
      const r = await applyBodyEntry(entry, { keepHands })
      return `Applied “${r.label}” (${r.applied} bones${r.skipped ? `, ${r.skipped} not on this rig` : ''}).`
    }
    if (tab === 'hand') {
      const r = await applyHandEntry(entry, { side, amount: strength / 100 })
      return `Applied “${r.label}” to the ${side === 'L' ? 'left hand' : side === 'R' ? 'right hand' : 'hands'}.`
    }
    const r = await applyAnimationEntry(entry)
    return `Added the clip “${r.name}” — press Play in Animate.`
  })
  const onSave = (fn) => run(async () => { const e = await fn(); await refresh(); setSource('all'); setSaveName(''); return `Saved “${e.name}” to the library.` })
  const onDelete = (e) => { if (confirmDialog(`Delete “${e.name}” from your library?`)) deleteEntry(e.id).then(refresh) }
  const onRename = (e, name) => { if (name && name.trim()) renameEntry(e.id, name.trim()).then(refresh) }
  const nameOrUndefined = () => saveName.trim() || undefined
  const onExport = () => run(async () => {
    const blob = new Blob([JSON.stringify(await exportLibraryJSON())], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = 'pose-library.json'; a.click(); URL.revokeObjectURL(a.href)
    return 'Library exported.'
  })
  const onImport = (e) => {
    const file = e.target.files?.[0]; e.target.value = ''
    if (file) run(async () => { const n = await importLibraryJSON(JSON.parse(await file.text())); await refresh(); return `Imported ${n} entr${n === 1 ? 'y' : 'ies'}.` })
  }

  return (
    <aside className="pl-panel" role="dialog" aria-label="Pose Library">
      <div className="pl-head">
        <div className="seg">
          {TABS.map(([key, label]) => (
            <button key={key} className={'seg-btn' + (tab === key ? ' active' : '')} onClick={() => open(key)}>{label}</button>
          ))}
        </div>
        <button className="icon-btn danger" title="Close (Esc)" aria-label="Close Pose Library" onClick={close}>×</button>
      </div>

      <div className="pl-tools">
        <input className="pl-search" type="search" placeholder={`Search ${tab} poses…`} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="pl-chips">
          {[['all', 'All'], ['presets', 'Presets'], ['mine', 'Mine']].map(([k, l]) => (
            <button key={k} className={'pl-chip' + (source === k ? ' active' : '')} onClick={() => setSource(k)}>{l}</button>
          ))}
        </div>
        {categories.length > 0 && (
          <div className="pl-chips">
            {['all', ...categories].map((c) => (
              <button key={c} className={'pl-chip' + (category === c ? ' active' : '')} onClick={() => setCategory(c)}>{c === 'all' ? 'Any type' : c}</button>
            ))}
          </div>
        )}
        {tab === 'body' && (
          <label className="pl-check" title="Body poses leave the fingers as they are, so a hand pose you picked stays put">
            <input type="checkbox" checked={keepHands} onChange={(e) => setKeepHands(e.target.checked)} /> Keep current hand poses
          </label>
        )}
        <label className="pl-check" title="Use a rendered example character instead of stick figures. Images are cached locally.">
          <input type="checkbox" checked={renderedCards} onChange={(e) => setRenderedCards(e.target.checked)} />
          Rendered cards
        </label>
        {tab === 'hand' && (
          <div className="pl-hand-apply">
            <div className="seg">
              {[['L', 'Left'], ['R', 'Right'], ['both', 'Both']].map(([k, l]) => (
                <button key={k} className={'seg-btn' + (side === k ? ' active' : '')} onClick={() => setSide(k)}>{l}</button>
              ))}
            </div>
            <label className="hand-slider"><span>Strength</span>
              <input type="range" min="0" max="120" value={strength} onChange={(e) => setStrength(Number(e.target.value))} /><b>{strength}%</b>
            </label>
          </div>
        )}
      </div>

      <PosePreview
        key={tab}
        tab={tab}
        entry={previewEntry}
        side={side}
        strength={strength}
        handAdjust={handAdjust}
        previewVersion={previewVersion}
      />

      <div className="pl-grid">
        {shown.map((entry) => (
          <Card
            key={entry.id || entry.name}
            entry={entry}
            rendered={renderedCards}
            onApply={onApply}
            onDelete={onDelete}
            onRename={onRename}
            onPreview={(next) => {
              setHandAdjust(null)
              setPreviewEntry(next)
              setPreviewVersion((version) => version + 1)
            }}
          />
        ))}
        {!shown.length && <div className="pl-empty">{items.length ? 'Nothing matches.' : EMPTY[tab]}</div>}
      </div>

      {tab === 'hand' && (
        <details className="pl-sliders">
          <summary>Hand sliders (open ↔ fist)</summary>
          <HandPoseSection onMessage={setMsg} onPreviewChange={(value) => {
            setSide(value.side)
            setHandAdjust(value)
          }} />
        </details>
      )}

      <div className="pl-foot">
        <input className="pl-search" placeholder="Name for what you save (optional)" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
                {tab === 'body' && <button className="btn" disabled={!hasCharacter} onClick={() => onSave(() => saveCurrentBodyPose(nameOrUndefined()))}>Save current pose</button>}
        {tab === 'hand' && (<>
          <button className="btn" disabled={!hasCharacter} onClick={() => onSave(() => saveCurrentHandPose('L', nameOrUndefined()))}>Save left hand</button>
          <button className="btn" disabled={!hasCharacter} onClick={() => onSave(() => saveCurrentHandPose('R', nameOrUndefined()))}>Save right hand</button>
        </>)}
        {tab === 'animation' && <button className="btn" disabled={!activeClipName} title={activeClipName ? '' : 'Pick a clip in Animate first'} onClick={() => onSave(() => saveClipToLibrary(activeClipName, nameOrUndefined()))}>Save current clip</button>}
        <button className={'pl-dots' + (manage ? ' active' : '')} title="More: import / export library" aria-label="More options" aria-pressed={manage} onClick={() => setManage((m) => !m)}>⋯</button>
      </div>
      {manage && (
        <div className="pl-manage">
          <b>Backup</b>
          <div className="pl-foot">
            <button className="btn secondary" onClick={onExport}>Export library</button>
            <button className="btn secondary" onClick={() => fileRef.current?.click()}>Import library</button>
          </div>
        </div>
      )}
      <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onImport} />
      {!isPersistent() && <div className="pl-msg">Browser storage isn’t available, so saved poses will be lost when you close the app. Use Export library to keep them.</div>}
      {msg && <div className="pl-msg">{msg}</div>}
    </aside>
  )
}
