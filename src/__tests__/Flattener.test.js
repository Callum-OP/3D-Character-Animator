import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js'
import { useStore } from '../store.js'
import {
  installFlattenerShader,
  isFlattenerShaderInstalled,
  flattenViewPoint,
  flattenedClip,
  patchFlattenerOutline,
  flatCount,
  flatPivot,
  flatUp,
  flatParams,
  flatMore,
  addFlattenerUniforms,
} from '../three/flattenerShader.js'
import {
  initFlattener,
  setFlattenerConfig,
  clearFlattener,
  addFlattener,
  setFlattenerEnabled,
  updateFlattener,
  removeFlattener,
  fitFlattener,
  findHeadBoneName,
  updateFlattenerGuides,
  setFlattenerGuideVisible,
} from '../three/flattener.js'
import { setPartLook } from '../three/materialHistory.js'
import { applyMaterials, recordOriginalMaterials } from '../three/materials.js'
import { performUndo, performRedo } from '../three/undoPriority.js'
import { clearUndoHistory } from '../three/undoHistory.js'

const CHAR = 1
let scene

// hips -> spine -> neck -> head -> head_end (the head bone points up at the top of the head)
function makeCharacter() {
  const root = new THREE.Group()
  const bone = (name, y) => {
    const b = new THREE.Bone()
    b.name = name
    b.position.set(0, y, 0)
    return b
  }
  const hips = bone('hips', 1.0)
  const spine = bone('spine', 0.2)
  const neck = bone('neck', 0.3)
  const head = bone('head', 0.1)
  const headEnd = bone('head_end', 0.4)
  hips.add(spine)
  spine.add(neck)
  neck.add(head)
  head.add(headEnd)
  root.add(hips)
  const bones = [hips, spine, neck, head, headEnd]
  const skeleton = new THREE.Skeleton(bones)

  const skinned = (geometry, boneIndex) => {
    const n = geometry.getAttribute('position').count
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? boneIndex : 0)), 4))
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4))
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial())
    return mesh
  }
  // a head: a sphere around y = 1.8 (1.6 .. 2.0), skinned to the head bone
  const headGeo = new THREE.SphereGeometry(0.2, 24, 16)
  headGeo.translate(0, 1.8, 0)
  const headMesh = skinned(headGeo, 3)
  // a body below it, skinned to the spine
  const bodyGeo = new THREE.CylinderGeometry(0.2, 0.25, 0.8, 12)
  bodyGeo.translate(0, 1.0, 0)
  const bodyMesh = skinned(bodyGeo, 1)
  root.add(headMesh, bodyMesh)
  scene.add(root)
  root.updateMatrixWorld(true)
  headMesh.bind(skeleton)
  bodyMesh.bind(skeleton)
  return { root, bones, meshes: [headMesh, bodyMesh], headMesh, bodyMesh, head, neck }
}

let model

beforeAll(() => {
  scene = new THREE.Scene()
  initFlattener({ scene, requestRender: () => {} })
})

beforeEach(() => {
  clearFlattener(CHAR)
  clearUndoHistory()
  if (model) scene.remove(model.root)
  model = makeCharacter()
  useStore.setState({ activeCharacterId: CHAR, characters: {}, flatteners: [], flattenerEnabled: true, meshOverrides: {} })
  setFlattenerConfig(CHAR, model, true, [])
})

const drawUniforms = (mesh) => {
  mesh.onBeforeRender()
  const seen = { count: flatCount.value, pivot: flatPivot.value[0].clone(), up: flatUp.value[0].clone(), params: flatParams.value[0].clone() }
  mesh.onAfterRender()
  return seen
}

describe('flattener shader patch', () => {
  it('patches three once, and is harmless to ask again', () => {
    expect(installFlattenerShader()).toBe(true)
    const once = THREE.ShaderChunk.project_vertex
    expect(installFlattenerShader()).toBe(true)
    expect(THREE.ShaderChunk.project_vertex).toBe(once)
    expect(isFlattenerShaderInstalled()).toBe(true)
    expect(once).toContain('FLATTENER_AVAILABLE')
    expect(once).toContain('FLATTENER_OFF')
    expect(once.indexOf('uFlatCount')).toBeLessThan(once.indexOf('gl_Position'))
    expect(THREE.ShaderChunk.common).toContain('uniform vec4 uFlatParams[')
  })

  it('shares its uniforms with every shader through addFlattenerUniforms', () => {
    const u = {}
    addFlattenerUniforms(u)
    expect(Object.keys(u).sort()).toEqual(['uFlatCount', 'uFlatMore', 'uFlatParams', 'uFlatPivot', 'uFlatUp'])
  })
})

