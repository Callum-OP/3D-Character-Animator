import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { triangleGlb } from './helpers/modelFixtures.js'

const require = createRequire(import.meta.url)
const blender = require('../../electron/blender.cjs')
const { parseVersion, isVersionSupported, candidatePaths, findBlender, safeRelativePath, convertBlend, getStatus, registerBlenderIpc, EXPORT_SCRIPT } = blender

let tmp
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'animare-test-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const touch = (p, content = 'x') => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  return p
}
const bytes = (s) => new Uint8Array(Buffer.from(s))

describe('Blender versions', () => {
  it('reads the version from `blender --version` output', () => {
    expect(parseVersion('Blender 4.0.2\n\tbuild date: 2024')).toMatchObject({ major: 4, minor: 0, patch: 2, text: '4.0.2' })
    expect(parseVersion('Blender 2.93')).toMatchObject({ major: 2, minor: 93, text: '2.93' })
    expect(parseVersion('not blender')).toBeNull()
    expect(parseVersion('')).toBeNull()
  })
  it('glTF export needs 2.80 or newer', () => {
    expect(isVersionSupported({ major: 2, minor: 79 })).toBe(false)
    expect(isVersionSupported({ major: 2, minor: 80 })).toBe(true)
    expect(isVersionSupported({ major: 3, minor: 0 })).toBe(true)
    expect(isVersionSupported(null)).toBe(false)
  })
})

