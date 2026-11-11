import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Added-bone offsets, applied ON TOP of the body's own skinning
//
// "Add bones" gives a piece of clothing (a jacket hem, a hood, a cape) bones of its own so
// the dangle / cloth physics can swing it. Plain skinning has a problem with that: a
// vertex weighted to an added bone follows ONLY that bone's parent, so when the body bends
// the piece stays rigid and clips through the body. Blending weights 50/50 cannot fix it
// either (glTF skinning has four influence slots, so the body's own weights get cut down).
//
// What is wanted is two stages:
//   1. the body moves the mesh exactly as it would if the added bones did not exist, then
//   2. the added bones' own motion (physics, hand posing, animation) is applied on top.
//
// This file does stage 2 in the vertex shader. A vertex keeps its ORIGINAL body weights in
// skinIndex / skinWeight. Two extra attributes carry up to four added-bone influences:
//
//   rigIndex  = skeleton bone index + 2 (0 = unused; the +2 keeps every value a missing
//               attribute can default to, at most 1, safely below the "in use" threshold)
//   rigWeight = how much of the vertex belongs to that added bone (0..1)
//
// and the bone texture slot of each added bone holds R = inverse(M_parent) * M_bone instead
// of its normal skin matrix (see partRig.js). M_parent is the skin matrix of the body bone
// the added chain hangs from, so R is exactly "how far the added bone has moved relative to
// where it would sit if it just followed its body parent": the identity when nothing swings.
//
// The vertex is first moved by D = sum(w_j * R_j) + (1 - sum(w_j)) * I, in bind space, and
// then skinned by the body as usual. Where nothing swings D is the identity and the mesh is
// exactly what the body alone produces.
// ---------------------------------------------------------------------------

export const RIG_INDEX_ATTR = 'rigIndex'
export const RIG_WEIGHT_ATTR = 'rigWeight'
export const RIG_INDEX_BASE = 2
export const RIG_MAX_INFLUENCES = 4

const PARS = `
#ifdef USE_SKINNING
	attribute vec4 rigIndex;
	attribute vec4 rigWeight;
#endif
`

const BASE = `
#ifdef USE_SKINNING
	mat4 rigDelta = mat4( 1.0 );
	if ( rigIndex.x > 1.5 ) {
		float rigTotal = rigWeight.x;
		mat4 rigSum = rigWeight.x * getBoneMatrix( rigIndex.x - 2.0 );
		if ( rigIndex.y > 1.5 ) {
			rigSum += rigWeight.y * getBoneMatrix( rigIndex.y - 2.0 );
			rigTotal += rigWeight.y;
		}
		if ( rigIndex.z > 1.5 ) {
			rigSum += rigWeight.z * getBoneMatrix( rigIndex.z - 2.0 );
			rigTotal += rigWeight.z;
		}
		if ( rigIndex.w > 1.5 ) {
			rigSum += rigWeight.w * getBoneMatrix( rigIndex.w - 2.0 );
			rigTotal += rigWeight.w;
		}
		rigDelta = rigSum + ( 1.0 - rigTotal ) * mat4( 1.0 );
	}
#endif
`

const VERTEX_OLD = 'vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );'
const VERTEX_NEW = 'vec4 skinVertex = rigDelta * ( bindMatrix * vec4( transformed, 1.0 ) );'
const NORMAL_OLD = 'skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;'
const NORMAL_NEW = 'skinMatrix = bindMatrixInverse * skinMatrix * rigDelta * bindMatrix;'

let installed = false

// Patch three's shared skinning chunks. Call once, before any material compiles. Returns true
// when the patch is active; if a future three.js changes a chunk this does nothing (the rig then
// simply has no body-follow offsets) rather than guessing.
export function installRigDeltaShader() {
  if (installed) return true
  const chunks = THREE.ShaderChunk
  const pars = chunks.skinning_pars_vertex
  const base = chunks.skinbase_vertex
  const vertex = chunks.skinning_vertex
  const normal = chunks.skinnormal_vertex
  if (
    typeof pars !== 'string' || typeof base !== 'string' || typeof vertex !== 'string' || typeof normal !== 'string' ||
    vertex.split(VERTEX_OLD).length !== 2 || normal.split(NORMAL_OLD).length !== 2
  ) return false
  chunks.skinning_pars_vertex = `${pars}\n${PARS}`
  chunks.skinbase_vertex = `${base}\n${BASE}`
  chunks.skinning_vertex = vertex.replace(VERTEX_OLD, VERTEX_NEW)
  chunks.skinnormal_vertex = normal.replace(NORMAL_OLD, NORMAL_NEW)
  installed = true
  return true
}