describe('flattener maths (the same as the shader)', () => {
  // camera at the origin looking down -Z; pivot (head centre) 5 away; "height" = how far above the pivot
  const params = [1, -0.2, 0.3, 0.05] // strength, chin line, falloff, depth kept
  const pivotZ = -5

  it('flattens depth above the chin line to a thin slab around the centre', () => {
    const front = flattenViewPoint(new THREE.Vector3(0.2, 0.3, -4.8), pivotZ, 0.1, params).point // nose, 0.2 in front of centre
    const back = flattenViewPoint(new THREE.Vector3(0.2, 0.3, -5.2), pivotZ, 0.1, params).point // back of head
    expect(Math.abs(front.z - pivotZ)).toBeLessThan(0.2 * 0.05 + 1e-6)
    expect(Math.abs(back.z - pivotZ)).toBeLessThan(0.2 * 0.05 + 1e-6)
    expect(front.z).toBeGreaterThan(back.z)
    // sideways position in view space is untouched (a true flatten along the view axis)
    expect(front.x).toBeCloseTo(0.2, 9)
    expect(front.y).toBeCloseTo(0.3, 9)
  })

  it('leaves everything below the falloff untouched and fades in between', () => {
    const v = new THREE.Vector3(0.1, 0.2, -4.8)
    expect(flattenViewPoint(v, pivotZ, -0.6, params).point.z).toBeCloseTo(v.z, 9) // well below the chin
    const mid = flattenViewPoint(v, pivotZ, -0.35, params).point
    const full = flattenViewPoint(v, pivotZ, 0.1, params).point
    expect(Math.abs(mid.z - pivotZ)).toBeGreaterThan(Math.abs(full.z - pivotZ))
    expect(Math.abs(mid.z - pivotZ)).toBeLessThan(Math.abs(v.z - pivotZ))
  })

  it('strength scales it, and 0 does nothing', () => {
    const v = new THREE.Vector3(0.1, 0.2, -4.8)
    expect(flattenViewPoint(v, pivotZ, 0.1, [0, -0.2, 0.3, 0.05]).point.z).toBeCloseTo(v.z, 9)
    const half = flattenViewPoint(v, pivotZ, 0.1, [0.5, -0.2, 0.3, 0.05]).point
    const whole = flattenViewPoint(v, pivotZ, 0.1, [1, -0.2, 0.3, 0.05]).point
    expect(Math.abs(half.z - pivotZ)).toBeGreaterThan(Math.abs(whole.z - pivotZ))
  })

  it('the shading normals are flattened with the geometry: a face turned toward the camera is lit as a flat plane', () => {
    // a cheek turned 50 degrees from the camera
    const n = new THREE.Vector3(Math.sin(0.87), 0.1, Math.cos(0.87)).normalize()
    const flat = flattenViewPoint(new THREE.Vector3(0.1, 0.2, -4.9), pivotZ, 0.1, params, n).normal
    expect(flat.length()).toBeCloseTo(1, 9)
    expect(flat.z).toBeGreaterThan(0.99) // now almost straight at the camera
    expect(flat.z).toBeGreaterThan(n.z)
    // a surface edge-on to the camera (a silhouette) stays edge-on
    const edge = flattenViewPoint(new THREE.Vector3(0.1, 0.2, -4.9), pivotZ, 0.1, params, new THREE.Vector3(1, 0, 0)).normal
    expect(edge.x).toBeCloseTo(1, 9)
    // below the chin line the lighting is untouched
    const below = flattenViewPoint(new THREE.Vector3(0.1, 0.2, -4.9), pivotZ, -0.7, params, n).normal
    expect(below.distanceTo(n)).toBeLessThan(1e-9)
  })

  it('"flatten shading" 0 flattens the shape but leaves the lighting alone', () => {
    const n = new THREE.Vector3(0.7, 0, 0.7).normalize()
    const out = flattenViewPoint(new THREE.Vector3(0, 0, -4.9), pivotZ, 0.1, params, n, 0)
    expect(out.normal.distanceTo(n)).toBeLessThan(1e-9)
    expect(out.keep).toBeLessThan(0.1)
    const half = flattenViewPoint(new THREE.Vector3(0, 0, -4.9), pivotZ, 0.1, params, n, 0.5).normal
    expect(half.z).toBeGreaterThan(n.z)
  })

  it('draw order never changes: the depth that is written is the original depth', () => {
    const projection = new THREE.PerspectiveCamera(50, 1, 0.1, 100).projectionMatrix
    // skin, and an eye 1 mm behind it: far closer together than the squash would leave them
    const skin = new THREE.Vector3(0.05, 0.1, -4.8)
    const eye = new THREE.Vector3(0.05, 0.1, -4.801)
    const depthOf = (v) => {
      const f = flattenViewPoint(v, pivotZ, 0.1, params)
      const clip = flattenedClip(v, f.point, projection)
      const original = new THREE.Vector4(v.x, v.y, v.z, 1).applyMatrix4(projection)
      return { ndc: clip.z / clip.w, originalNdc: original.z / original.w, moved: f.point.z !== v.z }
    }
    const a = depthOf(skin)
    const b = depthOf(eye)
    expect(a.moved).toBe(true)
    expect(a.ndc).toBeCloseTo(a.originalNdc, 12)
    expect(b.ndc).toBeCloseTo(b.originalNdc, 12)
    expect(b.ndc).toBeGreaterThan(a.ndc) // the eye is still behind the skin
  })
})

