import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store.js'
import { isProjectDirty, markProjectSaveFailed } from '../three/projectDirty.js'
import { saveCurrentProject } from '../three/projectSession.js'
import { hasPendingSaves, waitForPendingSaves } from '../three/projectStore.js'
import { askAboutUnsavedWork, registerUnsavedPromptHost } from '../three/unsavedPrompt.js'

// The "Save changes?" box. Used whenever unsaved work is about to be thrown away: closing the app,
// New Project, Open / Open recent (they ask through confirmDiscardUnsaved in projectDirty.js).
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
  const [verb, setVerb] = useState('close the app')
  const openRef = useRef(false)
  const resolveRef = useRef(null)
  const name = useStore((s) => s.currentProject?.name)

  // Anyone asking "is it OK to lose the unsaved work?" gets this box.
  useEffect(
    () =>
      registerUnsavedPromptHost((request) => {
        if (openRef.current) {
          request.resolve(false) // already asking something: treat a second ask as Cancel
          return
        }
        openRef.current = true
        resolveRef.current = request.resolve
        setVerb(request.verb)
        setError(null)
        setOpen(true)
      }),
    []
  )

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.animare : null
    if (bridge && bridge.onCloseRequested) {
      return bridge.onCloseRequested(() => {
        bridge.closeAck() // tell the main process the page is alive and handling it
        const decide = (failures = []) => {
          if (!isProjectDirty() && !failures.length) {
            bridge.closeNow()
            return
          }
          askAboutUnsavedWork('close the app').then((ok) => {
            if (ok) bridge.closeNow()
          })
        }
        // A save that is still being written finishes first; only then is "unsaved changes" a real question.
        if (hasPendingSaves()) waitForPendingSaves().then(decide)
        else decide()
      })
    }
    const onBeforeUnload = (e) => {
      if (!isProjectDirty() && !hasPendingSaves()) return
      e.preventDefault()
      e.returnValue = '' // required by some browsers to show the warning
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // proceed = true: carry on with whatever was asked (close / new / open); false: stay put.
  function close(proceed) {
    openRef.current = false
    setOpen(false)
    setBusy(false)
    const resolve = resolveRef.current
    resolveRef.current = null
    resolve?.(proceed)
  }

  async function onSave() {
    setBusy(true)
    setError(null)
    try {
      await saveCurrentProject()
      if (isProjectDirty()) {
        setBusy(false)
        setError({ title: 'Changes not yet saved', message: 'The project changed while it was saving. Save again to include your latest changes.' })
        return
      }
      close(true)
    } catch (e) {
      setBusy(false)
      // Cancelling the "where to save" dialog just returns to this box; the app stays open.
      if (e?.name !== 'AbortError') {
        markProjectSaveFailed()
        setError({ title: 'Save failed', message: 'Could not save: ' + (e?.message || String(e)) })
      }
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
        <p className="help-intro">Your changes will be lost if you {verb} without saving.</p>
        {error && (
          <div className="save-error-details" role="alert">
            <strong>{error.title}</strong>
            <p>{error.message}</p>
            <p>Your changes are still in the app. Try saving again or choose Don&apos;t save to discard them.</p>
          </div>
        )}
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
