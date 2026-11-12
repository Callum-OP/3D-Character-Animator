'use strict'
// Pose Finder engine (main process). Runs Meta's SAM 3D Body (an ONNX conversion, ViT-H body decoder) with
// onnxruntime-node — CPU everywhere, DirectML on Windows (incl. ARM64) when available. No Python, no CUDA.
//
//   status   -> what's installed / loaded
//   download -> fetch the ~1.4 GB model once into userData (SHA-256 checked, resumable by restarting)
//   load     -> create the ONNX Runtime session
//   infer    -> one person crop in, MHR pose out
//
// The model is NOT bundled: it is downloaded on request, after the person accepts Meta's SAM License.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const https = require('node:https')
const http = require('node:http')
const crypto = require('node:crypto')

const MODEL = {
  file: 'sam-3d-body-vith-body.onnx',
  url: 'https://huggingface.co/gok11/sam-3d-body-onnx/resolve/main/sam-3d-body-vith-body.onnx',
  bytes: 1424013951,
  sha256: 'c13492cf96932c6fab67bdab3ce9a983f81743e270ba1adae128d7ff4dff4378',
  licenseUrl: 'https://huggingface.co/gok11/sam-3d-body-onnx/blob/main/LICENSE',
}
const CROP = 512
const OUTPUTS = ['keypoints_2d', 'keypoints_3d', 'cam_t', 'joint_coords', 'joint_rotations']

// ---- download ----------------------------------------------------------------------------------------------

// Streams `url` to `dest` (via dest + '.part'), following redirects, hashing as it goes. Rejects on a size or
// SHA-256 mismatch and deletes the partial file. `signal` (AbortSignal) cancels.
function downloadFile(url, dest, { onProgress, signal, sha256, bytes, maxRedirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const part = dest + '.part'
    let settled = false
    let req = null
    const fail = (err) => {
      if (settled) return
      settled = true
      try { req && req.destroy() } catch (_) { /* ignore */ }
      fsp.rm(part, { force: true }).finally(() => reject(err))
    }
    if (signal) {
      if (signal.aborted) return fail(new Error('Cancelled'))
      signal.addEventListener('abort', () => fail(new Error('Cancelled')), { once: true })
    }
    const get = (u, left) => {
      const lib = u.startsWith('https:') ? https : http
      req = lib.get(u, { headers: { 'User-Agent': '3d-character-animator' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (left <= 0) return fail(new Error('Too many redirects'))
          return get(new URL(res.headers.location, u).toString(), left - 1)
        }
        if (res.statusCode !== 200) { res.resume(); return fail(new Error(`Download failed (HTTP ${res.statusCode})`)) }
        const total = Number(res.headers['content-length']) || bytes || 0
        const hash = crypto.createHash('sha256')
        const out = fs.createWriteStream(part)
        let got = 0, last = 0
        res.on('data', (chunk) => {
          got += chunk.length
          hash.update(chunk)
          const now = Date.now()
          if (onProgress && now - last > 250) { last = now; onProgress({ received: got, total }) }
        })
        res.on('error', fail)
        out.on('error', fail)
        out.on('finish', async () => {
          if (settled) return
          try {
            if (bytes && got !== bytes) throw new Error(`Downloaded ${got} bytes, expected ${bytes}`)
            if (sha256 && hash.digest('hex') !== sha256) throw new Error('Checksum mismatch — the download is corrupt or has changed')
            await fsp.rename(part, dest)
            settled = true
            onProgress && onProgress({ received: got, total: got })
            resolve({ bytes: got })
          } catch (e) { fail(e) }
        })
        res.pipe(out)
      })
      req.on('error', fail)
    }
    fsp.mkdir(path.dirname(dest), { recursive: true }).then(() => get(url, maxRedirects), fail)
  })
}

// ---- tensors -----------------------------------------------------------------------------------------------

// RGBA bytes (512x512, already warped to the person crop) -> float32 CHW RGB in 0..1.
function rgbaToChw(rgba, size = CROP) {
  const n = size * size
  if (!rgba || rgba.length !== n * 4) throw new Error(`Expected a ${size}x${size} RGBA crop`)
  const out = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    out[i] = rgba[i * 4] / 255
    out[n + i] = rgba[i * 4 + 1] / 255
    out[2 * n + i] = rgba[i * 4 + 2] / 255
  }
  return out
}

// ---- engine ------------------------------------------------------------------------------------------------