describe('finding Blender', () => {
  it('a path the user chose wins over everything', () => {
    const chosen = touch(path.join(tmp, 'mine', 'blender'))
    const other = touch(path.join(tmp, 'bin', 'blender'))
    const found = findBlender({ configuredPath: chosen, platform: 'linux', env: { PATH: path.dirname(other) } })
    expect(found).toEqual({ path: chosen, source: 'chosen' })
  })

  it('a chosen path that no longer exists is ignored (falls back to searching)', () => {
    const onPath = touch(path.join(tmp, 'bin', 'blender'))
    const found = findBlender({ configuredPath: path.join(tmp, 'gone'), platform: 'linux', env: { PATH: path.dirname(onPath) } })
    expect(found.source).toBe('PATH')
  })

  it('BLENDER_PATH is honoured', () => {
    const p = touch(path.join(tmp, 'x', 'blender'))
    expect(findBlender({ platform: 'linux', env: { BLENDER_PATH: p, PATH: '' } })).toEqual({ path: p, source: 'BLENDER_PATH' })
  })

  it('searches PATH', () => {
    const p = touch(path.join(tmp, 'bin', 'blender.exe'))
    expect(findBlender({ platform: 'win32', env: { PATH: [path.join(tmp, 'nothing'), path.dirname(p)].join(path.delimiter) } }).path).toBe(p)
  })

  it('Windows: finds installs under Program Files, newest version first', () => {
    for (const v of ['Blender 2.93', 'Blender 4.2', 'Blender 3.6']) touch(path.join(tmp, 'Blender Foundation', v, 'blender.exe'))
    const found = findBlender({ platform: 'win32', env: { ProgramFiles: tmp, PATH: '' } })
    expect(found.path).toBe(path.join(tmp, 'Blender Foundation', 'Blender 4.2', 'blender.exe'))
    expect(found.source).toBe('Program Files')
  })

  it('Windows: sorts versions numerically, so 4.10 beats 4.9', () => {
    for (const v of ['Blender 4.9', 'Blender 4.10']) touch(path.join(tmp, 'Blender Foundation', v, 'blender.exe'))
    expect(findBlender({ platform: 'win32', env: { ProgramFiles: tmp, PATH: '' } }).path).toContain('Blender 4.10')
  })

  it('Windows: finds the Steam copy', () => {
    const p = touch(path.join(tmp, 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe'))
    expect(findBlender({ platform: 'win32', env: { ProgramFiles: tmp, PATH: '' } }).path).toBe(p)
  })

  it('knows the usual macOS and Linux locations', () => {
    expect(candidatePaths({ platform: 'darwin', env: { PATH: '' }, home: '/Users/me' }).map((c) => c.path)).toContain('/Applications/Blender.app/Contents/MacOS/Blender')
    expect(candidatePaths({ platform: 'linux', env: { PATH: '' } }).map((c) => c.path)).toEqual(expect.arrayContaining(['/usr/bin/blender', '/snap/bin/blender']))
  })

  it('nothing found → null', () => {
    expect(findBlender({ platform: 'win32', env: { ProgramFiles: tmp, 'ProgramFiles(x86)': tmp, PATH: '' } })).toBeNull()
  })
})

describe('status for the Settings panel', () => {
  const runnerFor = (text, code = 0) => async () => ({ code, log: text })

  it('available when the version is supported', async () => {
    const p = touch(path.join(tmp, 'blender'))
    const s = await getStatus({ configuredPath: p, runner: runnerFor('Blender 4.2.1\n') })
    expect(s).toMatchObject({ available: true, version: '4.2.1', path: p, source: 'chosen' })
  })
  it('too old is reported as such', async () => {
    const p = touch(path.join(tmp, 'blender'))
    const s = await getStatus({ configuredPath: p, runner: runnerFor('Blender 2.79\n') })
    expect(s).toMatchObject({ available: false, tooOld: true, version: '2.79' })
  })
  it('an executable that is not Blender is not available', async () => {
    const p = touch(path.join(tmp, 'blender'))
    const s = await getStatus({ configuredPath: p, runner: runnerFor('hello world') })
    expect(s.available).toBe(false)
  })
  it('nothing found → not available, no path', async () => {
    const s = await getStatus({ platform: 'win32', env: { ProgramFiles: tmp, 'ProgramFiles(x86)': tmp, PATH: '' }, runner: runnerFor('') })
    expect(s).toEqual({ available: false, path: null, source: null, version: null })
  })
})

describe('safeRelativePath: file names come from the renderer, so they are untrusted', () => {
  it.each([
    ['model.blend', 'model.blend'],
    ['textures/a.png', 'textures/a.png'],
    ['textures\\a.png', 'textures/a.png'],
    ['./a/./b.png', 'a/b.png'],
  ])('accepts %s', (input, expected) => expect(safeRelativePath(input)).toBe(expected))

  it.each(['', '/etc/passwd', '\\windows\\system32', 'C:\\x\\a.png', '../escape.png', 'a/../../b.png', 'a\0b', '..', null, undefined])(
    'rejects %j',
    (input) => expect(() => safeRelativePath(input)).toThrow(/Invalid file path/),
  )
})

// ---------------------------------------------------------------------------
describe('convertBlend (with a fake Blender)', () => {
  const fakeBlender = () => touch(path.join(tmp, 'fake', 'blender'))
  const outFrom = (args) => args[args.indexOf('--') + 1]
  const okRunner = (spy = () => {}) => async (cmd, args, opts) => {
    spy(cmd, args, opts)
    fs.writeFileSync(outFrom(args), triangleGlb())
    return { code: 0, log: '' }
  }
  const files = () => [
    { path: 'scene.blend', data: bytes('BLENDER-v400') },
    { path: 'textures/wood.png', data: bytes('PNGDATA') },
  ]
  const tmpRoot = () => path.join(tmp, 'work-root')
  const ready = () => fs.mkdirSync(tmpRoot(), { recursive: true })

  it('runs Blender in the background with the safety switches, and returns the glb', async () => {
    ready()
    let call
    const r = await convertBlend({ blenderPath: fakeBlender(), files: files(), main: 'scene.blend', tmpRoot: tmpRoot(), runner: okRunner((c, a, o) => (call = { c, a, o })) })
    expect(r.glb.toString('latin1', 0, 4)).toBe('glTF')
    expect(call.c).toBe(fakeBlender())
    for (const flag of ['--background', '--factory-startup', '--disable-autoexec', '-noaudio']) expect(call.a).toContain(flag)
    expect(call.a[call.a.indexOf('--python-exit-code') + 1]).toBe('3')
    expect(call.a.indexOf('--')).toBeGreaterThan(call.a.indexOf('--python'))
  })

  it('NEVER enables auto-run of scripts in the file (a .blend can come from anyone)', async () => {
    ready()
    let args
    await convertBlend({ blenderPath: fakeBlender(), files: files(), main: 'scene.blend', tmpRoot: tmpRoot(), runner: okRunner((c, a) => (args = a)) })
    expect(args).toContain('--disable-autoexec')
    expect(args).not.toContain('--enable-autoexec')
  })

  it('passes arguments as an array (no shell), so a hostile file name cannot become a command', async () => {
    ready()
    let args
    const nasty = 'a; rm -rf ~ && echo.blend'
    await convertBlend({ blenderPath: fakeBlender(), files: [{ path: nasty, data: bytes('x') }], main: nasty, tmpRoot: tmpRoot(), runner: okRunner((c, a) => (args = a)) })
    expect(args.some((a) => a.endsWith(nasty))).toBe(true) // present as ONE argument, untouched
  })

  it('lays the files out as they were, so relative texture paths (//textures/wood.png) resolve', async () => {
    ready()
    let seen
    await convertBlend({
      blenderPath: fakeBlender(), files: files(), main: 'scene.blend', tmpRoot: tmpRoot(),
      runner: async (c, a, o) => {
        const blendPath = a.find((x) => x.endsWith('scene.blend'))
        seen = {
          blend: fs.readFileSync(blendPath, 'utf8'),
          texture: fs.readFileSync(path.join(path.dirname(blendPath), 'textures', 'wood.png'), 'utf8'),
          cwd: o.cwd === path.dirname(blendPath),
        }
        fs.writeFileSync(outFrom(a), triangleGlb())
        return { code: 0, log: '' }
      },
    })
    expect(seen).toEqual({ blend: 'BLENDER-v400', texture: 'PNGDATA', cwd: true })
  })

  it('gives Blender our export script (it cannot read files out of an Electron asar)', async () => {
    ready()
    let scriptText
    await convertBlend({
      blenderPath: fakeBlender(), files: files(), main: 'scene.blend', tmpRoot: tmpRoot(),
      runner: async (c, a) => {
        scriptText = fs.readFileSync(a[a.indexOf('--python') + 1], 'utf8')
        fs.writeFileSync(outFrom(a), triangleGlb())
        return { code: 0, log: '' }
      },
    })
    expect(scriptText).toBe(EXPORT_SCRIPT)
  })

  it('cleans up its temp folder when it works…', async () => {
    ready()
    await convertBlend({ blenderPath: fakeBlender(), files: files(), main: 'scene.blend', tmpRoot: tmpRoot(), runner: okRunner() })
    expect(fs.readdirSync(tmpRoot())).toEqual([])
  })

  it('…and when it fails', async () => {
    ready()
    await expect(
      convertBlend({ blenderPath: fakeBlender(), files: files(), main: 'scene.blend', tmpRoot: tmpRoot(), runner: async () => ({ code: 3, log: 'RuntimeError: boom' }) }),
    ).rejects.toThrow()
    expect(fs.readdirSync(tmpRoot())).toEqual([])
  })

  it('a failing conversion reports Blender\'s own reason, not a wall of log', async () => {
    ready()
    const log = ['Blender 4.0.2', 'Read blend: x', 'Traceback (most recent call last):', '  File "export.py", line 3', 'RuntimeError: This file has no meshes or armatures to export.'].join('\n')
    await expect(
      convertBlend({ blenderPath: fakeBlender(), files: files(), main: 'scene.blend', tmpRoot: tmpRoot(), runner: async () => ({ code: 3, log }) }),
    ).rejects.toThrow(/This file has no meshes or armatures to export\.$/)
  })

  it('an exit code of 0 but no output file is still a failure', async () => {
    ready()
    await expect(
      convertBlend({ blenderPath: fakeBlender(), files: files(), main: 'scene.blend', tmpRoot: tmpRoot(), runner: async () => ({ code: 0, log: '' }) }),
    ).rejects.toThrow(/could not convert/)
  })

  it('output that is not a glb is rejected', async () => {
    ready()
    await expect(
      convertBlend({
        blenderPath: fakeBlender(), files: files(), main: 'scene.blend', tmpRoot: tmpRoot(),
        runner: async (c, a) => {
          fs.writeFileSync(outFrom(a), Buffer.from('this is definitely not a glb file at all'))
          return { code: 0, log: '' }
        },
      }),
    ).rejects.toThrow(/invalid file/)
  })

  it('a timeout stops Blender and says so', async () => {
    ready()
    await expect(
      convertBlend({ blenderPath: fakeBlender(), files: files(), main: 'scene.blend', tmpRoot: tmpRoot(), timeoutMs: 2000, runner: async () => ({ code: null, log: '', timedOut: true }) }),
    ).rejects.toThrow(/longer than 2 seconds/)
  })

  it('Blender failing to even start is explained', async () => {
    ready()
    await expect(
      convertBlend({ blenderPath: fakeBlender(), files: files(), main: 'scene.blend', tmpRoot: tmpRoot(), runner: async () => ({ code: null, log: '', spawnError: new Error('spawn EACCES') }) }),
    ).rejects.toThrow(/could not be started: spawn EACCES/)
  })

  it('collects Blender\'s warnings for the app to show', async () => {
    ready()
    const log = 'WARNING: image is huge\n[animare] warning: texture not found: wood.png\nsome other line\n[animare] options this Blender does not have: export_morph\nWARNING: image is huge'
    const r = await convertBlend({
      blenderPath: fakeBlender(), files: files(), main: 'scene.blend', tmpRoot: tmpRoot(),
      runner: async (c, a) => {
        fs.writeFileSync(outFrom(a), triangleGlb())
        return { code: 0, log }
      },
    })
    expect(r.warnings).toEqual(['WARNING: image is huge', 'texture not found: wood.png', 'options this Blender does not have: export_morph'])
  })

  it('does not bother the user with colour-management notices an old file triggers in a newer Blender', async () => {
    ready()
    const log = [
      '00:01.579  color_management | WARNING Display "sRGB / BT.709" used by scene not found, setting to "sRGB".',
      '00:01.579  color_management | WARNING scene view "Filmic Log Encoding Base" not found, setting to "Filmic".',
      '00:01.579  color_management | WARNING scene look "Base Contrast" not found, setting default "None".',
      '[animare] warning: texture not found: wood.png',
    ].join('\n')
    const r = await convertBlend({
      blenderPath: fakeBlender(), files: files(), main: 'scene.blend', tmpRoot: tmpRoot(),
      runner: async (c, a) => {
        fs.writeFileSync(outFrom(a), triangleGlb())
        return { code: 0, log }
      },
    })
    expect(r.warnings).toEqual(['texture not found: wood.png'])
  })

  it('tells Blender where to look for textures: the whole folder it was given', async () => {
    ready()
    let args
    await convertBlend({ blenderPath: fakeBlender(), files: files(), main: 'scene.blend', tmpRoot: tmpRoot(), runner: okRunner((c, a) => (args = a)) })
    const extra = args.slice(args.indexOf('--') + 1)
    expect(extra).toHaveLength(2)
    expect(extra[1]).toBe(path.dirname(args.find((x) => x.endsWith('scene.blend'))))
  })

  it.each([
    ['a path that climbs out', [{ path: '../evil.png', data: bytes('x') }, { path: 'a.blend', data: bytes('x') }], 'a.blend'],
    ['an absolute path', [{ path: '/etc/x', data: bytes('x') }, { path: 'a.blend', data: bytes('x') }], 'a.blend'],
    ['a main file that was not sent', [{ path: 'a.png', data: bytes('x') }], 'a.blend'],
    ['a main file that is not a .blend', [{ path: 'a.fbx', data: bytes('x') }], 'a.fbx'],
  ])('refuses %s — before running anything', async (_n, input, main) => {
    ready()
    const runner = vi.fn()
    await expect(convertBlend({ blenderPath: fakeBlender(), files: input, main, tmpRoot: tmpRoot(), runner })).rejects.toThrow()
    expect(runner).not.toHaveBeenCalled()
    expect(fs.readdirSync(tmpRoot())).toEqual([])
  })

  it('no Blender configured → a clear message', async () => {
    await expect(convertBlend({ blenderPath: path.join(tmp, 'missing'), files: files(), main: 'scene.blend' })).rejects.toThrow(/Blender was not found/)
    await expect(convertBlend({ blenderPath: fakeBlender(), files: [], main: 'scene.blend' })).rejects.toThrow(/No files/)
  })

  it('accepts ArrayBuffers and typed-array views too (what IPC delivers)', async () => {
    ready()
    const big = new Uint8Array(32)
    big.set(bytes('BLENDER'), 8)
    const view = big.subarray(8, 15) // a view into the middle of a bigger buffer
    let content
    await convertBlend({
      blenderPath: fakeBlender(), files: [{ path: 's.blend', data: view }], main: 's.blend', tmpRoot: tmpRoot(),
      runner: async (c, a) => {
        content = fs.readFileSync(a.find((x) => x.endsWith('s.blend')), 'utf8')
        fs.writeFileSync(outFrom(a), triangleGlb())
        return { code: 0, log: '' }
      },
    })
    expect(content).toBe('BLENDER')
  })
})

describe('the export script', () => {
  it('only passes export options the running Blender actually has (names differ between versions)', () => {
    expect(EXPORT_SCRIPT).toMatch(/get_rna_type\(\)\.properties\.keys\(\)/)
    expect(EXPORT_SCRIPT).toMatch(/k in supported/)
  })
  it('exports visible things only, keeps morphs, leaves cameras and lights to the app', () => {
    expect(EXPORT_SCRIPT).toContain("'use_visible'")
    expect(EXPORT_SCRIPT).toContain("'export_morph': True")
    expect(EXPORT_SCRIPT).toContain("'export_cameras': False")
    expect(EXPORT_SCRIPT).toContain("'export_lights': False")
    expect(EXPORT_SCRIPT).toContain("'export_draco_mesh_compression_enable': False")
  })
  it('relinks missing textures by name and converts old-style shaders to Principled', () => {
    expect(EXPORT_SCRIPT).toContain('def relink_textures')
    expect(EXPORT_SCRIPT).toContain('def convert_shaders')
    expect(EXPORT_SCRIPT).toContain("'BSDF_DIFFUSE'")
    expect(EXPORT_SCRIPT).toContain('ShaderNodeBsdfPrincipled')
  })
  it('exits non-zero on any failure', () => {
    expect(EXPORT_SCRIPT).toMatch(/sys\.exit\(3\)/)
  })
})

describe('IPC registration', () => {
  const setup = (deps) => {
    const handlers = {}
    const userData = path.join(tmp, 'userData')
    fs.mkdirSync(userData, { recursive: true })
    const dialog = { showOpenDialog: vi.fn() }
    registerBlenderIpc({ ipcMain: { handle: (n, fn) => (handlers[n] = fn) }, dialog, app: { getPath: () => userData }, deps })
    return { handlers, dialog, userData }
  }

  it('registers status / choose / clear / convert', () => {
    const { handlers } = setup({})
    expect(Object.keys(handlers).sort()).toEqual(['animare:blender-choose', 'animare:blender-clear', 'animare:blender-convert', 'animare:blender-status'])
  })

  it('convert: not found → a structured, readable failure (never a thrown error across IPC)', async () => {
    const { handlers } = setup({ getStatus: async () => ({ available: false, path: null }) })
    const r = await handlers['animare:blender-convert']({}, { main: 'a.blend', files: [] })
    expect(r).toMatchObject({ ok: false, code: 'not-found' })
    expect(r.error).toMatch(/Install it from blender\.org/)
  })

  it('convert: too old', async () => {
    const { handlers } = setup({ getStatus: async () => ({ available: false, path: '/b', version: '2.79' }) })
    expect(await handlers['animare:blender-convert']({}, {})).toMatchObject({ ok: false, code: 'too-old' })
  })

  it('convert: success returns the glb, warnings and version', async () => {
    const convert = vi.fn(async () => ({ glb: Buffer.from('glb'), warnings: ['w'] }))
    const { handlers } = setup({ getStatus: async () => ({ available: true, path: '/b', version: '4.0.2' }), convertBlend: convert })
    const r = await handlers['animare:blender-convert']({}, { main: 'a.blend', files: [{ path: 'a.blend', data: bytes('x') }] })
    expect(r).toMatchObject({ ok: true, warnings: ['w'], blenderVersion: '4.0.2' })
    expect(convert.mock.calls[0][0]).toMatchObject({ blenderPath: '/b', main: 'a.blend' })
  })

  it('convert: an error inside the converter comes back as a failure result', async () => {
    const { handlers } = setup({ getStatus: async () => ({ available: true, path: '/b' }), convertBlend: async () => { throw new Error('exploded') } })
    expect(await handlers['animare:blender-convert']({}, {})).toMatchObject({ ok: false, code: 'failed', error: 'exploded' })
  })

  it('choose: remembers a real Blender, rejects something else, and clear forgets it', async () => {
    const calls = []
    const status = async ({ configuredPath }) => { calls.push(configuredPath); return { available: true, path: configuredPath || null, source: configuredPath ? 'chosen' : null } }
    const { handlers, dialog, userData } = setup({ getStatus: status, getVersion: async (p) => (p === '/is/blender' ? { text: '4.0' } : null) })

    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/not/blender'] })
    expect((await handlers['animare:blender-choose']()).error).toMatch(/does not look like Blender/)
    expect(fs.existsSync(path.join(userData, 'blender.json'))).toBe(false)

    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/is/blender'] })
    expect((await handlers['animare:blender-choose']()).path).toBe('/is/blender')
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'blender.json'), 'utf8')).path).toBe('/is/blender')

    expect((await handlers['animare:blender-status']()).path).toBe('/is/blender') // remembered

    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect((await handlers['animare:blender-choose']()).path).toBe('/is/blender') // cancel changes nothing

    await handlers['animare:blender-clear']()
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'blender.json'), 'utf8')).path).toBeNull()
  })
})
