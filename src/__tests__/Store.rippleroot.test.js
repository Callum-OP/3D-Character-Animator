import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from '../store.js'

// addRootKeyframe's "ripple" mode: editing a character root-motion keyframe
// should optionally carry the same position delta onto every LATER keyframe,
// so nudging where a walk clip is at frame 20 doesn't leave the rest of the
// steps behind.
describe('addRootKeyframe ripple editing', () => {
  beforeEach(() => {
    useStore.setState({ animData: { tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [] } })
  })

  it('without ripple, only the edited keyframe changes', () => {
    const { addRootKeyframe } = useStore.getState()
    addRootKeyframe(0, [0, 0, 0], [0, 0, 0, 1])
    addRootKeyframe(1, [1, 0, 0], [0, 0, 0, 1])
    addRootKeyframe(2, [2, 0, 0], [0, 0, 0, 1])

    // Re-save frame 1 further along, WITHOUT ripple.
    addRootKeyframe(1, [1.5, 0, 0], [0, 0, 0, 1], false)

    const root = useStore.getState().animData.root
    expect(root.find((k) => k.time === 1).pos).toEqual([1.5, 0, 0])
    expect(root.find((k) => k.time === 2).pos).toEqual([2, 0, 0]) // untouched
  })

  it('with ripple, every later keyframe shifts by the same delta', () => {
    const { addRootKeyframe } = useStore.getState()
    addRootKeyframe(0, [0, 0, 0], [0, 0, 0, 1])
    addRootKeyframe(1, [1, 0, 0], [0, 0, 0, 1])
    addRootKeyframe(2, [2, 0, 0], [0, 0, 0, 1])

    // Move frame 1 half a unit further forward, WITH ripple.
    addRootKeyframe(1, [1.5, 0, 0], [0, 0, 0, 1], true)

    const root = useStore.getState().animData.root
    expect(root.find((k) => k.time === 0).pos).toEqual([0, 0, 0]) // before the edit: untouched
    expect(root.find((k) => k.time === 1).pos).toEqual([1.5, 0, 0])
    expect(root.find((k) => k.time === 2).pos).toEqual([2.5, 0, 0]) // carried forward by +0.5
  })

  it('ripple with no prior keyframes at that time is a no-op shift', () => {
    const { addRootKeyframe } = useStore.getState()
    addRootKeyframe(0, [0, 0, 0], [0, 0, 0, 1])
    addRootKeyframe(2, [2, 0, 0], [0, 0, 0, 1])

    // No keyframe exists at t=1 yet, so ripple has nothing to diff against —
    // interpolated "before" position is the midpoint (1,0,0), same as the
    // new value, so the delta is zero and later keys are untouched.
    addRootKeyframe(1, [1, 0, 0], [0, 0, 0, 1], true)

    const root = useStore.getState().animData.root
    expect(root.find((k) => k.time === 2).pos).toEqual([2, 0, 0])
  })
})