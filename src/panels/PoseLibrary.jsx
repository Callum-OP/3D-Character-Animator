import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store.js'
import { listPresets, presetThumb } from '../three/poseLibraryPresets.js'
import { listEntries, deleteEntry, renameEntry, exportLibraryJSON, importLibraryJSON, isPersistent } from '../three/poseLibraryStore.js'
import {
  applyBodyEntry, applyHandEntry, applyAnimationEntry,
  saveCurrentBodyPose, saveCurrentHandPose, saveClipToLibrary, BASIC_HANDS,
} from '../three/poseLibraryActions.js'
import HandPoseSection from './HandPoseSection.jsx'
import { confirmDialog } from '../dialogs.js'

const TABS = [['body', 'Body'], ['hand', 'Hand'], ['animation', 'Animation']]
const EMPTY = {
  body: 'No body presets yet. Drop .bvh files into src/poseLibrary/body/ and rebuild, or save your own from the Pose panel.',
  hand: 'No hand presets yet. Drop .bvh files into src/poseLibrary/hand/ and rebuild, or save a hand from the Pose panel.',
  animation: 'No animation presets yet. Drop .bvh files into src/poseLibrary/animation/ and rebuild, or save a clip from Animate.',
}

function Thumb({ thumb, animation }) {
  if (!thumb || !thumb.segs?.length) {
    return <div className="pl-thumb pl-thumb-empty">{animation ? '🎬' : '…'}</div>
  }
  return (
    <svg className="pl-thumb" viewBox="0 0 100 100" aria-hidden="true">
      {thumb.segs.map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={100 - y1} x2={x2} y2={100 - y2} stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      ))}
    </svg>
  )
}

function Card({ entry, onApply, onDelete, onRename }) {
  const [thumb, setThumb] = useState(entry.thumb || null)
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
  const duration = thumb?.duration ?? entry.data?.clip?.clip?.duration
  return (
    <div className="pl-card" ref={ref}>
      <button className="pl-card-main" onClick={() => onApply(entry)} title={`Apply “${entry.name}”`}>
        <Thumb thumb={thumb} animation={entry.kind === 'animation'} />
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

  const refresh = useCallback(() => listEntries().then((all) => setMine(all.map((e) => ({ ...e, source: 'mine' })))), [])
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
    const basics = tab === 'hand' ? BASIC_HANDS.map((b) => ({ ...b, source: 'basic', kind: 'hand', category: 'Basic' })) : []
    return [...mine.filter((e) => e.kind === tab), ...basics, ...presets]
  }, [tab, mine])
  const categories = useMemo(() => [...new Set(items.map((i) => i.category).filter(Boolean))], [items])
  const q = query.trim().toLowerCase()
  const shown = items.filter((i) =>
    (source === 'all' || (source === 'mine' ? i.source === 'mine' : i.source !== 'mine')) &&
    (category === 'all' || i.category === category) &&
    (!q || i.name.toLowerCase().includes(q) || (i.category || '').toLowerCase().includes(q)))

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

      <div className="pl-grid">
        {shown.map((entry) => <Card key={entry.id || entry.name} entry={entry} onApply={onApply} onDelete={onDelete} onRename={onRename} />)}
        {!shown.length && <div className="pl-empty">{items.length ? 'Nothing matches.' : EMPTY[tab]}</div>}
      </div>

      {tab === 'hand' && (
        <details className="pl-sliders">
          <summary>Hand sliders (open ↔ fist)</summary>
          <HandPoseSection onMessage={setMsg} />
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