export function isRigDeltaShaderInstalled() {
  return installed
}

// ---------------------------------------------------------------------------
// CPU side: the same maths, for the bone-texture slots and for tests
// ---------------------------------------------------------------------------

const _parentInv = new THREE.Matrix4()
const _bone = new THREE.Matrix4()

// Write each added bone's offset matrix into its skeleton slot. `boneMatrices` already holds the
// normal skin matrices (M = world * boneInverse) for every bone. `links` is [{ index, parent }]:
// the added bone's slot and the slot of the body bone it hangs from. The parent slots are never
// overwritten (they are body bones), so reading them in any order is safe.
export function writeRigOffsets(boneMatrices, links) {
  if (!links || !links.length) return
  const inverses = new Map()
  for (const { index, parent } of links) {
    let inv = inverses.get(parent)
    if (inv === undefined) {
      _parentInv.fromArray(boneMatrices, parent * 16)
      inv = Math.abs(_parentInv.determinant()) > 1e-12 ? _parentInv.clone().invert() : null
      inverses.set(parent, inv)
    }
    if (!inv) {
      _bone.identity() // a collapsed parent has no meaningful offset
    } else {
      _bone.fromArray(boneMatrices, index * 16)
      _bone.premultiply(inv)
    }
    _bone.toArray(boneMatrices, index * 16)
  }
}

// What the shader's `rigDelta` is for one vertex: `offsets(i)` gives the offset matrix of bone slot i.
export function rigDeltaFor(rigIndex, rigWeight, offsets, out = new THREE.Matrix4()) {
  out.identity()
  if (!(rigIndex[0] > 1.5)) return out
  const sum = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  let total = 0
  for (let k = 0; k < RIG_MAX_INFLUENCES; k++) {
    if (!(rigIndex[k] > 1.5)) continue
    const m = offsets(rigIndex[k] - RIG_INDEX_BASE)
    for (let e = 0; e < 16; e++) sum.elements[e] += rigWeight[k] * m.elements[e]
    total += rigWeight[k]
  }
  const rest = 1 - total
  for (let e = 0; e < 16; e += 5) sum.elements[e] += rest // the diagonal: (1 - total) * identity
  return out.copy(sum)
}

const _p = new THREE.Vector3()
const _acc = new THREE.Vector3()
const _m = new THREE.Matrix4()

// Where the vertex is drawn: the vertex shader's maths on the CPU (bind space offset first, then
// the body's own skinning). For tests and for anything that needs to know the drawn position.
export function skinnedVertexWithRig(mesh, index, target = new THREE.Vector3()) {
  const geo = mesh.geometry
  const skeleton = mesh.skeleton
  skeleton.update() // boneMatrices from the live bones (and the added bones' offsets when hooked)
  const bm = skeleton.boneMatrices
  const skinIndex = geo.getAttribute('skinIndex')
  const skinWeight = geo.getAttribute('skinWeight')
  _p.fromBufferAttribute(geo.getAttribute('position'), index).applyMatrix4(mesh.bindMatrix)
  const rigIndex = geo.getAttribute(RIG_INDEX_ATTR)
  const rigWeight = geo.getAttribute(RIG_WEIGHT_ATTR)
  if (rigIndex && rigWeight) {
    const idx = [0, 1, 2, 3].map((k) => rigIndex.getComponent(index, k))
    const w = [0, 1, 2, 3].map((k) => rigWeight.getComponent(index, k))
    const delta = rigDeltaFor(idx, w, (i) => _m.fromArray(bm, i * 16))
    _p.applyMatrix4(delta)
  }
  _acc.set(0, 0, 0)
  for (let k = 0; k < 4; k++) {
    const weight = skinWeight.getComponent(index, k)
    if (!weight) continue
    _m.fromArray(bm, skinIndex.getComponent(index, k) * 16)
    _acc.addScaledVector(target.copy(_p).applyMatrix4(_m), weight)
  }
  return target.copy(_acc).applyMatrix4(mesh.bindMatrixInverse)
}
