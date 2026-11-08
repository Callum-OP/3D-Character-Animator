// Native dialogs in the packaged (Electron) app leave the window "half focused": the page still receives
// clicks on plain buttons, but native form controls - notably <select> popups such as the clip dropdown -
// stop responding until another native dialog opens and closes (which is why Open clip... then Cancel used
// to bring the dropdown back). This happened after deleting a model (window.confirm) and after importing one
// (the browser file picker).
//
// In Electron, confirms are shown by the main process (window.animare.confirm) and the window is explicitly
// refocused afterwards (window.animare.refocusWindow). In a plain browser window.confirm is used as before.

export function restoreFocusAfterNativeDialog() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const refocus = () => {
    try {
      window.animare?.refocusWindow?.()
    } catch {
      // best effort only
    }
  }
  try {
    const active = document.activeElement
    if (active && active !== document.body && typeof active.blur === 'function') active.blur()
  } catch {
    // best effort only
  }
  refocus()
  setTimeout(refocus, 0)
  setTimeout(refocus, 120)
}

export function confirmDialog(message) {
  const native = typeof window !== 'undefined' ? window.animare : null
  const ok = typeof native?.confirm === 'function' ? !!native.confirm(message) : window.confirm(message)
  restoreFocusAfterNativeDialog()
  return ok
}

// <input type="file"> pickers are native dialogs too: refocus once one closes, whether a file was chosen
// ('change') or it was cancelled ('cancel' - it does not bubble, hence the capture listener).
export function installNativeDialogFocusGuard() {
  if (typeof document === 'undefined') return () => {}
  const onClose = (e) => {
    if (e.target && e.target.type === 'file') restoreFocusAfterNativeDialog()
  }
  document.addEventListener('change', onClose, true)
  document.addEventListener('cancel', onClose, true)
  return () => {
    document.removeEventListener('change', onClose, true)
    document.removeEventListener('cancel', onClose, true)
  }
}
