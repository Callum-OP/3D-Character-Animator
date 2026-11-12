// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { downloadFile, rgbaToChw, createPoseEngine, MODEL } = require('../../electron/poseEngine.cjs')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pose-'))

function serve(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` }))
  })
}

describe('downloadFile', () => {
  it('follows redirects, verifies size + sha256 and reports progress', async () => {
    const data = crypto.randomBytes(300_000)
    const sha = crypto.createHash('sha256').update(data).digest('hex')
    const { s, base } = await serve((req, res) => {
      if (req.url === '/start') { res.writeHead(302, { location: '/real' }); return res.end() }
      res.writeHead(200, { 'content-length': data.length }); res.end(data)
    })
    const dest = path.join(tmp(), 'm.onnx')
    const seen = []
    await downloadFile(`${base}/start`, dest, { sha256: sha, bytes: data.length, onProgress: (p) => seen.push(p) })
    s.close()
    expect(fs.readFileSync(dest).equals(data)).toBe(true)
    expect(fs.existsSync(dest + '.part')).toBe(false)
    expect(seen.at(-1)).toEqual({ received: data.length, total: data.length })
  })

  it('rejects a corrupt download and leaves nothing behind', async () => {
    const data = crypto.randomBytes(1000)
    const { s, base } = await serve((req, res) => { res.writeHead(200); res.end(data) })
    const dest = path.join(tmp(), 'm.onnx')
    await expect(downloadFile(`${base}/x`, dest, { sha256: 'deadbeef', bytes: data.length })).rejects.toThrow(/Checksum/)
    s.close()
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.existsSync(dest + '.part')).toBe(false)
  })

  it('can be cancelled', async () => {
    const { s, base } = await serve((req, res) => { res.writeHead(200, { 'content-length': 1e9 }); res.write(Buffer.alloc(1000)) })
    const ac = new AbortController()
    const dest = path.join(tmp(), 'm.onnx')
    const p = downloadFile(`${base}/x`, dest, { signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    await expect(p).rejects.toThrow(/Cancelled/)
    s.closeAllConnections?.(); s.close()
    expect(fs.existsSync(dest + '.part')).toBe(false)
  })
})

describe('rgbaToChw', () => {
  it('splits RGBA into planar RGB floats in 0..1', () => {
    const size = 2
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 51, 102, 153, 255])
    const out = rgbaToChw(rgba, size)
    expect(Array.from(out.slice(0, 4))).toEqual([1, 0, 0, 0.2].map((v) => Math.fround(v)))
    expect(Array.from(out.slice(4, 8))[1]).toBe(1)
    expect(out[11]).toBeCloseTo(0.6, 5)
  })
  it('rejects a wrongly sized crop', () => {
    expect(() => rgbaToChw(new Uint8Array(10))).toThrow(/512x512/)
  })
})

describe('engine session handling (mocked onnxruntime)', () => {
  function fakeOrt({ failDml = false } = {}) {
    const calls = { created: [], feeds: [] }
    class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims } }
    const ort = {
      Tensor,
      calls,
      InferenceSession: {
        async create(p, opts) {
          calls.created.push(opts.executionProviders[0])
          if (failDml && opts.executionProviders[0] === 'dml') throw new Error('DirectML unavailable')
          return {
            async run(feeds) {
              calls.feeds.push(feeds)
              return {
                keypoints_2d: new Tensor('float32', new Float32Array(140), [1, 70, 2]),
                keypoints_3d: new Tensor('float32', new Float32Array(210), [1, 70, 3]),
                cam_t: new Tensor('float32', new Float32Array(3), [1, 3]),
                joint_coords: new Tensor('float32', new Float32Array(381), [1, 127, 3]),
                joint_rotations: new Tensor('float32', new Float32Array(1143), [1, 127, 3, 3]),
              }
            },
            async release() {},
          }
        },
      },
    }
    return ort
  }
  const withModel = () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, MODEL.file), '')
    fs.truncateSync(path.join(dir, MODEL.file), MODEL.bytes) // sparse file of the right size
    return dir
  }

  it('reports status without a model, and refuses to load', async () => {
    const e = createPoseEngine({ modelDir: tmp(), ort: fakeOrt() })
    const st = await e.status()
    expect(st.modelReady).toBe(false)
    await expect(e.load('auto')).rejects.toThrow(/not been downloaded/)
  })

  it('falls back from DirectML to CPU on Windows', async () => {
    const ort = fakeOrt({ failDml: true })
    const e = createPoseEngine({ modelDir: withModel(), ort, platform: 'win32', arch: 'x64' })
    const r = await e.load('auto')
    expect(r.provider).toBe('cpu')
    expect(ort.calls.created).toEqual(['dml', 'cpu'])
  })

  it('defaults to the CPU on Windows ARM (Adreno DirectML is unverified) but honours an explicit GPU choice', async () => {
    const a = fakeOrt()
    const e = createPoseEngine({ modelDir: withModel(), ort: a, platform: 'win32', arch: 'arm64' })
    expect((await e.load('auto')).provider).toBe('cpu')
    expect(a.calls.created).toEqual(['cpu'])
    const b = fakeOrt()
    const e2 = createPoseEngine({ modelDir: withModel(), ort: b, platform: 'win32', arch: 'arm64' })
    expect((await e2.load('dml')).provider).toBe('dml')
    const c = fakeOrt()
    await createPoseEngine({ modelDir: withModel(), ort: c, platform: 'win32', arch: 'x64' }).load('auto')
    expect(c.calls.created[0]).toBe('dml')
  })

  it('uses CPU only off Windows and when asked', async () => {
    const ort = fakeOrt()
    const e = createPoseEngine({ modelDir: withModel(), ort, platform: 'linux' })
    expect((await e.load('auto')).provider).toBe('cpu')
    const e2 = createPoseEngine({ modelDir: withModel(), ort: fakeOrt(), platform: 'win32' })
    expect((await e2.load('cpu')).provider).toBe('cpu')
  })

  it('feeds the documented inputs and returns every output', async () => {
    const ort = fakeOrt()
    const e = createPoseEngine({ modelDir: withModel(), ort })
    await e.load('cpu')
    const out = await e.infer({ rgba: new Uint8Array(512 * 512 * 4), center: [100, 200], scale: [400, 400], affine: [1.28, 0, 1, 0, 1.28, 2], imageSize: [1920, 1080], camera: [2203, 0, 960, 0, 2203, 540, 0, 0, 1] })
    const f = ort.calls.feeds[0]
    expect(f.image.dims).toEqual([1, 3, 512, 512])
    expect(f.bbox_center.dims).toEqual([1, 2])
    expect(f.affine.dims).toEqual([1, 2, 3])
    expect(f.camera.dims).toEqual([3, 3])
    expect(out.joint_rotations.length).toBe(1143)
    expect(out.keypoints_3d.length).toBe(210)
  })

  it('rejects inference before the model is loaded', async () => {
    const e = createPoseEngine({ modelDir: withModel(), ort: fakeOrt() })
    await expect(e.infer({})).rejects.toThrow(/not loaded/)
  })
})
