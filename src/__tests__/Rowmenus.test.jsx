import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import React from 'react'

const lightCalls = { remove: vi.fn(), rename: vi.fn((id, name) => name), visible: vi.fn() }
const cameraCalls = { remove: vi.fn(), rename: vi.fn((id, name) => name) }
const sceneCalls = { visible: vi.fn(), rename: vi.fn((id, name) => name), remove: vi.fn(), reset: vi.fn(), rim: vi.fn() }

vi.mock('../three/lights.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    removeLight: (...a) => lightCalls.remove(...a),
    renameLight: (...a) => lightCalls.rename(...a),
    setLightVisible: (...a) => lightCalls.visible(...a),
    selectLight: () => {},
    getLightTransform: () => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }),
  }
})
vi.mock('../three/cameras.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    removeCamera: (...a) => cameraCalls.remove(...a),
    renameCamera: (...a) => cameraCalls.rename(...a),
    getCameraTransform: () => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }),
  }
})
vi.mock('../three/scene.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    setObjectVisibleById: (...a) => {
      sceneCalls.visible(...a)
      actual.setObjectVisibleById && useStore.getState().setObjectVisible(a[0], a[1])
    },
    renameObjectById: (id, name) => {
      sceneCalls.rename(id, name)
      useStore.getState().renameSceneObject(id, name)
      return name
    },
    removeObjectById: (...a) => sceneCalls.remove(...a),
    resetObjectById: (...a) => sceneCalls.reset(...a),
    setObjectRimImmuneById: (...a) => sceneCalls.rim(...a),
    getTransparentMeshUuidsForObject: () => [],
  }
})

import ViewportContextMenu from '../panels/ViewportContextMenu.jsx'
import ObjectsPanel from '../panels/ObjectsPanel.jsx'
import LightsPanel from '../panels/LightsPanel.jsx'
import CamerasPanel from '../panels/CamerasPanel.jsx'
import { useStore } from '../store.js'

afterEach(cleanup)

