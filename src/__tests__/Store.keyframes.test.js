import { describe, it, expect } from 'vitest'
import { useStore } from '../store.js'

describe('character pose keyframes', () => {
  it('stores local bone positions with rotations and retains an existing position when replacing a rotation key', () => {
    useStore.setState({
      animData: {
        tracks: {
          Hips: [{ time: 0.5, quat: [0, 0, 0, 1], pos: [1, 2, 3] }],
        },
        root: [],
        meshes: {},
        cameras: {},
        cuts: [],
        morphs: {},
        lights: {},
      },
    })

    useStore.getState().addKeyframesAtTime([{ name: 'Hips', quat: [0, 0.2, 0, 0.98], pos: [4, 5, 6] }], 1)
    useStore.getState().addKeyframesAtTime([{ name: 'Hips', quat: [0, 0, 0, 1] }], 0.5)

    expect(useStore.getState().animData.tracks.Hips).toEqual([
      { time: 0.5, quat: [0, 0, 0, 1], pos: [1, 2, 3] },
      { time: 1, quat: [0, 0.2, 0, 0.98], pos: [4, 5, 6] },
    ])
  })

  it('moves a position key and its keyed pose to the edited time', () => {
    useStore.setState({
      animData: {
        tracks: { Hips: [{ time: 0.5, quat: [0, 0, 0, 1] }] },
        root: [{ time: 0.5, pos: [1, 2, 3], quat: [0, 0, 0, 1] }],
        meshes: {},
        cameras: {},
        cuts: [],
        morphs: {},
        lights: {},
      },
    })

    useStore.getState().moveRootKeyframe(0.5, 1)

    expect(useStore.getState().animData.root).toEqual([
      { time: 1, pos: [1, 2, 3], quat: [0, 0, 0, 1] },
    ])
    expect(useStore.getState().animData.tracks.Hips).toEqual([
      { time: 1, quat: [0, 0, 0, 1] },
    ])
  })

  it('removes a moved key from its original position when that position is deleted', () => {
    useStore.setState({
      animData: {
        tracks: {},
        root: [
          { time: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1] },
          { time: 1, pos: [8, 0, 0], quat: [0, 0, 0, 1] },
        ],
        meshes: {},
        cameras: {},
        cuts: [],
        morphs: {},
        lights: {},
      },
    })

    useStore.getState().deleteRootKeyframe(1)

    expect(useStore.getState().animData.root).toEqual([
      { time: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1] },
    ])
  })
})

describe('deleting a position key', () => {
  it('also removes the pose keys saved with it, but leaves other times alone', () => {
    const Q = [0, 0, 0, 1]
    useStore.setState({
      animData: {
        tracks: {
          Hips: [{ time: 0, quat: Q }, { time: 1, quat: Q }, { time: 2, quat: Q }],
          Spine: [{ time: 2, quat: Q }],
        },
        root: [{ time: 0, pos: [0, 0, 0], quat: Q }, { time: 2, pos: [9, 0, 0], quat: Q }],
        meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {},
      },
    })
    useStore.getState().deleteRootKeyframe(2)
    const d = useStore.getState().animData
    expect(d.root.map((k) => k.time)).toEqual([0])
    expect(d.tracks.Hips.map((k) => k.time)).toEqual([0, 1])
    expect(d.tracks.Spine).toBeUndefined()
  })
})