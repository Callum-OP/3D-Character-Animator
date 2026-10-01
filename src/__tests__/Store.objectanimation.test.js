import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store.js'

describe('scene object animation keyframes', () => {
  beforeEach(() => {
    useStore.setState({ objectAnimData: {} })
  })

  it('stores transform keys in time order and replaces a key at the same time', () => {
    const { addObjectTransformKeyframe } = useStore.getState()
    addObjectTransformKeyframe('crate', 1, { position: [1, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] })
    addObjectTransformKeyframe('crate', 0, { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] })
    addObjectTransformKeyframe('crate', 1, { position: [2, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] })

    expect(useStore.getState().objectAnimData.crate.map((key) => key.time)).toEqual([0, 1])
    expect(useStore.getState().objectAnimData.crate[1].position).toEqual([2, 0, 0])
  })

  it('deletes individual keys and removes empty object tracks', () => {
    const store = useStore.getState()
    store.addObjectTransformKeyframe('crate', 0, { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] })
    store.addObjectTransformKeyframe('crate', 1, { position: [1, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] })
    store.deleteObjectTransformKeyframe('crate', 0)
    expect(useStore.getState().objectAnimData.crate).toHaveLength(1)
    useStore.getState().deleteObjectTransformKeyframe('crate', 1)
    expect(useStore.getState().objectAnimData).toEqual({})
  })
})