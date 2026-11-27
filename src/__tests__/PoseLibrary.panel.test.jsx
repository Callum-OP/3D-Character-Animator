import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('../three/poseLibraryActions.js', () => ({
  applyBodyEntry: vi.fn().mockResolvedValue({ applied: 3, skipped: 0, label: 'Wave' }),
  applyHandEntry: vi.fn().mockResolvedValue({ applied: 15, label: 'Fist' }),
  applyAnimationEntry: vi.fn().mockResolvedValue({ name: 'Walk (2)' }),
  beginManualRetarget: vi.fn(),
  canRetargetManually: (entry) => entry?.kind === 'body' || entry?.kind === 'animation',
  saveCurrentBodyPose: vi.fn().mockResolvedValue({ name: 'Mine1' }),
  saveCurrentHandPose: vi.fn(),
  saveClipToLibrary: vi.fn(),
  backfillAnimationThumb: vi.fn(async (entry) => entry),
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
  useStore.setState({ poseLibraryTab: null, modelInfo: { name: 'x' }, qualityPreset: 'standard' })
})

describe('Pose Library panel', () => {
  it('Animation tab can send you to Pose Finder, and closes the library', async () => {
    const onOpenPoseFinder = vi.fn()
    useStore.setState({ poseLibraryTab: 'animation' })
    render(<PoseLibrary onOpenPoseFinder={onOpenPoseFinder} />)
    fireEvent.click(await screen.findByText('Make from video…'))
    expect(onOpenPoseFinder).toHaveBeenCalledTimes(1)
    expect(useStore.getState().poseLibraryTab).toBeNull()
  })

  it('only offers Make from video… on the Animation tab', async () => {
    useStore.setState({ poseLibraryTab: 'body' })
    render(<PoseLibrary onOpenPoseFinder={() => {}} />)
    await screen.findByText('Save current pose')
    expect(screen.queryByText('Make from video…')).toBeNull()
  })

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

  it('offers rendered model cards as an option', async () => {
    useStore.setState({ poseLibraryTab: 'body' })
    render(<PoseLibrary />)
    const option = screen.getByRole('checkbox', { name: 'Rendered cards' })
    expect(option.checked).toBe(true)
    fireEvent.click(option)
    expect(option.checked).toBe(false)
  })

  it('defaults rendered cards off only for Potato quality and follows quality changes', async () => {
    useStore.setState({ poseLibraryTab: 'body', qualityPreset: 'verylow' })
    render(<PoseLibrary />)
    const option = screen.getByRole('checkbox', { name: 'Rendered cards' })
    expect(option.checked).toBe(false)

    useStore.setState({ qualityPreset: 'low' })
    await waitFor(() => expect(option.checked).toBe(true))
    useStore.setState({ qualityPreset: 'verylow' })
    await waitFor(() => expect(option.checked).toBe(false))
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

  describe('right-click menu', () => {
    const mapping = () => ({
      name: 'Wave',
      sourceBones: ['Hips', 'Spine'],
      targetBones: ['mixamorig:Hips', 'mixamorig:Spine'],
      slots: [{ key: 'hips', label: 'Hips', target: 'mixamorig:Hips', source: 'Hips', guessed: false }],
    })

    it('offers Apply and Retarget manually on a body pose, plus Delete on your own', async () => {
      await store.putEntry({ kind: 'body', name: 'Wave', data: { bones: {} } })
      useStore.setState({ poseLibraryTab: 'body' })
      render(<PoseLibrary />)
      fireEvent.contextMenu(await screen.findByTitle('Apply “Wave”'))
      expect(await screen.findByText('Apply')).toBeTruthy()
      expect(screen.getByText('Retarget manually…')).toBeTruthy()
      expect(screen.getByText('Delete')).toBeTruthy()
    })

    it('has no Retarget option on hand poses', async () => {
      useStore.setState({ poseLibraryTab: 'hand' })
      render(<PoseLibrary />)
      fireEvent.contextMenu(await screen.findByTitle('Apply “Fist”'))
      expect(await screen.findByText('Apply')).toBeTruthy()
      expect(screen.queryByText('Retarget manually…')).toBeNull()
    })

    it('opens the bone-mapping editor and applies the pose with the edited mapping', async () => {
      await store.putEntry({ kind: 'body', name: 'Wave', data: { bones: {} } })
      actions.beginManualRetarget.mockResolvedValue(mapping())
      useStore.setState({ poseLibraryTab: 'body' })
      render(<PoseLibrary />)
      fireEvent.contextMenu(await screen.findByTitle('Apply “Wave”'))
      fireEvent.click(await screen.findByText('Retarget manually…'))
      expect(await screen.findByText(/bones → this rig/)).toBeTruthy()
      expect(actions.applyBodyEntry).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ slots: expect.anything() }))

      fireEvent.change(screen.getByTitle('Source bone'), { target: { value: 'Spine' } })
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      await waitFor(() => expect(actions.applyBodyEntry).toHaveBeenCalled())
      const [entry, opts] = actions.applyBodyEntry.mock.calls.at(-1)
      expect(entry.name).toBe('Wave')
      expect(opts.keepHands).toBe(true)
      expect(opts.slots[0]).toMatchObject({ key: 'hips', target: 'mixamorig:Hips', source: 'Spine' })
      await waitFor(() => expect(screen.queryByText(/bones → this rig/)).toBeNull())
      expect(await screen.findByText(/with your bone mapping/)).toBeTruthy()
    })

    it('Escape backs out of the editor without closing the library', async () => {
      await store.putEntry({ kind: 'animation', name: 'Walk', data: { clip: {}, rig: {} } })
      actions.beginManualRetarget.mockResolvedValue(mapping())
      useStore.setState({ poseLibraryTab: 'animation' })
      render(<PoseLibrary />)
      fireEvent.contextMenu(await screen.findByTitle('Apply “Walk”'))
      fireEvent.click(await screen.findByText('Retarget manually…'))
      await screen.findByText(/bones → this rig/)
      fireEvent.keyDown(window, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByText(/bones → this rig/)).toBeNull())
      expect(useStore.getState().poseLibraryTab).toBe('animation')
    })

    it('shows why mapping could not start instead of opening an empty editor', async () => {
      await store.putEntry({ kind: 'body', name: 'Old', data: { bones: {} } })
      actions.beginManualRetarget.mockRejectedValue(new Error('This older library entry has no source rig.'))
      useStore.setState({ poseLibraryTab: 'body' })
      render(<PoseLibrary />)
      fireEvent.contextMenu(await screen.findByTitle('Apply “Old”'))
      fireEvent.click(await screen.findByText('Retarget manually…'))
      expect(await screen.findByText(/no source rig/)).toBeTruthy()
      expect(screen.queryByText(/bones → this rig/)).toBeNull()
    })
  })
})
