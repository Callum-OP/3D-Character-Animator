import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { existsSync, readFileSync } from 'node:fs'
import TitleBar from '../panels/TitleBar.jsx'
import { PRIVACY_POLICY_URL } from '../links.js'

afterEach(cleanup)

describe('Privacy policy', () => {
  it('ships with the app (public/ is copied into the build) and is a real page', () => {
    expect(existsSync('public/privacy.html')).toBe(true)
    expect(readFileSync('public/privacy.html', 'utf8')).toMatch(/Privacy Policy/)
    expect(PRIVACY_POLICY_URL).toMatch(/^https:\/\/.+\/privacy\.html$/)
  })

  it('is reachable from the Help menu and opens in the browser, not in-app', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<TitleBar />)
    fireEvent.click(screen.getByText('Help'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Privacy Policy' }))
    expect(open).toHaveBeenCalledWith(PRIVACY_POLICY_URL, '_blank', 'noopener,noreferrer')
    open.mockRestore()
  })
})
