"""Rebuild sand3d objects from their programs, with UV maps, as GLB.

Runs each object's sand3d program in Blender (bpy), smart-UV-unwraps every part,
rescales the UVs so one UV unit is one metre (textures then tile at their real
physical size), and exports a GLB that keeps sand3d's material names (their kind:
oak, brushed_steel, fabric…) so the viewer can apply matching PBR textures.

Usage (inside a venv with `pip install sand3d`):
    python scripts/rebuild.py list.json out_dir [--workers N]
list.json: [[ds, split, row, id, entry], ...]   (programs are fetched from the HF rows API)
"""
import json
import math
import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROG_CACHE = os.path.join(HERE, ".cache", "programs")


def fetch_program(ds, split, row):
    os.makedirs(PROG_CACHE, exist_ok=True)
    path = os.path.join(PROG_CACHE, f"{ds}-{split}-{row}.json")
    if os.path.exists(path):
        return json.load(open(path))
    url = f"https://datasets-server.huggingface.co/rows?dataset=Sandflow/sand3d-{ds}&config=default&split={split}&offset={row}&length=1"
    for i in range(7):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                d = json.load(r)
            row_ = d["rows"][0]["row"]
            out = {"program": row_["program"], "entry": row_.get("entry")}
            json.dump(out, open(path, "w"))
            return out
        except Exception as e:  # noqa: BLE001
            print("retry", ds, row, e, file=sys.stderr)
            time.sleep(2 ** i)
    return None


def build_one(program, entry, out_path):
    """Runs inside Blender's Python (bpy)."""
    import bpy
    import bmesh
    import sand3d as s3d

    bpy.ops.wm.read_factory_settings(use_empty=True)
    ns = {}
    exec(program, ns)
    if entry and entry != "None" and entry in ns:
        obj = ns[entry]()
    else:
        roots = [o for o in bpy.context.scene.objects if o.parent is None]
        obj = roots[0] if len(roots) == 1 else s3d.group("object", *roots)

    # metres per Blender unit: sand3d works in mm unless the program set units
    unit = bpy.context.scene.unit_settings.scale_length or 1.0

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH" and len(o.data.polygons)]
    for o in meshes:
        bpy.ops.object.select_all(action="DESELECT")
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        if not o.data.uv_layers:
            o.data.uv_layers.new(name="UVMap")
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.003, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode="OBJECT")
        # rescale to metric texel density: UV area per m^2 of surface = 1
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bm.transform(o.matrix_world)
        uvl = bm.loops.layers.uv.active
        a3 = sum(f.calc_area() for f in bm.faces) * unit * unit
        auv = 0.0
        for f in bm.faces:
            pts = [l[uvl].uv for l in f.loops]
            s = 0.0
            for i in range(len(pts)):
                x1, y1 = pts[i]
                x2, y2 = pts[(i + 1) % len(pts)]
                s += x1 * y2 - x2 * y1
            auv += abs(s) / 2
        bm.free()
        k = math.sqrt(a3 / auv) if auv > 1e-12 else 1.0
        for l in o.data.uv_layers.active.data:
            l.uv = (l.uv[0] * k, l.uv[1] * k)
    s3d.export(obj, out_path)


def worker(job_file, out_dir):
    jobs = json.load(open(job_file))
    for ds, split, row, oid, entry in jobs:
        out = os.path.join(out_dir, f"{oid}.glb")
        if os.path.exists(out):
            continue
        p = fetch_program(ds, split, row)
        if not p:
            continue
        try:
            build_one(p["program"], p.get("entry") or entry, out)
            print("ok", oid, os.path.getsize(out), flush=True)
        except Exception as e:  # noqa: BLE001
            print("fail", oid, repr(e)[:200], flush=True)


def main():
    if sys.argv[1] == "--worker":
        worker(sys.argv[2], sys.argv[3])
        return
    lst, out_dir = sys.argv[1], sys.argv[2]
    n = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else max(1, (os.cpu_count() or 2) - 1)
    os.makedirs(out_dir, exist_ok=True)
    items = json.load(open(lst))
    todo = [it for it in items if not os.path.exists(os.path.join(out_dir, f"{it[3]}.glb"))]
    print(len(todo), "to build with", n, "workers", flush=True)
    procs = []
    for w in range(n):
        chunk = todo[w::n]
        if not chunk:
            continue
        jf = os.path.join(out_dir, f".jobs-{w}.json")
        json.dump(chunk, open(jf, "w"))
        procs.append(subprocess.Popen([sys.executable, __file__, "--worker", jf, out_dir]))
    for p in procs:
        p.wait()


if __name__ == "__main__":
    main()
