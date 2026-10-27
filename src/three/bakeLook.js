import * as THREE from 'three'
import { getFlatColor, getPalette } from './textureLook.js'
import { reducibleSize, drawSmaller } from './textureReduce.js'
import { hasSurface } from './surfaceMaterials.js'

// "Include Material look in export": writes the Look > Material settings into the exported file, so a model
// opened in another program (a 3D editor, Unity, a game engine) has the same textures, colours and finish.
//
// The look is a display effect while you work (a shader on private copies of the materials). A file has no
// shader, so what can be baked into the textures and colours of REAL materials is:
//   • the colour grade — black & white, noir, sepia, pastel, vivid / muted, clay grey, contrast, brightness,
//     saturation, tint and the colour tones (bands). It works on the surface colour before any lighting, so
//     baking it gives the same colours,
//   • Flat colour and Flat — keep shapes (each texture becomes its own average colour / a few clear colours),
//   • Smoothed / Simplified (the texture is stored smaller and blurrier) and Pixel (a chunky low-resolution
//     texture with hard edges),
//   • Flatten bumps (normal / bump maps removed) and the matte / satin / glossy / metallic finish.
// What cannot be baked is drawn from the LIT colour on screen: Manga ink and Pencil hatching. (They are
// reported so it is never a silent surprise.) The Lighting styles (toon, outlines) are not part of a model either.
//
// The model's own materials and textures are never touched: baked materials are copies on the export copy.

const LUMA = [0.299, 0.587, 0.114]
const mix = (a, b, t) => a + (b - a) * t
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

// What of a raw look (store.materialLook) cannot be put in a file.
export function lookExportNotes(look) {
  const notes = []
  if (look && look.colour === 'manga') notes.push('Manga ink')
  if (look && look.finish === 'hatch') notes.push('pencil hatching')
  return notes
}

// The colour grade of the surface shader (textureLook.js tlGrade), on one linear colour, with the tone steps.
// `look` is resolveTextureLook()'s result. Returns the new linear colour in `out`.
export function gradeColour(r, g, b, look, out = [0, 0, 0]) {
  const k = look.clay
  r = mix(r, 0.26, k)
  g = mix(g, 0.26, k)
  b = mix(b, 0.26, k)
  let cr = Math.pow(Math.max(r, 0), 0.4545)
  let cg = Math.pow(Math.max(g, 0), 0.4545)
  let cb = Math.pow(Math.max(b, 0), 0.4545)
  let l = cr * LUMA[0] + cg * LUMA[1] + cb * LUMA[2]
  const grey = clamp01(look.grey)
  cr = mix(cr, l, grey)
  cg = mix(cg, l, grey)
  cb = mix(cb, l, grey)
  cr = clamp01((cr - 0.5) * look.contrast + 0.5)
  cg = clamp01((cg - 0.5) * look.contrast + 0.5)
  cb = clamp01((cb - 0.5) * look.contrast + 0.5)
  if (look.sepia) {
    const sr = clamp01(cr * 0.393 + cg * 0.769 + cb * 0.189)
    const sg = clamp01(cr * 0.349 + cg * 0.686 + cb * 0.168)
    const sb = clamp01(cr * 0.272 + cg * 0.534 + cb * 0.131)
    cr = mix(cr, sr, look.sepia)
    cg = mix(cg, sg, look.sepia)
    cb = mix(cb, sb, look.sepia)
  }
  const l2 = cr * LUMA[0] + cg * LUMA[1] + cb * LUMA[2]
  cr = mix(l2, cr, look.saturation)
  cg = mix(l2, cg, look.saturation)
  cb = mix(l2, cb, look.saturation)
  if (look.pastel) {
    cr = mix(cr, mix(l2, cr, 0.65) * 0.6 + 0.4, look.pastel)
    cg = mix(cg, mix(l2, cg, 0.65) * 0.6 + 0.4, look.pastel)
    cb = mix(cb, mix(l2, cb, 0.65) * 0.6 + 0.4, look.pastel)
  }
  const lift = look.brightness * 0.4
  cr += lift
  cg += lift
  cb += lift
  if (look.tintAmount) {
    const lt = clamp01(cr) * LUMA[0] + clamp01(cg) * LUMA[1] + clamp01(cb) * LUMA[2]
    const t = look.tint
    const scale = lt / Math.max(t[0] * LUMA[0] + t[1] * LUMA[1] + t[2] * LUMA[2], 0.05)
    cr = mix(cr, clamp01(t[0] * scale), look.tintAmount)
    cg = mix(cg, clamp01(t[1] * scale), look.tintAmount)
    cb = mix(cb, clamp01(t[2] * scale), look.tintAmount)
  }
  cr = clamp01(cr)
  cg = clamp01(cg)
  cb = clamp01(cb)
  if (look.bands > 1.5) {
    const n = look.bands - 1
    cr = Math.floor(cr * n + 0.5) / n
    cg = Math.floor(cg * n + 0.5) / n
    cb = Math.floor(cb * n + 0.5) / n
  }
  out[0] = Math.pow(cr, 2.2)
  out[1] = Math.pow(cg, 2.2)
  out[2] = Math.pow(cb, 2.2)
  return out
}

