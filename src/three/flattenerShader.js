import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Flattener: the shader half
//
// A "flattener" squashes a head (or any part of a character) flat toward the camera, the
// look anime-style 3D relies on: the model is still fully 3D, but from the camera the face
// reads like a flat drawing, and it keeps doing so as the head turns or the camera moves.
//
// It is done in the vertex shader, in VIEW space, after skinning: every vertex above the
// "chin line" of a flattener has its depth (distance from the camera) squeezed toward the
// depth of the flattener's centre, exactly like squashing the head along the camera's view
// axis. It follows whatever camera is rendering — the free camera, a placed camera, a
// recorded shot — with nothing to keep in sync. Three things make it read as a drawing:
//
//  * SHADING. The surface normals are flattened with the geometry (a squash along the view
//    axis turns a normal n into (n.x, n.y, n.z / keep)), so the front of the face faces the
//    camera and is lit like a flat plane, with no cheek / nose / brow shading. This is the
//    main part of the look.
//  * DEPTH ORDER. The depth that is written is the ORIGINAL depth (only where the vertex
//    lands on screen and how it is lit change). Parts that sit a millimetre apart — the eyes
//    behind the lids, the teeth behind the lips, the skin over the skull — keep their exact
//    draw order, so nothing shows through, however thin the squash.
//  * OUTLINE. The outline pass is drawn from the same flattened vertices, so it stays attached.
//
// The squash fades in below the chin line (the "falloff"), so the neck and hair blend into
// the body instead of tearing. Up to MAX_FLATTENERS zones are handled per draw.
//
// Shadows are left alone on purpose: the depth / distance materials that draw shadow maps
// get FLATTENER_OFF (see shadowDarkening.js), so shadows are still cast by the real 3D shape.
//
// The numbers come from three/flattener.js, which fills the shared uniforms below just before
// each flattened mesh is drawn (and zeroes the count right after, so nothing else is touched).
// ---------------------------------------------------------------------------

export const MAX_FLATTENERS = 4

export const flatCount = { value: 0 }
export const flatPivot = { value: Array.from({ length: MAX_FLATTENERS }, () => new THREE.Vector3()) }
export const flatUp = { value: Array.from({ length: MAX_FLATTENERS }, () => new THREE.Vector3(0, 1, 0)) }
// x: strength 0..1, y: chin line (world units above the pivot along `up`), z: falloff distance
// below the chin line, w: depth kept at full strength (1 = untouched, 0 = a perfect plane)
export const flatParams = { value: Array.from({ length: MAX_FLATTENERS }, () => new THREE.Vector4(0, 0, 1, 1)) }
// x: how much of the flattening also goes into the shading normals (1 = all of it)
// y: the same, for the part being drawn (0 = this part keeps its own lighting)
// z: keep screen shape (0 = a true flatten, 1 = every point stays exactly where it is on screen)
// w: shading edge softness (surfaces turned away from the camera keep their own lighting)
export const flatMore = { value: Array.from({ length: MAX_FLATTENERS }, () => new THREE.Vector4(1, 0, 0, 0)) }

export function addFlattenerUniforms(uniforms) {
  uniforms.uFlatCount = flatCount
  uniforms.uFlatPivot = flatPivot
  uniforms.uFlatUp = flatUp
  uniforms.uFlatParams = flatParams
  uniforms.uFlatMore = flatMore
}

const DECLARATIONS = `
#define FLATTENER_AVAILABLE
uniform float uFlatCount; // how many flattener zones apply to the mesh being drawn (0 = none)
uniform vec3 uFlatPivot[ ${MAX_FLATTENERS} ];
uniform vec3 uFlatUp[ ${MAX_FLATTENERS} ];
uniform vec4 uFlatParams[ ${MAX_FLATTENERS} ];
uniform vec4 uFlatMore[ ${MAX_FLATTENERS} ];
`

// Runs between "mvPosition = modelViewMatrix * ..." and "gl_Position = projectionMatrix * mvPosition".
const APPLY_BEFORE = `
#if defined( FLATTENER_AVAILABLE ) && ! defined( FLATTENER_OFF )
	vec4 flatMvOriginal = mvPosition;
	bool flatApplied = false;
	if ( uFlatCount > 0.5 && mvPosition.z < - 0.0001 ) {
		vec3 flatWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
		for ( int fi = 0; fi < ${MAX_FLATTENERS}; fi ++ ) {
			if ( float( fi ) >= uFlatCount ) break;
			vec4 fParams = uFlatParams[ fi ];
			float fHeight = dot( flatWorld - uFlatPivot[ fi ], uFlatUp[ fi ] );
			float fAmount = fParams.x * smoothstep( fParams.y - fParams.z, fParams.y, fHeight );
			if ( fAmount <= 0.0 ) continue;
			float fPivotZ = ( viewMatrix * vec4( uFlatPivot[ fi ], 1.0 ) ).z;
			if ( fPivotZ > - 0.0001 ) continue;
			float fKeep = mix( 1.0, fParams.w, fAmount );
			vec3 fBefore = mvPosition.xyz;
			mvPosition.z = min( fPivotZ + ( mvPosition.z - fPivotZ ) * fKeep, - 0.0001 );
			// optionally slide the point along its line of sight so it stays where it was on screen
			mvPosition.xyz = mix( mvPosition.xyz, fBefore * ( mvPosition.z / fBefore.z ), uFlatMore[ fi ].z );
			#ifdef FLATTENER_HAS_VNORMAL
				// a squash along the view axis by fKeep turns a normal n into ( n.x, n.y, n.z / fKeep )
				float fKeepShade = mix( 1.0, fKeep, uFlatMore[ fi ].x * uFlatMore[ fi ].y );
				vec3 fFlatNormal = normalize( vec3( vNormal.xy, vNormal.z / max( fKeepShade, 0.01 ) ) );
				// only surfaces that face the camera are re-lit; ones turned away keep their own lighting
				float fSoft = uFlatMore[ fi ].w;
				float fFace = fSoft > 0.001 ? smoothstep( 0.0, fSoft, vNormal.z ) : step( 0.0, vNormal.z );
				vNormal = normalize( mix( vNormal, fFlatNormal, fFace ) );
			#endif
			flatApplied = true;
		}
	}
#endif
`

