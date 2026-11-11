import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { isOwnOrigin } = require('../../electron/origin.cjs')

describe('Electron trusted origins', () => {
  it('accepts the packaged app origin and paths', () => {
    expect(isOwnOrigin('app://app')).toBe(true)
    expect(isOwnOrigin('app://app/index.html?test=1')).toBe(true)
  })

  it('accepts only the configured development origin', () => {
    const devUrl = 'http://localhost:5173/'
    expect(isOwnOrigin('http://localhost:5173/index.html', devUrl)).toBe(true)
    expect(isOwnOrigin('http://localhost:5174/index.html', devUrl)).toBe(false)
    expect(isOwnOrigin('https://localhost:5173/', devUrl)).toBe(false)
  })

  it('rejects other or malformed origins, including other custom schemes', () => {
    for (const url of [
      'app://other/index.html',
      'app://app.evil/index.html',
      'app://app:123/index.html',
      'app://user@app/index.html',
      'file:///index.html',
      'https://example.com/',
      'not a url',
    ]) {
      expect(isOwnOrigin(url, 'http://localhost:5173/')).toBe(false)
      expect(isOwnOrigin(url, 'app://app')).toBe(false)
    }
  })
})
