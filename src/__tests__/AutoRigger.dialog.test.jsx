import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import AutoRiggerDialog from '../panels/AutoRiggerDialog.jsx'
import { useStore } from '../store.js'
import { summariseRigReport, autoRigAvailable } from '../three/autoRig.js'

afterEach(() => {
  cleanup()
  delete window.animare
  useStore.getState().setAutoRiggerOpen(false)
})

describe('Auto Rigger dialog', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<AutoRiggerDialog />)
    expect(container.firstChild).toBeNull()
  })
  it('explains that it needs the desktop app when there is no bridge (web / itch.io)', () => {
    expect(autoRigAvailable()).toBe(false)
    render(<AutoRiggerDialog />)
    act(() => useStore.getState().setAutoRiggerOpen(true))
    expect(screen.getByText(/only available in the desktop app/i)).toBeTruthy()
    expect(screen.queryByText('Rig character')).toBeNull()
  })
  it('shows the rigging controls when the desktop bridge exists, and closes', () => {
    window.animare = { autoRig: { run: async () => ({ ok: false }) } }
    render(<AutoRiggerDialog />)
    act(() => useStore.getState().setAutoRiggerOpen(true))
    expect(screen.getByText('Choose a file…')).toBeTruthy()
    expect(screen.getByText(/From the scene/)).toBeTruthy() // pick something already in the app
    expect(screen.getByTitle('Undo (Ctrl+Z)').disabled).toBe(true) // nothing to undo yet
    expect(screen.getByTitle('Zoom out (−)').disabled).toBe(true) // no model yet
    const rig = screen.getByText('Rig character')
    expect(rig.disabled).toBe(true) // nothing to rig until a model is chosen
    act(() => screen.getByTitle('Close').click())
    expect(useStore.getState().autoRiggerOpen).toBe(false)
  })
})

describe('summariseRigReport', () => {
  const report = {
    bones: 22,
    components: new Array(20).fill({}),
    rigid_bindings: [{}, {}, {}],
    weights: { unweighted_vertices: 0, max_influences: 4 },
    symmetry: { applied: true, coverage: 0.907 },
    pose_check: {
      knees_bent_90: { min_volume_ratio: 0.97, max_edge_stretch: 1.25, stretched_edges: 0 },
      hips_flexed_70: { min_volume_ratio: 0.78, max_edge_stretch: 2.06, stretched_edges: 0 },
    },
  }
  it('reports measured numbers and the worst pose', () => {
    const text = summariseRigReport(report)
    expect(text).toMatch(/22 bones, 20 parts \(3 bound rigidly\)/)
    expect(text).toMatch(/0 unweighted vertices, at most 4 influences/)
    expect(text).toMatch(/applied \(91%/)
    expect(text).toMatch(/worst volume 78% of rest \(hips flexed 70\)/)
    expect(text).not.toMatch(/Warning/)
  })
  it('warns when edges stretched in a test pose', () => {
    const bad = { ...report, pose_check: { arms: { min_volume_ratio: 0.9, max_edge_stretch: 4, stretched_edges: 7 } } }
    expect(summariseRigReport(bad)).toMatch(/Warning: 7 edges/)
  })
  it('copes with an empty report', () => {
    expect(summariseRigReport({})).toBe('Rigged.')
  })
})
