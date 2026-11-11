'use strict'
const fsp = require('node:fs/promises')

// Write a file so that an interrupted or failed write can never damage what was already there.
//
// The old way (fs.writeFile straight onto the file) empties the file first and then streams the new
// contents in, so anything that stops it part-way - the app closing, a crash, a cloud-drive client
// grabbing the file, a full disk - leaves a half-written project AND has already thrown away the
// previous good copy. Here the contents go to a temporary file next to the target, are flushed to disk and
// checked to be the right size, and only then replace the target in one step. If anything goes wrong the
// temporary file is removed and the original is exactly as it was.
async function writeFileSafely(filePath, contents) {
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf-8')
  const temp = `${filePath}.${process.pid}-${Date.now()}.tmp`
  let handle = null
  try {
    handle = await fsp.open(temp, 'w')
    await handle.writeFile(data)
    await handle.sync() // on the disk, not just in the operating system's cache
    await handle.close()
    handle = null
    await assertSize(temp, data.length)
    await replaceFile(temp, filePath, data.length)
  } catch (err) {
    if (handle) await handle.close().catch(() => {})
    await fsp.rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

async function assertSize(filePath, expected) {
  const { size } = await fsp.stat(filePath)
  if (size !== expected) {
    throw new Error(`The file was not written completely (${size} of ${expected} bytes), so the previous version was kept.`)
  }
}

// Put `temp` in place of `target`. A rename is atomic. Some folders (a cloud-drive client holding the file open)
// refuse it for a moment, so retry a few times, then fall back to copying over the target and checking the result.
async function replaceFile(temp, target, expectedSize) {
  let lastError = null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fsp.rename(temp, target)
      return
    } catch (err) {
      lastError = err
      if (!['EPERM', 'EBUSY', 'EACCES', 'EXDEV'].includes(err && err.code)) throw err
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
    }
  }
  try {
    await fsp.copyFile(temp, target)
    await assertSize(target, expectedSize)
    await fsp.rm(temp, { force: true })
  } catch (err) {
    throw lastError || err
  }
}

module.exports = { writeFileSafely }
