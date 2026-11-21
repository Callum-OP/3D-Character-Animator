"""
Auto Rigger pipeline. Runs INSIDE the user's own Blender, headless:

  blender --background --factory-startup --disable-autoexec --python autorig.py -- job.json

job.json: { "input": "mesh.glb|obj|ply|fbx", "output": "rigged.glb", "report": "report.json",
            "landmarks": { id: [x, y, z], ... },   (metres, Y up, character faces +Z, character's LEFT is +X)
            "options":   { ... } }

Stages (accuracy first, every stage reports numbers instead of "looks fine"):
  1. import + apply transforms + weld-aware connected components
  2. classify components: body-like (skinned), rigid (thin shells, blades, small solids such as eyes)
  3. template skeleton fitted to the landmarks
  4. watertight voxel proxy of the body-like components -> Blender bone-heat weights on the proxy
     (retried at coarser voxel sizes if the solver fails)
  5. transfer proxy weights to every real vertex (nearest surface point, barycentric)
  6. clean up: weld-consistent and joint-local smoothing, head lock, mirror symmetry, 4 influences, normalise
  7. rigid components bound 100% to the nearest bone
  8. self-check: posed volume / stretch tests, written to the report
  9. export GLB
"""
import bpy, bmesh, json, math, sys, os
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

# ----------------------------------------------------------------------------------------------
# Template: (bone, parent, head landmark/expression, tail landmark/expression)
# ----------------------------------------------------------------------------------------------
CENTER_BONES = [
    ('Hips', None, 'pelvis', 'spine'),
    ('Spine', 'Hips', 'spine', 'chest'),
    ('Spine1', 'Spine', 'chest', 'upper_chest'),
    ('Spine2', 'Spine1', 'upper_chest', 'neck'),
    ('Neck', 'Spine2', 'neck', 'head'),
    ('Head', 'Neck', 'head', 'head_top'),
]


# Bone local axes (the "roll") in glTF world space
# (Y up, +Z forward, +X = character left). Y always runs along the bone; this is the local X axis.
# Clips and poses rotate bones about these axes, so a rig that has the right
# bone names but a different roll twists and bends the wrong way (stretched arms, folded legs).
BONE_X = {
    'Hips': (1, 0, 0), 'Spine': (1, 0, 0), 'Spine1': (1, 0, 0), 'Spine2': (1, 0, 0), 'Neck': (1, 0, 0), 'Head': (1, 0, 0),
    'LeftShoulder': (0, 0, -1), 'LeftArm': (0, 0, -1), 'LeftForeArm': (0, 0, -1), 'LeftHand': (0, 0, -1),
    'RightShoulder': (0, 0, 1), 'RightArm': (0, 0, 1), 'RightForeArm': (0, 0, 1), 'RightHand': (0, 0, 1),
    'LeftUpLeg': (-1, 0, 0), 'LeftLeg': (-1, 0, 0), 'LeftFoot': (-1, 0, 0), 'LeftToeBase': (-1, 0, 0),
    'RightUpLeg': (-1, 0, 0), 'RightLeg': (-1, 0, 0), 'RightFoot': (-1, 0, 0), 'RightToeBase': (-1, 0, 0),
}


# Roll offsets in degrees about each bone's own Y axis (left negative, right positive).
ROLL_OFFSET = {'Shoulder': 2.6, 'Arm': 2.4, 'ForeArm': 2.5, 'Hand': 6.2, 'Foot': 3.0, 'ToeBase': -2.5}
FINGER_ROLL = 6.0
# Canonical bone directions (glTF world, Y up, +Z forward) for the bones whose direction a clip is most
# sensitive to. A clip that sets absolute rotations (a pose, frame 0 of a mocap) is amplified along the whole limb by
# a rest-direction mismatch, so when the detected direction is already close (< 20 deg) it is snapped to these.
# (Not the clavicle: snapping it measurably worsened the shoulder deformation, because the bone must stay on the
# anatomy it pivots about.)
CANON_DIR = {
    'LeftFoot': (0.0, -0.57, 0.82), 'RightFoot': (0.0, -0.57, 0.82),
    'LeftToeBase': (0.0, 0.0, 1.0), 'RightToeBase': (0.0, 0.0, 1.0),
}
SNAP_MAX_DEG = 20.0
ROLL_SIGN = 1.0  # sign convention between "about the bone's own Y" and Blender's roll


def roll_offset_for(side, part):
    v = ROLL_OFFSET.get(part)
    if v is None:
        return 0.0
    return math.radians(ROLL_SIGN * (-v if side == 'Left' else v))


def side_bones(S):
    s = S  # 'Left' / 'Right'
    k = 'l' if S == 'Left' else 'r'
    return [
        (s + 'Shoulder', 'Spine2', k + '_clavicle', k + '_shoulder'),
        (s + 'Arm', s + 'Shoulder', k + '_shoulder', k + '_elbow'),
        (s + 'ForeArm', s + 'Arm', k + '_elbow', k + '_wrist'),
        (s + 'Hand', s + 'ForeArm', k + '_wrist', k + '_fingertip'),
        (s + 'UpLeg', 'Hips', k + '_hip', k + '_knee'),
        (s + 'Leg', s + 'UpLeg', k + '_knee', k + '_ankle'),
        (s + 'Foot', s + 'Leg', k + '_ankle', k + '_toe'),
        (s + 'ToeBase', s + 'Foot', k + '_toe', k + '_toe_tip'),
    ]


REQUIRED = ['pelvis', 'spine', 'chest', 'upper_chest', 'neck', 'head', 'head_top'] + [
    k + '_' + n for k in ('l', 'r') for n in ('shoulder', 'elbow', 'wrist', 'fingertip', 'hip', 'knee', 'ankle', 'toe', 'toe_tip')
]

DEFAULTS = {
    'proxy_voxels': 150,        # voxels along the character's height (retries go coarser)
    'smooth_iterations': 2,
    'smooth_strength': 0.5,
    'max_influences': 4,
    'prune_below': 0.01,
    'mirror': 'auto',           # 'auto' | 'on' | 'off'
    'mirror_tolerance': 0.012,  # fraction of height; partner must be this close to count
    'rigid_thin_fraction': 0.03,   # PCA thickness below this fraction of height -> rigid
    'rigid_small_fraction': 0.07,  # whole component smaller than this (diagonal) -> rigid
    'head_lock': True,
    'fingers': True,            # five fingers per hand
    'clavicle_rebalance': True, # the clavicle cannot hold the chest
    'spine_profile': True,      # height blend between the spine bones
    'skin_thin_on_body': True,  # thin pieces lying on the body are clothing, not rigid accessories
    'thin_on_body_frac': 0.02,  # mean distance to the body, fraction of the height
    'cross_mesh_blend': True,   # weights agree where different meshes (sleeve / torso / jacket layers) meet
    'blend_radius': 0.0035,     # spatial grid cell as a fraction of height
    'blend_strength': 1.0,
    'final_blend_strength': 0.7,
    'shoulder_soften': True,    # longer, smoother shoulder-to-arm transition
    'shoulder_radius': 0.012,   # blend neighbourhood (fraction of the height) around the shoulders
    'shoulder_reach': 0.09,     # how far from the shoulder joint it applies
    'shoulder_strength': 0.9,
    'hip_soften': True,         # smooth neighbouring body and clothing weights around the hip joints
    'hip_rebalance': True,      # keep the upper pelvis from following the thighs
    'crotch_profile': True,     # one smooth left/right thigh handover across the crotch, same for every layer
    'crotch_width': 0.0064,     # length of the far-thigh tail of that handover, fraction of the height
    'limb_cap': True,           # limb bones cannot claim the body next to them
    'cap_lo': 1.7,
    'cap_hi': 2.7,
    'side_coherence': True,     # stop the voxel proxy leaking weights between left and right limbs
    'layer_blend': True,        # stacked layers (skin / shirt / jacket) share weights so the inner one cannot poke through
    'layer_cell': 0.012,        # layer thickness it bridges, fraction of the height
    'layer_strength': 0.9,
    'hand_isolate': True,       # no arm weight past the wrist (thumb / fingertip tearing)
    'run_self_check': True,
    'force_envelope': False,    # skip the heat solver (tests / emergency)
}


import time, traceback

_T0 = time.time()
TIMINGS = {}
_stage = {'name': None, 't': _T0}


def log(*a):
    print('[autorig]', *a, flush=True)


def progress(frac, label):
    """Machine-readable line the desktop app turns into a progress bar and an ETA."""
    now = time.time()
    if _stage['name']:
        TIMINGS[_stage['name']] = round(TIMINGS.get(_stage['name'], 0) + now - _stage['t'], 3)
    _stage['name'], _stage['t'] = label, now
    print('[autorig-progress] %.3f %s' % (frac, label), flush=True)


def fail(msg, code='failed'):
    log('FAILED:', msg)
    raise SystemExit('AUTORIG_ERROR:%s:%s' % (code, msg))


# ----------------------------------------------------------------------------------------------
# 1. import
# ----------------------------------------------------------------------------------------------
def import_mesh(path):
    ext = os.path.splitext(path)[1].lower()
    before = set(bpy.data.objects)
    if ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == '.obj':
        if hasattr(bpy.ops.wm, 'obj_import'):
            bpy.ops.wm.obj_import(filepath=path)
        else:
            bpy.ops.import_scene.obj(filepath=path)
    elif ext == '.ply':
        # PLY files from the app are Y-up / +Z-forward (like glTF); Blender must convert them like it does for OBJ
        if hasattr(bpy.ops.wm, 'ply_import'):
            bpy.ops.wm.ply_import(filepath=path, forward_axis='NEGATIVE_Z', up_axis='Y')
        else:
            bpy.ops.import_mesh.ply(filepath=path)
            for o in bpy.context.selected_objects:
                o.rotation_euler = (math.radians(90), 0, 0)
    else:
        fail('Unsupported input format ' + ext, 'format')
    new = [o for o in bpy.data.objects if o not in before]
    # importers add helper meshes used only to DRAW bones (custom bone shapes, e.g. a radius-1 icosphere)
    shapes = set()
    for o in new:
        if o.type == 'ARMATURE':
            shapes.update(pb.custom_shape for pb in o.pose.bones if pb.custom_shape)
    for o in list(new):
        if o.type == 'MESH' and any(c.name.lower().startswith(('gltf_not_exported', 'bone_shape', 'wgt')) for c in o.users_collection):
            shapes.add(o)
    for o in list(new):
        if o in shapes:
            bpy.data.objects.remove(o, do_unlink=True)
            new.remove(o)
    meshes = [o for o in new if o.type == 'MESH']
    if not meshes:
        fail('The file has no meshes', 'empty')
    # a model that is already rigged: drop the old rig so the new one is the only one
    for o in new:
        if o.type == 'ARMATURE':
            for m in meshes:
                for mod in [x for x in m.modifiers if x.type == 'ARMATURE']:
                    m.modifiers.remove(mod)
                m.vertex_groups.clear()
    bpy.context.view_layer.update()
    for m in meshes:  # keep where the mesh really is (a parent armature may carry scale / offset)
        mw = m.matrix_world.copy()
        m.parent = None
        m.matrix_world = mw
    for o in new:
        if o.type != 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.object.select_all(action='DESELECT')
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.make_single_user(object=True, obdata=True)  # shared mesh data would block applying transforms
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for m in meshes:  # shape keys would block modifier-free export of applied data; keep basis only
        if m.data.shape_keys:
            m.shape_key_clear()
    return meshes


