import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import MaterialPanel from '../panels/MaterialPanel.jsx'

afterEach(cleanup)

describe('Look panel layout', () => {
  it('lists Studio and Realistic modes and presets, with Shadows, then Depth & edge light, then Outline at the end', () => {
    const { container, getByText } = render(<MaterialPanel />)
    const labels = [...container.querySelectorAll('.radio-label')].map((n) => n.textContent)
    expect(labels).toEqual(expect.arrayContaining(['Studio', 'Realistic']))
    const presets = [...container.querySelectorAll('.preset-row')[0].querySelectorAll('button')].map((b) => b.textContent)
    expect(presets).toEqual(expect.arrayContaining(['Realistic', 'Studio']))
    expect(presets).not.toContain('Toy / Figure')
    const sums = [...container.querySelectorAll('details > summary')].map((n) => n.textContent)
    const i = (t) => sums.indexOf(t)
    expect(i('Shadows')).toBeGreaterThan(-1)
    expect(i('Night mode')).toBe(i('Shadows') + 1)
    expect(i('Depth & edge light')).toBe(i('Night mode') + 1)
    expect(i('Outline')).toBe(i('Depth & edge light') + 1)
    expect(container.textContent).not.toMatch(/blender/i)
    expect(getByText(/Studio environment lighting/)).toBeTruthy()
  })
})
