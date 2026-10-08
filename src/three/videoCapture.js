// Records the live canvas to a proper, seekable MP4 using WebCodecs (H.264) and
// mp4-muxer.
//
// Why not MediaRecorder for MP4? Browsers write MediaRecorder MP4 as a
// *fragmented* file with no duration or seek index: it plays, but most players
// show no scrub bar and stutter around the start. Here every frame is encoded
// ourselves with explicit timestamps and the muxer writes a normal MP4 with the
// index (moov) at the front ("fast start"), so duration and seeking just work.

export const H264_CODECS = [
  'avc1.640034', // High, level 5.2 (4K at 60 fps)
  'avc1.640033', // High, level 5.1
  'avc1.4d0033', // Main, level 5.1
]

export function webCodecsAvailable() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'
}

// First H.264 configuration the browser can really encode at this size, or null.
export async function findH264Config({ width, height, fps, bitrate }, EncoderClass = globalThis.VideoEncoder) {
  if (!EncoderClass?.isConfigSupported) return null
  for (const codec of H264_CODECS) {
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
        avc: { format: 'avc' }, // length-prefixed NALUs, which is what MP4 stores
      }
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

const MAX_QUEUE = 4 // keep real-time latency bounded when the encoder falls behind

export class VideoCapture {
  constructor({
    canvas,
    width,
    height,
    fps,
    config,
    Muxer,
    ArrayBufferTarget,
    EncoderClass = globalThis.VideoEncoder,
    FrameClass = globalThis.VideoFrame,
  }) {
    this.canvas = canvas
    this.fps = fps
    this.FrameClass = FrameClass
    this.startedAt = null
    this.lastElapsed = -Infinity // ms since the first frame, of the last captured frame
    this.nextFrameNumber = 0
    this.lastTimestamp = -1 // µs
    this.captured = 0
    this.dropped = 0
    this.error = null
    this.stopped = false
    this.target = new ArrayBufferTarget()
    this.muxer = new Muxer({
      target: this.target,
      video: { codec: 'avc', width, height },
      fastStart: 'in-memory', // index at the front of the file → duration + scrubbing
      firstTimestampBehavior: 'offset',
    })
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

  // Call right after each rendered frame. Frame timestamps use a constant-rate
  // grid, avoiding visible cadence jitter from small render-loop timing changes.
  // If rendering misses a slot, the timestamp advances to the current slot, so
  // slow frames still hold their real place in the shot instead of speeding it up.
  onFrame(nowMs) {
    if (this.stopped || this.error) return false
    if (this.startedAt === null) this.startedAt = nowMs
    const elapsed = nowMs - this.startedAt
    const frameNumber = Math.floor((elapsed + 0.01) / (1000 / this.fps))
    if (frameNumber < this.nextFrameNumber) return false
    this.nextFrameNumber = frameNumber + 1
    if (this.encoder.encodeQueueSize >= MAX_QUEUE) {
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

  // Flush the encoder and write the finished MP4.
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
    return new Blob([this.target.buffer], { type: 'video/mp4' })
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
