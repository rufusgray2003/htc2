"""Packs the 3D models into models.js (base64 GLB files the game loads at start-up).

Usage: python3 tools/pack_models.py <Universal Base Characters[Standard] folder> <bike.glb>

- Character: Quaternius "Universal Base Characters" Superhero_Male (CC0), plus the beard and
  buzz-cut hair. Unused vertex data and the normal/roughness maps are dropped and textures shrunk.
- Bike: "Bicycle" by jeremy on Poly Pizza (CC-BY 3.0). Split into frame / front wheel / rear wheel /
  crank so the wheels and pedals can spin, and scaled to metres.
"""
import base64, io, json, os, struct, sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_gltf(path):
    if path.endswith('.glb'):
        d = open(path, 'rb').read(); n = struct.unpack_from('<I', d, 12)[0]
        j = json.loads(d[20:20 + n]); return j, [d[20 + n + 8:]], os.path.dirname(path)
    j = json.load(open(path)); base = os.path.dirname(path)
    return j, [open(os.path.join(base, b['uri']), 'rb').read() for b in j['buffers']], base


def accessor(j, bufs, i):
    a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]
    dt = np.dtype(DT[a['componentType']]); k = NC[a['type']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0); stride = bv.get('byteStride')
    buf = bufs[bv['buffer']]
    if stride and stride != dt.itemsize * k:
        rows = [np.frombuffer(buf, dt, k, off + r * stride) for r in range(a['count'])]
        arr = np.array(rows)
    else:
        arr = np.frombuffer(buf, dt, a['count'] * k, off).reshape(-1, k).copy()
    return arr if k > 1 else arr[:, 0]


class GLB:
    """Minimal glTF 2.0 binary writer."""
    def __init__(self):
        self.j = {'asset': {'version': '2.0', 'generator': 'htc2 pack_models.py'}, 'scene': 0, 'scenes': [{'nodes': []}],
                  'nodes': [], 'meshes': [], 'materials': [], 'accessors': [], 'bufferViews': [], 'buffers': [],
                  'textures': [], 'images': [], 'samplers': [{'magFilter': 9729, 'minFilter': 9987}], 'skins': []}
        self.bin = bytearray()

    def view(self, data, target=None):
        while len(self.bin) % 4: self.bin.append(0)
        bv = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target: bv['target'] = target
        self.bin += data; self.j['bufferViews'].append(bv); return len(self.j['bufferViews']) - 1

    def acc(self, arr, ctype, typ, target=None, minmax=False):
        arr = np.ascontiguousarray(arr.astype(DT[ctype]))
        a = {'bufferView': self.view(arr.tobytes(), target), 'componentType': ctype, 'count': len(arr), 'type': typ}
        if minmax: a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
        self.j['accessors'].append(a); return len(self.j['accessors']) - 1

    def image(self, im, fmt):
        b = io.BytesIO(); im.save(b, fmt, quality=82) if fmt == 'JPEG' else im.save(b, fmt, optimize=True)
        self.j['images'].append({'bufferView': self.view(b.getvalue()), 'mimeType': 'image/' + fmt.lower()})
        self.j['textures'].append({'sampler': 0, 'source': len(self.j['images']) - 1})
        return len(self.j['textures']) - 1

    def material(self, name, color=(1, 1, 1, 1), tex=None):
        pbr = {'baseColorFactor': list(color), 'metallicFactor': 0, 'roughnessFactor': 0.9}
        if tex is not None: pbr['baseColorTexture'] = {'index': tex}
        self.j['materials'].append({'name': name, 'pbrMetallicRoughness': pbr}); return len(self.j['materials']) - 1

    def mesh(self, name, prims):
        self.j['meshes'].append({'name': name, 'primitives': prims}); return len(self.j['meshes']) - 1

    def prim(self, pos, nrm, idx, mat, uv=None, joints=None, weights=None):
        attrs = {'POSITION': self.acc(pos, 5126, 'VEC3', 34962, True), 'NORMAL': self.acc(nrm, 5126, 'VEC3', 34962)}
        if uv is not None: attrs['TEXCOORD_0'] = self.acc(uv, 5126, 'VEC2', 34962)
        if joints is not None: attrs['JOINTS_0'] = self.acc(joints, 5121 if joints.max() < 256 else 5123, 'VEC4', 34962)
        if weights is not None: attrs['WEIGHTS_0'] = self.acc(weights, 5126, 'VEC4', 34962)
        ct = 5123 if idx.max() < 65536 else 5125
        return {'attributes': attrs, 'indices': self.acc(idx.reshape(-1), ct, 'SCALAR', 34963), 'material': mat}

    def node(self, n, top=False):
        self.j['nodes'].append(n); i = len(self.j['nodes']) - 1
        if top: self.j['scenes'][0]['nodes'].append(i)
        return i

    def bytes(self):
        while len(self.bin) % 4: self.bin.append(0)
        self.j['buffers'] = [{'byteLength': len(self.bin)}]
        for k in [k for k, v in self.j.items() if v == []]: del self.j[k]
        js = json.dumps(self.j, separators=(',', ':')).encode()
        while len(js) % 4: js += b' '
        out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(self.bin))
        return out + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(self.bin), 0x004E4942) + bytes(self.bin)


