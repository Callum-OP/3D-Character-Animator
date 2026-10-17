import unrarWasmUrl from 'node-unrar-js/esm/js/unrar.wasm?url'

// ---------------------------------------------------------------------------
// Reading .rar archives
//
// zips are read with fflate (modelBundle.js); RAR has no JavaScript-friendly
// format, so this uses node-unrar-js — the official UnRAR source compiled to
// WebAssembly (MIT wrapper; UnRAR's own license allows extracting, which is all
// this does). It runs entirely in the renderer, so it works in the browser build
// and the desktop app alike. The WebAssembly module (~200 KB) is only downloaded
// when someone actually opens a .rar.
// ---------------------------------------------------------------------------

// "Rar!\x1A\x07" — the start of both RAR 4 and RAR 5 archives.
export function isRarBytes(bytes) {
  return (
    !!bytes &&
    bytes.length >= 7 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x72 &&
    bytes[3] === 0x21 &&
    bytes[4] === 0x1a &&
    bytes[5] === 0x07
  )
}

let wasmPromise = null
function loadWasm() {
  if (!wasmPromise) {
    wasmPromise = fetch(unrarWasmUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`could not load the RAR reader (${res.status})`)
        return res.arrayBuffer()
      })
      .catch((err) => {
        wasmPromise = null // allow a retry
        throw err
      })
  }
  return wasmPromise
}

function rarError(err) {
  const reason = String((err && (err.reason || err.message)) || err || '')
  if (/password/i.test(reason)) return new Error('This RAR archive is password-protected, which is not supported.')
  if (/ERAR_EOPEN|volume|multi/i.test(reason)) {
    return new Error('This RAR is part of a multi-part archive. Join the parts (or re-save it as one file) and try again.')
  }
  return new Error(`could not read the RAR archive (${reason || 'unknown error'})`)
}

// Test seam: jsdom's fake browser looks like Node to the WebAssembly loader, so tests of the
// wiring (not of RAR itself) swap in a stand-in. The real reader is tested in a Node environment.
let override = null
export function __setRarExtractorForTest(fn) {
  override = fn
}

// → Map<path, Uint8Array> (files only, "/" separators). Throws a readable Error.
export async function extractRar(arrayBuffer) {
  if (override) return override(arrayBuffer)
  let extractor
  try {
    const { createExtractorFromData } = await import('node-unrar-js')
    const wasmBinary = await loadWasm()
    extractor = await createExtractorFromData({ data: arrayBuffer, wasmBinary })
  } catch (err) {
    throw rarError(err)
  }
  const files = new Map()
  try {
    const { files: extracted } = extractor.extract()
    for (const file of extracted) {
      if (file.fileHeader.flags.directory || !file.extraction) continue
      files.set(file.fileHeader.name.replace(/\\/g, '/'), file.extraction)
    }
  } catch (err) {
    throw rarError(err)
  }
  return files
}
