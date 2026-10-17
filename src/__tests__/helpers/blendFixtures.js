import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Shared by the tests that run the REAL Blender: finding it, and building genuine .blend
// files with it. If no Blender (2.80+) is installed those tests are skipped, not failed.
const require = createRequire(import.meta.url)
export const blenderModule = require('../../../electron/blender.cjs')
const { findBlender, isVersionSupported } = blenderModule

const found = findBlender()
export let blenderPath = null
let supported = false
if (found) {
  const r = spawnSync(found.path, ['--version'], { encoding: 'utf8', timeout: 30000 })
  const m = /Blender\s+(\d+)\.(\d+)/.exec(r.stdout || '')
  supported = !!m && isVersionSupported({ major: +m[1], minor: +m[2] })
  if (supported) blenderPath = found.path
}

// Built by Blender itself, so these are genuine .blend files.
export const MAKE_FILES = String.raw`
import bpy, math, os, zlib, struct
OUT = os.environ['ANIMARE_OUT'] + '/'
os.makedirs(OUT + 'textures', exist_ok=True)

def png(w, h):
    rows = b''.join(b'\x00' + bytes(sum(([255,0,0] if (x+y)%2==0 else [0,0,255] for x in range(w)), [])) for y in range(h))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')
open(OUT + 'textures/checker.png', 'wb').write(png(8, 8))

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

# crate: subdivision modifier, external texture by relative path, a hidden helper object
reset()
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1)); cube = bpy.context.active_object; cube.name = 'Crate'
cube.modifiers.new('Sub', 'SUBSURF').levels = 1
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.3, location=(3, 0, 0)); bpy.context.active_object.name = 'HiddenHelper'
bpy.context.active_object.hide_viewport = True
mat = bpy.data.materials.new('CrateMat'); mat.use_nodes = True
tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
tex.image = bpy.data.images.load(OUT + 'textures/checker.png'); tex.image.filepath = '//textures/checker.png'
mat.node_tree.links.new(tex.outputs['Color'], mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
cube.data.materials.append(mat)
bpy.ops.wm.save_as_mainfile(filepath=OUT + 'crate.blend', relative_remap=False)

# rig: two bones, a skinned mesh, a keyframed action
reset()
bpy.ops.object.armature_add(location=(0, 0, 0)); arm = bpy.context.active_object; arm.name = 'Rig'
bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones; b1 = eb[0]; b1.name = 'Root'; b1.head = (0, 0, 0); b1.tail = (0, 0, 1)
b2 = eb.new('Arm'); b2.head = (0, 0, 1); b2.tail = (0, 0, 2); b2.parent = b1
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=2, location=(0, 0, 1)); body = bpy.context.active_object; body.name = 'Body'
body.parent = arm
g1 = body.vertex_groups.new(name='Root'); g2 = body.vertex_groups.new(name='Arm')
for v in body.data.vertices: (g2 if v.co.z > 0 else g1).add([v.index], 1.0, 'REPLACE')
body.modifiers.new('Armature', 'ARMATURE').object = arm
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='POSE')
pb = arm.pose.bones['Arm']; pb.rotation_mode = 'XYZ'
for f, r in ((1, 0), (20, math.radians(60)), (40, 0)):
    pb.rotation_euler = (r, 0, 0); pb.keyframe_insert('rotation_euler', frame=f)
bpy.ops.object.mode_set(mode='OBJECT')
arm.animation_data.action.name = 'Wave'
bpy.ops.wm.save_as_mainfile(filepath=OUT + 'rig.blend')

# shape keys
reset()
bpy.ops.mesh.primitive_cube_add(size=2); sk = bpy.context.active_object; sk.name = 'Face'
sk.modifiers.new('Sub', 'SUBSURF')
sk.shape_key_add(name='Basis'); k = sk.shape_key_add(name='Smile')
for v in k.data: v.co.z *= 1.5
bpy.ops.wm.save_as_mainfile(filepath=OUT + 'shapekeys.blend')

# hostile: Python that runs on load if (and only if) auto-run is enabled
reset()
bpy.ops.mesh.primitive_cube_add(size=1)
t = bpy.data.texts.new('evil.py'); t.write("import bpy\nopen(r'" + OUT + "PWNED_TEXT','w').write('x')\n"); t.use_module = True
bpy.ops.wm.save_as_mainfile(filepath=OUT + 'evil.blend')

# legacy shaders: older files and many Cycles scenes build materials from Diffuse / Glossy /
# Emission / Mix nodes, which Blender's glTF exporter can't read (it exports plain white).
# The textures were saved with paths from the artist's machine, which never exist here.
reset()
def make_mat(name, build):
    m = bpy.data.materials.new(name); m.use_nodes = True
    for n in list(m.node_tree.nodes): m.node_tree.nodes.remove(n)
    out = m.node_tree.nodes.new('ShaderNodeOutputMaterial')
    build(m.node_tree, out)
    return m
def diffuse(nt, color):
    d = nt.nodes.new('ShaderNodeBsdfDiffuse'); d.inputs['Color'].default_value = color; return d
def textured(path):
    def build(nt, out):
        d = diffuse(nt, (0.8, 0.8, 0.8, 1))
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = bpy.data.images.load(OUT + 'textures/checker.png', check_existing=False)
        t.image.filepath = path
        nt.links.new(t.outputs['Color'], d.inputs['Color']); nt.links.new(d.outputs['BSDF'], out.inputs['Surface'])
    return build
def b_diffuse(nt, out):
    nt.links.new(diffuse(nt, (0.8, 0.1, 0.1, 1)).outputs['BSDF'], out.inputs['Surface'])
def b_glossy(nt, out):
    g = nt.nodes.new('ShaderNodeBsdfGlossy'); g.inputs['Color'].default_value = (0.2, 0.4, 0.9, 1)
    nt.links.new(g.outputs['BSDF'], out.inputs['Surface'])
def b_emission(nt, out):
    e = nt.nodes.new('ShaderNodeEmission'); e.inputs['Color'].default_value = (1.0, 0.5, 0.0, 1)
    nt.links.new(e.outputs['Emission'], out.inputs['Surface'])
def b_mix(nt, out):
    mix = nt.nodes.new('ShaderNodeMixShader'); tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    nt.links.new(tr.outputs['BSDF'], mix.inputs[1]); nt.links.new(diffuse(nt, (0.1, 0.6, 0.1, 1)).outputs['BSDF'], mix.inputs[2])
    nt.links.new(mix.outputs['Shader'], out.inputs['Surface'])
specs = [
    ('DiffuseRed', b_diffuse), ('GlossyBlue', b_glossy), ('EmissionOrange', b_emission), ('MixGreen', b_mix),
    ('TexMac', textured('//../../../Unity/Assets/Textures/CHECKER.png')),
    ('TexWin', textured('C:\\Users\\me\\Desktop\\art\\checker.png')),
]
for i, (name, build) in enumerate(specs):
    bpy.ops.mesh.primitive_plane_add(size=1, location=(i * 1.5, 0, 0))
    o = bpy.context.active_object; o.name = 'Plane_' + name
    o.data.materials.append(make_mat(name, build))
bpy.ops.wm.save_as_mainfile(filepath=OUT + 'legacy.blend', relative_remap=False)

# nothing exportable
reset()
bpy.ops.object.light_add(type='POINT')
bpy.ops.wm.save_as_mainfile(filepath=OUT + 'empty.blend')
`


// Builds crate/rig/shapekeys/evil/empty .blend files (+ textures/checker.png) into `dir`.
export function buildBlendFixtures(dir) {
  const script = path.join(dir, 'make.py')
  fs.writeFileSync(script, MAKE_FILES)
  const r = spawnSync(blenderPath, ['-b', '--factory-startup', '--python', script], { env: { ...process.env, ANIMARE_OUT: dir }, encoding: 'utf8', timeout: 120000 })
  if (!fs.existsSync(path.join(dir, 'empty.blend'))) throw new Error('could not build test .blend files:\n' + r.stdout + r.stderr)
}
