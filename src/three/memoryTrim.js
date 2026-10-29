// Giving memory back after a project is cleared (New Project, or the clear that precedes opening one).
//
// Disposing a model frees its graphics memory straight away, but the page keeps a lot of other things
// until the garbage collector next runs — decoded textures, geometry arrays, the old project's JS objects —
// and V8 is in no hurry when the heap limit is high. On the desktop app the renderer is started with
// --expose-gc (see electron/main.cjs), so after a clear we ask for one collection. In a browser there is
// no such function and this does nothing beyond the renderer clean-up.

let timer = null

export function trimMemory(renderer) {
  try {
    renderer?.renderLists?.dispose?.() // the per-frame sorted lists keep references to the last frame's objects
  } catch {
    /* best-effort */
  }
  if (typeof globalThis.gc !== 'function') return
  clearTimeout(timer)
  // Let the disposals and the next render settle first, then collect once (it can take a moment on a big heap).
  timer = setTimeout(() => {
    timer = null
    try {
      globalThis.gc()
    } catch {
      /* not exposed after all */
    }
  }, 1500)
}
