import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import * as THREE from 'three'

vi.mock('../three/scene.js', () => ({ applyModelMaterials: vi.fn(), getObjectRootById: () => null }))

import { useStore } from '../store.js'
import { recordOverrideEdit } from '../three/materialHistory.js'
import { undoScene, redoScene } from '../three/sceneHistory.js'
import { clearUndoHistory, getHistorySequence } from '../three/undoHistory.js'
import {
  initLights, addLight, getLightById, setLightColor, setLightIntensity, setLightCastShadow, setLightDirectional,
  setLightRange, setLightCone, applyLightPreset, lightDataForPreset, getLightShape, getLightsData, applyLightsData,
  LIGHT_PRESETS,
} from '../three/lights.js'

const overrides = () => useStore.getState().meshOverrides

describe('undo / redo of part looks', () => {
  beforeEach(() => {
    clearUndoHistory()
    useStore.setState({ meshOverrides: {} })
  })

  it('undoes and redoes a colour change', () => {
    recordOverrideEdit(['m1'], () => useStore.getState().setMeshesColor(['m1'], { color: '#ff0000' }))
    expect(overrides().m1.color).toBe('#ff0000')
    undoScene()
    expect(overrides().m1).toBeUndefined()
    redoScene()
    expect(overrides().m1.color).toBe('#ff0000')
  })

  it('undoes Material editor edits and regions', () => {
    recordOverrideEdit(['m1'], () => useStore.getState().setMeshesSlot([{ uuid: 'm1', slot: 0 }], { metalness: 1, roughness: 0.1 }))
    const regions = [{ id: 'a', name: 'Lamp', tris: [[0, 3]], look: { mode: 'solid', color: '#ff0000' } }]
    // a gap, so the two edits are separate steps
    clearUndoHistoryKeepOverrides()
    recordOverrideEdit(['m1'], () => useStore.getState().setMeshRegions('m1', regions))
    expect(overrides().m1.regions).toHaveLength(1)
    undoScene()
    expect(overrides().m1.regions).toBeUndefined()
    expect(overrides().m1.slots[0].metalness).toBe(1) // the earlier edit is still there
    redoScene()
    expect(overrides().m1.regions[0].name).toBe('Lamp')
  })

  function clearUndoHistoryKeepOverrides() {
    const keep = overrides()
    clearUndoHistory()
    useStore.setState({ meshOverrides: keep })
  }

  it('merges a slider drag into ONE undo step', () => {
    for (const v of [0.1, 0.2, 0.3, 0.4, 0.5]) {
      recordOverrideEdit(['m1'], () => useStore.getState().setMeshesSlot([{ uuid: 'm1', slot: 0 }], { roughness: v }))
    }
    expect(overrides().m1.slots[0].roughness).toBe(0.5)
    undoScene()
    expect(overrides().m1?.slots).toBeUndefined() // back to before the whole drag
    redoScene()
    expect(overrides().m1.slots[0].roughness).toBe(0.5)
  })

  it('edits to different parts are separate steps, and an edit that changes nothing records nothing', () => {
    recordOverrideEdit(['m1'], () => useStore.getState().setMeshesColor(['m1'], { color: '#111111' }))
    recordOverrideEdit(['m2'], () => useStore.getState().setMeshesColor(['m2'], { color: '#222222' }))
    const seq = getHistorySequence()
    recordOverrideEdit(['m2'], () => useStore.getState().setMeshesColor(['m2'], { color: '#222222' }))
    expect(getHistorySequence()).toBe(seq)
    undoScene()
    expect(overrides().m2).toBeUndefined()
    expect(overrides().m1.color).toBe('#111111')
  })

  it('restoring re-applies the materials', async () => {
    const { applyModelMaterials } = await import('../three/scene.js')
    applyModelMaterials.mockClear()
    recordOverrideEdit(['m1'], () => useStore.getState().setMeshesColor(['m1'], { color: '#ff0000' }))
    undoScene()
    expect(applyModelMaterials).toHaveBeenCalled()
  })
})

