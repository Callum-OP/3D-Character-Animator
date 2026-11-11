'use strict'

function isOwnOrigin(url, devUrl = '') {
  try {
    const parsed = new URL(url)
    // Node's URL.origin is "null" for custom schemes, even when Electron treats them as standard.
    if (parsed.protocol === 'app:' && parsed.host === 'app' && !parsed.username && !parsed.password) return true
    return !!devUrl && parsed.origin !== 'null' && parsed.origin === new URL(devUrl).origin
  } catch {
    return false
  }
}

module.exports = { isOwnOrigin }
