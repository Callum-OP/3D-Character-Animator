import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const script = path.resolve(__dirname, '../../electron/autorig/autorig.py')
const helper = path.resolve(__dirname, 'helpers/autorigLayers.py')
const py = spawnSync('python3', ['-c', 'import numpy'], { encoding: 'utf8' })
const hasPython = py.status === 0

describe('Auto Rigger layer blend and hand isolation (numpy only)', () => {
  it.skipIf(!hasPython)('blends stacked layers, keeps facing surfaces apart, and frees the hand of arm weight', () => {
    const r = spawnSync('python3', [helper, script], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.stdout.trim()).toBe('ok')
  })
})
