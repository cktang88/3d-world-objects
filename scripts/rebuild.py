"""Rebuild sand3d objects from their programs, with UV maps, as GLB.

Runs each object's sand3d program in Blender (bpy), smart-UV-unwraps every part,
rescales the UVs so one UV unit is one metre (textures then tile at their real
physical size), and exports a GLB that keeps sand3d's material names (their kind:
oak, brushed_steel, fabric…) so the viewer can apply matching PBR textures.

With --bake, also bakes per-vertex shading into the GLB's COLOR_0 (no extra textures):
R = ambient occlusion (Cycles AO bake), G = convexity (0.5 flat, >0.5 convex edge, <0.5 crease),
B = 1. The viewer (src/materials.ts) uses R to occlude indirect light and G for edge wear.

Usage (inside a venv with `pip install sand3d`):
    python scripts/rebuild.py list.json out_dir [--workers N] [--bake] [--samples 48]
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


def bake_vertex(meshes, unit, samples=48):
    """AO (Cycles) and convexity into a float colour attribute "bake" on every mesh."""
    import bpy
    import numpy as np

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    if scene.world is None:
        scene.world = bpy.data.worlds.new("bake")
    # occlusion reach: 8 cm, or a fifth of the object for small things (Blender units)
    lo = [min(v[i] for o in meshes for v in o.bound_box) for i in range(3)]
    size = max(max(v[i] for o in meshes for v in o.bound_box) - lo[i] for i in range(3)) * unit
    scene.world.light_settings.distance = min(0.08, max(0.005, size * 0.2)) / unit
    done = set()
    for o in meshes:
        if o.data.name in done:
            continue
        done.add(o.data.name)
        ca = o.data.color_attributes.get("bake") or o.data.color_attributes.new("bake", "FLOAT_COLOR", "POINT")
        o.data.color_attributes.active_color = ca
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")
    for name in done:
        me = bpy.data.meshes[name]
        n = len(me.vertices)
        co = np.empty(n * 3, np.float32)
        me.vertices.foreach_get("co", co)
        nr = np.empty(n * 3, np.float32)
        me.vertices.foreach_get("normal", nr)
        co, nr = co.reshape(-1, 3), nr.reshape(-1, 3)
        ev = np.empty(len(me.edges) * 2, np.int32)
        me.edges.foreach_get("vertices", ev)
        ev = ev.reshape(-1, 2)
        d = co[ev[:, 0]] - co[ev[:, 1]]
        d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
        # convex: neighbours lie below the vertex's tangent plane
        acc = np.zeros(n, np.float32)
        cnt = np.zeros(n, np.float32)
        np.add.at(acc, ev[:, 0], (nr[ev[:, 0]] * d).sum(1))
        np.add.at(acc, ev[:, 1], -(nr[ev[:, 1]] * d).sum(1))
        np.add.at(cnt, ev[:, 0], 1)
        np.add.at(cnt, ev[:, 1], 1)
        conv = np.clip(0.5 + 1.5 * acc / np.maximum(cnt, 1), 0, 1)
        ca = me.color_attributes["bake"]
        col = np.empty(n * 4, np.float32)
        ca.data.foreach_get("color", col)
        col = col.reshape(-1, 4)
        col[:, 1] = conv
        col[:, 2] = 1
        col[:, 3] = 1
        ca.data.foreach_set("color", col.ravel())


def build_one(program, entry, out_path, bake=False, samples=48):
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
    if bake and meshes:
        bake_vertex(meshes, unit, samples)
        # sand3d's exporter does not pass vertex colours through: ask for ours by name.
        # (bpy.ops.export_scene is rebuilt on every access, so shadow it on the module)
        real = bpy.ops.export_scene

        class ExportScene:
            def __getattr__(self, name):
                return getattr(real, name)

            def gltf(self, *a, **k):
                k.setdefault("export_vertex_color", "NAME")
                k.setdefault("export_vertex_color_name", "bake")
                return real.gltf(*a, **k)

        bpy.ops.export_scene = ExportScene()
        try:
            s3d.export(obj, out_path)
        finally:
            del bpy.ops.export_scene
        return
    s3d.export(obj, out_path)


def worker(job_file, out_dir, bake=False, samples=48):
    jobs = json.load(open(job_file))
    for ds, split, row, oid, entry in jobs:
        out = os.path.join(out_dir, f"{oid}.glb")
        if os.path.exists(out):
            continue
        p = fetch_program(ds, split, row)
        if not p:
            continue
        try:
            build_one(p["program"], p.get("entry") or entry, out, bake, samples)
            print("ok", oid, os.path.getsize(out), flush=True)
        except Exception as e:  # noqa: BLE001
            print("fail", oid, repr(e)[:200], flush=True)


def main():
    bake = "--bake" in sys.argv
    samples = int(sys.argv[sys.argv.index("--samples") + 1]) if "--samples" in sys.argv else 48
    if sys.argv[1] == "--worker":
        worker(sys.argv[2], sys.argv[3], bake, samples)
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
        extra = (["--bake"] if bake else []) + ["--samples", str(samples)]
        procs.append(subprocess.Popen([sys.executable, __file__, "--worker", jf, out_dir] + extra))
    for p in procs:
        p.wait()


if __name__ == "__main__":
    main()
