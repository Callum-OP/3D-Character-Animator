// Records the live canvas to a proper, seekable MP4 (H.264) or WebM (VP9/VP8)
// using WebCodecs plus mp4-muxer / webm-muxer.
//
// Why not MediaRecorder? It stamps every frame with wall-clock time as it
// arrives, so any hiccup while the encoder spins up or the render loop stalls
// is baked into the file, and the container ends up with no duration (WebM) or
// is fragmented with no seek index (MP4). Here every frame is encoded by us
// with an explicit timestamp on a constant-rate grid and the muxer writes a
// normal file with duration + seek index, so length and scrubbing just work.
//
// Two things keep the START of a recording clean:
//  - warmUp() pushes the first frame through the encoder and waits for it to
//    come out BEFORE playback starts. Hardware encoders can take seconds to
//    create their session; without this the first frames pile up in the
//    queue, get dropped, and the opening frame is held until the encoder
//    catches up (the "frozen for the first few seconds" bug).
//  - begin() anchors the frame-timestamp grid to the moment playback actually
//    starts, instead of whenever the first render happened to occur.

export const H264_CODECS = [
  'avc1.640034', // High, level 5.2 (4K at 60 fps)
  'avc1.640033', // High, level 5.1
  'avc1.4d0033', // Main, level 5.1
]

// Highest level first; the browser tells us which it can really encode.
export const VP_CODECS = [
  'vp09.00.61.08', // VP9 profile 0, level 6.1 (8K)
  'vp09.00.51.08', // level 5.1 (4K at 60 fps)
  'vp09.00.41.08', // level 4.1 (1080p at 60 fps)
  'vp8',
]

export const CONTAINERS = {
  mp4: { ext: 'mp4', mime: 'video/mp4', codecs: H264_CODECS, muxerCodec: () => 'avc' },
  webm: { ext: 'webm', mime: 'video/webm', codecs: VP_CODECS, muxerCodec: (codec) => (codec === 'vp8' ? 'V_VP8' : 'V_VP9') },
}

export function webCodecsAvailable() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'
}

// First configuration from `codecs` the browser can really encode at this size, or null.
async function findConfig(codecs, { width, height, fps, bitrate }, EncoderClass) {
  if (!EncoderClass?.isConfigSupported) return null
  for (const codec of codecs) {
    // Prefer a hardware encoder (keeps up with 1080p60 / 4K without stealing
    // CPU from the render loop), then whatever the browser has.
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      const config = {
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
        hardwareAcceleration,
        latencyMode: 'realtime', // keep up with the live render loop instead of buffering
      }
      if (codec.startsWith('avc1')) config.avc = { format: 'avc' } // length-prefixed NALUs, which is what MP4 stores
      try {
        const result = await EncoderClass.isConfigSupported(config)
        if (result?.supported) return result.config || config
      } catch {
        // try the next option
      }
    }
  }
  return null
}

export function findH264Config(size, EncoderClass = globalThis.VideoEncoder) {
  return findConfig(H264_CODECS, size, EncoderClass)
}

// Encoder config for 'mp4' or 'webm' at this size, or null if the browser can't.
export function findVideoConfig(container, size, EncoderClass = globalThis.VideoEncoder) {
  const def = CONTAINERS[container]
  return def ? findConfig(def.codecs, size, EncoderClass) : Promise.resolve(null)
}

const MAX_QUEUE = 12 // frames allowed to wait for the encoder before new ones are dropped

export class VideoCapture {
  constructor({
    canvas,
    width,
    height,
    fps,
    config,
    Muxer,
    ArrayBufferTarget,
    container = 'mp4',
    manualStart = false, // true: ignore frames until begin() is called
    maxQueue = MAX_QUEUE,
    EncoderClass = globalThis.VideoEncoder,
    FrameClass = globalThis.VideoFrame,
  }) {
    const def = CONTAINERS[container] || CONTAINERS.mp4
    this.ext = def.ext
    this.mime = def.mime
    this.canvas = canvas
    this.fps = fps
    this.FrameClass = FrameClass
    this.maxQueue = maxQueue
    this.manualStart = manualStart
    this.startedAt = null
    this.lastElapsed = -Infinity // ms since the shot started, of the last captured frame
    this.nextFrameNumber = 0
    this.lastTimestamp = -1 // µs
    this.captured = 0
    this.dropped = 0
    this.error = null
    this.stopped = false
    this.target = new ArrayBufferTarget()
    const muxerOptions = {
      target: this.target,
      video: { codec: def.muxerCodec(config.codec), width, height },
      firstTimestampBehavior: 'offset',
    }
    if (container === 'webm') muxerOptions.video.frameRate = fps
    else muxerOptions.fastStart = 'in-memory' // index at the front of the file → duration + scrubbing
    this.muxer = new Muxer(muxerOptions)
    this.encoder = new EncoderClass({
      output: (chunk, meta) => {
        try {
          this.muxer.addVideoChunk(chunk, meta)
        } catch (e) {
          this.error = this.error || e
        }
      },
      error: (e) => {
        this.error = this.error || e
      },
    })
    this.encoder.configure(config)
  }

