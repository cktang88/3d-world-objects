"""Minimal USDA (as written by sand3d) -> GLB converter. Stdlib only.

Handles: nested Xform/Scope prims with translate / orient / scale / rotateXYZ /
transform ops, Mesh prims (points, faceVertexCounts, faceVertexIndices,
vertex or faceVarying normals), UsdPreviewSurface materials bound with
material:binding (diffuseColor, roughness, metallic, opacity, emissiveColor).

Output GLB is Y-up, metres, centred on X/Z with its base at Y=0.

Usage as a library: convert(usda_text) -> (glb_bytes, info_dict)
"""
from __future__ import annotations

import json
import math
import re
import struct
import sys

DEF_RE = re.compile(r'^\s*(def|over|class)\s+(\w+)?\s*"([^"]+)"')
ATTR_RE = re.compile(r'^\s*(?:uniform\s+|custom\s+)?([\w\[\]]+)\s+([\w:.]+)\s*=\s*(.*)$')
REL_RE = re.compile(r'^\s*rel\s+([\w:.]+)\s*=\s*<([^>]+)>')
NUM_RE = re.compile(r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|nan|inf', re.I)


class Prim:
    __slots__ = ("kind", "name", "path", "attrs", "rels", "children", "meta")

    def __init__(self, kind, name, path):
        self.kind, self.name, self.path = kind, name, path
        self.attrs, self.rels, self.children, self.meta = {}, {}, [], {}


def parse(text: str) -> Prim:
    root = Prim("Root", "", "")
    stack = [root]
    pending = None  # prim declared, waiting for '{'
    last_attr = None
    in_meta = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = DEF_RE.match(line)
        if m:
            parent = stack[-1]
            p = Prim(m.group(2) or "", m.group(3), parent.path + "/" + m.group(3))
            parent.children.append(p)
            pending = p
            if line.endswith("(") or "(" in line and ")" not in line:
                in_meta += 1
            continue
        if in_meta:
            # prim metadata block, e.g. ( prepend apiSchemas = [...] ) or attr metadata
            if "interpolation" in line and last_attr is not None:
                mm = re.search(r'interpolation\s*=\s*"(\w+)"', line)
                if mm:
                    stack[-1].meta[last_attr + ":interpolation"] = mm.group(1)
            if line.startswith(")"):
                in_meta -= 1
            continue
        if line == "{":
            if pending is not None:
                stack.append(pending)
                pending = None
            else:
                stack.append(Prim("Anon", "", stack[-1].path))
            continue
        if line == "}":
            if len(stack) > 1:
                stack.pop()
            continue
        if len(stack) == 1:
            continue  # layer metadata
        m = REL_RE.match(line)
        if m:
            stack[-1].rels[m.group(1)] = m.group(2)
            continue
        m = ATTR_RE.match(line)
        if m:
            typ, name, val = m.groups()
            if val.endswith("("):
                in_meta += 1
                val = val[:-1].strip()
            stack[-1].attrs[name] = (typ, val)
            last_attr = name
    return root


def nums(s: str) -> list[float]:
    return [float(x) for x in NUM_RE.findall(s)]


def ints(s: str) -> list[int]:
    return [int(x) for x in re.findall(r'-?\d+', s)]


# ---------- 4x4 matrices (row-major, column vectors: p' = M p) ----------

def mat_id():
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def mat_mul(a, b):
    r = [0.0] * 16
    for i in range(4):
        for j in range(4):
            r[i * 4 + j] = sum(a[i * 4 + k] * b[k * 4 + j] for k in range(4))
    return r


def mat_t(x, y, z):
    m = mat_id(); m[3], m[7], m[11] = x, y, z
    return m


def mat_s(x, y, z):
    m = mat_id(); m[0], m[5], m[10] = x, y, z
    return m


def mat_q(w, x, y, z):
    n = math.sqrt(w * w + x * x + y * y + z * z) or 1
    w, x, y, z = w / n, x / n, y / n, z / n
    return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
            2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
            2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0,
            0, 0, 0, 1]


def mat_rot_axis(axis, deg):
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    if axis == "X":
        return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]
    if axis == "Y":
        return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]
    return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def local_matrix(p: Prim):
    order_attr = p.attrs.get("xformOpOrder")
    if not order_attr:
        return mat_id()
    order = re.findall(r'"([^"]+)"', order_attr[1])
    m = mat_id()
    for op in order:
        inv = op.startswith("!invert!")
        op = op.replace("!invert!", "")
        if op not in p.attrs:
            continue
        v = nums(p.attrs[op][1])
        base = op.split(":")[1] if ":" in op else op
        if base == "translate":
            o = mat_t(*v[:3])
        elif base == "orient":
            o = mat_q(*v[:4])
        elif base == "scale":
            o = mat_s(*v[:3])
        elif base == "transform":
            # USD stores row-vector matrices: rows are basis, last row translation
            t = v[:16]
            o = [t[0], t[4], t[8], t[12], t[1], t[5], t[9], t[13],
                 t[2], t[6], t[10], t[14], t[3], t[7], t[11], t[15]]
        elif base.startswith("rotate") and len(base) == 9:  # rotateXYZ etc.
            axes = base[6:]
            o = mat_id()
            # rotateXYZ means apply X first, then Y, then Z
            for ax, ang in zip(axes, v[:3]):
                o = mat_mul(mat_rot_axis(ax, ang), o)
        elif base in ("rotateX", "rotateY", "rotateZ"):
            o = mat_rot_axis(base[-1], v[0])
        else:
            continue
        if inv:
            continue  # pivots: rarely used by sand3d; skip
        m = mat_mul(m, o)
    return m


