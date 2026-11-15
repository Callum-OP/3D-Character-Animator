"""
Auto Rigger pipeline. Runs INSIDE the user's own Blender, headless:

  blender --background --factory-startup --disable-autoexec --python autorig.py -- job.json

job.json: { "input": "mesh.glb|obj|ply|fbx", "output": "rigged.glb", "report": "report.json",
            "landmarks": { id: [x, y, z], ... },   (metres, Y up, character faces +Z, character's LEFT is +X)
            "options":   { ... } }

Stages (accuracy first, every stage reports numbers instead of "looks fine"):
  1. import + apply transforms + weld-aware connected components
  2. classify components: body-like (skinned), rigid (thin shells, blades, small solids such as eyes)
  3. template skeleton (Mixamo names) fitted to the landmarks
  4. watertight voxel proxy of the body-like components -> Blender bone-heat weights on the proxy
     (retried at coarser voxel sizes if the solver fails)
  5. transfer proxy weights to every real vertex (nearest surface point, barycentric)
  6. clean up: weld-consistent smoothing, head lock, mirror symmetry, 4 influences, normalise
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
# Template: Mixamo names. (bone, parent, head landmark/expression, tail landmark/expression)
# ----------------------------------------------------------------------------------------------
CENTER_BONES = [
    ('Hips', None, 'pelvis', 'spine'),
    ('Spine', 'Hips', 'spine', 'chest'),
    ('Spine1', 'Spine', 'chest', 'upper_chest'),
    ('Spine2', 'Spine1', 'upper_chest', 'neck'),
    ('Neck', 'Spine2', 'neck', 'head'),
    ('Head', 'Neck', 'head', 'head_top'),
]


# Mixamo's bone local axes (the "roll"), measured from a real Mixamo character, in glTF world space
# (Y up, +Z forward, +X = character left). Y always runs along the bone; this is the local X axis.
# Clips and poses made for any Mixamo rig rotate bones about THESE axes, so a rig that has the right
# bone names but a different roll twists and bends the wrong way (stretched arms, folded legs).
MIXAMO_X = {
    'Hips': (1, 0, 0), 'Spine': (1, 0, 0), 'Spine1': (1, 0, 0), 'Spine2': (1, 0, 0), 'Neck': (1, 0, 0), 'Head': (1, 0, 0),
    'LeftShoulder': (0, 0, -1), 'LeftArm': (0, 0, -1), 'LeftForeArm': (0, 0, -1), 'LeftHand': (0, 0, -1),
    'RightShoulder': (0, 0, 1), 'RightArm': (0, 0, 1), 'RightForeArm': (0, 0, 1), 'RightHand': (0, 0, 1),
    'LeftUpLeg': (-1, 0, 0), 'LeftLeg': (-1, 0, 0), 'LeftFoot': (-1, 0, 0), 'LeftToeBase': (-1, 0, 0),
    'RightUpLeg': (-1, 0, 0), 'RightLeg': (-1, 0, 0), 'RightFoot': (-1, 0, 0), 'RightToeBase': (-1, 0, 0),
}


def side_bones(S):
    s = S  # 'Left' / 'Right'
    k = 'l' if S == 'Left' else 'r'
    return [
        (s + 'Shoulder', 'Spine2', 'upper_chest', k + '_shoulder'),
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
    'side_coherence': True,     # stop the voxel proxy leaking weights between left and right limbs
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


def map_landmarks(raw, three_box, mesh_box):
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
        # thin axes are noisy: only compare axes that are a meaningful fraction of the height
        if et[i] > 0.15 * et[1] and not (0.7 <= (eb[i] / et[i]) / s <= 1.43):
            fail('The model looks different in Blender than in the preview (%s differs: preview %.3g, Blender %.3g, '
                 'relative to height). It is probably rotated or scaled differently in the file. Try exporting it as .glb first.'
                 % (name, et[i] / et[1], eb[i] / eb[1]), 'frame')
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
        b = arm_data.edit_bones.new('mixamorig:' + name)
        b.head, b.tail = L[h].copy(), L[t].copy()
        if (b.tail - b.head).length < 1e-5:
            b.tail = b.head + Vector((0, 0, 0.01))
        # roll: make the bone's X axis the Mixamo one (projected so it stays perpendicular to the bone)
        gx = MIXAMO_X[name]
        want_x = Vector((gx[0], -gx[2], gx[1]))  # glTF -> Blender axes
        y = (b.tail - b.head).normalized()
        x = want_x - y * want_x.dot(y)
        if x.length > 1e-4:
            x.normalize()
            b.align_roll(x.cross(y))  # Blender aligns the bone's Z axis; Z = X cross Y
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


def side_coherence(Wobj, co, arm, names, height):
    """The voxel proxy fuses limbs that sit close together (feet side by side, arms against the torso), so
    heat weights can leak across. A vertex that is nearer the LEFT limb than the RIGHT one by more than a
    small margin must not carry the right limb's weights (and vice versa).
    Legs: the margin is tight on shins and feet (they never share weight with the other leg, even when the
    feet touch) and relaxes toward the crotch, where skinning legitimately blends across the midline.
    Arms: a small constant margin, so the chest centre, equally near both, is left alone."""
    D = bone_distances(co, arm, names)
    W = Wobj.copy()
    z = co[:, 2]
    knee_z = float(np.mean([(arm.matrix_world @ arm.data.bones['mixamorig:%sLeg' % s].head_local).z for s in ('Left', 'Right')]))
    hip_z = float(np.mean([(arm.matrix_world @ arm.data.bones['mixamorig:%sUpLeg' % s].head_local).z for s in ('Left', 'Right')]))
    t = np.clip((z - knee_z) / max(hip_z - knee_z, 1e-6), 0.0, 1.0)
    margins = {'leg': (0.003 + 0.009 * t) * height, 'arm': np.full(len(z), 0.004 * height)}
    removed = 0
    for part, bones in LIMB_PARTS.items():
        li = [names.index('mixamorig:Left' + b) for b in bones]
        ri = [names.index('mixamorig:Right' + b) for b in bones]
        dl, dr = D[:, li].min(axis=1), D[:, ri].min(axis=1)
        m = margins[part]
        is_left = dl + m < dr
        is_right = dr + m < dl
        for sel, kill in ((is_left, ri), (is_right, li)):
            if sel.any():
                rows = np.where(sel)[0]
                removed += int((W[np.ix_(rows, kill)] > 0).sum())
                W[np.ix_(rows, kill)] = 0.0
    # a vertex that lost everything: nearest allowed bones
    empty = W.sum(axis=1) < 1e-6
    if empty.any():
        W[empty] = envelope_weights(co[empty], arm, names, height)
    return W / np.maximum(W.sum(axis=1, keepdims=True), 1e-9), removed


def head_lock(Wobj, co, names, L):
    """Everything clearly above the neck, whose weights are spine/neck/head, is Head 100% (face rule)."""
    head_i = names.index('mixamorig:Head')
    neck_i = names.index('mixamorig:Neck')
    spine_ids = [names.index('mixamorig:' + n) for n in ('Spine', 'Spine1', 'Spine2', 'Hips')]
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
    W[W < prune] = 0.0
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
    'arms_down_80': {'mixamorig:LeftArm': (0, 0, -80), 'mixamorig:RightArm': (0, 0, 80)},
    'elbows_bent_100': {'mixamorig:LeftForeArm': (0, 100, 0), 'mixamorig:RightForeArm': (0, -100, 0)},
    'knees_bent_90': {'mixamorig:LeftLeg': (-90, 0, 0), 'mixamorig:RightLeg': (-90, 0, 0)},
    'hips_flexed_70': {'mixamorig:LeftUpLeg': (-70, 0, 0), 'mixamorig:RightUpLeg': (-70, 0, 0)},
    'spine_bend_40': {'mixamorig:Spine1': (35, 0, 0), 'mixamorig:Spine': (25, 0, 0)},
    'head_turn_60': {'mixamorig:Head': (0, 60, 0)},
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
    mapped = map_landmarks(job['landmarks'], job.get('bbox'), blender_bbox_as_gltf(all_co))
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

    transferred, sym_cov, sym_used = transfer(proxy, Wp, body, names, cx, height, opt, height / float(voxels or opt['proxy_voxels']))
    progress(0.60, 'Cleaning up weights')
    locked = 0
    side_removed = 0
    for o in body:
        W = transferred[o.name]
        co = world_vertices(o)
        if opt['side_coherence']:
            W, r1 = side_coherence(W, co, arm, names, height)
        W = smooth_weights(o, W, opt['smooth_iterations'], opt['smooth_strength'])
        if opt['side_coherence']:
            W, r2 = side_coherence(W, co, arm, names, height)
            side_removed += r1 + r2
        if opt['head_lock']:
            W, n_locked = head_lock(W, co, names, L)
            locked += n_locked
        W, zero = limit_normalise(W, opt['max_influences'], opt['prune_below'])
        if zero:  # nothing survived pruning: fall back to the nearest bone
            for v in np.where(W.sum(axis=1) < 0.5)[0]:
                bi, _ = nearest_bone(arm, names, Vector(co[v]))
                W[v] = 0.0
                W[v, bi] = 1.0
        write_weights(o, arm, names, W)
    report['head_locked_vertices'] = locked
    report['side_leak_removed'] = side_removed
    report['symmetry'] = {'coverage': round(sym_cov, 4), 'applied': bool(sym_used)}

    for i in rigid:
        o = i['obj']
        co = world_vertices(o)
        bi, d = nearest_bone(arm, names, Vector(co.mean(axis=0)))
        W = np.zeros((len(co), len(names)), dtype=np.float32)
        W[:, bi] = 1.0
        write_weights(o, arm, names, W)
        i['bone'] = names[bi]
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
        per_component[o.name] = {'bone': names[top].replace('mixamorig:', ''), 'share': round(float(tot[top] / max(tot.sum(), 1e-9)), 3)}
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