// One texel through the whole look, as the shader does it: flat colour, keep-shapes palette, the material's
// own colour, then the grade blended in by the look's strength. `t` and the result are linear.
const scratch = [0, 0, 0]
function shadeTexel(tr, tg, tb, look, plan, out) {
  if (plan.flat) {
    tr = mix(tr, plan.flat[0], plan.flatMix)
    tg = mix(tg, plan.flat[1], plan.flatMix)
    tb = mix(tb, plan.flat[2], plan.flatMix)
  }
  if (plan.palette) {
    const pr = Math.pow(Math.max(tr, 0), 0.4545)
    const pg = Math.pow(Math.max(tg, 0), 0.4545)
    const pb = Math.pow(Math.max(tb, 0), 0.4545)
    let best = Infinity
    let pick = null
    for (const c of plan.palette) {
      const d = (pr - c[0]) ** 2 + (pg - c[1]) ** 2 + (pb - c[2]) ** 2
      if (d < best) {
        best = d
        pick = c
      }
    }
    if (pick) {
      tr = mix(tr, Math.pow(pick[0], 2.2), look.regions)
      tg = mix(tg, Math.pow(pick[1], 2.2), look.regions)
      tb = mix(tb, Math.pow(pick[2], 2.2), look.regions)
    }
  }
  const dr = tr * plan.color[0]
  const dg = tg * plan.color[1]
  const db = tb * plan.color[2]
  gradeColour(dr, dg, db, look, scratch)
  out[0] = mix(dr, scratch[0], look.strength)
  out[1] = mix(dg, scratch[1], look.strength)
  out[2] = mix(db, scratch[2], look.strength)
  return out
}

// sRGB byte <-> linear
const BYTE_TO_LINEAR = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  BYTE_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
const LUT = 4096
const LINEAR_TO_BYTE = new Uint8Array(LUT + 1)
for (let i = 0; i <= LUT; i++) {
  const x = i / LUT
  const c = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
  LINEAR_TO_BYTE[i] = Math.round(clamp01(c) * 255)
}
const toByte = (x) => LINEAR_TO_BYTE[Math.round(clamp01(x) * LUT)]

const MAX_SIDE = 4096

// The texture, redrawn the size the look wants (smoothed = smaller, pixel = a tiny grid) with every texel graded.
function bakeImage(map, look, plan) {
  const size = reducibleSize(map)
  if (!size) return null
  let width = size.width
  let height = size.height
  if (look.pixels > 0) {
    width = height = Math.max(1, Math.round(look.pixels))
  } else if (look.bias > 0) {
    const f = Math.pow(2, look.bias)
    width = Math.max(4, Math.round(width / f))
    height = Math.max(4, Math.round(height / f))
  }
  const over = Math.max(width, height) / MAX_SIDE
  if (over > 1) {
    width = Math.max(1, Math.round(width / over))
    height = Math.max(1, Math.round(height / over))
  }
  const canvas = drawSmaller(map.image, size, { width, height })
  if (!canvas) return null
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const image = ctx.getImageData(0, 0, width, height)
  const data = image.data
  const out = [0, 0, 0]
  let lastKey = -1
  let lr = 0
  let lg = 0
  let lb = 0
  for (let i = 0; i < data.length; i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    if (key !== lastKey) {
      shadeTexel(BYTE_TO_LINEAR[data[i]], BYTE_TO_LINEAR[data[i + 1]], BYTE_TO_LINEAR[data[i + 2]], look, plan, out)
      lastKey = key
      lr = toByte(out[0])
      lg = toByte(out[1])
      lb = toByte(out[2])
    }
    data[i] = lr
    data[i + 1] = lg
    data[i + 2] = lb
  }
  ctx.putImageData(image, 0, 0)
  const texture = map.clone()
  texture.source = new THREE.Source(canvas) // not `.image =`: that would write into the Source the model's own texture shares
  if (look.pixels > 0) {
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false
  }
  texture.needsUpdate = true
  return texture
}

