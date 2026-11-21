"""Thumb placement check on synthetic hands. Plain python + numpy, no Blender needed:

    python electron/autorig/test_thumb.py

bpy / bmesh / mathutils are replaced by a tiny stand-in so autorig.py's finger_layout() can run on its own.
Each scenario builds a hand (palm slab, four fingers, a thumb at a known place) in hand coordinates, runs the real
finger_layout() and compares the thumb joints with the true ones. The OLD template is scored too, for reference.
"""
import importlib.util, math, os, sys, types
import numpy as np


class Vector:
    def __init__(self, v=(0, 0, 0)):
        self.v = np.array(list(v), dtype=float)
    def __add__(self, o): return Vector(self.v + o.v)
    def __sub__(self, o): return Vector(self.v - o.v)
    def __mul__(self, k): return Vector(self.v * k)
    __rmul__ = __mul__
    def __truediv__(self, k): return Vector(self.v / k)
    def __neg__(self): return Vector(-self.v)
    def __getitem__(self, i): return self.v[i]
    def __iter__(self): return iter(self.v)
    @property
    def length(self): return float(np.linalg.norm(self.v))
    def dot(self, o): return float(self.v @ o.v)
    def cross(self, o): return Vector(np.cross(self.v, o.v))
    def normalize(self): self.v = self.v / np.linalg.norm(self.v)
    def normalized(self): return Vector(self.v / np.linalg.norm(self.v))
    def copy(self): return Vector(self.v.copy())
    @property
    def x(self): return self.v[0]
    @property
    def z(self): return self.v[2]


for name in ('bpy', 'bmesh'):
    sys.modules[name] = types.ModuleType(name)
mu = types.ModuleType('mathutils'); mu.Vector = Vector; mu.Matrix = object
bv = types.ModuleType('mathutils.bvhtree'); bv.BVHTree = object
kd = types.ModuleType('mathutils.kdtree'); kd.KDTree = object
sys.modules.update({'mathutils': mu, 'mathutils.bvhtree': bv, 'mathutils.kdtree': kd})
spec = importlib.util.spec_from_file_location('autorig', os.path.join(os.path.dirname(__file__), 'autorig.py'))
ar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ar)

rng = np.random.default_rng(3)
FINGER_S = (-0.12, -0.02, 0.08, 0.17)  # index .. pinky centre across the hand at the knuckles
FINGER_TIP = (1.0, 1.04, 0.99, 0.90)    # how far out each finger reaches (the little finger is shortest)


def capsule(a, b, r, n):
    t = rng.random(n)[:, None]
    axis = (b - a) / np.linalg.norm(b - a)
    helper = np.cross(axis, [0, 0, 1.0]); helper /= np.linalg.norm(helper)
    helper2 = np.cross(axis, helper)
    ang = rng.random(n) * 2 * np.pi
    return a + (b - a) * t + r * (np.cos(ang)[:, None] * helper + np.sin(ang)[:, None] * helper2)


def hand(thumb_base, thumb_tip, fan=(0.0, 0.0, 0.0, 0.0), thumb_r=0.06, dense=False):
    """A hand in hand coordinates: palm slab, four fingers (fan = each finger's sideways slope), a thumb."""
    thumb_base, thumb_tip = np.array(thumb_base, float), np.array(thumb_tip, float)
    palm_end = 0.62 if dense else 0.55  # dense (mesh-shape test): the palm fills the webbing, so the fingers part at 0.62
    n_palm = 12000 if dense else 1500  # dense: a connected palm surface
    pts = [np.stack([rng.uniform(0.0, palm_end, n_palm), rng.uniform(-0.17, 0.2, n_palm), rng.uniform(-0.04, 0.04, n_palm)], axis=1)]
    axes = []
    for s0, tip_u, k in zip(FINGER_S, FINGER_TIP, fan):
        a = np.array([0.55, s0, -0.02]); b = np.array([tip_u, s0 + k * (tip_u - 0.55), -0.02])
        pts.append(capsule(a, b, 0.028 if dense else 0.04, 2500 if dense else 600)); axes.append((a, b))  # dense: fingers are separate pieces of surface
    pts.append(capsule(thumb_base, thumb_tip, thumb_r, 900))
    return np.concatenate(pts), thumb_base, thumb_tip, axes


def run(side, thumb_base, thumb_tip, fan=(0.0, 0.0, 0.0, 0.0), with_edges=False):
    P, tb, tt, axes = hand(thumb_base, thumb_tip, fan, dense=with_edges)
    edges = None
    if with_edges:  # the mesh connections: neighbouring surface points, like triangle edges (fingers stay separate pieces)
        from scipy.spatial import cKDTree
        edges = np.array(sorted(cKDTree(P).query_pairs(0.016)), dtype=np.int64)
    wrist, fingertip = Vector((0, 0, 0)), Vector((0, 0, 1.0))  # hand along +Z for the stand-in; L = 1
    a, ex, up, L = ar.hand_frame(wrist.copy(), fingertip.copy(), side)
    sg = 1.0 if side == 'Left' else -1.0
    world = np.array([(a.v * u + ex.v * (s * sg) + up.v * w) * L for u, s, w in P])
    layout, _, info = ar.finger_layout(wrist.copy(), fingertip.copy(), side, world, edges)

    def to_hand(vs):
        return np.array([[(Vector(v) - wrist).dot(a), (Vector(v) - wrist).dot(ex) * sg, (Vector(v) - wrist).dot(up)] for v in [p.v for p in vs]])
    return to_hand(layout['Thumb']), tb, tt, {f: to_hand(layout[f]) for f in ar.FINGER_NAMES}, axes, info


