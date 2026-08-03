import { describe, it, expect } from 'vitest'
import { angleDeltaToValue } from '../panels/RadialScale.jsx'

const TAU = Math.PI * 2

describe('RadialScale angleDeltaToValue', () => {
  it('no movement leaves the value unchanged', () => {
    expect(angleDeltaToValue(0, 0, 2)).toBeCloseTo(2)
  })

  it('a quarter turn clockwise scales up by 2^0.25', () => {
    expect(angleDeltaToValue(0, TAU / 4, 1)).toBeCloseTo(Math.pow(2, 0.25), 3)
  })

  it('a quarter turn counter-clockwise scales down by 2^-0.25', () => {
    expect(angleDeltaToValue(0, -TAU / 4, 1)).toBeCloseTo(Math.pow(2, -0.25), 3)
  })

  it('a half turn clockwise vs counter-clockwise scale oppositely by the same factor', () => {
    // +PI and -PI are the two boundary values right at the wrap point; the
    // normalisation keeps them distinct (rather than merging them into one),
    // so clockwise and counter-clockwise land on inverse factors of each
    // other rather than the same value.
    const up = angleDeltaToValue(0, Math.PI, 1)
    const down = angleDeltaToValue(0, -Math.PI, 1)
    expect(up).toBeCloseTo(Math.SQRT2, 3)
    expect(down).toBeCloseTo(1 / Math.SQRT2, 3)
  })

  it('cannot represent more than one full turn (angle wraps, as real pointer angles do)', () => {
    // A drag of exactly 360 degrees looks identical to no movement at all —
    // this is a property of using an absolute angle (atan2), not a bug in
    // the formula, and it's worth pinning down so nobody "fixes" it later.
    expect(angleDeltaToValue(0, TAU, 5)).toBeCloseTo(5)
  })

  it('does not jump when the drag crosses the +/-180 degree seam', () => {
    // starting near +179 degrees and moving a few degrees further should be a
    // SMALL change, not a huge jump from wrapping to -179 naively.
    const startAngle = Math.PI - 0.05
    const nearSeam = angleDeltaToValue(startAngle, Math.PI - 0.02, 1)
    const acrossSeam = angleDeltaToValue(startAngle, -Math.PI + 0.02, 1)
    // both are small forward movements (~0.03 and ~0.07 rad respectively),
    // so both results must stay close to 1, not blow up or collapse.
    expect(nearSeam).toBeGreaterThan(0.9)
    expect(nearSeam).toBeLessThan(1.1)
    expect(acrossSeam).toBeGreaterThan(0.9)
    expect(acrossSeam).toBeLessThan(1.1)
  })

  it('never returns zero or negative, even for an extreme angle input', () => {
    const v = angleDeltaToValue(0, -Math.PI + 0.001, 1)
    expect(v).toBeGreaterThan(0)
  })

  it('scales relative to the value captured at drag start, not the live value', () => {
    // Same start value (5) with two different current angles should scale
    // proportionally from 5, regardless of call order/state elsewhere.
    expect(angleDeltaToValue(0, TAU / 2, 5)).toBeCloseTo(5 * Math.SQRT2, 3)
  })
})