import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import React from 'react'
import Accordion, { openAccordion, forgetAccordionStates } from '../panels/Accordion.jsx'

afterEach(() => {
  cleanup()
  forgetAccordionStates()
})

describe('openAccordion (used by the title bar)', () => {
  it('opens a section that is on screen', () => {
    render(<Accordion id="animate-test" title="Animate"><p>clip tools</p></Accordion>)
    expect(screen.queryByText('clip tools')).toBeNull()
    act(() => openAccordion('animate-test', { scroll: false }))
    expect(screen.getByText('clip tools')).toBeTruthy()
  })

  it('a remembered sub-section that is not mounted yet starts open when it appears', () => {
    act(() => openAccordion('export-model-test', { scroll: false }))
    render(<Accordion id="export-model-test" remember title="Export 3D model"><p>formats</p></Accordion>)
    expect(screen.getByText('formats')).toBeTruthy()
  })

  it('ignores a section that does not exist', () => {
    expect(() => openAccordion('nope', { scroll: false })).not.toThrow()
  })
})