  // Encode the opening frame now and wait for the encoder to hand it back, so
  // its start-up cost is paid before playback begins rather than during it.
  // `renderFn` must draw the first frame synchronously (a WebGL canvas may be
  // blank once control returns to the browser). Never throws; a slow encoder
  // just costs up to `timeoutMs`.
  async warmUp(renderFn, timeoutMs = 5000) {
    if (this.stopped || this.error || this.captured) return
    try {
      renderFn?.()
    } catch {
      // the frame below is still worth trying
    }
    if (!this.#capture(0)) return
    this.nextFrameNumber = 1 // frame 0 is done; the live grid carries on from frame 1
    let timer
    try {
      await Promise.race([
        this.encoder.flush(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        }),
      ])
    } catch (e) {
      this.error = this.error || e
    } finally {
      clearTimeout(timer)
    }
  }

  // Playback has started: frame times are measured from here.
  begin(nowMs) {
    if (this.startedAt === null) this.startedAt = nowMs
  }

  // Call right after each rendered frame. Frame timestamps use a constant-rate
  // grid, avoiding visible cadence jitter from small render-loop timing changes.
  // If rendering misses a slot, the timestamp advances to the current slot, so
  // slow frames still hold their real place in the shot instead of speeding it up.
  onFrame(nowMs) {
    if (this.stopped || this.error) return false
    if (this.startedAt === null) {
      if (this.manualStart) return false
      this.startedAt = nowMs
    }
    const elapsed = nowMs - this.startedAt
    const frameNumber = Math.floor((elapsed + 0.01) / (1000 / this.fps))
    if (frameNumber < this.nextFrameNumber) return false
    this.nextFrameNumber = frameNumber + 1
    if (this.encoder.encodeQueueSize >= this.maxQueue) {
      this.dropped++
      return false
    }
    return this.#capture(frameNumber * (1000 / this.fps))
  }

  #capture(elapsedMs) {
    let frame
    try {
      const timestamp = Math.max(this.lastTimestamp + 1, Math.round(elapsedMs * 1000)) // strictly increasing, in µs
      frame = new this.FrameClass(this.canvas, { timestamp, duration: Math.round(1e6 / this.fps) })
      this.encoder.encode(frame, { keyFrame: this.captured % (this.fps * 2) === 0 })
      this.lastElapsed = elapsedMs
      this.lastTimestamp = timestamp
      this.captured++
      return true
    } catch (e) {
      this.error = this.error || e
      return false
    } finally {
      frame?.close()
    }
  }

  // Take one last frame at the current time (so the video's length matches the
  // shot) and stop accepting more. Synchronous: call while the canvas is still
  // at the recording size.
  stopCapturing(nowMs) {
    if (this.stopped) return
    if (this.startedAt !== null && !this.error) {
      this.#capture(Math.max(this.lastElapsed + 1, nowMs - this.startedAt))
    }
    this.stopped = true
  }

  // Flush the encoder and write the finished file.
  async finish() {
    this.stopped = true
    try {
      await this.encoder.flush()
    } catch (e) {
      this.error = this.error || e
    }
    try {
      this.encoder.close()
    } catch {
      // already closed after an error
    }
    if (this.error) throw this.error
    if (!this.captured) throw new Error('No video frames were captured')
    this.muxer.finalize()
    return new Blob([this.target.buffer], { type: this.mime })
  }

  cancel() {
    this.stopped = true
    try {
      this.encoder.close()
    } catch {
      // ignore
    }
  }
}
