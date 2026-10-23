import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import MaterialLookPanel from '../panels/MaterialLookPanel.jsx'
import MaterialPanel from '../panels/MaterialPanel.jsx'
import { useStore } from '../store.js'
import { TEXTURE_LOOK_DEFAULT, TEXTURE_LOOK_PRESETS } from '../three/textureLookOptions.js'

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
    expect(useStore.getState().materialLook.detail).toBe('smooth')
    expect(useStore.getState().materialLook.colour).toBe('vivid')
  })

  it('a preset fills the controls, and changing one by hand clears the preset highlight', () => {
    render(<MaterialLookPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Flat colours' }))
    expect(screen.getByLabelText('Texture detail').value).toBe('flat')
    fireEvent.change(screen.getByLabelText('Colours'), { target: { value: 'sepia' } })
    expect(useStore.getState().materialLook.colour).toBe('sepia')
    expect(useStore.getState().materialLook.detail).toBe('flat') // rest unchanged
    expect(screen.getByRole('button', { name: 'Flat colours' }).getAttribute('aria-pressed')).toBe('false')
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
