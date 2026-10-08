import { beforeAll, describe, expect, it } from 'vitest'
import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer'
import { VideoCapture, findH264Config, findVideoConfig, H264_CODECS, VP_CODECS } from '../three/videoCapture.js'

// --- minimal WebCodecs stand-ins (jsdom has none) --------------------------
class FakeEncodedVideoChunk {
  constructor({ type, timestamp, duration, data }) {
    this.type = type
    this.timestamp = timestamp
    this.duration = duration
    this.byteLength = data.byteLength
    this._data = data
  }
  copyTo(target) {
    target.set(this._data)
  }
}

// A minimal but structurally valid avcC (H.264 decoder config) record.
const SPS = [0x67, 0x64, 0x00, 0x33, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x60, 0xc6, 0x58]
const PPS = [0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]
const AVCC = new Uint8Array([1, 0x64, 0x00, 0x33, 0xff, 0xe1, 0, SPS.length, ...SPS, 1, 0, PPS.length, ...PPS])

class FakeFrame {
  constructor(canvas, init) {
    this.timestamp = init.timestamp
    this.duration = init.duration
    FakeFrame.live++
  }
  close() {
    FakeFrame.live--
  }
}
FakeFrame.live = 0

function makeEncoderClass(state = {}) {
  return class FakeEncoder {
    constructor({ output, error }) {
      this.output = output
      this.error = error
      this.encodeQueueSize = state.queue ?? 0
      this.keyFlags = []
      state.instance = this
      this.first = true
    }
    configure(config) {
      state.config = config
    }
    encode(frame, opts) {
      if (state.throwOnEncode) throw new Error('encode failed')
      this.keyFlags.push(opts.keyFrame)
      const chunk = new FakeEncodedVideoChunk({
        type: opts.keyFrame ? 'key' : 'delta',
        timestamp: frame.timestamp,
        duration: frame.duration,
        data: new Uint8Array([0, 0, 0, 5, opts.keyFrame ? 0x65 : 0x41, 1, 2, 3, 4]),
      })
      const meta = this.first
        ? { decoderConfig: { codec: 'avc1.640033', codedWidth: 1920, codedHeight: 1080, description: AVCC } }
        : undefined
      this.first = false
      this.output(chunk, meta)
    }
    async flush() {}
    close() {}
  }
}

beforeAll(() => {
  globalThis.EncodedVideoChunk = FakeEncodedVideoChunk // the muxer type-checks against this global
})

const fps = 30
function makeCapture(encoderState = {}) {
  return new VideoCapture({
    canvas: {},
    width: 1920,
    height: 1080,
    fps,
    config: { codec: 'avc1.640033' },
    Muxer,
    ArrayBufferTarget,
    EncoderClass: makeEncoderClass(encoderState),
    FrameClass: FakeFrame,
  })
}

// --- tiny MP4 box reader ---------------------------------------------------
async function readBoxes(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(buf.buffer)
  const type = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3])
  const boxes = []
  for (let o = 0; o < buf.length; ) {
    const size = view.getUint32(o)
    boxes.push({ type: type(o + 4), offset: o, size })
    if (size < 8) break
    o += size
  }
  const moov = boxes.find((b) => b.type === 'moov')
  let duration = 0
  let timescale = 1
  if (moov) {
    // mvhd is moov's first child: header(8) + version/flags(4) + created(4) + modified(4) + timescale(4) + duration(4)
    const mvhd = moov.offset + 8
    timescale = view.getUint32(mvhd + 8 + 4 + 8)
    duration = view.getUint32(mvhd + 8 + 4 + 8 + 4)
  }
  return { boxes, seconds: duration / timescale }
}