function createPoseEngine({ modelDir, ort: ortInjected, platform = process.platform, arch = process.arch }) {
  let ort = ortInjected || null
  let ortError = null
  let session = null
  let provider = null
  let busy = Promise.resolve()
  const modelPath = path.join(modelDir, MODEL.file)

  function getOrt() {
    if (ort) return ort
    try { ort = require('onnxruntime-node') } catch (e) { ortError = e.message || String(e) }
    return ort
  }

  async function modelBytes() {
    try { return (await fsp.stat(modelPath)).size } catch (_) { return 0 }
  }

  async function status() {
    const o = getOrt()
    const have = await modelBytes()
    return {
      ortOk: !!o,
      ortError,
      modelReady: have === MODEL.bytes,
      modelBytes: have,
      expectedBytes: MODEL.bytes,
      modelPath,
      licenseUrl: MODEL.licenseUrl,
      loaded: !!session,
      provider,
      platform,
      arch,
    }
  }

  function providerLists(pref) {
    const dml = platform === 'win32'
    if (pref === 'cpu') return [['cpu']]
    if (pref === 'dml') return [['dml', 'cpu']]
    // 'auto': DirectML was only verified on an NVIDIA card. Qualcomm/Adreno (win32 arm64) drivers can return
    // garbage for a graph this size, so ARM defaults to the CPU and DirectML stays an explicit choice.
    return dml && arch !== 'arm64' ? [['dml', 'cpu'], ['cpu']] : [['cpu']]
  }

  async function load(pref = 'auto') {
    const o = getOrt()
    if (!o) throw new Error(`onnxruntime-node is not available: ${ortError || 'not installed'}`)
    if ((await modelBytes()) !== MODEL.bytes) throw new Error('The pose model has not been downloaded yet')
    await unload()
    let lastErr = null
    for (const eps of providerLists(pref)) {
      try {
        const t0 = Date.now()
        const opts = { executionProviders: eps, graphOptimizationLevel: 'all' }
        if (eps[0] === 'dml') { opts.executionMode = 'sequential'; opts.enableMemPattern = false } // DirectML requirements
        session = await o.InferenceSession.create(modelPath, opts)
        provider = eps[0]
        return { provider, loadMs: Date.now() - t0 }
      } catch (e) {
        lastErr = e
        session = null
      }
    }
    throw new Error(`Could not start the pose model: ${lastErr && lastErr.message}`)
  }

  async function unload() {
    const s = session
    session = null
    provider = null
    if (s && typeof s.release === 'function') { try { await s.release() } catch (_) { /* ignore */ } }
  }

  // payload: { rgba: Uint8Array(512*512*4), center:[cx,cy], scale:[s,s], affine:[a,b,c,d,e,f], imageSize:[w,h], camera:[9] }
  function infer(payload) {
    const run = async () => {
      if (!session) throw new Error('The pose model is not loaded')
      const t = (data, dims) => new ort.Tensor('float32', data, dims)
      const f32 = (a) => Float32Array.from(a)
      const feeds = {
        image: t(rgbaToChw(payload.rgba), [1, 3, CROP, CROP]),
        bbox_center: t(f32(payload.center), [1, 2]),
        bbox_scale: t(f32(payload.scale), [1, 2]),
        affine: t(f32(payload.affine), [1, 2, 3]),
        image_size: t(f32(payload.imageSize), [1, 2]),
        camera: t(f32(payload.camera), [3, 3]),
      }
      const t0 = Date.now()
      const res = await session.run(feeds)
      const out = { ms: Date.now() - t0 }
      for (const k of OUTPUTS) {
        if (!res[k]) throw new Error(`The model did not return ${k}`)
        out[k] = Float32Array.from(res[k].data)
      }
      if (res.focal_length) out.focal_length = Number(res.focal_length.data[0])
      return out
    }
    // one inference at a time (the session is not re-entrant on DirectML)
    const p = busy.then(run, run)
    busy = p.catch(() => {})
    return p
  }

  return { status, load, unload, infer, downloadModel: (opts) => downloadFile(MODEL.url, modelPath, { sha256: MODEL.sha256, bytes: MODEL.bytes, ...opts }), modelPath }
}

// ---- IPC ---------------------------------------------------------------------------------------------------

function registerPoseEngineIpc({ ipcMain, app, BrowserWindow }) {
  const engine = createPoseEngine({ modelDir: path.join(app.getPath('userData'), 'pose-engine') })
  let dl = null // AbortController of the running download

  ipcMain.handle('animare:pose-status', () => engine.status())

  ipcMain.handle('animare:pose-download', async (event) => {
    if (dl) return { ok: false, error: 'A download is already running' }
    dl = new AbortController()
    try {
      await engine.downloadModel({
        signal: dl.signal,
        onProgress: (p) => { try { event.sender.send('animare:pose-download-progress', p) } catch (_) { /* window closed */ } },
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message || String(e) }
    } finally { dl = null }
  })
  ipcMain.handle('animare:pose-download-cancel', () => { if (dl) dl.abort(); return true })

  ipcMain.handle('animare:pose-load', async (_e, pref) => {
    try { return { ok: true, ...(await engine.load(pref)) } } catch (e) { return { ok: false, error: e.message || String(e) } }
  })
  ipcMain.handle('animare:pose-unload', async () => { await engine.unload(); return true })
  ipcMain.handle('animare:pose-infer', async (_e, payload) => {
    try { return { ok: true, out: await engine.infer(payload) } } catch (e) { return { ok: false, error: e.message || String(e) } }
  })
  app.on('before-quit', () => { engine.unload() })
  return engine
}

module.exports = { MODEL, CROP, downloadFile, rgbaToChw, createPoseEngine, registerPoseEngineIpc }
