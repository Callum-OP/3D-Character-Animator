import { describe, it, expect, beforeAll } from 'vitest'
import * as THREE from 'three'
import {
  initPosing, setPoseModel, getBoneRegionKey, getPartOverlayMeshes, getRegionLabel, getRegionControlBoneName,
} from '../three/posing.js'

// Body Parts view: every segment of every finger is its own region (finger.<side>.<type>.<1-3>), titled like
// "LeftIndexHand2", instead of one lump per hand.

const bone = (name, x = 0, y = 0, z = 0) => {
  const b = new THREE.Bone()
  b.name = name
  b.position.set(x, y, z)
  return b
}

// Hips > Spine > arm > hand, both sides, with the finger chains named by `fingerName(side, type, segment)`.
// `layout(type)` gives the hand-local position of a finger's knuckle and its direction.
function makeRig({ fingerName, layout, extraEnd = true }) {
  const hips = bone('Hips')
  const spine = bone('Spine', 0, 1, 0)
  hips.add(spine)
  const bones = [hips, spine]
  const fingers = {}
  for (const [side, sx] of [['Left', 1], ['Right', -1]]) {
    const arm = bone(`${side}Arm`, sx * 0.3, 0.5, 0)
    const fore = bone(`${side}ForeArm`, sx * 0.3, 0, 0)
    const hand = bone(`${side}Hand`, sx * 0.3, 0, 0)
    spine.add(arm); arm.add(fore); fore.add(hand)
    bones.push(arm, fore, hand)
    for (const type of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
      const { at, dir } = layout(type)
      let parent = hand
      const count = extraEnd ? 4 : 3
      for (let seg = 1; seg <= count; seg++) {
        const b = seg === 1
          ? bone(fingerName(side, type, seg), sx * at[0], at[1], at[2])
          : bone(fingerName(side, type, seg), sx * dir[0] * 0.05, dir[1] * 0.05, dir[2] * 0.05)
        parent.add(b)
        bones.push(b)
        fingers[`${side}.${type}.${seg}`] = b
        parent = b
      }
    }
  }
  hips.updateMatrixWorld(true)
  return { root: hips, hips, bones, fingers }
}

const cap = (s) => s[0].toUpperCase() + s.slice(1)
const named = (side, type, seg) => `mixamorig:${side}Hand${cap(type)}${seg}`
// a flat hand: knuckles spread along Z, thumb out front and angled
const flat = (type) => ({
  thumb: { at: [0.02, 0, 0.06], dir: [0.5, 0, 1] },
  index: { at: [0.08, 0, 0.04], dir: [1, 0, 0] },
  middle: { at: [0.09, 0, 0.0], dir: [1, 0, 0] },
  ring: { at: [0.08, 0, -0.04], dir: [1, 0, 0] },
  pinky: { at: [0.07, 0, -0.07], dir: [1, 0, 0] },
}[type])

function attach(model) {
  // one triangle per bone, fully weighted to it, so every bone owns some surface
  const pos = []
  const idx = []
  const w = []
  model.bones.forEach((b, i) => {
    for (let k = 0; k < 3; k++) {
      pos.push(i * 0.1 + k * 0.01, k * 0.01, 0)
      idx.push(i, 0, 0, 0)
      w.push(1, 0, 0, 0)
    }
  })
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map(() => 0), 3))
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4))
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4))
  geo.setIndex(Array.from({ length: model.bones.length * 3 }, (_, i) => i))
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial())
  const skeleton = new THREE.Skeleton(model.bones)
  model.hips.add(mesh)
  mesh.bind(skeleton)
  model.skinnedMeshes = [mesh]
  model.meshes = [mesh]
  model.skeleton = skeleton
  return model
}

beforeAll(() => {
  const canvas = document.createElement('canvas')
  initPosing({
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    renderer: { domElement: canvas },
    controls: { enabled: true, locked: false },
    requestRender: () => {},
    onSelect: () => {},
  })
})

