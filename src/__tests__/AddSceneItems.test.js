import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  addLight: vi.fn(() => ({ id: 7, name: 'Light 1' })),
  selectLight: vi.fn(),
  addCamera: vi.fn(() => ({ id: 9, name: 'Camera 1', fov: 50 })),
}))
vi.mock('../three/lights.js', () => ({ addLight: m.addLight, selectLight: m.selectLight }))
vi.mock('../three/cameras.js', () => ({ addCamera: m.addCamera }))

import { addLightAndSelect, addCameraAndSelect } from '../three/addSceneItems.js'
import { useStore } from '../store.js'

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockClear())
  useStore.setState({ sceneLights: [], sceneCameras: [], selectedLightId: null, selectedCameraId: null, selectedObjectId: 3, selectedObjectIds: [3], mode: 'bone' })
})

describe('Edit menu: Add Light / Add Camera', () => {
  it('adds a light, registers it, selects it (store + gizmo) and switches to Object mode', () => {
    addLightAndSelect()
    const s = useStore.getState()
    expect(s.sceneLights.map((l) => l.id)).toEqual([7])
    expect(s.selectedLightId).toBe(7)
    expect(m.selectLight).toHaveBeenCalledWith(7)
    expect(s.mode).toBe('object')
    expect(s.selectedObjectId).toBeNull() // selecting a light drops the object selection
  })

  it('adds a camera, registers it, selects it and switches to Object mode', () => {
    addCameraAndSelect()
    const s = useStore.getState()
    expect(s.sceneCameras.map((c) => c.id)).toEqual([9])
    expect(s.selectedCameraId).toBe(9)
    expect(s.mode).toBe('object')
    expect(s.selectedObjectId).toBeNull()
  })

  it('each press adds another one', () => {
    m.addLight.mockReturnValueOnce({ id: 1, name: 'a' }).mockReturnValueOnce({ id: 2, name: 'b' })
    addLightAndSelect()
    addLightAndSelect()
    expect(useStore.getState().sceneLights.map((l) => l.id)).toEqual([1, 2])
    expect(useStore.getState().selectedLightId).toBe(2)
  })
})
