// File System Access API gate shared by project + clip file handling.
//
// showOpenFilePicker / showSaveFilePicker exist on Chromium, but browsers
// refuse them inside a CROSS-ORIGIN iframe ("Cross origin sub frames aren't
// allowed to show a file picker") — which is exactly how itch.io embeds a
// web build (the game runs on html.itch.zone inside a page on itch.io). There
// the picker API must be treated as unavailable so the app uses its plain
// <input type="file"> / download fallbacks instead.

// True when this window is framed by a page from a different origin (reading
// the top window's location throws a SecurityError in that case).
export function inCrossOriginFrame(win = typeof window !== 'undefined' ? window : null) {
  if (!win) return false
  try {
    if (win.self === win.top) return false
    void win.top.location.href
    return false
  } catch {
    return true
  }
}

// Can we actually show a native open/save picker here?
export function pickerUsable(win = typeof window !== 'undefined' ? window : null) {
  if (!win || typeof win.showOpenFilePicker !== 'function') return false
  return !inCrossOriginFrame(win)
}

// A picker call that the browser refused for security reasons (cross-origin
// frame, sandboxed iframe, missing user activation policy…) — as opposed to
// the user cancelling (AbortError).
export function isPickerBlocked(err) {
  return err?.name === 'SecurityError' || err?.name === 'NotAllowedError'
}

// Ask for ONE file through a plain <input type="file"> (works everywhere the
// native picker doesn't, including embedded cross-origin iframes). Resolves
// with the chosen File, or null if the dialog was dismissed. Must be called
// from a user gesture (a click handler) or the browser will ignore it.
export function pickFileWithInput(accept = '') {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    input.style.display = 'none'
    let done = false
    const finish = (file) => {
      if (done) return
      done = true
      input.remove()
      resolve(file)
    }
    input.addEventListener('change', () => finish(input.files && input.files[0] ? input.files[0] : null))
    input.addEventListener('cancel', () => finish(null))
    document.body.appendChild(input)
    input.click()
  })
}