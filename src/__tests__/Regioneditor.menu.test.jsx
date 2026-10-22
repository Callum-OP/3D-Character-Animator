import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import React from 'react'

vi.mock('../three/regions.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, isRegionCapable: () => true, setRegionOverlay: () => {}, fromRanges: () => [] }
})
vi.mock('../three/scene.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, applyModelMaterials: () => {} }
})
vi.mock('../three/materialHistory.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, recordOverrideEdit: (_uuids, fn) => fn() }
})
vi.mock('../three/meshedit.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, setFacePickHandler: () => {} }
})
vi.mock('../three/surfaceMaterials.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getOriginalMaterials: () => null }
})

import RegionEditor from '../panels/RegionEditor.jsx'
import { useStore } from '../store.js'

const mesh = { uuid: 'm1', geometry: {} }
const regionsOf = () => useStore.getState().meshOverrides.m1.regions

beforeEach(() => {
  useStore.setState({
    meshOverrides: {
      m1: {
        regions: [
          { id: 'a', name: 'Headlight', tris: [], look: { mode: 'solid', color: '#ffffff' } },
          { id: 'b', name: 'Window', tris: [], look: { mode: 'solid', color: '#222222' } },
        ],
      },
    },
  })
})
afterEach(cleanup)

const renderEditor = () => render(<RegionEditor meshUuid="m1" resolveMesh={() => mesh} />)
const row = (name) => screen.getByText(name).closest('.obj-row')

describe('Paint regions list', () => {
  it('lists each region as a row with a swatch, a ⋯ and a ×', () => {
    renderEditor()
    const r = row('Headlight')
    expect(within(r).getByRole('button', { name: 'Region options' })).toBeTruthy()
    expect(within(r).getByRole('button', { name: 'Delete Headlight' })).toBeTruthy()
  })

  it('clicking a row opens its editor, clicking again closes it', () => {
    renderEditor()
    const r = row('Headlight') // grab it once: "Headlight" is also a look preset in the editor
    expect(screen.queryByLabelText('Region look')).toBeNull()
    fireEvent.click(r)
    expect(screen.getByLabelText('Region look')).toBeTruthy()
    fireEvent.click(r)
    expect(screen.queryByLabelText('Region look')).toBeNull()
  })

  it('the rarely used controls start collapsed', () => {
    renderEditor()
    fireEvent.click(row('Headlight'))
    expect(screen.getByText('Shine (roughness, metalness)').closest('details').open).toBe(false)
    expect(screen.getByText('Turn into a light').closest('details').open).toBe(false)
  })

  it('the menu applies a look to the region it was opened on', () => {
    renderEditor()
    fireEvent.contextMenu(row('Window'))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Look/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Chrome' }))
    const win = regionsOf().find((r) => r.id === 'b')
    expect(win.look.color).toBe('#e9e9e9')
    expect(win.look.metalness).toBe(1)
    expect(regionsOf().find((r) => r.id === 'a').look.color).toBe('#ffffff') // the other one is untouched
  })

  it('the menu switches the colour mode', () => {
    renderEditor()
    fireEvent.contextMenu(row('Headlight'))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Colour/ }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Tint/ }))
    expect(regionsOf().find((r) => r.id === 'a').look.mode).toBe('tint')
  })

  it('Turn into a light… in the menu opens that section', () => {
    renderEditor()
    fireEvent.contextMenu(row('Headlight'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Turn into a light/ }))
    expect(screen.getByText('Turn into a light', { selector: 'summary' }).closest('details').open).toBe(true)
  })

  it('renaming through the row saves one change and keeps the look', () => {
    renderEditor()
    fireEvent.doubleClick(screen.getByText('Window'))
    const box = screen.getByLabelText('Name')
    fireEvent.change(box, { target: { value: 'Windscreen' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    const r = regionsOf().find((x) => x.id === 'b')
    expect(r.name).toBe('Windscreen')
    expect(r.look.color).toBe('#222222')
  })

  it('an empty name is ignored', () => {
    renderEditor()
    fireEvent.doubleClick(screen.getByText('Window'))
    const box = screen.getByLabelText('Name')
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(regionsOf().find((x) => x.id === 'b').name).toBe('Window')
  })

  it('delete (× or menu) asks first', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    renderEditor()
    fireEvent.click(within(row('Window')).getByRole('button', { name: 'Delete Window' }))
    expect(regionsOf()).toHaveLength(2)
    confirm.mockReturnValueOnce(true)
    fireEvent.contextMenu(row('Window'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }))
    expect(regionsOf().map((r) => r.id)).toEqual(['a'])
    confirm.mockRestore()
  })
})