describe('flattener maths: the hair-tuning controls', () => {
  const params = [1, -0.2, 0.3, 0.05]
  const pivotZ = -5
  const view = new THREE.Vector3(0.3, 0.2, -4.8)
  const project = (v) => new THREE.Vector2(v.x / -v.z, v.y / -v.z)

  it('surfaces turned away from the camera keep their own lighting (shading edge)', () => {
    const away = new THREE.Vector3(0.2, 0.3, -0.6).normalize() // a hair card whose stored normal points away
    const withEdge = flattenViewPoint(view, pivotZ, 0.1, params, away, 1, { edge: 0.15 }).normal
    expect(withEdge.distanceTo(away)).toBeLessThan(1e-9)
    const without = flattenViewPoint(view, pivotZ, 0.1, params, away, 1, { edge: 0 }).normal
    expect(without.distanceTo(away)).toBeLessThan(1e-9) // hard cut at facing-away
    // a grazing surface is only partly re-lit, a facing one fully
    const grazing = new THREE.Vector3(0.99, 0, 0.1).normalize()
    const g = flattenViewPoint(view, pivotZ, 0.1, params, grazing, 1, { edge: 0.3 }).normal
    const gFull = flattenViewPoint(view, pivotZ, 0.1, params, grazing, 1, { edge: 0 }).normal
    expect(g.z).toBeLessThan(gFull.z)
    expect(g.z).toBeGreaterThan(grazing.z)
    const facing = new THREE.Vector3(0.3, 0.1, 0.9).normalize()
    expect(flattenViewPoint(view, pivotZ, 0.1, params, facing, 1, { edge: 0.3 }).normal.z).toBeGreaterThan(0.99)
  })

  it('a part can keep its own lighting while its shape is flattened', () => {
    const n = new THREE.Vector3(0.4, 0.1, 0.9).normalize()
    const out = flattenViewPoint(view, pivotZ, 0.1, params, n, 1, { partShade: 0 })
    expect(out.normal.distanceTo(n)).toBeLessThan(1e-9)
    expect(out.keep).toBeLessThan(0.1)
  })

  it('"keep screen shape" leaves every point where it is on screen', () => {
    const full = flattenViewPoint(view, pivotZ, 0.1, params, null, 1, { keepScreen: 1 }).point
    expect(project(full).distanceTo(project(view))).toBeLessThan(1e-9)
    expect(Math.abs(full.z - pivotZ)).toBeLessThan(0.2 * 0.05 + 1e-6) // and it is still flattened
    const none = flattenViewPoint(view, pivotZ, 0.1, params, null, 1, { keepScreen: 0 }).point
    expect(project(none).distanceTo(project(view))).toBeGreaterThan(1e-4)
    const half = flattenViewPoint(view, pivotZ, 0.1, params, null, 1, { keepScreen: 0.5 }).point
    const d = (v) => project(v).distanceTo(project(view))
    expect(d(half)).toBeLessThan(d(none))
    expect(d(half)).toBeGreaterThan(d(full))
  })

  it('the shader carries the same controls', () => {
    const chunk = THREE.ShaderChunk.project_vertex
    expect(chunk).toContain('uFlatMore[ fi ].z') // keep screen shape
    expect(chunk).toContain('uFlatMore[ fi ].w') // shading edge
    expect(chunk).toContain('uFlatMore[ fi ].y') // per-part lighting
    expect(chunk).toContain('smoothstep( 0.0, fSoft, vNormal.z )')
  })
})

