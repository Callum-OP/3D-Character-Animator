import { describe, it, expect } from 'vitest'
import { createShadowRefresh, canReuseShadows, cullSignature } from '../three/shadowReuse.js'

describe('shadow maps are reused only on camera-only frames', () => {
  it('the first draw always draws the shadows', () => {
    const r = createShadowRefresh()
    expect(r.take()).toBe(true)
  })
  it('a camera move alone does not mark anything changed; any other request does', () => {
    const r = createShadowRefresh()
    r.take() // first draw
    expect(r.take()).toBe(false) // nothing else asked: camera-only
    r.markChanged()
    expect(r.take()).toBe(true)
    expect(r.take()).toBe(false) // cleared for the next one
  })
  it('an ordinary request in the same frame as a camera move wins', () => {
    const r = createShadowRefresh()
    r.take()
    r.markChanged() // e.g. a light was edited while the user was orbiting
    expect(r.take()).toBe(true)
  })
  it('reuses only when camera-only, not playing, and the same roots reach the shadow pass', () => {
    const base = { cameraOnly: true, continuous: false, signatureBefore: 5, signatureAfter: 5 }
    expect(canReuseShadows(base)).toBe(true)
    expect(canReuseShadows({ ...base, cameraOnly: false })).toBe(false)
    expect(canReuseShadows({ ...base, continuous: true })).toBe(false)
    expect(canReuseShadows({ ...base, signatureAfter: 6 })).toBe(false)
  })
  it('the fingerprint changes when a different set of roots is hidden', () => {
    const a = { id: 3 }, b = { id: 4 }
    expect(cullSignature([])).toBe(0)
    expect(cullSignature([a])).not.toBe(cullSignature([b]))
    expect(cullSignature([a, b])).not.toBe(cullSignature([a]))
    expect(cullSignature([a, b])).toBe(cullSignature([a, b]))
  })
})