const round = (n) => Math.round(n * 1000) / 1000
function lookSignature(look) {
  return [look.strength, look.bias, look.pixels, look.bands, look.grey, look.contrast, look.sepia, look.pastel, look.saturation, look.clay, look.brightness, look.tintAmount, ...look.tint, look.regions].map(round).join(',')
}

// Bake the look into one material (a copy is returned; `material` is never changed).
// Returns { material, baked } — `baked` false when nothing could be done (kept as it was).
function bakeOne(material, { mesh, slot, source, slotLook, look, cache }) {
  if (!material || !material.color || material.isShaderMaterial) return { material, baked: false }
  const map = material.map
  const plan = { color: [material.color.r, material.color.g, material.color.b], flat: null, flatMix: 0, palette: null }
  if (map && source && source.map) {
    if (look.flat > 0) {
      const c = getFlatColor(mesh, slot, source)
      if (c) {
        plan.flat = [c.r, c.g, c.b]
        plan.flatMix = look.flat
      }
    }
    if (look.regions > 0) {
      const palette = getPalette(mesh, slot, source, look.threshold)
      if (palette && palette.length) plan.palette = palette.slice(0, 8)
    }
  }
  const alphaFromMap = !!map && (material.transparent || material.alphaTest > 0)
  const constant =
    !alphaFromMap && (!map || (plan.flat && plan.flatMix >= 0.999) || (look.clay >= 0.999 && look.strength >= 0.999))

  const copy = material.clone()
  copy.userData = {} // Material.clone JSON-copies userData, which would carry app flags without their hooks
  if (constant) {
    const out = [0, 0, 0]
    const start = plan.flat && plan.flatMix >= 0.999 ? plan.flat : [1, 1, 1]
    shadeTexel(start[0], start[1], start[2], look, plan, out)
    copy.color.setRGB(out[0], out[1], out[2], THREE.LinearSRGBColorSpace)
    copy.map = null
  } else if (map) {
    const key = [
      map.source.uuid,
      map.colorSpace,
      lookSignature(look),
      plan.color.map(round).join(','),
      plan.flat ? plan.flat.map(round).join(',') + '@' + round(plan.flatMix) : '-',
      plan.palette ? plan.palette.map((c) => c.map(round).join(',')).join(';') : '-',
    ].join('|')
    let baked = cache.get(key)
    if (baked === undefined) {
      baked = bakeImage(map, look, plan)
      cache.set(key, baked)
    }
    if (!baked) return { material, baked: false }
    copy.map = baked
    copy.color.setRGB(1, 1, 1, THREE.LinearSRGBColorSpace) // the colour is already inside the texture
  }
  if (look.flatten) {
    copy.normalMap = null
    copy.bumpMap = null
  }
  if (look.finish && copy.isMeshStandardMaterial && !hasSurface(slotLook)) {
    copy.roughness = look.finish.roughness
    copy.metalness = look.finish.metalness
    copy.roughnessMap = null
    copy.metalnessMap = null
  }
  copy.needsUpdate = true
  return { material: copy, baked: true }
}

/**
 * Bake a resolved Look > Material (`look`: resolveTextureLook()) into the material(s) a mesh will be exported
 * with. `sources` are the model's own materials for the same slots (colours are measured from their textures).
 * `cache` is a Map shared by one export, so a texture used by several parts is baked once.
 * Returns { material, baked, failed }.
 */
export function bakeLookIntoMaterials(material, { mesh, sources, slotLooks = null, look, cache }) {
  if (!look || !material) return { material, baked: 0, failed: 0 }
  const list = Array.isArray(material) ? material : [material]
  const sourceAt = (k) => (Array.isArray(sources) ? sources[k] ?? sources[0] : sources)
  const slotFor = (k) => (Array.isArray(sources) && sources.length === list.length ? k : 0)
  let baked = 0
  let failed = 0
  const made = list.map((m, k) => {
    const r = bakeOne(m, { mesh, slot: slotFor(k), source: sourceAt(k), slotLook: slotLooks ? slotLooks[slotFor(k)] : null, look, cache })
    if (r.baked) baked++
    else failed++
    return r.material
  })
  return { material: Array.isArray(material) ? made : made[0], baked, failed }
}