describe('finger segments as body parts', () => {
  it('titles every segment of every finger, e.g. LeftThumbHand1 … RightPinkyHand3', () => {
    expect(getRegionLabel('finger.L.thumb.1')).toBe('LeftThumbHand1')
    expect(getRegionLabel('finger.L.index.2')).toBe('LeftIndexHand2')
    expect(getRegionLabel('finger.R.pinky.3')).toBe('RightPinkyHand3')
    expect(getRegionLabel('finger.R.middle.1')).toBe('RightMiddleHand1')
    expect(getRegionLabel('nope')).toBeNull()
  })

  it('splits named fingers into their segments (a tip/end bone joins segment 3)', () => {
    const rig = makeRig({ fingerName: named, layout: flat })
    setPoseModel(rig)
    for (const type of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
      expect(getBoneRegionKey(named('Left', type, 1))).toBe(`finger.L.${type}.1`)
      expect(getBoneRegionKey(named('Left', type, 2))).toBe(`finger.L.${type}.2`)
      expect(getBoneRegionKey(named('Left', type, 3))).toBe(`finger.L.${type}.3`)
      expect(getBoneRegionKey(named('Left', type, 4))).toBe(`finger.L.${type}.3`)
      expect(getBoneRegionKey(named('Right', type, 2))).toBe(`finger.R.${type}.2`)
    }
    expect(getBoneRegionKey('LeftHand')).toBe('hand.L')
  })

  it('works on other naming schemes (Rigify style: f_index.01.L, thumb.01.L, little)', () => {
    const rigify = (side, type, seg) => {
      const n = type === 'thumb' ? 'thumb' : `f_${type === 'pinky' ? 'pinky' : type}`
      return `${n}.0${seg}.${side[0]}`
    }
    const rig = makeRig({ fingerName: rigify, layout: flat, extraEnd: false })
    // Rigify arms: make the hand findable
    rig.bones.find((b) => b.name === 'LeftHand').name = 'hand.L'
    rig.bones.find((b) => b.name === 'RightHand').name = 'hand.R'
    setPoseModel(rig)
    expect(getBoneRegionKey('f_ring.02.L')).toBe('finger.L.ring.2')
    expect(getBoneRegionKey('thumb.03.R')).toBe('finger.R.thumb.3')
    const little = makeRig({ fingerName: (side, type, seg) => (type === 'pinky' ? `${side}HandLittle${seg}` : named(side, type, seg)), layout: flat })
    setPoseModel(little)
    expect(getBoneRegionKey('LeftHandLittle2')).toBe('finger.L.pinky.2')
  })

  it('tells the fingers apart by where they sit when the bones carry no finger names', () => {
    const anon = (side, type, seg) => `${side}_J${['thumb', 'index', 'middle', 'ring', 'pinky'].indexOf(type)}_${seg}`
    const rig = makeRig({ fingerName: anon, layout: flat })
    setPoseModel(rig)
    expect(getBoneRegionKey('Left_J0_1')).toBe('finger.L.thumb.1')
    expect(getBoneRegionKey('Left_J1_2')).toBe('finger.L.index.2')
    expect(getBoneRegionKey('Left_J4_3')).toBe('finger.L.pinky.3')
    expect(getBoneRegionKey('Right_J0_1')).toBe('finger.R.thumb.1')
    expect(getBoneRegionKey('Right_J3_2')).toBe('finger.R.ring.2')
  })

  it('keeps the general fingers region for a hand it cannot split (no names, only four chains)', () => {
    const rig = makeRig({ fingerName: (side, type, seg) => `${side}_X${['thumb', 'index', 'middle', 'ring', 'pinky'].indexOf(type)}_${seg}`, layout: flat })
    const dropped = rig.bones.filter((b) => b.name.includes('_X4_'))
    dropped.forEach((b) => b.parent && b.parent.remove(b))
    rig.bones = rig.bones.filter((b) => !dropped.includes(b))
    setPoseModel(rig)
    expect(getBoneRegionKey('Left_X1_1')).toBe('fingers.L')
  })

  it('builds a separate overlay for each segment, and clicking one selects that segment\'s own bone', () => {
    const rig = attach(makeRig({ fingerName: named, layout: flat }))
    setPoseModel(rig)
    const regions = new Set(getPartOverlayMeshes().map((o) => o.region))
    for (const side of ['L', 'R']) {
      for (const type of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
        for (const seg of [1, 2, 3]) expect(regions.has(`finger.${side}.${type}.${seg}`)).toBe(true)
      }
    }
    expect(regions.has('fingers.L')).toBe(false) // nothing left over in the lump
    expect(getRegionControlBoneName('finger.L.index.2')).toBe(named('Left', 'index', 2))
    expect(getRegionControlBoneName('finger.R.thumb.1')).toBe(named('Right', 'thumb', 1))
    expect(getRegionControlBoneName('finger.L.pinky.3')).toBe(named('Left', 'pinky', 3))
  })
})
