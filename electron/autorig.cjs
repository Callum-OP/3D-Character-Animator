'use strict'
// Auto Rigger backend (desktop only). Runs electron/autorig/autorig.py inside the user's own
// Blender, headless, exactly like .blend import does (see BLENDER.md): separate program, no shell,
// --disable-autoexec, throw-away temp folder, timeout. The renderer sends the mesh + landmarks and
// gets back a rigged .glb plus a numeric report.
const fs = require('fs')
const fsp = fs.promises
const os = require('os')
const path = require('path')
const { getStatus, run, errorTail, isVersionSupported } = require('./blender.cjs')

const crypto = require('crypto')

const TIMEOUT_MS = 20 * 60 * 1000
const STALE_JOB_MS = 24 * 60 * 60 * 1000
const MAX_INPUT_BYTES = 400 * 1024 * 1024
const INPUT_EXTS = ['glb', 'gltf', 'fbx', 'obj', 'ply']
const SCRIPT_FILE = path.join(__dirname, 'autorig', 'autorig.py')

function validLandmarks(lm) {
  if (!lm || typeof lm !== 'object') return false
  const keys = Object.keys(lm)
  if (!keys.length) return false
  return keys.every((k) => /^[a-z_]+$/.test(k) && Array.isArray(lm[k]) && lm[k].length === 3 && lm[k].every((n) => Number.isFinite(n)))
}

// "[autorig-progress] 0.550 Transferring weights" lines from the script → { frac, label }.
function makeProgressParser(onProgress) {
  let pending = ''
  return (text) => {
    pending += text
    const lines = pending.split(/\r?\n/)
    pending = lines.pop()
    for (const line of lines) {
      const m = /^\[autorig-progress\]\s+([0-9.]+)\s+(.*)$/.exec(line.trim())
      if (m) onProgress({ frac: Math.min(1, Math.max(0, parseFloat(m[1]))), label: m[2] })
    }
  }
}

// Windows exit codes that mean the OS (or security software) stopped the process rather than Blender failing.
const BLOCKED_EXIT_CODES = new Set([3221225781, 3221225477, 3221225794, 3221226505, 3221225786, -1073741819, -1073741515, -1073740791])

// A plain-language message when the launch looks blocked, else null.
function explainLaunchFailure(r, platform = process.platform) {
  const code = r?.spawnError?.code
  const log = r?.log || ''
  const denied = code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN' || /access is denied|operation did not complete successfully because the file contains a virus|blocked by/i.test(log)
  const killed = r && BLOCKED_EXIT_CODES.has(r.code) && !/autorig/i.test(log)
  if (!denied && !killed) return null
  if (platform === 'win32') {
    return 'Windows or your security software stopped Blender from running. Open Windows Security → Virus & threat protection → Protection history and allow the blocked item, ' +
      'add Blender and the Animare data folder to the exclusions, or turn off Controlled folder access for them. Then try again.'
  }
  return 'The system stopped Blender from running (permission denied). Check that the Blender executable is allowed to run and try again.'
}

