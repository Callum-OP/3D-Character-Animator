import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import MaterialLookPanel from '../panels/MaterialLookPanel.jsx'
import MaterialPanel from '../panels/MaterialPanel.jsx'
import { useStore } from '../store.js'
import { TEXTURE_LOOK_DEFAULT, TEXTURE_LOOK_PRESETS, presetLook as presetLookFor } from '../three/textureLookOptions.js'

beforeEach(() => useStore.setState({ materialLook: { ...TEXTURE_LOOK_DEFAULT } }))
afterEach(cleanup)

describe('Look > Material tab', () => {
  it('offers every preset, with Original marked', () => {
    render(<MaterialLookPanel />)
    for (const p of TEXTURE_LOOK_PRESETS) expect(screen.getByRole('button', { name: p.label })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Original' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('has Noir and Anime texture presets', () => {
    render(<MaterialLookPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Noir' }))
    expect(useStore.getState().materialLook.colour).toBe('noir')
    expect(screen.getByRole('button', { name: 'Noir' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Anime' }))
    expect(useStore.getState().materialLook.detail).toBe('regions') // flat colours that keep shapes
    expect(useStore.getState().materialLook.separation).toBe(0)
    expect(useStore.getState().materialLook.bands).toBe(0)
    expect(useStore.getState().materialLook.colour).toBe('vivid')
    expect(useStore.getState().materialLook.strength).toBe(0.7)
  })

  it('a preset fills the controls, and changing one by hand clears the preset highlight', () => {
    render(<MaterialLookPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Flat colour' }))
    expect(screen.getByLabelText('Texture detail').value).toBe('flat') // one plain colour per surface
    fireEvent.change(screen.getByLabelText('Colours'), { target: { value: 'sepia' } })
    expect(useStore.getState().materialLook.colour).toBe('sepia')
    expect(useStore.getState().materialLook.detail).toBe('flat') // rest unchanged
    expect(screen.getByRole('button', { name: 'Flat colour' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('numeric controls store numbers, and "Apply to" and strength work', () => {
    render(<MaterialLookPanel />)
    fireEvent.change(screen.getByLabelText('Colour tones'), { target: { value: '4' } })
    expect(useStore.getState().materialLook.bands).toBe(4)
    fireEvent.change(screen.getByLabelText('Pixel size'), { target: { value: '32' } })
    expect(useStore.getState().materialLook.pixels).toBe(32)
    fireEvent.change(screen.getByLabelText('Apply to'), { target: { value: 'objects' } })
    expect(useStore.getState().materialLook.scope).toBe('objects')
  })

  it('"Back to original materials" resets, and is disabled when there is nothing to reset', () => {
    render(<MaterialLookPanel />)
    const reset = screen.getByRole('button', { name: 'Back to original materials' })
    expect(reset.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Clay' }))
    expect(reset.disabled).toBe(false)
    fireEvent.click(reset)
    expect(useStore.getState().materialLook.preset).toBe('original')
    expect(useStore.getState().materialLook.detail).toBe('full')
  })

  it('does not touch the lighting settings, so the two can be combined', () => {
    useStore.setState({ materialMode: 'toon', colorGrading: 'bleach' })
    render(<MaterialLookPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Noir' }))
    expect(useStore.getState().materialMode).toBe('toon')
    expect(useStore.getState().colorGrading).toBe('bleach')
  })
})

describe('the old Material panel is now Lighting', () => {
  it('is headed Lighting and points to the Material tab', () => {
    render(<MaterialPanel />)
    expect(screen.getByRole('heading', { name: 'Lighting' })).toBeTruthy()
    expect(screen.getByText(/Material tab/)).toBeTruthy()
  })
})

describe('the dropdowns stay uncluttered', () => {
  it('show only their title — no description text sits under them', () => {
    const { container } = render(<MaterialLookPanel />)
    const fields = container.querySelectorAll('.material-look-field')
    expect(fields.length).toBe(7)
    for (const f of fields) {
      expect(f.querySelector('.radio-hint')).toBeNull()
      expect(f.textContent).not.toMatch(/Textures stay|Shine\.|Fewer tones/) // the old visible hints
    }
  })

  it('the description appears on hover, and follows the chosen option', () => {
    const { container } = render(<MaterialLookPanel />)
    const field = (label) => [...container.querySelectorAll('.material-look-field')].find((f) => f.textContent.startsWith(label))
    expect(field('Texture detail').getAttribute('title')).toMatch(/Flat colour turns each textured surface/)
    fireEvent.change(screen.getByLabelText('Colours'), { target: { value: 'clay' } })
    expect(field('Colours').getAttribute('title')).toMatch(/one plain grey/)
    fireEvent.change(screen.getByLabelText('Colours'), { target: { value: 'manga' } })
    expect(field('Colours').getAttribute('title')).toMatch(/Clean ink on blank paper/)
  })

  it('the presets are laid out in three rows of four', () => {
    render(<MaterialLookPanel />)
    const names = screen.getAllByRole('button').map((b) => b.textContent).filter((t) => TEXTURE_LOOK_PRESETS.some((p) => p.label === t))
    expect(names).toEqual([
      'Original', 'Flat colour', 'Cel Paint', 'Anime',
      'Toon Smoothed', 'Pixel', 'Flat Pixel', 'Retro',
      'Clay', 'Manga', 'Noir Ink', 'Noir',
    ])
    for (const gone of ['Simplified', 'Smoothed', 'Vivid']) expect(screen.queryByRole('button', { name: gone })).toBeNull()
  })
})

describe('Flat — keep shapes: the sensitivity slider', () => {
  it('only appears with that texture detail, and sets the sensitivity', () => {
    render(<MaterialLookPanel />)
    expect(screen.queryByText('Shape sensitivity')).toBeNull()
    fireEvent.change(screen.getByLabelText('Texture detail'), { target: { value: 'regions' } })
    expect(screen.getByText('Shape sensitivity')).toBeTruthy()
    const slider = screen.getByText('Shape sensitivity').closest('label').querySelector('input[type=range]')
    fireEvent.change(slider, { target: { value: '0.8' } })
    expect(useStore.getState().materialLook.separation).toBe(0.8)
    fireEvent.change(screen.getByLabelText('Texture detail'), { target: { value: 'flat' } })
    expect(screen.queryByText('Shape sensitivity')).toBeNull()
  })
  it('the Anime and Flat Pixel presets turn it on; plain Flat colour does not', () => {
    render(<MaterialLookPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Flat colour' }))
    expect(screen.queryByText('Shape sensitivity')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Anime' }))
    expect(screen.getByText('Shape sensitivity')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Flat Pixel' }))
    expect(screen.getByText('Shape sensitivity')).toBeTruthy()
  })
})

describe('controls that cannot show anything here say so', () => {
  const labelOf = (container, name) => [...container.querySelectorAll('.material-look-field')].find((f) => f.textContent.startsWith(name))
  it('Bumps notes when no model in the scene has a bump map', () => {
    useStore.setState({ materialMode: 'toon', sceneObjects: [] })
    const { container } = render(<MaterialLookPanel />)
    expect(labelOf(container, 'Bumps').textContent).toContain('no bump maps in this scene')
    expect(labelOf(container, 'Surface finish').textContent).not.toContain('no effect')
    expect(screen.getByLabelText('Bumps')).toBeTruthy() // still a normal, labelled control
  })
  it('Surface finish notes that Flat colour lighting has no shine', () => {
    useStore.setState({ materialMode: 'unlit' })
    const { container } = render(<MaterialLookPanel />)
    expect(labelOf(container, 'Surface finish').textContent).toContain('no shine in Flat colour lighting')
    expect(labelOf(container, 'Surface finish').getAttribute('title')).toMatch(/Nothing to show right now/)
  })
  it('and says nothing when it does apply', () => {
    useStore.setState({ materialMode: 'standard' })
    const { container } = render(<MaterialLookPanel />)
    expect(labelOf(container, 'Surface finish').textContent).toBe('Surface finishOriginalMatteSatinGlossyMetallicPencil hatching')
  })
})

describe('Adjust colour', () => {
  const slider = (name) => screen.getByRole('slider', { name })
  it('is a collapsed group with contrast, brightness, saturation and a tint', () => {
    render(<MaterialLookPanel />)
    const group = screen.getByText(/^Adjust colour/).closest('details')
    expect(group.open).toBe(false)
    for (const n of ['Contrast', 'Brightness', 'Saturation', 'Tint amount']) expect(slider(n)).toBeTruthy()
    expect(screen.getByLabelText('Tint colour')).toBeTruthy()
  })
  it('starts open when a look with adjustments is already set', () => {
    useStore.setState({ materialLook: { ...TEXTURE_LOOK_DEFAULT, contrast: 0.3 } })
    render(<MaterialLookPanel />)
    expect(screen.getByText(/^Adjust colour/).closest('details').open).toBe(true)
  })
  it('the sliders set the look (and switch it on)', () => {
    render(<MaterialLookPanel />)
    fireEvent.change(slider('Contrast'), { target: { value: '0.5' } })
    fireEvent.change(slider('Brightness'), { target: { value: '-0.25' } })
    fireEvent.change(slider('Saturation'), { target: { value: '0.8' } })
    const l = useStore.getState().materialLook
    expect([l.contrast, l.brightness, l.saturation]).toEqual([0.5, -0.25, 0.8])
    expect(l.preset).toBe('custom')
  })
  it('picking a tint colour gives it a visible amount straight away, but never overrides one you set', () => {
    render(<MaterialLookPanel />)
    fireEvent.change(screen.getByLabelText('Tint colour'), { target: { value: '#ff8800' } })
    expect(useStore.getState().materialLook.tint).toBe('#ff8800')
    expect(useStore.getState().materialLook.tintAmount).toBe(0.5)
    fireEvent.change(slider('Tint amount'), { target: { value: '0.9' } })
    fireEvent.change(screen.getByLabelText('Tint colour'), { target: { value: '#0088ff' } })
    expect(useStore.getState().materialLook.tintAmount).toBe(0.9)
  })
  it('Reset adjustments clears just the adjustments', () => {
    useStore.setState({ materialLook: { ...presetLookFor('noir'), contrast: 0.4, tint: '#ff0000', tintAmount: 0.5 } })
    render(<MaterialLookPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset adjustments' }))
    const l = useStore.getState().materialLook
    expect([l.contrast, l.brightness, l.saturation, l.tintAmount, l.tint]).toEqual([0, 0, 0, 0, '#ffffff'])
    expect(l.colour).toBe('noir') // the rest of the look stays
  })
  it('Reset adjustments is greyed out when there is nothing to reset', () => {
    render(<MaterialLookPanel />)
    expect(screen.getByRole('button', { name: 'Reset adjustments' }).disabled).toBe(true)
  })
  it('the tone dropdown has the extra counts', () => {
    render(<MaterialLookPanel />)
    const options = [...screen.getByLabelText('Colour tones').querySelectorAll('option')].map((o) => o.textContent)
    expect(options).toEqual(['Off', '2 tones', '3 tones', '4 tones', '5 tones', '6 tones', '8 tones', '10 tones', '12 tones'])
  })
})
