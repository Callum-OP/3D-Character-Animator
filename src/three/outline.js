import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js'

// ---------------------------------------------------------------------------
// Inverted-hull outline
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
//
// `soften` (0..1) thins the outline globally; per-mesh overrides can switch it
// off entirely (e.g. no outline on the face). NOTE: outline visibility is keyed
// by material, so if two meshes share one material object (rare — usually each
// part has its own), they can't have different outline states.
export function applyOutlineParams(model, width, soften = 0, overrides = {}) {
  if (!model) return
  const thickness = width * (1 - soften) // global soften thins the outline
  for (const mesh of model.meshes) {
    const ov = overrides[mesh.uuid]
    const visible = !ov || ov.outline !== false // default on
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const mat of mats) {
      if (!mat) continue
      mat.userData.outlineParameters = {
        thickness,
        color: [0, 0, 0],
        alpha: 1,
        visible,
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
