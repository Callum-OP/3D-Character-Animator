import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js'

// ---------------------------------------------------------------------------
// Inverted-hull outline (pulled forward from Phase 5)
//
// Wraps the renderer in three's OutlineEffect, which draws the classic anime
// outline: each mesh is re-drawn as black back-faces pushed out along the
// surface normal. The push is scaled by clip-space w in the shader, so the
// outline stays a CONSISTENT screen-space thickness regardless of how the model
// is scaled (metre-scale glTF vs centimetre-scale FBX) or how far the camera is.
//
// Rendering routes through the effect always; when disabled it falls straight
// through to renderer.render, so there's no cost when the outline is off. Width
// and colour are read per-material from userData.outlineParameters every frame,
// so changing the width slider updates live without rebuilding anything.
// ---------------------------------------------------------------------------

let effect = null

export function initOutline(renderer) {
  effect = new OutlineEffect(renderer, {
    defaultThickness: 0.003, // very thin by default
    defaultColor: [0, 0, 0], // black outline
    defaultAlpha: 1,
    defaultKeepAlive: false, // let stale outline materials purge after unload
  })
  effect.enabled = false // off until toggled on
  return effect
}

export function getOutlineEffect() {
  return effect
}

export function setOutlineEnabled(on) {
  if (effect) effect.enabled = on
}

// Stamp thickness/colour onto every material currently on the model. Must be
// re-run whenever the active materials change (mode switches swap them), because
// OutlineEffect reads these params off the live material's userData.
export function applyOutlineParams(model, thickness) {
  if (!model) return
  for (const mesh of model.meshes) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const mat of mats) {
      if (!mat) continue
      mat.userData.outlineParameters = {
        thickness,
        color: [0, 0, 0],
        alpha: 1,
        visible: true,
        keepAlive: false,
      }
    }
  }
}

export function disposeOutline() {
  // The effect holds no GPU resources of its own beyond cached outline materials,
  // which drop with the reference; nothing to explicitly dispose here.
  effect = null
}