describe('the outline shader', () => {
  it('builds its push direction from the vertex itself, so flattening cannot bend it', () => {
    const src = 'a\n\tvec4 pos2 = projectionMatrix * modelViewMatrix * vec4( skinned.xyz + normal, 1.0 );\nb'
    const out = patchFlattenerOutline(src)
    expect(out).toContain('vec4 pos2 = pos + projectionMatrix * modelViewMatrix * vec4( normal, 0.0 );')
    expect(patchFlattenerOutline('nothing to change')).toBe('nothing to change')
  })

  it('the patched chunk writes the original depth and flattens vNormal where there is one', () => {
    const chunk = THREE.ShaderChunk.project_vertex
    expect(chunk).toContain('flatClipOriginal')
    expect(chunk).toContain('gl_Position.z = flatClipOriginal.z / flatClipOriginal.w * gl_Position.w')
    expect(chunk).toContain('FLATTENER_HAS_VNORMAL')
    expect(THREE.ShaderChunk.normal_pars_vertex).toContain('#define FLATTENER_HAS_VNORMAL')
  })
})

describe('auto-fit', () => {
  it('finds the head centre, size, up direction and a chin line from the mesh', () => {
    const fit = fitFlattener(model, model.head)
    expect(fit.fitted).toBe(true)
    expect(fit.headSize).toBeGreaterThan(0.36)
    expect(fit.headSize).toBeLessThan(0.42)
    const centre = new THREE.Vector3(...fit.pivotLocal).applyMatrix4(model.head.matrixWorld)
    expect(centre.distanceTo(new THREE.Vector3(0, 1.8, 0))).toBeLessThan(0.02)
    expect(fit.upLocal[1]).toBeGreaterThan(0.99)
    expect(fit.start).toBeLessThanOrEqual(-0.1)
    expect(fit.start).toBeGreaterThanOrEqual(-0.8)
  })

  it('still works on a bone with no skinned vertices (a sensible default)', () => {
    const fit = fitFlattener(model, model.bones[4]) // head_end: nothing is skinned to it
    expect(fit.fitted).toBe(false)
    expect(fit.headSize).toBeGreaterThan(0)
  })

  it('recognises a head bone', () => {
    expect(findHeadBoneName(['hips', 'spine', 'Head', 'hand_L'])).toBe('Head')
    expect(findHeadBoneName(['a', 'b'])).toBeNull()
  })
})