def pack_man(ubc):
    j, bufs, base = read_gltf(f'{ubc}/Base Characters/Godot - UE/Superhero_Male_FullBody.gltf')
    tex = f'{ubc}/Base Characters/Textures'
    g = GLB()
    skin_tex = g.image(Image.open(f'{tex}/T_Superhero_Male_Ligh.png').convert('RGB').resize((1024, 1024), Image.LANCZOS), 'JPEG')
    hair_tex = g.image(Image.open(f'{ubc}/Hairstyles/Textures/T_Hair_1_BaseColor.png').convert('RGB').resize((256, 256), Image.LANCZOS), 'JPEG')
    eye_tex = g.image(Image.open(f'{tex}/T_Eye_Brown.png').convert('RGB').resize((64, 64), Image.LANCZOS), 'JPEG')
    mats = {'MI_Superhero_Male': g.material('Body', tex=skin_tex), 'MI_Hair_1': g.material('Hair', tex=hair_tex),
            'MI_Eyes': g.material('Eyes', tex=eye_tex)}
    # Copy the node tree as-is (same indices), rewriting meshes.
    for nd in j['nodes']:
        nd = dict(nd)
        if 'mesh' in nd:
            m = j['meshes'][nd['mesh']]; prims = []
            for p in m['primitives']:
                A = p['attributes']
                prims.append(g.prim(accessor(j, bufs, A['POSITION']), accessor(j, bufs, A['NORMAL']),
                                    accessor(j, bufs, p['indices']), mats[j['materials'][p['material']]['name']],
                                    uv=accessor(j, bufs, A['TEXCOORD_0']), joints=accessor(j, bufs, A['JOINTS_0']),
                                    weights=accessor(j, bufs, A['WEIGHTS_0'])))
            nd['mesh'] = g.mesh(nd['name'], prims)
        g.node(nd)
    g.j['scenes'][0]['nodes'] = list(j['scenes'][j.get('scene', 0)]['nodes'])
    sk = dict(j['skins'][0]); sk['inverseBindMatrices'] = g.acc(accessor(j, bufs, sk['inverseBindMatrices']), 5126, 'MAT4')
    g.j['skins'].append(sk)
    # Hair pieces: static meshes in the body's bind-pose space; the game parents them to the head bone.
    for name in ['Hair_Beard', 'Hair_Buzzed']:
        hj, hb, _ = read_gltf(f'{ubc}/Hairstyles/Origin at 0/glTF (Godot)/{name}.gltf')
        p = hj['meshes'][0]['primitives'][0]; A = p['attributes']
        mi = g.mesh(name, [g.prim(accessor(hj, hb, A['POSITION']), accessor(hj, hb, A['NORMAL']), accessor(hj, hb, p['indices']),
                                  mats['MI_Hair_1'], uv=accessor(hj, hb, A['TEXCOORD_0']))])
        g.node({'name': name, 'mesh': mi}, top=True)
    return g.bytes()


