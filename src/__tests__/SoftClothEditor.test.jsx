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
import { disposeSoftCloth, getSoftEntry, makeSoftZone, syncSoftCloth } from '../three/softcloth.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

function makeMesh() {
  const geo = new THREE.PlaneGeometry(1, 1, 4, 4)
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff0000 }))
  return mesh
}

let mesh
beforeEach(() => {
  disposeSoftCloth()
  mesh = makeMesh()
  picker.handler = null
  picker.options = null
  clearUndoHistory()
  useStore.setState({ meshOverrides: {} })
})
afterEach(() => {
  cleanup()
  disposeSoftCloth()
})

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

  it('lets a soft cloth zone opt in to collisions with other meshes', () => {
    render(<SoftClothEditor mesh={mesh} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))
    const collision = screen.getByLabelText('Collide with other meshes')
    expect(collision.checked).toBe(false)
    fireEvent.click(collision)
    expect(zonesOf()[0].collideWithMeshes).toBe(true)
  })

  it('lets a soft cloth zone opt in to collision with the rest of its own mesh', () => {
    render(<SoftClothEditor mesh={mesh} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))
    const collision = screen.getByLabelText('Collide with this mesh')
    expect(collision.checked).toBe(false)
    fireEvent.click(collision)
    expect(zonesOf()[0].collideWithSelf).toBe(true)
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

  it('does not show join controls when a picked cloth area has no held vertices', () => {
    const zone = makeSoftZone('soft', { kind: 'tris', tris: [[0, 0]], vertexCount: 3 }, 'hood')
    const overrides = { [mesh.uuid]: { softZones: [zone] } }
    useStore.setState({ meshOverrides: overrides })
    syncSoftCloth([{ meshes: [mesh], overrides }])
    expect(getSoftEntry(mesh).zones.get(zone.id).lockedSites).toHaveLength(0)

    render(<SoftClothEditor mesh={mesh} />)

    expect(screen.getByText(/Nothing is held on this effect/)).toBeTruthy()
    expect(screen.queryByRole('slider', { name: /Join range/ })).toBeNull()
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

  it('edits an existing picked area and saves the change as one undoable step', () => {
    render(<SoftClothEditor mesh={mesh} />)
    const where = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'picked'))
    fireEvent.change(where, { target: { value: 'picked' } })
    const growBy = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'face'))
    fireEvent.change(growBy, { target: { value: 'face' } })
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: 5 }))
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))
    const originalArea = zonesOf()[0].area

    fireEvent.click(screen.getByText('Picked faces'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit area' }))
    expect(screen.getByText(/1 face selected.*shown in pink/)).toBeTruthy()
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: 6 }))
    fireEvent.click(screen.getByRole('button', { name: 'Save area' }))
    expect(zonesOf()[0].area.tris).toEqual([[6, 6]])

    performUndo(useStore.getState())
    expect(zonesOf()[0].area).toEqual(originalArea)
  })

  it('cancels area editing without changing the saved area', () => {
    render(<SoftClothEditor mesh={mesh} />)
    const where = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'picked'))
    fireEvent.change(where, { target: { value: 'picked' } })
    const growBy = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'face'))
    fireEvent.change(growBy, { target: { value: 'face' } })
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: 5 }))
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))
    const originalArea = zonesOf()[0].area

    fireEvent.click(screen.getByText('Picked faces'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit area' }))
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: 6 }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(zonesOf()[0].area).toEqual(originalArea)
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
    fireEvent.change(screen.getByLabelText('Group these meshes'), { target: { value: 'seams' } })
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

describe('Soft cloth editor: fill tool and highlight', () => {
  const N = 6
  const quadTris = (r, c) => [2 * (r * N + c), 2 * (r * N + c) + 1]
  const bigMesh = () => new THREE.Mesh(new THREE.PlaneGeometry(1, 1, N, N), new THREE.MeshBasicMaterial({ color: 0xff0000 }))

  function pickMode() {
    const where = screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === 'picked'))
    fireEvent.change(where, { target: { value: 'picked' } })
  }
  const selectByValue = (value) => screen.getAllByRole('combobox').find((s) => [...s.options].some((o) => o.value === value))

  function drawRing() {
    // a ring around the inner 2x2 quads (rows/cols 2..3): the border of the 4x4 block at rows/cols 1..4
    fireEvent.change(selectByValue('face'), { target: { value: 'face' } })
    fireEvent.click(screen.getByLabelText('Each click adds to the area'))
    for (let r = 1; r <= 4; r++) {
      for (let c = 1; c <= 4; c++) {
        if (r > 1 && r < 4 && c > 1 && c < 4) continue
        for (const t of quadTris(r, c)) act(() => picker.handler({ uuid: mesh.uuid, faceIndex: t }))
      }
    }
  }

  it('fills the inside of an outline, and clicking inside the fill again takes it away', () => {
    mesh = bigMesh()
    render(<SoftClothEditor mesh={mesh} />)
    pickMode()
    drawRing()
    expect(screen.getByText(/24 faces selected/)).toBeTruthy()
    fireEvent.change(selectByValue('fill'), { target: { value: 'fill' } })
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: quadTris(2, 2)[0] }))
    expect(screen.getByText(/Filled 8 faces/)).toBeTruthy()
    expect(screen.getByText(/32 faces selected/)).toBeTruthy()
    // the zone keeps outline + fill
    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }))
    const faces = zonesOf()[0].area.tris.reduce((total, [a, b]) => total + (b - a + 1), 0)
    expect(faces).toBe(32)
  })

  it('clicking inside a fill again removes just that fill', () => {
    mesh = bigMesh()
    render(<SoftClothEditor mesh={mesh} />)
    pickMode()
    drawRing()
    fireEvent.change(selectByValue('fill'), { target: { value: 'fill' } })
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: quadTris(2, 2)[0] }))
    expect(screen.getByText(/32 faces selected/)).toBeTruthy()
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: quadTris(3, 3)[1] }))
    expect(screen.getByText(/24 faces selected/)).toBeTruthy()
  })

  it('warns when the outline has a gap and the fill runs out across the connected piece', () => {
    mesh = bigMesh()
    render(<SoftClothEditor mesh={mesh} />)
    pickMode()
    fireEvent.change(selectByValue('face'), { target: { value: 'face' } })
    fireEvent.click(screen.getByLabelText('Each click adds to the area'))
    // only the top and left sides of the outline: it is not closed
    for (let i = 1; i <= 4; i++) {
      for (const t of [...quadTris(1, i), ...quadTris(i, 1)]) act(() => picker.handler({ uuid: mesh.uuid, faceIndex: t }))
    }
    fireEvent.change(selectByValue('fill'), { target: { value: 'fill' } })
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: quadTris(2, 2)[0] }))
    expect(screen.getByText(/outline probably has a gap/)).toBeTruthy()
  })

  it('does not fill a face that is part of the outline', () => {
    mesh = bigMesh()
    render(<SoftClothEditor mesh={mesh} />)
    pickMode()
    drawRing()
    fireEvent.change(selectByValue('fill'), { target: { value: 'fill' } })
    act(() => picker.handler({ uuid: mesh.uuid, faceIndex: quadTris(1, 1)[0] }))
    expect(screen.getByText(/part of the outline/)).toBeTruthy()
    expect(screen.getByText(/24 faces selected/)).toBeTruthy()
  })

  it('switching to the fill tool and back does not change the faces already picked', () => {
    mesh = bigMesh()
    render(<SoftClothEditor mesh={mesh} />)
    pickMode()
    drawRing()
    fireEvent.change(selectByValue('fill'), { target: { value: 'fill' } })
    fireEvent.change(selectByValue('brush'), { target: { value: 'brush' } })
    expect(screen.getByText(/24 faces selected/)).toBeTruthy()
  })
})
