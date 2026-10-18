'use strict'
// Opening .blend files by running Blender itself, headless, to convert them to glTF.
//
// Why Blender and not a parser: a .blend file is a raw dump of Blender's internals —
// modifiers, shader node trees, rigs, drivers — so only Blender can turn one into
// what you actually see. We never bundle or link Blender: the user's own install is
// started as a separate program (see electron/BLENDER.md for the licensing notes).
//
//   renderer ──IPC──► registerBlenderIpc ──► convertBlend ──► blender -b … --python <script>
//                                                  ▲ temp copy of the files        │
//                                                  └──────────── .glb ◄────────────┘
//
// Everything here is plain Node (no Electron imports) except registerBlenderIpc, so
// the converter can be tested directly against a real or fake Blender executable.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

// glTF export has shipped with Blender since 2.80.
const MIN_VERSION = { major: 2, minor: 80 }
const MAX_INPUT_BYTES = 1.5 * 1024 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const LOG_LIMIT = 1024 * 1024

// ---------------------------------------------------------------------------
// The script Blender runs. Kept as a string (and written to the temp folder at
// conversion time) because Blender is an external process and cannot read files out
// of an Electron .asar archive.
// ---------------------------------------------------------------------------
const EXPORT_SCRIPT = String.raw`
import os
import re
import sys
import traceback

import bpy


def log(*parts):
    print('[animare]', *parts, flush=True)


IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.tga', '.bmp', '.tif', '.tiff', '.webp', '.gif', '.exr', '.hdr', '.dds'}


def norm_name(name):
    # "Houses+Colorscheme.png", "houses_colorscheme.PNG" and "Houses Colorscheme.png" are one file
    return re.sub(r'[\s_+\-]+', ' ', name.lower()).strip()


def trailing_overlap(a, b):
    a = a.replace('\\', '/').lower().split('/')[::-1]
    b = b.replace('\\', '/').lower().split('/')[::-1]
    n = 0
    while n < len(a) and n < len(b) and a[n] == b[n]:
        n += 1
    return n


def relink_textures(root):
    # A .blend remembers where its textures were on the ARTIST'S machine ("//../../Unity/
    # Assets/Textures/wall.png", "C:\\Users\\me\\wall.png"), which never exists here. Find each
    # missing image by NAME anywhere in the folder we were given and point Blender at it.
    # The exporter silently drops a texture it can't find, so say so if one is truly absent.
    by_name, by_norm, by_stem = {}, {}, {}
    for dirpath, _dirs, names in os.walk(root):
        for n in names:
            full = os.path.join(dirpath, n)
            stem, ext = os.path.splitext(n)
            by_name.setdefault(n.lower(), []).append(full)
            by_norm.setdefault(norm_name(n), []).append(full)
            if ext.lower() in IMAGE_EXTS:
                by_stem.setdefault(norm_name(stem), []).append(full)

    def best(options, wanted):
        return sorted(options, key=lambda p: (-trailing_overlap(p, wanted), len(p)))[0] if options else None

    for img in bpy.data.images:
        if img.source != 'FILE' or not img.users or img.packed_file:
            continue
        raw = img.filepath_raw or img.filepath
        if not raw:
            continue
        if os.path.exists(bpy.path.abspath(raw)):
            continue
        # Newer Blenders can hand back a path with nothing after the last slash for a missing
        # file, so fall back to the image's own name rather than reporting an empty one.
        base = os.path.basename(raw.replace('\\', '/').rstrip('/')) or os.path.basename(img.filepath.replace('\\', '/').rstrip('/')) or img.name
        stem = os.path.splitext(base)[0]
        found = best(by_name.get(base.lower()), raw) or best(by_norm.get(norm_name(base)), raw) or best(by_stem.get(norm_name(stem)), raw)
        if found:
            img.filepath = found
            img.reload()
            log('relinked texture:', base, '->', os.path.relpath(found, root))
        else:
            log('warning: texture not found:', base)


# What colour a shader node contributes, for turning it into a Principled BSDF.
COLOR_SHADERS = {'BSDF_DIFFUSE', 'BSDF_TRANSLUCENT', 'BSDF_TOON', 'BSDF_VELVET', 'BSDF_SHEEN', 'SUBSURFACE_SCATTERING', 'BSDF_GLASS', 'BSDF_REFRACTION'}
METAL_SHADERS = {'BSDF_GLOSSY', 'BSDF_ANISOTROPIC', 'BSDF_REFLECTION'}
NOTHING_SHADERS = {'BSDF_TRANSPARENT', 'HOLDOUT'}


def shader_color(node, depth=0):
    # -> {'socket': linked output socket or None, 'value': colour tuple, 'kind': 'diffuse'|'metal'|'emission'} or None
    if node is None or depth > 6:
        return None
    t = node.type
    if t in COLOR_SHADERS or t in METAL_SHADERS or t == 'EMISSION':
        inp = node.inputs.get('Color')
        if inp is None:
            return None
        kind = 'metal' if t in METAL_SHADERS else ('emission' if t == 'EMISSION' else 'diffuse')
        if inp.links:
            return {'socket': inp.links[0].from_socket, 'value': None, 'kind': kind}
        return {'socket': None, 'value': tuple(inp.default_value), 'kind': kind}
    if t in ('MIX_SHADER', 'ADD_SHADER'):
        first = 1 if t == 'MIX_SHADER' else 0
        found = []
        for sock in list(node.inputs)[first:first + 2]:
            if sock.links and sock.links[0].from_node.type not in NOTHING_SHADERS:
                got = shader_color(sock.links[0].from_node, depth + 1)
                if got:
                    found.append(got)
        # prefer the plain surface colour over a glossy/emissive layer on top of it
        found.sort(key=lambda g: {'diffuse': 0, 'metal': 1, 'emission': 2}[g['kind']])
        return found[0] if found else None
    return None


def convert_shaders():
    # Blender's glTF exporter only understands the Principled BSDF. Older files — and a lot
    # of Cycles scenes — build materials from Diffuse / Glossy / Emission / Mix nodes, which
    # it exports as plain default white (colour AND texture lost). So give each such
    # material an equivalent Principled BSDF, fed by the same colour or texture.
    converted = 0
    for mat in bpy.data.materials:
        if not mat.use_nodes or not mat.node_tree:
            continue
        nt = mat.node_tree
        outputs = [n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL']
        if not outputs:
            continue
        out = next((n for n in outputs if getattr(n, 'is_active_output', False)), outputs[0])
        surface = out.inputs.get('Surface')
        if surface is None or not surface.links or surface.links[0].from_node.type == 'BSDF_PRINCIPLED':
            continue
        info = shader_color(surface.links[0].from_node)
        if not info:
            continue
        p = nt.nodes.new('ShaderNodeBsdfPrincipled')
        p.location = (out.location.x - 320, out.location.y)
        if info['socket'] is not None:
            nt.links.new(info['socket'], p.inputs['Base Color'])
        else:
            p.inputs['Base Color'].default_value = info['value']
        if info['kind'] == 'metal':
            p.inputs['Metallic'].default_value = 1.0
            p.inputs['Roughness'].default_value = 0.35
        else:
            p.inputs['Roughness'].default_value = 1.0  # matte, like a Diffuse BSDF
            for spec in ('Specular IOR Level', 'Specular'):
                if spec in p.inputs:
                    p.inputs[spec].default_value = 0.0
        if info['kind'] == 'emission':
            for name in ('Emission Color', 'Emission'):
                if name in p.inputs:
                    if info['socket'] is not None:
                        nt.links.new(info['socket'], p.inputs[name])
                    else:
                        p.inputs[name].default_value = info['value']
                    break
            if 'Emission Strength' in p.inputs:
                p.inputs['Emission Strength'].default_value = 1.0
        nt.links.new(p.outputs['BSDF'], surface)
        converted += 1
    if converted:
        log('converted', converted, 'materials to Principled BSDF so their colours and textures export')


def export(out_path, search_root):
    # The glTF exporter ships with Blender and is on by default; make sure.
    if not hasattr(bpy.ops.export_scene, 'gltf'):
        import addon_utils
        addon_utils.enable('io_scene_gltf2', default_set=False, persistent=False)

    relink_textures(search_root)
    convert_shaders()

    exportable = {'MESH', 'ARMATURE'}
    if not any(o.type in exportable for o in bpy.data.objects):
        raise RuntimeError('This file has no meshes or armatures to export.')

    # Export what you can SEE: hidden helper objects are usually not part of the model.
    # If everything is hidden, fall back to exporting everything rather than nothing.
    visible = [o for o in bpy.context.view_layer.objects if o.type in exportable and o.visible_get()]
    use_visible = bool(visible)
    if not use_visible:
        log('no visible objects - exporting everything')

    # Applying modifiers (subdivision, mirror, array...) matches what the model looks like,
    # but the exporter can't keep shape keys (face morphs) while doing it, so a model with
    # shape keys is exported with its modifiers left unapplied instead.
    has_shape_keys = any(getattr(o.data, 'shape_keys', None) for o in bpy.data.objects if o.type == 'MESH')

    op = bpy.ops.export_scene.gltf
    supported = set(op.get_rna_type().properties.keys())
    wanted = {
        'filepath': out_path,
        'export_format': 'GLB',
        'use_selection': False,
        'use_visible': use_visible,
        'export_apply': not has_shape_keys,
        'export_animations': True,
        'export_skins': True,
        'export_morph': True,
        'export_materials': 'EXPORT',
        'export_image_format': 'AUTO',
        'export_cameras': False,
        'export_lights': False,
        'export_yup': True,
        'export_draco_mesh_compression_enable': False,
    }
    # Option names differ a little between Blender versions: pass only what this one knows.
    kwargs = {k: v for k, v in wanted.items() if k in supported}
    skipped = [k for k in wanted if k not in supported]
    if skipped:
        log('options this Blender does not have:', ', '.join(skipped))
    result = op(**kwargs)
    if 'FINISHED' not in result:
        raise RuntimeError('glTF export did not finish: ' + str(result))
    log('exported', out_path)


def main():
    argv = sys.argv
    extra = argv[argv.index('--') + 1:] if '--' in argv else []
    if not extra:
        raise RuntimeError('no output path given')
    out_path = extra[0]
    # Where to look for textures: the whole folder we were given (default: beside the file).
    search_root = extra[1] if len(extra) > 1 else os.path.dirname(bpy.data.filepath)
    export(out_path, search_root)


try:
    main()
except Exception:
    traceback.print_exc()
    sys.stdout.flush()
    sys.exit(3)
`

