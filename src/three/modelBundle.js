import { zipSync, unzipSync } from 'three/examples/jsm/libs/fflate.module.js'

// ---------------------------------------------------------------------------
// Models that come as a FOLDER (or a zip of one)
//
// A lot of 3D downloads aren't a single file: an .fbx or .obj next to a
// textures/ folder, a .gltf with its .bin and images, an .obj + .mtl + pictures,
// a Sketchfab zip with source/ and textures/. The model file only stores NAMES
// for those other files — Autodesk's FBX docs: with "Embed media" off the file
// holds the relative and absolute path of each texture as exported, so it breaks
// as soon as the files move. Browsers can't open sibling files by path from a
// plain file pick, so everything the model needs has to be handed over together.
//
// That is what this module does: gather the files (several picked/dropped files,
// a dropped or picked folder, or a .zip), choose the main model, and pack the lot
// into ONE self-contained zip File. Everything downstream (loading, saving the
// project, re-opening it) keeps working with a single File exactly as before —
// loadModel.js unpacks the zip and serves each requested texture from it.
// ---------------------------------------------------------------------------

// Main-model formats, in the order we prefer one when a folder holds several.
export const MODEL_EXTENSIONS = ['fbx', 'glb', 'gltf', 'dae', 'obj', 'ply', 'stl']
export const BUNDLE_EXTENSIONS = ['zip']
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tga', 'tif', 'tiff']
// Everything besides images that a model can pull in by name.
const SUPPORT_EXTENSIONS = ['mtl', 'bin']

export const extOf = (name) => {
  const m = /\.([^./\\]+)$/.exec(name || '')
  return m ? m[1].toLowerCase() : ''
}
export const baseNameOf = (path) => String(path || '').replace(/\\/g, '/').split('/').pop()
export const stemOf = (name) => baseNameOf(name).replace(/\.[^.]+$/, '')
export const isModelName = (name) => MODEL_EXTENSIONS.includes(extOf(name))
export const isImageName = (name) => IMAGE_EXTENSIONS.includes(extOf(name))
const isSupportName = (name) => SUPPORT_EXTENSIONS.includes(extOf(name))
// 3D program project files people often have next to an export — can't be opened
// here, so say what to do instead of a vague "no model found".
const UNSUPPORTED_MODEL_EXTENSIONS = ['blend', 'max', 'ma', 'mb', 'c4d', '3ds', 'usd', 'usda', 'usdc', 'usdz', 'abc', 'skp', 'lwo', 'x3d', '3mf', 'off']
const isJunkPath = (path) => /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(path) || /(^|\/)\._/.test(path)

// The string for a file input's `accept` — models, a zip bundle, and the loose
// textures/materials that can ride along when several files are picked at once.
export const MODEL_ACCEPT = [
  ...MODEL_EXTENSIONS,
  ...BUNDLE_EXTENSIONS,
  ...SUPPORT_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
].map((e) => '.' + e).join(',')

// --- Path helpers ------------------------------------------------------------

