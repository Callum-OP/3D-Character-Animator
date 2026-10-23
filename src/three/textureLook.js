import * as THREE from 'three'
import { hasSurface, isStyledCopy } from './surfaceMaterials.js'

export * from './textureLookOptions.js'

// The Look > Material tab: changes what the SURFACES are made of — their textures, colours and
// finish — separately from the Lighting tab, which changes how they are lit. The two stack:
// Noir lighting plus Noir textures, Anime lighting plus a flat-colour floor, and so on.
//
// How it works. Every control reduces to a few numbers (resolveTextureLook), handed to a small
// shader hook installed on a PRIVATE copy of each material (the model's own materials are never
// touched, so "Original" always puts everything back exactly). The hook:
//   • reads the texture at a blurrier mip level  (smoothing / simplifying),
//   • snaps the texture lookup to a coarse grid   (pixelating),
//   • swaps the texture for its own average colour (flat colour — the average of what the mesh
//     actually shows of it, worked out on the CPU, so a texture atlas gives each part its own
//     colour rather than one muddy mix),
//   • then grades the colour: black & white, noir contrast, sepia, pastel, vivid / muted, and
//     snaps it to a few colour bands.
// Flattening bump maps and the matte / glossy / metallic finish are plain material properties.

// ---------------------------------------------------------------------------
// The shader hook
// ---------------------------------------------------------------------------
const KEY = 'charanim-texlook-v1'

const GLSL = `
uniform vec4 tlA; // mip bias, colour bands, pixel cells, contrast
uniform vec4 tlB; // grey, sepia, pastel, flat-colour mix
uniform vec4 tlC; // saturation, strength, 0, on/off
uniform vec3 tlFlat; // the flat colour (linear)
vec3 tlGrade( vec3 lin ) {
  vec3 c = pow( max( lin, vec3( 0.0 ) ), vec3( 0.4545 ) ); // work in display space
  float l = dot( c, vec3( 0.299, 0.587, 0.114 ) );
  c = mix( c, vec3( l ), clamp( tlB.x, 0.0, 1.0 ) );
  c = clamp( ( c - 0.5 ) * tlA.w + 0.5, 0.0, 1.0 );
  vec3 sep = vec3( dot( c, vec3( 0.393, 0.769, 0.189 ) ), dot( c, vec3( 0.349, 0.686, 0.168 ) ), dot( c, vec3( 0.272, 0.534, 0.131 ) ) );
  c = mix( c, clamp( sep, 0.0, 1.0 ), tlB.y );
  float l2 = dot( c, vec3( 0.299, 0.587, 0.114 ) );
  c = mix( vec3( l2 ), c, tlC.x );
  c = mix( c, mix( vec3( l2 ), c, 0.65 ) * 0.6 + 0.4, tlB.z );
  c = clamp( c, 0.0, 1.0 );
  if ( tlA.y > 1.5 ) c = floor( c * ( tlA.y - 1.0 ) + 0.5 ) / ( tlA.y - 1.0 );
  return pow( c, vec3( 2.2 ) );
}
`
const MAP_FRAGMENT = `
#ifdef USE_MAP
  vec2 tlUv = vMapUv;
  vec4 sampledDiffuseColor;
  if ( tlA.z > 0.5 ) {
    // snap to a coarse grid; take the mip level from the real UVs so cell edges don't shimmer
    tlUv = ( floor( vMapUv * tlA.z ) + 0.5 ) / tlA.z;
    sampledDiffuseColor = textureGrad( map, tlUv, dFdx( vMapUv ), dFdy( vMapUv ) );
  } else {
    sampledDiffuseColor = texture2D( map, tlUv, tlA.x );
  }
  #ifdef DECODE_VIDEO_TEXTURE
    sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );
  #endif
  sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, tlFlat, tlB.w );
  diffuseColor *= sampledDiffuseColor;
#endif
`

function hasHook(mat) {
  return typeof mat.customProgramCacheKey === 'function' && String(mat.customProgramCacheKey()).includes(KEY)
}

function ensureUniforms(mat) {
  const u = mat.userData
  if (hasHook(mat) && u.texLookUniforms && u.texLookUniforms.tlA && u.texLookUniforms.tlA.value.isVector4) return u.texLookUniforms
  // A clone keeps userData but not the hook, so (re)build both together.
  const uniforms = {
    tlA: { value: new THREE.Vector4(0, 0, 0, 1) },
    tlB: { value: new THREE.Vector4(0, 0, 0, 0) },
    tlC: { value: new THREE.Vector4(1, 1, 0, 0) },
    tlFlat: { value: new THREE.Color(1, 1, 1) },
  }
  u.texLookUniforms = uniforms
  const prevCompile = mat.onBeforeCompile
  const prevKey = mat.customProgramCacheKey
  mat.customProgramCacheKey = () => String(prevKey.call(mat)) + '|' + KEY
  mat.onBeforeCompile = (shader, renderer) => {
    prevCompile.call(mat, shader, renderer)
    Object.assign(shader.uniforms, uniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL)
      .replace('#include <map_fragment>', MAP_FRAGMENT)
      // after colour_fragment, so Colour replace / region looks (which work there) see the raw colours first
      .replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\n  if ( tlC.w > 0.5 ) diffuseColor.rgb = mix( diffuseColor.rgb, tlGrade( diffuseColor.rgb ), tlC.y );')
  }
  mat.needsUpdate = true
  return uniforms
}

