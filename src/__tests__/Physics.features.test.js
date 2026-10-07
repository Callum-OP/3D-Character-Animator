import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  clearLimitsModel,
  clampBoneLocal,
  clampQuaternionForBone,
  limitsEnabled,
  setLimitsEnabled,
  setLimitsModel,
} from '../three/limits.js'
import { clearDangle, collectDescendantBoneNames, initDangle, setDangleConfig, stepDangleLive } from '../three/dangle.js'
import {
  FABRIC_PRESETS,
  clothEnergy,
  disableCloth,
  disposeClothMod,
  enableCloth,
  getClothEntry,
  initClothMod,
  isClothEnabled,
  isClothShrinkwrap,
  setClothShrinkwrap,
  stepClothOnce,
} from '../three/clothmod.js'

describe('pose limits', () => {
  let bone

  beforeEach(() => {
    const root = new THREE.Group()
    bone = new THREE.Bone()
    bone.name = 'Joint'
    const child = new THREE.Bone()
    child.position.y = 1
    root.add(bone)
    bone.add(child)
    setLimitsEnabled(true)
    setLimitsModel({ root, bones: [bone, child] }, (candidate) => candidate === bone ? 'head' : null)
  })

  afterEach(() => clearLimitsModel())

  it('keeps a valid rest-pose rotation unchanged and clamps excessive swing to the role limit', () => {
    const rest = bone.quaternion.clone()
    expect(clampQuaternionForBone(bone, rest.clone())).toBe(false)

    bone.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(90))
    expect(clampBoneLocal(bone)).toBe(true)
    expect(bone.quaternion.angleTo(new THREE.Quaternion())).toBeCloseTo(THREE.MathUtils.degToRad(45), 3)
  })

  it('does not clamp live bone edits while the limits toggle is off', () => {
    const proposed = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
    bone.quaternion.copy(proposed)
    setLimitsEnabled(false)

    expect(limitsEnabled()).toBe(false)
    expect(clampBoneLocal(bone)).toBe(false)
    expect(bone.quaternion.angleTo(proposed)).toBeCloseTo(0)
  })

  it('leaves unclassified bones unconstrained', () => {
    const unknown = new THREE.Bone()
    unknown.name = 'TailTip'
    expect(clampQuaternionForBone(unknown, new THREE.Quaternion())).toBe(false)
  })
})

describe('secondary motion', () => {
  it('collects only descendant skeleton bones and respects the requested cap', () => {
    const root = new THREE.Bone()
    root.name = 'Root'
    const child = new THREE.Bone()
    child.name = 'Hair'
    const tip = new THREE.Bone()
    tip.name = 'HairTip'
    root.add(child)
    child.add(tip)

    expect(collectDescendantBoneNames({ bones: [root, child, tip] }, 'Hair')).toEqual(['Hair', 'HairTip'])
    expect(collectDescendantBoneNames({ bones: [root, child, tip] }, 'Root', 2)).toHaveLength(2)
    expect(collectDescendantBoneNames({ bones: [root, child, tip] }, 'missing')).toEqual([])
  })

  it('builds and advances an enabled dangle chain, then clears it for the character', () => {
    const root = new THREE.Bone()
    const strand = new THREE.Bone()
    strand.name = 'Strand'
    strand.position.y = 1
    const tip = new THREE.Bone()
    tip.name = 'Tip'
    tip.position.y = 1
    root.add(strand)
    strand.add(tip)
    const model = { root, bones: [root, strand, tip] }
    const requestRender = vi.fn()
    initDangle({ requestRender })
    setDangleConfig('character-1', model, true, [{ id: 'hair', boneNames: ['Strand', 'Tip'] }])

    expect(() => stepDangleLive(1 / 60)).not.toThrow()
    expect(strand.quaternion.toArray().every(Number.isFinite)).toBe(true)
    expect(requestRender).toHaveBeenCalled()

    clearDangle('character-1')
    expect(() => stepDangleLive(1 / 60)).not.toThrow()
  })
})

describe('cloth simulation workflow', () => {
  let scene
  let garment

  beforeEach(() => {
    disposeClothMod()
    scene = new THREE.Scene()
    initClothMod({
      scene,
      camera: new THREE.PerspectiveCamera(),
      renderer: { domElement: document.createElement('canvas') },
      controls: { enabled: true, locked: false },
      requestRender: () => {},
    })
    garment = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1, 3, 3),
      new THREE.MeshStandardMaterial({ vertexColors: true }),
    )
    scene.add(garment)
  })

  afterEach(() => disposeClothMod())

  it('enables a cloth proxy without changing the source geometry and restores the source on disable', () => {
    const sourceGeometry = garment.geometry
    expect(enableCloth(garment, [], { preset: 'silk' })).toBe(true)
    expect(isClothEnabled(garment.uuid)).toBe(true)
    expect(garment.visible).toBe(false)
    expect(getClothEntry(garment.uuid).proxy.material.side).toBe(THREE.DoubleSide)
    expect(getClothEntry(garment.uuid).proxy.material.vertexColors).toBe(false)
    expect(getClothEntry(garment.uuid).preset).toBe('silk')
    expect(getClothEntry(garment.uuid).sim._mass).toBe(FABRIC_PRESETS.silk.mass)
    expect(getClothEntry(garment.uuid).sim.params.friction).toBe(FABRIC_PRESETS.silk.friction)
    expect(garment.geometry).toBe(sourceGeometry)

    disableCloth(garment.uuid)
    expect(isClothEnabled(garment.uuid)).toBe(false)
    expect(garment.visible).toBe(true)
  })

  it('advances finite simulation state and preserves shrinkwrap toggles', () => {
    expect(enableCloth(garment, [])).toBe(true)
    setClothShrinkwrap(garment.uuid, true)
    expect(isClothShrinkwrap(garment.uuid)).toBe(true)

    stepClothOnce(2)
    expect(Number.isFinite(clothEnergy(garment.uuid))).toBe(true)

    setClothShrinkwrap(garment.uuid, false)
    expect(isClothShrinkwrap(garment.uuid)).toBe(false)
  })

  it('rejects geometry that cannot form a cloth surface without hiding it', () => {
    const empty = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial())
    scene.add(empty)

    expect(enableCloth(empty, [])).toBe(false)
    expect(empty.visible).toBe(true)
    expect(isClothEnabled(empty.uuid)).toBe(false)
  })
})
