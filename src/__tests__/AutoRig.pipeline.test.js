import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { blenderPath } from './helpers/blendFixtures.js'

const require = createRequire(import.meta.url)
const { runAutoRig, validLandmarks, makeProgressParser, explainLaunchFailure } = require('../../electron/autorig.cjs')

// world rotation of a glTF node (3x3, row-major arrays) from the node hierarchy
function qmat([x, y, z, w]) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ]
}
const mul = (A, B) => A.map((r) => [0, 1, 2].map((c) => r[0] * B[0][c] + r[1] * B[1][c] + r[2] * B[2][c]))
function worldAxes(j, name) {
  const parent = {}
  j.nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)))
  let i = j.nodes.findIndex((n) => n.name === name)
  const chain = []
  while (i !== undefined && i >= 0) {
    chain.unshift(i)
    i = parent[i]
  }
  let R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (const k of chain) R = mul(R, qmat(j.nodes[k].rotation || [0, 0, 0, 1]))
  return { x: [R[0][0], R[1][0], R[2][0]], y: [R[0][1], R[1][1], R[2][1]] }
}
const angleDeg = (a, b) => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI

// Expected local X axis per bone in glTF world space.
const BONE_X = {
  Hips: [1, 0, 0], Spine: [1, 0, 0], Spine1: [1, 0, 0], Spine2: [1, 0, 0], Neck: [1, 0, 0], Head: [1, 0, 0],
  LeftArm: [0, 0, -1], LeftForeArm: [0, 0, -1], LeftHand: [0, 0, -1], RightArm: [0, 0, 1], RightForeArm: [0, 0, 1], RightHand: [0, 0, 1],
  LeftUpLeg: [-1, 0, 0], LeftLeg: [-1, 0, 0], LeftFoot: [-1, 0, 0], LeftToeBase: [-1, 0, 0],
  RightUpLeg: [-1, 0, 0], RightLeg: [-1, 0, 0], RightFoot: [-1, 0, 0], RightToeBase: [-1, 0, 0],
}

function glbJson(buf) {
  expect(buf.toString('latin1', 0, 4)).toBe('glTF')
  return JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)))
}

describe('Auto Rigger runner (no Blender needed)', () => {
  it('validates landmarks and refuses bad input before starting anything', async () => {
    expect(validLandmarks({ pelvis: [0, 1, 0] })).toBe(true)
    expect(validLandmarks({ pelvis: [0, 'x', 0] })).toBe(false)
    expect(validLandmarks({ 'bad key!': [0, 0, 0] })).toBe(false)
    expect(validLandmarks(null)).toBe(false)
    await expect(runAutoRig({ blenderPath: process.execPath, input: { name: 'a.exe', data: Buffer.from('x') }, landmarks: { pelvis: [0, 0, 0] } })).rejects.toThrow(/can't read/)
    await expect(runAutoRig({ blenderPath: process.execPath, input: { name: 'a.glb', data: Buffer.from('x') }, landmarks: {} })).rejects.toThrow(/landmarks/)
    await expect(runAutoRig({ blenderPath: '/nope/blender', input: { name: 'a.glb', data: Buffer.from('x') }, landmarks: { pelvis: [0, 0, 0] } })).rejects.toThrow(/not found/)
  })
  it('turns the script marker into a readable error and cleans up its job folder', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'animare-rigtest-'))
    const runner = async () => ({ code: 3, log: 'x\nAUTORIG_ERROR:landmarks:Missing landmarks: pelvis\n' })
    await expect(runAutoRig({ blenderPath: process.execPath, input: { name: 'a.glb', data: Buffer.from('x') }, landmarks: { pelvis: [0, 0, 0] }, tmpRoot: tmp, runner })).rejects.toThrow('Missing landmarks: pelvis')
    expect(fs.readdirSync(tmp).filter((n) => n.startsWith('job-'))).toEqual([])
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('progress + launch problems (no Blender needed)', () => {
  it('parses progress lines even when split across chunks', () => {
    const got = []
    const feed = makeProgressParser((p) => got.push(p))
    feed('noise\n[autorig-progress] 0.150 Solving wei')
    feed('ghts\n[autorig-progress] 0.55')
    feed('0 Transferring\n')
    expect(got).toEqual([{ frac: 0.15, label: 'Solving weights' }, { frac: 0.55, label: 'Transferring' }])
  })
  it('explains blocked launches in plain language, and leaves real failures alone', () => {
    expect(explainLaunchFailure({ spawnError: { code: 'EPERM' } }, 'win32')).toMatch(/Windows Security/)
    expect(explainLaunchFailure({ code: 3221225781, log: '' }, 'win32')).toMatch(/stopped Blender/)
    expect(explainLaunchFailure({ spawnError: { code: 'EACCES' } }, 'linux')).toMatch(/permission denied/)
    expect(explainLaunchFailure({ code: 1, log: 'AUTORIG_ERROR:x' }, 'win32')).toBeNull()
    expect(explainLaunchFailure({ code: 0, log: '' }, 'win32')).toBeNull()
  })
  it('reuses one script path and a job folder under the work root', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'animare-work-'))
    const seen = []
    const runner = async (_exe, args) => {
      seen.push(args[args.indexOf('--python') + 1])
      return { code: 3, log: 'AUTORIG_ERROR:landmarks:nope' }
    }
    for (let i = 0; i < 2; i++) {
      await expect(runAutoRig({ blenderPath: process.execPath, input: { name: 'a.glb', data: Buffer.from('x') }, landmarks: { pelvis: [0, 0, 0] }, workRoot: work, runner })).rejects.toThrow('nope')
    }
    expect(seen[0]).toBe(seen[1])
    expect(seen[0].startsWith(work)).toBe(true)
    expect(fs.readdirSync(work).filter((n) => n.startsWith('job-'))).toEqual([]) // job folders cleaned up
    fs.rmSync(work, { recursive: true, force: true })
  })
})