def world_vertices(obj):
    n = len(obj.data.vertices)
    co = np.empty(n * 3, dtype=np.float64)
    obj.data.vertices.foreach_get('co', co)
    return co.reshape(n, 3)


ORIGIN = {}  # piece object name -> name of the original mesh object it was split from


def split_components(meshes, weld):
    """Weld-aware loose parts: UV-seam duplicates do not split a part. Each loose part becomes its own object."""
    out = []
    for obj in meshes:
        origin_name = obj.name
        before = set(bpy.data.objects)
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        # Weld a copy's duplicates only for the separation test: do it for real, but the weld is
        # position-exact so nothing visible changes; UV seams stay because UVs live on loops.
        bpy.ops.mesh.remove_doubles(threshold=weld, use_unselected=False)
        bpy.ops.mesh.separate(type='LOOSE')
        bpy.ops.object.mode_set(mode='OBJECT')
        ORIGIN[obj.name] = origin_name
        for o in bpy.data.objects:
            if o not in before and o.type == 'MESH':
                ORIGIN[o.name] = origin_name
    for o in bpy.context.scene.objects:
        if o.type == 'MESH':
            out.append(o)
    return out


def rejoin_pieces(arm):
    """Put the loose pieces back into the mesh objects they came from, so the rigged file keeps the
    original mesh structure, names and material slots (the app keeps per-mesh settings by mesh)."""
    groups = {}
    for o in list(bpy.context.scene.objects):
        if o.type == 'MESH' and o.name in ORIGIN:
            groups.setdefault(ORIGIN[o.name], []).append(o)
    kept = []
    for origin, pieces in groups.items():
        pieces.sort(key=lambda o: o.name)
        bpy.ops.object.select_all(action='DESELECT')
        for o in pieces:
            o.select_set(True)
        bpy.context.view_layer.objects.active = pieces[0]
        if len(pieces) > 1:
            bpy.ops.object.join()
        merged = bpy.context.view_layer.objects.active
        merged.name = origin
        merged.data.name = origin
        merged.parent = arm
        merged.matrix_parent_inverse = arm.matrix_world.inverted()
        kept.append(merged)
    return kept


# ----------------------------------------------------------------------------------------------
# 2. classify
# ----------------------------------------------------------------------------------------------
def pca_thickness(co):
    c = co - co.mean(axis=0)
    if len(c) < 4:
        return 0.0
    w, v = np.linalg.eigh(np.cov(c.T))
    proj = c @ v[:, 0]  # smallest principal axis
    return float(proj.max() - proj.min())