describe('what the shader is told while a mesh is drawn', () => {
  it('numbers go in just before the character is drawn and out right after', () => {
    const item = addFlattener('head', { characterId: CHAR })
    expect(item).toBeTruthy()
    const seen = drawUniforms(model.headMesh)
    expect(seen.count).toBe(1)
    expect(seen.pivot.distanceTo(new THREE.Vector3(0, 1.8, 0))).toBeLessThan(0.02)
    expect(seen.up.y).toBeGreaterThan(0.99)
    expect(seen.params.x).toBe(1)
    expect(flatMore.value[0].toArray()).toEqual([1, 1, 0, 0.15]) // lighting, part lighting, keep screen, edge
    expect(flatCount.value).toBe(0) // cleared: nothing else drawn afterwards is flattened
  })

  it('survives the outline effect swapping the mesh\'s onBeforeRender for its own pass', () => {
    addFlattener('head', { characterId: CHAR })
    const mesh = model.headMesh
    // what three's OutlineEffect does: read the current function, put its own in, draw, put the old one back
    const calls = []
    const saved = mesh.onBeforeRender
    mesh.onBeforeRender = function outlineBeforeRender() {
      calls.push('outline')
    }
    mesh.onBeforeRender()
    expect(flatCount.value).toBe(1) // the flattener was still switched on for the outline pass
    expect(calls).toEqual(['outline']) // and the outline effect's own function still ran
    mesh.onAfterRender()
    expect(flatCount.value).toBe(0)
    mesh.onBeforeRender = saved // the effect puts the old one back
    calls.length = 0
    mesh.onBeforeRender()
    expect(flatCount.value).toBe(1)
    expect(calls).toEqual([]) // the outline effect's function is gone again, nothing left behind
    mesh.onAfterRender()
  })

  it('is on for BOTH passes of the real outline effect (the ghost of the unflattened shape)', () => {
    addFlattener('head', { characterId: CHAR })
    const seen = [] // [what was drawn, how many flattener zones were switched on]
    const renderer = {
      autoClear: true,
      shadowMap: { enabled: false, type: 0, autoUpdate: true },
      domElement: document.createElement('canvas'),
      clear: () => {},
      // a draw call as three makes it: each mesh's onBeforeRender, then the draw, then onAfterRender
      render(drawScene, camera) {
        drawScene.traverse((o) => {
          if (!o.isMesh || o !== model.headMesh) return
          o.onBeforeRender(renderer, drawScene, camera, o.geometry, o.material)
          seen.push([Array.isArray(o.material) ? 'array' : o.material.type, flatCount.value])
          o.onAfterRender(renderer, drawScene, camera, o.geometry, o.material)
        })
      },
    }
    const effect = new OutlineEffect(renderer, { defaultThickness: 0.01 })
    effect.render(scene, new THREE.PerspectiveCamera())
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual(['MeshStandardMaterial', 1]) // the normal pass
    expect(seen[1][0]).not.toBe('MeshStandardMaterial') // the outline pass: three's own outline material...
    expect(seen[1][1]).toBe(1) // ...drawn flattened too
    expect(flatCount.value).toBe(0)
    // and the effect put the mesh back the way it found it
    model.headMesh.onBeforeRender()
    expect(flatCount.value).toBe(1)
    model.headMesh.onAfterRender()
  })

  it('follows the bone: tilting the head tilts the zone with it', () => {
    addFlattener('head', { characterId: CHAR })
    model.head.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
    model.root.updateMatrixWorld(true)
    const seen = drawUniforms(model.bodyMesh)
    expect(seen.up.y).toBeLessThan(0.05)
    expect(Math.abs(seen.up.x)).toBeGreaterThan(0.99)
  })

  it('the chin line and falloff are in head sizes, so they scale with the character', () => {
    const item = addFlattener('head', { characterId: CHAR })
    const a = drawUniforms(model.headMesh).params
    model.root.scale.setScalar(2)
    model.root.updateMatrixWorld(true)
    const b = drawUniforms(model.headMesh).params
    expect(b.y).toBeCloseTo(a.y * 2, 5)
    expect(b.z).toBeCloseTo(a.z * 2, 5)
    expect(item.start).toBeLessThan(0)
  })

  it('a disabled flattener, the master switch, strength 0 and a part opted out all draw normally', () => {
    const item = addFlattener('head', { characterId: CHAR })
    expect(drawUniforms(model.headMesh).count).toBe(1)
    updateFlattener(item.id, { enabled: false })
    expect(drawUniforms(model.headMesh).count).toBe(0)
    updateFlattener(item.id, { enabled: true, strength: 0 })
    expect(drawUniforms(model.headMesh).count).toBe(0)
    updateFlattener(item.id, { strength: 1 })
    expect(drawUniforms(model.headMesh).count).toBe(1)
    model.headMesh.userData.flatOff = true
    expect(drawUniforms(model.headMesh).count).toBe(0)
    model.headMesh.userData.flatOff = false
    setFlattenerConfig(CHAR, model, false, useStore.getState().flatteners)
    expect(drawUniforms(model.headMesh).count).toBe(0)
  })

  it('a mesh that is not part of the character is never flattened', () => {
    addFlattener('head', { characterId: CHAR })
    const other = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    expect(flatCount.value).toBe(0)
    other.onBeforeRender?.()
    expect(flatCount.value).toBe(0)
  })
})

describe('what the shader is told: the tuning controls', () => {
  it('the new settings and a part that keeps its own lighting reach the shader', () => {
    const item = addFlattener('head', { characterId: CHAR })
    updateFlattener(item.id, { shading: 0.6, shadingEdge: 0.4, keepScreen: 0.7 })
    const seen = (mesh) => {
      mesh.onBeforeRender()
      const v = flatMore.value[0].toArray()
      mesh.onAfterRender()
      return v
    }
    expect(seen(model.headMesh)).toEqual([0.6, 1, 0.7, 0.4])
    model.headMesh.userData.flatShade = 0
    expect(seen(model.headMesh)[1]).toBe(0)
  })

  it('applyMaterials marks a part that keeps its own lighting', () => {
    const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    const m = { meshes: [a, b] }
    recordOriginalMaterials(m)
    applyMaterials(m, { mode: 'standard', overrides: { [a.uuid]: { flatShade: false } } })
    expect(a.userData.flatShade).toBe(0)
    expect(b.userData.flatShade).toBe(1)
    setPartLook(['x'], { flatShade: false })
    expect(useStore.getState().meshOverrides.x.flatShade).toBe(false)
    setPartLook(['x'], { flatShade: true })
    expect(useStore.getState().meshOverrides.x.flatShade).toBeUndefined()
  })
})

