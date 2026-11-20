"""Pure-numpy checks of the auto-rigger's layer blend and hand isolation. No Blender needed:
the bpy-side modules are stubbed so autorig.py can be imported."""
import importlib.util
import sys
import types

import numpy as np

sys.dont_write_bytecode = True
for name in ('bpy', 'bmesh', 'mathutils', 'mathutils.bvhtree', 'mathutils.kdtree'):
    sys.modules[name] = types.ModuleType(name)
sys.modules['mathutils'].Vector = list
sys.modules['mathutils'].Matrix = list
sys.modules['mathutils.bvhtree'].BVHTree = object
sys.modules['mathutils.kdtree'].KDTree = object
script = sys.argv[1]
spec = importlib.util.spec_from_file_location('autorig', script)
rig = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rig)

rng = np.random.default_rng(3)

# --- layer_blend: a shirt 1.5 cm under a jacket moves as one; surfaces facing each other do not mix
def plate(z, n=400, facing=1.0):
    p = np.c_[rng.uniform(0, 0.2, n), rng.uniform(0, 0.2, n), np.full(n, z)]
    nrm = np.tile([0, 0, facing], (n, 1)).astype(float)
    return p, nrm

cols = 3
inner_p, inner_n = plate(0.0)
outer_p, outer_n = plate(0.015)
w_in = np.tile([1.0, 0, 0], (len(inner_p), 1))
w_out = np.tile([0, 1.0, 0], (len(outer_p), 1))
b_in, b_out = rig.layer_blend([w_in, w_out], [inner_p, outer_p], [inner_n, outer_n], 0.02, 1.0)
gap_before = np.abs(w_in - w_out).sum(axis=1).mean()
gap_after = np.abs(b_in - b_out).sum(axis=1).mean()
assert gap_after < 0.7 * gap_before, 'stacked layers should move toward matching weights (%.2f -> %.2f)' % (gap_before, gap_after)
assert np.allclose(b_in.sum(axis=1), 1, atol=1e-5)

a_p, a_n = plate(0.0, facing=1.0)
b_p, b_n = plate(0.015, facing=-1.0)   # faces the other way: like the two sides of an armpit
f_a, f_b = rig.layer_blend([np.tile([1.0, 0, 0], (len(a_p), 1)), np.tile([0, 1.0, 0], (len(b_p), 1))], [a_p, b_p], [a_n, b_n], 0.02, 1.0)
assert f_a[:, 0].min() > 0.99 and f_b[:, 1].min() > 0.99, 'facing surfaces must not exchange weights'

# --- hand_isolate: arm weight is removed from the thumb tip and moves to the finger bone
names = ['LeftForeArm', 'LeftHand', 'LeftHandThumb3', 'LeftHandThumb4']
class V(list):
    pass
lay = {'Left': {'frame': (V([1.0, 0, 0]), None, None, 0.2), 'wrist': V([0.0, 0, 0])}}
co = np.array([[0.02, 0, 0], [0.12, 0.01, 0], [0.13, 0.0, 0.0]])
W = np.array([[1.0, 0, 0, 0], [0.14, 0, 0.86, 0], [0.1, 0.0, 0.0, 0.0]])
n = rig.hand_isolate(W, co, names, lay)
assert np.allclose(W[0], [1, 0, 0, 0]), 'weight near the wrist is untouched'
assert abs(W[1, 0]) < 1e-9 and abs(W[1, 2] - 1.0) < 1e-9, 'thumb tip loses its forearm weight to the thumb bone'
assert abs(W[2, 1] - 0.1) < 1e-9 and W[2, 0] == 0, 'a vertex with no hand weight gets it on the hand'
assert n == 2
print('ok')
