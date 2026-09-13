import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Camera post-processing: Depth of Field + uniform Blur
//
// Deliberately hand-rolled instead of three's examples/jsm/postprocessing
// (EffectComposer/BokehPass) so it can sit alongside the existing OutlineEffect
// wrapper with minimal plumbing: we render the normal (possibly outlined)
// frame into an offscreen target that also carries a depth texture, then draw
// one full-screen shader pass that blurs it. When both effects are off this
// module is entirely bypassed — render() returns false and the caller falls
// through to its normal renderer.render()/OutlineEffect path, so there is no
// cost when neither effect is enabled.
//
// The shader does a small fixed poisson-disk kernel rather than a true
// separable Gaussian; it's cheap (one pass) and visually reads as camera blur,
// which is all "blur" and "depth of field" need to be for this app. DOF blurs
// only what's FARTHER than the focus distance — everything from the camera up
// to the focus point stays sharp (a foreground-in-focus look), rather than a
// thin symmetric focal plane that also blurs anything nearer than focus. The
// uniform Blur effect adds a flat radius on top, independent of depth.
// ---------------------------------------------------------------------------

const KERNEL = [
  [0, 0],
  [0.53, 0.14], [-0.53, 0.14], [0.31, -0.48], [-0.31, -0.48],
  [0.0, 0.6], [0.6, -0.2], [-0.6, -0.2], [0.2, 0.55], [-0.2, -0.55],
  [0.85, 0.2], [-0.85, -0.2],
]

const VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const FRAGMENT_SHADER = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform vec2 uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform bool uDofEnabled;
  uniform float uFocusDistance;
  uniform float uAperture; // 0..1, how quickly out-of-focus areas blur
  uniform float uMaxBlurPx;
  uniform bool uBlurEnabled;
  uniform float uBlurPx;

  // Perspective depth -> linear view-space distance from the camera.
  float linearizeDepth(float z) {
    float ndc = z * 2.0 - 1.0;
    return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - ndc * (uCameraFar - uCameraNear));
  }

  // Standard linear -> sRGB transfer function (IEC 61966-2-1). This quad is
  // the pass that writes to the canvas: three.js renders the offscreen scene
  // pass in linear space (display encoding is only applied when the render
  // target IS the canvas), so without converting here the result would reach
  // the screen still in linear space, which a display expects as sRGB —
  // making the whole image read as darker than it should.
  vec3 linearToSRGB(vec3 c) {
    vec3 low = c * 12.92;
    vec3 high = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    return mix(high, low, step(c, vec3(0.0031308)));
  }

  void main() {
    float dofRadiusPx = 0.0;
    if (uDofEnabled) {
      float depth = texture2D(tDepth, vUv).x;
      float dist = linearizeDepth(depth);
      // Only things FARTHER than the focus distance blur — everything from the
      // camera up to the focus point stays sharp, like a foreground-in-focus
      // portrait shot rather than a thin symmetric focal plane.
      float beyond = max(dist - uFocusDistance, 0.0);
      float coc = clamp(beyond / max(uAperture, 0.001), 0.0, 1.0);
      dofRadiusPx = coc * uMaxBlurPx;
    }
    float flatRadiusPx = uBlurEnabled ? uBlurPx : 0.0;
    float radiusPx = max(dofRadiusPx, flatRadiusPx);

    if (radiusPx < 0.6) {
      vec4 c = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(linearToSRGB(c.rgb), c.a);
      return;
    }

    vec2 texel = radiusPx / uResolution;
    vec4 sum = texture2D(tDiffuse, vUv);
    float total = 1.0;
    ${KERNEL.slice(1).map((k) => `
    sum += texture2D(tDiffuse, vUv + vec2(${k[0].toFixed(4)}, ${k[1].toFixed(4)}) * texel);
    total += 1.0;`).join('')}
    vec4 blended = sum / total;
    gl_FragColor = vec4(linearToSRGB(blended.rgb), blended.a);
  }