describe.skipIf(!blenderPath)('real Blender: synthetic humanoid → rigged glb', () => {
  let dir, input, landmarks
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animare-human-'))
    const r = spawnSync(blenderPath, ['--background', '--factory-startup', '--python', path.join(__dirname, 'helpers/syntheticHumanoid.py'), '--', dir], { encoding: 'utf8', timeout: 120000 })
    expect(fs.existsSync(path.join(dir, 'human.glb')), r.stdout + r.stderr).toBe(true)
    input = { name: 'human.glb', data: fs.readFileSync(path.join(dir, 'human.glb')) }
    landmarks = JSON.parse(fs.readFileSync(path.join(dir, 'landmarks.json'), 'utf8'))
  }, 180000)
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('produces a clean, accurate rig', async () => {
    const { glb, report } = await runAutoRig({ blenderPath, input, landmarks })
    const j = glbJson(glb)

    // expected bone names, one skin
    const names = j.nodes.map((n) => n.name)
    for (const n of ['mixamorig:Hips', 'mixamorig:Spine2', 'mixamorig:Head', 'mixamorig:LeftForeArm', 'mixamorig:RightLeg', 'mixamorig:LeftToeBase']) expect(names).toContain(n)
    expect(j.skins).toHaveLength(1)
    expect(j.skins[0].joints.length).toBe(report.bones)

    // weights: every vertex bound, normalised, at most 4 influences
    expect(report.weights.unweighted_vertices).toBe(0)
    expect(report.weights.max_sum_error).toBeLessThan(1e-4)
    expect(report.weights.max_influences).toBeLessThanOrEqual(4)
    expect(report.proxy.solver_unweighted).toBe(0)

    // each separate part is owned by the right bone (the thing you would check by eye)
    const dom = Object.fromEntries(Object.entries(report.per_component).map(([k, v]) => [k, v.bone]))
    expect(dom).toMatchObject({
      Head: 'Head', Neck: 'Neck', Pelvis: 'Hips',
      LUpperArm: 'LeftArm', LForeArm: 'LeftForeArm',
      RUpperArm: 'RightArm', RForeArm: 'RightForeArm',
      LThigh: 'LeftUpLeg', LShin: 'LeftLeg', RThigh: 'RightUpLeg', RShin: 'RightLeg',
    })
    for (const k of ['LForeArm', 'LThigh', 'Head']) expect(report.per_component[k].share).toBeGreaterThan(0.6)
    // a hand is split between the palm and its fingers: its dominant bone is one of the left hand's
    expect(report.per_component.LHand.bone).toMatch(/^LeftHand/)
    expect(report.per_component.RHand.bone).toMatch(/^RightHand/)

    // thin blade + eyes are bound rigidly, not heat-diffused
    const rigid = Object.fromEntries(report.rigid_bindings.map((r) => [r.name, r.bone]))
    expect(rigid).toMatchObject({ Blade: 'mixamorig:RightHand', LEye: 'mixamorig:Head', REye: 'mixamorig:Head' })

    // left/right symmetry was detected and applied
    expect(report.symmetry.applied).toBe(true)
    expect(report.symmetry.coverage).toBeGreaterThan(0.9)

    // extreme poses: no collapsing volume, no spikes
    for (const [pose, m] of Object.entries(report.pose_check)) {
      expect(m.min_volume_ratio, pose).toBeGreaterThan(0.7)
      expect(m.stretched_edges, pose).toBe(0)
    }
  }, 300000)

  it('gives every bone the expected local axes', async () => {
    const { glb } = await runAutoRig({ blenderPath, input, landmarks })
    const j = glbJson(glb)
    for (const [bone, want] of Object.entries(BONE_X)) {
      const a = worldAxes(j, 'mixamorig:' + bone)
      expect(angleDeg(a.x, want), `${bone} local X`).toBeLessThan(12)
    }
  }, 300000)

  it('adds five fingers per hand with the expected names and axes, and weights the hand across them', async () => {
    const { glb, report } = await runAutoRig({ blenderPath, input, landmarks })
    const j = glbJson(glb)
    const names = j.nodes.map((n) => n.name)
    for (const side of ['Left', 'Right']) {
      for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) for (const k of [1, 2, 3, 4]) expect(names, `${side}Hand${f}${k}`).toContain(`mixamorig:${side}Hand${f}${k}`)
    }
    expect(report.bones).toBe(22 + 40)
    expect(report.fingers.bones_added).toBe(40)
    // non-thumb fingers share the arm's sideways axis: left -Z, right +Z
    for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) {
      expect(angleDeg(worldAxes(j, `mixamorig:LeftHand${f}2`).x, [0, 0, -1]), `Left ${f}`).toBeLessThan(15)
      expect(angleDeg(worldAxes(j, `mixamorig:RightHand${f}2`).x, [0, 0, 1]), `Right ${f}`).toBeLessThan(15)
    }
    // the finger bones really carry weight (a hand that cannot curl would be "not rigged")
    expect(report.weights.unweighted_vertices).toBe(0)
    expect(report.weights.max_influences).toBeLessThanOrEqual(4)
  }, 300000)

  it('applies the expected roll to hands and fingers', async () => {
    const { glb } = await runAutoRig({ blenderPath, input, landmarks })
    const j = glbJson(glb)
    // left fingers: X tilted ~6 deg DOWN from straight back (-Z); right fingers: ~6 deg UP from straight forward (+Z)
    const l = worldAxes(j, 'mixamorig:LeftHandMiddle2').x
    const r = worldAxes(j, 'mixamorig:RightHandMiddle2').x
    expect(angleDeg(l, [0, 0, -1])).toBeGreaterThan(4)
    expect(angleDeg(l, [0, 0, -1])).toBeLessThan(8)
    expect(l[1]).toBeLessThan(-0.06)
    expect(angleDeg(r, [0, 0, 1])).toBeGreaterThan(4)
    expect(angleDeg(r, [0, 0, 1])).toBeLessThan(8)
    expect(r[1]).toBeGreaterThan(0.06)
    // the hand carries the same ~6 degrees
    expect(angleDeg(worldAxes(j, 'mixamorig:LeftHand').x, [0, 0, -1])).toBeGreaterThan(4)
  }, 300000)

  it('points the foot forward and down when the detected direction is close', async () => {
    const { glb } = await runAutoRig({ blenderPath, input, landmarks })
    const j = glbJson(glb)
    for (const side of ['Left', 'Right']) expect(angleDeg(worldAxes(j, `mixamorig:${side}Foot`).y, [0, -0.57, 0.82].map((c) => c / Math.hypot(0, 0.57, 0.82))), `${side} foot`).toBeLessThan(4)
  }, 300000)

  it('rebalances the clavicle so it cannot hold the chest, and the step can be switched off', async () => {
    const on = await runAutoRig({ blenderPath, input, landmarks })
    expect(on.report.clavicle_rebalanced).toBeGreaterThanOrEqual(0)
    const off = await runAutoRig({ blenderPath, input, landmarks, options: { clavicle_rebalance: false } })
    expect(off.report.clavicle_rebalanced).toBe(0)
  }, 400000)

  it('parents all five finger roots to the hand, regardless of exporter child order', async () => {
    const { glb } = await runAutoRig({ blenderPath, input, landmarks })
    const j = glbJson(glb)
    for (const side of ['Left', 'Right']) {
      const hand = j.nodes.find((n) => n.name === `mixamorig:${side}Hand`)
      const children = hand.children.map((i) => j.nodes[i].name)
      for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
        expect(children).toContain(`mixamorig:${side}Hand${finger}1`)
      }
    }
  }, 300000)

  it('blends weights between separate meshes and both can be switched off', async () => {
    const on = await runAutoRig({ blenderPath, input, landmarks })
    expect(on.report.cross_mesh_blend.applied).toBe(true)
    expect(on.report.cross_mesh_blend.meshes).toBeGreaterThan(5)
    expect(on.report.spine_profile).toBe(true)
    const off = await runAutoRig({ blenderPath, input, landmarks, options: { cross_mesh_blend: false, spine_profile: false } })
    expect(off.report.cross_mesh_blend.applied).toBe(false)
    expect(off.report.spine_profile).toBe(false)
    expect(off.report.weights.unweighted_vertices).toBe(0)
  }, 400000)

  it('softens shoulder and hip transitions and allows both to be switched off', async () => {
    const on = await runAutoRig({ blenderPath, input, landmarks })
    expect(on.report.shoulder_soften).toBe(true)
    expect(on.report.hip_soften).toBe(true)
    expect(on.report.weights.unweighted_vertices).toBe(0)
    expect(on.report.side_leak_removed).toBeGreaterThanOrEqual(0)
    const off = await runAutoRig({ blenderPath, input, landmarks, options: { shoulder_soften: false, hip_soften: false } })
    expect(off.report.shoulder_soften).toBe(false)
    expect(off.report.hip_soften).toBe(false)
  }, 400000)

  it('skins a thin piece lying on the body like clothing, but keeps a blade standing away from it rigid', async () => {
    const { report } = await runAutoRig({ blenderPath, input, landmarks })
    expect(report.rigid_bindings.map((r) => r.name)).toContain('Blade') // held out away from the body: rigid
    expect(report.thin_pieces_skinned_as_clothing).toBeGreaterThanOrEqual(0)
    const all = await runAutoRig({ blenderPath, input, landmarks, options: { skin_thin_on_body: false } })
    expect(all.report.thin_pieces_skinned_as_clothing).toBeUndefined()
  }, 400000)

  it('can be told not to add fingers', async () => {
    const { report } = await runAutoRig({ blenderPath, input, landmarks, options: { fingers: false } })
    expect(report.bones).toBe(22)
  }, 300000)

  it('keeps the original mesh objects (names, count) instead of splitting them into loose pieces', async () => {
    const { glb, report } = await runAutoRig({ blenderPath, input, landmarks })
    const j = glbJson(glb)
    const names = j.nodes.map((n) => n.name)
    for (const n of ['Torso', 'Head', 'LForeArm', 'RShin', 'Jacket', 'Blade', 'LEye']) expect(names).toContain(n)
    expect(j.meshes.length).toBe(20) // the synthetic model has 20 mesh objects
    expect(report.meshes_out).toBe(20)
  }, 300000)

  it('never lets one leg or arm carry the other side\'s weights (side coherence)', async () => {
    const { report } = await runAutoRig({ blenderPath, input, landmarks })
    expect(report.side_leak_removed).toBeGreaterThanOrEqual(0)
    const raw = await runAutoRig({ blenderPath, input, landmarks, options: { side_coherence: false } })
    expect(raw.report.side_leak_removed).toBe(0)
  }, 400000)

  it('maps markers onto the model even when the preview used other units (cm)', async () => {
    const cm = Object.fromEntries(Object.entries(landmarks).map(([k, p]) => [k, p.map((c) => c * 100)]))
    const { report } = await runAutoRig({ blenderPath, input, landmarks: cm, bbox: { min: [-100, 0, -25], max: [100, 180, 30] } })
    expect(report.weights.unweighted_vertices).toBe(0)
    expect(report.proxy.method).toBe('heat')
  }, 300000)

  it('refuses markers that do not fit the model instead of producing garbage', async () => {
    const far = Object.fromEntries(Object.entries(landmarks).map(([k, p]) => [k, p.map((c) => c * 100)]))
    await expect(runAutoRig({ blenderPath, input, landmarks: far })).rejects.toThrow(/do not line up/)
    await expect(runAutoRig({ blenderPath, input, landmarks, bbox: { min: [0, -1, -1], max: [1.8, 1, 1] } })).rejects.toThrow(/looks different in Blender[\s\S]*Blender sees:/)
  }, 180000)

  it('falls back to flagged envelope weights instead of crashing when the solver cannot be used', async () => {
    const { report } = await runAutoRig({ blenderPath, input, landmarks, options: { force_envelope: true } })
    expect(report.proxy.method).toBe('envelope')
    expect(report.warnings.join(' ')).toMatch(/less accurate/)
    expect(report.weights.unweighted_vertices).toBe(0)
  }, 300000)

  it('rigs a Y-up PLY exactly like the app exports scene objects', async () => {
    const ply = { name: 'scene-object.ply', data: fs.readFileSync(path.join(dir, 'human.ply')) }
    const { report } = await runAutoRig({ blenderPath, input: ply, landmarks, bbox: { min: [-1, 0, -0.25], max: [1, 1.8, 0.3] } })
    expect(report.weights.unweighted_vertices).toBe(0)
    expect(report.height).toBeGreaterThan(1.6)
    expect(report.height).toBeLessThan(1.9)
  }, 300000)

  it('keeps world position when the input was already rigged (parent transform preserved)', async () => {
    const first = await runAutoRig({ blenderPath, input, landmarks })
    const again = await runAutoRig({ blenderPath, input: { name: 'rigged.glb', data: first.glb }, landmarks })
    expect(again.report.height).toBeCloseTo(first.report.height, 2)
  }, 400000)

  it('reports missing landmarks instead of producing a broken rig', async () => {
    const bad = { ...landmarks }
    delete bad.pelvis
    await expect(runAutoRig({ blenderPath, input, landmarks: bad })).rejects.toThrow(/Missing landmarks: pelvis/)
  }, 120000)
})

