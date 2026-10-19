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
      // Track how much of this pixel's direct light is blocked, over ALL lights: each light
      // counts in proportion to how much light it would deliver here (brightness x how much
      // the surface faces it). A spot shadowed from one lamp but lit by another is therefore
      // only dimmed by the lamp it lost; two lights that fill each other's shadows leave no
      // dark patch (taking the single worst light instead made every shadow show up, even
      // where another light lit that very spot). The far side of an object faces no light, so
      // it carries no weight and isn't darkened twice.
      // A placed light (point or spot) has a RANGE (its `distance`): its light is gone there, and its
      // shadow fades out with it, over a long smooth ramp, instead of a small lamp shadowing every
      // building and the skybox out to the shadow camera's far plane. The sun-like key light (a
      // directional light) has no range, so it is never faded.
      const rangeLight = shadowCall.startsWith('getPointShadow') ? 'pointLight' : shadowCall.includes('spotShadowMap') ? 'spotLight' : null
      const reachFade = rangeLight
        ? `\n\t\tdsShadow = mix( 1.0, dsShadow, dsReachFade( length( ${rangeLight}.position - geometryPosition ), ${rangeLight}.distance ) );`
        : ''
      return `{
		float dsShadow = ( directLight.visible && receiveShadow && uShadowImmune < 0.5 ) ? ${shadowCall} : 1.0;${reachFade}
		float dsWeight = dot( directLight.color, vec3( 0.2126, 0.7152, 0.0722 ) ) * saturate( dot( geometryNormal, directLight.direction ) );
		dsLightSum += dsWeight;
		dsLitSum += dsWeight * dsShadow;
		directLight.color *= dsShadow;
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
      `// Fraction of the direct light that actually arrives (1 = unshadowed, or nothing facing a light).
	dsShadowMin = dsLightSum > 0.0001 ? clamp( dsLitSum / dsLightSum, 0.0, 1.0 ) : 1.0;
	float dsShadowAmt = uShadowDarkness * ( 1.0 - dsShadowMin );
	outgoingLight *= ( 1.0 - dsShadowAmt ) * mix( vec3( 1.0 ), uShadowTint, 1.0 - dsShadowMin );
	// Night mode: a flat dark wash over everything (zero uniforms = no change).
	float dsNight = uNightAmt * ( 1.0 - uNightImmune );
	outgoingLight *= ( 1.0 - dsNight ) * mix( vec3( 1.0 ), uNightTint, dsNight );
	${needle}`,
    ),
    count: 1,
  }
}

export function patchCommonChunk(source) {
  return `${source}