describe('VideoCapture (WebCodecs MP4)', () => {
  it('writes a seekable MP4: index (moov) before the media data, with a real duration', async () => {
    const cap = makeCapture()
    // 2 seconds of a 60 Hz render loop
    for (let i = 0; i <= 120; i++) cap.onFrame(1000 + (i * 1000) / 60)
    cap.stopCapturing(1000 + 2000)
    const blob = await cap.finish()
    expect(blob.type).toBe('video/mp4')
    const { boxes, seconds } = await readBoxes(blob)
    const order = boxes.map((b) => b.type)
    expect(order[0]).toBe('ftyp')
    expect(order.indexOf('moov')).toBeGreaterThan(-1)
    expect(order.indexOf('moov')).toBeLessThan(order.indexOf('mdat')) // "fast start": what makes the scrub bar work
    expect(seconds).toBeGreaterThan(1.9)
    expect(seconds).toBeLessThan(2.2)
  })

  it('captures one frame per output slot (60 Hz loop → 30 fps video) and never leaks VideoFrames', () => {
    const cap = makeCapture()
    for (let i = 0; i < 60; i++) cap.onFrame(i * (1000 / 60))
    expect(cap.captured).toBeGreaterThanOrEqual(29)
    expect(cap.captured).toBeLessThanOrEqual(31)
    expect(cap.onFrame(59 * (1000 / 60))).toBe(false) // same slot again → ignored
    expect(FakeFrame.live).toBe(0)
  })

  it('does not oversample 24 fps on a 60 Hz render loop', () => {
    const cap = new VideoCapture({
      canvas: {}, width: 1920, height: 1080, fps: 24, config: {}, Muxer, ArrayBufferTarget,
      EncoderClass: makeEncoderClass({}), FrameClass: FakeFrame,
    })
    for (let i = 0; i < 600; i++) cap.onFrame(i * (1000 / 60))
    expect(cap.captured).toBeGreaterThanOrEqual(239)
    expect(cap.captured).toBeLessThanOrEqual(241)
  })

  it('stamps frames with real time: a stall holds a frame instead of shortening the video', async () => {
    const cap = makeCapture()
    cap.onFrame(0)
    cap.onFrame(33)
    cap.onFrame(66)
    cap.onFrame(2066) // render loop froze for 2 s
    cap.stopCapturing(2100)
    const { seconds } = await readBoxes(await cap.finish())
    expect(seconds).toBeGreaterThan(2.0)
  })

  it('stamps frames to a constant frame-rate grid despite render-loop jitter', () => {
    const stamps = []
    class Spy extends FakeFrame {
      constructor(c, init) {
        super(c, init)
        stamps.push(init.timestamp)
      }
    }
    const cap = new VideoCapture({
      canvas: {}, width: 1920, height: 1080, fps, config: {}, Muxer, ArrayBufferTarget,
      EncoderClass: makeEncoderClass({}), FrameClass: Spy,
    })
    // a slightly jittery 60 Hz loop
    const times = [5, 21.9, 38.1, 55.2, 71.4, 88.0, 104.1, 121.3]
    for (const t of times) cap.onFrame(t)
    expect(stamps[0]).toBe(0)
    const frameDuration = 1e6 / fps
    for (const stamp of stamps) {
      const nearestSlot = Math.round(stamp / frameDuration)
      expect(Math.abs(stamp - nearestSlot * frameDuration)).toBeLessThan(1)
    }
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]).toBeGreaterThan(stamps[i - 1])
  })

  it('keeps an even cadence on a jittery 60 Hz loop (no 33/50 ms alternation)', () => {
    const stamps = []
    class Spy extends FakeFrame {
      constructor(c, init) {
        super(c, init)
        stamps.push(init.timestamp / 1000)
      }
    }
    const cap = new VideoCapture({
      canvas: {}, width: 1920, height: 1080, fps, config: {}, Muxer, ArrayBufferTarget,
      EncoderClass: makeEncoderClass({}), FrameClass: Spy,
    })
    let t = 0
    let seed = 1
    for (let i = 0; i < 300; i++) {
      seed = (seed * 16807) % 2147483647
      t += 16.67 + ((seed % 100) / 100 - 0.5) * 1.6 // ±0.8 ms of vsync jitter
      cap.onFrame(t)
    }
    const gaps = stamps.slice(1).map((v, i) => v - stamps[i])
    expect(Math.min(...gaps)).toBeGreaterThan(30)
    expect(Math.max(...gaps)).toBeLessThan(37)
  })

  it('asks for a keyframe at the start and then every 2 seconds', () => {
    const state = {}
    const cap = makeCapture(state)
    for (let i = 0; i < 200; i++) cap.onFrame(i * (1000 / 30))
    const keys = state.instance.keyFlags.map((k, i) => (k ? i : -1)).filter((i) => i >= 0)
    expect(keys[0]).toBe(0)
    expect(keys[1]).toBe(60) // 2 s × 30 fps
  })

  it('drops frames instead of piling up when the encoder is really far behind', () => {
    const cap = makeCapture({ queue: 12 })
    for (let i = 0; i < 10; i++) cap.onFrame(i * 40)
    expect(cap.captured).toBe(0)
    expect(cap.dropped).toBe(10)
  })

  it('tolerates a short backlog (encoder start-up) instead of dropping the opening frames', () => {
    // Regression: a limit of 4 dropped every frame while a hardware encoder spun
    // up, so the first frame was held for seconds. A small backlog must be kept.
    const cap = makeCapture({ queue: 6 })
    for (let i = 0; i < 10; i++) cap.onFrame(i * 40)
    expect(cap.dropped).toBe(0)
    expect(cap.captured).toBeGreaterThan(5)
  })

  it('reports an encoder failure instead of writing a broken file', async () => {
    const cap = makeCapture({ throwOnEncode: true })
    cap.onFrame(0)
    await expect(cap.finish()).rejects.toThrow('encode failed')
  })

  it('rejects when nothing was captured', async () => {
    await expect(makeCapture().finish()).rejects.toThrow(/No video frames/)
  })

  it('ignores frames after it has been stopped', () => {
    const cap = makeCapture()
    cap.onFrame(0)
    cap.stopCapturing(50)
    const before = cap.captured
    expect(cap.onFrame(5000)).toBe(false)
    expect(cap.captured).toBe(before)
  })
})

