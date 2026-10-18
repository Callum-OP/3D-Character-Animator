// The app stores live shader state on each material's `userData` (rim-light
// uniforms, the "rim light already installed" flag, outline parameters, …).
// That state is only meaningful inside the running app, and it does not survive
// being written to a file:
//
//  • GLTFExporter writes `userData` into the file (as glTF "extras"). THREE.Color
//    becomes a bare hex number and Vector3 a plain {x,y,z}, and the shader's
//    uniform map (with whole serialised textures inside it) is dragged along too.
//  • When that file is imported again, GLTFLoader hands the extras straight back as
//    `userData`. The app then sees `rimLightInstalled: true` (so it never installs
//    the rim-light shader hook) next to a `backlightColor` that is a number, and
//    `u.backlightColor.set(...)` throws "set is not a function" — which is what
//    Standard-mode styles such as Cinematic hit on a model exported from the app.
//
// So: keep this state out of exported files, and scrub it from anything imported
// (files exported by older versions of the app still contain it).

export const APP_MATERIAL_KEYS = [
  'rimLightInstalled',
  'rimColor',
  'rimLightDir',
  'rimSoftIntensity',
  'rimSoftWidth',
  'rimHardIntensity',
  'rimHardWidth',
  'rimSideOnly',
  'ambientOcclusionStrength',
  'backlightColor',
  'backlightFalloff',
  'colorGrading',
  'shadowStrength',
  'nightImmune',
  'outlineParameters',
  'rimUniforms',
  'styleUniforms',
]

// Remove the app's own keys from one material (or an array of them), in place.
export function stripAppMaterialData(material) {
  const list = Array.isArray(material) ? material : [material]
  for (const m of list) {
    if (!m || !m.userData) continue
    for (const key of APP_MATERIAL_KEYS) delete m.userData[key]
  }
}

function forEachMaterial(root, fn) {
  const seen = new Set()
  root.traverse((obj) => {
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : []
    for (const m of mats) {
      if (m && !seen.has(m)) {
        seen.add(m)
        fn(m)
      }
    }
  })
}

// Scrub every material under a freshly imported root.
export function sanitizeLoadedMaterials(root) {
  if (root) forEachMaterial(root, stripAppMaterialData)
}

// Run `fn` (an export) with the app's keys hidden from every material under
// `root`, then put the real `userData` back exactly as it was. The export copy
// shares its materials with the live scene, so they must be restored, not stripped.
export async function withExportSafeMaterials(root, fn) {
  const saved = []
  forEachMaterial(root, (m) => {
    saved.push([m, m.userData])
    const clean = { ...m.userData }
    for (const key of APP_MATERIAL_KEYS) delete clean[key]
    m.userData = clean
  })
  try {
    return await fn()
  } finally {
    for (const [m, userData] of saved) m.userData = userData
  }
}
