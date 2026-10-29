// When can a frame reuse the shadow maps of the previous one?
//
// Cast shadows depend on the lights and on what stands in them, never on where the camera is. So a frame
// whose ONLY change is the camera (orbit / pan / zoom with nothing else moving) can skip the shadow pass,
// which is a large share of the cost of a frame in a scene with real shadows and lights. Anything else —
// an edit, a loaded model, a toggle, a light change, playback — must redraw them, and so must a frame in
// which a different set of objects reaches the shadow pass (an object coming into view must get its shadow).

// Tracks "something other than the camera changed since the last draw". Starts true: the first draw
// always draws the shadows.
export function createShadowRefresh() {
  let pending = true
  return {
    // Any ordinary render request: assume anything may have moved.
    markChanged() {
      pending = true
    },
    // The scheduled draw asks, and the flag is cleared for the next one.
    take() {
      const was = pending
      pending = false
      return was
    },
    peek: () => pending,
  }
}

export function canReuseShadows({ cameraOnly, continuous, signatureBefore, signatureAfter }) {
  return !!cameraOnly && !continuous && signatureBefore === signatureAfter
}

// A cheap fingerprint of which roots a draw hid from the colour pass.
export function cullSignature(roots) {
  let signature = roots.length
  for (const root of roots) signature = (Math.imul(signature, 31) + root.id) | 0
  return signature
}

// ---------------------------------------------------------------------------------------------
// The key light's shadow map is the biggest single graphics allocation (tens to ~130 MB, depending on
// quality) and three allocates it as soon as the light is allowed to cast — even in an empty scene, and it
// is never given back. So the light only casts while something in the scene can actually cast on it:
//
//   wanted      the user's setting (real shadows on, not the blob)
//   hasCasters  at least one visible root has a shadow-casting mesh
//
// Returns what the light's castShadow should be, and whether its map should be freed now.
export function planKeyShadow({ wanted, hasCasters, castShadow, hasMap }) {
  const cast = !!wanted && !!hasCasters
  return { cast, freeMap: !cast && !!hasMap, change: cast !== !!castShadow }
}