def is_closed(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    open_edges = sum(1 for e in bm.edges if not e.is_manifold and e.is_boundary)
    bm.free()
    return open_edges == 0


def classify(objs, height, opt):
    info = []
    for o in objs:
        co = world_vertices(o)
        ext = co.max(axis=0) - co.min(axis=0)
        diag = float(np.linalg.norm(ext))
        thick = pca_thickness(co)
        reason = None
        if diag < opt['rigid_small_fraction'] * height:
            reason = 'small solid (eye / button / jewellery)'
        elif thick < opt['rigid_thin_fraction'] * height:
            reason = 'thin shell (blade / plane / accessory)'
        info.append({'obj': o, 'verts': len(co), 'thickness': thick, 'diag': diag, 'rigid': reason is not None, 'reason': reason})
    # many tiny pieces holding a big share of the mesh are fragments of the body / clothing, not accessories
    total = sum(i['verts'] for i in info) or 1
    small = [i for i in info if i['rigid'] and i['reason'].startswith('small')]
    if small and sum(i['verts'] for i in small) > 0.25 * total:
        for i in small:
            i['rigid'], i['reason'] = False, None
        info[0]['fragments_note'] = True
    # if everything came out rigid the mesh is probably one thin-skinned model: treat the biggest as body
    if all(i['rigid'] for i in info):
        big = max(info, key=lambda i: i['verts'])
        big['rigid'], big['reason'] = False, None
    return info


# ----------------------------------------------------------------------------------------------
# 3. skeleton
# ----------------------------------------------------------------------------------------------
def blender_bbox_as_gltf(co):
    """Blender (Z up, -Y forward) bounding box expressed in glTF axes (Y up, +Z forward)."""
    mn, mx = co.min(axis=0), co.max(axis=0)
    return {'min': [mn[0], mn[2], -mx[1]], 'max': [mx[0], mx[2], -mn[1]]}


def map_landmarks(raw, three_box, mesh_box, detail='', strict=True):
    """The preview (three.js) and Blender can disagree about units, origin and scale (FBX centimetres,
    parent transforms...). Landmarks are re-expressed relative to the model's own bounding box: ONE uniform
    scale from the heights, feet on the floor, and centred in X/Z. Uniform means a slightly different box
    (an extra wide prop in one of them) can never squash the proportions of the markers. The two boxes must
    still have a similar shape, or the job is refused."""
    if not three_box:
        return raw
    tmin, tmax = three_box['min'], three_box['max']
    bmin, bmax = mesh_box['min'], mesh_box['max']
    et = [tmax[i] - tmin[i] for i in range(3)]
    eb = [bmax[i] - bmin[i] for i in range(3)]
    if et[1] <= 0 or eb[1] <= 0:
        fail('The model has no height', 'frame')
    s = eb[1] / et[1]
    for i, name in ((0, 'width'), (2, 'depth')):
        if not strict:
            # the app sends plain baked geometry made from the preview's own mesh, so there is nothing to
            # disagree about: scale, origin and units are reconciled by the uniform mapping below
            break
        # thin axes are noisy: only compare axes that are a meaningful fraction of the height
        if et[i] > 0.15 * et[1] and not (0.7 <= (eb[i] / et[i]) / s <= 1.43):
            fail('The model looks different in Blender than in the preview (%s differs: preview %.3g, Blender %.3g, '
                 'relative to height). It is probably rotated or scaled differently in the file. Try exporting it as .glb first.%s'
                 % (name, et[i] / et[1], eb[i] / eb[1], detail), 'frame')
    tc = [(tmin[i] + tmax[i]) / 2 for i in range(3)]
    bc = [(bmin[i] + bmax[i]) / 2 for i in range(3)]
    out = {}
    for k, p in raw.items():
        out[k] = [
            bc[0] + (p[0] - tc[0]) * s,
            bmin[1] + (p[1] - tmin[1]) * s,
            bc[2] + (p[2] - tc[2]) * s,
        ]
    return out


def check_landmarks_fit(L, mesh_co, height):
    """Refuse (clearly) when the skeleton cannot possibly belong to this mesh, instead of making garbage."""
    mn, mx = mesh_co.min(axis=0), mesh_co.max(axis=0)
    pad = 0.12 * height
    p = L['pelvis']
    if not all(mn[i] - pad <= p[i] <= mx[i] + pad for i in range(3)):
        fail('The pelvis marker is not inside the model. The markers and the model do not line up.', 'markers')
    span = L['head_top'].z - min(L['l_toe'].z, L['r_toe'].z, L['l_ankle'].z, L['r_ankle'].z)
    if not (0.7 * height <= span <= 1.3 * height):
        fail('The markers are %d%% of the model height from toes to head. They should roughly cover the whole model.' % round(100 * span / height), 'markers')


def fit_landmarks(raw):
    L = {}
    for k in REQUIRED:
        if k in raw:
            x, y, z = raw[k]
            L[k] = Vector((x, -z, y))  # glTF (Y up, +Z forward) -> Blender (Z up, -Y forward)
    # mirror any missing side from the other (X mirrored about the pelvis plane)
    cx = L['pelvis'].x if 'pelvis' in L else 0.0
    for k in REQUIRED:
        if k in L:
            continue
        if k.startswith('r_') and ('l_' + k[2:]) in L:
            p = L['l_' + k[2:]]
            L[k] = Vector((2 * cx - p.x, p.y, p.z))
        elif k.startswith('l_') and ('r_' + k[2:]) in L:
            p = L['r_' + k[2:]]
            L[k] = Vector((2 * cx - p.x, p.y, p.z))
    missing = [k for k in REQUIRED if k not in L]
    if missing:
        fail('Missing landmarks: ' + ', '.join(missing), 'landmarks')
    # The clavicle starts a third of the way from the neck base to the shoulder joint.
    # (Starting it at the chest centre makes the bone run through the chest and claim it.)
    for k in ('l', 'r'):
        L[k + '_clavicle'] = L['neck'] + (L[k + '_shoulder'] - L['neck']) * 0.33
    return L


def build_armature(L):
    arm_data = bpy.data.armatures.new('Armature')
    arm = bpy.data.objects.new('Armature', arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    spec = list(CENTER_BONES) + side_bones('Left') + side_bones('Right')
    made = {}
    for name, parent, h, t in spec:
        b = arm_data.edit_bones.new(name)
        b.head, b.tail = L[h].copy(), L[t].copy()
        if (b.tail - b.head).length < 1e-5:
            b.tail = b.head + Vector((0, 0, 0.01))
        if name in CANON_DIR:
            cd = CANON_DIR[name]
            want_dir = Vector((cd[0], -cd[2], cd[1])).normalized()  # glTF -> Blender
            cur = (b.tail - b.head)
            if cur.length > 1e-6 and math.degrees(cur.normalized().angle(want_dir)) < SNAP_MAX_DEG:
                b.tail = b.head + want_dir * cur.length
        # Project the desired X axis so it stays perpendicular to the bone.
        gx = BONE_X[name]
        want_x = Vector((gx[0], -gx[2], gx[1]))  # glTF -> Blender axes
        y = (b.tail - b.head).normalized()
        x = want_x - y * want_x.dot(y)
        if x.length > 1e-4:
            x.normalize()
            b.align_roll(x.cross(y))  # Blender aligns the bone's Z axis; Z = X cross Y
            for sd in ('Left', 'Right'):
                if name.startswith(sd):
                    b.roll += roll_offset_for(sd, name[len(sd):])
        made[name] = b
    for name, parent, h, t in spec:
        if parent:
            made[name].parent = made[parent]
            # chain bones connect when the child starts where the parent ends
            if (made[name].head - made[parent].tail).length < 1e-4:
                made[name].use_connect = True
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm


# ----------------------------------------------------------------------------------------------
# fingers
# ----------------------------------------------------------------------------------------------
FINGERS = ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky')
# Prefer the middle finger when building the hand; exporters may reorder siblings, so the BVH retargeter
# chooses the middle branch by name rather than relying on this order.
FINGER_BUILD_ORDER = ('Middle', 'Index', 'Ring', 'Pinky', 'Thumb')
# joint 1..4 of each finger in HAND coordinates: (u along the hand, s sideways [thumb negative], w up), all
# divided by L = wrist -> middle fingertip distance. Joint 4 is the fingertip.
FINGER_TEMPLATE = {
    'Thumb': [(0.23, -0.12, -0.03), (0.42, -0.21, -0.05), (0.53, -0.33, -0.06), (0.60, -0.44, -0.07)],
    'Index': [(0.57, -0.12, -0.03), (0.72, -0.11, -0.02), (0.85, -0.11, -0.02), (0.97, -0.10, -0.02)],
    'Middle': [(0.57, -0.02, -0.02), (0.73, -0.02, -0.02), (0.87, -0.01, -0.01), (1.00, 0.00, 0.00)],
    'Ring': [(0.56, 0.07, -0.03), (0.70, 0.08, -0.03), (0.84, 0.09, -0.02), (0.95, 0.10, -0.01)],
    'Pinky': [(0.54, 0.17, -0.06), (0.66, 0.17, -0.05), (0.76, 0.17, -0.05), (0.85, 0.18, -0.05)],
}


def hand_frame(wrist, tip, side):
    """a = along the hand, ex = sideways axis (backward for the left hand, forward for the right),
    up = a x ex. Blender space (Z up, -Y forward)."""
    a = tip - wrist
    L = a.length
    a.normalize()
    ex = Vector((0, 1, 0)) if side == 'Left' else Vector((0, -1, 0))
    ex = ex - a * ex.dot(a)
    if ex.length < 1e-4:
        ex = Vector((0, 0, 1)) - a * a.z
    ex.normalize()
    return a, ex, a.cross(ex), L


def finger_layout(wrist, tip, side, pts):
    """Finger joint positions for one hand: the template, stretched/shifted to the real palm width and
    finger-zone height measured from the mesh vertices near the hand. -> {finger: [4 Vectors]}"""
    a, ex, up, L = hand_frame(wrist, tip, side)
    sg = 1.0 if side == 'Left' else -1.0
    scale, shift, wshift = 1.0, 0.0, 0.0
    thumb_scale, thumb_shift = 1.0, 0.0
    if len(pts):
        rel = np.asarray(pts) - np.array(wrist[:])
        u = rel @ np.array(a[:]) / L
        sm = (rel @ np.array(ex[:])) * sg / L
        wm = rel @ np.array(up[:]) / L
        zone = (u > 0.68) & (u < 1.02) & (np.abs(wm) < 0.3) & (np.abs(sm) < 0.6)  # finger area only: the thumb tip (u~0.6) would stretch it
        if zone.sum() >= 60:
            p5, p95 = np.percentile(sm[zone], [5, 95])
            scale = float(np.clip((p95 - p5) / 0.34, 0.6, 1.6))
            shift = float((p5 + p95) / 2 - 0.025 * scale)
            # The thumb is outside this sampling zone; keep its separate, more conservative fit.
            thumb_scale = float(np.clip((p95 - p5) / 0.43, 0.6, 1.6))
            thumb_shift = float((p5 + p95) / 2 - 0.025 * thumb_scale)
            wshift = float(np.clip(np.median(wm[zone]) + 0.02, -0.08, 0.08))
    out = {}
    for f, joints in FINGER_TEMPLATE.items():
        fs, offset = (thumb_scale, thumb_shift) if f == 'Thumb' else (scale, shift)
        out[f] = [wrist + (a * u_ + ex * ((s_ * fs + offset) * sg) + up * (w_ + wshift)) * L for (u_, s_, w_) in joints]
    return out, (a, ex, up, L)


def add_fingers(arm, L, body_objs, report):
    """Adds finger bones (1-3 deform, 4 is the tip) to both hands. -> layout per side"""
    cos = np.concatenate([world_vertices(o) for o in body_objs])
    layouts = {}
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    for side, k in (('Left', 'l'), ('Right', 'r')):
        wrist, tip = L[k + '_wrist'].copy(), L[k + '_fingertip'].copy()
        a0 = tip - wrist
        d = np.linalg.norm(cos - np.array(wrist[:]), axis=1)
        near = cos[(d < 1.4 * a0.length) & (((cos - np.array(wrist[:])) @ np.array(a0.normalized()[:])) > -0.1 * a0.length)]
        layout, (a, ex, up, hl) = finger_layout(wrist, tip, side, near)
        layouts[side] = {'joints': layout, 'frame': (a, ex, up, hl), 'wrist': np.array(wrist[:])}
        hand = eb['%sHand' % side]
        for f in FINGER_BUILD_ORDER:
            J = layout[f]
            parent = hand
            for kk in range(4):
                b = eb.new('%sHand%s%d' % (side, f, kk + 1))
                b.head = J[kk].copy()
                seg = (J[kk + 1] - J[kk]).length if kk < 3 else (J[3] - J[2]).length * 0.35
                if f == 'Thumb':
                    # The thumb rotations use a shared axis even though the joint positions curve.
                    sg = 1.0 if side == 'Left' else -1.0
                    d = (a * 0.75 + ex * (-0.65 * sg) + up * (-0.05)).normalized()
                    b.tail = J[kk] + d * seg
                elif kk < 3:
                    b.tail = J[kk + 1].copy()
                else:
                    b.tail = J[3] + (J[3] - J[2]).normalized() * (J[3] - J[2]).length * 0.35
                y = (b.tail - b.head).normalized()
                # roll: fingers share the hand's sideways axis; the thumb is turned ~45 degrees
                if f == 'Thumb':
                    want = (a * 0.66 + ex * 0.75) if side == 'Left' else (a * -0.62 + ex * 0.78)
                else:
                    want = ex
                x = want - y * want.dot(y)
                if x.length > 1e-4:
                    x.normalize()
                    b.align_roll(x.cross(y))
                    if kk < 3:
                        b.roll += math.radians(ROLL_SIGN * (-FINGER_ROLL if side == 'Left' else FINGER_ROLL))
                b.parent = parent
                if kk > 0 and f != 'Thumb':
                    b.use_connect = True
                parent = b
    bpy.ops.object.mode_set(mode='OBJECT')
    report['fingers'] = {'bones_added': 2 * 5 * 4, 'scale': {s: round(float(np.linalg.norm(np.array(layouts[s]['joints']['Pinky'][0][:]) - np.array(layouts[s]['joints']['Index'][0][:]))), 4) for s in layouts}}
    return layouts


def finger_redistribute(co, W, names, layouts, height, edges=None):
    """Split HAND weight between the palm and finger segments. Connected distal finger surfaces use one
    finger even when a surface vertex is closer to its neighbour; webbing and knuckles retain a palm blend."""
    eps = 0.0015 * height
    done = 0
    for side, lay in layouts.items():
        hi = names.index('%sHand' % side)
        sel = np.where(W[:, hi] > 1e-4)[0]
        if not len(sel):
            continue
        P = co[sel]
        segs = []
        for f in FINGERS:
            J = [np.array(j[:]) for j in lay['joints'][f]]
            segs.append((hi, lay['wrist'], J[0]))
            for k in range(3):
                segs.append((names.index('%sHand%s%d' % (side, f, k + 1)), J[k], J[k + 1]))
        D = np.empty((len(P), len(segs)))
        for j, (_, p0, p1) in enumerate(segs):
            ab = p1 - p0
            t = np.clip(((P - p0) @ ab) / max(float(ab @ ab), 1e-12), 0.0, 1.0)
            D[:, j] = np.linalg.norm(P - (p0 + t[:, None] * ab), axis=1)
        # A finger surface belongs to one finger, not a weighted average of adjacent fingers.
        # Keep the palm blend for the webbing and the segment blends for bending at the joints.
        finger_dist = np.stack([D[:, 4 * f + 1:4 * f + 4].min(axis=1) for f in range(len(FINGERS))], axis=1)
        closest = finger_dist.argmin(axis=1)
        if edges is not None and len(edges):
            # Only trust narrow, predominantly single-finger components past the webbing.
            a, ex, up, length = lay['frame']
            rel = P - lay['wrist']
            u = rel @ np.array(a[:]) / length
            lateral = rel @ np.array(ex[:])
            vertical = rel @ np.array(up[:]) / length
            distal = (u > 0.68) & (u < 1.2) & (np.abs(lateral) < 0.6 * length) & (np.abs(vertical) < 0.3)
            mask = np.zeros(len(co), dtype=bool)
            mask[sel[distal]] = True
            ee = edges[mask[edges[:, 0]] & mask[edges[:, 1]]]
            local = np.full(len(co), -1, dtype=np.int64)
            local[sel] = np.arange(len(sel))
            parent = np.arange(len(sel))

            def root(i):
                while parent[i] != i:
                    parent[i] = parent[parent[i]]
                    i = parent[i]
                return i

            for v, w in local[ee]:
                rv, rw = root(v), root(w)
                if rv != rw:
                    parent[rv] = rw
            rows = np.flatnonzero(distal)
            groups = {}
            for v in rows:
                groups.setdefault(root(v), []).append(v)
            centers = sorted(float((lay['joints'][f][1] - lay['joints']['Middle'][1]).dot(ex)) for f in FINGERS[1:])
            spacing = min(np.diff(centers))
            for group in groups.values():
                if len(group) < 8:
                    continue
                votes = np.bincount(closest[group], minlength=len(FINGERS))
                winner = int(votes.argmax())
                p10, p90 = np.percentile(lateral[group], [10, 90])
                if votes[winner] >= 0.7 * len(group) and p90 - p10 <= 1.5 * spacing:
                    closest[group] = winner
            # The thumb ends before the other fingers' distal zone. Follow a
            # narrow connected piece along its own axis instead of the hand axis.
            J = [np.array(j[:]) for j in lay['joints']['Thumb']]
            direction = J[3] - J[1]
            t = ((P - J[1]) @ direction) / max(float(direction @ direction), 1e-12)
            distance = np.linalg.norm(P - (J[1] + t[:, None] * direction), axis=1)
            across = np.cross(direction, np.array(up[:]))
            across /= max(float(np.linalg.norm(across)), 1e-12)
            width = (P - J[1]) @ across
            thumb_zone = (t > 0.0) & (t < 1.25) & (distance < 0.14 * length) & (u < 0.70)
            mask[:] = False
            mask[sel[thumb_zone]] = True
            ee = edges[mask[edges[:, 0]] & mask[edges[:, 1]]]
            parent = np.arange(len(sel))
            for v, w in local[ee]:
                rv, rw = root(v), root(w)
                if rv != rw:
                    parent[rv] = rw
            groups = {}
            for v in np.flatnonzero(thumb_zone):
                groups.setdefault(root(v), []).append(v)
            for group in groups.values():
                if len(group) < 8 or np.count_nonzero(closest[group] == 0) < 0.9 * len(group):
                    continue
                p10, p90 = np.percentile(width[group], [10, 90])
                if p90 - p10 <= 0.15 * length:
                    closest[group] = 0
        Wseg = ((D.min(axis=1, keepdims=True) + eps) / (D + eps)) ** 6
        for f in range(len(FINGERS)):
            Wseg[closest != f, 4 * f + 1:4 * f + 4] = 0.0
        bones = sorted(set(b for b, _, _ in segs))
        Wb = np.zeros((len(P), len(names)))
        for j, (b, _, _) in enumerate(segs):
            Wb[:, b] = np.maximum(Wb[:, b], Wseg[:, j])  # the palm is five segments: take the nearest, never the sum
        Wb /= np.maximum(Wb.sum(axis=1, keepdims=True), 1e-18)
        # A distal surface should rotate with one bone rather than collapse between transforms.
        J = [np.array(j[:]) for j in lay['joints']['Thumb']]
        ab = J[3] - J[2]
        t = ((P - J[2]) @ ab) / max(float(ab @ ab), 1e-12)
        distance = np.linalg.norm(P - (J[2] + np.clip(t, 0.0, 2.0)[:, None] * ab), axis=1)  # the tip sticks out past the last joint
        length = lay['frame'][3]
        along = np.clip((t - 0.55) / 0.35, 0.0, 1.0)
        radial = np.clip((0.12 * length - distance) / (0.06 * length), 0.0, 1.0)
        tip = along * along * (3.0 - 2.0 * along) * radial * radial * (3.0 - 2.0 * radial)
        tip *= (closest == 0)
        Wb *= (1.0 - tip[:, None])
        thumb_tip = names.index('%sHandThumb3' % side)
        Wb[:, thumb_tip] += tip
        h = W[sel, hi].copy()
        W[sel, hi] = 0.0
        forearm = names.index('%sForeArm' % side)
        forearm_tip = W[sel, forearm] * tip
        W[sel, forearm] -= forearm_tip
        W[sel, thumb_tip] += forearm_tip
        W[sel] += (Wb * h[:, None]).astype(W.dtype)
        done += len(sel)
    return done


# ----------------------------------------------------------------------------------------------
# 4. proxy + heat weights
# ----------------------------------------------------------------------------------------------
def join_copy(objs, name):
    copies = []
    for o in objs:
        c = o.copy()
        c.data = o.data.copy()
        bpy.context.scene.collection.objects.link(c)
        copies.append(c)
    bpy.ops.object.select_all(action='DESELECT')
    for c in copies:
        c.select_set(True)
    bpy.context.view_layer.objects.active = copies[0]
    if len(copies) > 1:
        bpy.ops.object.join()
    res = bpy.context.view_layer.objects.active
    res.name = name
    return res


def make_proxy(body_objs, height, voxels):
    proxy = join_copy(body_objs, 'AutoRigProxy')
    # drop materials/uvs: only shape matters here
    proxy.data.materials.clear()
    try:  # only the shape matters; layer names differ between joined meshes, so never remove by stale reference
        while len(proxy.data.uv_layers):
            proxy.data.uv_layers.remove(proxy.data.uv_layers[0])
    except Exception:
        pass
    try:
        while len(proxy.data.color_attributes):
            proxy.data.color_attributes.remove(proxy.data.color_attributes[0])
    except Exception:
        pass
    proxy.data.remesh_voxel_size = height / float(voxels)
    proxy.data.remesh_voxel_adaptivity = 0.0
    bpy.ops.object.select_all(action='DESELECT')
    proxy.select_set(True)
    bpy.context.view_layer.objects.active = proxy
    bpy.ops.object.voxel_remesh()
    return proxy


def heat_weight(proxy, arm):
    bpy.ops.object.select_all(action='DESELECT')
    proxy.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    proxy.vertex_groups.clear()
    for m in [x for x in proxy.modifiers if x.type == 'ARMATURE']:
        proxy.modifiers.remove(m)
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')


def dense_weights(obj, bone_names):
    idx = {n: i for i, n in enumerate(bone_names)}
    gmap = {g.index: idx[g.name] for g in obj.vertex_groups if g.name in idx}
    n = len(obj.data.vertices)
    W = np.zeros((n, len(bone_names)), dtype=np.float32)
    for v in obj.data.vertices:
        for g in v.groups:
            j = gmap.get(g.group)
            if j is not None:
                W[v.index, j] = g.weight
    return W


def bone_distances(points, arm, names):
    """distance from every point to every bone segment -> (n, bones)"""
    P = np.asarray(points, dtype=np.float64)
    D = np.empty((len(P), len(names)))
    for j, n in enumerate(names):
        bone = arm.data.bones[n]
        h = np.array((arm.matrix_world @ bone.head_local)[:])
        t = np.array((arm.matrix_world @ bone.tail_local)[:])
        ab = t - h
        den = max(float(ab @ ab), 1e-12)
        tt = np.clip(((P - h) @ ab) / den, 0.0, 1.0)
        D[:, j] = np.linalg.norm(P - (h + tt[:, None] * ab), axis=1)
    return D


def envelope_weights(points, arm, names, height):
    """Distance-to-bone fallback (no solver). Smooth, normalised, but less accurate than heat weights:
    the report flags it loudly so it is never mistaken for a good result."""
    D = bone_distances(points, arm, names)
    W = 1.0 / (D + 0.01 * height) ** 4
    W[D > D.min(axis=1, keepdims=True) * 2.0 + 0.03 * height] = 0.0
    return (W / W.sum(axis=1, keepdims=True)).astype(np.float32)


def proxy_is_sane(proxy, body_co, voxel):
    me = proxy.data
    if len(me.vertices) < 300 or len(me.polygons) < 300:
        return False
    pc = world_vertices(proxy)
    tol = 4 * voxel
    return bool(np.all(np.abs(pc.min(axis=0) - body_co.min(axis=0)) <= tol) and np.all(np.abs(pc.max(axis=0) - body_co.max(axis=0)) <= tol))


def discard(obj):
    mesh = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.meshes.remove(mesh)


def skin_proxy(body_objs, arm, bone_names, height, opt):
    """-> (proxy, W, voxels, solver_unweighted, method). Never raises on a bad solve: it retries at coarser
    voxel sizes, then falls back to envelope weights on the raw (un-remeshed) body."""
    body_co = np.concatenate([world_vertices(o) for o in body_objs])
    tries = [int(opt['proxy_voxels'] * f) for f in (1.0, 0.7, 0.5, 0.35)]
    for voxels in ([] if opt.get('force_envelope') else tries):
        voxel = height / float(voxels)
        proxy = make_proxy(body_objs, height, voxels)
        if not proxy_is_sane(proxy, body_co, voxel):
            log('proxy voxels=%d rejected (verts=%d): not a faithful copy of the body' % (voxels, len(proxy.data.vertices)))
            discard(proxy)
            continue
        heat_weight(proxy, arm)
        W = dense_weights(proxy, bone_names)
        has = W.sum(axis=1) >= 1e-6
        empty = int((~has).sum())
        log('proxy voxels=%d verts=%d unweighted=%d' % (voxels, len(proxy.data.vertices), empty))
        if has.mean() >= 0.98:
            return proxy, W, voxels, empty, 'heat'
        discard(proxy)
    log('bone heat could not solve this body: using envelope weights')
    proxy = join_copy(body_objs, 'AutoRigProxy')
    proxy.data.materials.clear()
    W = envelope_weights(world_vertices(proxy), arm, bone_names, height)
    return proxy, W, 0, int(len(W)), 'envelope'


def fill_unweighted(proxy, W, arm, names, height):
    """Proxy vertices the solver missed take the weights of the nearest weighted proxy vertex."""
    empty = np.where(W.sum(axis=1) < 1e-6)[0]
    if len(empty) == 0:
        return 0
    good = np.where(W.sum(axis=1) >= 1e-6)[0]
    if len(good) == 0:  # nothing solved at all: never index an empty set
        W[:] = envelope_weights(world_vertices(proxy), arm, names, height)
        return len(empty)
    kd = KDTree(len(good))
    for k, i in enumerate(good):
        kd.insert(proxy.data.vertices[int(i)].co, k)
    kd.balance()
    for i in empty:
        _, k, _ = kd.find(proxy.data.vertices[int(i)].co)
        W[i] = W[good[k]]
    return len(empty)


# ----------------------------------------------------------------------------------------------
# 5. transfer (nearest surface point, barycentric)
# ----------------------------------------------------------------------------------------------
def build_tree(proxy):
    mesh = proxy.data
    mesh.calc_loop_triangles()
    verts = [v.co.copy() for v in mesh.vertices]
    tris = [tuple(t.vertices) for t in mesh.loop_triangles]
    return BVHTree.FromPolygons(verts, tris), verts, tris


def sample_weights(tree, verts, tris, W, points):
    """Weights at arbitrary points: nearest surface point of the proxy, barycentric. -> (weights, distances)"""
    out = np.zeros((len(points), W.shape[1]), dtype=np.float32)
    dist = np.full(len(points), 1e9)
    for i, p in enumerate(points):
        loc, nor, fi, d = tree.find_nearest(Vector(p))
        if fi is None:
            continue
        dist[i] = d
        tri = tris[fi]
        a, b, c = (verts[k] for k in tri)
        v0, v1, v2 = b - a, c - a, loc - a
        d00, d01, d11 = v0.dot(v0), v0.dot(v1), v1.dot(v1)
        d20, d21 = v2.dot(v0), v2.dot(v1)
        den = d00 * d11 - d01 * d01
        if abs(den) < 1e-18:
            u, v, w = 1.0, 0.0, 0.0
        else:
            v = (d11 * d20 - d01 * d21) / den
            w = (d00 * d21 - d01 * d20) / den
            u = 1.0 - v - w
        wa, wb, wc = max(u, 0.0), max(v, 0.0), max(w, 0.0)
        s = wa + wb + wc
        if s <= 0:
            wa, wb, wc, s = 1.0, 0.0, 0.0, 1.0
        out[i] = (W[tri[0]] * wa + W[tri[1]] * wb + W[tri[2]] * wc) / s
    return out, dist


def thin_pieces_on_body(proxy, rigid_info, height, frac):
    """A thin piece lying ON the body (a drawstring, a strap, a collar, a hair card) belongs to the clothing: bound to
    one bone it would stay put while the cloth around it moves. Only blade-like pieces standing away from the body
    (a sword, a wing) should be rigid. -> the entries of rigid_info that sit within `frac` x height of the body."""
    tree, verts, tris = build_tree(proxy)
    out = []
    for i in rigid_info:
        if not (i['reason'] or '').startswith('thin'):
            continue
        co = world_vertices(i['obj'])
        step = max(1, len(co) // 200)
        ds = [tree.find_nearest(Vector(p))[3] for p in co[::step]]
        ds = [d for d in ds if d is not None]
        if ds and float(np.mean(ds)) < frac * height:
            out.append(i)
    return out


def transfer(proxy, W, targets, names, cx, height, opt, voxel_size):
    """Proxy weights -> every real vertex. Symmetry is applied by ALSO sampling the proxy at the mirrored
    position (works for any tessellation, and across separate left/right parts)."""
    tree, verts, tris = build_tree(proxy)
    perm = mirror_names(names)
    # a voxel proxy is only accurate to about a voxel, so the symmetry test must allow for that
    tol = max(opt['mirror_tolerance'] * height, 2.5 * voxel_size)
    sampled, mirrored, mdist = {}, {}, {}
    for obj in targets:
        co = world_vertices(obj)
        sampled[obj.name], _ = sample_weights(tree, verts, tris, W, co)
        if opt['mirror'] != 'off':
            mco = co.copy()
            mco[:, 0] = 2 * cx - mco[:, 0]
            mw, md = sample_weights(tree, verts, tris, W, mco)
            mirrored[obj.name], mdist[obj.name] = mw[:, perm], md
    coverage = 0.0
    if mdist:
        allm = np.concatenate([d for d in mdist.values()])
        coverage = float((allm <= tol).mean())
    use = opt['mirror'] == 'on' or (opt['mirror'] == 'auto' and coverage >= 0.9)
    results = {}
    for obj in targets:
        Wt = sampled[obj.name]
        if use and obj.name in mirrored:
            ok = mdist[obj.name] <= tol
            Wt = Wt.copy()
            Wt[ok] = 0.5 * (Wt[ok] + mirrored[obj.name][ok])
        results[obj.name] = Wt
    return results, coverage, use


# ----------------------------------------------------------------------------------------------
# 6. cleanup
# ----------------------------------------------------------------------------------------------
def weld_groups(co, tol=1e-6):
    """Vertices at the same position (UV / normal seams) must end up with identical weights."""
    key = np.round(co / tol).astype(np.int64)
    _, inverse = np.unique(key, axis=0, return_inverse=True)
    return inverse.reshape(-1)


def cross_mesh_blend(weights, positions, height, radius_frac=0.0035, strength=1.0, side_below_z=None, axis_x=0.0):
    """Clothing is often several meshes (jacket, shirt, body, sleeves ...). Weights are computed per vertex and
    smoothed along each mesh's OWN edges, so two meshes meeting at a shoulder never blend with each other and can
    pull apart. A spatial grid blends neighbouring weights across meshes and along seams."""
    P = np.concatenate(positions)
    W = np.concatenate(weights).astype(np.float64)
    cell = max(radius_frac * height, 1e-6)
    grid = P / cell
    ijk = np.floor(grid).astype(np.int64)
    frac = grid - ijk
    ijk -= ijk.min(axis=0)
    # below `side_below_z` (the crotch) the two legs and feet never blend into each other, even where they touch:
    # a fourth key dimension holds the side of the middle line, and neighbours must share it
    side = np.where((side_below_z is not None) & (P[:, 2] < (side_below_z if side_below_z is not None else 0)), np.where(P[:, 0] >= axis_x, 2, 1), 0)
    ijk = np.concatenate([ijk, side[:, None].astype(np.int64)], axis=1)
    dims = ijk.max(axis=0) + np.array([2, 2, 2, 1])
    def key_of(a):
        return ((a[:, 0] * dims[1] + a[:, 1]) * dims[2] + a[:, 2]) * dims[3] + a[:, 3]
    # Splat and sample continuously so crossing a cell boundary cannot produce a weight step.
    keys, factors = [], []
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                keys.append(key_of(ijk + np.array([dx, dy, dz, 0])))
                factors.append((frac[:, 0] if dx else 1 - frac[:, 0]) *
                               (frac[:, 1] if dy else 1 - frac[:, 1]) *
                               (frac[:, 2] if dz else 1 - frac[:, 2]))
    uniq, inverse = np.unique(np.concatenate(keys), return_inverse=True)
    inverse = inverse.reshape(8, len(P))
    S = np.zeros((len(uniq), W.shape[1]))
    C = np.zeros(len(uniq))
    for inv, factor in zip(inverse, factors):
        np.add.at(S, inv, W * factor[:, None])
        np.add.at(C, inv, factor)
    acc = np.zeros_like(W)
    cnt = np.zeros(len(W))
    for inv, factor in zip(inverse, factors):
        acc += S[inv] * factor[:, None]
        cnt += C[inv] * factor
    avg = acc / np.maximum(cnt, 1e-12)[:, None]
    out = ((1.0 - strength) * W + strength * avg).astype(np.float32)
    parts, start = [], 0
    for w in weights:
        parts.append(out[start:start + len(w)])
        start += len(w)
    return parts


def smooth_weights(obj, Wobj, iterations, strength):
    if iterations <= 0:
        return Wobj
    co = world_vertices(obj)
    group = weld_groups(co)
    ng = int(group.max()) + 1
    # accumulate neighbour sums in welded space
    nbr_sum = None
    edges = np.empty(len(obj.data.edges) * 2, dtype=np.int64)
    obj.data.edges.foreach_get('vertices', edges)
    edges = edges.reshape(-1, 2)
    ga, gb = group[edges[:, 0]], group[edges[:, 1]]
    keep = ga != gb
    ga, gb = ga[keep], gb[keep]
    W = Wobj.copy()
    # one value per welded group
    GW = np.zeros((ng, W.shape[1]), dtype=np.float32)
    cnt = np.zeros(ng, dtype=np.float32)
    np.add.at(GW, group, W)
    np.add.at(cnt, group, 1.0)
    GW /= np.maximum(cnt, 1)[:, None]
    for _ in range(iterations):
        S = np.zeros_like(GW)
        N = np.zeros(ng, dtype=np.float32)
        np.add.at(S, ga, GW[gb])
        np.add.at(S, gb, GW[ga])
        np.add.at(N, ga, 1.0)
        np.add.at(N, gb, 1.0)
        avg = S / np.maximum(N, 1)[:, None]
        has = N > 0
        GW[has] = GW[has] * (1 - strength) + avg[has] * strength
    return GW[group]


def world_normals(obj):
    """Area-weighted vertex normals (outward for a normal Blender mesh), in the same space as world_vertices."""
    co = world_vertices(obj)
    me = obj.data
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    tris = np.empty(nt * 3, dtype=np.int64)
    me.loop_triangles.foreach_get('vertices', tris)
    tris = tris.reshape(-1, 3)
    fn = np.cross(co[tris[:, 1]] - co[tris[:, 0]], co[tris[:, 2]] - co[tris[:, 0]])
    out = np.zeros_like(co)
    for k in range(3):
        np.add.at(out, tris[:, k], fn)
    return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-12)


_BIN_DIRS = None


def _bin_dirs():
    global _BIN_DIRS
    if _BIN_DIRS is None:
        d = np.array([(x, y, z) for x in (-1, 0, 1) for y in (-1, 0, 1) for z in (-1, 0, 1) if (x, y, z) != (0, 0, 0)], dtype=np.float64)
        _BIN_DIRS = d / np.linalg.norm(d, axis=1, keepdims=True)
    return _BIN_DIRS


def layer_blend(weights, positions, normals, cell, strength=1.0, slots=3, power=4.0):
    """Layered clothing (skin, shirt, jacket) must move as one: where a layer lies a centimetre or two
    under another, vertices at the same spot need the same weights, or the inner layer pokes through
    when a joint bends. Weights are averaged between SAME-FACING surfaces that are stacked within about
    one grid cell. Surfaces that face each other (armpit, inner thigh, between fingers) never mix:
    the grid key holds a soft orientation bin as well as the cell.
    weights / positions / normals: one array per mesh. -> list of blended weight arrays"""
    P = np.concatenate(positions)
    N = np.concatenate(normals)
    W = np.concatenate(weights).astype(np.float32)
    n = len(P)
    N = N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
    D = _bin_dirs()
    A = np.clip(N @ D.T, 0.0, None) ** power
    top = np.argsort(-A, axis=1)[:, :slots]
    a = np.take_along_axis(A, top, 1)
    a = a / np.maximum(a.sum(axis=1, keepdims=True), 1e-9)
    grid = P / max(cell, 1e-9)
    ijk = np.floor(grid).astype(np.int64)
    frac = grid - ijk
    ijk -= ijk.min(axis=0)
    dims = ijk.max(axis=0) + np.array([2, 2, 2])
    nb = len(D)
    entries = []
    for s in range(slots):
        b = top[:, s]
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    c = ijk + np.array([dx, dy, dz])
                    key = ((c[:, 0] * dims[1] + c[:, 1]) * dims[2] + c[:, 2]) * nb + b
                    f = ((frac[:, 0] if dx else 1 - frac[:, 0]) * (frac[:, 1] if dy else 1 - frac[:, 1]) *
                         (frac[:, 2] if dz else 1 - frac[:, 2]) * a[:, s])
                    entries.append((key, f.astype(np.float32)))
    uniq, inv = np.unique(np.concatenate([e[0] for e in entries]), return_inverse=True)
    inv = inv.reshape(len(entries), n)
    S = np.zeros((len(uniq), W.shape[1]), dtype=np.float32)
    C = np.zeros(len(uniq), dtype=np.float32)
    for (_, f), iv in zip(entries, inv):
        order = np.argsort(iv, kind='stable')
        ivs = iv[order]
        starts = np.concatenate([[0], np.flatnonzero(np.diff(ivs)) + 1])
        ids = ivs[starts]
        S[ids] += np.add.reduceat(W[order] * f[order, None], starts, axis=0)
        C[ids] += np.add.reduceat(f[order], starts)
    acc = np.zeros_like(W)
    cnt = np.zeros(n, dtype=np.float32)
    for (_, f), iv in zip(entries, inv):
        acc += (S[iv] / np.maximum(C[iv], 1e-9)[:, None]) * f[:, None]
        cnt += f
    out = (1.0 - strength) * W + strength * (acc / np.maximum(cnt, 1e-9)[:, None])
    out /= np.maximum(out.sum(axis=1, keepdims=True), 1e-9)
    parts, start = [], 0
    for w in weights:
        parts.append(out[start:start + len(w)])
        start += len(w)
    return parts


def hand_isolate(W, co, names, layouts, near=0.15, far=0.35, reach=0.75):
    """The arm bones must not hold anything out in the hand. The voxel weights leave a few per cent of ForeArm on
    the thumb tip and fingertips, and where neighbouring vertices carry different amounts the tip tears when
    the thumb moves. Past the wrist the arm weight fades out and moves to the hand / finger bones the vertex
    already has (or to the hand). Edits W in place. -> number of vertices changed"""
    changed = 0
    for side, lay in layouts.items():
        a = np.array(lay['frame'][0][:], dtype=np.float64)
        length = float(lay['frame'][3])
        rel = co - np.array(lay['wrist'][:], dtype=np.float64)
        along = rel @ a
        lateral = np.linalg.norm(rel - np.outer(along, a), axis=1) / length
        x = np.clip(((along / length) - near) / (far - near), 0.0, 1.0)
        t = x * x * (3.0 - 2.0 * x) * (lateral < reach)
        donors = [names.index(side + k) for k in ('ForeArm', 'Arm', 'Shoulder') if (side + k) in names]
        hand_cols = [i for i, nm in enumerate(names) if nm.startswith(side + 'Hand')]
        moved = W[:, donors].sum(axis=1) * t
        if not (moved > 1e-7).any():
            continue
        W[:, donors] *= (1.0 - t)[:, None]
        cur = W[:, hand_cols].sum(axis=1)
        has = cur > 1e-6
        W[np.ix_(has, hand_cols)] += (W[np.ix_(has, hand_cols)] / cur[has, None]) * moved[has, None]
        W[~has, names.index(side + 'Hand')] += moved[~has]
        changed += int((moved > 1e-4).sum())
    return changed


def mirror_names(names):
    out = []
    for n in names:
        if ':Left' in n:
            out.append(names.index(n.replace(':Left', ':Right')))
        elif ':Right' in n:
            out.append(names.index(n.replace(':Right', ':Left')))
        else:
            out.append(names.index(n))
    return out


LIMB_PARTS = {'leg': ('UpLeg', 'Leg', 'Foot', 'ToeBase'), 'arm': ('Shoulder', 'Arm', 'ForeArm', 'Hand')}


def side_coherence(Wobj, co, arm, names, height, axis_x=0.0):
    """The voxel proxy fuses limbs that sit close together (feet side by side, arms against the torso), so
    heat weights can leak across. A vertex that is nearer the LEFT limb than the RIGHT one by more than a
    small margin must not carry the right limb's weights (and vice versa).
    Legs: the margin is tight on shins and feet and relaxes toward the crotch.
    At the upper-leg centre seam, opposite-thigh influence fades toward the nearer side.
    Arms: a small constant margin, so the chest centre, equally near both, is left alone."""
    D = bone_distances(co, arm, names)
    W = Wobj.copy()
    z = co[:, 2]
    knee_z = float(np.mean([(arm.matrix_world @ arm.data.bones['%sLeg' % s].head_local).z for s in ('Left', 'Right')]))
    hip_z = float(np.mean([(arm.matrix_world @ arm.data.bones['%sUpLeg' % s].head_local).z for s in ('Left', 'Right')]))
    t = np.clip((z - knee_z) / max(hip_z - knee_z, 1e-6), 0.0, 1.0)
    margins = {'leg': (0.012 * t) * height, 'arm': np.full(len(z), 0.004 * height)}
    removed = 0
    for part, bones in LIMB_PARTS.items():
        li = [names.index('Left' + b) for b in bones]
        ri = [names.index('Right' + b) for b in bones]
        dl, dr = D[:, li].min(axis=1), D[:, ri].min(axis=1)
        m = margins[part]
        is_left = dl + m < dr
        is_right = dr + m < dl
        if part == 'leg':
            # ties (feet touching on the middle line): the side of the middle line decides, never "both"
            tie = ~(is_left | is_right) & (t < 0.05)
            # At the pelvis, fade the opposite leg's share continuously rather than cutting it
            # abruptly at the margin. A cap on the share makes repeated cleanup passes stable.
            hip_i = names.index('Hips')
            total = W[:, li].sum(axis=1) + W[:, ri].sum(axis=1) + W[:, hip_i]
            for delta, kill in ((dr - dl, ri), (dl - dr, li)):
                q = np.clip((delta / np.maximum(m, 1e-12) - 0.75) / 0.5, 0.0, 1.0)
                q = q * q * (3.0 - 2.0 * q)
                old = W[:, kill].sum(axis=1)
                # Cap the opposite side's share after normalisation, so repeated passes do not tighten it.
                allowed = np.where(q > 1e-12, (total - old) * (1.0 - q) / np.maximum(q, 1e-12), old)
                factor = np.minimum(1.0, allowed / np.maximum(old, 1e-12))
                factor = np.where((delta > 0) & ~tie, factor, 1.0)
                rows = np.where(factor < 1.0)[0]
                removed += int((W[np.ix_(rows, kill)] > 0).sum())
                W[np.ix_(rows, kill)] *= factor[rows, None]
            # Exact ties below the knee are resolved by the centre line.
            for sel, kill in ((tie & (co[:, 0] >= axis_x), ri), (tie & (co[:, 0] < axis_x), li)):
                rows = np.where(sel)[0]
                removed += int((W[np.ix_(rows, kill)] > 0).sum())
                W[np.ix_(rows, kill)] = 0.0
        else:
            for sel, kill in ((is_left, ri), (is_right, li)):
                if sel.any():
                    rows = np.where(sel)[0]
                    removed += int((W[np.ix_(rows, kill)] > 0).sum())
                    W[np.ix_(rows, kill)] = 0.0
    # The legs cannot influence the upper body. Bone heat sometimes hands a rim or an inner shell near the shoulders
    # a big UpLeg weight (it happened on an open jacket); a vertex up there would then fly off whenever a leg moves.
    # Leg weights are fully allowed up to a little above the hip joint and fade to nothing by 12% of the height above.
    leg_idx = [names.index('%s%s' % (sd, b)) for sd in ('Left', 'Right') for b in LIMB_PARTS['leg']]
    fade = np.clip((hip_z + 0.12 * height - z) / (0.08 * height), 0.0, 1.0)
    fade = fade * fade * (3.0 - 2.0 * fade)
    cut = fade < 0.999
    if cut.any():
        removed += int((W[np.ix_(np.where(cut)[0], leg_idx)] > 0).sum())
        W[np.ix_(np.where(cut)[0], leg_idx)] *= fade[cut][:, None]
    thigh_ids = [names.index('%sUpLeg' % side) for side in ('Left', 'Right')]
    hip_heads = [arm.matrix_world @ arm.data.bones['%sUpLeg' % side].head_local for side in ('Left', 'Right')]
    width = max(min(abs(hip_heads[0].x - hip_heads[1].x) * 0.1, 0.012 * height), 1e-6)
    lower = np.clip((z - (hip_z - 0.08 * height)) / (0.04 * height), 0.0, 1.0)
    upper = np.clip(((hip_z + 0.10 * height) - z) / (0.06 * height), 0.0, 1.0)
    gate = lower * lower * (3.0 - 2.0 * lower) * upper * upper * (3.0 - 2.0 * upper)
    # Keep total thigh influence unchanged so bending both hips does not pin the seam.
    total = W[:, thigh_ids].sum(axis=1)
    side = np.clip(np.abs(co[:, 0] - axis_x) / width, 0.0, 1.0)
    side = side * side * (3.0 - 2.0 * side)
    for sign, own, other in ((1.0, thigh_ids[0], thigh_ids[1]), (-1.0, thigh_ids[1], thigh_ids[0])):
        cap = total * (1.0 - 0.5 * gate * (1.0 + side))
        excess = np.where((sign * (co[:, 0] - axis_x) > 0) & (W[:, other] <= W[:, own]),
                          np.maximum(W[:, other] - cap, 0.0), 0.0)
        removed += int((excess > 1e-6).sum())
        W[:, other] -= excess
        W[:, own] += excess
    # a vertex that lost everything: nearest allowed bones
    empty = W.sum(axis=1) < 1e-6
    if empty.any():
        W[empty] = envelope_weights(co[empty], arm, names, height)
    return W / np.maximum(W.sum(axis=1, keepdims=True), 1e-9), removed


CAP_PARTS = ('Shoulder', 'Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot', 'ToeBase')


def limb_reach_cap(Wobj, co, arm, names, height, lo=1.7, hi=2.7):
    """Heat weights let a limb bone claim far too much of the body next to it (the upper arm taking the
    shoulder top and ribs, so lowering the arm drags the body's side down). Each limb bone's weight fades
    out between `lo` and `hi` times its own radius (measured from the vertices it clearly owns), and the
    freed weight goes to the other bones (spine, hips ...)."""
    D = bone_distances(co, arm, names)
    W = Wobj.copy()
    capped = 0
    for side in ('Left', 'Right'):
        for part in CAP_PARTS:
            j = names.index('%s%s' % (side, part))
            owned = (W.argmax(axis=1) == j) & (W[:, j] > 0.6)
            if owned.sum() < 30:
                continue
            r = max(float(np.median(D[owned, j])), 0.008 * height)
            cap = np.clip((hi * r - D[:, j]) / ((hi - lo) * r), 0.0, 1.0)
            cap = cap * cap * (3.0 - 2.0 * cap)
            capped += int(((cap < 0.999) & (W[:, j] > 0)).sum())
            W[:, j] *= cap
    empty = W.sum(axis=1) < 1e-6
    if empty.any():
        W[empty] = envelope_weights(co[empty], arm, names, height)
    return W / np.maximum(W.sum(axis=1, keepdims=True), 1e-9), capped


def clavicle_rebalance(Wobj, co, arm, names, height):
    """Bone heat lets the clavicle take about half of the upper chest and shoulder top, so the chest follows the
    arms outward. Cap the clavicle weight to a profile along the bone and
    hand the excess to Spine2; arm-dominated vertices (the deltoid) and everything beyond the joint are untouched."""
    W = Wobj.copy()
    s2 = names.index('Spine2')
    moved = 0
    for side in ('Left', 'Right'):
        sh = names.index('%sShoulder' % side)
        arm_i = names.index('%sArm' % side)
        b = arm.data.bones['%sShoulder' % side]
        h = np.array((arm.matrix_world @ b.head_local)[:])
        t = np.array((arm.matrix_world @ b.tail_local)[:])
        ab = t - h
        u = ((co - h) @ ab) / max(float(ab @ ab), 1e-12)
        # Profile by position along the clavicle (0 = neck end, 1 = shoulder joint):
        # ~1% over the inner 40% (the chest centre belongs to the spine), rising to ~14% at 85% and 28% at the joint,
        # then free again out over the arm
        cap = np.interp(u, [0.4, 0.85, 1.0, 1.3], [0.01, 0.14, 0.28, 1.0])
        over = (W[:, sh] > cap) & (W[:, arm_i] < 0.5)
        excess = np.where(over, W[:, sh] - cap, 0.0)
        W[:, sh] -= excess
        W[:, s2] += excess
        moved += int(over.sum())
    return W, moved


SPINE_CHAIN = ('Hips', 'Spine', 'Spine1', 'Spine2')
RAMP = 1.5  # widen the hand-over ramps for softer blending between spine bones


def spine_profile(Wobj, co, arm, names):
    """Split the spine chain with a linear blend by height. Bone heat can let one spine bone keep too much weight
    (Spine1 right up to the shoulders), which leaves the upper
    torso, and any jacket on it, to the shoulder bones that pull it outward with the arms. The weight a vertex
    already gives the spine chain is kept; only its split between Hips / Spine / Spine1 / Spine2 is replaced by a
    height profile. The hand-over heights are: Hips -> Spine at the Spine joint,
    Spine -> Spine1 just under the Spine1 joint, Spine1 -> Spine2 well under the Spine2 joint, each a ramp about as
    wide as the next segment."""
    idx = [names.index(n) for n in SPINE_CHAIN]
    heads = []
    for n in SPINE_CHAIN + ('Neck',):
        b = arm.data.bones[n]
        heads.append(float((arm.matrix_world @ b.head_local).z))
    h0, h1, h2, h3, h4 = heads
    cross = [h1, h2 - 0.19 * (h2 - h1), h3 - 0.38 * (h3 - h2)]
    half = [r * RAMP for r in (0.5 * (h2 - h1), 0.5 * (h3 - h2), 0.5 * (h4 - h3))]
    z = co[:, 2]
    s = [np.clip((z - (cross[k] - half[k])) / max(2 * half[k], 1e-9), 0.0, 1.0) for k in range(3)]
    s[1] = np.minimum(s[0], s[1])
    s[2] = np.minimum(s[1], s[2])
    prof = np.stack([1.0 - s[0], s[0] - s[1], s[1] - s[2], s[2]], axis=1)
    W = Wobj.copy()
    mass = W[:, idx].sum(axis=1)
    # above the neck base the spine chain's influence fades out and the Neck bone takes over (bone heat bleeds some
    # spine weight up into the neck; consolidating it all on Spine2 would make Spine2 own the neck)
    head_z = float((arm.matrix_world @ arm.data.bones['Head'].head_local).z)
    fade = np.clip((z - h4) / max(0.5 * (head_z - h4), 1e-9), 0.0, 1.0)
    to_neck = mass * fade
    W[:, idx] = (prof * (mass - to_neck)[:, None]).astype(W.dtype)
    W[:, names.index('Neck')] += to_neck.astype(W.dtype)
    return W


def hip_rebalance(Wobj, co, arm, names, height):
    """Cap thigh influence across the pelvis, transferring excess to Hips."""
    hips = names.index('Hips')
    legs = [names.index('%sUpLeg' % side) for side in ('Left', 'Right')]
    hip_z = float(np.mean([(arm.matrix_world @ arm.data.bones['%sUpLeg' % side].head_local).z
                           for side in ('Left', 'Right')]))
    t = np.clip((co[:, 2] - (hip_z - 0.08 * height)) / (0.16 * height), 0.0, 1.0)
    cap = 1.0 - t * t * (3.0 - 2.0 * t)
    W = Wobj.copy()
    leg_mass = W[:, legs].sum(axis=1)
    allowed = cap * (leg_mass + W[:, hips])
    factor = np.minimum(1.0, np.divide(allowed, leg_mass, out=np.ones_like(leg_mass), where=leg_mass > 1e-12))
    W[:, legs] *= factor[:, None]
    W[:, hips] += leg_mass * (1.0 - factor)
    return W, int((factor < 0.999).sum())


def crotch_apex(Wobj, co, names, height, axis_x=0.0):
    """Height of the crotch of one mesh: the lowest vertex near the middle that still carries both thighs.
    None when the mesh has no crotch (a shirt, a jacket, the head)."""
    li, ri = names.index('LeftUpLeg'), names.index('RightUpLeg')
    seam = (np.minimum(Wobj[:, li], Wobj[:, ri]) > 0.05) & (np.abs(co[:, 0] - axis_x) < 0.03 * height)
    if seam.sum() < 20:
        return None
    return float(co[seam, 2].min())


def crotch_profile(Wobj, co, arm, names, height, axis_x, apex, width_frac=0.0064):
    """Skin, underwear and trousers meet in one place between the legs and must share the same thigh handover.
    The proxy hands the thigh weight over differently on every layer: the skin is 100% one thigh right up to the
    middle, while the cloth next to it is split 74/26 or 50/50. With the legs apart the cloth then slides away from
    the skin and its middle vertices hang halfway between the legs as a fin of stretched trousers, and the thin
    seam folds over. Here every layer in the crotch band gets one smooth profile of the lateral position: the
    thigh on the far side fades from half at the middle to a few per cent a centimetre or two out (a short
    exponential tail, the usual hand-weighted look). Hips weight and the total thigh share are unchanged and it
    depends on position only, so layers that reach the same spot get the same weights.
    apex is the lowest crotch of all layers (crotch_apex); below it the thighs are separate tubes and stay as they
    are. -> (weights, vertices changed)"""
    li, ri = names.index('LeftUpLeg'), names.index('RightUpLeg')
    heads = [arm.matrix_world @ arm.data.bones['%sUpLeg' % s].head_local for s in ('Left', 'Right')]
    hip_z = float(np.mean([h.z for h in heads]))
    left_sign = 1.0 if heads[0].x >= heads[1].x else -1.0
    scale = max(width_frac * height, 1e-6)
    cut = 4.5 * scale
    z = co[:, 2]
    dx = left_sign * (co[:, 0] - axis_x)
    rise = 0.0116 * height
    gz = np.clip((z - (apex - 0.5 * rise)) / rise, 0.0, 1.0) * np.clip(((hip_z + 0.05 * height) - z) / (0.023 * height), 0.0, 1.0)
    gz = gz * gz * (3.0 - 2.0 * gz)
    gx = np.clip((cut - np.abs(dx)) / (0.5 * cut), 0.0, 1.0)
    gx = gx * gx * (3.0 - 2.0 * gx)
    g = gx * gz
    W = Wobj.copy()
    legs = W[:, li] + W[:, ri]
    other = 0.5 * np.exp(-np.abs(dx) / scale)
    left_share = np.where(dx >= 0.0, 1.0 - other, other)
    W[:, li] = (1.0 - g) * W[:, li] + g * legs * left_share
    W[:, ri] = (1.0 - g) * W[:, ri] + g * legs * (1.0 - left_share)
    return W, int((g > 0.01).sum())


def joint_soften(staged, arm, height, radius_frac, reach_frac, strength, cross_args, part):
    """Blend neighbouring weights around a pair of joints, fading out away from the joints."""
    if not staged:
        return staged
    P = [x[2] for x in staged]
    wide = cross_mesh_blend([x[1] for x in staged], P, height, radius_frac, 1.0, *cross_args)
    joints = [np.array((arm.matrix_world @ arm.data.bones['%s%s' % (sd, part)].head_local)[:]) for sd in ('Left', 'Right')]
    reach = reach_frac * height
    out = []
    for (o, W, co), Ww in zip(staged, wide):
        d = np.min([np.linalg.norm(co - j, axis=1) for j in joints], axis=0)
        t = np.clip(1.0 - d / reach, 0.0, 1.0)
        m = (t * t * (3.0 - 2.0 * t) * strength)[:, None]
        Wn = (1.0 - m) * W + m * Ww
        out.append((o, (Wn / np.maximum(Wn.sum(axis=1, keepdims=True), 1e-9)).astype(np.float32), co))
    return out


def head_lock(Wobj, co, names, L):
    """Everything clearly above the neck, whose weights are spine/neck/head, is Head 100% (face rule)."""
    head_i = names.index('Head')
    neck_i = names.index('Neck')
    spine_ids = [names.index(n) for n in ('Spine', 'Spine1', 'Spine2', 'Hips')]
    allowed = set([head_i, neck_i] + spine_ids)
    z_cut = L['neck'].z + 0.45 * (L['head_top'].z - L['neck'].z)
    argmax = Wobj.argmax(axis=1)
    sel = (co[:, 2] > z_cut) & np.isin(argmax, list(allowed))
    Wobj = Wobj.copy()
    Wobj[sel] = 0.0
    Wobj[sel, head_i] = 1.0
    return Wobj, int(sel.sum())


def limit_normalise(Wobj, max_inf, prune):
    W = Wobj.copy()
    if prune > 0:
        # Fade small influences out rather than creating a step at the cutoff.
        t = np.clip((W - prune) / prune, 0.0, 1.0)
        W *= t * t * (3.0 - 2.0 * t)
    if max_inf < W.shape[1]:
        order = np.argsort(-W, axis=1)
        mask = np.zeros_like(W, dtype=bool)
        rows = np.arange(W.shape[0])[:, None]
        mask[rows, order[:, :max_inf]] = True
        W = np.where(mask, W, 0.0)
    s = W.sum(axis=1, keepdims=True)
    bad = (s[:, 0] < 1e-9)
    W = W / np.maximum(s, 1e-9)
    return W, int(bad.sum())


def nearest_bone(arm, names, point):
    best, bi = 1e18, 0
    for i, n in enumerate(names):
        b = arm.data.bones[n]
        h, t = arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local
        ab = t - h
        tt = 0.0 if ab.length_squared == 0 else max(0.0, min(1.0, (point - h).dot(ab) / ab.length_squared))
        d = (h + ab * tt - point).length
        if d < best:
            best, bi = d, i
    return bi, best


# ----------------------------------------------------------------------------------------------
# apply to objects
# ----------------------------------------------------------------------------------------------
def write_weights(obj, arm, names, W):
    obj.vertex_groups.clear()
    groups = [obj.vertex_groups.new(name=n) for n in names]
    nz = np.nonzero(W > 0)
    by_bone = {}
    for v, b in zip(nz[0], nz[1]):
        by_bone.setdefault(int(b), {}).setdefault(float(W[v, b]), []).append(int(v))
    for b, wmap in by_bone.items():
        for w, verts in wmap.items():
            groups[b].add(verts, w, 'REPLACE')
    for m in [x for x in obj.modifiers if x.type == 'ARMATURE']:
        obj.modifiers.remove(m)
    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    obj.parent = arm
    obj.matrix_parent_inverse = arm.matrix_world.inverted()


# ----------------------------------------------------------------------------------------------
# 8. self-check
# ----------------------------------------------------------------------------------------------
def mesh_volume(obj, dg):
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    vol = 0.0
    for f in bm.faces:
        a, b, c = (v.co for v in f.verts)
        vol += a.dot(b.cross(c)) / 6.0
    bm.free()
    ev.to_mesh_clear()
    return abs(vol)


def evaluated_positions(obj, dg):
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get('co', co)
    ev.to_mesh_clear()
    return co.reshape(n, 3)


POSES = {
    'arms_down_80': {'LeftArm': (0, 0, -80), 'RightArm': (0, 0, 80)},
    'elbows_bent_100': {'LeftForeArm': (0, 100, 0), 'RightForeArm': (0, -100, 0)},
    'knees_bent_90': {'LeftLeg': (-90, 0, 0), 'RightLeg': (-90, 0, 0)},
    'hips_flexed_70': {'LeftUpLeg': (-70, 0, 0), 'RightUpLeg': (-70, 0, 0)},
    'spine_bend_40': {'Spine1': (35, 0, 0), 'Spine': (25, 0, 0)},
    'head_turn_60': {'Head': (0, 60, 0)},
}


def self_check(arm, skinned_objs, rest_vols, rest_co, rest_edges, height):
    bpy.context.view_layer.objects.active = arm
    results = {}
    dg = bpy.context.evaluated_depsgraph_get()
    for pname, rots in POSES.items():
        bpy.ops.object.mode_set(mode='POSE')
        for pb in arm.pose.bones:
            pb.rotation_mode = 'XYZ'
            pb.rotation_euler = (0, 0, 0)
        for bname, (rx, ry, rz) in rots.items():
            pb = arm.pose.bones.get(bname)
            if pb:
                pb.rotation_euler = (math.radians(rx), math.radians(ry), math.radians(rz))
        bpy.ops.object.mode_set(mode='OBJECT')
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        worst_vol, worst_stretch, spikes = 1.0, 1.0, 0
        for o in skinned_objs:
            if o.name in rest_vols and rest_vols[o.name] > 1e-9:
                ratio = mesh_volume(o, dg) / rest_vols[o.name]
                worst_vol = min(worst_vol, ratio)
            co = evaluated_positions(o, dg)
            e = rest_edges[o.name]
            if len(e):
                rest_len = np.linalg.norm(rest_co[o.name][e[:, 0]] - rest_co[o.name][e[:, 1]], axis=1)
                pose_len = np.linalg.norm(co[e[:, 0]] - co[e[:, 1]], axis=1)
                ratio = pose_len / np.maximum(rest_len, 1e-6)
                big = rest_len > 1e-4
                if big.any():
                    worst_stretch = max(worst_stretch, float(ratio[big].max()))
                    spikes += int((ratio[big] > 2.5).sum())
        results[pname] = {'min_volume_ratio': round(worst_vol, 4), 'max_edge_stretch': round(worst_stretch, 3), 'stretched_edges': spikes}
    bpy.ops.object.mode_set(mode='POSE')
    for pb in arm.pose.bones:
        pb.rotation_euler = (0, 0, 0)
    bpy.ops.object.mode_set(mode='OBJECT')
    return results


# ----------------------------------------------------------------------------------------------
def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if not argv:
        fail('No job file', 'args')
    job = json.load(open(argv[0]))
    opt = dict(DEFAULTS)
    opt.update(job.get('options') or {})
    bpy.ops.wm.read_factory_settings(use_empty=True)

    progress(0.01, 'Reading the model')
    meshes = import_mesh(job['input'])
    progress(0.02, 'Preparing parts')
    pre = np.concatenate([world_vertices(o) for o in meshes])
    weld = max(float(pre[:, 2].max() - pre[:, 2].min()) * 1e-5, 1e-9)  # relative: works for metres and centimetres
    comps = split_components(meshes, weld)
    all_co = np.concatenate([world_vertices(o) for o in comps])
    height = float(all_co[:, 2].max() - all_co[:, 2].min())
    if height < 1e-6:
        fail('The model has no height', 'empty')
    # markers were placed in the preview's frame: re-express them in the frame Blender actually sees
    biggest = sorted(((o.name, len(o.data.vertices), np.ptp(world_vertices(o), axis=0)) for o in comps), key=lambda r: -float(r[2].max()))[:3]
    detail = ' [Blender sees: ' + '; '.join('%s (%d verts, %.2gx%.2gx%.2g m)' % (n, v, e[0], e[1], e[2]) for n, v, e in biggest) + ']'
    mapped = map_landmarks(job['landmarks'], job.get('bbox'), blender_bbox_as_gltf(all_co), detail, strict=not job.get('baked'))
    L = fit_landmarks(mapped)
    check_landmarks_fit(L, all_co, height)
    cx = L['pelvis'].x
    log('components:', len(comps), 'height:', round(height, 4))

    info = classify(comps, height, opt)
    body = [i['obj'] for i in info if not i['rigid']]
    rigid = [i for i in info if i['rigid']]

    progress(0.14, 'Building the skeleton')
    arm = build_armature(L)
    names = [b.name for b in arm.data.bones]

    # rest-state snapshot for the self-check, taken before any rig exists on the meshes
    rest_co = {o.name: world_vertices(o) for o in comps}
    rest_edges = {}
    for o in comps:
        e = np.empty(len(o.data.edges) * 2, dtype=np.int64)
        o.data.edges.foreach_get('vertices', e)
        rest_edges[o.name] = e.reshape(-1, 2)
    rest_vols = {}
    dg0 = bpy.context.evaluated_depsgraph_get()
    for i in info:
        if not i['rigid'] and is_closed(i['obj']):
            rest_vols[i['obj'].name] = mesh_volume(i['obj'], dg0)

    progress(0.15, 'Solving weights on a watertight body proxy')
    proxy, Wp, voxels, empty, method = skin_proxy(body, arm, names, height, opt)
    patched = fill_unweighted(proxy, Wp, arm, names, height)

    report = {
        'blender': bpy.app.version_string,
        'height': height,
        'components': [{'name': i['obj'].name, 'verts': i['verts'], 'rigid': i['rigid'], 'reason': i['reason']} for i in info],
        'proxy': {'voxels': voxels, 'verts': len(proxy.data.vertices), 'solver_unweighted': empty, 'patched': patched, 'method': method},
        'bones': len(names),
        'warnings': [],
    }
    if any(i.get('fragments_note') for i in info):
        report['warnings'].append('The model is made of many small separate pieces; they were skinned like the body instead of being bound rigidly.')
    if method != 'heat':
        report['warnings'].append('Bone-heat weighting could not solve this body, so a simpler distance-based fallback was used. '
                                  'Weights will be less accurate. Check the markers, and that the mesh is not extremely thin or broken.')
    progress(0.55, 'Transferring weights to the real mesh')

    if opt['skin_thin_on_body']:
        on_body = thin_pieces_on_body(proxy, rigid, height, opt['thin_on_body_frac'])
        for i in on_body:
            i['rigid'], i['reason'], i['as_clothing'] = False, None, True
            body.append(i['obj'])
        rigid = [i for i in rigid if i['rigid']]
        report['thin_pieces_skinned_as_clothing'] = len(on_body)
    transferred, sym_cov, sym_used = transfer(proxy, Wp, body, names, cx, height, opt, height / float(voxels or opt['proxy_voxels']))
    progress(0.60, 'Cleaning up weights')
    locked = 0
    side_removed = 0
    clav_moved = 0
    crotch_z = float(np.mean([(arm.matrix_world @ arm.data.bones['%sUpLeg' % sd].head_local).z for sd in ('Left', 'Right')]))
    # stage 1 (per mesh): side split, limb reach, smoothing along the mesh's own edges
    stage1 = []
    for o in body:
        W = transferred[o.name]
        co = world_vertices(o)
        if opt['side_coherence']:
            W, r1 = side_coherence(W, co, arm, names, height, cx)
            side_removed += r1
        if opt['limb_cap']:
            W, c1 = limb_reach_cap(W, co, arm, names, height, opt['cap_lo'], opt['cap_hi'])
        W = smooth_weights(o, W, opt['smooth_iterations'], opt['smooth_strength'])
        stage1.append((o, W, co))
    # blend BETWEEN meshes, so a sleeve and the torso beside it (or a jacket over a shirt) move as one
    if opt['cross_mesh_blend'] and len(stage1) > 1:
        blended = cross_mesh_blend([x[1] for x in stage1], [x[2] for x in stage1], height, opt['blend_radius'], opt['blend_strength'], crotch_z, cx)
        stage1 = [(o, Wb, co) for (o, _, co), Wb in zip(stage1, blended)]
    # stage 2 (per mesh): re-apply the rules the blend may have softened, then the face / clavicle rules
    staged = []
    for o, W, co in stage1:
        if opt['side_coherence']:
            W, r2 = side_coherence(W, co, arm, names, height, cx)
            side_removed += r2
        if opt['limb_cap']:
            W, c2 = limb_reach_cap(W, co, arm, names, height, opt['cap_lo'], opt['cap_hi'])
        if opt['spine_profile']:
            W = spine_profile(W, co, arm, names)
        if opt['head_lock']:
            W, n_locked = head_lock(W, co, names, L)
            locked += n_locked
        if opt['clavicle_rebalance']:
            W, n_clav = clavicle_rebalance(W, co, arm, names, height)
            clav_moved += n_clav
        staged.append((o, W, co))
    # one last blend between meshes, so the rules above (clavicle, spine, face) cannot reopen a seam
    if opt['cross_mesh_blend'] and len(staged) > 1:
        final = cross_mesh_blend([x[1] for x in staged], [x[2] for x in staged], height, opt['blend_radius'], opt['final_blend_strength'], crotch_z, cx)
        staged = [(o, Wb, co) for (o, _, co), Wb in zip(staged, final)]
    if opt['shoulder_soften']:
        staged = joint_soften(staged, arm, height, opt['shoulder_radius'], opt['shoulder_reach'], opt['shoulder_strength'], (crotch_z, cx), 'Arm')
    if opt['hip_soften']:
        staged = joint_soften(staged, arm, height, 0.004, 0.09, 0.9, (crotch_z, cx), 'UpLeg')
    layer_meshes = 0
    if opt['layer_blend'] and len(staged) > 1:
        blended = layer_blend([x[1] for x in staged], [x[2] for x in staged], [world_normals(x[0]) for x in staged],
                              opt['layer_cell'] * height, opt['layer_strength'])
        staged = [(o, Wb, co) for (o, _, co), Wb in zip(staged, blended)]
        layer_meshes = len(staged)
    # the blends above may have let a little weight cross the middle line again: the side rule has the last word
    if opt['side_coherence']:
        fixed = []
        for o, W, co in staged:
            W, r3 = side_coherence(W, co, arm, names, height, cx)
            side_removed += r3
            fixed.append((o, W, co))
        staged = fixed
    hip_rebalanced = 0
    if opt['hip_rebalance']:
        fixed = []
        for o, W, co in staged:
            W, count = hip_rebalance(W, co, arm, names, height)
            hip_rebalanced += count
            fixed.append((o, W, co))
        staged = fixed
    crotch_vertices = 0
    if opt['crotch_profile']:
        apexes = [crotch_apex(W, co, names, height, cx) for o, W, co in staged]
        apexes = [a for a in apexes if a is not None]
        if apexes:
            apex = min(apexes)          # every layer uses the lowest crotch (the trousers hang lower than the skin)
            fixed = []
            for o, W, co in staged:
                W, count = crotch_profile(W, co, arm, names, height, cx, apex, opt['crotch_width'])
                crotch_vertices += count
                fixed.append((o, W, co))
            staged = fixed
    report['crotch_profile_vertices'] = crotch_vertices
    report['head_locked_vertices'] = locked
    report['side_leak_removed'] = side_removed
    report['clavicle_rebalanced'] = clav_moved
    report['cross_mesh_blend'] = {'applied': bool(opt['cross_mesh_blend'] and len(staged) > 1), 'meshes': len(staged)}
    report['spine_profile'] = bool(opt['spine_profile'])
    report['shoulder_soften'] = bool(opt['shoulder_soften'])
    report['hip_soften'] = bool(opt['hip_soften'])
    report['layer_blend'] = {'applied': bool(layer_meshes), 'meshes': layer_meshes}
    report['hip_rebalanced_vertices'] = hip_rebalanced
    report['symmetry'] = {'coverage': round(sym_cov, 4), 'applied': bool(sym_used)}

    # fingers: added AFTER the body weights are settled (the proxy cannot resolve them), then each vertex's
    # hand weight is split between the palm and the finger bones
    base_names = list(names)
    layouts = None
    if opt['fingers']:
        progress(0.62, 'Adding fingers')
        try:
            layouts = add_fingers(arm, L, body, report)
            names = [b.name for b in arm.data.bones]
            report['bones'] = len(names)
        except Exception as e:  # never lose the whole rig over the fingers
            layouts = None
            report['warnings'].append('Fingers could not be added (%s); the hands are a single bone.' % e)
    wide = []
    hand_fixed = 0
    for o, W, co in staged:
        if layouts:
            Wf = np.zeros((len(W), len(names)), dtype=np.float32)
            # Blender keeps bones depth-first, so adding fingers shifts the other bones' columns: map BY NAME
            for j, bn in enumerate(base_names):
                Wf[:, names.index(bn)] = W[:, j]
            finger_redistribute(co, Wf, names, layouts, height, rest_edges[o.name])
            if opt['hand_isolate']:
                hand_fixed += hand_isolate(Wf, co, names, layouts)
            W = Wf
        W, zero = limit_normalise(W, opt['max_influences'], opt['prune_below'])
        if zero:  # nothing survived pruning: fall back to the nearest bone
            for v in np.where(W.sum(axis=1) < 0.5)[0]:
                bi, _ = nearest_bone(arm, base_names, Vector(co[v]))
                W[v] = 0.0
                W[v, names.index(base_names[bi])] = 1.0
        write_weights(o, arm, names, W)

    for i in rigid:
        o = i['obj']
        co = world_vertices(o)
        bi, d = nearest_bone(arm, base_names, Vector(co.mean(axis=0)))
        W = np.zeros((len(co), len(names)), dtype=np.float32)
        W[:, names.index(base_names[bi])] = 1.0
        if layouts and base_names[bi].endswith('Hand'):
            finger_redistribute(co, W, names, layouts, height, rest_edges[o.name])  # a hand modelled as its own piece gets fingers too
            if opt['hand_isolate']:
                hand_fixed += hand_isolate(W, co, names, layouts)
            W, _ = limit_normalise(W, opt['max_influences'], opt['prune_below'])
        write_weights(o, arm, names, W)
        i['bone'] = base_names[bi]
    report['hand_arm_weight_removed'] = hand_fixed
    report['rigid_bindings'] = [{'name': i['obj'].name, 'bone': i['bone'], 'reason': i['reason']} for i in rigid]

    # remove the proxy
    pm = proxy.data
    bpy.data.objects.remove(proxy, do_unlink=True)
    bpy.data.meshes.remove(pm)

    # final stats straight from what will be exported
    max_inf, unweighted, wsum_err = 0, 0, 0.0
    per_component = {}
    for o in comps:
        W = dense_weights(o, names)
        tot = W.sum(axis=0)
        top = int(tot.argmax())
        per_component[o.name] = {'bone': names[top], 'share': round(float(tot[top] / max(tot.sum(), 1e-9)), 3)}
        s = W.sum(axis=1)
        unweighted += int((s < 0.99).sum())
        wsum_err = max(wsum_err, float(np.abs(s - 1.0).max()))
        max_inf = max(max_inf, int((W > 0).sum(axis=1).max()))
    report['weights'] = {'max_influences': max_inf, 'unweighted_vertices': unweighted, 'max_sum_error': round(wsum_err, 6)}
    report['per_component'] = per_component

    progress(0.65, 'Checking extreme poses')
    if opt['run_self_check']:
        skinned = [i['obj'] for i in info if not i['rigid']]
        report['pose_check'] = self_check(arm, skinned, rest_vols, rest_co, rest_edges, height)

    progress(0.70, 'Exporting')
    report['timings'] = dict(TIMINGS)
    joined = rejoin_pieces(arm)
    report['meshes_out'] = len(joined)
    # export
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    for o in joined:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=job['output'], export_format='GLB', use_selection=True,
        export_skins=True, export_animations=False, export_yup=True,
    )
    progress(1.0, 'Done')
    report['timings'] = dict(TIMINGS)
    report['total_seconds'] = round(time.time() - _T0, 2)
    json.dump(report, open(job['report'], 'w'), indent=2)
    log('done')


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # one readable line, with where it happened, instead of a bare numpy message
        tb = traceback.format_exc().strip().splitlines()
        fail(' | '.join([type(e).__name__ + ': ' + str(e)] + [t.strip() for t in tb[-5:-1]]), 'internal')
