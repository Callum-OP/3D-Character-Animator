import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from '../store.js'
import { getProjectData, applyProjectData, clearProjectScene } from '../three/scene.js'

describe('Stop at first clip end is saved with the project', () => {
  beforeEach(() => {
    useStore.setState({ stopAtFirstClipEnd: false })
  })

  it('is written into the project settings', () => {
    useStore.setState({ stopAtFirstClipEnd: true })
    expect(getProjectData().settings.stopAtFirstClipEnd).toBe(true)
    useStore.setState({ stopAtFirstClipEnd: false })
    expect(getProjectData().settings.stopAtFirstClipEnd).toBe(false)
  })

  it('is restored when the project is opened again', async () => {
    useStore.setState({ stopAtFirstClipEnd: true })
    const saved = getProjectData()
    useStore.setState({ stopAtFirstClipEnd: false })
    await applyProjectData(saved)
    expect(useStore.getState().stopAtFirstClipEnd).toBe(true)
  })

  it('opens OFF for a project saved without it, instead of inheriting the previous project\'s', async () => {
    useStore.setState({ stopAtFirstClipEnd: false })
    const saved = getProjectData()
    delete saved.settings.stopAtFirstClipEnd
    useStore.setState({ stopAtFirstClipEnd: true })
    await applyProjectData(saved)
    expect(useStore.getState().stopAtFirstClipEnd).toBe(false)
  })

  it('New Project resets it', () => {
    useStore.setState({ stopAtFirstClipEnd: true })
    clearProjectScene()
    expect(useStore.getState().stopAtFirstClipEnd).toBe(false)
  })
})
