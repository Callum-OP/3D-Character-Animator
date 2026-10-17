import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import React from 'react'
import { BlenderSettings } from '../panels/ViewPanel.jsx'

afterEach(() => {
  cleanup()
  delete window.animare
})

const bridge = (status) => ({
  status: vi.fn(async () => status),
  choose: vi.fn(async () => ({ available: true, version: '4.2.0', path: 'C:\\Blender\\blender.exe', source: 'chosen' })),
  clear: vi.fn(async () => ({ available: true, version: '4.0.2', path: '/usr/bin/blender', source: 'system' })),
})

describe('Blender settings (desktop app only)', () => {
  it('shows nothing in the browser build', () => {
    const { container } = render(<BlenderSettings />)
    expect(container.textContent).toBe('')
  })

  it('shows where Blender was found', async () => {
    window.animare = { blender: bridge({ available: true, version: '4.0.2', path: '/usr/bin/blender', source: 'system' }) }
    render(<BlenderSettings />)
    expect(await screen.findByText(/Found Blender 4\.0\.2/)).toBeTruthy()
    expect(screen.getByText(/\/usr\/bin\/blender/)).toBeTruthy()
  })

  it('says so when Blender is not installed', async () => {
    window.animare = { blender: bridge({ available: false, path: null, version: null }) }
    render(<BlenderSettings />)
    expect(await screen.findByText(/Blender not found/)).toBeTruthy()
    expect(screen.queryByText('Auto-detect')).toBeNull()
  })

  it('says so when Blender is too old', async () => {
    window.animare = { blender: bridge({ available: false, tooOld: true, path: '/b', version: '2.79' }) }
    render(<BlenderSettings />)
    expect(await screen.findByText(/2\.79 is too old/)).toBeTruthy()
  })

  it('"Choose Blender…" asks the app for a path and shows the result; Auto-detect then appears', async () => {
    const b = bridge({ available: false, path: null, version: null })
    window.animare = { blender: b }
    render(<BlenderSettings />)
    await screen.findByText(/Blender not found/)
    fireEvent.click(screen.getByText('Choose Blender…'))
    expect(await screen.findByText(/Found Blender 4\.2\.0/)).toBeTruthy()
    expect(b.choose).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Auto-detect')).toBeTruthy()
  })

  it('a pick that was not Blender shows the reason', async () => {
    const b = bridge({ available: false, path: null, version: null })
    b.choose = vi.fn(async () => ({ available: false, path: null, error: 'That does not look like Blender.' }))
    window.animare = { blender: b }
    render(<BlenderSettings />)
    await screen.findByText(/Blender not found/)
    fireEvent.click(screen.getByText('Choose Blender…'))
    expect((await screen.findByRole('alert')).textContent).toMatch(/does not look like Blender/)
  })

  it('"Auto-detect" forgets the chosen path', async () => {
    const b = bridge({ available: true, version: '4.2.0', path: 'C:\\Blender\\blender.exe', source: 'chosen' })
    window.animare = { blender: b }
    render(<BlenderSettings />)
    fireEvent.click(await screen.findByText('Auto-detect'))
    await waitFor(() => expect(b.clear).toHaveBeenCalled())
    expect(await screen.findByText(/Found Blender 4\.0\.2/)).toBeTruthy()
  })
})
