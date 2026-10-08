import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store.js'
import { startKeyframeHistory } from '../three/keyframeHistory.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'
import { applyKeyClick, isTimeSelected, pruneSelection, timesToDelete } from '../panels/keySelection.js'

const times = [0, 0.5, 1, 1.5, 2]
const click = (state, time, mods = {}) => {
  const r = applyKeyClick({ selection: state.selection, anchor: state.anchor, times, time, shift: false, toggle: false, ...mods })
  return { selection: r.selection, anchor: r.anchor, handled: r.handled }
}

describe('key selection helpers', () => {
  it('plain click clears the selection and is not a selection gesture', () => {
    const r = click({ selection: [0.5, 1], anchor: 0.5 }, 2)
    expect(r.selection).toEqual([])
    expect(r.handled).toBe(false)
    expect(r.anchor).toBe(2)
  })

  it('ctrl/cmd-click toggles single rows', () => {
    let st = click({ selection: [], anchor: null }, 0.5, { toggle: true })
    st = click(st, 1.5, { toggle: true })
    expect(st.selection).toEqual([0.5, 1.5])
    expect(st.handled).toBe(true)
    st = click(st, 0.5, { toggle: true })
    expect(st.selection).toEqual([1.5])
  })

  it('shift-click selects the range from the anchor, in either direction', () => {
    let st = click({ selection: [], anchor: null }, 0.5) // plain click sets the anchor
    st = click(st, 1.5, { shift: true })
    expect(st.selection).toEqual([0.5, 1, 1.5])
    st = click(st, 0, { shift: true })
    expect(st.selection).toEqual([0, 0.5])
  })

  it('shift with no anchor selects just that row; ctrl+shift extends an existing selection', () => {
    expect(click({ selection: [], anchor: null }, 1, { shift: true }).selection).toEqual([1])
    const st = click({ selection: [0], anchor: 1 }, 2, { shift: true, toggle: true })
    expect(st.selection.sort()).toEqual([0, 1, 1.5, 2])
  })

  it('tolerates float noise when matching times', () => {
    expect(isTimeSelected([0.1 + 0.2], 0.3)).toBe(true)
    expect(pruneSelection([0.5, 9], [0.5, 1])).toEqual([0.5])
  })

  it('x on a selected row deletes the whole selection, on an unselected row only that row', () => {
    expect(timesToDelete([0.5, 1], 1)).toEqual([0.5, 1])
    expect(timesToDelete([0.5, 1], 2)).toEqual([2])
    expect(timesToDelete([], 2)).toEqual([2])
  })
})

describe('batch keyframe deletion (store)', () => {
  beforeEach(() => {
    clearUndoHistory()
    startKeyframeHistory()
    useStore.setState({
      animData: {
        root: times.map((t) => ({ time: t, pos: [t, 0, 0], quat: [0, 0, 0, 1] })),
        tracks: {
          Hips: times.map((t) => ({ time: t, quat: [0, 0, 0, 1] })),
          Spine: [{ time: 0.5, quat: [0, 0, 0, 1] }, { time: 1, quat: [0, 0, 0, 1] }],
        },
        cameras: { 'Camera 1': times.map((t) => ({ time: t, pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] })) },
        lights: { 'Light 1': times.map((t) => ({ time: t, pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] })) },
      },
      objectAnimData: { crate: times.map((t) => ({ time: t, position: [t, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] })) },
    })
  })

  const rootTimes = () => useStore.getState().animData.root.map((k) => k.time)

  it('removes every selected position key AND the pose keys saved with them', () => {
    useStore.getState().deleteRootKeyframes([0.5, 1.5])
    const { animData } = useStore.getState()
    expect(rootTimes()).toEqual([0, 1, 2])
    expect(animData.tracks.Hips.map((k) => k.time)).toEqual([0, 1, 2])
    expect(animData.tracks.Spine.map((k) => k.time)).toEqual([1])
  })

  it('drops a track entirely when its last key goes, and handles deleting everything', () => {
    useStore.getState().deleteRootKeyframes([0.5, 1])
    expect(useStore.getState().animData.tracks.Spine).toBeUndefined()
    useStore.getState().deleteRootKeyframes(times)
    expect(rootTimes()).toEqual([])
    expect(useStore.getState().animData.tracks).toEqual({})
  })

  it('ignores times that have no key', () => {
    useStore.getState().deleteRootKeyframes([0.77])
    expect(rootTimes()).toEqual(times)
  })

  it('is a single undo step that restores the whole selection (and redo reapplies it)', () => {
    const ctx = () => ({ selectedObjectId: null, mode: 'bone' })
    useStore.getState().deleteRootKeyframes([0, 1, 2])
    expect(rootTimes()).toEqual([0.5, 1.5])
    performUndo(ctx())
    expect(rootTimes()).toEqual(times)
    expect(useStore.getState().animData.tracks.Hips).toHaveLength(5)
    performRedo(ctx())
    expect(rootTimes()).toEqual([0.5, 1.5])
  })

  it('batch-deletes object, camera and light keys too', () => {
    const s = useStore.getState()
    s.deleteObjectTransformKeyframes('crate', [0, 2])
    s.deleteCameraKeyframes('Camera 1', [0.5, 1])
    s.deleteLightKeyframes('Light 1', [1.5])
    const after = useStore.getState()
    expect(after.objectAnimData.crate.map((k) => k.time)).toEqual([0.5, 1, 1.5])
    expect(after.animData.cameras['Camera 1'].map((k) => k.time)).toEqual([0, 1.5, 2])
    expect(after.animData.lights['Light 1'].map((k) => k.time)).toEqual([0, 0.5, 1, 2])
    s.deleteObjectTransformKeyframes('crate', [0.5, 1, 1.5])
    s.deleteCameraKeyframes('Camera 1', [0, 1.5, 2])
    expect(useStore.getState().objectAnimData.crate).toBeUndefined()
    expect(useStore.getState().animData.cameras['Camera 1']).toBeUndefined()
  })
})