// input: { name, data } (data: Buffer/Uint8Array/ArrayBuffer). → { glb: Buffer, report: object, log }
async function runAutoRig({ blenderPath, input, landmarks, bbox = null, baked = false, options = {}, timeoutMs = TIMEOUT_MS, tmpRoot = os.tmpdir(), workRoot = null, onProgress = null, runner = run }) {
  if (!blenderPath || !fs.existsSync(blenderPath)) throw new Error('Blender was not found. Choose its executable in Settings.')
  const ext = String(input?.name || '').split('.').pop().toLowerCase()
  if (!INPUT_EXTS.includes(ext)) throw new Error(`Auto Rigger can't read .${ext} files. Use ${INPUT_EXTS.join(', ')}.`)
  if (!validLandmarks(landmarks)) throw new Error('The landmarks are missing or invalid.')
  const raw = input.data
  const data = Buffer.from(raw.buffer ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : raw)
  if (!data.length) throw new Error('The model file is empty.')
  if (data.length > MAX_INPUT_BYTES) throw new Error('This model is too large to rig.')

  // A fixed, app-owned folder (not a fresh random path in %TEMP% every time): security software
  // judges the same script in the same place once instead of re-prompting for every run.
  const base = workRoot || tmpRoot
  await fsp.mkdir(base, { recursive: true })
  await sweepStaleJobs(base)
  const root = await fsp.mkdtemp(path.join(base, 'job-'))
  try {
    const inPath = path.join(root, `input.${ext}`)
    const outPath = path.join(root, 'rigged.glb')
    const reportPath = path.join(root, 'report.json')
    const jobPath = path.join(root, 'job.json')
    const source = await fsp.readFile(SCRIPT_FILE) // readable from inside the asar too
    const scriptPath = path.join(base, `autorig-${crypto.createHash('sha1').update(source).digest('hex').slice(0, 10)}.py`)
    if (!fs.existsSync(scriptPath)) await fsp.writeFile(scriptPath, source)
    await fsp.writeFile(inPath, data)
    await fsp.writeFile(jobPath, JSON.stringify({ input: inPath, output: outPath, report: reportPath, landmarks, bbox, baked: !!baked, options }))

    const args = ['--background', '--factory-startup', '--disable-autoexec', '-noaudio', '--python-exit-code', '3', '--python', scriptPath, '--', jobPath]
    const onData = onProgress ? makeProgressParser(onProgress) : undefined
    const r = await runner(blenderPath, args, { timeoutMs, cwd: root, onData })
    const blocked = explainLaunchFailure(r)
    if (blocked) throw Object.assign(new Error(blocked), { code: 'blocked' })
    if (r.spawnError) throw new Error(`Blender could not be started: ${r.spawnError.message}`)
    if (r.timedOut) throw new Error(`Rigging took longer than ${Math.round(timeoutMs / 60000)} minutes and was stopped.`)

    const marker = /AUTORIG_ERROR:([a-z]+):(.+)/.exec(r.log || '')
    if (marker) throw Object.assign(new Error(marker[2].trim()), { code: marker[1] })
    let glb = null
    try {
      glb = await fsp.readFile(outPath)
    } catch {
      glb = null
    }
    if (r.code !== 0 || !glb || glb.toString('latin1', 0, 4) !== 'glTF') {
      throw new Error(`Rigging failed.\n${errorTail(r.log)}`.trim())
    }
    let report = {}
    try {
      report = JSON.parse(await fsp.readFile(reportPath, 'utf8'))
    } catch {
      report = {}
    }
    return { glb, report, log: r.log }
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

// Job folders from crashed/killed runs would otherwise pile up.
async function sweepStaleJobs(base) {
  try {
    for (const name of await fsp.readdir(base)) {
      if (!name.startsWith('job-')) continue
      const full = path.join(base, name)
      const st = await fsp.stat(full)
      if (Date.now() - st.mtimeMs > STALE_JOB_MS) await fsp.rm(full, { recursive: true, force: true })
    }
  } catch {
    /* best effort */
  }
}

function registerAutoRigIpc({ ipcMain, app, deps = {} }) {
  const status = deps.getStatus || getStatus
  const rig = deps.runAutoRig || runAutoRig
  const configFile = () => path.join(app.getPath('userData'), 'blender.json')
  const configuredPath = () => {
    try {
      return JSON.parse(fs.readFileSync(configFile(), 'utf8'))?.path || undefined
    } catch {
      return undefined
    }
  }
  const workRoot = () => path.join(app.getPath('userData'), 'autorig-work')
  ipcMain.handle('animare:autorig-run', async (event, payload = {}) => {
    try {
      const st = await status({ configuredPath: configuredPath() })
      if (!st.path) return { ok: false, code: 'not-found', error: 'Blender was not found. Install it from blender.org, or choose its location in Settings.' }
      if (!st.available) return { ok: false, code: 'too-old', error: `Blender ${st.version || ''} is too old: version 2.80 or newer is needed.`.replace('  ', ' ') }
      const onProgress = (p) => {
        try {
          event.sender.send('animare:autorig-progress', p)
        } catch {
          /* window closed */
        }
      }
      const { glb, report } = await rig({ blenderPath: st.path, input: payload.input, landmarks: payload.landmarks, bbox: payload.bbox, baked: payload.baked, options: payload.options, workRoot: workRoot(), onProgress })
      return { ok: true, glb, report, blenderVersion: st.version }
    } catch (err) {
      return { ok: false, code: err?.code || 'failed', error: err?.message || String(err) }
    }
  })
}

module.exports = { runAutoRig, registerAutoRigIpc, validLandmarks, INPUT_EXTS, makeProgressParser, explainLaunchFailure }