def xf_point(m, p):
    x, y, z = p
    return (m[0] * x + m[1] * y + m[2] * z + m[3],
            m[4] * x + m[5] * y + m[6] * z + m[7],
            m[8] * x + m[9] * y + m[10] * z + m[11])


def xf_dir(m, n):
    # normal transform: assume no extreme non-uniform scale; renormalise
    x, y, z = n
    r = (m[0] * x + m[1] * y + m[2] * z,
         m[4] * x + m[5] * y + m[6] * z,
         m[8] * x + m[9] * y + m[10] * z)
    l = math.sqrt(r[0] ** 2 + r[1] ** 2 + r[2] ** 2) or 1
    return (r[0] / l, r[1] / l, r[2] / l)


def det3(m):
    return (m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8])
            + m[2] * (m[4] * m[9] - m[5] * m[8]))


# ---------- materials ----------

def collect_materials(root: Prim):
    mats = {}

    def walk(p):
        if p.kind == "Material":
            mat = {"color": [0.7, 0.7, 0.7], "rough": 0.6, "metal": 0.0, "opacity": 1.0, "emissive": [0, 0, 0]}
            for c in p.children:
                if c.kind == "Shader":
                    a = c.attrs
                    if "inputs:diffuseColor" in a:
                        mat["color"] = nums(a["inputs:diffuseColor"][1])[:3]
                    if "inputs:roughness" in a:
                        mat["rough"] = nums(a["inputs:roughness"][1])[0]
                    if "inputs:metallic" in a:
                        mat["metal"] = nums(a["inputs:metallic"][1])[0]
                    if "inputs:opacity" in a:
                        mat["opacity"] = nums(a["inputs:opacity"][1])[0]
                    if "inputs:emissiveColor" in a:
                        mat["emissive"] = nums(a["inputs:emissiveColor"][1])[:3]
            mats[p.path] = mat
        for c in p.children:
            walk(c)

    walk(root)
    return mats


# ---------- geometry ----------

def to_y_up(p):
    x, y, z = p
    return (x, z, -y)


