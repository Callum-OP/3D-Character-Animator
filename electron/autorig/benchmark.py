"""Accuracy benchmark for the Auto Rigger. Pure Python + numpy (+ scipy), NO Blender needed.

    python benchmark.py truth.glb rigged.glb result.json

truth.glb  : reference rig for the SAME mesh (e.g. a Mixamo-rigged character). Extra bones such as fingers or
             hair collapse onto their nearest ancestor among the 22 body bones.
rigged.glb : what the Auto Rigger produced.

Both files are skinned straight from their glTF data (joint transforms x inverse bind matrices, exactly how
the app renders them), so Blender's importer cannot skew the comparison. Reports:
  * weight error per vertex (L1) and dominant-bone agreement
  * left/right leakage (weight on the opposite side's limb bones)
  * rest bone-axis match to the reference
  * THE real measure: both rigs posed with identical bone rotations, vertex positions compared (percent of
    body height). Lower is better; 0 = identical deformation.
"""
import json, struct, sys, math
import numpy as np

BODY = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'] + [s + b for s in ('Left', 'Right') for b in ('Shoulder', 'Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot', 'ToeBase')]
SIDE = ('Shoulder', 'Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot', 'ToeBase')
POSES = {
    'arms_down_60': {'LeftArm': (0, 0, 60), 'RightArm': (0, 0, -60)},
    'arms_forward_80': {'LeftArm': (80, 0, 0), 'RightArm': (80, 0, 0)},
    'elbows_bent_110': {'LeftForeArm': (0, 0, 110), 'RightForeArm': (0, 0, -110)},
    'knees_bent_90': {'LeftLeg': (90, 0, 0), 'RightLeg': (90, 0, 0)},
    'legs_apart_35': {'LeftUpLeg': (0, 0, 35), 'RightUpLeg': (0, 0, -35)},
    'leg_raised_80': {'LeftUpLeg': (80, 0, 0)},
    'feet_pointed_40': {'LeftFoot': (40, 0, 0), 'RightFoot': (40, 0, 0)},
    'spine_bend_40': {'Spine': (25, 0, 0), 'Spine1': (25, 0, 0)},
    'spine_twist_50': {'Spine': (0, 25, 0), 'Spine1': (0, 25, 0)},
    # fingers: curl index..pinky 70 degrees at each of the three joints (about their local X), both hands
    'fingers_curl_70': {'%sHand%s%d' % (s, f, k): (70, 0, 0) for s in ('Left', 'Right') for f in ('Index', 'Middle', 'Ring', 'Pinky') for k in (1, 2, 3)},
}
CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def qmat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def euler_xyz(x, y, z):
    """Blender 'XYZ' euler (degrees) -> 3x3 (R = Rz Ry Rx)"""
    x, y, z = map(math.radians, (x, y, z))
    cx, sx, cy, sy, cz, sz = math.cos(x), math.sin(x), math.cos(y), math.sin(y), math.cos(z), math.sin(z)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


