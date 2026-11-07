// Minimal ZIP writer (no compression — PNG frames are already compressed).
// Entries are added one at a time and only their bytes' CRC is computed up front; the
// image data itself stays in the Blob, so a long frame sequence doesn't need to be
// held as one big array. Names are UTF-8. Plain (non-zip64) zips: up to 65,535 files
// and 4 GB, which finish() checks.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const day = (Math.max(1980, date.getFullYear()) - 1980) << 9 | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

export function createZip() {
  const entries = []
  const encoder = new TextEncoder()
  const stamp = dosDateTime(new Date())

  return {
    // blob: the file's bytes (a Blob). Returns the zip so far's entry count.
    async add(name, blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      entries.push({ name: encoder.encode(name), size: bytes.length, crc: crc32(bytes), blob })
      return entries.length
    },

    finish() {
      if (entries.length > 0xffff) throw new Error('Too many images for one zip file.')
      const parts = []
      const central = []
      let offset = 0
      for (const e of entries) {
        const local = new DataView(new ArrayBuffer(30))
        local.setUint32(0, 0x04034b50, true)
        local.setUint16(4, 20, true) // version needed
        local.setUint16(6, 0x0800, true) // UTF-8 names
        local.setUint16(8, 0, true) // stored
        local.setUint16(10, stamp.time, true)
        local.setUint16(12, stamp.day, true)
        local.setUint32(14, e.crc, true)
        local.setUint32(18, e.size, true)
        local.setUint32(22, e.size, true)
        local.setUint16(26, e.name.length, true)
        local.setUint16(28, 0, true)
        parts.push(local.buffer, e.name, e.blob)

        const dir = new DataView(new ArrayBuffer(46))
        dir.setUint32(0, 0x02014b50, true)
        dir.setUint16(4, 20, true) // version made by
        dir.setUint16(6, 20, true)
        dir.setUint16(8, 0x0800, true)
        dir.setUint16(10, 0, true)
        dir.setUint16(12, stamp.time, true)
        dir.setUint16(14, stamp.day, true)
        dir.setUint32(16, e.crc, true)
        dir.setUint32(20, e.size, true)
        dir.setUint32(24, e.size, true)
        dir.setUint16(28, e.name.length, true)
        dir.setUint32(42, offset, true)
        central.push(dir.buffer, e.name)

        offset += 30 + e.name.length + e.size
      }
      const centralSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0)
      if (offset + centralSize > 0xfffffff0) throw new Error('The images add up to more than 4 GB — lower the resolution or frame rate.')

      const end = new DataView(new ArrayBuffer(22))
      end.setUint32(0, 0x06054b50, true)
      end.setUint16(8, entries.length, true)
      end.setUint16(10, entries.length, true)
      end.setUint32(12, centralSize, true)
      end.setUint32(16, offset, true)
      return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' })
    },
  }
}
