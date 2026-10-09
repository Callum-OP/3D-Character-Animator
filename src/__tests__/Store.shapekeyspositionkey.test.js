import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store.js'

const st = () => useStore.getState()
const morphs = () => st().animData.morphs

describe('Position keys carry the character\'s shape-key layout', () => {
  beforeEach(() => {
    st().setAnimData({ tracks: {}, root: [], meshes: {}, cameras: {}, cuts: [], morphs: {}, lights: {} })
  })

  it('addShapeKeysAtTime keys several meshes in one go', () => {
    st().addShapeKeysAtTime(
      [
        { meshIndex: 0, list: [{ morphName: 'Smile', value: 1 }, { morphName: 'Blink', value: 0 }] },
        { meshIndex: 2, list: [{ morphName: 'Smile', value: 0.5 }] },
      ],
      1,
    )
    expect(morphs()[0].Smile).toEqual([{ time: 1, value: 1 }])
    expect(morphs()[0].Blink).toEqual([{ time: 1, value: 0 }])
    expect(morphs()[2].Smile).toEqual([{ time: 1, value: 0.5 }])
  })

  it('re-keying the same time replaces the value, and keys stay sorted', () => {
    st().addShapeKeysAtTime([{ meshIndex: 0, list: [{ morphName: 'Smile', value: 1 }] }], 2)
    st().addShapeKeysAtTime([{ meshIndex: 0, list: [{ morphName: 'Smile', value: 0 }] }], 0)
    st().addShapeKeysAtTime([{ meshIndex: 0, list: [{ morphName: 'Smile', value: 0.25 }] }], 2)
    expect(morphs()[0].Smile).toEqual([
      { time: 0, value: 0 },
      { time: 2, value: 0.25 },
    ])
  })

  it('an empty layout changes nothing', () => {
    const before = st().animData
    st().addShapeKeysAtTime([], 1)
    expect(st().animData).toBe(before)
  })

  it('deleting a position key removes the shape keys saved with it, and only those', () => {
    st().addShapeKeysAtTime([{ meshIndex: 0, list: [{ morphName: 'Smile', value: 1 }] }], 1)
    st().addShapeKeysAtTime([{ meshIndex: 0, list: [{ morphName: 'Smile', value: 0 }] }], 2)
    st().addRootKeyframe(1, [0, 0, 0], [0, 0, 0, 1])
    st().deleteRootKeyframe(1)
    expect(morphs()[0].Smile).toEqual([{ time: 2, value: 0 }])
  })

  it('deleting the last shape key at a time drops the empty track', () => {
    st().addShapeKeysAtTime([{ meshIndex: 3, list: [{ morphName: 'Smile', value: 1 }] }], 1)
    st().addRootKeyframe(1, [0, 0, 0], [0, 0, 0, 1])
    st().deleteRootKeyframe(1)
    expect(morphs()[3]).toBeUndefined()
  })

  it('multi-delete removes shape keys at every selected time', () => {
    for (const t of [0.5, 1, 1.5]) {
      st().addShapeKeysAtTime([{ meshIndex: 0, list: [{ morphName: 'Smile', value: t }] }], t)
      st().addRootKeyframe(t, [0, 0, 0], [0, 0, 0, 1])
    }
    st().deleteRootKeyframes([0.5, 1.5])
    expect(morphs()[0].Smile).toEqual([{ time: 1, value: 1 }])
  })

  it('moving a position key moves its shape keys too', () => {
    st().addShapeKeysAtTime([{ meshIndex: 0, list: [{ morphName: 'Smile', value: 1 }] }], 1)
    st().addShapeKeysAtTime([{ meshIndex: 0, list: [{ morphName: 'Smile', value: 0 }] }], 3)
    st().addRootKeyframe(1, [0, 0, 0], [0, 0, 0, 1])
    st().moveRootKeyframe(1, 2)
    expect(morphs()[0].Smile).toEqual([
      { time: 2, value: 1 },
      { time: 3, value: 0 },
    ])
  })
})