describe('findH264Config', () => {
  const dims = { width: 1920, height: 1080, fps: 30, bitrate: 10_000_000 }

  it('returns the first profile the browser supports, in realtime mode', async () => {
    const Enc = { isConfigSupported: async (c) => ({ supported: c.codec === H264_CODECS[1], config: c }) }
    const cfg = await findH264Config(dims, Enc)
    expect(cfg.codec).toBe(H264_CODECS[1])
    expect(cfg.hardwareAcceleration).toBe('prefer-hardware') // tried first
    expect(cfg).toMatchObject({ width: 1920, height: 1080, bitrate: 10_000_000, framerate: 30, latencyMode: 'realtime' })
  })

  it('falls back to a software encoder when hardware is not available', async () => {
    const Enc = { isConfigSupported: async (c) => ({ supported: c.hardwareAcceleration === 'no-preference', config: c }) }
    expect((await findH264Config(dims, Enc)).hardwareAcceleration).toBe('no-preference')
  })

  it('returns null when no profile works, when the API is missing, or when it throws', async () => {
    expect(await findH264Config(dims, { isConfigSupported: async () => ({ supported: false }) })).toBeNull()
    expect(await findH264Config(dims, {})).toBeNull()
    expect(await findH264Config(dims, { isConfigSupported: async () => { throw new Error('x') } })).toBeNull()
  })
})

