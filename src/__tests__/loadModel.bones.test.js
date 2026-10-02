import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { collapseNestedBoneDuplicates } from '../three/loadModel.js'

describe('collapseNestedBoneDuplicates', () => {
  it('keeps the controlling parent bone and drops its nested skin-bone duplicate', () => {
    const root = new THREE.Group()
    const upperArm = new THREE.Bone()
    upperArm.name = 'UpperArm'
    const skinUpperArm = new THREE.Bone()
    skinUpperArm.name = 'UpperArm'
    const lowerArm = new THREE.Bone()
    lowerArm.name = 'LowerArm'
    lowerArm.position.x = 1
    const skinLowerArm = new THREE.Bone()
    skinLowerArm.name = 'LowerArm'

    root.add(upperArm)
    upperArm.add(skinUpperArm, lowerArm)
    lowerArm.add(skinLowerArm)

    const bones = collapseNestedBoneDuplicates([
      skinUpperArm,
      skinLowerArm,
      upperArm,
      lowerArm,
    ])

    expect(bones).toEqual([upperArm, lowerArm])
    upperArm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
    root.updateMatrixWorld(true)
    const lowerArmPosition = lowerArm.getWorldPosition(new THREE.Vector3())
    expect(lowerArmPosition.distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-6)
    expect(skinLowerArm.getWorldPosition(new THREE.Vector3()).distanceTo(lowerArmPosition)).toBeLessThan(1e-6)
  })

  it('preserves same-named bones that are not nested duplicates', () => {
    const left = new THREE.Bone()
    const right = new THREE.Bone()
    left.name = right.name = 'Hand'

    expect(collapseNestedBoneDuplicates([left, right])).toEqual([left, right])
  })
})