// ---------------------------------------------------------------------------
// Finding Blender
// ---------------------------------------------------------------------------

function parseVersion(text) {
  const m = /Blender\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(String(text || ''))
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: m[3] ? +m[3] : 0, text: `${m[1]}.${m[2]}${m[3] ? '.' + m[3] : ''}` }
}

function isVersionSupported(v) {
  if (!v) return false
  return v.major > MIN_VERSION.major || (v.major === MIN_VERSION.major && v.minor >= MIN_VERSION.minor)
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

// "Blender 4.2" > "Blender 3.6" > "Blender 2.93": compare the numbers, not the strings.
function versionKey(name) {
  const m = /(\d+)\.(\d+)/.exec(name)
  return m ? +m[1] * 1000 + +m[2] : 0
}

// Every place a Blender executable is commonly found, most specific first.
function candidatePaths({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const out = []
  const add = (p, source) => p && out.push({ path: p, source })

  add(env.BLENDER_PATH, 'BLENDER_PATH')

  const exeNames = platform === 'win32' ? ['blender.exe'] : ['blender']
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const exe of exeNames) add(path.join(dir, exe), 'PATH')
  }

  if (platform === 'win32') {
    // Only fall back to the default location when the environment says nothing, so a
    // caller-supplied env (tests, odd setups) is never second-guessed by the real machine.
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)
    if (!roots.length) roots.push('C:\\Program Files')
    for (const root of [...new Set(roots)]) {
      const base = path.join(root, 'Blender Foundation')
      const dirs = listDirs(base).filter((d) => /^Blender/i.test(d)).sort((a, b) => versionKey(b) - versionKey(a))
      for (const d of dirs) add(path.join(base, d, 'blender.exe'), 'Program Files')
      add(path.join(root, 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe'), 'Steam')
    }
  } else if (platform === 'darwin') {
    add('/Applications/Blender.app/Contents/MacOS/Blender', 'Applications')
    add(path.join(home, 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender'), 'Applications')
  } else {
    for (const p of ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender']) add(p, 'system')
    for (const d of listDirs('/opt').filter((d) => /^blender/i.test(d)).sort((a, b) => versionKey(b) - versionKey(a))) {
      add(path.join('/opt', d, 'blender'), 'system')
    }
  }
  return out
}

// A path the user chose wins; then the usual places.
function findBlender({ configuredPath, ...opts } = {}) {
  if (configuredPath && isFile(configuredPath)) return { path: configuredPath, source: 'chosen' }
  for (const c of candidatePaths(opts)) if (isFile(c.path)) return c
  return null
}

// ---------------------------------------------------------------------------
// Running Blender
// ---------------------------------------------------------------------------

// Run a process to completion, keeping (a bounded amount of) its output.
function run(command, args, { timeoutMs, cwd } = {}) {
  return new Promise((resolve) => {
    let log = ''
    let timedOut = false
    let child
    try {
      // No shell: arguments are passed as an array, so file names can't be interpreted as commands.
      child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: null, log: '', spawnError: err })
      return
    }
    const collect = (chunk) => {
      log += chunk.toString()
      if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeoutMs)
      : null
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolve({ code: null, log, spawnError: err })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, log, timedOut })
    })
  })
}

