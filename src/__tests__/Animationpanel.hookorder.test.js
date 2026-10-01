import { describe, it, vi, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'

// Regression test for a real black-screen crash: AnimationPanel used to call
// three useEffect hooks AFTER an early `if (!modelInfo) return null` (and a
// second early return just below it). React requires every hook to run on
// every render of a given component instance — AnimationPanel stays mounted
// regardless of whether a character is loaded (unlike BonePanel/MeshPanel,
// which unmount via their own Accordion's `mode === …` condition in
// App.jsx), so the moment it re-rendered with modelInfo going from set to
// null on the SAME instance — e.g. pressing Clear, or the brief
// no-character moment partway through reopening a saved project — React
// threw "Minified React error #300: Rendered fewer hooks than expected",
// which (with no boundary around anything but the 3D viewport, at the time)
// took the whole app down to a blank screen. This only shows up with the
// Animate accordion actually open, since Accordion doesn't mount its
// children at all while collapsed (see Accordion.jsx) — that's why this
// wasn't caught by the AnimationPanel.hookorder eslint check alone; this
// test exercises the actual mount/unmount sequence end to end.

vi.mock('../three/Viewport.jsx', () => ({
  default: () => React.createElement('div', { 'data-testid': 'viewport-stub' }),
}))

import App from '../App.jsx'
import { useStore } from '../store.js'

describe('AnimationPanel stays mounted across modelInfo going to null', () => {
  it('does not crash the app when Clear is pressed with the Animate panel open', async () => {
    useStore.setState({
      modelInfo: { name: 'TestChar', bones: [{ name: 'Hips', deform: true }], meshCount: 1, boneCount: 1, clipNames: ['Walk'] },
      mode: 'bone',
      sceneObjects: [],
    })
    render(React.createElement(App))

    // Open the Animate accordion — its children (AnimationPanel) only mount
    // once it's open (Accordion.jsx renders `{open && children}`).
    fireEvent.click(screen.getByText('Animate'))

    // Open File > Clear, same as the user's reported steps.
    fireEvent.click(screen.getByText('File'))
    const clearBtn = screen.getAllByText('Clear').find((el) => el.getAttribute('role') === 'menuitem')
    window.confirm = () => true
    fireEvent.click(clearBtn)
    await new Promise((r) => setTimeout(r, 50))

    // The real symptom: the app-level crash screen should never appear.
    expect(screen.queryByText('Something went wrong')).toBeNull()
    expect(useStore.getState().modelInfo).toBeNull()
  })
})