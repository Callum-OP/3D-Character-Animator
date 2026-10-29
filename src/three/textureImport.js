import * as THREE from 'three'
import { drawSmaller, reducedSize, reducibleSize, texturesOf } from './textureReduce.js'

// Memory at import time.
//
// A model's textures are by far the biggest part of its memory: a 4096 x 4096 map is 64 MB decoded in the
// page, then about 85 MB again on the graphics card (with mipmaps), and a character has several. Two things
// are done as a model comes in:
//
//   limitTextureSizes   textures larger than the chosen size (default 2048 px on the longest side) are
//                       redrawn smaller before anything uploads them. 2048 is still sharp for a character
//                       filling the viewport, and it takes a quarter of the memory of 4096. "Original" in
//                       the settings keeps every texture exactly as loaded.
//   releaseLoaderCaches the glTF loader's result keeps a reference to everything it read — including the
//                       whole file's bytes — for as long as the model lives. Nothing here reads it again.

// Redraw every texture of `root` that is bigger than `max` px at that size. Textures that cannot be redrawn
// (compressed, data textures, cube maps, video) and ones already small enough are left alone.
// Returns { textures, reduced, bytesBefore, bytesAfter } (decoded size, 4 bytes a pixel).
export function limitTextureSizes(root, max) {
  const stats = { textures: 0, reduced: 0, bytesBefore: 0, bytesAfter: 0 }
  if (!root || !(max >= 1)) return stats
  const done = new Map() // old Source -> its smaller replacement, or null when it cannot be redrawn
  const seenSources = new Set()
  const oldImages = []
  root.traverse((obj) => {
    if (!obj.isMesh && !obj.isSprite) return
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const material of materials) {
      for (const [, tex] of texturesOf(material)) {
        const size = reducibleSize(tex)
        if (!size) continue
        const source = tex.source
        if (!seenSources.has(source)) {
          seenSources.add(source)
          stats.textures++
          stats.bytesBefore += size.width * size.height * 4
          const target = reducedSize(size.width, size.height, max)
          stats.bytesAfter += target.width * target.height * 4
          if (target.width !== size.width || target.height !== size.height) {
            const canvas = drawSmaller(tex.image, size, target)
            if (canvas) {
              done.set(source, new THREE.Source(canvas))
              oldImages.push(tex.image)
              stats.reduced++
            } else {
              done.set(source, null)
              stats.bytesAfter += size.width * size.height * 4 - target.width * target.height * 4 // kept as it was
            }
          }
        }
        const smaller = done.get(source)
        if (smaller) {
          tex.source = smaller
          tex.needsUpdate = true
        }
      }
    }
  })
  // Free the decoded pixels now instead of whenever the garbage collector gets round to them (an
  // ImageBitmap holds its decoded image until it is closed).
  for (const image of oldImages) {
    if (image && typeof image.close === 'function') {
      try {
        image.close()
      } catch {
        /* already closed */
      }
    }
  }
  return stats
}

// Let go of what the glTF loader keeps after it has finished (its parser holds the file's bytes and every
// intermediate it cached). The model itself is untouched. Safe to call on any parse result.
export function releaseLoaderCaches(parsed) {
  const raw = parsed && parsed.source
  if (raw && typeof raw === 'object' && raw.parser) raw.parser = null
}

// Roughly how much memory the textures in a scene take (decoded size, a third more for mipmaps), in MB.
// Each image counts once however many materials use it. For the optional stats readout.
export function estimateTextureMB(scene) {
  if (!scene) return 0
  const seen = new Set()
  let bytes = 0
  scene.traverse((obj) => {
    if (!obj.isMesh && !obj.isSprite) return
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const material of materials) {
      for (const [, tex] of texturesOf(material)) {
        if (seen.has(tex.source)) continue
        seen.add(tex.source)
        const size = reducibleSize(tex)
        if (size) bytes += size.width * size.height * 4 * 1.33
      }
    }
  })
  return bytes / (1024 * 1024)
}