// ---------------------------------------------------------------------------
// Average colour of what a mesh shows of a texture
// ---------------------------------------------------------------------------
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const MAX_SAMPLED_TRIANGLES = 6000

// Pure: the area-weighted average (linear) colour of `pixels` ({ data RGBA8, width, height }) at
// the centres of the triangles `materialIndex` uses (every triangle when the mesh has one
// material). Returns a THREE.Color, or null if the mesh has no usable UVs.
export function averageTextureColor(geometry, materialIndex, texture, pixels, multi = false) {
  const uv = geometry.getAttribute(texture.channel ? 'uv' + texture.channel : 'uv')
  const pos = geometry.getAttribute('position')
  if (!uv || !pos || !pixels) return null
  const index = geometry.index
  const ranges =
    multi && geometry.groups && geometry.groups.length
      ? geometry.groups.filter((g) => g.materialIndex === materialIndex).map((g) => [g.start, g.count])
      : [[0, index ? index.count : pos.count]]
  let triangles = 0
  for (const [, count] of ranges) triangles += Math.floor(count / 3)
  if (!triangles) return null
  const stride = Math.max(1, Math.floor(triangles / MAX_SAMPLED_TRIANGLES))

  if (texture.matrixAutoUpdate) texture.updateMatrix()
  const m = texture.matrix.elements
  const srgb = texture.colorSpace === THREE.SRGBColorSpace
  const clampS = texture.wrapS === THREE.ClampToEdgeWrapping
  const clampT = texture.wrapT === THREE.ClampToEdgeWrapping
  // An ImageBitmap is already oriented for the GPU; flipY does not apply to it.
  const flip = texture.flipY && !(typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap)
  const { data, width, height } = pixels

  let r = 0
  let g = 0
  let b = 0
  let wsum = 0
  let ur = 0
  let ug = 0
  let ub = 0
  let n = 0
  let t = 0
  for (const [start, count] of ranges) {
    for (let i = start; i + 2 < start + count; i += 3) {
      t++
      if ((t - 1) % stride) continue
      const a = index ? index.getX(i) : i
      const bb = index ? index.getX(i + 1) : i + 1
      const c = index ? index.getX(i + 2) : i + 2
      const u = (uv.getX(a) + uv.getX(bb) + uv.getX(c)) / 3
      const v = (uv.getY(a) + uv.getY(bb) + uv.getY(c)) / 3
      let x = m[0] * u + m[3] * v + m[6]
      let y = m[1] * u + m[4] * v + m[7]
      x = clampS ? Math.min(0.9999, Math.max(0, x)) : x - Math.floor(x)
      y = clampT ? Math.min(0.9999, Math.max(0, y)) : y - Math.floor(y)
      const px = Math.min(width - 1, Math.floor(x * width))
      const py = Math.min(height - 1, Math.floor((flip ? 1 - y : y) * height))
      const o = (py * width + px) * 4
      if (data[o + 3] < 12) continue // a see-through texel isn't a colour of the surface
      const cr = data[o] / 255
      const cg = data[o + 1] / 255
      const cb = data[o + 2] / 255
      const lr = srgb ? toLinear(cr) : cr
      const lg = srgb ? toLinear(cg) : cg
      const lb = srgb ? toLinear(cb) : cb
      // weight by the triangle's real size, so a big floor panel outweighs a tiny trim piece
      const ax = pos.getX(bb) - pos.getX(a)
      const ay = pos.getY(bb) - pos.getY(a)
      const az = pos.getZ(bb) - pos.getZ(a)
      const bx = pos.getX(c) - pos.getX(a)
      const by = pos.getY(c) - pos.getY(a)
      const bz = pos.getZ(c) - pos.getZ(a)
      const area = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx)
      const w = area > 1e-12 ? area : 1e-12
      r += lr * w
      g += lg * w
      b += lb * w
      wsum += w
      ur += lr
      ug += lg
      ub += lb
      n++
    }
  }
  if (!n) return null
  // (all-degenerate triangles fall back to a plain average)
  const out = wsum > 1e-9 ? [r / wsum, g / wsum, b / wsum] : [ur / n, ug / n, ub / n]
  return new THREE.Color().setRGB(out[0], out[1], out[2], THREE.LinearSRGBColorSpace)
}

