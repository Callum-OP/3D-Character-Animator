import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { NightPanel } from '../panels/ShadowPanel.jsx'
import { useStore } from '../store.js'
import { DEFAULT_NIGHT } from '../three/shadowSettings.js'

beforeEach(() => useStore.setState({ night: { ...DEFAULT_NIGHT } }))
afterEach(cleanup)

const box = () => screen.getByRole('checkbox', { name: /Night also dims placed lights/ })

describe('Night mode: placed lights switch', () => {
  it('is off by default, so placed lights keep shining', () => {
    render(<NightPanel />)
    expect(box().checked).toBe(false)
  })
  it('is greyed out until Night mode itself is on', () => {
    render(<NightPanel />)
    expect(box().disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /Night mode/i }))
    expect(box().disabled).toBe(false)
  })
  it('turns the dimming of placed lights on and off, and keeps the rest of the night settings', () => {
    useStore.setState({ night: { ...DEFAULT_NIGHT, enabled: true, strength: 0.8 } })
    render(<NightPanel />)
    fireEvent.click(box())
    expect(useStore.getState().night.affectLights).toBe(true)
    expect(useStore.getState().night.strength).toBe(0.8)
    expect(useStore.getState().night.enabled).toBe(true)
    fireEvent.click(box())
    expect(useStore.getState().night.affectLights).toBe(false)
  })
  it('explains itself on hover', () => {
    render(<NightPanel />)
    expect(box().closest('label').getAttribute('title')).toMatch(/still works in total darkness/)
  })
})
