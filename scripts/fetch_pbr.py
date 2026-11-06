"""Write public/pbr.json: CC0 Poly Haven PBR texture sets used by the viewer.

For each chosen texture: its real-world size (so it tiles at physical scale) and the
CDN URLs of its maps (diffuse, displacement, ARM = AO/roughness/metal, normal) at 1k/2k.
The browser streams them from dl.polyhaven.org (CORS enabled).
"""
import json
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SETS = {
    # sand3d material kinds
    "oak": "oak_veneer_01", "walnut": "american_walnut_veneer", "pine": "coated_pine", "birch": "ash_veneer",
    "steel": "metal_plate_02", "brushed_steel": "metal_plate", "aluminium": "metal_plate", "chrome": "metal_plate",
    "brass": "metal_plate", "copper": "metal_plate", "painted_metal": "metal_plate_02",
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


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "sand3d-world-viewer/1.0 (texture catalogue)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    out = {"kinds": SETS, "sets": {}}
    for slug in sorted(set(SETS.values())):
        try:
            files = get(f"https://api.polyhaven.com/files/{slug}")
            info = get(f"https://api.polyhaven.com/info/{slug}")
        except Exception as e:  # noqa: BLE001
            print("missing", slug, e)
            continue
        entry = {"dim": [d / 1000 for d in (info.get("dimensions") or [2000, 2000])], "maps": {}}
        for key, names in MAPS.items():
            for n in names:
                if n in files:
                    entry["maps"][key] = {res: files[n][res]["jpg"]["url"] for res in ("1k", "2k", "4k") if res in files[n] and "jpg" in files[n][res]}
        out["sets"][slug] = entry
        print(slug, entry["dim"], sorted(entry["maps"]))
    json.dump(out, open(os.path.join(ROOT, "public", "pbr.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
