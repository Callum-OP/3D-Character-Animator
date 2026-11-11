import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { fingerNameOf, fingerInfo, looksLikeHand } from '../three/fingers.js'
import { classifyBones } from '../three/loadModel.js'
import { setLimitsModel, clearLimitsModel, clampQuaternionForBone } from '../three/limits.js'

// A Mixamo-style arm: ...Hand > Index1..4, Thumb1..4, plus unrelated bones whose names contain finger words.
function chain(parent, names, step = [0.1, 0, 0]) {
  const out = []
  let p = parent
  for (const name of names) {
    const b = new THREE.Bone()
    b.name = name
    b.position.set(...step)
    p.add(b)
    out.push(b)
    p = b
  }
  return out
}

function rig(prefix = 'mixamorig:') {
  const hips = new THREE.Bone(); hips.name = `${prefix}Hips`
  const spine = chain(hips, [`${prefix}Spine`], [0, 0.3, 0])[0]
  const arm = chain(spine, [`${prefix}LeftShoulder`, `${prefix}LeftArm`, `${prefix}LeftForeArm`, `${prefix}LeftHand`])
  const hand = arm[3]
  const index = chain(hand, [1, 2, 3, 4].map((n) => `${prefix}LeftHandIndex${n}`))
  const thumb = chain(hand, [1, 2, 3, 4].map((n) => `${prefix}LeftHandThumb${n}`))
  const drawstring = chain(spine, ['drawstring_1', 'drawstring_2'])
  const earring = chain(spine, ['Earring_L'])
  const root = new THREE.Group()
  root.add(hips)
  root.updateMatrixWorld(true)
  return { root, hips, spine, hand, index, thumb, drawstring, earring, bones: [hips, spine, ...arm, ...index, ...thumb, ...drawstring, ...earring] }
}

describe('finger names', () => {
  it('recognises the common naming schemes', () => {
    expect(fingerNameOf('mixamorig:LeftHandIndex2')).toBe('index')
    expect(fingerNameOf('lThumb1')).toBe('thumb')
    expect(fingerNameOf('thumb_01_l')).toBe('thumb')
    expect(fingerNameOf('f_pinky.02.R')).toBe('pinky')
    expect(fingerNameOf('Bip01 L Finger3')).toBe('ring')
    expect(fingerNameOf('Bip01 L Finger1Nub')).toBe('index')
    expect(fingerNameOf('lefthandmiddle2')).toBe('middle')
    expect(fingerNameOf('hand_l')).toBeNull()
    expect(fingerNameOf('LeftForeArm')).toBeNull()
  })

  it('only counts them as fingers when they sit under a hand', () => {
    const r = rig()
    const isHand = looksLikeHand
    expect(fingerInfo(r.index[0], isHand)).toMatchObject({ finger: 'index', segment: 1, tip: false })
    expect(fingerInfo(r.index[2], isHand)).toMatchObject({ segment: 3, tip: false })
    expect(fingerInfo(r.index[3], isHand)).toMatchObject({ segment: 4, tip: true }) // Index4 is the tip marker
    expect(fingerInfo(r.thumb[3], isHand)?.tip).toBe(true)
    expect(fingerInfo(r.earring[0], isHand)).toBeNull() // "Earring" is not a ring finger
    expect(fingerInfo(r.drawstring[0], isHand)).toBeNull()
  })
})

describe('hiding helper bones', () => {
  it('flags finger tip markers (and only those) as helpers', () => {
    const r = rig()
    const info = classifyBones(r.bones)
    const byName = Object.fromEntries(info.map((b) => [b.name, b.deform]))
    expect(byName['mixamorig:LeftHandIndex1']).toBe(true)
    expect(byName['mixamorig:LeftHandIndex3']).toBe(true)
    expect(byName['mixamorig:LeftHandIndex4']).toBe(false)
    expect(byName['mixamorig:LeftHandThumb3']).toBe(true)
    expect(byName['mixamorig:LeftHandThumb4']).toBe(false)
    expect(byName['mixamorig:LeftHand']).toBe(true)
    expect(byName.drawstring_2).toBe(true) // not a finger: untouched
  })

  it('flags tips named _end / Nub / tip, wherever they sit in the numbering', () => {
    const hand = new THREE.Bone(); hand.name = 'Hand_R'
    const idx = chain(hand, ['index_01_r', 'index_02_r', 'index_03_r', 'index_03_r_end_0458'])
    const nub = chain(hand, ['Bip01 R Finger2', 'Bip01 R Finger2Nub'])
    const tip = chain(hand, ['pinky_01', 'pinky_02', 'pinky_tip'])
    const info = Object.fromEntries(classifyBones([hand, ...idx, ...nub, ...tip]).map((b) => [b.name, b.deform]))
    expect(info.index_03_r).toBe(true)
    expect(info.index_03_r_end_0458).toBe(false)
    expect(info['Bip01 R Finger2']).toBe(true)
    expect(info['Bip01 R Finger2Nub']).toBe(false)
    expect(info.pinky_02).toBe(true)
    expect(info.pinky_tip).toBe(false)
  })
})

describe('finger limits', () => {
  const angleOf = (q) => 2 * Math.acos(Math.min(1, Math.abs(q.w)))

  it('keeps finger joints inside their range and leaves anything else alone', () => {
    const r = rig()
    setLimitsModel({ root: r.root, bones: r.bones })
    try {
      const knuckle = r.index[0]
      const far = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(170))
      const q = knuckle.quaternion.clone().multiply(far)
      expect(clampQuaternionForBone(knuckle, q)).toBe(true)
      expect(THREE.MathUtils.radToDeg(angleOf(knuckle.quaternion.clone().invert().multiply(q)))).toBeLessThan(91)

      const fine = knuckle.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(60)))
      expect(clampQuaternionForBone(knuckle, fine)).toBe(false) // a comfortable curl is untouched

      // the fingertip marker and non-finger bones have no limit
      const wild = (b) => b.quaternion.clone().multiply(far)
      expect(clampQuaternionForBone(r.index[3], wild(r.index[3]))).toBe(false)
      expect(clampQuaternionForBone(r.drawstring[0], wild(r.drawstring[0]))).toBe(false)
      expect(clampQuaternionForBone(r.earring[0], wild(r.earring[0]))).toBe(false)
    } finally {
      clearLimitsModel()
    }
  })

  it('stops a finger rolling about its own axis', () => {
    const r = rig()
    setLimitsModel({ root: r.root, bones: r.bones })
    try {
      const mid = r.index[1]
      const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(80))
      const q = mid.quaternion.clone().multiply(roll)
      expect(clampQuaternionForBone(mid, q)).toBe(true)
      expect(THREE.MathUtils.radToDeg(angleOf(mid.quaternion.clone().invert().multiply(q)))).toBeLessThan(10)
    } finally {
      clearLimitsModel()
    }
  })
})
