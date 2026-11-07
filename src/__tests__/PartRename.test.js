import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { useStore } from '../store.js'
import { renamePart } from '../three/materialHistory.js'
import { cleanPartName, partDisplayName, MAX_PART_NAME } from '../three/partNames.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'
import { syncMeshMaterialFlags } from '../three/materials.js'
import { partMenu } from '../panels/rowMenus.js'

afterEach(() => vi.useRealTimers())

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clearUndoHistory()
  useStore.setState({ meshOverrides: {}, activeCharacterId: 1, characters: {}, flatteners: [] })
})

describe('part names', () => {
  it('tidies a name, and an empty one means "the model\'s own name"', () => {
    expect(cleanPartName('  Hood   front \n')).toBe('Hood front')
    expect(cleanPartName(null)).toBe('')
    expect(cleanPartName('x'.repeat(200))).toHaveLength(MAX_PART_NAME)
    expect(partDisplayName({ name: ' Cape ' }, 'Mesh_012')).toBe('Cape')
    expect(partDisplayName({}, 'Mesh_012')).toBe('Mesh_012')
    expect(partDisplayName(undefined, '')).toBe('Part')
  })

  it('renames a part, keeps the loaded name when cleared, and undoes / redoes', () => {
    renamePart('a', '  Front hair ')
    expect(useStore.getState().meshOverrides.a.name).toBe('Front hair')
    vi.setSystemTime(Date.now() + 5000) // a separate edit, not part of the same quick burst
    renamePart('a', '   ')
    expect(useStore.getState().meshOverrides.a.name).toBeUndefined()
    performUndo(useStore.getState())
    expect(useStore.getState().meshOverrides.a.name).toBe('Front hair')
    performUndo(useStore.getState())
    expect(useStore.getState().meshOverrides.a?.name).toBeUndefined()
    performRedo(useStore.getState())
    expect(useStore.getState().meshOverrides.a.name).toBe('Front hair')
  })

  it('a rename does not disturb the part\'s other settings', () => {
    useStore.setState({ meshOverrides: { a: { outline: false, shading: 'flat', castShadow: false } } })
    renamePart('a', 'Cape')
    expect(useStore.getState().meshOverrides.a).toMatchObject({ outline: false, shading: 'flat', castShadow: false, name: 'Cape' })
  })

  it('renames a part of a character that is not the active one in its own roster entry', () => {
    useStore.setState({ characters: { 2: { meshOverrides: {} } } })
    renamePart('z', 'Hood', 2)
    expect(useStore.getState().characters[2].meshOverrides.z.name).toBe('Hood')
    expect(useStore.getState().meshOverrides.z).toBeUndefined()
  })
})

describe('per-part light & shadow flags reach the materials', () => {
  function meshWith(userData) {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial())
    Object.assign(mesh.userData, userData)
    return mesh
  }

  it('a part flag switches the material flag on, and the object\'s own switch still works', () => {
    const part = meshWith({ partShadowImmune: true, partRimImmune: true, partNightImmune: true })
    const object = meshWith({ shadowImmune: true })
    const plain = meshWith({})
    syncMeshMaterialFlags([part, object, plain])
    expect(part.material.userData.shadowImmune).toBe(true)
    expect(part.material.userData.rimImmune).toBe(true)
    expect(part.material.userData.nightImmune).toBe(true)
    expect(object.material.userData.shadowImmune).toBe(true)
    expect(plain.material.userData.shadowImmune).toBeUndefined()
    // switching the part flag off again clears it
    part.userData.partShadowImmune = false
    syncMeshMaterialFlags([part])
    expect(part.material.userData.shadowImmune).toBeUndefined()
  })
})

describe('the Parts list menu', () => {
  it('is laid out like an object menu: rename / hide, Look, then Light & shadow', () => {
    const { items, run } = partMenu(['a'], { nameOf: () => 'Mesh_012', startRename: (u) => (run.renamed = u) })
    const flat = items.map((i) => (i.separator ? '-' : i.header ? `# ${i.header}` : i.label))
    expect(flat.slice(0, 4)).toEqual(['# Mesh_012', 'Rename', 'Hide', '-'])
    expect(flat).toContain('Look')
    expect(flat.indexOf('Look')).toBeLessThan(flat.indexOf('# Light & shadow'))
    expect(flat.slice(flat.indexOf('# Light & shadow') + 1, flat.indexOf('# Light & shadow') + 5)).toEqual(['Casts shadows', 'Receives shadows', 'Ignore rim lighting', 'Darkens at night'])
    run('rename')
    expect(run.renamed).toBe('a')
  })

  it('has no Rename for several parts at once', () => {
    const { items } = partMenu(['a', 'b'], {})
    expect(items.some((i) => i.id === 'rename')).toBe(false)
    expect(items[0].header).toBe('2 parts selected')
  })

  it('the Look submenu sets this part\'s shading', () => {
    const { items, run } = partMenu(['a'], {})
    const look = items.find((i) => i.label === 'Look')
    expect(look.children.map((c) => c.id)).toEqual(['shade:full', 'shade:soft', 'shade:flat'])
    run('shade:soft')
    expect(useStore.getState().meshOverrides.a.shading).toBe('soft')
    expect(partMenu(['a'], {}).items.find((i) => i.label === 'Look').children.find((c) => c.checked).id).toBe('shade:soft')
  })
})