async function getVersion(blenderPath, runner = run) {
  const r = await runner(blenderPath, ['--version'], { timeoutMs: 30000 })
  if (r.spawnError || r.code !== 0) return null
  return parseVersion(r.log)
}

// What the renderer shows in Settings.
async function getStatus({ configuredPath, runner = run, ...opts } = {}) {
  const found = findBlender({ configuredPath, ...opts })
  if (!found) return { available: false, path: null, source: null, version: null }
  const version = await getVersion(found.path, runner)
  return {
    available: !!version && isVersionSupported(version),
    path: found.path,
    source: found.source,
    version: version ? version.text : null,
    tooOld: !!version && !isVersionSupported(version),
  }
}

// Files come from the renderer, so treat every path as untrusted: relative, inside
// the temp folder, nothing sneaky.
function safeRelativePath(p) {
  const s = String(p || '').replace(/\\/g, '/')
  if (!s || s.includes('\0') || s.startsWith('/') || /^[a-z]:/i.test(s)) throw new Error(`Invalid file path: ${JSON.stringify(p)}`)
  const parts = s.split('/').filter((seg) => seg && seg !== '.')
  if (!parts.length || parts.some((seg) => seg === '..')) throw new Error(`Invalid file path: ${JSON.stringify(p)}`)
  return parts.join('/')
}