describe('flattener: more undo', () => {
  it('the master switch is an undo step', () => {
    addFlattener('head', { characterId: CHAR })
    expect(useStore.getState().flattenerEnabled).toBe(true)
    setFlattenerEnabled(CHAR, false)
    expect(useStore.getState().flattenerEnabled).toBe(false)
    expect(drawUniforms(model.headMesh).count).toBe(0)
    performUndo(useStore.getState())
    expect(useStore.getState().flattenerEnabled).toBe(true)
    expect(drawUniforms(model.headMesh).count).toBe(1)
    performRedo(useStore.getState())
    expect(useStore.getState().flattenerEnabled).toBe(false)
  })

  it('an edit straight after an undo is its own step and is not lost', () => {
    const item = addFlattener('head', { characterId: CHAR })
    updateFlattener(item.id, { strength: 0.5 })
    performUndo(useStore.getState())
    updateFlattener(item.id, { strength: 0.25 })
    expect(useStore.getState().flatteners[0].strength).toBe(0.25)
    performUndo(useStore.getState())
    expect(useStore.getState().flatteners[0].strength).toBe(1)
    performRedo(useStore.getState())
    expect(useStore.getState().flatteners[0].strength).toBe(0.25)
  })
})

describe('editing', () => {
  it('adding, tweaking and removing are undoable; a slider drag is one step', () => {
    const item = addFlattener('head', { characterId: CHAR })
    expect(useStore.getState().flatteners).toHaveLength(1)
    for (const v of [0.9, 0.8, 0.7]) updateFlattener(item.id, { strength: v })
    expect(useStore.getState().flatteners[0].strength).toBe(0.7)
    performUndo(useStore.getState())
    expect(useStore.getState().flatteners[0].strength).toBe(1)
    performUndo(useStore.getState())
    expect(useStore.getState().flatteners).toHaveLength(0)
    performRedo(useStore.getState())
    expect(useStore.getState().flatteners).toHaveLength(1)
    removeFlattener(item.id)
    expect(useStore.getState().flatteners).toHaveLength(0)
    performUndo(useStore.getState())
    expect(useStore.getState().flatteners).toHaveLength(1)
  })

  it('stops at four per character', () => {
    for (let i = 0; i < 5; i++) addFlattener('head', { characterId: CHAR })
    expect(useStore.getState().flatteners.length).toBe(4)
  })

  it('a bone that does not exist adds nothing', () => {
    expect(addFlattener('nope', { characterId: CHAR })).toBeNull()
  })

  it('a part can opt out, and the saved override only ever says "false"', () => {
    setPartLook(['a'], { flatten: false })
    expect(useStore.getState().meshOverrides.a.flatten).toBe(false)
    setPartLook(['a'], { flatten: true })
    expect(useStore.getState().meshOverrides.a.flatten).toBeUndefined()
  })

  it('applyMaterials marks an opted-out part for the shader', () => {
    const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    const m = { meshes: [a, b] }
    recordOriginalMaterials(m)
    applyMaterials(m, { mode: 'standard', overrides: { [a.uuid]: { flatten: false } } })
    expect(a.userData.flatOff).toBe(true)
    expect(b.userData.flatOff).toBe(false)
  })
})

describe('the chin-line guide', () => {
  it('appears only while switched on, sits at the chin line and follows the head', () => {
    const item = addFlattener('head', { characterId: CHAR })
    updateFlattenerGuides()
    expect(scene.children.some((c) => c.name === 'flattener-guide')).toBe(false)
    setFlattenerGuideVisible(true)
    updateFlattenerGuides()
    const guide = scene.children.find((c) => c.name === 'flattener-guide')
    expect(guide).toBeTruthy()
    expect(guide.visible).toBe(true)
    const chin = new THREE.Vector3()
    guide.userData.chin.getWorldPosition(chin)
    expect(chin.y).toBeLessThan(1.8)
    expect(chin.y).toBeGreaterThan(1.55)
    setFlattenerGuideVisible(false)
    expect(guide.visible).toBe(false)
    removeFlattener(item.id)
    expect(scene.children.some((c) => c.name === 'flattener-guide')).toBe(false)
  })
})