`

const state = {
  renderer: null,
  target: null, // WebGLRenderTarget with an attached depth texture
  quadScene: null,
  quadCamera: null,
  quadMesh: null,
  material: null,
  dofEnabled: false,
  focusDistance: 5,
  aperture: 0.3,
  maxBlurPx: 12,
  blurEnabled: false,
  blurPx: 6,
}

export function initPostFX(renderer) {
  state.renderer = renderer

  const depthTexture = new THREE.DepthTexture()
  depthTexture.type = THREE.UnsignedIntType

  state.target = new THREE.WebGLRenderTarget(1, 1, {
    depthTexture,
    depthBuffer: true,
  })

  state.material = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uCameraNear: { value: 0.1 },
      uCameraFar: { value: 100 },
      uDofEnabled: { value: false },
      uFocusDistance: { value: state.focusDistance },
      uAperture: { value: state.aperture },
      uMaxBlurPx: { value: state.maxBlurPx },
      uBlurEnabled: { value: false },
      uBlurPx: { value: state.blurPx },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    depthTest: false,
    depthWrite: false,
  })

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(
    [-1, -1, 0, 3, -1, 0, -1, 3, 0], 3,
  ))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(
    [0, 0, 2, 0, 0, 2], 2,
  ))
  state.quadMesh = new THREE.Mesh(geometry, state.material)
  state.quadMesh.frustumCulled = false

  state.quadScene = new THREE.Scene()
  state.quadScene.add(state.quadMesh)
  state.quadCamera = new THREE.Camera() // untransformed, unused by the shader
}

export function isPostFXActive() {
  return state.dofEnabled || state.blurEnabled
}

export function setDepthOfField(enabled, focusDistance, aperture, maxBlurPx) {
  state.dofEnabled = !!enabled
  if (focusDistance != null) state.focusDistance = focusDistance
  if (aperture != null) state.aperture = aperture
  if (maxBlurPx != null) state.maxBlurPx = maxBlurPx
  if (!state.material) return
  state.material.uniforms.uDofEnabled.value = state.dofEnabled
  state.material.uniforms.uFocusDistance.value = state.focusDistance
  state.material.uniforms.uAperture.value = state.aperture
  state.material.uniforms.uMaxBlurPx.value = state.maxBlurPx
}

export function setBlurEffect(enabled, blurPx) {
  state.blurEnabled = !!enabled
  if (blurPx != null) state.blurPx = blurPx
  if (!state.material) return
  state.material.uniforms.uBlurEnabled.value = state.blurEnabled
  state.material.uniforms.uBlurPx.value = state.blurPx
}

export function resizePostFX(width, height, pixelRatio = 1) {
  if (!state.target) return
  state.target.setSize(Math.max(1, Math.round(width * pixelRatio)), Math.max(1, Math.round(height * pixelRatio)))
  if (state.material) state.material.uniforms.uResolution.value.set(
    Math.max(1, Math.round(width * pixelRatio)),
    Math.max(1, Math.round(height * pixelRatio)),
  )
}

// Renders `scene`/`camera` through the DOF/Blur pipeline when either effect is
// on, using `drawFn(target)` to do the actual (possibly outlined) scene draw
// into the given render target. Returns false — doing nothing — when both
// effects are off, so the caller should fall back to its normal render path.
export function renderPostFX(camera, drawFn) {
  if (!state.renderer || !state.target) return false
  if (!state.dofEnabled && !state.blurEnabled) return false

  state.material.uniforms.uCameraNear.value = camera.near
  state.material.uniforms.uCameraFar.value = camera.far

  const renderer = state.renderer
  const prevTarget = renderer.getRenderTarget()

  renderer.setRenderTarget(state.target)
  drawFn(state.target)

  renderer.setRenderTarget(prevTarget)
  state.material.uniforms.tDiffuse.value = state.target.texture
  state.material.uniforms.tDepth.value = state.target.depthTexture
  renderer.render(state.quadScene, state.quadCamera)

  return true
}

export function disposePostFX() {
  if (state.target) state.target.dispose()
  if (state.quadMesh) {
    state.quadMesh.geometry.dispose()
    state.material?.dispose()
  }
  state.renderer = null
  state.target = null
  state.quadScene = null
  state.quadCamera = null
  state.quadMesh = null
  state.material = null
}