// Clean a path or URL a loader asked for into a plain relative path:
// forward slashes, no query/hash, no drive letter, "." and ".." resolved.
export function normalizeResourcePath(raw) {
  let p = String(raw || '')
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/*/i, (m) => (/^[a-z]:[\\/]/i.test(m) ? m : '')) // scheme://
  p = p.split(/[?#]/)[0]
  try {
    p = decodeURIComponent(p)
  } catch {
    // not valid percent-encoding — use it as it is
  }
  p = p.replace(/\\/g, '/').replace(/^[a-z]:\//i, '') // C:\Users\... -> Users/...
  const out = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

// Finds the file a model is asking for. Models name their textures in all sorts
// of ways — relative to the model ("../textures/a.png"), relative to the
// exporter's project, an absolute path from someone else's machine
// ("C:\Users\me\Desktop\a.png"), wrong case, a different image extension — so it
// tries the exact path first and then progressively looser matches, ending at
// the bare file name, which is what almost always identifies it.
export function createResourceResolver(paths) {
  const list = [...paths]
  const byLower = new Map(list.map((p) => [p.toLowerCase(), p]))
  const byBase = new Map()
  const byStem = new Map()
  for (const p of list) {
    const base = baseNameOf(p).toLowerCase()
    if (!byBase.has(base)) byBase.set(base, [])
    byBase.get(base).push(p)
    if (isImageName(p)) {
      const stem = stemOf(p).toLowerCase()
      if (!byStem.has(stem)) byStem.set(stem, [])
      byStem.get(stem).push(p)
    }
  }
  const sharedTail = (a, b) => {
    const A = a.toLowerCase().split('/').reverse()
    const B = b.toLowerCase().split('/').reverse()
    let n = 0
    while (n < A.length && n < B.length && A[n] === B[n]) n++
    return n
  }
  const best = (candidates, wanted) =>
    [...candidates].sort((x, y) => sharedTail(y, wanted) - sharedTail(x, wanted) || x.length - y.length)[0]

  return {
    find(raw) {
      const wanted = normalizeResourcePath(raw)
      if (!wanted) return null
      const lower = wanted.toLowerCase()
      if (byLower.has(lower)) return byLower.get(lower)
      // "textures/a.png" asked for, file stored as "model/textures/a.png"
      const tail = list.filter((p) => p.toLowerCase().endsWith('/' + lower))
      if (tail.length) return best(tail, wanted)
      // Same file name, any folder — prefer the folder that shares the most trailing path.
      const base = baseNameOf(wanted).toLowerCase()
      if (byBase.has(base)) return best(byBase.get(base), wanted)
      // A texture exported as .psd/.tga but shipped as .png/.jpg: same name, any image type.
      if (isImageName(wanted) || extOf(wanted) === 'psd') {
        const stem = stemOf(wanted).toLowerCase()
        if (byStem.has(stem)) return best(byStem.get(stem), wanted)
      }
      return null
    },
  }
}

// --- Gathering files ---------------------------------------------------------

// Each gathered file keeps the path it had inside the folder it came from.
//   { file: File, path: 'textures/a.png' }

// Files from an <input type=file> (multi-select and/or webkitdirectory).
// webkitRelativePath is "folder/sub/file.ext" for a folder pick, empty otherwise.
export function entriesFromFileList(fileList) {
  const files = Array.from(fileList || [])
  const entries = files.map((file) => ({ file, path: (file.webkitRelativePath || file.name).replace(/\\/g, '/') }))
  return stripCommonRoot(entries)
}

// A dropped folder arrives as "folder/..." for every file; the folder's own name
// carries no meaning, so drop it when every path shares it.
function stripCommonRoot(entries) {
  if (entries.length < 2) return entries
  const first = entries[0].path.split('/')[0]
  if (!entries.every((e) => e.path.includes('/') && e.path.split('/')[0] === first)) return entries
  return entries.map((e) => ({ ...e, path: e.path.slice(first.length + 1) }))
}

// Everything in a drop, including whole folders. IMPORTANT: DataTransfer items are
// only readable during the drop event itself, so every item is grabbed
// synchronously here before anything is awaited.
export function collectDroppedFiles(dataTransfer) {
  const items = Array.from(dataTransfer?.items || [])
  const roots = []
  if (items.length && typeof items[0].webkitGetAsEntry === 'function') {
    for (const item of items) {
      if (item.kind && item.kind !== 'file') continue
      const entry = item.webkitGetAsEntry()
      if (entry) roots.push(entry)
    }
  }
  if (!roots.length) {
    const plain = Array.from(dataTransfer?.files || []).map((file) => ({ file, path: file.name }))
    return Promise.resolve(plain)
  }
  return Promise.all(roots.map((entry) => walkEntry(entry, ''))).then((lists) =>
    stripCommonRoot(lists.flat()),
  )
}

async function walkEntry(entry, parent) {
  const path = parent ? `${parent}/${entry.name}` : entry.name
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
    return [{ file, path }]
  }
  if (entry.isDirectory) {
    const reader = entry.createReader()
    const children = []
    // readEntries returns results in batches (~100) until it returns an empty list.
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
      if (!batch.length) break
      children.push(...batch)
    }
    return (await Promise.all(children.map((child) => walkEntry(child, path)))).flat()
  }
  return []
}

// --- Bundling ----------------------------------------------------------------

function pickMain(entries) {
  const models = entries.filter((e) => isModelName(e.path))
  models.sort((a, b) => MODEL_EXTENSIONS.indexOf(extOf(a.path)) - MODEL_EXTENSIONS.indexOf(extOf(b.path)) || b.file.size - a.file.size)
  return models[0] || null
}

// Turn whatever the user gave us into ONE File that loadModel() can open.
//  - a single model file, or a single .zip  → returned as is
//  - a model plus textures/materials/buffers (several files, a folder) → a zip
//    of the main model and everything it could reference
// Throws a readable error when there is nothing loadable.
export async function bundleModelFiles(rawEntries) {
  const entries = rawEntries.filter((e) => e && e.file && !isJunkPath(e.path))
  if (!entries.length) throw new Error('No files found.')

  if (entries.length === 1) {
    const only = entries[0].file
    const ext = extOf(only.name)
    if (isModelName(only.name) || BUNDLE_EXTENSIONS.includes(ext)) return only
    throw new Error(`Unsupported file ".${ext}". Drop a 3D model (${MODEL_EXTENSIONS.map((e) => '.' + e).join(', ')}), a folder, or a .zip.`)
  }

  const zips = entries.filter((e) => BUNDLE_EXTENSIONS.includes(extOf(e.path)))
  const main = pickMain(entries)
  const hasResources = entries.some((e) => isImageName(e.path) || isSupportName(e.path))

  // Only zips (nothing else worth keeping): the zip IS the model.
  if (!main && zips.length && !hasResources) return zips[0].file

  if (!main && !zips.length) {
    const unsupported = entries.map((e) => extOf(e.path)).find((x) => UNSUPPORTED_MODEL_EXTENSIONS.includes(x))
    throw new Error(
      unsupported
        ? `Found a .${unsupported} file, which can't be opened here. Export it as .fbx or .glb from your 3D program first.`
        : 'No 3D model found in those files. Include a ' + MODEL_EXTENSIONS.map((e) => '.' + e).join(' / ') + ' file.',
    )
  }

  // Only what a model can reference by name rides along; unrelated files in the
  // folder (other models, .blend sources, readmes) are left behind. A .zip inside
  // the folder rides along too — the model, or its textures, may be packed in it
  // ("source/model.zip" beside a "textures" folder is a common download layout);
  // loadModel unpacks it.
  const wanted = entries.filter((e) => e === main || isImageName(e.path) || isSupportName(e.path) || zips.includes(e))
  const data = {}
  for (const e of wanted) data[e.path] = new Uint8Array(await e.file.arrayBuffer())
  // level 0: stored, not compressed — textures are already compressed, and this keeps import instant.
  const zipped = zipSync(data, { level: 0 })
  const name = main ? stemOf(main.path) : stemOf(zips[0].path)
  return new File([zipped], `${name}.zip`, { type: 'application/zip' })
}

// Convenience entry points for the UI.
export async function modelFileFromInput(fileList) {
  return bundleModelFiles(entriesFromFileList(fileList))
}
export async function modelFileFromDrop(dataTransfer) {
  return bundleModelFiles(await collectDroppedFiles(dataTransfer))
}

// --- Reading a bundle --------------------------------------------------------

// A .zip's contents as Map<path, Uint8Array>, junk and folders dropped. Zips
// found INSIDE it are opened too, their contents placed in the folder the inner
// zip sat in (so "source/model.zip" holding "model.obj" gives "source/model.obj")
// — downloads are often a zip of folders where the model itself is yet another
// zip. Nesting is capped so a zip bomb can't run away.
const MAX_NESTED_DEPTH = 3
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024

export function readBundle(arrayBuffer, depth = 0, budget = { bytes: 0 }) {
  const files = new Map()
  const raw = unzipSync(new Uint8Array(arrayBuffer))
  for (const [rawPath, bytes] of Object.entries(raw)) {
    const path = rawPath.replace(/\\/g, '/')
    if (path.endsWith('/') || isJunkPath(path)) continue
    budget.bytes += bytes.length
    if (budget.bytes > MAX_BUNDLE_BYTES) throw new Error('The zip is too large to open.')
    if (BUNDLE_EXTENSIONS.includes(extOf(path)) && depth < MAX_NESTED_DEPTH) {
      let inner = null
      try {
        inner = readBundle(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), depth + 1, budget)
      } catch {
        inner = null // not actually a readable zip — keep it as an ordinary file
      }
      if (inner) {
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
        for (const [innerPath, innerBytes] of inner) {
          if (!files.has(dir + innerPath)) files.set(dir + innerPath, innerBytes)
        }
        continue
      }
    }
    files.set(path, bytes)
  }
  return files
}

// The main model inside a bundle (same preference order as when bundling).
export function pickMainModelPath(files) {
  const models = [...files.keys()].filter(isModelName)
  models.sort((a, b) => MODEL_EXTENSIONS.indexOf(extOf(a)) - MODEL_EXTENSIONS.indexOf(extOf(b)) || files.get(b).length - files.get(a).length)
  return models[0] || null
}

export const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  bmp: 'image/bmp', tga: 'image/x-tga', tif: 'image/tiff', tiff: 'image/tiff',
  bin: 'application/octet-stream', mtl: 'text/plain',
}
export const mimeOf = (path) => MIME_BY_EXT[extOf(path)] || 'application/octet-stream'

// --- Textures the model never mentions --------------------------------------
//
// Some models ship NO texture reference at all: the example skybox is a UV sphere
// with a default grey material and a lone textures/*.jpg beside it, and an OBJ
// can name an .mtl that isn't in the download — leaving only a folder of
// "detective_Body_diffuse.png / _normal.png / _specular.png…" to be paired with
// the materials by NAME. So images nothing asked for are classified by role
// (diffuse, normal, specular…) from their file names and matched to untextured
// (or map-less) materials, conservatively:
//   * the base name (file name minus the role word) must match the material's or
//     mesh's name — except a lone colour image, which can go on a plain model;
//   * a map is only added where the material doesn't already have one.

// Words in a file name that say what kind of map an image is.
const ROLE_WORDS = {
  diffuse: ['diffuse', 'albedo', 'basecolor', 'color', 'colour', 'col', 'diff', 'dif', 'basemap'],
  normal: ['normal', 'normals', 'nrm', 'nrml', 'norm', 'nor'],
  specular: ['specular', 'spec', 'specularity'],
  gloss: ['gloss', 'glossiness', 'glossy'],
  roughness: ['roughness', 'rough'],
  metalness: ['metalness', 'metallic', 'metal'],
  ao: ['ao', 'occlusion', 'ambientocclusion'],
  emissive: ['emissive', 'emission', 'emit', 'glow'],
  // not applied, but recognised so they are never mistaken for a colour image
  other: ['opacity', 'alpha', 'transparency', 'mask', 'height', 'displacement', 'disp', 'bump', 'orm', 'mrao', 'lightmap', 'cavity', 'curvature'],
}
// Game-engine style one-letter suffixes: T_Body_D, T_Body_N, T_Body_S…
const ROLE_LETTERS = { d: 'diffuse', n: 'normal', s: 'specular', r: 'roughness', m: 'metalness', e: 'emissive' }
const GENERIC_WORDS = new Set(['texture', 'tex', 'map', 'img', 'image', 'tx', 't'])

const LEADING_ROLE_WORDS = new Set(['normal', 'normals', 'nrm', 'specular', 'roughness', 'metallic', 'metalness', 'occlusion', 'emissive', 'emission', 'opacity', 'height', 'displacement'])
const ROLE_LOOKUP = new Map()
for (const [role, words] of Object.entries(ROLE_WORDS)) for (const w of words) ROLE_LOOKUP.set(w, role)

// { role, base } for an image path. `base` is what's left of the name once the
// role word and filler ("texture", "map") are removed: "detective_Body_normal.png"
// → role normal, base "detectivebody". When nothing is left ("textures/Body/diffuse.png")
// the folder it sits in names the material.
export function classifyTexture(path) {
  const stem = stemOf(path)
    .toLowerCase()
    .replace(/base[ _.-]?colou?r/g, 'basecolor')
    .replace(/ambient[ _.-]?occlusion/g, 'ambientocclusion')
    .replace(/spec(?:ular)?[ _.-]?gloss/g, 'specular')
  const tokens = stem.split(/[^a-z0-9]+/).filter(Boolean)
  let role = null
  let at = -1
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (GENERIC_WORDS.has(tokens[i])) continue
    if (ROLE_LOOKUP.has(tokens[i])) {
      role = ROLE_LOOKUP.get(tokens[i])
      at = i
    } else if (i === tokens.length - 1 && tokens.length > 1 && ROLE_LETTERS[tokens[i]]) {
      role = ROLE_LETTERS[tokens[i]]
      at = i
    }
    break
  }
  // "…_normal_v2", "…_diffuse_01": a trailing version/number after the role word.
  if (role === null) {
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (/^\d+$/.test(tokens[i]) || GENERIC_WORDS.has(tokens[i])) continue
      if (i !== tokens.length - 1 && ROLE_LOOKUP.has(tokens[i])) {
        role = ROLE_LOOKUP.get(tokens[i])
        at = i
      }
      break
    }
  }
  // "normal_body.png": the role word comes FIRST. Only unambiguous words count there,
  // so a material called "metal_plate" or "rough_stone" isn't taken for a map type.
  if (role === null && tokens.length > 1 && LEADING_ROLE_WORDS.has(tokens[0])) {
    role = ROLE_LOOKUP.get(tokens[0])
    at = 0
  }
  const rest = tokens.filter((t, i) => i !== at && !GENERIC_WORDS.has(t) && !/^\d+k?$/.test(t))
  let base = rest.join('')
  if (!base) {
    const parent = String(path).replace(/\\/g, '/').split('/').slice(-2, -1)[0]
    if (parent) base = parent.toLowerCase().replace(/[^a-z0-9]/g, '')
  }
  // An image that names no role is treated as a colour picture (the skybox's "sunroof_city_6k.jpg").
  return { role: role || 'diffuse', explicit: role !== null, base }
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// How well an image's base name matches a material (0 = not at all). Exact beats
// "one contains the other"; very short names (under 3 characters) never match by
// containment, so a material called "a" can't swallow every image.
function matchScore(names, base) {
  if (!base) return 0
  let best = 0
  for (const raw of names) {
    const n = normName(raw)
    if (!n) continue
    if (n === base) return 3
    if (Math.min(n.length, base.length) < 3) continue
    if (base.endsWith(n) || base.startsWith(n)) best = Math.max(best, 2)
    else if (base.includes(n) || n.includes(base)) best = Math.max(best, 1)
  }
  return best
}

export function isColorImageCandidate(path) {
  return isImageName(path) && classifyTexture(path).role === 'diffuse'
}

// materials: [{ id, names: [material name, mesh names…], textured: bool }]
// candidates: image paths nothing referenced. → [{ id, path }]   (colour maps)
export function planLooseTextures(materials, candidates) {
  const free = candidates.filter(isColorImageCandidate)
  const plain = materials.filter((m) => !m.textured)
  if (!free.length || !plain.length) return []

  if (free.length === 1) {
    // A lone image whose name belongs to a material goes to THAT material only.
    const base = classifyTexture(free[0]).base
    const owners = plain.filter((m) => matchScore(m.names, base) > 0)
    if (owners.length) return owners.map((m) => ({ id: m.id, path: free[0] }))
    // One that names nothing in the model (the skybox's "sunroof_city_6k.jpg") is the
    // model's picture: fine for a plain model, or a lone plain material — never sprayed
    // over a mix of deliberately plain and textured materials.
    const anyTextured = materials.some((m) => m.textured)
    if (!anyTextured || plain.length === 1) return plain.map((m) => ({ id: m.id, path: free[0] }))
  }

  const plan = []
  for (const m of plain) {
    let hit = null
    let hitScore = 0
    for (const p of free) {
      const score = matchScore(m.names, classifyTexture(p).base)
      if (score > hitScore) {
        hit = p
        hitScore = score
      }
    }
    if (hit) plan.push({ id: m.id, path: hit })
  }
  return plan
}

// The non-colour maps (normal, specular, roughness, metalness, AO, emissive) that
// belong to a material, by name only — never guessed. materials carry `has`: the
// roles they already have. → [{ id, role, path }]
export function planExtraMaps(materials, candidates) {
  const extras = candidates
    .filter(isImageName)
    .map((path) => ({ path, ...classifyTexture(path) }))
    .filter((c) => c.role !== 'diffuse' && c.role !== 'other' && c.role !== 'gloss')
  const plan = []
  for (const m of materials) {
    const bestByRole = new Map()
    for (const c of extras) {
      if (m.has && m.has[c.role]) continue
      const score = matchScore(m.names, c.base)
      if (score === 0) continue
      const cur = bestByRole.get(c.role)
      if (!cur || score > cur.score) bestByRole.set(c.role, { score, path: c.path })
    }
    for (const [role, { path }] of bestByRole) plan.push({ id: m.id, role, path })
  }
  return plan
}

// What to tell the user after an import that referred to files it couldn't find.
// `bundle` is info.bundle from loadModel. Returns null when nothing is missing.
export function describeMissingFiles(name, bundle) {
  if (!bundle) return null
  const images = [...new Set((bundle.missingTextures || []).map(baseNameOf))]
  const others = (bundle.missingFiles || []).map(baseNameOf)
  if (!images.length && !others.length) return null
  const list = (arr) => (arr.length <= 3 ? arr.join(', ') : `${arr.slice(0, 3).join(', ')} and ${arr.length - 3} more`)
  const parts = []
  if (images.length) parts.push(`${images.length} texture${images.length === 1 ? '' : 's'} (${list(images)})`)
  if (others.length) parts.push(`its material file (${list(others)})`)
  const one = images.length + others.length === 1
  return (
    `Imported "${name}", but it refers to ${parts.join(' and ')} that ${one ? "wasn't" : "weren't"} included, so it may look plain. ` +
    `Import the model's whole folder or .zip — or pick the model and ${one ? 'that file' : 'those files'} together — to bring ${one ? 'it' : 'them'} in.`
  )
}
