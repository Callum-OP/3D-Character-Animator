import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('../three/poseLibraryActions.js', () => ({
  applyBodyEntry: vi.fn().mockResolvedValue({ applied: 3, skipped: 0, label: 'Wave' }),
  applyHandEntry: vi.fn().mockResolvedValue({ applied: 15, label: 'Fist' }),
  applyAnimationEntry: vi.fn(),
  saveCurrentBodyPose: vi.fn().mockResolvedValue({ name: 'Mine1' }),
  saveCurrentHandPose: vi.fn(),
  saveClipToLibrary: vi.fn(),
  BASIC_HANDS: [
    { id: 'open', name: 'Open hand', curl: {}, spread: 0 },
    { id: 'fist', name: 'Fist', curl: {}, spread: 0 },
  ],
  beginHandAdjust: vi.fn(), setHandCurl: vi.fn(), endHandAdjust: vi.fn(),
}))
vi.mock('../three/poseLibraryPresets.js', () => ({ listPresets: () => [], presetThumb: async () => ({ segs: [] }) }))

const PoseLibrary = (await import('../panels/PoseLibrary.jsx')).default
const actions = await import('../three/poseLibraryActions.js')
const store = await import('../three/poseLibraryStore.js')
const { useStore } = await import('../store.js')

beforeEach(async () => {
  cleanup()
  for (const e of await store.listEntries()) await store.deleteEntry(e.id)
  useStore.setState({ poseLibraryTab: null, modelInfo: { name: 'x' } })
})

describe('Pose Library panel', () => {
  it('is hidden until opened from the menu', () => {
    const { container } = render(<PoseLibrary />)
    expect(container.firstChild).toBeNull()
  })

  it('shows empty-folder guidance for presets and applies a saved pose on click', async () => {
    await store.putEntry({ kind: 'body', name: 'Wave', thumb: { segs: [[10, 10, 50, 50]] }, data: { bones: {} } })
    useStore.setState({ poseLibraryTab: 'body' })
    render(<PoseLibrary />)
    fireEvent.click(await screen.findByTitle('Apply “Wave”'))
    await waitFor(() => expect(actions.applyBodyEntry).toHaveBeenCalled())
    expect(actions.applyBodyEntry.mock.calls[0][1]).toEqual({ keepHands: true })
    expect(await screen.findByText(/Applied “Wave”/)).toBeTruthy()
  })

  it('searches by name', async () => {
    await store.putEntry({ kind: 'body', name: 'Wave', data: { bones: {} } })
    await store.putEntry({ kind: 'body', name: 'Bow', data: { bones: {} } })
    useStore.setState({ poseLibraryTab: 'body' })
    render(<PoseLibrary />)
    await screen.findByTitle('Apply “Bow”')
    fireEvent.change(screen.getByPlaceholderText(/Search body/), { target: { value: 'wav' } })
    expect(screen.queryByTitle('Apply “Bow”')).toBeNull()
    expect(screen.getByTitle('Apply “Wave”')).toBeTruthy()
  })

  it('hand tab offers the built-in hands, side and strength', async () => {
    useStore.setState({ poseLibraryTab: 'hand' })
    render(<PoseLibrary />)
    fireEvent.click((await screen.findAllByText('Left'))[0])
    fireEvent.click(await screen.findByTitle('Apply “Fist”'))
    await waitFor(() => expect(actions.applyHandEntry).toHaveBeenCalled())
    expect(actions.applyHandEntry.mock.calls.at(-1)[1]).toEqual({ side: 'L', amount: 1 })
  })

  it('keeps import / export out of sight until the dots are opened', async () => {
    useStore.setState({ poseLibraryTab: 'body' })
    render(<PoseLibrary />)
    expect(screen.queryByText('Export library')).toBeNull()
    fireEvent.click(screen.getByLabelText('More options'))
    expect(screen.getByText('Export library')).toBeTruthy()
    expect(screen.getByText('Import library')).toBeTruthy()
  })

  it('switches tabs and closes with Escape', async () => {
    useStore.setState({ poseLibraryTab: 'body' })
    const { container } = render(<PoseLibrary />)
    fireEvent.click(screen.getByText('Animation'))
    expect(useStore.getState().poseLibraryTab).toBe('animation')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useStore.getState().poseLibraryTab).toBeNull()
    await waitFor(() => expect(container.firstChild).toBeNull())
  })
})
