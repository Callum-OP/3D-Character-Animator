// Writes the solved motion as BVH text. Every bone's rest orientation is identity (offsets only), channels are
// Zrotation Xrotation Yrotation. The first frame is a NEUTRAL rest frame: the app's BVH retargeter treats frame 0
// as the rest pose, and a video rarely starts in one.
import * as THREE from 'three'
import { BVH_JOINTS, restOffsets, endOffset, hasChildren } from './humanoid.js'

const f4 = (v) => (Math.abs(v) < 5e-5 ? '0' : v.toFixed(4))

export function writeBVH({ fps, count, root, rot, restFrame = true }) {
  const off = restOffsets()
  const lines = ['HIERARCHY']
  const depth = (i) => { let d = 0; for (let p = BVH_JOINTS[i].parent; p >= 0; p = BVH_JOINTS[p].parent) d++; return d }
  const ind = (d) => '  '.repeat(d)
  // Channel values in MOTION must follow the order the joints appear in HIERARCHY (depth first), not list order.
  const order = []
  const walk = (i) => { order.push(i); BVH_JOINTS.forEach((c, k) => { if (c.parent === i) walk(k) }) }
  walk(0)
  const emit = (i) => {
    const d = depth(i), j = BVH_JOINTS[i]
    lines.push(`${ind(d)}${i === 0 ? 'ROOT' : 'JOINT'} ${j.name}`, `${ind(d)}{`)
    lines.push(`${ind(d + 1)}OFFSET ${off[i].map(f4).join(' ')}`)
    lines.push(`${ind(d + 1)}CHANNELS ${i === 0 ? '6 Xposition Yposition Zposition' : '3'} Zrotation Xrotation Yrotation`)
    BVH_JOINTS.forEach((c, k) => { if (c.parent === i) emit(k) })
    if (!hasChildren(i)) {
      const e = endOffset(i) || [0, 3, 0]
      lines.push(`${ind(d + 1)}End Site`, `${ind(d + 1)}{`, `${ind(d + 2)}OFFSET ${e.map(f4).join(' ')}`, `${ind(d + 1)}}`)
    }
    lines.push(`${ind(d)}}`)
  }
  emit(0)

  const total = count + (restFrame ? 1 : 0)
  lines.push('MOTION', `Frames: ${total}`, `Frame Time: ${(1 / fps).toFixed(6)}`)
  const q = new THREE.Quaternion(), e = new THREE.Euler()
  const deg = 180 / Math.PI
  const identityRow = (rx, ry, rz) => [f4(rx), f4(ry), f4(rz), ...Array(BVH_JOINTS.length * 3).fill('0')]
  if (restFrame) lines.push(identityRow(root[0], root[1], root[2]).join(' '))
  for (let k = 0; k < count; k++) {
    const row = [f4(root[k * 3]), f4(root[k * 3 + 1]), f4(root[k * 3 + 2])]
    for (const j of order) {
      q.set(rot[j][k * 4], rot[j][k * 4 + 1], rot[j][k * 4 + 2], rot[j][k * 4 + 3]).normalize()
      e.setFromQuaternion(q, 'ZXY')
      row.push(f4(e.z * deg), f4(e.x * deg), f4(e.y * deg))
    }
    lines.push(row.join(' '))
  }
  return lines.join('\n') + '\n'
}
