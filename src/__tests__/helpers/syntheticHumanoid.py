"""Builds a synthetic humanoid (no copyrighted assets) the way real models are often made:
separate overlapping parts, a thin blade, eyes, and an open jacket shell. Writes human.glb + landmarks.json.
Run:  blender --background --factory-startup --python syntheticHumanoid.py -- OUTDIR"""
import bpy, bmesh, json, math, sys, os
from mathutils import Vector

OUT = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)

def capsule(name, a, b, r, seg=24, rings=12):
    a, b = Vector(a), Vector(b)
    d = b - a
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, radius=1)
    o = bpy.context.active_object
    o.name = name
    # stretch a unit sphere into an ellipsoid along a->b
    L = d.length
    o.scale = (r, r, max(L / 2 + r * 0.6, r))
    bpy.ops.object.transform_apply(scale=True)
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    o.location = (a + b) / 2
    bpy.ops.object.transform_apply(location=True, rotation=True)
    return o

# Blender space (Z up, -Y forward). Height 1.8.
H = 1.8
LM = {  # glTF space = (x, z_up -> y, -y_blender -> z)
}
def g(x, y, z):  # blender xyz -> glTF xyz
    return [x, z, -y]

pts = {
    'pelvis': (0, 0, 0.95), 'spine': (0, 0, 1.10), 'chest': (0, 0, 1.25), 'upper_chest': (0, 0, 1.38),
    'neck': (0, 0, 1.52), 'head': (0, 0, 1.58), 'head_top': (0, 0, 1.80),
}
for side, sx in (('l', 1), ('r', -1)):
    pts[side + '_shoulder'] = (sx * 0.20, 0, 1.45)
    pts[side + '_elbow'] = (sx * 0.52, 0, 1.45)
    pts[side + '_wrist'] = (sx * 0.80, 0, 1.45)
    pts[side + '_fingertip'] = (sx * 0.98, 0, 1.45)
    pts[side + '_hip'] = (sx * 0.10, 0, 0.92)
    pts[side + '_knee'] = (sx * 0.10, 0, 0.50)
    pts[side + '_ankle'] = (sx * 0.10, 0, 0.08)
    pts[side + '_toe'] = (sx * 0.10, -0.12, 0.04)
    pts[side + '_toe_tip'] = (sx * 0.10, -0.22, 0.03)

parts = []
parts.append(capsule('Torso', (0, 0, 1.00), (0, 0, 1.42), 0.17))
parts[-1].scale.y = 0.65; bpy.context.view_layer.objects.active = parts[-1]; bpy.ops.object.transform_apply(scale=True)
parts.append(capsule('Pelvis', (0, 0, 0.92), (0, 0, 1.02), 0.17))
parts.append(capsule('Neck', (0, 0, 1.48), (0, 0, 1.58), 0.055))
parts.append(capsule('Head', (0, 0, 1.64), (0, 0, 1.72), 0.095))
for side, sx in (('L', 1), ('R', -1)):
    p = lambda k: pts[('l' if sx > 0 else 'r') + '_' + k]
    parts.append(capsule(side + 'UpperArm', (sx * 0.18, 0, 1.45), p('elbow'), 0.055))
    parts.append(capsule(side + 'ForeArm', p('elbow'), p('wrist'), 0.045))
    parts.append(capsule(side + 'Hand', p('wrist'), p('fingertip'), 0.038))
    parts.append(capsule(side + 'Thigh', p('hip'), p('knee'), 0.085))
    parts.append(capsule(side + 'Shin', p('knee'), p('ankle'), 0.060))
    parts.append(capsule(side + 'Foot', (sx * 0.10, 0.0, 0.05), (sx * 0.10, -0.20, 0.04), 0.045))
# eyes: small separate solids inside the head
for side, sx in (('L', 1), ('R', -1)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.014, location=(sx * 0.035, -0.085, 1.67), segments=12, ring_count=8)
    bpy.context.active_object.name = side + 'Eye'
# a thin blade held in the right hand (plane, no volume)
bpy.ops.mesh.primitive_plane_add(size=1, location=(-1.05, 0, 1.45))
blade = bpy.context.active_object; blade.name = 'Blade'
blade.scale = (0.25, 0.015, 1); bpy.ops.object.transform_apply(scale=True)
blade.rotation_euler = (0, 0, 0)
bpy.ops.object.transform_apply(rotation=True)
# open jacket shell around the torso (open at the neck and hem)
bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=0.19, depth=0.46, location=(0, 0, 1.19), end_fill_type='NOTHING')
jk = bpy.context.active_object; jk.name = 'Jacket'
jk.scale.y = 0.7; bpy.ops.object.transform_apply(scale=True)

with_mats = bpy.data.materials.new('skin')
for o in bpy.context.scene.objects:
    if o.type == 'MESH':
        o.data.materials.append(with_mats)
        bpy.ops.object.shade_smooth() if False else None

bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'human.glb'), export_format='GLB', use_selection=True)
bpy.ops.wm.ply_export(filepath=os.path.join(OUT, 'human.ply'), forward_axis='NEGATIVE_Z', up_axis='Y', export_selected_objects=False)
json.dump({k: g(*v) for k, v in pts.items()}, open(os.path.join(OUT, 'landmarks.json'), 'w'))
