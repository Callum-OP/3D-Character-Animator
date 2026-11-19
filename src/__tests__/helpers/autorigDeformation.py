"""Focused tests of the auto-rigger's hand and pelvis weights, run inside Blender."""
import importlib.util
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.dont_write_bytecode = True
script = sys.argv[sys.argv.index('--') + 1]
spec = importlib.util.spec_from_file_location('autorig', script)
rig = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rig)

bpy.ops.wm.read_factory_settings(use_empty=True)
points = {
    'pelvis': (0, 0, 0.95), 'spine': (0, 0, 1.10), 'chest': (0, 0, 1.25),
    'upper_chest': (0, 0, 1.38), 'neck': (0, 0, 1.52), 'head': (0, 0, 1.58),
    'head_top': (0, 0, 1.8),
}
for side, sign in (('l', 1), ('r', -1)):
    points.update({
        side + '_shoulder': (sign * 0.2, 0, 1.45), side + '_elbow': (sign * 0.52, 0, 1.45),
        side + '_wrist': (sign * 0.8, 0, 1.45), side + '_fingertip': (sign * 0.98, 0, 1.45),
        side + '_hip': (sign * 0.1, 0, 0.92), side + '_knee': (sign * 0.1, 0, 0.5),
        side + '_ankle': (sign * 0.1, 0, 0.08), side + '_toe': (sign * 0.1, -0.12, 0.04),
        side + '_toe_tip': (sign * 0.1, -0.22, 0.03),
        side + '_clavicle': (sign * 0.07, 0, 1.49),
    })
L = {key: Vector(value) for key, value in points.items()}
arm = rig.build_armature(L)
base_names = [bone.name for bone in arm.data.bones]

# The upper pelvis must transition smoothly, while lower legs remain isolated.
co = np.column_stack((np.linspace(0, 0.02, 401), np.zeros(401), np.full(401, 0.92)))
weights = np.zeros((len(co), len(base_names)), dtype=np.float32)
hips = base_names.index('Hips')
left = base_names.index('LeftUpLeg')
right = base_names.index('RightUpLeg')
weights[:, hips], weights[:, left], weights[:, right] = 0.4, 0.3, 0.3
result, _ = rig.side_coherence(weights, co, arm, base_names, 1.8)
assert np.max(np.abs(np.diff(result[:, right]))) < 0.03
assert result[0, right] > 0.29 and result[-1, right] < 1e-5
assert result[-1, hips] > 0.56 and result[-1, left] > 0.42
again, _ = rig.side_coherence(result, co, arm, base_names, 1.8)
assert np.max(np.abs(again - result)) < 1e-5
lower = np.array([[0.08, 0, 0.5], [-0.08, 0, 0.5], [0, 0, 0.5]])
lower_result, _ = rig.side_coherence(weights[:3], lower, arm, base_names, 1.8)
assert lower_result[0, right] == 0 and lower_result[1, left] == 0
assert lower_result[2, right] == 0
assert np.allclose(lower_result.sum(axis=1), 1)
distances = rig.bone_distances
try:
    def near_tie(points, armature, bone_names):
        d = np.ones((len(points), len(bone_names)))
        d[:, bone_names.index('LeftLeg')] = 0.01045
        d[:, bone_names.index('RightLeg')] = 0.01
        return d
    rig.bone_distances = near_tie
    near, _ = rig.side_coherence(weights[:1], np.array([[0.001, 0, 0.51]]), arm, base_names, 1.8)
    assert near[0, right] == 0 and near[0, left] > 0.42
finally:
    rig.bone_distances = distances

# Hip smoothing blends nearby layers, leaves distant vertices alone, and does not
# blend the two sides together below the crotch.
layer_co = np.array([[0.10, 0, 0.92], [0.1005, 0, 0.92], [0, 0, 1.52]])
layer_weights = np.zeros((3, len(base_names)), dtype=np.float32)
layer_weights[0, hips] = layer_weights[2, hips] = 1
layer_weights[1, left] = 1
soft = rig.joint_soften([(None, layer_weights, layer_co)], arm, 1.8, 0.004, 0.09, 0.9, (0.92, 0), 'UpLeg')[0][1]
assert 0 < soft[0, left] < 1 and 0 < soft[1, hips] < 1
assert np.array_equal(soft[2], layer_weights[2])
assert np.allclose(soft.sum(axis=1), 1)
leg_co = np.array([[0.001, 0, 0.90], [-0.001, 0, 0.90]])
leg_weights = np.zeros((2, len(base_names)), dtype=np.float32)
leg_weights[0, left] = leg_weights[1, right] = 1
soft = rig.joint_soften([(None, leg_weights, leg_co)], arm, 1.8, 0.004, 0.09, 0.9, (0.92, 0), 'UpLeg')[0][1]
assert np.array_equal(soft, leg_weights)