class Glb:
    def __init__(self, path):
        b = open(path, 'rb').read()
        jl = struct.unpack('<I', b[12:16])[0]
        self.j = json.loads(b[20:20 + jl])
        off = 20 + jl
        bl = struct.unpack('<I', b[off:off + 4])[0]
        self.bin = b[off + 8:off + 8 + bl]
        self.nodes = self.j['nodes']
        self.parent = {}
        for i, n in enumerate(self.nodes):
            for c in n.get('children', []):
                self.parent[c] = i
        self.name_to_node = {n.get('name'): i for i, n in enumerate(self.nodes)}

    def acc(self, k):
        a = self.j['accessors'][k]
        bv = self.j['bufferViews'][a['bufferView']]
        nc = NC[a['type']]
        dt = np.dtype(CT[a['componentType']])
        stride = bv.get('byteStride') or nc * dt.itemsize
        start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        if stride == nc * dt.itemsize:
            arr = np.frombuffer(self.bin, dtype=dt, count=a['count'] * nc, offset=start).reshape(a['count'], nc)
        else:
            arr = np.stack([np.frombuffer(self.bin, dtype=dt, count=nc, offset=start + i * stride) for i in range(a['count'])])
        if a.get('normalized'):
            arr = arr.astype(np.float32) / np.iinfo(dt).max
        return arr

    def local(self, i, delta=None):
        n = self.nodes[i]
        T = np.eye(4)
        if 'matrix' in n:
            return np.array(n['matrix']).reshape(4, 4).T
        R = qmat(n.get('rotation', [0, 0, 0, 1]))
        if delta is not None:
            R = R @ delta  # pose rotation about the bone's own axes
        S = np.array(n.get('scale', [1, 1, 1]))
        T[:3, :3] = R * S
        T[:3, 3] = n.get('translation', [0, 0, 0])
        return T

    def world(self, deltas=None):
        """world matrix per node, with optional {node: 3x3 pose rotation}"""
        cache = {}

        def g(i):
            if i in cache:
                return cache[i]
            m = self.local(i, (deltas or {}).get(i))
            p = self.parent.get(i)
            cache[i] = (g(p) @ m) if p is not None else m
            return cache[i]
        for i in range(len(self.nodes)):
            g(i)
        return cache

    def skinned_meshes(self):
        """-> list of (positions Nx3, joints Nx4 (skin joint idx), weights Nx4, skin index)"""
        out = []
        for ni, n in enumerate(self.nodes):
            if 'mesh' not in n or 'skin' not in n:
                continue
            for prim in self.j['meshes'][n['mesh']]['primitives']:
                at = prim['attributes']
                if 'JOINTS_0' not in at:
                    continue
                out.append((self.acc(at['POSITION']).astype(np.float64), self.acc(at['JOINTS_0']).astype(np.int64), self.acc(at['WEIGHTS_0']).astype(np.float64), n['skin']))
        return out

    def skin_matrices(self, skin, world):
        s = self.j['skins'][skin]
        ibm = self.acc(s['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
        return np.stack([world[j] @ ibm[k] for k, j in enumerate(s['joints'])])

    def joint_names(self, skin):
        return [self.nodes[j].get('name', '') for j in self.j['skins'][skin]['joints']]

    def collapse(self, skin):
        """skin-joint index -> index into BODY (nearest ancestor among the 22 body bones) or -1"""
        s = self.j['skins'][skin]
        out = []
        for j in s['joints']:
            cur, res = j, -1
            while cur is not None:
                nm = (self.nodes[cur].get('name') or '').replace('mixamorig:', '').replace('mixamorig', '')
                if nm in BODY:
                    res = BODY.index(nm)
                    break
                cur = self.parent.get(cur)
            out.append(res)
        return np.array(out)


def evaluate(path, pose=None):
    """-> positions (all skinned meshes concatenated, world space), body weights (N x 22), per-bone world X axes"""
    g = Glb(path)
    deltas = {}
    if pose:
        for bone, (x, y, z) in pose.items():
            i = g.name_to_node.get('mixamorig:' + bone, g.name_to_node.get('mixamorig' + bone))
            if i is not None:
                deltas[i] = euler_xyz(x, y, z)
    world = g.world(deltas)
    P, W22 = [], []
    for pos, joints, wts, skin in g.skinned_meshes():
        M = g.skin_matrices(skin, world)
        col = g.collapse(skin)
        v = np.concatenate([pos, np.ones((len(pos), 1))], axis=1)
        out = np.zeros((len(pos), 3))
        wb = np.zeros((len(pos), len(BODY)))
        for k in range(4):
            Mk = M[joints[:, k]]
            out += wts[:, k:k + 1] * np.einsum('nij,nj->ni', Mk[:, :3, :], v)
            c = col[joints[:, k]]
            ok = c >= 0
            np.add.at(wb, (np.nonzero(ok)[0], c[ok]), wts[ok, k])
        P.append(out)
        W22.append(wb)
    axes = {}
    for bn in BODY:
        i = g.name_to_node.get('mixamorig:' + bn, g.name_to_node.get('mixamorig' + bn))
        if i is not None:
            axes[bn] = world[i][:3, 0] / max(np.linalg.norm(world[i][:3, 0]), 1e-12)
    return np.concatenate(P), np.concatenate(W22), axes


def run(truth, rigged):
    from scipy.spatial import cKDTree
    tp, tW, tax = evaluate(truth)
    rp, rW, rax = evaluate(rigged)
    height = float(tp[:, 1].max() - tp[:, 1].min())
    dist, match = cKDTree(tp).query(rp)
    G = tW[match]
    body = G.sum(axis=1) > 0.5
    Gn = G / np.maximum(G.sum(axis=1, keepdims=True), 1e-9)
    Rn = rW / np.maximum(rW.sum(axis=1, keepdims=True), 1e-9)
    l1 = np.abs(Gn - Rn).sum(axis=1)
    dom = Gn.argmax(axis=1) == Rn.argmax(axis=1)
    cx = 0.0
    li = [BODY.index('Left' + b) for b in SIDE]
    ri = [BODY.index('Right' + b) for b in SIDE]
    margin = 0.02 * height
    onleft, onright = rp[:, 0] > cx + margin, rp[:, 0] < cx - margin
    side = onleft | onright
    leak = np.maximum(np.where(onleft, rW[:, ri].sum(axis=1), 0), np.where(onright, rW[:, li].sum(axis=1), 0))
    gleak = np.maximum(np.where(onleft, G[:, ri].sum(axis=1), 0), np.where(onright, G[:, li].sum(axis=1), 0))
    regions = {}
    for name, ids in (('arms', [BODY.index(s + b) for s in ('Left', 'Right') for b in ('Shoulder', 'Arm', 'ForeArm', 'Hand')]),
                      ('legs', [BODY.index(s + b) for s in ('Left', 'Right') for b in ('UpLeg', 'Leg')]),
                      ('feet', [BODY.index(s + b) for s in ('Left', 'Right') for b in ('Foot', 'ToeBase')]),
                      ('torso_head', [BODY.index(b) for b in ('Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head')])):
        sel = body & np.isin(Gn.argmax(axis=1), ids)
        if sel.any():
            regions[name] = {'verts': int(sel.sum()), 'mean_l1': round(float(l1[sel].mean()), 4), 'dominant_agree': round(float(dom[sel].mean()), 4)}
    res = {
        'height': round(height, 3), 'verts_compared': int(body.sum()), 'position_match_max_cm': round(float(dist.max() * 100), 4),
        'weights': {'mean_l1': round(float(l1[body].mean()), 4), 'p95_l1': round(float(np.percentile(l1[body], 95)), 4), 'dominant_bone_agreement': round(float(dom[body].mean()), 4)},
        'side_leak': {'truth_verts_over_0.1': round(float((gleak[body & side] > 0.1).mean()), 4), 'rigged_verts_over_0.1': round(float((leak[body & side] > 0.1).mean()), 4), 'rigged_mean': round(float(leak[body & side].mean()), 4)},
        'regions': regions,
        'rest_axes_deg': {bn: round(math.degrees(math.acos(float(np.clip(tax[bn] @ rax[bn], -1, 1)))), 1) for bn in BODY if bn in tax and bn in rax},
    }
    perr = {}
    for pname, rots in POSES.items():
        tpp, _, _ = evaluate(truth, rots)
        rpp, _, _ = evaluate(rigged, rots)
        ev = np.linalg.norm(rpp - tpp[match], axis=1) / height * 100.0
        e = ev[body]
        perr[pname] = {'mean_pct': round(float(e.mean()), 3), 'p95_pct': round(float(np.percentile(e, 95)), 3), 'max_pct': round(float(e.max()), 3)}
        if pname == 'fingers_curl_70':
            hand = body & (np.abs(rp[:, 0]) > 0.60) & (rp[:, 1] > 1.2)  # the hands (arms held out)
            if hand.any():
                perr[pname]['hands_only_mean_pct'] = round(float(ev[hand].mean()), 3)
                perr[pname]['hands_only_p95_pct'] = round(float(np.percentile(ev[hand], 95)), 3)
    res['pose_error_pct_of_height'] = perr
    res['pose_error_mean_pct'] = round(float(np.mean([v['mean_pct'] for v in perr.values()])), 3)
    return res


if __name__ == '__main__':
    out = run(sys.argv[1], sys.argv[2])
    if len(sys.argv) > 3:
        json.dump(out, open(sys.argv[3], 'w'), indent=2)
    print(json.dumps(out, indent=2))
