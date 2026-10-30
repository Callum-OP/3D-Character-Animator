import wasmUrl from 'tinyusdz/tinyusdz.wasm?url'
import { buildUsdRoot, readUsdHeader } from './usdBuild.js'

// Load a USD file (.usdz / .usdc / .usda / .usd) into a three.js scene.
//
// The file is read in a Web Worker (TinyUSDZ is WebAssembly and takes seconds for a big scene), and the worker
// is TERMINATED afterwards: a WebAssembly heap never shrinks, so keeping the reader alive would hold hundreds of
// MB for the rest of the session. Where Workers are unavailable the same code runs in-process.

export const USD_EXTENSIONS = ['usdz', 'usd', 'usda', 'usdc']

function readInWorker(bytes, name) {
  return import('./usdWorker.js?worker&inline').then(
    ({ default: UsdWorker }) =>
      new Promise((resolve, reject) => {
        const worker = new UsdWorker()
        const done = (fn) => (arg) => {
          worker.terminate() // frees the reader's memory
          fn(arg)
        }
        worker.onmessage = (e) => (e.data.ok ? done(resolve)(e.data.data) : done(reject)(new Error(e.data.error)))
        worker.onerror = (e) => done(reject)(new Error(e.message || 'the USD reader crashed'))
        // The page's own copy of the bytes is handed over, not duplicated.
        const url = new URL(wasmUrl, document.baseURI).href
        worker.postMessage({ bytes, name, wasmUrl: url }, [bytes.buffer])
      }),
  )
}

async function readInProcess(bytes, name) {
  const { extractUsd } = await import('./usdCore.js')
  const wasmBinary = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer())
  return extractUsd(bytes, name, wasmBinary)
}

/**
 * @param {Uint8Array} bytes  the file (its buffer is handed to the worker, so do not use it afterwards)
 * @param {string} name       the file name
 * @returns {Promise<THREE.Group>}
 */
export async function loadUsdRoot(bytes, name) {
  const units = readUsdHeader(bytes) // before the bytes are handed to the worker
  const data = typeof Worker !== 'undefined' ? await readInWorker(bytes, name) : await readInProcess(bytes, name)
  return buildUsdRoot(data, { name: String(name).replace(/\.[^.]+$/, ''), units })
}
