import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Attaching lights and cameras to scene objects (props / characters)
//
// An attached light or camera is genuinely re-parented under the object's root,
// so it follows every move/rotate/resize of that object for free — no per-frame
// sync code. Two things make that safe:
//
//  1. A "mount": a Group between the object and the attached thing whose
//     world scale is forced back to 1. Without it the object's own scale leaks
//     into the camera (a character imported in centimetres has a root scale of
//     ~0.01, which would make a camera parented straight to it render the world
//     100x magnified) and into a light's marker.
//
//  2. A registry of everything that is attached ("followers"), so that when an
//     object is DELETED we can pull its lights/cameras back out into the scene
//     first. Otherwise they would be removed — and their GPU resources
//     disposed — along with the object's subtree.
// ---------------------------------------------------------------------------

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _one = new THREE.Vector3(1, 1, 1)
const _m = new THREE.Matrix4()
const _inv = new THREE.Matrix4()

export function createMount() {
  const mount = new THREE.Group()
  mount.name = 'attach-mount'
  mount.userData.isAttachMount = true
  const baseUpdate = mount.updateMatrixWorld.bind(mount)
  // Runs after the parent's matrixWorld is current (parents update first), and
  // cancels whatever scale the ancestors contribute so the mount — and
  // everything under it — is at world scale 1 while still following the
  // ancestors' position and rotation.
  mount.updateMatrixWorld = (force) => {
    if (mount.parent) {
      mount.parent.matrixWorld.decompose(_p, _q, _s)
      mount.scale.set(_s.x ? 1 / _s.x : 1, _s.y ? 1 / _s.y : 1, _s.z ? 1 / _s.z : 1)
    }
    baseUpdate(force)
  }
  return mount
}

// World-space bounds of an object's OWN content — its meshes — leaving out whatever is
// mounted on it (an attached light's glow sphere and beam cone, a camera's body). Those are
// markers, not part of the object, and a long light cone or a camera body parked away from
// it would otherwise stretch the box, so "Set camera to object" framed a tiny prop from
// miles back. Same maths as Box3.setFromObject for everything else.
const _contentBox = new THREE.Box3()
export function getContentBounds(root, target = new THREE.Box3()) {
  target.makeEmpty()
  if (!root) return target
  const walk = (obj) => {
    if (obj.userData && obj.userData.isAttachMount) return
    obj.updateWorldMatrix(false, false)
    const geometry = obj.geometry
    if (geometry) {
      if (obj.boundingBox !== undefined) {
        if (obj.boundingBox === null) obj.computeBoundingBox()
        _contentBox.copy(obj.boundingBox)
      } else {
        if (geometry.boundingBox === null) geometry.computeBoundingBox()
        _contentBox.copy(geometry.boundingBox)
      }
      target.union(_contentBox.applyMatrix4(obj.matrixWorld))
    }
    for (const child of obj.children) walk(child)
  }
  walk(root)
  return target
}

// Bring every world matrix in `obj`'s tree up to date. updateWorldMatrix()
// would bypass the mount's scale-cancelling override above, so refresh from the
// top of the tree with the normal recursive update instead.
function refreshWorld(obj) {
  let top = obj
  while (top.parent) top = top.parent
  top.updateMatrixWorld(true)
}

// Re-parent `obj` under `newParent`, rewriting its local transform so its WORLD
// transform doesn't change.
export function reparentKeepingWorld(obj, newParent) {
  refreshWorld(obj)
  const world = obj.matrixWorld.clone()
  newParent.add(obj)
  refreshWorld(newParent)
  _inv.copy(newParent.matrixWorld).invert()
  _m.multiplyMatrices(_inv, world)
  _m.decompose(obj.position, obj.quaternion, obj.scale)
}

// An object's WORLD position / rotation / scale, wherever it is parented. Copy & paste need
// this: an attached light or camera stores its transform relative to the object it rides on,
// and pasting that as if it were a world position drops the copy somewhere else entirely.
export function getWorldTransform(obj) {
  refreshWorld(obj)
  obj.matrixWorld.decompose(_p, _q, _s)
  return { position: _p.toArray(), quaternion: _q.toArray(), scale: _s.toArray() }
}

// Set an object's WORLD position + orientation, whatever it is parented to
// (its scale is left alone).
export function setObjectWorldTransform(obj, position, quaternion) {
  refreshWorld(obj)
  _m.compose(position, quaternion, _one)
  if (obj.parent) _m.premultiply(_inv.copy(obj.parent.matrixWorld).invert())
  _m.decompose(obj.position, obj.quaternion, _s)
}

// --- follower registry -------------------------------------------------------

const followers = new Set() // { mount, release() }

export function registerFollower(follower) {
  followers.add(follower)
}

export function unregisterFollower(follower) {
  followers.delete(follower)
}

// Pull every light/camera mounted on `root` back out into the scene, keeping
// each where it is in the world. Call BEFORE removing/disposing `root`.
export function releaseFollowersOf(root) {
  if (!root) return
  for (const follower of [...followers]) {
    if (follower.mount.parent === root) follower.release()
  }
}
