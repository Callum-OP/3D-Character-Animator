// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { writeFileSafely } = require('../../electron/safeWrite.cjs')

describe('writeFileSafely (desktop project saves)', () => {
  let dir
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'safewrite-'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('writes the whole file and leaves nothing else behind', async () => {
    const target = path.join(dir, 'a.3dcp')
    await writeFileSafely(target, 'x'.repeat(100000))
    expect(fs.statSync(target).size).toBe(100000)
    expect(fs.readdirSync(dir)).toEqual(['a.3dcp'])
  })

  it('replaces an existing project in one step', async () => {
    const target = path.join(dir, 'a.3dcp')
    await fsp.writeFile(target, 'old project')
    await writeFileSafely(target, 'new project, longer')
    expect(await fsp.readFile(target, 'utf-8')).toBe('new project, longer')
    expect(fs.readdirSync(dir)).toEqual(['a.3dcp'])
  })

  it('keeps the previous project untouched when the save fails part-way', async () => {
    const target = path.join(dir, 'a.3dcp')
    await fsp.writeFile(target, 'the good, earlier project')
    vi.spyOn(fsp, 'rename').mockRejectedValue(Object.assign(new Error('disk went away'), { code: 'EIO' }))
    await expect(writeFileSafely(target, 'a new save that never finishes')).rejects.toThrow('disk went away')
    expect(await fsp.readFile(target, 'utf-8')).toBe('the good, earlier project')
    expect(fs.readdirSync(dir)).toEqual(['a.3dcp']) // and no stray temporary file
  })

  it('keeps the previous project when the file would be written short', async () => {
    const target = path.join(dir, 'a.3dcp')
    await fsp.writeFile(target, 'the good, earlier project')
    const realOpen = fsp.open
    vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args)
      const realWrite = handle.writeFile.bind(handle)
      handle.writeFile = (data) => realWrite(data.subarray(0, Math.floor(data.length / 2))) // a cut-off write
      return handle
    })
    await expect(writeFileSafely(target, 'x'.repeat(5000))).rejects.toThrow(/not written completely/)
    expect(await fsp.readFile(target, 'utf-8')).toBe('the good, earlier project')
    expect(fs.readdirSync(dir)).toEqual(['a.3dcp'])
  })
})