# Thigh leakage into the waist is transferred to Hips, without changing unrelated
# weights or restricting the lower thighs. The operation must be stable on repeat.
pelvis_co = np.array([[0.1, 0, z] for z in np.linspace(0.65, 1.22, 501)])
pelvis_weights = np.zeros((len(pelvis_co), len(base_names)), dtype=np.float32)
spine = base_names.index('Spine')
pelvis_weights[:, left], pelvis_weights[:, hips], pelvis_weights[:, spine] = 0.8, 0.1, 0.1
balanced, changed = rig.hip_rebalance(pelvis_weights, pelvis_co, arm, base_names, 1.8)
assert changed > 0
assert np.array_equal(balanced[0], pelvis_weights[0])
assert balanced[-1, left] == 0 and abs(balanced[-1, hips] - 0.9) < 1e-6
assert np.allclose(balanced[:, spine], 0.1)
assert np.allclose(balanced.sum(axis=1), 1)
assert np.max(np.abs(np.diff(balanced[:, left]))) < 0.01
again, _ = rig.hip_rebalance(balanced, pelvis_co, arm, base_names, 1.8)
assert np.allclose(again, balanced)
no_legs = np.zeros_like(pelvis_weights)
no_legs[:, hips] = 1
unchanged, count = rig.hip_rebalance(no_legs, pelvis_co, arm, base_names, 1.8)
assert count == 0 and np.array_equal(unchanged, no_legs)
probe_co = np.array([[0.1, 0, 0.7], [0.1, 0, 0.99]])
probe_weights = np.zeros((2, len(base_names)), dtype=np.float32)
probe_weights[:, left] = 1
corrected, _ = rig.hip_rebalance(probe_weights, probe_co, arm, base_names, 1.8)
objects = []
for label, weights in (('raw', probe_weights), ('balanced', corrected)):
    mesh = bpy.data.meshes.new(label + ' hip probe')
    mesh.from_pydata(probe_co.tolist(), [], [])
    obj = bpy.data.objects.new(label + ' hip probe', mesh)
    bpy.context.scene.collection.objects.link(obj)
    rig.write_weights(obj, arm, base_names, weights)
    objects.append(obj)
leg = arm.pose.bones['LeftUpLeg']
leg.rotation_mode = 'XYZ'
leg.rotation_euler.x = 0.8
bpy.context.view_layer.update()
movements = [np.linalg.norm(rig.evaluated_positions(obj, bpy.context.evaluated_depsgraph_get()) - probe_co, axis=1)
             for obj in objects]
assert abs(movements[0][0] - movements[1][0]) < 1e-5
assert movements[1][1] < movements[0][1] * 0.25
leg.rotation_euler.x = 0
bpy.context.view_layer.update()

# Finger-zone samples describe the four finger lanes, not the thumb.
for side, key, sign in (('Left', 'l', 1), ('Right', 'r', -1)):
    wrist, tip = L[key + '_wrist'], L[key + '_fingertip']
    a, ex, up, length = rig.hand_frame(wrist, tip, side)
    for scale, shift in ((0.8, -0.02), (1.2, 0.03)):
        pts = []
        for finger in ('Index', 'Middle', 'Ring', 'Pinky'):
            center = rig.FINGER_TEMPLATE[finger][1][1] * scale + shift
            for u in (0.7, 0.8, 0.9):
                for angle in np.linspace(0, 2 * np.pi, 16, endpoint=False):
                    pts.append(np.array((wrist + (a * u + ex * ((center + 0.025 * np.cos(angle)) * sign)
                                                       + up * (0.02 * np.sin(angle))) * length)[:]))
        fit, _ = rig.finger_layout(wrist, tip, side, np.array(pts))
        for finger in ('Index', 'Middle', 'Ring', 'Pinky'):
            expected = rig.FINGER_TEMPLATE[finger][1][1] * scale + shift
            actual = (fit[finger][1] - wrist).dot(ex) * sign / length
            assert abs(actual - expected) < 0.025, (side, scale, finger, actual, expected)

