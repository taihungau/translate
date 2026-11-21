"""Reads an Avatar SDK "Head 2.0" bust (.glb) for the texture tools: its mesh, its texture, the
islands of the mesh in the texture, and where the photo of the person lies in it.

The bust's texture has, on the right, the photo the head was made from (unwrapped: the face seen
from the front, hair and shoulders smeared out to the sides); most of the head is painted straight
from it. The middle of the face (around the eyes, the nose, the mouth) is painted from a second,
denser island on the left, unwrapped so that lids, nostrils and lips have room; eyeballs, teeth
and the inside of the mouth have islands of their own.
"""
import json
import struct

import cv2
import numpy as np

COMPONENT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class Bust:
    def __init__(self, path):
        data = open(path, "rb").read()
        magic, _version, _length = struct.unpack_from("<4sII", data, 0)
        assert magic == b"glTF"
        n = struct.unpack_from("<I", data, 12)[0]
        self.gltf = g = json.loads(data[20:20 + n])
        self.bin = data[20 + n + 8:]
        prim = g["meshes"][0]["primitives"][0]
        self.idx = self.accessor(prim["indices"]).astype(np.int64).reshape(-1, 3)
        self.pos = self.accessor(prim["attributes"]["POSITION"]).astype(np.float64)
        self.uv = self.accessor(prim["attributes"]["TEXCOORD_0"]).astype(np.float64)
        self.joints = self.accessor(prim["attributes"]["JOINTS_0"])
        self.weights = self.accessor(prim["attributes"]["WEIGHTS_0"]).astype(np.float64)
        self.target_names = g["meshes"][0]["extras"]["targetNames"]
        self._targets = prim["targets"]
        tex = g["textures"][g["materials"][prim["material"]]["pbrMetallicRoughness"]["baseColorTexture"]["index"]]
        view = g["bufferViews"][g["images"][tex["source"]]["bufferView"]]
        raw = np.frombuffer(self.bin, np.uint8, view["byteLength"], view.get("byteOffset", 0))
        self.texture = cv2.imdecode(raw, cv2.IMREAD_COLOR)  # BGR
        self.th, self.tw = self.texture.shape[:2]
        self.px = self.uv * [self.tw, self.th]  # every vertex, in texture pixels
        skin = g["skins"][0]
        self.joint_names = [g["nodes"][j]["name"] for j in skin["joints"]]
        self._islands()
        self._normals()

    def accessor(self, i):
        a = self.gltf["accessors"][i]
        view = self.gltf["bufferViews"][a["bufferView"]]
        dtype = COMPONENT[a["componentType"]]
        width = WIDTH[a["type"]]
        start = view.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = view.get("byteStride")
        if stride and stride != np.dtype(dtype).itemsize * width:
            rows = np.frombuffer(self.bin, np.uint8, stride * a["count"], start).reshape(a["count"], stride)
            return rows[:, :np.dtype(dtype).itemsize * width].copy().view(dtype).reshape(a["count"], width)
        out = np.frombuffer(self.bin, dtype, a["count"] * width, start)
        return out.reshape(a["count"], width) if width > 1 else out.copy()

    def target(self, name):
        """A face shape's movement of every vertex (metres)."""
        return self.accessor(self._targets[self.target_names.index(name)]["POSITION"]).astype(np.float64)

    def node_position(self, name):
        """A bone's place in the world (the busts' bones have no rotation or scale)."""
        nodes = self.gltf["nodes"]
        parent = {c: i for i, node in enumerate(nodes) for c in node.get("children", [])}
        i = next(k for k, node in enumerate(nodes) if node.get("name") == name)
        p = np.zeros(3)
        while i is not None:
            p += nodes[i].get("translation", [0, 0, 0])
            i = parent.get(i)
        return p

    def _islands(self):
        n = len(self.pos)
        parent = np.arange(n)

        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        for a, b, c in self.idx:
            ra = find(a)
            parent[find(b)] = ra
            parent[find(c)] = ra
        self.island = np.array([find(i) for i in range(n)])
        roots, counts = np.unique(self.island, return_counts=True)
        order = roots[np.argsort(-counts)]
        self.islands = []
        eye_joints = [i for i, name in enumerate(self.joint_names) if name.lower().startswith("eye")]
        eye_weight = np.where(np.isin(self.joints, eye_joints), self.weights, 0).sum(1)
        square = self.th / self.tw  # the left square of the 2:1 texture ends at u = 0.5
        for root in order:
            verts = np.flatnonzero(self.island == root)
            lo, hi = self.px[verts].min(0), self.px[verts].max(0)
            if (eye_weight[verts] > 0.5).mean() > 0.5:
                kind = "eye"
            elif root == order[0]:
                kind = "photo"
            elif hi[0] > square * self.tw + 4:
                kind = "base"  # the flat underside of the bust
            elif len(verts) > 2000:
                kind = "middle"  # the middle of the face
            elif hi[0] < 820 * self.tw / 4096 and hi[1] < 560 * self.th / 2048:
                kind = "tooth"
            else:
                kind = "mouth"
            self.islands.append({"root": root, "verts": verts, "kind": kind, "lo": lo, "hi": hi,
                                 "tris": np.flatnonzero(self.island[self.idx[:, 0]] == root)})
        self.kind_of_vertex = np.empty(n, dtype=object)
        for isl in self.islands:
            self.kind_of_vertex[isl["verts"]] = isl["kind"]

    def _normals(self):
        """Smooth normals: summed over vertices that share a place, as prep-bust.mjs does."""
        key = np.round(self.pos * 2e5).astype(np.int64)
        _, self.place = np.unique(key, axis=0, return_inverse=True)
        self.place = self.place.reshape(-1)
        a, b, c = (self.pos[self.idx[:, k]] for k in range(3))
        face = np.cross(b - a, c - a)
        total = np.zeros((self.place.max() + 1, 3))
        for k in range(3):
            np.add.at(total, self.place[self.idx[:, k]], face)
        n = total[self.place]
        self.normal = n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)

    def of(self, kind):
        return [i for i in self.islands if i["kind"] == kind]

    def openings(self, island):
        """The holes in an island: loops of edges that belong to one triangle only. Each as its vertices."""
        tris = self.idx[island["tris"]]
        edges = np.sort(np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]]), axis=1)
        uniq, counts = np.unique(edges, axis=0, return_counts=True)
        rim = uniq[counts == 1]
        near = {}
        for a, b in rim:
            near.setdefault(int(a), []).append(int(b))
            near.setdefault(int(b), []).append(int(a))
        seen, loops = set(), []
        for start in near:
            if start in seen:
                continue
            stack, verts = [start], []
            seen.add(start)
            while stack:
                v = stack.pop()
                verts.append(v)
                for w in near[v]:
                    if w not in seen:
                        seen.add(w)
                        stack.append(w)
            loops.append(np.array(verts))
        return loops
