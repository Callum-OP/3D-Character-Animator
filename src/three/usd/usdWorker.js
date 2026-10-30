import { extractUsd, transferablesOf } from './usdCore.js'

// Web Worker entry: read a USD file off the main thread (it takes seconds for a big scene) and post the plain
// data back. The page terminates this worker afterwards, which frees the reader's memory.
self.onmessage = async (event) => {
  const { bytes, name, wasmUrl } = event.data
  try {
    const wasmBinary = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer())
    const data = await extractUsd(bytes, name, wasmBinary)
    self.postMessage({ ok: true, data }, transferablesOf(data))
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) })
  }
}