# A minimal body supplies vertices to add_fingers without changing the template fit.
mesh = bpy.data.meshes.new('body')
mesh.from_pydata([(0, 0, 0)], [], [])
body = bpy.data.objects.new('body', mesh)
bpy.context.scene.collection.objects.link(body)
layouts = rig.add_fingers(arm, L, [body], {})
names = [bone.name for bone in arm.data.bones]
samples = []
for side in ('Left', 'Right'):
    thumb_direction = None
    for k in (1, 2, 3):
        bone = arm.data.bones['%sHandThumb%d' % (side, k)]
        assert (bone.head_local - layouts[side]['joints']['Thumb'][k - 1]).length < 1e-5
        direction = (bone.tail_local - bone.head_local).normalized()
        if thumb_direction is not None:
            assert direction.dot(thumb_direction) > 0.9999
        thumb_direction = direction
    for finger in rig.FINGERS:
        joints = layouts[side]['joints'][finger]
        # A point just off the middle segment represents the surface of that finger.
        point = np.array(((joints[1] + joints[2]) * 0.5)[:])
        point += np.array(layouts[side]['frame'][2][:]) * 0.002
        samples.append((side, finger, point))
        w = np.zeros((1, len(names)), dtype=np.float32)
        hand = names.index('%sHand' % side)
        forearm = names.index('%sForeArm' % side)
        w[0, hand], w[0, forearm] = 0.7, 0.3
        rig.finger_redistribute(point[None, :], w, names, layouts, 1.8)
        own = [names.index('%sHand%s%d' % (side, finger, k)) for k in (1, 2, 3)]
        other = [names.index('%sHand%s%d' % (side, f, k))
                 for f in rig.FINGERS if f != finger for k in (1, 2, 3)]
        assert w[0, own].sum() > 0.65, (side, finger, w[0, own].sum())
        assert w[0, other].sum() == 0, (side, finger)
        assert abs(w[0, forearm] - 0.3) < 1e-6
        assert abs(w.sum() - 1) < 1e-6

# A surface vertex may be closer to a neighbouring bone than to its own; its
# connected distal finger still has to move as one, not stretch across the gap.
lay = layouts['Left']
middle = lay['joints']['Middle']
index = lay['joints']['Index']
chain = [np.array((middle[1].lerp(middle[2], t))[:]) for t in np.linspace(0.1, 0.9, 20)]
chain[-1] = np.array(index[1].lerp(index[2], 0.9)[:])
chain = np.array(chain)
chain_edges = np.array([(i, i + 1) for i in range(len(chain) - 1)])
hand = names.index('LeftHand')
middle_ids = [names.index('LeftHandMiddle%d' % k) for k in (1, 2, 3)]
index_ids = [names.index('LeftHandIndex%d' % k) for k in (1, 2, 3)]
naive = np.zeros((len(chain), len(names)), dtype=np.float32)
naive[:, hand] = 1
topological = naive.copy()
rig.finger_redistribute(chain, naive, names, {'Left': lay}, 1.8)
rig.finger_redistribute(chain, topological, names, {'Left': lay}, 1.8, chain_edges)
assert naive[-1, index_ids].sum() > 0.9
assert topological[-1, middle_ids].sum() > 0.9
assert topological[-1, index_ids].sum() == 0
chain_mesh = bpy.data.meshes.new('connected finger')
chain_mesh.from_pydata(chain.tolist(), chain_edges.tolist(), [])
chain_obj = bpy.data.objects.new('connected finger', chain_mesh)
bpy.context.scene.collection.objects.link(chain_obj)
rig.write_weights(chain_obj, arm, names, topological)
for finger, expected in (('Index', False), ('Middle', True)):
    bone = arm.pose.bones['LeftHand%s1' % finger]
    bone.rotation_mode = 'XYZ'
    bone.rotation_euler.x = 0.8
    bpy.context.view_layer.update()
    posed = rig.evaluated_positions(chain_obj, bpy.context.evaluated_depsgraph_get())
    moved = np.linalg.norm(posed[-1] - chain[-1])
    assert (moved > 0.005 if expected else moved < 1e-5)
    bone.rotation_euler.x = 0
    bpy.context.view_layer.update()

# A component that still joins two fingers at the web must not be assigned to one finger.
two = np.array([np.array(joints[1].lerp(joints[2], t)[:])
                for joints in (index, middle) for t in np.linspace(0.1, 0.9, 12)])
joined_edges = np.array([(i, i + 1) for i in range(len(two) - 1)])
w = np.zeros((len(two), len(names)), dtype=np.float32)
w[:, hand] = 1
rig.finger_redistribute(two, w, names, {'Left': lay}, 1.8, joined_edges)
assert w[0, index_ids].sum() > 0.9
assert w[-1, middle_ids].sum() > 0.9

