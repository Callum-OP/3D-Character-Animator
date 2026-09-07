import { describe, it, expect } from 'vitest'
import { getImportDecimationPlan } from '../three/loadModel.js'

describe('import decimation thresholds', () => {
  it('leaves ordinary meshes alone below the first threshold', () => {
    expect(getImportDecimationPlan(149_999)).toBeNull()
  })

  it('uses staged reductions at the configured vertex counts', () => {
    expect(getImportDecimationPlan(150_000)).toMatchObject({ level: 1, reduction: 0.2 })
    expect(getImportDecimationPlan(500_000)).toMatchObject({ level: 2, reduction: 0.4 })
    expect(getImportDecimationPlan(1_000_000)).toMatchObject({ level: 3, reduction: 0.6 })
  })

  it('keeps the highest stage for larger meshes', () => {
    expect(getImportDecimationPlan(2_000_000).level).toBe(3)
  })
})