def dist_to_segment(p, a, b):
    ab = b - a
    t = np.clip(((p - a) @ ab) / (ab @ ab), 0, 1)
    return float(np.linalg.norm(p - (a + t * ab)))


failed = False


def check(label, ok, detail=''):
    global failed
    failed |= not ok
    print('%-62s %s  %s' % (label, 'ok' if ok else 'FAIL', detail))


THUMBS = {
    'thumb where the template expects it': ((0.10, -0.12, -0.05), (0.56, -0.42, -0.06)),
    'thumb further back': ((0.06, -0.12, -0.05), (0.46, -0.40, -0.06)),
    'less splayed, nearer the index': ((0.08, -0.14, -0.05), (0.52, -0.30, -0.06)),
    'strongly splayed': ((0.10, -0.12, -0.05), (0.42, -0.52, -0.06)),
}
for side in ('Left', 'Right'):
    for label, (b, t) in THUMBS.items():
        th, tb, tt, fingers, axes, info = run(side, b, t)
        chord = tt - tb
        length = np.linalg.norm(chord)
        axis = chord / length
        base_fwd = (th[0] - tb) @ axis / length                  # how far along the thumb the first joint starts
        tip_err = float(np.linalg.norm(th[3] - tt))
        off_axis = max(dist_to_segment(p, tb, tt) for p in th)    # every joint inside the thumb
        seg = np.linalg.norm(np.diff(th, axis=0), axis=1)
        check('%-5s %s: base forward, tip near the end, joints inside' % (side, label),
              info['used'] and 0.10 <= base_fwd <= 0.45 and tip_err < 0.08 and off_axis < 0.07 and seg.sum() < length,
              'base %.2f of the way, tip off by %.3f, off-axis %.3f, length %.2f vs %.2f' % (base_fwd, tip_err, off_axis, seg.sum(), length))

# fingers: straight (like Blue), and fanned out (like a wide cartoon glove): bones follow, tips reach the ends
# a hand's fingers fan out in proportion across the hand (the outer fingers most), which is what the fit assumes
FANS = {'straight fingers': (0, 0, 0, 0), 'fan out to the thumb side': (-0.30, -0.20, -0.10, 0.0), 'fan out to the little-finger side': (0.0, 0.10, 0.20, 0.30), 'fan out both ways': (-0.20, -0.07, 0.07, 0.20)}
for side in ('Left', 'Right'):
    for label, fan in FANS.items():
        th, tb, tt, fingers, axes, info = run(side, *THUMBS['thumb where the template expects it'], fan=fan)
        worst, tips, shrink = 0.0, 0.0, True
        for f, (a, b) in zip(ar.FINGER_NAMES, axes):
            J = fingers[f]
            worst = max(worst, max(dist_to_segment(p, a, b) for p in J))
            tips = max(tips, abs(J[3][0] - (b[0] - ar.FINGER_TIP_INSET)))
            seg = np.linalg.norm(np.diff(J, axis=0), axis=1)
            shrink &= bool(seg[0] > seg[1] > seg[2])
        check('%-5s %s: bones inside the fingers, tips at their ends, phalanges shrink' % (side, label),
              worst < 0.035 and tips < 0.05 and shrink, 'worst %.3f off axis, tips off by %.3f' % (worst, tips))

# the same fans through the mesh-shape method (needs the mesh connections): each finger is its own piece of surface
for side in ('Left', 'Right'):
    for label, fan in FANS.items():
        th, tb, tt, fingers, axes, info = run(side, *THUMBS['thumb where the template expects it'], fan=fan, with_edges=True)
        used = all(v.get('method') == 'shape' for v in info['fingers'].values())
        worst, tips = 0.0, 0.0
        for f, (a, b) in zip(ar.FINGER_NAMES, axes):
            J = fingers[f]
            worst = max(worst, max(dist_to_segment(p, a, b) for p in J))
            tips = max(tips, abs(J[3][0] - (b[0] - ar.FINGER_TIP_INSET)))
        roots = [fingers[f][0][0] for f in ar.FINGER_NAMES]
        check('%-5s %s (mesh shape): own axes, tips at the ends, knuckles where they part' % (side, label),
              used and worst < 0.03 and tips < 0.04 and all(0.60 <= r <= 0.70 for r in roots),
              'method shape %s, worst %.3f off axis, tips off by %.3f, knuckles at %.2f..%.2f' % (used, worst, tips, min(roots), max(roots)))

# no thumb-like vertices at all: must fall back to the template, not crash or invent a thumb
P = np.stack([rng.uniform(0, 0.55, 2000), rng.uniform(-0.1, 0.2, 2000), rng.uniform(-0.04, 0.04, 2000)], axis=1)
joints, info = ar.fit_thumb(P[:, 0], P[:, 1], P[:, 2], -0.17, ar.FINGER_TEMPLATE['Thumb'])
check('no thumb in the mesh -> template thumb', joints is None, str(info))
# no fingers either: every finger keeps its template joints
out, finfo = ar.fit_fingers(P[:, 0], P[:, 1], P[:, 2], {f: np.array(ar.FINGER_TEMPLATE[f]) for f in ar.FINGER_NAMES})
check('no fingers in the mesh -> template fingers', not any(v['used'] for v in finfo.values()), str(finfo))
sys.exit(1 if failed else 0)
