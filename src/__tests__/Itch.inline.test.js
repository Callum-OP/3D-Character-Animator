import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// The itch.io package folds the JS + CSS into index.html. The .wasm files (USD and RAR readers) are
// fetched at runtime, so they must still be in the package afterwards, next to index.html (that is where the inlined script looks).
describe('itch.io packaging (scripts/inline-itch.mjs)', () => {
  it('inlines the script and stylesheet but keeps the WebAssembly files', () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'itch-'))
    fs.mkdirSync(path.join(dist, 'assets'))
    fs.writeFileSync(
      path.join(dist, 'index.html'),
      '<html><head><script type="module" crossorigin src="./assets/index-abc.js"></script><link rel="stylesheet" crossorigin href="./assets/index-abc.css"></head><body></body></html>',
    )
    fs.writeFileSync(path.join(dist, 'assets', 'index-abc.js'), 'console.log(1)')
    fs.writeFileSync(path.join(dist, 'assets', 'index-abc.css'), 'body{}')
    fs.writeFileSync(path.join(dist, 'assets', 'tinyusdz-x.wasm'), 'wasm')
    fs.writeFileSync(path.join(dist, 'assets', 'unrar-x.wasm'), 'wasm')

    execFileSync('node', [path.resolve('scripts/inline-itch.mjs'), dist])

    const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
    expect(html).toContain('console.log(1)')
    expect(html).not.toContain('src="./assets/index-abc.js"')
    expect(fs.existsSync(path.join(dist, 'assets'))).toBe(false)
    expect(fs.existsSync(path.join(dist, 'tinyusdz-x.wasm'))).toBe(true)
    expect(fs.existsSync(path.join(dist, 'unrar-x.wasm'))).toBe(true)
    expect(fs.existsSync(path.join(dist, 'index-abc.js'))).toBe(false)
    fs.rmSync(dist, { recursive: true, force: true })
  })
})