describe('undo / redo of light settings', () => {
  beforeAll(() => {
    const scene = new THREE.Scene()
    initLights({
      scene,
      camera: new THREE.PerspectiveCamera(50, 1, 0.1, 100),
      renderer: { domElement: document.createElement('canvas') },
      controls: { enabled: true, locked: false },
      requestRender: () => {},
      getSceneScale: () => 2,
    })
  })
  beforeEach(() => clearUndoHistory())

  const fresh = () => {
    const meta = addLight({ recordUndo: false })
    useStore.getState().addSceneLight(meta)
    clearUndoHistory()
    return meta.id
  }

  it('colour, intensity and shadows are undoable and keep the panel in step', () => {
    const id = fresh()
    const light = getLightById(id)
    setLightColor(id, '#ff0000')
    expect(light.color.getHexString()).toBe('ff0000')
    undoScene()
    expect(light.color.getHexString()).toBe('ffffff')
    expect(useStore.getState().sceneLights.find((x) => x.id === id).color).toBe('#ffffff')
    redoScene()
    expect(light.color.getHexString()).toBe('ff0000')

    clearUndoHistory()
    setLightCastShadow(id, true)
    expect(light.castShadow).toBe(true)
    undoScene()
    expect(light.castShadow).toBe(false)
  })

  it('a slider drag is one step', () => {
    const id = fresh()
    const light = getLightById(id)
    for (const v of [3, 4, 5, 6]) setLightIntensity(id, v)
    expect(light.intensity).toBe(6)
    undoScene()
    expect(light.intensity).toBe(2)
  })

  it('range, cone and type changes are undoable', () => {
    const id = fresh()
    setLightRange(id, 40)
    expect(getLightShape(id).range).toBe(40)
    undoScene()
    expect(getLightShape(id).range).toBeCloseTo(7.5)
    expect(getLightById(id).distance).toBeCloseTo(7.5)

    clearUndoHistory()
    setLightDirectional(id, true)
    setLightCone(id, { angle: 20 })
    expect(getLightById(id).isSpotLight).toBe(true)
    undoScene() // cone angle + type were one run of edits within the window -> one step
    expect(getLightById(id).isPointLight).toBe(true)
    redoScene()
    expect(getLightById(id).isSpotLight).toBe(true)
    expect(THREE.MathUtils.radToDeg(getLightById(id).angle)).toBeCloseTo(20)
  })

  it('applying a preset is one step that undoes the whole change', () => {
    const id = fresh()
    applyLightPreset(id, 'headlight')
    const light = getLightById(id)
    expect(light.isSpotLight).toBe(true)
    undoScene()
    const back = getLightById(id)
    expect(back.isPointLight).toBe(true)
    expect(back.distance).toBeCloseTo(7.5)
    expect(back.intensity).toBe(2)
    expect(useStore.getState().sceneLights.find((x) => x.id === id).directional).toBe(false)
  })

  it('adding a light from a preset is a single add step (not an add followed by an edit)', () => {
    clearUndoHistory()
    const before = getHistorySequence()
    const meta = addLight({ data: lightDataForPreset('flood') })
    expect(getHistorySequence()).toBe(before + 1)
    const light = getLightById(meta.id)
    expect(light.isSpotLight).toBe(true)
    expect(light.distance).toBe(40)
    expect(meta.directional).toBe(true)
  })

  it('loading a project records no undo steps', () => {
    const id = fresh()
    setLightRange(id, 22)
    const saved = getLightsData()
    clearUndoHistory()
    const before = getHistorySequence()
    applyLightsData(saved.map((s) => ({ ...s, directional: true, castShadow: true, color: '#00ff00', intensity: 3 })))
    expect(getHistorySequence()).toBe(before)
  })

  it('every preset has a usable single-step description', () => {
    for (const p of LIGHT_PRESETS) {
      const data = lightDataForPreset(p.id)
      expect(data.range).toBeGreaterThan(0)
      expect(typeof data.directional).toBe('boolean')
    }
    expect(lightDataForPreset('nope')).toBeNull()
  })
})
