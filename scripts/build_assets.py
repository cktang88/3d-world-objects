"""Pick sand3d objects for each world role, download their USDA, convert to GLB.

Reads scripts/.cache/catalog.json (from fetch_catalog.py) and writes
public/models/<role>/<id>.glb plus public/models/manifest.json and CREDITS.md.

Usage: python3 scripts/build_assets.py [per_role_multiplier]
"""
import concurrent.futures as cf
import json
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from usda_to_glb import convert  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, ".cache", "usda")
OUT = os.path.join(ROOT, "public", "models")
BASE = "https://huggingface.co/datasets/Sandflow/sand3d-objaverse/resolve/main/"

# role: (families or None for any, title/entry keyword regex, max count, max usda bytes, (minH, maxH) metres)
ROLES = {
    "building":   (["building"], r"house|home|cabin|hut|cottage|tower|church|shop|store|building|apartment|castle|barn|bungalow|villa|temple|mansion|chapel|bank|station|tavern|pavilion|kiosk|cafe|restaurant|hotel|office|school|lighthouse|windmill|pagoda|shrine|garage|warehouse|factory|hall|library|museum", 40, 1_500_000, None),
    "streetlamp": (["lighting", "architectural element", "garden or outdoor"], r"lamp ?post|street ?light|streetlamp|street lamp|lamppost|light pole|post lamp|park lamp|lantern post|road lamp", 10, 900_000, None),
    "plant":      (["garden or outdoor", "furniture", "architectural element", "container"], r"\btrees?\b|\bplants?\b|\bbush|flower|\bpot\b|planter|cactus|palm|shrub|bonsai|\bfern", 24, 900_000, None),
    "bench":      (None, r"bench", 10, 900_000, None),
    "vehicle":    (["vehicle"], r"\bcar\b|truck|bus\b|van\b|taxi|jeep|tractor|bike|bicycle|motorcycle|scooter|wagon|sedan|pickup|ambulance|police|tram|train|forklift|kart|buggy|suv|cart", 30, 1_500_000, None),
    "streetprop": (None, r"fountain|well\b|hydrant|mailbox|post ?box|trash|garbage|dumpster|bin\b|sign|traffic|cone|barrier|bollard|bus stop|vending|phone booth|newspaper|statue|monument", 24, 900_000, None),
    "chair":      (["furniture"], r"chair|stool|armchair|\bseat", 20, 700_000, None),
    "table":      (["furniture"], r"table|desk", 20, 700_000, None),
    "sofa":       (["furniture"], r"sofa|couch|settee|loveseat|ottoman", 12, 900_000, None),
    "bed":        (["furniture"], r"\bbed\b|bunk|cot\b|crib", 10, 900_000, None),
    "storage":    (["furniture"], r"shelf|shelving|bookcase|cabinet|wardrobe|drawer|dresser|cupboard|locker|sideboard|rack|closet|chest of|commode|tv unit|nightstand|bedside", 26, 900_000, None),
    "lamp":       (["lighting"], r"lamp|light|chandelier|sconce|lantern|torch|candle|pendant|bulb|floor", 22, 600_000, None),
    "electronics":(["electronics"], r"\btv\b|television|monitor|computer|laptop|radio|speaker|phone|console|camera|game ?boy|keyboard|printer|amplifier|retro|arcade|tablet|pc\b|router|server|stereo|walkman|cassette|vhs|player", 30, 600_000, None),
    "appliance":  (["home appliance", "kitchen appliance"], r".", 20, 700_000, None),
    "tableware":  (["tableware", "cookware"], r".", 30, 400_000, None),
    "food":       (["food and drink"], r".", 26, 400_000, None),
    "toy":        (["toy or game"], r".", 26, 500_000, None),
    "stationery": (["stationery"], r".", 18, 400_000, None),
    "container":  (["container", "packaging"], r"box|crate|chest|basket|jar|barrel|bag|case|suitcase|bin|trunk|tin|can\b|bucket|coffer|casket|treasure", 30, 500_000, None),
    "instrument": (["musical instrument"], r".", 14, 700_000, None),
    "tool":       (["hand tool", "power tool", "measuring instrument"], r".", 20, 400_000, None),
    "bathroom":   (["bathroom fixture"], r".", 10, 700_000, None),
    "sports":     (["sports equipment"], r".", 12, 400_000, None),
    "craft":      (["aircraft or spacecraft", "watercraft"], r".", 16, 900_000, None),
    "gear":       (["weapon or armour"], r"shield|sword|helmet|armou?r|axe|spear|bow\b|knight", 12, 500_000, None),
    "machine":    (["machine or industrial"], r".", 14, 700_000, None),
}