// After gl_Position is set: keep the ORIGINAL depth, so parts a hair apart keep their draw order.
const APPLY_AFTER = `
#if defined( FLATTENER_AVAILABLE ) && ! defined( FLATTENER_OFF )
	if ( flatApplied ) {
		vec4 flatClipOriginal = projectionMatrix * flatMvOriginal;
		gl_Position.z = flatClipOriginal.z / flatClipOriginal.w * gl_Position.w;
	}
#endif
`

const TARGET = 'gl_Position = projectionMatrix * mvPosition;'

// three's OutlineEffect pushes each outline vertex out along its normal by comparing the vertex with a
// second projected point; with the vertex flattened that comparison would pick up the flattening as well.
// Building the second point from the vertex itself gives the same direction the unflattened mesh gets.
const OUTLINE_OLD = 'vec4 pos2 = projectionMatrix * modelViewMatrix * vec4( skinned.xyz + normal, 1.0 );'
const OUTLINE_NEW = 'vec4 pos2 = pos + projectionMatrix * modelViewMatrix * vec4( normal, 0.0 );'

export function patchFlattenerOutline(vertexShader) {
  return typeof vertexShader === 'string' && vertexShader.includes(OUTLINE_OLD) ? vertexShader.replace(OUTLINE_OLD, OUTLINE_NEW) : vertexShader
}

let installed = false

// Patch three's shared chunks. Call once, before any material compiles. Returns true when the
// patch is active; if a future three.js changes the chunk this does nothing (no flattening, no
// harm) rather than guessing.
export function installFlattenerShader() {
  if (installed) return true
  const chunks = THREE.ShaderChunk
  const project = chunks.project_vertex
  if (typeof project !== 'string' || project.split(TARGET).length !== 2) return false
  chunks.project_vertex = project.replace(TARGET, `${APPLY_BEFORE}\n\t${TARGET}\n${APPLY_AFTER}`)
  // tell project_vertex whether this shader has a vNormal to flatten (the basic / depth shaders do not)
  const normals = chunks.normal_pars_vertex
  if (typeof normals === 'string' && normals.includes('varying vec3 vNormal;')) {
    chunks.normal_pars_vertex = normals.replace('varying vec3 vNormal;', 'varying vec3 vNormal;\n\t#define FLATTENER_HAS_VNORMAL')
  }
  chunks.common = `${chunks.common}\n${DECLARATIONS}`
  installed = true
  return true
}

export function isFlattenerShaderInstalled() {
  return installed
}

// The same maths as the shader, for tests and for anything on the CPU that needs to know where a
// point lands. `view` is the point in view space (camera at the origin, looking down -Z),
// `pivotViewZ` the view-space depth of the flattener centre, `height` how far the point is above
// the pivot along `up`, `params` = [strength, chin line, falloff, depth kept], `normal` an optional
// view-space normal and `shading` how much of the squash goes into it.
// Returns { point, normal, keep, amount } (the new view-space point, the flattened normal and the
// depth factor that was applied).
export function flattenViewPoint(view, pivotViewZ, height, params, normal = null, shading = 1, opts = {}) {
  const { partShade = 1, keepScreen = 0, edge = 0 } = opts
  const [strength, start, falloff, thickness] = params
  const t = Math.min(1, Math.max(0, (height - (start - falloff)) / Math.max(falloff, 1e-9)))
  const amount = strength * t * t * (3 - 2 * t)
  const out = { point: view.clone(), normal: normal ? normal.clone() : null, keep: 1, amount }
  if (amount <= 0 || view.z >= -0.0001 || pivotViewZ >= -0.0001) return out
  const keep = 1 + (thickness - 1) * amount
  out.keep = keep
  const flat = view.clone()
  flat.z = Math.min(pivotViewZ + (view.z - pivotViewZ) * keep, -0.0001)
  const kept = view.clone().multiplyScalar(flat.z / view.z) // same place on screen
  out.point.copy(flat).lerp(kept, keepScreen)
  if (normal) {
    const keepShade = 1 + (keep - 1) * shading * partShade
    const flatNormal = new THREE.Vector3(normal.x, normal.y, normal.z / Math.max(keepShade, 0.01)).normalize()
    let face
    if (edge > 0.001) {
      const x = Math.min(1, Math.max(0, normal.z / edge))
      face = x * x * (3 - 2 * x)
    } else face = normal.z >= 0 ? 1 : 0
    out.normal.copy(normal).lerp(flatNormal, face).normalize()
  }
  return out
}

// Where the vertex lands in clip space: the flattened position, but with the ORIGINAL depth
// (the shader's gl_Position.z override), so draw order never changes.
export function flattenedClip(view, flat, projection) {
  const original = new THREE.Vector4(view.x, view.y, view.z, 1).applyMatrix4(projection)
  const clip = new THREE.Vector4(flat.x, flat.y, flat.z, 1).applyMatrix4(projection)
  clip.z = (original.z / original.w) * clip.w
  return clip
}
