import { describe, it, expect } from 'vitest'
import { createZip, crc32 } from '../three/zipStore.js'

describe('zipStore', () => {
  it('matches the standard CRC-32 check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('writes stored entries whose bytes and offsets can be read back', async () => {
    const zip = createZip()
    const files = { 'a_00001.png': 'first', 'a_00002.png': 'second!', 'é.png': '' }
    for (const [name, text] of Object.entries(files)) await zip.add(name, new Blob([text]))
    const bytes = Buffer.from(await zip.finish().arrayBuffer())

    const eocd = bytes.length - 22
    expect(bytes.readUInt16LE(eocd + 10)).toBe(3)
    let at = bytes.readUInt32LE(eocd + 16)
    const seen = []
    for (let i = 0; i < 3; i++) {
      expect(bytes.readUInt32LE(at)).toBe(0x02014b50)
      const crc = bytes.readUInt32LE(at + 16)
      const size = bytes.readUInt32LE(at + 20)
      const nameLen = bytes.readUInt16LE(at + 28)
      const local = bytes.readUInt32LE(at + 42)
      const name = bytes.subarray(at + 46, at + 46 + nameLen).toString()
      const dataStart = local + 30 + bytes.readUInt16LE(local + 26)
      const data = bytes.subarray(dataStart, dataStart + size)
      expect(crc32(data)).toBe(crc)
      seen.push([name, data.toString()])
      at += 46 + nameLen
    }
    expect(seen).toEqual(Object.entries(files))
  })
})
