// One "Save changes?" box for everything that would throw away unsaved work: closing the app,
// starting a new project, opening another one. The box itself lives in CloseGuard.jsx (mounted once
// in App); this is the small hand-off between whoever needs to ask and that box.

let host = null

// CloseGuard registers itself here. `host(request)` shows the box for `request`
// ({ verb, resolve }) and later calls request.resolve(true | false).
export function registerUnsavedPromptHost(fn) {
  host = fn
  return () => {
    if (host === fn) host = null
  }
}

// Shows the box. Resolves true when it is fine to go ahead (saved, or "Don't save") and false on Cancel.
// `verb` finishes the sentence "Your changes will be lost if you ... without saving."
export function askAboutUnsavedWork(verb = 'continue') {
  return new Promise((resolve) => {
    if (!host) {
      // No box mounted (should not happen in the app): fall back to the plain browser question.
      resolve(typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(`You have unsaved changes. If you ${verb}, they will be lost. Continue?`)
        : true)
      return
    }
    host({ verb, resolve })
  })
}
