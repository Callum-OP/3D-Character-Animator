import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as THREE from 'three'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { clearUndoHistory } from '../three/undoHistory.js'

let current = null
vi.mock('../three/scene.js', () => ({ getCurrentModel: () => current }))
vi.mock('../three/meshedit.js', () => ({ setFacePickHandler: () => {} }))

import SymmetrySection from '../panels/SymmetrySection.jsx'
import { initMeshSymmetry } from '../three/meshSymmetry.js'

const M = 20 // rings along the tube
const S = 8 // points round each ring

// A tube along X from -1 to +1: the middle ring is the centre line. Skinned to Hips (centre), LeftArm (+x) and
// RightArm (-x). `stretch` lengthens the +x half (a long arm on the left).
function makeModel({ stretch = 1, seam = false } = {}) {
  const SS = seam ? S + 1 : S // a UV seam: the first point of every ring is there twice
  const pos = []
  const skinIndex = []
  const skinWeight = []
  for (let j = 0; j <= M; j++) {
    const x0 = -1 + (2 * j) / M
    const x = x0 > 1e-9 ? x0 * stretch : x0
    for (let k = 0; k < SS; k++) {
      const th = (k / S) * Math.PI * 2
      pos.push(x, 0.1 * Math.cos(th) + 1, 0.1 * Math.sin(th))
      const bone = j === M / 2 ? 0 : x0 > 0 ? 1 : 2
      skinIndex.push(bone, 0, 0, 0)
      skinWeight.push(1, 0, 0, 0)
    }
  }
  const index = []
  for (let j = 0; j < M; j++) {
    for (let k = 0; k < S; k++) {
      const a = j * SS + k
      const b = j * SS + (seam ? k + 1 : (k + 1) % S)
      const c = (j + 1) * SS + k
      const d = (j + 1) * SS + (seam ? k + 1 : (k + 1) % S)
      index.push(a, b, c, b, d, c)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4))
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4))
  geo.setIndex(index)
  geo.computeVertexNormals()

  const root = new THREE.Group()
  const hips = new THREE.Bone(); hips.name = 'Hips'; hips.position.set(0, 1, 0)
  const left = new THREE.Bone(); left.name = 'LeftArm'; left.position.set(0.5, 0, 0)
  const right = new THREE.Bone(); right.name = 'RightArm'; right.position.set(-0.5, 0, 0)
  hips.add(left, right)
  root.add(hips)
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial())
  mesh.name = 'Body'
  root.add(mesh)
  root.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton([hips, left, right]))
  return { root, bones: [hips, left, right], meshes: [mesh], mesh, geo }
}


beforeEach(() => {
  cleanup()
  clearUndoHistory()
  initMeshSymmetry({})
  current = makeModel({ stretch: 1.5 })
})

describe('Mirror & symmetrise panel', () => {
  it('shows how many points will change, symmetrises, and mirrors', async () => {
    const m = current
    const before = Float32Array.from(m.geo.attributes.position.array)
    render(<SymmetrySection meshUuid={m.mesh.uuid} resolveMesh={(u) => m.meshes.find((x) => x.uuid === u) || null} partsList={[]} />)
    expect(await screen.findByText(/points? on the other side will change/, {}, { timeout: 2000 })).toBeTruthy()
    fireEvent.click(screen.getByText('Symmetrise'))
    expect(await screen.findByText(/now matches the left side/)).toBeTruthy()
    expect(Float32Array.from(m.geo.attributes.position.array)).not.toEqual(before)
    fireEvent.click(screen.getByText('Mirror part'))
    expect(await screen.findByText(/Mirrored Body/)).toBeTruthy()
  })
})
