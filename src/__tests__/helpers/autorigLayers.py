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

# --- crotch_profile: every layer gets the same smooth thigh handover across the middle
class P3:
    def __init__(self, x, y, z):
        self.x, self.y, self.z = x, y, z
class Ident:
    def __matmul__(self, v):
        return v
class Bone:
    def __init__(self, x, z):
        self.head_local = P3(x, 0.0, z)
class Arm:
    matrix_world = Ident()
    class data:
        bones = {'LeftUpLeg': Bone(0.06, 0.9), 'RightUpLeg': Bone(-0.06, 0.9)}
nm = ['Hips', 'LeftUpLeg', 'RightUpLeg']
H = 1.7
xs = np.linspace(-0.08, 0.08, 33)
upper = np.c_[xs, np.zeros(33), np.full(33, 0.85)]     # the sheet above the crotch apex
lower = np.c_[xs, np.zeros(33), np.full(33, 0.70)]     # separate inner thighs below it
seam = np.c_[np.linspace(-0.01, 0.01, 30), np.zeros(30), np.linspace(0.80, 0.83, 30)]   # apex z = 0.80
cc = np.concatenate([upper, lower, seam])
one = np.where(cc[:, 0] > 0, 0.9, 0.0)                 # every thigh vertex 100% on its own side...
left = one.copy()
left[-30:] = 0.45                                      # ...except the seam, which carries both thighs
Wc = np.c_[np.full(len(cc), 0.1), left, 0.9 - left]
apex = rig.crotch_apex(Wc, cc, nm, H, 0.0)
assert abs(apex - 0.80) < 1e-9, 'the apex is the lowest vertex that still carries both thighs'
assert rig.crotch_apex(np.tile([1.0, 0, 0], (40, 1)), np.c_[np.linspace(-0.1, 0.1, 40), np.zeros(40), np.full(40, 1.2)], nm, H, 0.0) is None, 'no crotch on a shirt'
out, cnt = rig.crotch_profile(Wc, cc, Arm, nm, H, 0.0, apex, 0.0064)
assert np.allclose(out.sum(axis=1), Wc.sum(axis=1)) and np.allclose(out[:, 0], Wc[:, 0]), 'hips and the total are unchanged'
assert np.allclose(out[33:66], Wc[33:66]), 'below the apex the legs are separate tubes and stay untouched'
ramp = out[:33, 1] / np.maximum(out[:33, 1] + out[:33, 2], 1e-9)
mid = len(xs) // 2
assert abs(ramp[mid] - 0.5) < 1e-6, 'half and half exactly on the middle line'
assert np.all(np.diff(ramp[mid - 6:mid + 7]) >= -1e-9), 'the left share rises steadily across the middle'
assert ramp[mid + 4] > 0.9 and ramp[mid - 4] < 0.1, 'a couple of centimetres out each thigh is nearly all its own'
assert np.allclose(out[0], Wc[0]) and np.allclose(out[32], Wc[32]), 'outside the crotch band nothing changes'
# the skin (100% one thigh) and the cloth next to it (mixed) end up with the same weights at the same spot
skin = Wc[:33].copy(); cloth = Wc[:33].copy(); cloth[:, 1:] = cloth[:, 1:][:, ::-1] * 0 + [0.45, 0.45]
sk_out = rig.crotch_profile(skin, upper, Arm, nm, H, 0.0, apex, 0.0064)[0]
cl_out = rig.crotch_profile(cloth, upper, Arm, nm, H, 0.0, apex, 0.0064)[0]
assert np.allclose(sk_out[mid - 3:mid + 4, 1:], cl_out[mid - 3:mid + 4, 1:] * (sk_out[mid - 3:mid + 4, 1:].sum(1) / cl_out[mid - 3:mid + 4, 1:].sum(1))[:, None]), 'same position, same handover'
print('ok')