describe('VideoCapture start-up (warm-up and playback anchoring)', () => {
  function manualCapture(encoderState = {}, extra = {}) {
    return new VideoCapture({
      canvas: {}, width: 1920, height: 1080, fps, config: { codec: 'avc1.640033' }, Muxer, ArrayBufferTarget,
      manualStart: true, EncoderClass: makeEncoderClass(encoderState), FrameClass: FakeFrame, ...extra,
    })
  }

  it('ignores render frames until playback begins', () => {
    const cap = manualCapture()
    expect(cap.onFrame(0)).toBe(false)
    expect(cap.onFrame(500)).toBe(false)
    expect(cap.captured).toBe(0)
    cap.begin(1000)
    expect(cap.onFrame(1000)).toBe(true)
  })

  it('measures frame times from begin(), not from the first render', () => {
    const stamps = []
    class Spy extends FakeFrame {
      constructor(c, init) { super(c, init); stamps.push(init.timestamp) }
    }
    const cap = manualCapture({}, { FrameClass: Spy })
    cap.onFrame(100) // an early render, before playback: must not start the clock
    cap.begin(5000)
    cap.onFrame(5000)
    cap.onFrame(5034)
    expect(stamps[0]).toBe(0)
    expect(stamps[1]).toBeGreaterThan(30_000)
    expect(stamps[1]).toBeLessThan(36_000)
  })

  it('warmUp draws the first frame itself, pushes it through the encoder and waits for it', async () => {
    const order = []
    const state = {}
    const Enc = makeEncoderClass(state)
    class SpyEnc extends Enc {
      encode(...a) { order.push('encode'); return super.encode(...a) }
      async flush() { order.push('flush') }
    }
    const cap = manualCapture({}, { EncoderClass: SpyEnc })
    await cap.warmUp(() => order.push('render'))
    expect(order).toEqual(['render', 'encode', 'flush']) // render → encode synchronously, then wait
    expect(cap.captured).toBe(1)
    // The live grid carries on after frame 0: no duplicate frame at t=0.
    cap.begin(2000)
    expect(cap.onFrame(2000)).toBe(false)
    expect(cap.onFrame(2000 + 1000 / fps)).toBe(true)
  })

  it('warmUp does not hang on an encoder that never answers', async () => {
    const Enc = makeEncoderClass({})
    class Stuck extends Enc { flush() { return new Promise(() => {}) } }
    const cap = manualCapture({}, { EncoderClass: Stuck })
    const t0 = Date.now()
    await cap.warmUp(() => {}, 50)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('warmUp surfaces an encoder failure so the caller can fall back', async () => {
    const cap = manualCapture({ throwOnEncode: true })
    await cap.warmUp(() => {})
    expect(cap.error).toBeTruthy()
  })

  it('a stall between warm-up and playback does not freeze the opening of the video', async () => {
    const cap = manualCapture()
    await cap.warmUp(() => {})
    // encoder set-up "took" a long time, playback starts afterwards at t=10 s
    cap.begin(10_000)
    for (let i = 0; i <= 60; i++) cap.onFrame(10_000 + (i * 1000) / 30)
    cap.stopCapturing(12_000)
    const { seconds } = await readBoxes(await cap.finish())
    expect(seconds).toBeGreaterThan(1.9)
    expect(seconds).toBeLessThan(2.2)
  })
})

describe('VideoCapture (WebCodecs WebM)', () => {
  function webmCapture(codec = 'vp09.00.51.08') {
    const opts = {}
    class SpyMuxer extends WebmMuxer {
      constructor(o) { super(o); opts.value = o }
    }
    const cap = new VideoCapture({
      canvas: {}, width: 1280, height: 720, fps, config: { codec }, container: 'webm',
      Muxer: SpyMuxer, ArrayBufferTarget: WebmTarget,
      EncoderClass: makeEncoderClass({}), FrameClass: FakeFrame,
    })
    return { cap, opts }
  }

  it('writes a WebM blob with the matching extension and mime type', async () => {
    const { cap } = webmCapture()
    for (let i = 0; i <= 60; i++) cap.onFrame(i * (1000 / 30))
    cap.stopCapturing(2000)
    const blob = await cap.finish()
    expect(cap.ext).toBe('webm')
    expect(blob.type).toBe('video/webm')
    const head = new Uint8Array(await blob.arrayBuffer()).slice(0, 4)
    expect([...head]).toEqual([0x1a, 0x45, 0xdf, 0xa3]) // EBML header
  })

  it('tells the muxer VP9 vs VP8 and the frame rate; no MP4 fast-start option', () => {
    expect(webmCapture('vp09.00.51.08').opts.value.video).toMatchObject({ codec: 'V_VP9', width: 1280, height: 720, frameRate: fps })
    expect(webmCapture('vp8').opts.value.video.codec).toBe('V_VP8')
    expect(webmCapture().opts.value.fastStart).toBeUndefined()
  })
})

describe('findVideoConfig', () => {
  const dims = { width: 1920, height: 1080, fps: 30, bitrate: 10_000_000 }
  const only = (codec) => ({ isConfigSupported: async (c) => ({ supported: c.codec === codec, config: c }) })

  it('finds a WebM (VP9) config, falling back to VP8', async () => {
    expect((await findVideoConfig('webm', dims, only(VP_CODECS[2]))).codec).toBe(VP_CODECS[2])
    expect((await findVideoConfig('webm', dims, only('vp8'))).codec).toBe('vp8')
  })

  it('only sets the H.264 length-prefixed option on H.264 configs', async () => {
    const mp4 = await findVideoConfig('mp4', dims, only(H264_CODECS[0]))
    const webm = await findVideoConfig('webm', dims, only('vp8'))
    expect(mp4.avc).toEqual({ format: 'avc' })
    expect(webm.avc).toBeUndefined()
  })

  it('returns null for an unknown container or when nothing is supported', async () => {
    expect(await findVideoConfig('mov', dims, only('vp8'))).toBeNull()
    expect(await findVideoConfig('webm', dims, only('nope'))).toBeNull()
  })
})