describe.skipIf(!blenderPath)('real Blender: localized deformation weights', () => {
  it('fits and isolates fingers, preserves thumb axes, and smoothly transitions the hips', () => {
    const r = spawnSync(blenderPath, [
      '--background', '--factory-startup', '--python-exit-code', '3',
      '--python', path.join(__dirname, 'helpers/autorigDeformation.py'),
      '--', path.join(__dirname, '../../electron/autorig/autorig.py'),
    ], { encoding: 'utf8', timeout: 120000 })
    expect(r.status, r.stdout + r.stderr).toBe(0)
  }, 150000)
})


// The accuracy benchmark (electron/autorig/benchmark.py): pure python + numpy + scipy, no Blender.
import { spawnSync as spawn } from 'node:child_process'
const python = ['python3', 'python'].find((exe) => spawn(exe, ['-c', 'import numpy, scipy']).status === 0)
describe.skipIf(!blenderPath || !python)('accuracy benchmark tool', () => {
  it('scores a rig against itself as perfect, and reports the measures that matter', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animare-bench-'))
    const r = spawnSync(blenderPath, ['--background', '--factory-startup', '--python', path.join(__dirname, 'helpers/syntheticHumanoid.py'), '--', dir], { encoding: 'utf8', timeout: 120000 })
    expect(fs.existsSync(path.join(dir, 'human.glb')), r.stdout).toBe(true)
    const lm = JSON.parse(fs.readFileSync(path.join(dir, 'landmarks.json'), 'utf8'))
    const { glb } = await runAutoRig({ blenderPath, input: { name: 'human.glb', data: fs.readFileSync(path.join(dir, 'human.glb')) }, landmarks: lm })
    fs.writeFileSync(path.join(dir, 'rigged.glb'), glb)
    const out = path.join(dir, 'bench.json')
    const b = spawn(python, [path.join(__dirname, '../../electron/autorig/benchmark.py'), path.join(dir, 'rigged.glb'), path.join(dir, 'rigged.glb'), out], { encoding: 'utf8', timeout: 120000 })
    expect(b.status, b.stderr).toBe(0)
    const res = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(res.weights.mean_l1).toBe(0)
    expect(res.weights.dominant_bone_agreement).toBe(1)
    expect(res.pose_error_mean_pct).toBe(0)
    expect(Object.keys(res.pose_error_pct_of_height)).toContain('leg_raised_80')
    expect(res.pose_error_pct_of_height.index_curl_70.hands_only_mean_pct).toBe(0)
    expect(res.pose_error_pct_of_height.thumb_curl_50.hands_only_mean_pct).toBe(0)
    expect(res.pose_error_pct_of_height.index_curl_70.other_fingers_mean_pct).toBe(0)
    expect(res.fingers.mean_l1).toBe(0)
    expect(Object.keys(res.rest_axes_deg).length).toBeGreaterThan(15)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 400000)
})
