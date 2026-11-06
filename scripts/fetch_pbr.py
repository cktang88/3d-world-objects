"""Write public/pbr.json: the CC0 PBR texture sets used by the viewer.

Two sources:
- Poly Haven (photo-scanned wood, fabric, leather, stone, architecture): streamed by the
  browser from dl.polyhaven.org (CORS enabled); we only record URLs and real-world size.
- ambientCG (metals, plastics, rubber, porcelain: kinds Poly Haven has no clean scans of):
  their 1K zips are downloaded once, repacked to small WebP files in
  public/assets/materials/<id>/ (diff = sRGB albedo, nor = OpenGL normal,
  arm = AO/roughness/metalness, disp = height) and served with the app.

For every set we also store "rough": the mean of its roughness channel, so the shader can
modulate sand3d's own roughness by the texture's relative variation instead of replacing it.

    python scripts/fetch_pbr.py            # needs Pillow + numpy
"""
import io
import json
import os
import urllib.request
import zipfile

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "scripts", ".cache", "pbr")
LOCAL = os.path.join(ROOT, "public", "assets", "materials")

# key -> Poly Haven slug
SETS = {
    # sand3d material kinds
    "oak": "oak_veneer_01", "walnut": "american_walnut_veneer", "pine": "coated_pine", "birch": "ash_veneer",
    "fabric": "rough_linen", "velvet": "velour_velvet", "leather": "brown_leather",
    "marble": "marble_01", "concrete": "concrete_floor_02",
    # architecture
    "nyc_brick": "brick_wall_02", "nyc_brick2": "dark_brick_wall", "nyc_brownstone": "red_sandstone_wall",
    "nyc_limestone": "large_sandstone_blocks", "nyc_castiron": "painted_plaster_wall", "nyc_panel": "concrete_wall_008",
    "nyc_sidewalk": "concrete_pavement", "nyc_asphalt": "asphalt_02", "nyc_roof": "bitumen",
    "floor_parquet": "herringbone_parquet", "floor_laminate": "laminate_floor_02", "floor_marble": "marble_tiles",
    "floor_tiles": "interior_tiles", "floor_carpet": "dirty_carpet", "wall_plaster": "painted_plaster_wall",
    "floor_concrete": "concrete_floor_02", "tree_bark": "bark_brown_02",
}
MAPS = {"diff": ["Diffuse"], "disp": ["Displacement"], "arm": ["arm"], "nor": ["nor_gl"]}

# key -> (ambientCG asset id, metres per repeat). ambientCG gives no physical size for
# these, so the sizes are chosen from the visible feature scale (brush lines ~0.1 mm apart,
# fingerprints ~1.5 cm, rubber granules ~1 mm).
ACG = {
    "steel": ("Metal011", 0.5), "brushed_steel": ("Metal009", 0.35), "aluminium": ("Metal012", 0.5),
    "chrome": ("Metal049B", 0.6), "brass": ("Metal048B", 0.5), "copper": ("Metal058A", 0.5),
    "painted_metal": ("Metal029", 0.6), "plastic": ("Plastic010", 0.5), "glossy_plastic": ("Plastic013B", 0.5),
    "rubber": ("Rubber004", 0.75), "ceramic": ("Porcelain002", 0.5),
}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "sand3d-world-viewer/1.0 (texture catalogue)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def mean_rough(img):
    return round(float(np.asarray(img.convert("L"), dtype=np.float32).mean() / 255), 3)


def polyhaven(slug):
    files = json.loads(get(f"https://api.polyhaven.com/files/{slug}"))
    info = json.loads(get(f"https://api.polyhaven.com/info/{slug}"))
    entry = {"dim": [d / 1000 for d in (info.get("dimensions") or [2000, 2000])], "maps": {}}
    for key, names in MAPS.items():
        for n in names:
            if n in files:
                entry["maps"][key] = {res: files[n][res]["jpg"]["url"] for res in ("1k", "2k", "4k") if res in files[n] and "jpg" in files[n][res]}
    if "arm" in entry["maps"]:
        arm = Image.open(io.BytesIO(get(entry["maps"]["arm"]["1k"])))
        entry["rough"] = mean_rough(arm.split()[1])
    return entry


def ambientcg(asset, size):
    os.makedirs(CACHE, exist_ok=True)
    z = os.path.join(CACHE, f"{asset}_1K-JPG.zip")
    if not os.path.exists(z):
        open(z, "wb").write(get(f"https://ambientcg.com/get?file={asset}_1K-JPG.zip"))
    zf = zipfile.ZipFile(z)

    def img(suffix):
        n = [x for x in zf.namelist() if x.endswith(f"_{suffix}.jpg")]
        return Image.open(zf.open(n[0])) if n else None

    out = os.path.join(LOCAL, asset)
    os.makedirs(out, exist_ok=True)
    col, nor, rough, metal, ao, disp = img("Color"), img("NormalGL"), img("Roughness"), img("Metalness"), img("AmbientOcclusion"), img("Displacement")
    size_px = col.size
    white = Image.new("L", size_px, 255)
    black = Image.new("L", size_px, 0)
    arm = Image.merge("RGB", [(ao or white).convert("L"), (rough or Image.new("L", size_px, 128)).convert("L"), (metal or black).convert("L")])
    maps = {}
    for key, im, q in (("diff", col.convert("RGB"), 82), ("nor", nor.convert("RGB"), 90), ("arm", arm, 85), ("disp", disp.convert("L") if disp else None, 80)):
        if im is None:
            continue
        p = os.path.join(out, f"{key}.webp")
        im.save(p, "WEBP", quality=q, method=6)
        maps[key] = {"1k": f"assets/materials/{asset}/{key}.webp"}
    return {"dim": [size, size], "maps": maps, "rough": mean_rough(arm.split()[1]), "src": f"https://ambientcg.com/view?id={asset}"}


def main():
    kinds = dict(SETS)
    out = {"kinds": kinds, "sets": {}}
    for slug in sorted(set(SETS.values())):
        try:
            out["sets"][slug] = polyhaven(slug)
        except Exception as e:  # noqa: BLE001
            print("missing", slug, e)
            continue
        print(slug, out["sets"][slug]["dim"], sorted(out["sets"][slug]["maps"]), out["sets"][slug].get("rough"))
    for key, (asset, size) in ACG.items():
        kinds[key] = asset
        if asset not in out["sets"]:
            out["sets"][asset] = ambientcg(asset, size)
            print(asset, sorted(out["sets"][asset]["maps"]), out["sets"][asset]["rough"])
    json.dump(out, open(os.path.join(ROOT, "public", "pbr.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