uniform float uShadowDarkness;
uniform vec3 uShadowTint; // luminance-normalised shadow colour (1,1,1 = plain darkening)
uniform float uNightAmt; // night mode strength, 0 = off
uniform float uNightImmune; // 1 = this material ignores night mode (its own uniform, see nightImmuneUniform)
uniform float uShadowImmune; // 1 = this material is never shadowed by other objects (its own uniform, see shadowImmuneUniform)
float dsReachFade( float dist, float reach ) { return reach > 0.0 ? 1.0 - smoothstep( reach * 0.1, reach, dist ) : 1.0; }
uniform vec3 uNightTint; // luminance-normalised night colour
float dsShadowMin = 1.0;
float dsLightSum = 0.0; // sum over lights of (brightness x facing)
float dsLitSum = 0.0; // the same, after each light's shadow
`
}

// ---------------------------------------------------------------------------
// Shadow filtering
//
// three's built-in PCF filter reads 17 taps in a fixed lattice spaced `radius`
// texels apart. With radius ~0 every tap lands on the same texel, so a crisp
// shadow edge is a raw staircase of shadow-map texels (the "blocky outline");
// with a large radius the lattice itself shows up as stepped, banded fades.
//
// This replaces that branch with:
//   - a golden-angle (Vogel) spiral of N taps, rotated per pixel by interleaved
//     gradient noise: the lattice turns into fine, even grain instead of bands;
//   - an anti-aliasing floor (about one texel) so even "exact" hard edges are smooth;
//   - optionally PCSS contact-hardening: find the occluders, measure how far they
//     are from the surface, and widen the penumbra accordingly, so a shadow is
//     tack-sharp where a foot meets the floor and softens with distance, like a
//     real shadow from a light with a size. Selected per light by a NEGATIVE
//     shadow.radius whose magnitude is the light's size (tan of its angular radius);
//     a positive radius is a plain, even blur of that many texels.
//
// The key light's own numbers (tap count, texel size in world units, depth range of
// its shadow camera, blur limits) travel in two shared uniforms, see
// shadowFilterA / shadowFilterB below. Every other shadow-casting light uses the
// positive-radius path, so it needs none of them.
// ---------------------------------------------------------------------------

export const shadowTint = { value: new THREE.Color(1, 1, 1) }
// x: taps, y: world size of one shadow-map texel, z: world depth range (far - near) of
// the key light's shadow camera, w: smallest blur radius in texels (edge anti-aliasing)
export const shadowFilterA = { value: new THREE.Vector4(24, 0.005, 20, 1) }
// x: largest blur radius in texels (also the blocker-search radius); y/z/w unused
export const shadowFilterB = { value: new THREE.Vector4(24, 0, 0, 0) }

// Night mode. One shared strength and colour for everything, plus one small per-material
// uniform (0 / 1) saying whether that material ignores it. Immunity is just that value:
// flipping it takes effect immediately, with no recompile. (An earlier version swapped the
// shared uniform for a zero one and relied on a program-cache-key change to re-run
// onBeforeCompile; switching back reused the cached program, whose uniform was still the zero
// one, so a material could be made immune but never un-immune again.)
export const nightAmount = { value: 0 }
export const nightTint = { value: new THREE.Color(1, 1, 1) }
const immuneUniforms = new WeakMap()
const notImmune = { value: 0 }

// The per-material immunity uniform (created once, kept for the life of the material).
export function nightImmuneUniform(material) {
  if (!material) return notImmune
  let u = immuneUniforms.get(material)
  if (!u) {
    u = { value: material.userData && material.userData.nightImmune ? 1 : 0 }
    immuneUniforms.set(material, u)
  }
  return u
}

export function setNightImmune(material, immune) {
  nightImmuneUniform(material).value = immune ? 1 : 0
}

// Shadow immunity: a material that is never darkened by shadows cast by other objects (it can
// still cast its own, and still follows Night mode). Same live per-material uniform as night
// immunity, so toggling it never recompiles anything.
const shadowImmuneUniforms = new WeakMap()
const notShadowImmune = { value: 0 }
export function shadowImmuneUniform(material) {
  if (!material) return notShadowImmune
  let u = shadowImmuneUniforms.get(material)
  if (!u) {
    u = { value: material.userData && material.userData.shadowImmune ? 1 : 0 }
    shadowImmuneUniforms.set(material, u)
  }
  return u
}
export function setShadowImmune(material, immune) {
  shadowImmuneUniform(material).value = immune ? 1 : 0
}

// Give a shader the shared shadow uniforms. Every onBeforeCompile (the built-in
// default below, and the app's custom-styled materials) must call this, or three
// fails to upload the uniforms the patched chunks declare.
export function addShadowUniforms(uniforms, material) {
  uniforms.uNightAmt = nightAmount
  uniforms.uNightImmune = nightImmuneUniform(material)
  uniforms.uNightTint = nightTint
  uniforms.uShadowImmune = shadowImmuneUniform(material)
  uniforms.uShadowDarkness = shadowDarkness
  uniforms.uShadowTint = shadowTint
  uniforms.uShadowFilterA = shadowFilterA
  uniforms.uShadowFilterB = shadowFilterB
}

export const SHADOW_FILTER_GLSL = `
	uniform vec4 uShadowFilterA;
	uniform vec4 uShadowFilterB;

	// Rotation by the golden angle (2.39996323 rad), column-major.
	const mat2 dsGolden = mat2( -0.7373688, 0.6754632, -0.6754632, -0.7373688 );

	// Interleaved gradient noise: a stable, evenly spread per-pixel value in 0..1.
	float dsNoise( vec2 p ) {

		return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );

	}

	// Fraction of light reaching the point: depth comparisons spread over a disc.
	float dsDiskShadow( sampler2D depths, vec2 uv, float compare, vec2 radiusUv, int taps, float rot ) {

		vec2 dir = vec2( cos( rot ), sin( rot ) );
		float invTaps = 1.0 / float( taps );
		float sum = 0.0;

		for ( int i = 0; i < 48; i ++ ) {

			if ( i >= taps ) break;
			float r = sqrt( ( float( i ) + 0.5 ) * invTaps );
			sum += texture2DCompare( depths, uv + dir * ( r * radiusUv ), compare );
			dir = dsGolden * dir;

		}

		return sum * invTaps;

	}

	float dsFilteredShadow( sampler2D depths, vec2 mapSize, float shadowRadius, vec3 sc ) {

		vec2 texel = 1.0 / mapSize;
		int taps = int( clamp( uShadowFilterA.x, 1.0, 48.0 ) + 0.5 );
		float rot = dsNoise( gl_FragCoord.xy ) * 6.2831853;
		float radiusTexels = max( shadowRadius, uShadowFilterA.w );

		if ( shadowRadius < 0.0 ) {

			// Contact-hardening: how wide should the penumbra be at this point?
			float lightTan = - shadowRadius;
			int searchTaps = int( clamp( float( taps ), 1.0, 16.0 ) + 0.5 );
			float searchRadius = max( uShadowFilterB.x, 1.0 );
			vec2 dir = vec2( cos( rot ), sin( rot ) );
			float blockerSum = 0.0;
			float blockers = 0.0;

			for ( int i = 0; i < 16; i ++ ) {

				if ( i >= searchTaps ) break;
				float r = sqrt( ( float( i ) + 0.5 ) / float( searchTaps ) );
				float d = unpackRGBAToDepth( texture2D( depths, sc.xy + dir * ( r * searchRadius ) * texel ) );

				if ( d < sc.z ) {

					blockerSum += d;
					blockers += 1.0;

				}

				dir = dsGolden * dir;

			}

			// Nothing between this point and the light within reach: fully lit.
			if ( blockers < 0.5 ) return 1.0;

			float blockerDepth = blockerSum / blockers;
			float penumbraWorld = lightTan * ( sc.z - blockerDepth ) * uShadowFilterA.z;
			radiusTexels = clamp( penumbraWorld / uShadowFilterA.y, uShadowFilterA.w, max( uShadowFilterB.x, uShadowFilterA.w ) );

		}

		return dsDiskShadow( depths, sc.xy, sc.z, texel * radiusTexels, taps, rot );

	}

