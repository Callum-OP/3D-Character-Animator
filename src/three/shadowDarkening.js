import * as THREE from 'three'

// Real shadow-map shadows only remove a light's DIRECT contribution. In a scene
// with ambient / environment fill (which this app always has) that is a very
// faint change, so cast shadows on maps, props and characters barely showed —
// only the invisible ShadowMaterial floor plane was ever strong enough to see.
//
// This makes the Shadow strength setting work on real surfaces: wherever a
// shadow-casting light is blocked, the final colour is darkened by `strength`
// on top of the normal lighting, whatever the ambient level. It patches three's
// shared shader chunks once, so it applies to every lit material (standard,
// toon, phong, lambert, and the app's custom-styled variants) with no scene
// graph changes — and it is per-pixel, so it follows any geometry: other
// levels, interiors, props shadowing themselves.
//
// The darkness is one shared uniform; changing it needs no shader recompile.

export const shadowDarkness = { value: 0 }

let installed = false

// Pure string transforms, exported so they can be tested/validated directly.
export function patchLightsChunk(source) {
  let count = 0
  const out = source.replace(
    /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? (.+?) : 1\.0;/g,
    (_, shadowCall) => {
      count++
      // Track how shadowed this pixel is by the strongest shadow-casting light.
      // Weighted by how much the surface faces that light so the already-dark
      // far side of an object isn't darkened twice.
      return `{
		float dsShadow = ( directLight.visible && receiveShadow ) ? ${shadowCall} : 1.0;
		directLight.color *= dsShadow;
		dsShadowMin = min( dsShadowMin, mix( 1.0, dsShadow, saturate( dot( geometryNormal, directLight.direction ) * 4.0 ) ) );
	}`
    },
  )
  return { source: out, count }
}

export function patchOpaqueChunk(source) {
  const needle = 'gl_FragColor = vec4( outgoingLight, diffuseColor.a );'
  if (!source.includes(needle)) return { source, count: 0 }
  return {
    source: source.replace(
      needle,
      `outgoingLight *= 1.0 - uShadowDarkness * ( 1.0 - dsShadowMin );
	${needle}`,
    ),
    count: 1,
  }
}

export function patchCommonChunk(source) {
  return `${source}
uniform float uShadowDarkness;
float dsShadowMin = 1.0;
`
}

// Returns true if the patch is active. If a future three.js reshuffles the
// chunks this could not match; then nothing is changed and shadows simply look
// as they do in stock three.js.
export function installShadowDarkening() {
  if (installed) return true
  const chunks = THREE.ShaderChunk
  const lights = patchLightsChunk(chunks.lights_fragment_begin)
  const opaque = patchOpaqueChunk(chunks.opaque_fragment)
  if (lights.count === 0 || opaque.count === 0) return false
  chunks.lights_fragment_begin = lights.source
  chunks.opaque_fragment = opaque.source
  chunks.common = patchCommonChunk(chunks.common)

  // Built-in materials have no onBeforeCompile of their own: give them the
  // shared uniform. (The app's custom-styled materials add it themselves.)
  THREE.Material.prototype.onBeforeCompile = function onBeforeCompile(shader) {
    shader.uniforms.uShadowDarkness = shadowDarkness
  }
  installed = true
  return true
}

export function setShadowDarkness(value) {
  shadowDarkness.value = Math.min(1, Math.max(0, value || 0))
}