function relevantLines(log) {
  const lines = String(log || '').split(/\r?\n/)
  const warnings = []
  for (const line of lines) {
    // Old files trigger a burst of harmless colour-management notices when opened in a newer
    // Blender ("view transform 'Filmic Log' not found, setting to 'Filmic'") — not worth showing.
    if (/color_management|colour_management/i.test(line)) continue
    if (/\bwarning\b/i.test(line) || /^\s*\[animare\] (options|no visible)/i.test(line)) {
      const clean = line.trim().replace(/^\[animare\]\s*(warning:\s*)?/i, '')
      if (clean && !warnings.includes(clean)) warnings.push(clean)
    }
  }
  return warnings.slice(0, 12)
}

// The reason a conversion failed, as short as possible: the Python error message
// ("RuntimeError: This file has no meshes…") if there is one, else the last log lines.
function errorTail(log) {
  const lines = String(log || '').split(/\r?\n/).filter((l) => l.trim())
  const reasons = []
  for (const l of lines) {
    const m = /^\s*(?:[A-Za-z_.]*(?:Error|Exception)):\s*(.+)$/.exec(l)
    if (m && !reasons.includes(m[1].trim())) reasons.push(m[1].trim())
  }
  if (reasons.length) return reasons.slice(-2).join('\n')
  return lines.slice(-6).join('\n')
}