def collect_meshes(root: Prim, mats):
    groups = {}  # material path -> {"pos": [], "nrm": [], "idx": [], "map": {}}

    def walk(p, m):
        lm = mat_mul(m, local_matrix(p))
        if p.kind == "Mesh" and "points" in p.attrs:
            add_mesh(p, lm)
        for c in p.children:
            walk(c, lm)

    def add_mesh(p, m):
        pts_f = nums(p.attrs["points"][1])
        pts = [xf_point(m, pts_f[i:i + 3]) for i in range(0, len(pts_f) - 2, 3)]
        counts = ints(p.attrs.get("faceVertexCounts", ("", ""))[1])
        idxs = ints(p.attrs.get("faceVertexIndices", ("", ""))[1])
        nrm = None
        interp = p.meta.get("normals:interpolation", "vertex")
        if "normals" in p.attrs:
            nf = nums(p.attrs["normals"][1])
            nrm = [xf_dir(m, nf[i:i + 3]) for i in range(0, len(nf) - 2, 3)]
        flip = det3(m) < 0
        if "orientation" in p.attrs and "leftHanded" in p.attrs["orientation"][1]:
            flip = not flip
        mat_path = p.rels.get("material:binding", "__default__")
        g = groups.setdefault(mat_path, {"pos": [], "nrm": [], "idx": [], "map": {}})
        if not counts:
            counts = [3] * (len(idxs) // 3)

        # if no normals: compute flat face normals
        cursor = 0
        for cnt in counts:
            face = idxs[cursor:cursor + cnt]
            fv_ids = list(range(cursor, cursor + cnt))
            cursor += cnt
            if cnt < 3 or any(i >= len(pts) for i in face):
                continue
            fn = None
            if nrm is None or (interp == "faceVarying" and len(nrm) < cursor) or (interp != "faceVarying" and interp != "uniform" and len(nrm) < len(pts)):
                a, b, c = pts[face[0]], pts[face[1]], pts[face[2]]
                u = (b[0] - a[0], b[1] - a[1], b[2] - a[2]); v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
                fn = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
                l = math.sqrt(sum(x * x for x in fn)) or 1
                fn = tuple(x / l for x in fn)
            out = []
            for k, vi in enumerate(face):
                if fn is not None:
                    n = fn
                elif interp == "faceVarying":
                    n = nrm[fv_ids[k]]
                elif interp == "uniform":
                    n = nrm[min(len(nrm) - 1, 0)]
                else:
                    n = nrm[vi]
                P = to_y_up(pts[vi]); N = to_y_up(n)
                key = (vi, id(p), round(N[0], 3), round(N[1], 3), round(N[2], 3))
                j = g["map"].get(key)
                if j is None:
                    j = len(g["pos"]) // 3
                    g["map"][key] = j
                    g["pos"].extend(P); g["nrm"].extend(N)
                out.append(j)
            for t in range(1, cnt - 1):
                tri = (out[0], out[t], out[t + 1])
                if flip:
                    tri = (tri[0], tri[2], tri[1])
                g["idx"].extend(tri)

    walk(root, mat_id())
    return groups


def pad4(b: bytes, fill=b"\x00"):
    return b + fill * ((4 - len(b) % 4) % 4)


def convert(text: str):
    root = parse(text)
    mats = collect_materials(root)
    groups = collect_meshes(root, mats)
    groups = {k: v for k, v in groups.items() if v["idx"]}
    if not groups:
        raise ValueError("no geometry")
    # bbox and recentre
    mn = [math.inf] * 3; mx = [-math.inf] * 3
    for g in groups.values():
        p = g["pos"]
        for i in range(0, len(p), 3):
            for a in range(3):
                v = p[i + a]
                if v < mn[a]: mn[a] = v
                if v > mx[a]: mx[a] = v
    off = ((mn[0] + mx[0]) / 2, mn[1], (mn[2] + mx[2]) / 2)
    size = [mx[a] - mn[a] for a in range(3)]

    bin_parts = []
    buffer_views, accessors, materials, primitives = [], [], [], []
    offset = 0

    def add_view(data: bytes, target):
        nonlocal offset
        data = pad4(data)
        buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data), "target": target})
        bin_parts.append(data)
        offset += len(data)
        return len(buffer_views) - 1

    total_tris = 0
    for mpath, g in groups.items():
        pos = g["pos"]
        n = len(pos) // 3
        for i in range(0, len(pos), 3):
            pos[i] -= off[0]; pos[i + 1] -= off[1]; pos[i + 2] -= off[2]
        pmin = [min(pos[a::3]) for a in range(3)]
        pmax = [max(pos[a::3]) for a in range(3)]
        bv = add_view(struct.pack(f"<{len(pos)}f", *pos), 34962)
        accessors.append({"bufferView": bv, "componentType": 5126, "count": n, "type": "VEC3", "min": pmin, "max": pmax})
        pa = len(accessors) - 1
        bv = add_view(struct.pack(f"<{len(g['nrm'])}f", *g["nrm"]), 34962)
        accessors.append({"bufferView": bv, "componentType": 5126, "count": n, "type": "VEC3"})
        na = len(accessors) - 1
        idx = g["idx"]
        total_tris += len(idx) // 3
        if n < 65536:
            bv = add_view(struct.pack(f"<{len(idx)}H", *idx), 34963); ct = 5123
        else:
            bv = add_view(struct.pack(f"<{len(idx)}I", *idx), 34963); ct = 5125
        accessors.append({"bufferView": bv, "componentType": ct, "count": len(idx), "type": "SCALAR"})
        ia = len(accessors) - 1
        mat = mats.get(mpath, {"color": [0.7, 0.7, 0.7], "rough": 0.6, "metal": 0.0, "opacity": 1.0, "emissive": [0, 0, 0]})
        c = [max(0.0, min(1.0, x)) for x in (mat["color"] + [0.7, 0.7, 0.7])[:3]]
        gm = {
            "name": mpath.rsplit("/", 1)[-1][:60],
            "pbrMetallicRoughness": {
                "baseColorFactor": c + [max(0.05, min(1.0, mat["opacity"]))],
                "metallicFactor": max(0.0, min(1.0, mat["metal"])),
                "roughnessFactor": max(0.0, min(1.0, mat["rough"])),
            },
            "doubleSided": True,
        }
        if mat["opacity"] < 0.99:
            gm["alphaMode"] = "BLEND"
        if any(x > 0 for x in mat["emissive"]):
            gm["emissiveFactor"] = [max(0.0, min(1.0, x)) for x in mat["emissive"]]
        materials.append(gm)
        primitives.append({"attributes": {"POSITION": pa, "NORMAL": na}, "indices": ia, "material": len(materials) - 1})

    name = root.children[0].name if root.children else "object"
    gltf = {
        "asset": {"version": "2.0", "generator": "sand3d usda_to_glb.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"primitives": primitives, "name": name}],
        "materials": materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": offset}],
    }
    jb = pad4(json.dumps(gltf, separators=(",", ":")).encode(), b" ")
    bb = b"".join(bin_parts)
    total = 12 + 8 + len(jb) + 8 + len(bb)
    glb = (struct.pack("<III", 0x46546C67, 2, total)
           + struct.pack("<II", len(jb), 0x4E4F534A) + jb
           + struct.pack("<II", len(bb), 0x004E4942) + bb)
    return glb, {"name": name, "size": [round(s, 4) for s in size], "tris": total_tris}


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    glb, info = convert(open(src).read())
    open(dst, "wb").write(glb)
    print(json.dumps(info))
