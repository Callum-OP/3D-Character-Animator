import { vi } from 'vitest'

// jsdom has no URL.createObjectURL and never decodes images, so a loader waiting on a
// texture would wait forever. These stand-ins record every blob URL handed out (so a
// test can look at the bytes a texture would have been loaded from) and make every
// <img> "load" a tick after its src is set.
export function installImageStubs() {
  const blobs = new Map()
  let n = 0
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:test/${++n}`
    blobs.set(url, blob)
    return url
  })
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  // Loaders fetch() buffers (glTF .bin) from blob URLs; a browser does that natively.
  const realFetch = globalThis.fetch
  const fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    const blob = blobs.get(url)
    if (blob) return new Response(await blob.arrayBuffer(), { status: 200 })
    return realFetch(input, init)
  })
  const proto = HTMLImageElement.prototype
  const original = Object.getOwnPropertyDescriptor(proto, 'src')
  Object.defineProperty(proto, 'src', {
    configurable: true,
    get() {
      return this._src
    },
    set(v) {
      this._src = v
      setTimeout(() => this.dispatchEvent(new Event('load')), 0)
    },
  })
  return {
    blobs,
    revoke,
    async bytesOf(url) {
      const b = blobs.get(url)
      return b ? new Uint8Array(await b.arrayBuffer()) : null
    },
    restore() {
      create.mockRestore()
      revoke.mockRestore()
      fetchStub.mockRestore()
      if (original) Object.defineProperty(proto, 'src', original)
      else delete proto.src
    },
  }
}
