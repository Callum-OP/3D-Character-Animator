import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import * as THREE from 'three'

const picker = vi.hoisted(() => ({ handler: null, options: null }))
vi.mock('../three/meshedit.js', async (importOriginal) => ({
  ...(await importOriginal()),
  setFacePickHandler: (fn, options) => {
    picker.handler = fn
    picker.options = options
  },
}))

import { useStore } from '../store.js'
import SoftClothEditor from '../panels/SoftClothEditor.jsx'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

function makeMesh() {
  const geo = new THREE.PlaneGeometry(1, 1, 4, 4)
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff0000 }))
  return mesh
}

let mesh
beforeEach(() => {
  mesh = makeMesh()
  picker.handler = null
  picker.options = null
  clearUndoHistory()
  useStore.setState({ meshOverrides: {} })
})
afterEach(cleanup)

const zonesOf = (target = mesh) => useStore.getState().meshOverrides[target.uuid]?.softZones || []

describe('Soft cloth editor', () => {
  it('adds a soft cloth effect on the whole part, and it is one undo step', () => {
    render(<SoftClothEditor mesh={mesh} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))
    expect(zonesOf()).toHaveLength(1)
    expect(zonesOf()[0].mode).toBe('soft')
    expect(zonesOf()[0].area.kind).toBe('all')
    expect(zonesOf()[0].enabled).toBe(true)
    performUndo(useStore.getState())
    expect(zonesOf()).toHaveLength(0)
    performRedo(useStore.getState())
    expect(zonesOf()).toHaveLength(1)
  })

  it('adds a swing effect from a preset', () => {
    render(<SoftClothEditor mesh={mesh} />)
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'swing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))
    expect(zonesOf()[0].mode).toBe('swing')
    expect(zonesOf()[0].preset).toBe('zip')
    expect(zonesOf()[0].swingLimit).toBeGreaterThan(0)
  })

  it('picking an area: the click is wired up for skinned parts, grows into faces, and the zone keeps them', () => {
    render(<SoftClothEditor mesh={mesh} />)
    const where = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'picked'))
    fireEvent.change(where, { target: { value: 'picked' } })
    expect(picker.handler).toBeTypeOf('function')
    expect(picker.options).toEqual({ allowSkinned: true })
    // Add is not possible until something is picked
    expect(screen.getByRole('button', { name: 'Add effect' }).disabled).toBe(true)
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: 5 }))
    expect(screen.getByText(/faces? selected/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add effect' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))
    const zone = zonesOf()[0]
    expect(zone.area.kind).toBe('tris')
    expect(zone.area.tris.length).toBeGreaterThan(0)
    expect(zone.lockTop).toBe(0) // an area picked by hand is not given a held top
  })

  it('lets picked soft cloth blend beyond its boundary by default and configure the affected area', () => {
    render(<SoftClothEditor mesh={mesh} />)
    const where = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'picked'))
    fireEvent.change(where, { target: { value: 'picked' } })
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: 5 }))
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))

    expect(screen.getByLabelText('Blend into unselected area').checked).toBe(true)
    expect(zonesOf()[0].blendOutside).toBe(true)

    fireEvent.change(screen.getByLabelText('Blend where'), { target: { value: 'all' } })
    expect(zonesOf()[0].outsideMode).toBe('all')
    fireEvent.click(screen.getByLabelText('Blend into unselected area'))
    expect(zonesOf()[0].blendOutside).toBe(false)
  })

  it('offers the same boundary blend settings for picked Swing zones', () => {
    render(<SoftClothEditor mesh={mesh} />)
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'swing' } })
    const where = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'picked'))
    fireEvent.change(where, { target: { value: 'picked' } })
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: 5 }))
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))

    expect(zonesOf()[0].mode).toBe('swing')
    expect(screen.getByLabelText('Blend into unselected area').checked).toBe(true)
    fireEvent.change(screen.getByLabelText('Blend where'), { target: { value: 'all' } })
    expect(zonesOf()[0].outsideMode).toBe('all')
  })

  it('clicking the selected area again deselects it', () => {
    render(<SoftClothEditor mesh={mesh} />)
    const where = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'picked'))
    fireEvent.change(where, { target: { value: 'picked' } })
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: 5 }))
    expect(screen.getByRole('button', { name: 'Add effect' }).disabled).toBe(false)
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: 5 }))
    expect(screen.getByRole('button', { name: 'Add effect' }).disabled).toBe(true)
    expect(screen.getByText(/click one or more selected parts/i)).toBeTruthy()
  })

  it('applies one whole-part effect to every selected mesh as one undo step', () => {
    const secondMesh = makeMesh()
    render(<SoftClothEditor mesh={mesh} meshes={[mesh, secondMesh]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))
    expect(zonesOf()).toHaveLength(1)
    expect(zonesOf(secondMesh)).toHaveLength(1)
    performUndo(useStore.getState())
    expect(zonesOf()).toHaveLength(0)
    expect(zonesOf(secondMesh)).toHaveLength(0)
    performRedo(useStore.getState())
    expect(zonesOf()).toHaveLength(1)
    expect(zonesOf(secondMesh)).toHaveLength(1)
  })

  it('stores the selected multi-mesh coupling mode on the effects', () => {
    const secondMesh = makeMesh()
    render(<SoftClothEditor mesh={mesh} meshes={[mesh, secondMesh]} />)
    fireEvent.change(screen.getByLabelText('Connection for new effects'), { target: { value: 'seams' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))
    const firstZone = zonesOf()[0]
    const secondZone = zonesOf(secondMesh)[0]
    expect(firstZone.couplingMode).toBe('seams')
    expect(firstZone.couplingGroup).toBe(secondZone.couplingGroup)
  })

  it('applies picked areas only to selected meshes where an area was clicked', () => {
    const secondMesh = makeMesh()
    render(<SoftClothEditor mesh={mesh} meshes={[mesh, secondMesh]} />)
    const where = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'picked'))
    fireEvent.change(where, { target: { value: 'picked' } })
    act(() => picker.handler({ uuid: secondMesh.uuid, faceIndex: 5 }))
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))
    expect(zonesOf()).toHaveLength(0)
    expect(zonesOf(secondMesh)).toHaveLength(1)
    expect(zonesOf(secondMesh)[0].area.kind).toBe('tris')
  })

  it('a click on a different part is refused', () => {
    render(<SoftClothEditor mesh={mesh} />)
    const where = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'picked'))
    fireEvent.change(where, { target: { value: 'picked' } })
    act(() => picker.handler({ uuid: 'someone-else', faceIndex: 1 }))
    expect(screen.getByText(/different part/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add effect' }).disabled).toBe(true)
  })

  it('the "round brush" reaches further with a bigger size', () => {
    render(<SoftClothEditor mesh={mesh} />)
    const where = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'picked'))
    fireEvent.change(where, { target: { value: 'picked' } })
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: 0 }))
    const count = () => Number(screen.getByText(/faces? selected/).textContent.match(/(\d+) face/)[1])
    const small = count()
    const size = screen.getByRole('slider', { name: /Size/ }) // the brush size
    fireEvent.change(size, { target: { value: '0.5' } })
    expect(count()).toBeGreaterThan(small)
  })

  it('an effect can be switched off, renamed and removed; each is undoable', () => {
    render(<SoftClothEditor mesh={mesh} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))
    const id = zonesOf()[0].id
    fireEvent.click(screen.getByLabelText('On'))
    expect(zonesOf()[0].enabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Remove this effect' }))
    expect(zonesOf()).toHaveLength(0)
    performUndo(useStore.getState())
    expect(zonesOf()).toHaveLength(1)
    expect(zonesOf()[0].id).toBe(id)
  })

  it('a preset changes the numbers but never gives a picked area a held top', () => {
    render(<SoftClothEditor mesh={mesh} />)
    const where = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'picked'))
    fireEvent.change(where, { target: { value: 'picked' } })
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: 3 }))
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))
    const zone = zonesOf()[0]
    const presetSelect = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'sleeves') && s.value === zone.preset)
    fireEvent.change(presetSelect, { target: { value: 'sleeves' } })
    expect(zonesOf()[0].preset).toBe('sleeves')
    expect(zonesOf()[0].lockTop).toBe(0)
  })

  it('says so when the full cloth simulation is on, and will not add', () => {
    render(<SoftClothEditor mesh={mesh} clothOn />)
    expect(screen.getByText(/full cloth simulation is on/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add effect' }).disabled).toBe(true)
  })

  it('a slider drag is one undo step, and an edit right after an undo is not lost', () => {
    render(<SoftClothEditor mesh={mesh} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))
    const start = zonesOf()[0].stiffness
    const slider = screen.getByRole('slider', { name: /Springiness/ })
    for (const v of ['0.5', '0.6', '0.7']) fireEvent.change(slider, { target: { value: v } })
    expect(zonesOf()[0].stiffness).toBe(0.7)
    performUndo(useStore.getState())
    expect(zonesOf()[0].stiffness).toBe(start) // the whole drag
    fireEvent.change(screen.getByRole('slider', { name: /Springiness/ }), { target: { value: '0.9' } })
    expect(zonesOf()[0].stiffness).toBe(0.9)
    performUndo(useStore.getState())
    expect(zonesOf()[0].stiffness).toBe(start)
    performRedo(useStore.getState())
    expect(zonesOf()[0].stiffness).toBe(0.9)
  })
})
