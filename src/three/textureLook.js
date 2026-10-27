import * as THREE from 'three'
import { hasSurface, isStyledCopy, applyToonSurface } from './surfaceMaterials.js'

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
uniform vec4 tlC; // saturation, strength, clay grey, on/off
uniform vec4 tlD; // manga, keep-shapes mix, palette size, pencil hatching
uniform vec4 tlE; // brightness, tint amount, 0, 0
uniform vec3 tlTint; // tint colour (display space)
uniform vec3 tlPal[8]; // keep-shapes palette (display-space colours)
uniform vec3 tlFlat; // the flat colour (linear)
vec3 tlGrade( vec3 lin ) {
  lin = mix( lin, vec3( 0.26 ), tlC.z ); // clay: every surface becomes one plain grey
  vec3 c = pow( max( lin, vec3( 0.0 ) ), vec3( 0.4545 ) ); // work in display space
  float l = dot( c, vec3( 0.299, 0.587, 0.114 ) );
  c = mix( c, vec3( l ), clamp( tlB.x, 0.0, 1.0 ) );
  c = clamp( ( c - 0.5 ) * tlA.w + 0.5, 0.0, 1.0 );
  vec3 sep = vec3( dot( c, vec3( 0.393, 0.769, 0.189 ) ), dot( c, vec3( 0.349, 0.686, 0.168 ) ), dot( c, vec3( 0.272, 0.534, 0.131 ) ) );
  c = mix( c, clamp( sep, 0.0, 1.0 ), tlB.y );
  float l2 = dot( c, vec3( 0.299, 0.587, 0.114 ) );
  c = mix( vec3( l2 ), c, tlC.x );
  c = mix( c, mix( vec3( l2 ), c, 0.65 ) * 0.6 + 0.4, tlB.z );
  c += tlE.x * 0.4; // brightness
  // tint: repaint in one colour, keeping the light and dark of what was there
  float lt = dot( clamp( c, 0.0, 1.0 ), vec3( 0.299, 0.587, 0.114 ) );
  vec3 tinted = clamp( tlTint / max( dot( tlTint, vec3( 0.299, 0.587, 0.114 ) ), 0.05 ) * lt, 0.0, 1.0 );
  c = mix( c, tinted, tlE.y );
  c = clamp( c, 0.0, 1.0 );
  if ( tlA.y > 1.5 ) c = floor( c * ( tlA.y - 1.0 ) + 0.5 ) / ( tlA.y - 1.0 );
  return pow( c, vec3( 2.2 ) );
}
// Ink, on the LIT colour (so it follows the lighting, not just the texture): how dark a spot is
// decides how much ink it gets — none above a dark grey, full at near-black.
//   manga:  the result is clean ink on clear white paper — every light area the same bright white,
//           very dark areas black. Add hatching and the dark areas are drawn as diagonal pencil
//           hatching instead (a cross-hatch in the darkest), grey in the gaps, black on the lines.
//   not manga (hatch only): the same hatching, darkening the colours it lands on — a coloured comic.
vec3 tlInk( vec3 lit, float manga, float hatch ) {
  float g = pow( clamp( dot( lit, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.0, 1.0 ), 0.4545 );
  float ink = 1.0 - smoothstep( 0.06, 0.30, g );
  float hatchA = step( 0.55, fract( ( gl_FragCoord.x + gl_FragCoord.y ) / 5.0 ) );
  float hatchB = step( 0.55, fract( ( gl_FragCoord.x - gl_FragCoord.y ) / 5.0 ) );
  float hatched = ink * 0.45 + ink * hatchA * 0.30 + smoothstep( 0.55, 1.0, ink ) * hatchB * 0.32;
  float clean = ink * 0.96;
  float darkness = clamp( mix( clean, hatched, hatch ), 0.0, 0.97 );
  if ( manga > 0.5 ) return vec3( pow( 0.985 - darkness * 0.955, 2.2 ) );
  return lit * ( 1.0 - darkness );
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
  if ( tlD.z > 0.5 ) {
    // keep shapes: snap each colour to the nearest of the few clearly different palette colours
    vec3 tlG = pow( max( sampledDiffuseColor.rgb, vec3( 0.0 ) ), vec3( 0.4545 ) );
    float tlBest = 1e9;
    vec3 tlPick = tlG;
    for ( int i = 0; i < 8; i ++ ) {
      if ( float( i ) >= tlD.z ) break;
      vec3 tlDiff = tlG - tlPal[ i ];
      float tlDist = dot( tlDiff, tlDiff );
      if ( tlDist < tlBest ) { tlBest = tlDist; tlPick = tlPal[ i ]; }
    }
    sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, pow( tlPick, vec3( 2.2 ) ), tlD.y );
  }
  diffuseColor *= sampledDiffuseColor;
#endif
`

function hasHook(mat) {
  return typeof mat.customProgramCacheKey === 'function' && String(mat.customProgramCacheKey()).includes(KEY)
}

function ensureUniforms(mat) {
  const u = mat.userData
  if (hasHook(mat) && u.texLookUniforms && u.texLookUniforms.tlE && u.texLookUniforms.tlA.value.isVector4) return u.texLookUniforms
  // A clone keeps userData but not the hook, so (re)build both together.
  const uniforms = {
    tlA: { value: new THREE.Vector4(0, 0, 0, 1) },
    tlB: { value: new THREE.Vector4(0, 0, 0, 0) },
    tlC: { value: new THREE.Vector4(1, 1, 0, 0) },
    tlD: { value: new THREE.Vector4(0, 0, 0, 0) },
    tlE: { value: new THREE.Vector4(0, 0, 0, 0) },
    tlTint: { value: new THREE.Vector3(1, 1, 1) },
    tlPal: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
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
      // manga / pencil hatching work on the finished, lit colour
      .replace('#include <tonemapping_fragment>', 'if ( tlC.w > 0.5 && ( tlD.x > 0.5 || tlD.w > 0.5 ) ) gl_FragColor.rgb = mix( gl_FragColor.rgb, tlInk( gl_FragColor.rgb, tlD.x, tlD.w ), tlC.y );\n  #include <tonemapping_fragment>')
  }
  mat.needsUpdate = true
  return uniforms
}

// ---------------------------------------------------------------------------
// Average colour of what a mesh shows of a texture
// ---------------------------------------------------------------------------
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const MAX_SAMPLED_TRIANGLES = 6000

// How a texture is read at a UV: its transform (repeat / offset), wrapping, which way up the image
// is, and its colour space. Returns (u, v) -> [r, g, b, a] in 0..1 (as stored: display-space for
// sRGB textures) or null for a see-through texel.
function makeTexelReader(texture, pixels) {
  if (texture.matrixAutoUpdate) texture.updateMatrix()
  const m = texture.matrix.elements
  const clampS = texture.wrapS === THREE.ClampToEdgeWrapping
  const clampT = texture.wrapT === THREE.ClampToEdgeWrapping
  // An ImageBitmap is already oriented for the GPU; flipY does not apply to it.
  const flip = texture.flipY && !(typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap)
  const { data, width, height } = pixels
  const out = [0, 0, 0, 1]
  return (u, v) => {
    let x = m[0] * u + m[3] * v + m[6]
    let y = m[1] * u + m[4] * v + m[7]
    x = clampS ? Math.min(0.9999, Math.max(0, x)) : x - Math.floor(x)
    y = clampT ? Math.min(0.9999, Math.max(0, y)) : y - Math.floor(y)
    const px = Math.min(width - 1, Math.floor(x * width))
    const py = Math.min(height - 1, Math.floor((flip ? 1 - y : y) * height))
    const o = (py * width + px) * 4
    if (data[o + 3] < 12) return null // a see-through texel isn't a colour of the surface
    out[0] = data[o] / 255
    out[1] = data[o + 1] / 255
    out[2] = data[o + 2] / 255
    return out
  }
}

// The triangles a material slot uses, as [start, count] index ranges.
function slotRanges(geometry, materialIndex, multi, vertexCount) {
  const index = geometry.index
  return multi && geometry.groups && geometry.groups.length
    ? geometry.groups.filter((g) => g.materialIndex === materialIndex).map((g) => [g.start, g.count])
    : [[0, index ? index.count : vertexCount]]
}

const triArea = (pos, a, b, c) => {
  const ax = pos.getX(b) - pos.getX(a)
  const ay = pos.getY(b) - pos.getY(a)
  const az = pos.getZ(b) - pos.getZ(a)
  const bx = pos.getX(c) - pos.getX(a)
  const by = pos.getY(c) - pos.getY(a)
  const bz = pos.getZ(c) - pos.getZ(a)
  return 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx)
}

// Pure: the area-weighted average (linear) colour of `pixels` ({ data RGBA8, width, height }) at
// the centres of the triangles `materialIndex` uses (every triangle when the mesh has one
// material). Returns a THREE.Color, or null if the mesh has no usable UVs.
export function averageTextureColor(geometry, materialIndex, texture, pixels, multi = false) {
  const uv = geometry.getAttribute(texture.channel ? 'uv' + texture.channel : 'uv')
  const pos = geometry.getAttribute('position')
  if (!uv || !pos || !pixels) return null
  const index = geometry.index
  const ranges = slotRanges(geometry, materialIndex, multi, pos.count)
  let triangles = 0
  for (const [, count] of ranges) triangles += Math.floor(count / 3)
  if (!triangles) return null
  const stride = Math.max(1, Math.floor(triangles / MAX_SAMPLED_TRIANGLES))
  const read = makeTexelReader(texture, pixels)
  const srgb = texture.colorSpace === THREE.SRGBColorSpace

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
      const texel = read((uv.getX(a) + uv.getX(bb) + uv.getX(c)) / 3, (uv.getY(a) + uv.getY(bb) + uv.getY(c)) / 3)
      if (!texel) continue
      const lr = srgb ? toLinear(texel[0]) : texel[0]
      const lg = srgb ? toLinear(texel[1]) : texel[1]
      const lb = srgb ? toLinear(texel[2]) : texel[2]
      // weight by the triangle's real size, so a big floor panel outweighs a tiny trim piece
      const area = triArea(pos, a, bb, c)
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

// ---------------------------------------------------------------------------
// "Flat — keep shapes": the few clearly different colours of a texture
// ---------------------------------------------------------------------------
const PALETTE_SAMPLES = 6000

// Pure: colours (display-space r,g,b triples in a Float32Array) sampled at random points over the
// surface the mesh really shows of its texture — not just triangle centres, so a small window
// inside one big wall triangle is still found. Seeded, so the result is stable.
export function sampleTextureColours(geometry, materialIndex, texture, pixels, multi = false, count = PALETTE_SAMPLES) {
  const uv = geometry.getAttribute(texture.channel ? 'uv' + texture.channel : 'uv')
  const pos = geometry.getAttribute('position')
  if (!uv || !pos || !pixels) return null
  const index = geometry.index
  const tris = []
  const cumulative = []
  let total = 0
  for (const [start, n] of slotRanges(geometry, materialIndex, multi, pos.count)) {
    for (let i = start; i + 2 < start + n; i += 3) {
      const a = index ? index.getX(i) : i
      const b = index ? index.getX(i + 1) : i + 1
      const c = index ? index.getX(i + 2) : i + 2
      const area = triArea(pos, a, b, c)
      if (!(area > 1e-12)) continue
      total += area
      tris.push([a, b, c])
      cumulative.push(total)
    }
  }
  if (!tris.length) return null
  const read = makeTexelReader(texture, pixels)
  const srgb = texture.colorSpace === THREE.SRGBColorSpace
  let seed = 0x9e3779b9
  const rand = () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = new Float32Array(count * 3)
  let got = 0
  for (let s = 0; s < count; s++) {
    // pick a triangle in proportion to its area, then a uniform point inside it
    const target = rand() * total
    let lo = 0
    let hi = cumulative.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cumulative[mid] < target) lo = mid + 1
      else hi = mid
    }
    const [a, b, c] = tris[lo]
    const r1 = Math.sqrt(rand())
    const r2 = rand()
    const wa = 1 - r1
    const wb = r1 * (1 - r2)
    const wc = r1 * r2
    const texel = read(uv.getX(a) * wa + uv.getX(b) * wb + uv.getX(c) * wc, uv.getY(a) * wa + uv.getY(b) * wb + uv.getY(c) * wc)
    if (!texel) continue
    for (let k = 0; k < 3; k++) out[got * 3 + k] = srgb ? texel[k] : Math.pow(texel[k], 1 / 2.2)
    got++
  }
  return got ? out.slice(0, got * 3) : null
}

// Pure: the clearly different colours in a set of display-space colours. The most common colour
// becomes a palette entry and absorbs everything within `threshold` of it, then the next most
// common colour left becomes the next entry, and so on — so two colours only stay separate if
// they are at least `threshold` apart, and grain, dirt and gradients that stay inside it vanish
// into their colour. Shades making up under `minShare` of the surface (stray specks) fold into
// their nearest neighbour. Returns up to `maxColors` [r, g, b] colours, most common first.
export function extractPalette(samples, { threshold = 0.26, maxColors = 8, minShare = 0.02 } = {}) {
  const n = samples ? Math.floor(samples.length / 3) : 0
  if (!n) return []
  const LEVELS = 16
  const bins = new Map()
  for (let i = 0; i < n; i++) {
    const r = samples[i * 3]
    const g = samples[i * 3 + 1]
    const b = samples[i * 3 + 2]
    const key = (Math.min(LEVELS - 1, Math.floor(r * LEVELS)) << 8) | (Math.min(LEVELS - 1, Math.floor(g * LEVELS)) << 4) | Math.min(LEVELS - 1, Math.floor(b * LEVELS))
    const bin = bins.get(key)
    if (bin) {
      bin.count++
      bin.r += r
      bin.g += g
      bin.b += b
    } else bins.set(key, { count: 1, r, g, b })
  }
  const remaining = [...bins.values()]
    .map((bin) => ({ count: bin.count, c: [bin.r / bin.count, bin.g / bin.count, bin.b / bin.count] }))
    .sort((a, b) => b.count - a.count)
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
  const clusters = []
  while (remaining.length && clusters.length < maxColors) {
    const seed = remaining.shift()
    const cluster = { seed: seed.c, count: seed.count, sum: seed.c.map((v) => v * seed.count) }
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (dist(remaining[i].c, seed.c) < threshold) {
        const bin = remaining[i]
        cluster.count += bin.count
        for (let k = 0; k < 3; k++) cluster.sum[k] += bin.c[k] * bin.count
        remaining.splice(i, 1)
      }
    }
    clusters.push(cluster)
  }
  const mean = (cl) => cl.sum.map((v) => v / cl.count)
  for (const bin of remaining) {
    // beyond the palette size: join the nearest colour
    let best = clusters[0]
    for (const cl of clusters) if (dist(bin.c, mean(cl)) < dist(bin.c, mean(best))) best = cl
    best.count += bin.count
    for (let k = 0; k < 3; k++) best.sum[k] += bin.c[k] * bin.count
  }
  const sorted = clusters.sort((a, b) => b.count - a.count)
  const keep = sorted.filter((cl, i) => i === 0 || cl.count / n >= minShare)
  return keep.map(mean)
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

const paletteCache = new WeakMap() // mesh -> Map(slot -> { map, version, geometry, threshold, palette })
// The clearly different colours of what one material slot of a mesh shows of its texture (display-space
// [r, g, b] list), or null if they can't be worked out.
export function getPalette(mesh, slot, source, threshold) {
  const texture = source && source.map
  if (!texture || !mesh || !mesh.geometry) return null
  let perMesh = paletteCache.get(mesh)
  if (!perMesh) paletteCache.set(mesh, (perMesh = new Map()))
  const key = Math.round(threshold * 100)
  const have = perMesh.get(slot)
  if (have && have.map === texture && have.version === texture.version && have.geometry === mesh.geometry && have.key === key) return have.palette
  const pixels = readTexturePixels(texture)
  const multi = Array.isArray(mesh.material) || mesh.geometry.groups.length > 1
  const samples = pixels ? sampleTextureColours(mesh.geometry, slot, texture, pixels, multi) : null
  const palette = samples ? extractPalette(samples, { threshold }) : null
  perMesh.set(slot, { map: texture, version: texture.version, geometry: mesh.geometry, key, palette })
  return palette
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
    uni.tlD.value.set(0, 0, 0, 0)
    uni.tlE.value.set(0, 0, 0, 0)
  }
  restoreRelief(target, source, slotLook)
  restoreFinish(target, source, slotLook)
}

// targets: the materials the mesh renders with now (generated shells / private copies — never
// the shared originals), sources: the model's own, `look`: resolveTextureLook() or null,
// slotLooks: the per-material editor settings for this mesh (its explicit surface beats a finish).
export function applyTextureLook(targets, sources, mesh, look, slotLooks = null, { toon = null } = {}) {
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
    uni.tlC.value.set(look.saturation, look.strength, look.clay, 1)
    uni.tlE.value.set(look.brightness, look.tintAmount, 0, 0)
    uni.tlTint.value.set(look.tint[0], look.tint[1], look.tint[2])
    // keep shapes: the clearly different colours of the texture, as a small palette
    let paletteSize = 0
    if (look.regions > 0 && target.map) {
      const palette = getPalette(mesh, i, source, look.threshold)
      if (palette && palette.length) {
        palette.slice(0, 8).forEach((c, k) => uni.tlPal.value[k].set(c[0], c[1], c[2]))
        paletteSize = Math.min(8, palette.length)
      }
    }
    uni.tlD.value.set(look.manga, paletteSize ? look.regions : 0, paletteSize, look.hatch)
    // finish in the toon modes: a stylised highlight (they have no real shine). Done before the
    // relief below, because it also sets the bump strength.
    // (Matte has no highlight to draw, so it changes nothing and installs nothing.)
    const f = look.finishToon
    if (toon && target.isMeshToonMaterial && f && (f.specularIntensity > 0 || f.metalness > 0) && !hasSurface(slotLook)) {
      applyToonSurface(target, source, f, { soft: !!toon.soft })
    }
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