TITLE_RE = re.compile(r'^"(.*?)" by (.*?), (https://\S+), ([\w.-]+)')


def title_of(r):
    m = TITLE_RE.match(r.get("attribution") or "")
    return (m.group(1) if m else (r.get("entry") or r["id"])), m


def fetch(path):
    local = os.path.join(CACHE, os.path.basename(path))
    if os.path.exists(local) and os.path.getsize(local) > 0:
        return local
    os.makedirs(CACHE, exist_ok=True)
    for i in range(4):
        try:
            with urllib.request.urlopen(BASE + path, timeout=120) as resp:
                data = resp.read()
            with open(local, "wb") as f:
                f.write(data)
            return local
        except Exception as e:  # noqa: BLE001
            print("retry", path, e, file=sys.stderr)
    return None


def main():
    mult = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
    rows = json.load(open(os.path.join(HERE, ".cache", "catalog.json")))
    rows.sort(key=lambda r: -float(r["f_score"]))
    used = set()
    picks = []
    for role, (fams, kw, n, maxb, _) in ROLES.items():
        rx = re.compile(kw, re.I)
        n = int(n * mult)
        got = 0
        for r in rows:
            if got >= n:
                break
            if r["id"] in used or int(r["usda_bytes"]) > maxb or float(r["f_score"]) < 0.8:
                continue
            if fams and r["family"] not in fams:
                continue
            t, _ = title_of(r)
            if not (rx.search(t) or rx.search(r.get("entry") or "")):
                continue
            used.add(r["id"])
            picks.append((role, r))
            got += 1
        print(f"{role}: {got}", file=sys.stderr)

    with cf.ThreadPoolExecutor(12) as ex:
        locals_ = list(ex.map(lambda p: fetch(p[1]["usda_path"]), picks))

    manifest = []
    for (role, r), local in zip(picks, locals_):
        if not local:
            continue
        try:
            glb, info = convert(open(local).read())
        except Exception as e:  # noqa: BLE001
            print("convert failed", r["id"], e, file=sys.stderr)
            continue
        if min(info["size"]) <= 0 or info["tris"] > 60000:
            continue
        d = os.path.join(OUT, role)
        os.makedirs(d, exist_ok=True)
        short = r["id"].replace("objaverse-", "")[:16]
        fn = f"{role}/{short}.glb"
        open(os.path.join(OUT, fn), "wb").write(glb)
        t, m = title_of(r)
        manifest.append({
            "id": r["id"], "role": role, "family": r["family"], "file": fn,
            "title": t, "entry": r.get("entry"), "size": info["size"], "tris": info["tris"],
            "author": m.group(2) if m else None, "url": m.group(3) if m else None,
            "license": m.group(4) if m else None, "attribution": r.get("attribution"),
        })
    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=0)
    with open(os.path.join(ROOT, "CREDITS.md"), "w") as f:
        f.write("# Credits\n\n3D objects from [sand3d-objaverse](https://huggingface.co/datasets/Sandflow/sand3d-objaverse) "
                "by Sandflow (CC BY 4.0), each rewritten as a [sand3d](https://github.com/Sandflow-ai/sand3d) program "
                "and derived from an Objaverse/Sketchfab source model. Converted from USDA to GLB for this project.\n\n")
        for e in sorted(manifest, key=lambda e: (e["role"], e["title"])):
            f.write(f"- **{e['role']}** — {e['attribution']}\n")
    total = sum(os.path.getsize(os.path.join(OUT, e["file"])) for e in manifest)
    print(f"{len(manifest)} models, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