// files: [{ path, data }] (data: Buffer / Uint8Array / ArrayBuffer), main: the .blend's path in `files`.
// → { glb: Buffer, warnings: string[], log: string }; throws an Error with a user-readable message.
async function convertBlend({ blenderPath, files, main, timeoutMs = DEFAULT_TIMEOUT_MS, tmpRoot = os.tmpdir(), runner = run }) {
  if (!blenderPath || !isFile(blenderPath)) throw new Error('Blender was not found. Choose its executable in Settings.')
  if (!Array.isArray(files) || !files.length) throw new Error('No files to convert.')

  const entries = files.map((f) => ({ rel: safeRelativePath(f.path), data: Buffer.from(f.data.buffer ? new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength) : f.data) }))
  const mainRel = safeRelativePath(main)
  if (!entries.some((e) => e.rel === mainRel)) throw new Error('The .blend file is missing from the files sent.')
  if (!/\.blend$/i.test(mainRel)) throw new Error('Only .blend files can be converted.')
  const total = entries.reduce((n, e) => n + e.data.length, 0)
  if (total > MAX_INPUT_BYTES) throw new Error('These files are too large to convert.')

  const root = await fsp.mkdtemp(path.join(tmpRoot, 'animare-blend-'))
  try {
    const work = path.join(root, 'work') // the model + its textures, laid out as they were
    const tools = path.join(root, 'tools') // our script and the output
    await fsp.mkdir(tools, { recursive: true })
    for (const e of entries) {
      const dest = path.join(work, e.rel)
      if (!path.resolve(dest).startsWith(path.resolve(work) + path.sep)) throw new Error(`Invalid file path: ${e.rel}`)
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      await fsp.writeFile(dest, e.data)
    }
    const scriptPath = path.join(tools, 'export.py')
    const outPath = path.join(tools, 'out.glb')
    await fsp.writeFile(scriptPath, EXPORT_SCRIPT)

    const args = [
      '--background',
      '--factory-startup', // ignore the user's add-ons / startup files
      '--disable-autoexec', // NEVER run scripts embedded in the file: it may come from anywhere
      '-noaudio',
      '--python-exit-code', '3', // a failing script fails the process
      path.join(work, mainRel),
      '--python', scriptPath,
      '--', outPath, work,
    ]
    const r = await runner(blenderPath, args, { timeoutMs, cwd: work })

    if (r.spawnError) throw new Error(`Blender could not be started: ${r.spawnError.message}`)
    if (r.timedOut) throw new Error(`Blender took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`)
    let glb = null
    try {
      glb = await fsp.readFile(outPath)
    } catch {
      glb = null
    }
    if (r.code !== 0 || !glb || glb.length < 20) {
      throw new Error(`Blender could not convert this file.\n${errorTail(r.log)}`.trim())
    }
    if (glb.toString('latin1', 0, 4) !== 'glTF') throw new Error('Blender produced an invalid file.')
    return { glb, warnings: relevantLines(r.log), log: r.log }
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Electron wiring (the only part that needs Electron)
// ---------------------------------------------------------------------------

function registerBlenderIpc({ ipcMain, dialog, app, deps = {} }) {
  const status = deps.getStatus || getStatus
  const version = deps.getVersion || getVersion
  const convert = deps.convertBlend || convertBlend
  const configFile = () => path.join(app.getPath('userData'), 'blender.json')
  const readConfig = () => {
    try {
      return JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {}
    } catch {
      return {}
    }
  }
  const writeConfig = (cfg) => fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2))

  ipcMain.handle('animare:blender-status', () => status({ configuredPath: readConfig().path }))

  ipcMain.handle('animare:blender-choose', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose the Blender executable',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Blender', extensions: ['exe'] }] : [],
    })
    if (res.canceled || !res.filePaths[0]) return status({ configuredPath: readConfig().path })
    const chosen = res.filePaths[0]
    const detected = await version(chosen)
    if (!detected) return { ...(await status({ configuredPath: readConfig().path })), error: 'That does not look like Blender.' }
    writeConfig({ ...readConfig(), path: chosen })
    return status({ configuredPath: chosen })
  })

  ipcMain.handle('animare:blender-clear', () => {
    writeConfig({ ...readConfig(), path: null })
    return status({})
  })

  ipcMain.handle('animare:blender-convert', async (_e, payload = {}) => {
    try {
      const st = await status({ configuredPath: readConfig().path })
      if (!st.path) {
        return { ok: false, code: 'not-found', error: 'Blender was not found. Install it from blender.org, or choose its location in Settings.' }
      }
      if (!st.available) {
        return { ok: false, code: 'too-old', error: `Blender ${st.version || ''} is too old: version 2.80 or newer is needed.`.replace('  ', ' ') }
      }
      const { glb, warnings } = await convert({ blenderPath: st.path, files: payload.files, main: payload.main })
      return { ok: true, glb, warnings, blenderVersion: st.version }
    } catch (err) {
      return { ok: false, code: 'failed', error: err && err.message ? err.message : String(err) }
    }
  })
}

module.exports = {
  EXPORT_SCRIPT,
  MIN_VERSION,
  parseVersion,
  isVersionSupported,
  candidatePaths,
  findBlender,
  getVersion,
  getStatus,
  safeRelativePath,
  convertBlend,
  registerBlenderIpc,
}