const pixelCache = new WeakMap() // texture -> { version, pixels }
// The texture's pixels as RGBA8, downscaled to at most `max` on a side. null when the browser
// can't hand them over (compressed textures, a blocked canvas, no canvas in tests).
export function readTexturePixels(texture, max = 256) {
  const cached = pixelCache.get(texture)
  if (cached && cached.version === texture.version) return cached.pixels
  let pixels = null
  try {
    const img = texture.image
    if (img && img.data && img.width && img.height && img.data.length >= img.width * img.height * 4 && (img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray)) {
      pixels = { data: img.data, width: img.width, height: img.height }
    } else if (img) {
      const w0 = img.naturalWidth || img.videoWidth || img.width
      const h0 = img.naturalHeight || img.videoHeight || img.height
      if (w0 && h0) {
        const k = Math.min(1, max / Math.max(w0, h0))
        const w = Math.max(1, Math.round(w0 * k))
        const h = Math.max(1, Math.round(h0 * k))
        const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h })
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (ctx) {
          ctx.drawImage(img, 0, 0, w, h)
          pixels = { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h }
        }
      }
    }
  } catch {
    pixels = null
  }
  pixelCache.set(texture, { version: texture.version, pixels })
  return pixels
}

const flatCache = new WeakMap() // mesh -> Map(slot -> { map, version, color })
// The flat colour for one material slot of a mesh, or null if it can't be worked out.
export function getFlatColor(mesh, slot, source) {
  const texture = source && source.map
  if (!texture || !mesh || !mesh.geometry) return null
  let perMesh = flatCache.get(mesh)
  if (!perMesh) flatCache.set(mesh, (perMesh = new Map()))
  const have = perMesh.get(slot)
  if (have && have.map === texture && have.version === texture.version && have.geometry === mesh.geometry) return have.color
  const pixels = readTexturePixels(texture)
  const color = pixels ? averageTextureColor(mesh.geometry, slot, texture, pixels, Array.isArray(mesh.material) || mesh.geometry.groups.length > 1) : null
  perMesh.set(slot, { map: texture, version: texture.version, geometry: mesh.geometry, color })
  return color
}

// ---------------------------------------------------------------------------
// Applying a resolved look to a mesh's materials
// ---------------------------------------------------------------------------
const touched = new WeakSet() // materials we have changed, so switching the look off puts them back

// Put surface relief back as the model (or the material editor's bump strength) has it.
function restoreRelief(target, source, slotLook) {
  if (target.normalScale && source && source.normalScale) {
    if (slotLook && slotLook.normalStrength != null) target.normalScale.set(slotLook.normalStrength, slotLook.normalStrength)
    else target.normalScale.copy(source.normalScale)
  }
  if ('bumpScale' in target && source && source.bumpScale != null) target.bumpScale = source.bumpScale
}

// A finish only ever goes on a private PBR copy, and never over a surface the person set in the
// material editor (that always wins).
function canFinish(target, slotLook) {
  return isStyledCopy(target) && target.isMeshStandardMaterial && !hasSurface(slotLook)
}
function restoreFinish(target, source, slotLook) {
  if (canFinish(target, slotLook) && source && source.isMeshStandardMaterial) {
    target.roughness = source.roughness
    target.metalness = source.metalness
  }
}

function neutralise(target, source, slotLook) {
  const uni = target.userData && target.userData.texLookUniforms
  if (uni && hasHook(target)) {
    uni.tlA.value.set(0, 0, 0, 1)
    uni.tlB.value.set(0, 0, 0, 0)
    uni.tlC.value.set(1, 1, 0, 0)
  }
  restoreRelief(target, source, slotLook)
  restoreFinish(target, source, slotLook)
}

// targets: the materials the mesh renders with now (generated shells / private copies — never
// the shared originals), sources: the model's own, `look`: resolveTextureLook() or null,
// slotLooks: the per-material editor settings for this mesh (its explicit surface beats a finish).
export function applyTextureLook(targets, sources, mesh, look, slotLooks = null) {
  const list = Array.isArray(targets) ? targets : [targets]
  const originals = Array.isArray(sources) ? sources : [sources]
  list.forEach((target, i) => {
    const source = originals[i]
    if (!target || !source) return
    const slotLook = slotLooks ? slotLooks[i] : null
    if (!look) {
      if (touched.has(target)) {
        neutralise(target, source, slotLook)
        touched.delete(target)
      }
      return
    }
    const uni = ensureUniforms(target)
    uni.tlA.value.set(look.bias, look.bands, look.pixels, look.contrast)
    let flat = 0
    if (look.flat > 0 && target.map) {
      const colour = getFlatColor(mesh, i, source)
      if (colour) {
        uni.tlFlat.value.copy(colour)
        flat = look.flat
      }
    }
    uni.tlB.value.set(look.grey, look.sepia, look.pastel, flat)
    uni.tlC.value.set(look.saturation, look.strength, 0, 1)
    // surface relief
    if (look.flatten) {
      if (target.normalScale) target.normalScale.set(0, 0)
      if ('bumpScale' in target) target.bumpScale = 0
    } else restoreRelief(target, source, slotLook)
    // finish
    if (look.finish && canFinish(target, slotLook)) {
      target.roughness = look.finish.roughness
      target.metalness = look.finish.metalness
    } else restoreFinish(target, source, slotLook)
    touched.add(target)
  })
}
