import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Regression guard for the exact bug class that caused the Brightness slider
// to appear "stuck": store.js is one big object literal passed to zustand's
// create(). JavaScript object literals silently let a later key of the same
// name overwrite an earlier one — there's no error, no warning, the first
// definition just quietly stops existing. That's what happened with
// `setLightIntensity` being defined once for the key light and again for
// per-scene-light intensity.
//
// This test parses store.js as source text (not by importing it, since a
// duplicate key can't be detected once JS has already collapsed it to one)
// and fails if any top-level `set` key appears more than once.
describe('store.js has no duplicate top-level keys', () => {
  it('every property/method name in the store object is unique', () => {
    const src = fs.readFileSync(path.join(__dirname, '../store.js'), 'utf8')

    // Grab the create((set) => ({ ... })) body. This is intentionally a
    // simple brace-matching scan rather than a full parser — good enough for
    // a flat-ish store object, and dependency-free.
    const startMarker = 'create((set) => ({'
    const start = src.indexOf(startMarker)
    expect(start, 'could not find the zustand create(...) call — did store.js change shape?').toBeGreaterThan(-1)
    const bodyStart = start + startMarker.length

    let depth = 1
    let i = bodyStart
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
    }
    const body = src.slice(bodyStart, i - 1)

    // Match top-level `name:` or `name (` at the start of a line (allowing
    // leading whitespace) — this only catches keys at brace-depth 0 within
    // the extracted body, which is what we want (nested object values like
    // sceneLights entries aren't store keys).
    const keyRe = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/gm
    const seen = new Map()
    const dupes = []
    let m
    let localDepth = 0
    let lastIndex = 0
    // Walk char by char tracking depth so we only count matches at depth 0.
    const lines = body.split('\n')
    let runningDepth = 0
    for (const line of lines) {
      const opens = (line.match(/[{(\[]/g) || []).length
      const closes = (line.match(/[})\]]/g) || []).length
      const match = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(line)
      if (match && runningDepth === 0) {
        const name = match[1]
        seen.set(name, (seen.get(name) || 0) + 1)
      }
      runningDepth += opens - closes
    }

    for (const [name, count] of seen) {
      if (count > 1) dupes.push(`${name} (${count}x)`)
    }

    expect(dupes, `duplicate store keys silently shadow each other: ${dupes.join(', ')}`).toEqual([])
  })
})