describe('menu: headings, ticks and flyouts', () => {
  const items = [
    { header: 'Hero' },
    { id: 'cast', label: 'Casts shadows', checked: true },
    { id: 'night', label: 'Darkens at night', checked: false },
    { label: 'Look', value: 'Cartoon', children: [{ id: 'style:toon', label: 'Cartoon', checked: true }, { id: 'style:unlit', label: 'Flat colour' }] },
  ]
  function setup() {
    const onAction = vi.fn()
    const onClose = vi.fn()
    render(<ViewportContextMenu menu={{ x: 10, y: 10, items }} onAction={onAction} onClose={onClose} />)
    return { onAction, onClose }
  }

  it('shows a heading that is not clickable, and ticks that reflect on / off', () => {
    setup()
    expect(screen.getByText('Hero').className).toContain('ctx-header')
    expect(screen.getByRole('menuitemcheckbox', { name: /Casts shadows/ }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemcheckbox', { name: /Darkens at night/ }).getAttribute('aria-checked')).toBe('false')
  })

  it('opens a flyout on hover and runs the chosen child', () => {
    const { onAction, onClose } = setup()
    expect(screen.queryByText('Flat colour')).toBeNull()
    fireEvent.mouseEnter(screen.getByText('Look').closest('.ctx-sub'))
    fireEvent.click(screen.getByText('Flat colour'))
    expect(onAction).toHaveBeenCalledWith('style:unlit')
    expect(onClose).toHaveBeenCalled()
  })

  it('opens a flyout on click too (touch screens)', () => {
    setup()
    fireEvent.click(screen.getByText('Look'))
    expect(screen.getByText('Flat colour')).toBeTruthy()
  })
})

describe('renaming keeps animation attached', () => {
  beforeEach(() => {
    useStore.setState({
      sceneCameras: [{ id: 1, name: 'Camera 1', fov: 50 }],
      sceneLights: [{ id: 5, name: 'Light 1', visible: true }],
      animData: {
        tracks: {}, root: [], meshes: {}, morphs: {},
        cameras: { 'Camera 1': [{ time: 0 }, { time: 1 }] },
        lights: { 'Light 1': [{ time: 0 }] },
        cuts: [{ time: 0, camera: 'Camera 1' }, { time: 2, camera: 'Other' }],
      },
    })
  })

  it('a renamed camera takes its keyframes and cuts with it', () => {
    useStore.getState().renameSceneCamera(1, 'Wide shot')
    const s = useStore.getState()
    expect(s.sceneCameras[0].name).toBe('Wide shot')
    expect(s.animData.cameras['Wide shot']).toHaveLength(2)
    expect(s.animData.cameras['Camera 1']).toBeUndefined()
    expect(s.animData.cuts).toEqual([{ time: 0, camera: 'Wide shot' }, { time: 2, camera: 'Other' }])
  })

  it('a renamed light takes its keyframes with it', () => {
    useStore.getState().renameSceneLight(5, 'Lamp')
    const s = useStore.getState()
    expect(s.sceneLights[0].name).toBe('Lamp')
    expect(s.animData.lights.Lamp).toHaveLength(1)
    expect(s.animData.lights['Light 1']).toBeUndefined()
  })

  it('renaming to the same name changes nothing', () => {
    const before = useStore.getState().animData
    useStore.getState().renameSceneLight(5, 'Light 1')
    expect(useStore.getState().animData).toBe(before)
  })
})

describe('Objects list menu', () => {
  beforeEach(() => {
    Object.values(sceneCalls).forEach((f) => f.mockClear?.())
    useStore.setState({
      sceneObjects: [
        { id: 1, name: 'Sword', visible: true, kind: 'model', style: 'auto', animationKey: 'k1' },
        { id: 2, name: 'Shield', visible: true, kind: 'model', style: 'auto', animationKey: 'k2' },
      ],
      selectedObjectId: null,
      selectedObjectIds: [],
      modelInfo: null,
      meshOverrides: {},
    })
  })
  const row = (name) => screen.getByText(name).closest('.obj-row')

  it('right-click shows the menu and selects the row', () => {
    render(<ObjectsPanel />)
    fireEvent.contextMenu(row('Sword'))
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Rename/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Duplicate/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeTruthy()
    expect(useStore.getState().selectedObjectId).toBe(1)
  })

  it('the ⋯ button opens the same menu', () => {
    render(<ObjectsPanel />)
    fireEvent.click(within(row('Shield')).getByRole('button', { name: 'More options' }))
    expect(screen.getByRole('menuitem', { name: /Reset position/ })).toBeTruthy()
  })

  it('shows the on/off settings with ticks', () => {
    useStore.setState({ sceneObjects: [{ id: 1, name: 'Sword', visible: true, kind: 'model', castShadow: false, nightImmune: true, animationKey: 'k1' }] })
    render(<ObjectsPanel />)
    fireEvent.contextMenu(row('Sword'))
    expect(screen.getByRole('menuitemcheckbox', { name: /Casts shadows/ }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('menuitemcheckbox', { name: /Darkens at night/ }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('menuitemcheckbox', { name: /Receives shadows/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('has "Ignore rim lighting" in the Light & shadow section, off by default, and it toggles', () => {
    render(<ObjectsPanel />)
    fireEvent.contextMenu(row('Sword'))
    const labels = [...screen.getByRole('menu').querySelectorAll('[role^="menuitem"]')].map((e) => e.textContent.replace('✓', '').trim())
    const shadow = labels.indexOf('Casts shadows')
    expect(shadow).toBeGreaterThan(-1)
    const rim = labels.indexOf('Ignore rim lighting')
    expect(rim).toBeGreaterThan(shadow) // after the section's first entry, before the section ends
    expect(rim).toBeLessThan(labels.indexOf('Reset position'))
    const item = screen.getByRole('menuitemcheckbox', { name: /Ignore rim lighting/ })
    expect(item.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(item)
    expect(sceneCalls.rim).toHaveBeenCalledWith(1, true)
  })

  it('shows it ticked, and a marker on the row, when the object ignores rim lighting', () => {
    useStore.setState({ sceneObjects: [{ id: 1, name: 'Sword', visible: true, kind: 'model', rimImmune: true, animationKey: 'k1' }] })
    render(<ObjectsPanel />)
    expect(row('Sword').querySelector('[title="Ignores rim lighting"]')).toBeTruthy()
    fireEvent.contextMenu(row('Sword'))
    expect(screen.getByRole('menuitemcheckbox', { name: /Ignore rim lighting/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('Hide runs on the row, and the menu then offers Show', () => {
    render(<ObjectsPanel />)
    fireEvent.contextMenu(row('Sword'))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Hide/ }))
    expect(sceneCalls.visible).toHaveBeenCalledWith(1, false)
    fireEvent.contextMenu(row('Sword'))
    expect(screen.getByRole('menuitem', { name: /^Show/ })).toBeTruthy()
  })

  it('Rename turns the name into a text box; Enter saves, Escape cancels', () => {
    render(<ObjectsPanel />)
    fireEvent.contextMenu(row('Sword'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }))
    const box = screen.getByLabelText('Name')
    fireEvent.change(box, { target: { value: 'Broadsword' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(sceneCalls.rename).toHaveBeenCalledWith(1, 'Broadsword')
    expect(screen.getByText('Broadsword')).toBeTruthy()

    fireEvent.doubleClick(screen.getByText('Broadsword'))
    const again = screen.getByLabelText('Name')
    fireEvent.change(again, { target: { value: 'Nope' } })
    fireEvent.keyDown(again, { key: 'Escape' })
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(screen.getByText('Broadsword')).toBeTruthy()
  })

  it('double-click renames without toggling the selection off', () => {
    render(<ObjectsPanel />)
    const name = screen.getByText('Sword')
    fireEvent.click(name, { detail: 1 })
    fireEvent.click(name, { detail: 2 })
    fireEvent.doubleClick(name)
    expect(useStore.getState().selectedObjectId).toBe(1)
    expect(screen.getByLabelText('Name')).toBeTruthy()
  })

  it('Delete asks first, and only deletes if confirmed', () => {
    const confirm = vi.spyOn(window, 'confirm')
    render(<ObjectsPanel />)
    confirm.mockReturnValueOnce(false)
    fireEvent.contextMenu(row('Sword'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }))
    expect(sceneCalls.remove).not.toHaveBeenCalled()
    confirm.mockReturnValueOnce(true)
    fireEvent.contextMenu(row('Sword'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }))
    expect(sceneCalls.remove).toHaveBeenCalledWith(1)
    confirm.mockRestore()
  })

  it('with several rows selected the menu acts on all of them', () => {
    useStore.setState({ selectedObjectId: 1, selectedObjectIds: [1, 2] })
    render(<ObjectsPanel />)
    fireEvent.contextMenu(row('Shield'))
    expect(screen.getByRole('menuitem', { name: /Delete 2 objects/ })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /Rename/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Reset position \(2\)/ }))
    expect(sceneCalls.reset).toHaveBeenCalledTimes(2)
  })

  it('rows keep only the name, eye, ⋯ and × — the old per-row controls are gone', () => {
    render(<ObjectsPanel />)
    const r = row('Sword')
    expect(within(r).queryByRole('combobox')).toBeNull()
    expect(r.querySelectorAll('button').length).toBe(3)
  })
})

describe('Lights list', () => {
  beforeEach(() => {
    Object.values(lightCalls).forEach((f) => f.mockClear?.())
    useStore.setState({
      sceneLights: [{ id: 5, name: 'Lamp', visible: true, color: '#ffffff', intensity: 2, castShadow: false, directional: false }],
      selectedLightId: null,
      animData: { tracks: {}, root: [], meshes: {}, morphs: {}, cameras: {}, lights: {}, cuts: [] },
    })
  })
  const row = () => screen.getByText(/Lamp/).closest('.obj-row')

  it('each light has an × that deletes it without selecting it', () => {
    render(<LightsPanel />)
    fireEvent.click(within(row()).getByRole('button', { name: 'Remove Lamp' }))
    expect(lightCalls.remove).toHaveBeenCalledWith(5)
    expect(useStore.getState().selectedLightId).toBeNull()
  })

  it('the menu has Delete too', () => {
    render(<LightsPanel />)
    fireEvent.contextMenu(row())
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }))
    expect(lightCalls.remove).toHaveBeenCalledWith(5)
  })

  it('the menu toggles shadows with a tick and offers presets and animation', () => {
    render(<LightsPanel />)
    fireEvent.contextMenu(row())
    expect(screen.getByRole('menuitemcheckbox', { name: /Casts shadows/ }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('menuitem', { name: /Preset/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Animation/ })).toBeTruthy()
  })

  it('Rename saves through the scene and moves the keyframes', () => {
    useStore.setState({ animData: { ...useStore.getState().animData, lights: { Lamp: [{ time: 0 }] } } })
    render(<LightsPanel />)
    fireEvent.doubleClick(screen.getByText(/Lamp/))
    const box = screen.getByLabelText('Name')
    fireEvent.change(box, { target: { value: 'Desk lamp' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(lightCalls.rename).toHaveBeenCalledWith(5, 'Desk lamp')
    expect(useStore.getState().animData.lights['Desk lamp']).toHaveLength(1)
  })
})

describe('Cameras list', () => {
  beforeEach(() => {
    Object.values(cameraCalls).forEach((f) => f.mockClear?.())
    useStore.setState({
      sceneCameras: [{ id: 1, name: 'Camera 1', fov: 50 }],
      selectedCameraId: null,
      viewCameraId: null,
      sceneObjects: [{ id: 9, name: 'Car', visible: true, kind: 'model' }],
      cameraAttachments: {},
      animData: { tracks: {}, root: [], meshes: {}, morphs: {}, cameras: {}, lights: {}, cuts: [] },
    })
  })
  const row = () => screen.getByText(/Camera 1/).closest('.obj-row')

  it('keeps the × and look-through icon, and the copy icon moved into the menu', () => {
    render(<CamerasPanel />)
    const r = row()
    expect(within(r).getByRole('button', { name: 'Remove Camera 1' })).toBeTruthy()
    expect(within(r).queryByTitle('Copy Camera 1')).toBeNull()
    fireEvent.contextMenu(r)
    expect(screen.getByRole('menuitem', { name: /Duplicate/ })).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: /Look through this camera/ })).toBeTruthy()
  })

  it('× and menu Delete both remove the camera', () => {
    render(<CamerasPanel />)
    fireEvent.click(within(row()).getByRole('button', { name: 'Remove Camera 1' }))
    expect(cameraCalls.remove).toHaveBeenCalledWith(1)
    fireEvent.contextMenu(row())
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }))
    expect(cameraCalls.remove).toHaveBeenCalledTimes(2)
  })

  it('Look through this camera from the menu switches the view', () => {
    render(<CamerasPanel />)
    fireEvent.contextMenu(row())
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Look through this camera/ }))
    expect(useStore.getState().viewCameraId).toBe(1)
  })
})
