import * as THREE from 'three'

// Reduce texture detail: cap the size of the textures a part uses (for example 4096 -> 512 px), so a
// high-resolution model needs far less graphics memory and the exported file shrinks a lot.
//
// Non-destructive, like Reduce detail (decimate.js): the setting is `textureMax` in the per-part
// override map (the longest side, in pixels, a texture may have), so it saves with the project, copies
// with the part and goes through undo / redo. The model's own textures are never touched: the part gets
// its own copy of its materials holding smaller copies of the textures (see materials.js resolveOriginal),
// so the viewport and the exporters both use them, and "Original" brings everything back.
//
// Textures are only ever made smaller, never larger. Compressed textures (KTX2 / Basis), data textures,
// cube maps and video cannot be redrawn this way and are left as they are.

export const TEXTURE_SIZES = [4096, 2048, 1024, 512, 256, 128, 64]

// The setting stored on a part -> the pixel cap, or null for "original".
export function textureMaxOf(override) {
  const v = override && override.textureMax
  return v && v >= 1 ? Math.round(v) : null
}

// Every texture a material holds, as [property, texture].
export function texturesOf(material) {
  const found = []
  if (!material) return found
  for (const key of Object.keys(material)) {
    const value = material[key]
    if (value && value.isTexture) found.push([key, value])
  }
  return found
}

// { width, height } of a texture that can be redrawn smaller, else null.
export function reducibleSize(tex) {
  if (!tex || !tex.isTexture || tex.isCompressedTexture || tex.isDataTexture || tex.isCubeTexture || tex.isVideoTexture) return null
  const image = tex.image
  if (!image || image.data) return null
  const width = image.naturalWidth || image.videoWidth || image.width
  const height = image.naturalHeight || image.videoHeight || image.height
  if (!(width > 0) || !(height > 0)) return null
  return { width, height }
}

// The size a texture ends up at for a cap: shrunk to fit, aspect kept, never below 1 px.
export function reducedSize(width, height, max) {
  const longest = Math.max(width, height)
  if (!max || longest <= max) return { width, height }
  const scale = max / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

const makeCanvas = (w, h) => {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return canvas
}

// Redraw an image smaller. Big reductions go down in halves, which keeps them smooth instead of jagged.
export function drawSmaller(image, from, to) {
  let source = image
  let w = from.width
  let h = from.height
  while (w / 2 >= to.width && h / 2 >= to.height) {
    const nw = Math.max(1, Math.floor(w / 2))
    const nh = Math.max(1, Math.floor(h / 2))
    const step = makeCanvas(nw, nh)
    const ctx = step.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, 0, 0, nw, nh)
    source = step
    w = nw
    h = nh
  }
  const out = makeCanvas(to.width, to.height)
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, to.width, to.height)
  return out
}

// source -> { size -> smaller Source }. Weak, so the smaller copies go when the model's own image does.
const smaller = new WeakMap()

// A smaller copy of one texture (a new Texture sharing a cached smaller image), or the texture itself
// when it is already within the cap or cannot be redrawn.
export function reduceTexture(tex, max) {
  const size = reducibleSize(tex)
  if (!size || !max) return tex
  const target = reducedSize(size.width, size.height, max)
  if (target.width === size.width && target.height === size.height) return tex
  let bySize = smaller.get(tex.source)
  if (!bySize) smaller.set(tex.source, (bySize = new Map()))
  const key = target.width + 'x' + target.height
  let source = bySize.get(key)
  if (!source) {
    const canvas = drawSmaller(tex.image, size, target)
    if (!canvas) return tex
    source = new THREE.Source(canvas)
    bySize.set(key, source)
  }
  const copy = tex.clone()
  copy.source = source // not `.image =`: that would write into the Source the model's own texture shares
  copy.needsUpdate = true
  return copy
}

// A copy of a material whose textures are capped at `max`. Returns { material, textures } (the new
// textures, so they can be disposed later), or null when no texture would change.
export function reduceMaterial(material, max) {
  if (!material) return null
  const swaps = []
  for (const [key, tex] of texturesOf(material)) {
    const next = reduceTexture(tex, max)
    if (next !== tex) swaps.push([key, next])
  }
  if (!swaps.length) return null
  const copy = material.clone()
  copy.userData = {} // Material.clone JSON-copies userData, which would carry the "rim light installed" flag without its hook
  for (const [key, next] of swaps) copy[key] = next
  copy.needsUpdate = true
  return { material: copy, textures: swaps.map(([, t]) => t) }
}

// What a cap does to the textures of some materials, for the panel: unique textures only
// (a texture used by several slots counts once), with an estimate of the graphics memory they take
// (4 bytes a pixel, a third more for mipmaps).
export function textureStats(materials, max) {
  const seen = new Set()
  let count = 0
  let reducedCount = 0
  let largest = 0
  let bytesBefore = 0
  let bytesAfter = 0
  for (const material of materials) {
    for (const [, tex] of texturesOf(material)) {
      const size = reducibleSize(tex)
      if (!size || seen.has(tex.source.uuid)) continue
      seen.add(tex.source.uuid)
      count++
      largest = Math.max(largest, size.width, size.height)
      const target = reducedSize(size.width, size.height, max)
      if (target.width !== size.width || target.height !== size.height) reducedCount++
      bytesBefore += size.width * size.height * 4 * 1.33
      bytesAfter += target.width * target.height * 4 * 1.33
    }
  }
  return { count, reducedCount, largest, bytesBefore, bytesAfter }
}