# The thumb ends before the other fingers' distal zone. Its connected surface
# should retain thumb ownership even if one vertex is closer to the index root.
for side in ('Left', 'Right'):
    lay = layouts[side]
    thumb, index = lay['joints']['Thumb'], lay['joints']['Index']
    chain = [np.array(thumb[1].lerp(thumb[2], t)[:]) for t in np.linspace(0.05, 0.8, 20)]
    chain[-1] = np.array(thumb[2].lerp(index[0].lerp(index[1], 0.5), 0.5)[:])
    chain = np.array(chain)
    edges = np.array([(i, i + 1) for i in range(len(chain) - 1)])
    w = np.zeros((len(chain), len(names)), dtype=np.float32)
    w[:, names.index('%sHand' % side)] = 1
    naive, connected = w.copy(), w.copy()
    rig.finger_redistribute(chain, naive, names, {side: lay}, 1.8)
    rig.finger_redistribute(chain, connected, names, {side: lay}, 1.8, edges)
    thumb_ids = [names.index('%sHandThumb%d' % (side, k)) for k in (1, 2, 3)]
    index_ids = [names.index('%sHandIndex%d' % (side, k)) for k in (1, 2, 3)]
    assert naive[-1, index_ids].sum() > 0.5
    assert connected[-1, thumb_ids].sum() > 0.5
    assert connected[-1, index_ids].sum() == 0
    mesh = bpy.data.meshes.new(side + ' connected thumb')
    mesh.from_pydata(chain.tolist(), edges.tolist(), [])
    obj = bpy.data.objects.new(side + ' connected thumb', mesh)
    bpy.context.scene.collection.objects.link(obj)
    rig.write_weights(obj, arm, names, connected)
    for finger, moves in (('Thumb', True), ('Index', False)):
        bone = arm.pose.bones['%sHand%s1' % (side, finger)]
        bone.rotation_mode = 'XYZ'
        bone.rotation_euler.x = 0.8
        bpy.context.view_layer.update()
        posed = rig.evaluated_positions(obj, bpy.context.evaluated_depsgraph_get())
        displacement = np.linalg.norm(posed[-1] - chain[-1])
        assert displacement > 0.005 if moves else displacement < 1e-5
        bone.rotation_euler.x = 0
        bpy.context.view_layer.update()

    # A mixed web joining thumb and index must not be assigned to the thumb.
    mixed = np.concatenate((chain[:-1], np.repeat(chain[-1:], 20, axis=0)))
    mixed_edges = np.array([(i, i + 1) for i in range(len(mixed) - 1)])
    w = np.zeros((len(mixed), len(names)), dtype=np.float32)
    w[:, names.index('%sHand' % side)] = 1
    rig.finger_redistribute(mixed, w, names, {side: lay}, 1.8, mixed_edges)
    assert w[-1, index_ids].sum() > 0.5

# Exercise the actual Blender armature modifier: curling one finger must not pull the others.
for side in ('Left', 'Right'):
    joints = layouts[side]['joints']['Thumb']
    samples.append((side, 'Thumb', np.array(joints[1].lerp(joints[2], 0.7)[:])))
sample_co = np.array([point for _, _, point in samples])
sample_mesh = bpy.data.meshes.new('finger samples')
sample_mesh.from_pydata(sample_co.tolist(), [], [])
sample_obj = bpy.data.objects.new('finger samples', sample_mesh)
bpy.context.scene.collection.objects.link(sample_obj)
weights = np.zeros((len(samples), len(names)), dtype=np.float32)
for i, (side, _, _) in enumerate(samples):
    weights[i, names.index('%sHand' % side)] = 1.0
rig.finger_redistribute(sample_co, weights, names, layouts, 1.8)
rig.write_weights(sample_obj, arm, names, weights)
for finger in ('Thumb', 'Index'):
    bone = arm.pose.bones['LeftHand%s1' % finger]
    bone.rotation_mode = 'XYZ'
    bone.rotation_euler.x = 0.8
    bpy.context.view_layer.update()
    posed = rig.evaluated_positions(sample_obj, bpy.context.evaluated_depsgraph_get())
    displacement = np.linalg.norm(posed - sample_co, axis=1)
    for i, (side, current, _) in enumerate(samples):
        if side == 'Left' and current == finger:
            assert displacement[i] > 0.005, (finger, displacement)
        else:
            assert displacement[i] < 1e-5, (finger, side, current, displacement)
    if finger == 'Thumb':
        indices = [i for i, (side, current, _) in enumerate(samples) if side == 'Left' and current == finger]
        rest_length = np.linalg.norm(sample_co[indices[0]] - sample_co[indices[1]])
        posed_length = np.linalg.norm(posed[indices[0]] - posed[indices[1]])
        assert abs(posed_length / rest_length - 1) < 0.02
    bone.rotation_euler.x = 0
    bpy.context.view_layer.update()
