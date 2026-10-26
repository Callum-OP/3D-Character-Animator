import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../store.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory, runWithoutHistoryCapture, hasUndoHistory } from '../three/undoHistory.js'
import { pushSceneHistory } from '../three/sceneHistory.js'
import { LOOK_HISTORY_KEYS } from '../three/lookHistory.js'
import { TEXTURE_LOOK_DEFAULT } from '../three/textureLookOptions.js'

const st = () => useStore.getState()
const undo = () => performUndo(st())
const redo = () => performRedo(st())
// each test gesture is its own step unless it happens inside the coalescing window
const later = (ms = 1000) => vi.setSystemTime(Date.now() + ms)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-24T12:00:00Z'))
  useStore.setState({
    materialMode: 'standard', toonSteps: 3, colorGrading: 'none', lightIntensity: 1, outlineEnabled: true,
    softenEnabled: false, rimSoftIntensity: 0.5, materialLook: { ...TEXTURE_LOOK_DEFAULT }, selectedObjectId: null,
  })
  clearUndoHistory()
})
afterEach(() => vi.useRealTimers())

describe('undo / redo of the Look panel', () => {
  it('covers the Material tab: a preset, then a hand change, each undo and redo', () => {
    st().applyMaterialLookPreset('toonsmooth')
    later()
    st().setMaterialLook({ bands: 3 })
    expect(st().materialLook.bands).toBe(3)

    undo()
    expect(st().materialLook.bands).toBe(8) // back to the preset
    expect(st().materialLook.preset).toBe('toonsmooth')
    undo()
    expect(st().materialLook).toEqual(TEXTURE_LOOK_DEFAULT) // back to the original materials

    redo()
    expect(st().materialLook.preset).toBe('toonsmooth')
    redo()
    expect(st().materialLook.bands).toBe(3)
    expect(st().materialLook.preset).toBe('custom')
  })

  it('covers the Lighting tab: style, toon steps, grading, outline, rim', () => {
    st().setMaterialMode('toon')
    later()
    st().setToonSteps(5)
    later()
    st().setColorGrading('bleach')
    later()
    st().setOutlineEnabled(false)
    later()
    st().setRimSoftIntensity(0.9)

    undo()
    expect(st().rimSoftIntensity).toBe(0.5)
    undo()
    expect(st().outlineEnabled).toBe(true)
    undo()
    expect(st().colorGrading).toBe('none')
    undo()
    expect(st().toonSteps).toBe(3)
    undo()
    expect(st().materialMode).toBe('standard')

    redo()
    redo()
    expect(st().materialMode).toBe('toon')
    expect(st().toonSteps).toBe(5)
  })

  it('a Lighting preset (many settings at once) is a single step', () => {
    st().applyStylePreset({ materialMode: 'toon', toonSteps: 2, colorGrading: 'cinematic', outlineEnabled: false, shadowStyle: 'soft' })
    expect(st().materialMode).toBe('toon')
    undo()
    expect(st().materialMode).toBe('standard')
    expect(st().toonSteps).toBe(3)
    expect(st().colorGrading).toBe('none')
    expect(st().outlineEnabled).toBe(true)
    expect(hasUndoHistory()).toBe(true) // (the redo)
    redo()
    expect(st().colorGrading).toBe('cinematic')
  })

  it('dragging a slider is one step, not one per pixel', () => {
    for (const v of [1.1, 1.3, 1.6, 1.9, 2.2]) {
      st().setLightIntensity(v)
      later(40)
    }
    undo()
    expect(st().lightIntensity).toBe(1)
    redo()
    expect(st().lightIntensity).toBe(2.2)
  })

  it('separate adjustments, moments apart, are separate steps', () => {
    st().setLightIntensity(1.5)
    later(900)
    st().setLightIntensity(2)
    undo()
    expect(st().lightIntensity).toBe(1.5)
    undo()
    expect(st().lightIntensity).toBe(1)
  })

  it('undoing one setting never rolls back another', () => {
    st().setColorGrading('warm')
    later()
    st().setToonSteps(4)
    later()
    st().setColorGrading('cool')
    undo() // grading only
    expect(st().colorGrading).toBe('warm')
    expect(st().toonSteps).toBe(4)
  })

  it('a setting first touched mid-gesture is undone to the value it had then', () => {
    st().setLightIntensity(1.2)
    later(50)
    st().setToonSteps(7) // joins the same gesture
    undo()
    expect(st().lightIntensity).toBe(1)
    expect(st().toonSteps).toBe(3)
  })

  it('goes back in order alongside the other kinds of undo', () => {
    const calls = []
    st().setColorGrading('warm')
    later()
    pushSceneHistory(() => calls.push('scene undo'), () => calls.push('scene redo'))
    later()
    st().setToonSteps(6)

    undo() // newest first: the toon steps
    expect(st().toonSteps).toBe(3)
    expect(calls).toEqual([])
    undo() // then the scene edit
    expect(calls).toEqual(['scene undo'])
    expect(st().colorGrading).toBe('warm')
    undo() // then the grading
    expect(st().colorGrading).toBe('none')
  })

  it('undo and redo themselves leave no extra steps behind', () => {
    st().setColorGrading('warm')
    undo()
    redo()
    undo()
    redo()
    undo()
    expect(st().colorGrading).toBe('none')
    undo() // nothing left: harmless
    expect(st().colorGrading).toBe('none')
  })

  it('a new change after an undo drops the old redo branch', () => {
    st().setColorGrading('warm')
    later()
    undo()
    later()
    st().setColorGrading('cool')
    redo() // nothing to redo any more
    expect(st().colorGrading).toBe('cool')
  })

  it('ignores things that are not Look settings, and changes made with capture suspended', () => {
    st().setSelectedObjectId?.(null)
    useStore.setState({ currentTime: 3 })
    expect(hasUndoHistory()).toBe(false)
    runWithoutHistoryCapture(() => st().setColorGrading('warm'))
    expect(hasUndoHistory()).toBe(false)
    expect(st().colorGrading).toBe('warm')
  })

  it('the keys it watches include both tabs', () => {
    expect(LOOK_HISTORY_KEYS).toEqual(expect.arrayContaining(['materialLook', 'materialMode', 'colorGrading', 'outlineEnabled', 'rimHardWidth', 'shadows']))
  })
})
