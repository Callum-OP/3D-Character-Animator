import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import React from 'react'

const requestRender = vi.fn()
let model = null
vi.mock('../three/scene.js', () => ({
  getCurrentModel: () => model,
  requestRender: (...a) => requestRender(...a),
}))

import ShapeKeyPicker, { collectShapeKeys, readShapeKey, writeShapeKey } from '../panels/ShapeKeyPicker.jsx'

function makeMesh(names) {
  return {
    morphTargetDictionary: Object.fromEntries(names.map((n, i) => [n, i])),
    morphTargetInfluences: names.map(() => 0),
  }
}

beforeEach(() => {
  requestRender.mockClear()
  model = { meshes: [makeMesh(['Smile', 'Blink']), makeMesh(['Smile', 'JawOpen']), { name: 'NoShapes' }] }
})
afterEach(cleanup)

describe('collectShapeKeys', () => {
  it('lists each shape key once by name, remembering every mesh that has it', () => {
    const keys = collectShapeKeys(model.meshes)
    expect(keys.map((k) => k.name).sort()).toEqual(['Blink', 'JawOpen', 'Smile'])
    expect(keys.find((k) => k.name === 'Smile').targets).toHaveLength(2)
  })

  it('writes to all meshes, clamped to 0–1', () => {
    const smile = collectShapeKeys(model.meshes).find((k) => k.name === 'Smile')
    writeShapeKey(smile, 0.6)
    expect(model.meshes[0].morphTargetInfluences[0]).toBe(0.6)
    expect(model.meshes[1].morphTargetInfluences[0]).toBe(0.6)
    expect(writeShapeKey(smile, 4)).toBe(1)
    expect(readShapeKey(smile)).toBe(1)
  })
})

describe('ShapeKeyPicker', () => {
  it('renders nothing for a character without shape keys', () => {
    model = { meshes: [{ name: 'Body' }] }
    const { container } = render(<ShapeKeyPicker />)
    expect(container.firstChild).toBeNull()
  })

  it('starts as a single compact drop-down with no sliders until one is picked', () => {
    const { container } = render(<ShapeKeyPicker />)
    const select = screen.getByLabelText('Shape key')
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Shape key…', 'Blink', 'JawOpen', 'Smile'])
    expect(container.querySelectorAll('input[type="range"]')).toHaveLength(0)
    expect(screen.queryByLabelText('Filter shape keys')).toBeNull() // only appears with lots of shape keys
  })

  it('equips the picked shape key as a full slider that drives every mesh carrying it', () => {
    render(<ShapeKeyPicker />)
    fireEvent.change(screen.getByLabelText('Shape key'), { target: { value: 'Smile' } })
    const slider = screen.getByLabelText('Smile shape key')
    fireEvent.change(slider, { target: { value: '0.7' } })
    expect(model.meshes[0].morphTargetInfluences[0]).toBeCloseTo(0.7)
    expect(model.meshes[1].morphTargetInfluences[0]).toBeCloseTo(0.7)
    expect(requestRender).toHaveBeenCalled()
    expect(screen.getByLabelText('Smile shape key').value).toBe('0.7')
  })

  it('shows the current value next to shape keys that are set, and the 0 button resets', () => {
    render(<ShapeKeyPicker />)
    fireEvent.change(screen.getByLabelText('Shape key'), { target: { value: 'Blink' } })
    fireEvent.change(screen.getByLabelText('Blink shape key'), { target: { value: '0.5' } })
    expect(within(screen.getByLabelText('Shape key')).getByText(/Blink\s+·\s+0\.50/)).toBeTruthy()
    fireEvent.click(screen.getByTitle('Set this shape key back to 0'))
    expect(model.meshes[0].morphTargetInfluences[1]).toBe(0)
  })

  it('fine slider nudges from where the value was and springs back when released', () => {
    render(<ShapeKeyPicker />)
    fireEvent.change(screen.getByLabelText('Shape key'), { target: { value: 'Smile' } })
    fireEvent.change(screen.getByLabelText('Smile shape key'), { target: { value: '0.5' } })
    const fine = screen.getByLabelText('Fine-tune Smile')
    fireEvent.change(fine, { target: { value: '0.03' } })
    expect(model.meshes[0].morphTargetInfluences[0]).toBeCloseTo(0.53)
    fireEvent.change(fine, { target: { value: '0.05' } })
    expect(model.meshes[0].morphTargetInfluences[0]).toBeCloseTo(0.55) // relative to where the nudge began, not compounding
    fireEvent.pointerUp(fine)
    expect(screen.getByLabelText('Fine-tune Smile').value).toBe('0')
    fireEvent.change(screen.getByLabelText('Fine-tune Smile'), { target: { value: '-0.02' } })
    expect(model.meshes[0].morphTargetInfluences[0]).toBeCloseTo(0.53) // new nudge starts from the new value (0.55)
  })

  it('the fine slider cannot push the value outside 0–1', () => {
    render(<ShapeKeyPicker />)
    fireEvent.change(screen.getByLabelText('Shape key'), { target: { value: 'Smile' } })
    fireEvent.change(screen.getByLabelText('Smile shape key'), { target: { value: '0.98' } })
    fireEvent.change(screen.getByLabelText('Fine-tune Smile'), { target: { value: '0.1' } })
    expect(model.meshes[0].morphTargetInfluences[0]).toBe(1)
  })

  describe('with lots of shape keys', () => {
    beforeEach(() => {
      const names = Array.from({ length: 52 }, (_, i) => (i % 2 ? `eyeBlink${i}` : `mouthSmile${i}`))
      model = { meshes: [makeMesh(names)] }
    })

    it('adds a filter that narrows the list, and Enter equips the first match', () => {
      render(<ShapeKeyPicker />)
      const filter = screen.getByLabelText('Filter shape keys')
      fireEvent.change(filter, { target: { value: 'blink' } })
      const options = within(screen.getByLabelText('Shape key')).getAllByRole('option')
      expect(options).toHaveLength(1 + 26) // placeholder + the 26 eyeBlink keys
      expect(options.slice(1).every((o) => /eyeBlink/.test(o.textContent))).toBe(true)
      fireEvent.keyDown(filter, { key: 'Enter' })
      expect(screen.getByLabelText('Shape key').value).toBe('eyeBlink1')
      expect(screen.getByLabelText('eyeBlink1 shape key')).toBeTruthy()
    })

    it('keeps the equipped shape key in the drop-down even when the filter hides it', () => {
      render(<ShapeKeyPicker />)
      fireEvent.change(screen.getByLabelText('Shape key'), { target: { value: 'mouthSmile0' } })
      fireEvent.change(screen.getByLabelText('Filter shape keys'), { target: { value: 'blink' } })
      expect(screen.getByLabelText('Shape key').value).toBe('mouthSmile0')
    })
  })
})
