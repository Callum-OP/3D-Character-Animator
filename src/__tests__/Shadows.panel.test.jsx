import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import ShadowPanel from '../panels/ShadowPanel.jsx'
import { useStore } from '../store.js'
import { DEFAULT_SHADOWS, SHADOW_STYLES, detectShadowStyle } from '../three/shadowSettings.js'

// The Shadows panel runs against the REAL store (no mocks). The previous system lost every
// style button because the panel called store setters that did not exist; this keeps the panel
// and the store honest with each other.

beforeEach(() => {
  useStore.setState({ shadows: { ...DEFAULT_SHADOWS } })
})
afterEach(cleanup)

describe('Shadows panel', () => {
  it('starts on the realistic default with that style highlighted', () => {
    render(<ShadowPanel />)
    expect(screen.getByRole('button', { name: 'Realistic' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText(/Contact-hardening/).checked).toBe(true)
  })

  it('every style button changes the real store values', () => {
    render(<ShadowPanel />)
    for (const st of SHADOW_STYLES) {
      fireEvent.click(screen.getByRole('button', { name: st.label }))
      const s = useStore.getState().shadows
      expect(detectShadowStyle(s)).toBe(st.id)
      expect(s.size).toBe(st.size)
      expect(s.darkness).toBe(st.darkness)
      expect(s.contact).toBe(st.contact)
      expect(screen.getByRole('button', { name: st.label }).getAttribute('aria-pressed')).toBe('true')
    }
  })

  it('moving a control by hand un-highlights the style ("Custom")', () => {
    render(<ShadowPanel />)
    fireEvent.click(screen.getByLabelText(/Contact-hardening/))
    expect(useStore.getState().shadows.contact).toBe(false)
    for (const st of SHADOW_STYLES) {
      expect(screen.getByRole('button', { name: st.label }).getAttribute('aria-pressed')).toBe('false')
    }
    expect(screen.getByText(/Custom/)).toBeTruthy()
  })

  it('light size and darkness sliders write to the store', () => {
    render(<ShadowPanel />)
    const [size, darkness] = screen.getAllByRole('slider')
    fireEvent.change(size, { target: { value: '12' } })
    expect(useStore.getState().shadows.size).toBe(12)
    fireEvent.change(darkness, { target: { value: '0.8' } })
    expect(useStore.getState().shadows.darkness).toBe(0.8)
  })

  it('quality, on/off and colour all work, and the blob locks the styled controls', () => {
    const { container } = render(<ShadowPanel />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'blob' } })
    expect(useStore.getState().shadows.quality).toBe('blob')
    expect(screen.getByRole('button', { name: 'Realistic' }).disabled).toBe(true)
    expect(screen.getByLabelText(/Contact-hardening/).disabled).toBe(true)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ultra' } })
    expect(screen.getByRole('button', { name: 'Realistic' }).disabled).toBe(false)

    fireEvent.change(container.querySelector('input[type="color"]'), { target: { value: '#335577' } })
    expect(useStore.getState().shadows.tint).toBe('#335577')

    fireEvent.click(screen.getByLabelText('Shadows'))
    expect(useStore.getState().shadows.enabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Realistic' }).disabled).toBe(true)
  })

  it('"Reset to realistic default" restores everything', () => {
    render(<ShadowPanel />)
    act(() => useStore.getState().setShadows({ size: 20, darkness: 0.1, contact: false, quality: 'low', tint: '#ff0000', enabled: false }))
    const reset = screen.getByRole('button', { name: /Reset to realistic default/ })
    expect(reset.disabled).toBe(false)
    fireEvent.click(reset)
    expect(useStore.getState().shadows).toEqual(DEFAULT_SHADOWS)
    expect(screen.getByRole('button', { name: /Reset to realistic default/ }).disabled).toBe(true)
  })
})
