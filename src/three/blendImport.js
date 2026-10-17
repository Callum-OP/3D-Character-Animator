import { stemOf } from './modelBundle.js'

// ---------------------------------------------------------------------------
// .blend import: hand the file to the user's own Blender (desktop app only), get a
// .glb back, and load THAT with the normal pipeline. Everything else (textures,
// rigs, animation, saving into projects) then works exactly as for any glTF.
//
// The conversion runs in Electron's main process (electron/blender.cjs); this is the
// renderer's side of it. In the browser build there is no bridge and no Blender, so
// .blend files get a clear explanation instead.
// ---------------------------------------------------------------------------

export const BLEND_WEB_MESSAGE =
  'Opening .blend files needs the desktop app, which uses your own copy of Blender (free from blender.org) to convert the file. ' +
  'In the browser, export it from Blender first: File ▸ Export ▸ glTF 2.0 (.glb).'

export function blenderBridge() {
  return typeof window !== 'undefined' && window.animare && window.animare.blender ? window.animare.blender : null
}

// Converting can take a while, so a File is only ever converted once: importModelAuto
// loads the same File twice (a probe to tell characters from props, then the real
// load) and each would otherwise start Blender.
const conversions = new WeakMap() // File -> Promise<{ file, warnings, blenderVersion }>

// files: Map<path, Uint8Array> — the .blend plus whatever sat beside it (textures, linked
// libraries); mainPath: the .blend's key in `files`; sourceFile: the File the user gave us
// (the cache key); displayName: what to call the model.
export function convertBlendToGlb(sourceFile, files, mainPath, displayName) {
  if (conversions.has(sourceFile)) return conversions.get(sourceFile)
  const job = (async () => {
    const bridge = blenderBridge()
    if (!bridge) throw new Error(BLEND_WEB_MESSAGE)
    const result = await bridge.convert({
      main: mainPath,
      files: [...files].map(([path, data]) => ({ path, data })),
    })
    if (!result || !result.ok) {
      throw new Error(result && result.error ? result.error : 'Blender could not convert this file.')
    }
    const glb = new File([result.glb], `${stemOf(displayName) || 'model'}.glb`, { type: 'model/gltf-binary' })
    return { file: glb, warnings: result.warnings || [], blenderVersion: result.blenderVersion || null }
  })()
  // A failed conversion shouldn't be cached: the user may fix Blender and retry the same File.
  job.catch(() => conversions.delete(sourceFile))
  conversions.set(sourceFile, job)
  return job
}