def pack_bike(path):
    j, bufs, _ = read_gltf(path)
    S = 0.094                       # model units -> metres (wheel radius ~0.34 m)
    R = 3.6                         # wheel radius in model units
    wheels = {'WheelF': np.array([3.64, -8.3]), 'WheelR': np.array([3.64, 4.1])}  # (y, z) hub centres
    g = GLB()
    parts = {k: [] for k in ['Frame', 'WheelF', 'WheelR', 'Crank']}
    colors = {}
    grey = None
    for p in j['meshes'][0]['primitives']:
        P = accessor(j, bufs, p['attributes']['POSITION']); N = accessor(j, bufs, p['attributes']['NORMAL'])
        I = accessor(j, bufs, p['indices']).reshape(-1, 3)
        name = j['materials'][p['material']]['name']; colors[name] = j['materials'][p['material']]['pbrMetallicRoughness']['baseColorFactor']
        if name == '78909C': grey = (P, I)
        C = P[I].mean(1)              # triangle centroids
        owner = np.array(['Frame'] * len(I), dtype=object)
        if name in ('1A1A1A', '78909C'):
            for wname, c in wheels.items():
                # every corner inside the wheel (so the chain, which runs out to the crank, stays put)
                far = np.hypot(P[I][:, :, 1] - c[0], P[I][:, :, 2] - c[1]).max(1)
                owner[(far < R + 0.1) & (np.abs(C[:, 0]) < 0.75)] = wname
        parts_for = {}
        for o in set(owner): parts_for[o] = I[owner == o]
        for o, tris in parts_for.items(): parts[o].append((name, P, N, tris))
    # Crank: grey triangles left in the frame near the bottom bracket.
    Pg, _ = grey
    frame_grey = [t for t in parts['Frame'] if t[0] == '78909C'][0]
    C = frame_grey[1][frame_grey[3]].mean(1)
    bb = np.array([np.median(C[:, 1]), np.median(C[:, 2])])
    near = np.hypot(C[:, 1] - bb[0], C[:, 2] - bb[1]) < 2.2
    parts['Crank'].append(('78909C', frame_grey[1], frame_grey[2], frame_grey[3][near]))
    parts['Frame'] = [t if t[0] != '78909C' else (t[0], t[1], t[2], t[3][~near]) for t in parts['Frame']]
    centres = dict(wheels, Crank=bb, Frame=np.array([0.0, 0.0]))
    mats = {k: g.material(k, tuple(v)) for k, v in colors.items()}
    for part, pieces in parts.items():
        prims = []
        cy, cz = centres[part]
        for name, P, N, tris in pieces:
            if not len(tris): continue
            used, inv = np.unique(tris.reshape(-1), return_inverse=True)
            pos = P[used].copy(); pos[:, 1] -= cy; pos[:, 2] -= cz; pos *= S
            prims.append(g.prim(pos, N[used], inv.reshape(-1, 3), mats[name]))
        g.node({'name': part, 'mesh': g.mesh(part, prims), 'translation': [0.0, float(cy * S), float(cz * S)]}, top=True)
    print('bike bottom bracket (y, z) m:', np.round(bb * S, 3), 'wheel centres m:', {k: np.round(v * S, 3).tolist() for k, v in wheels.items()})
    return g.bytes()


if __name__ == '__main__':
    ubc, bike = sys.argv[1], sys.argv[2]
    man = pack_man(ubc); bk = pack_bike(bike)
    out = os.path.join(ROOT, 'models.js')
    with open(out, 'w') as f:
        f.write('// Generated by tools/pack_models.py. 3D models as base64 GLB.\n'
                '// Character: Quaternius, Universal Base Characters (CC0). Bike: "Bicycle" by jeremy, Poly Pizza (CC-BY 3.0).\n')
        f.write('window.HTC_MODELS = {\n')
        f.write(f'  man: "{base64.b64encode(man).decode()}",\n')
        f.write(f'  bike: "{base64.b64encode(bk).decode()}",\n')
        f.write('};\n')
    print('man', len(man) // 1024, 'KB  bike', len(bk) // 1024, 'KB  ->', out, os.path.getsize(out) // 1024, 'KB')
