import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import { isProjectDirty } from '../three/projectDirty.js'
import { saveCurrentProject } from '../three/projectSession.js'

// Asks "Save changes?" when the app is being closed with unsaved work.
//
//  - Desktop app: the main process hands every close attempt to us first (window.animare). With
//    nothing unsaved we let it through at once; otherwise a Save / Don't save / Cancel box shows.
//  - In a browser: pages can't show their own box on close, only the browser's generic
//    "Leave site?" warning, so that is what unsaved work gets there. (Not used in the desktop app,
//    where the same handler would block the window from closing at all.)
export default function CloseGuard() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const openRef = useRef(false)
  const name = useStore((s) => s.currentProject?.name)

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.animare : null
    if (bridge && bridge.onCloseRequested) {
      return bridge.onCloseRequested(() => {
        bridge.closeAck() // tell the main process the page is alive and handling it
        if (!isProjectDirty()) {
          bridge.closeNow()
          return
        }
        if (openRef.current) return // already asking
        openRef.current = true
        setError(null)
        setOpen(true)
      })
    }
    const onBeforeUnload = (e) => {
      if (!isProjectDirty()) return
      e.preventDefault()
      e.returnValue = '' // required by some browsers to show the warning
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  function close(reallyQuit) {
    openRef.current = false
    setOpen(false)
    setBusy(false)
    if (reallyQuit) window.animare?.closeNow()
  }

  async function onSave() {
    setBusy(true)
    setError(null)
    try {
      await saveCurrentProject()
      close(true)
    } catch (e) {
      setBusy(false)
      // Cancelling the "where to save" dialog just returns to this box; the app stays open.
      if (e?.name !== 'AbortError') setError('Could not save: ' + (e?.message || String(e)))
    }
  }

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) close(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy])

  if (!open) return null
  return (
    <div className="help-backdrop" role="presentation">
      <div className="help-modal close-guard" role="alertdialog" aria-modal="true" aria-labelledby="close-guard-title">
        <h2 id="close-guard-title">Save changes{name ? ` to “${name}”` : ''}?</h2>
        <p className="help-intro">Your changes will be lost if you close without saving.</p>
        {error && <p className="close-guard-error" role="alert">{error}</p>}
        <div className="close-guard-actions">
          <button className="btn" onClick={onSave} disabled={busy} autoFocus>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button className="btn secondary" onClick={() => close(true)} disabled={busy}>
            Don&apos;t save
          </button>
          <button className="btn secondary" onClick={() => close(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