`

const GET_SHADOW_SIGNATURE = '\tfloat getShadow( sampler2D shadowMap,'
const PCF_BRANCH_START = '#if defined( SHADOWMAP_TYPE_PCF )\n'
const PCF_BRANCH_END = '#elif defined( SHADOWMAP_TYPE_PCF_SOFT )'

// Pure string transform (exported so it can be tested without a GPU): swap the PCF
// branch of getShadow() for the filter above. Returns count 0 and the source
// untouched if three's chunk doesn't look the way we expect.
export function patchShadowmapChunk(source) {
  const fn = source.indexOf(GET_SHADOW_SIGNATURE)
  if (fn < 0) return { source, count: 0 }
  const start = source.indexOf(PCF_BRANCH_START, fn)
  if (start < 0) return { source, count: 0 }
  const bodyStart = start + PCF_BRANCH_START.length
  const end = source.indexOf(PCF_BRANCH_END, bodyStart)
  if (end < 0) return { source, count: 0 }
  const call = '\n\t\t\tshadow = dsFilteredShadow( shadowMap, shadowMapSize, shadowRadius, shadowCoord.xyz );\n\n\t\t'
  const out = source.slice(0, fn) + SHADOW_FILTER_GLSL + source.slice(fn, bodyStart) + call + source.slice(end)
  return { source: out, count: 1 }
}

let originalShadowmapChunk = null
let filterInstalled = false
let filterEpoch = 0

// Part of every custom program cache key: if the filter has to be switched off at
// runtime (see revertShadowFilter) the key changes, so materials recompile instead
// of reusing a program that failed.
export function shadowFilterKey() {
  return filterEpoch > 1 ? `-sf${filterEpoch}` : ''
}

export function isShadowFilterInstalled() {
  return filterInstalled
}

export function installShadowFilter() {
  if (filterInstalled) return true
  const chunks = THREE.ShaderChunk
  const patched = patchShadowmapChunk(chunks.shadowmap_pars_fragment)
  if (patched.count === 0) return false
  if (originalShadowmapChunk === null) originalShadowmapChunk = chunks.shadowmap_pars_fragment
  chunks.shadowmap_pars_fragment = patched.source
  filterInstalled = true
  filterEpoch++
  return true
}

// Back to three's own shadow filtering. Used as the safety net if the GPU/driver
// rejects the patched shader: the caller marks materials for recompilation.
export function revertShadowFilter() {
  if (!filterInstalled || originalShadowmapChunk === null) return false
  THREE.ShaderChunk.shadowmap_pars_fragment = originalShadowmapChunk
  filterInstalled = false
  filterEpoch++
  return true
}

// Returns true if the darkening patch is active. If a future three.js reshuffles the
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
  installShadowFilter()

  // Built-in materials have no onBeforeCompile of their own: give them the
  // shared uniforms. (The app's custom-styled materials add them themselves.)
  THREE.Material.prototype.onBeforeCompile = function onBeforeCompile(shader) {
    addShadowUniforms(shader.uniforms, this)
  }
  THREE.Material.prototype.customProgramCacheKey = function customProgramCacheKey() {
    return this.onBeforeCompile.toString() + shadowFilterKey()
  }
  installed = true
  return true
}

export function setShadowDarkness(value) {
  shadowDarkness.value = Math.min(1, Math.max(0, value || 0))
}

// The colour shadows take on. Normalised to the same brightness as white so it
// changes the HUE of a shadow without changing how dark it is (darkness stays the
// Strength slider's job). White / unset = plain, neutral darkening.
// Night mode: strength 0..1 (0 = off) and the colour of the night.
export function setNightLook(strength, hex) {
  nightAmount.value = Math.min(1, Math.max(0, strength || 0))
  normalisedTint(hex, nightTint.value)
}

export function setShadowTint(hex) {
  normalisedTint(hex, shadowTint.value)
}

function normalisedTint(hex, target) {
  const c = new THREE.Color(hex || '#ffffff')
  const luma = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  if (luma < 1e-4) {
    target.setRGB(1, 1, 1)
    return
  }
  let r = c.r / luma
  let g = c.g / luma
  let b = c.b / luma
  // A very saturated colour would multiply one channel far above 1 and blow out. Blend
  // toward neutral until no channel exceeds 2; the blend is linear and white has the
  // same luminance, so the brightness stays exactly that of white.
  const peak = Math.max(r, g, b)
  if (peak > 2) {
    const k = 1 / (peak - 1)
    r = 1 + (r - 1) * k
    g = 1 + (g - 1) * k
    b = 1 + (b - 1) * k
  }
  target.setRGB(r, g, b)
}
