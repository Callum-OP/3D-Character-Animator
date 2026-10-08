import { beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { computeOutputSize, videoBitrate, pickVideoFormat, MAX_VIDEO_SIDE } from '../three/exportSize.js'
import { initCameras, addCamera, getCameraById } from '../three/cameras.js'
import {
  setViewCameraById,
  __setViewCameraRefsForTest,
  __setRendererForTest,
  __applyOutputSizeForTest,
} from '../three/scene.js'

describe('computeOutputSize', () => {
  const vp = { viewportW: 1000, viewportH: 600 }

  it('presets are named by the short side', () => {
    expect(computeOutputSize({ resolution: '1080p', aspect: '16:9', ...vp })).toMatchObject({ width: 1920, height: 1080, clamped: false })
    expect(computeOutputSize({ resolution: '1080p', aspect: '9:16', ...vp })).toMatchObject({ width: 1080, height: 1920 })
    expect(computeOutputSize({ resolution: '4k', aspect: '16:9', ...vp })).toMatchObject({ width: 3840, height: 2160 })
    expect(computeOutputSize({ resolution: '720p', aspect: '1:1', ...vp })).toMatchObject({ width: 720, height: 720 })
  })

  it("'viewport' aspect keeps the viewport's shape", () => {
    const r = computeOutputSize({ resolution: '1080p', aspect: 'viewport', viewportW: 1200, viewportH: 600 })
    expect(r.height).toBe(1080)
    expect(r.width).toBe(2160)
    const portrait = computeOutputSize({ resolution: '1080p', aspect: 'viewport', viewportW: 600, viewportH: 1200 })
    expect(portrait).toMatchObject({ width: 1080, height: 2160 })
  })

  it("'viewport' resolution uses the viewport size, optionally reshaped", () => {
    expect(computeOutputSize({ resolution: 'viewport', ...vp, evenSizes: false })).toMatchObject({ width: 1000, height: 600 })
    const r = computeOutputSize({ resolution: 'viewport', aspect: '1:1', ...vp })
    expect(r.width).toBe(r.height)
  })

  it('scales down to the GPU limit while keeping the shape, and says so', () => {
    const r = computeOutputSize({ resolution: '8k', aspect: '16:9', ...vp, maxSide: 4096 })
    expect(r.clamped).toBe(true)
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(4096)
    expect(r.width / r.height).toBeCloseTo(16 / 9, 1)
    expect(r.requested).toEqual({ width: 7680, height: 4320 })
  })

  it('video sizes are always even; image sizes can be odd', () => {
    const v = computeOutputSize({ resolution: 'viewport', viewportW: 1001, viewportH: 601 })
    expect(v.width % 2).toBe(0)
    expect(v.height % 2).toBe(0)
    const i = computeOutputSize({ resolution: 'viewport', viewportW: 1001, viewportH: 601, evenSizes: false })
    expect(i).toMatchObject({ width: 1001, height: 601 })
    expect(MAX_VIDEO_SIDE).toBeGreaterThanOrEqual(3840)
  })

  it('survives a zero-sized viewport', () => {
    const r = computeOutputSize({ resolution: 'viewport', viewportW: 0, viewportH: 0 })
    expect(r.width).toBeGreaterThanOrEqual(2)
    expect(r.height).toBeGreaterThanOrEqual(2)
  })
})

describe('videoBitrate', () => {
  it('goes up with quality, resolution and frame rate', () => {
    const base = { width: 1920, height: 1080, fps: 30 }
    const std = videoBitrate({ ...base, quality: 'standard' })
    const high = videoBitrate({ ...base, quality: 'high' })
    const max = videoBitrate({ ...base, quality: 'max' })
    expect(std).toBeLessThan(high)
    expect(high).toBeLessThan(max)
    expect(high).toBeGreaterThan(8e6) // 1080p30 'high' is ~10 Mbps, far above the browser default
    expect(videoBitrate({ ...base, fps: 60, quality: 'high' })).toBeGreaterThan(high)
    expect(videoBitrate({ width: 3840, height: 2160, fps: 30, quality: 'high' })).toBeGreaterThan(high)
  })

  it('is clamped to a sane range', () => {
    expect(videoBitrate({ width: 64, height: 64, fps: 24, quality: 'standard' })).toBe(1_000_000)
    expect(videoBitrate({ width: 7680, height: 4320, fps: 60, quality: 'max' })).toBe(120_000_000)
    expect(videoBitrate({ width: 1280, height: 720, fps: 30, quality: 'nonsense' })).toBeGreaterThan(0)
  })
})

describe('pickVideoFormat', () => {
  it('uses mp4 when supported', () => {
    const r = pickVideoFormat('mp4', (t) => t.startsWith('video/mp4'))
    expect(r).toMatchObject({ ext: 'mp4', blobType: 'video/mp4', fellBack: false })
  })

  it('falls back to webm (and reports it) when mp4 is unsupported', () => {
    const r = pickVideoFormat('mp4', (t) => t === 'video/webm;codecs=vp8')
    expect(r).toMatchObject({ ext: 'webm', mimeType: 'video/webm;codecs=vp8', fellBack: true })
  })

  it('prefers vp9 for webm and is not a fallback when webm was requested', () => {
    const r = pickVideoFormat('webm', () => true)
    expect(r).toMatchObject({ ext: 'webm', mimeType: 'video/webm;codecs=vp9', fellBack: false })
  })

  it('returns an empty mime (browser default) when nothing is supported or the check throws', () => {
    expect(pickVideoFormat('webm', () => false).mimeType).toBe('')
    expect(pickVideoFormat('mp4', () => { throw new Error('x') })).toMatchObject({ ext: 'webm', mimeType: '' })
  })
})

describe('rendering at a fixed export size', () => {
  let canvas
  let renderer
  let free
  let cams

  beforeAll(() => {
    canvas = document.createElement('canvas')
    renderer = {
      domElement: canvas,
      ratio: 1.5,
      setPixelRatio(r) { this.ratio = r },
      setSize(w, h, updateStyle = true) {
        canvas.width = Math.floor(w * this.ratio)
        canvas.height = Math.floor(h * this.ratio)
        if (updateStyle) {
          canvas.style.width = `${w}px`
          canvas.style.height = `${h}px`
        }
      },
    }
    free = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
    initCameras({
      scene: new THREE.Scene(),
      camera: free,
      renderer: { domElement: canvas },
      controls: { enabled: true, locked: false, target: new THREE.Vector3() },
      requestRender: () => {},
    })
    const container = { clientWidth: 800, clientHeight: 500 }
    __setViewCameraRefsForTest(free, { enabled: true, locked: false })
    __setRendererForTest(renderer, container)
    cams = [addCamera(50, { recordUndo: false }).id]
  })

  it('draws at exactly the requested pixels (no device-ratio scaling) and restores afterwards', () => {
    const restore = __applyOutputSizeForTest(3840, 2160)
    expect(canvas.width).toBe(3840)
    expect(canvas.height).toBe(2160)
    expect(canvas.style.objectFit).toBe('contain') // letterboxed on screen, never stretched
    expect(free.aspect).toBeCloseTo(16 / 9, 5)

    restore()
    expect(canvas.style.objectFit).toBe('')
    expect(free.aspect).toBeCloseTo(800 / 500, 5)
    expect(canvas.width).toBe(Math.floor(800 * renderer.ratio))
  })

  it('a camera switched to mid-shot (cuts) gets the export aspect, not the viewport aspect', () => {
    const restore = __applyOutputSizeForTest(1080, 1920)
    setViewCameraById(cams[0])
    expect(getCameraById(cams[0]).aspect).toBeCloseTo(1080 / 1920, 5)
    restore()
    setViewCameraById(null)
  })

  it('persists the export settings as app preferences', () => {
    const s = useStore.getState()
    expect(['viewport', '720p', '1080p', '1440p', '4k']).toContain(s.exportVideoResolution)
    expect(s.exportVideoFps).toBe(30)
    expect(s.exportVideoFormat).toBe('mp4')
    useStore.getState().setExportVideoFps(60)
    expect(JSON.parse(localStorage.getItem('3d-animator-app-settings')).exportVideoFps).toBe(60)
    useStore.getState().setExportVideoFps(30)
  })
})