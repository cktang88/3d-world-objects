"""Sample the Sandflow sand3d-objaverse catalog via the HF dataset-viewer /rows API.

Writes scripts/.cache/catalog.json with lightweight metadata (no renders).
Usage: python3 scripts/fetch_catalog.py [pages]
"""
import json, os, random, sys, time, urllib.request

DS = "Sandflow/sand3d-objaverse"
TOTAL = 64642
PAGE = 100
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, ".cache", "catalog.json")
KEEP = ["id", "family", "entry", "usda_path", "usda_bytes", "f_score", "attribution", "n_joints"]


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            print("retry", url, e, file=sys.stderr)
            time.sleep(2 ** i)
    return None


def main():
    pages = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    rows = {}
    if os.path.exists(OUT):
        rows = {r["id"]: r for r in json.load(open(OUT))}
    rng = random.Random(1234)
    offsets = rng.sample(range(0, TOTAL - PAGE, PAGE), pages)
    for n, off in enumerate(offsets):
        url = (f"https://datasets-server.huggingface.co/rows?dataset={DS}"
               f"&config=default&split=train&offset={off}&length={PAGE}")
        d = get(url)
        if not d or "rows" not in d:
            continue
        for r in d["rows"]:
            row = r["row"]
            rows[row["id"]] = {k: row.get(k) for k in KEEP}
        print(f"{n + 1}/{pages} offset {off}: {len(rows)} rows", file=sys.stderr)
    json.dump(list(rows.values()), open(OUT, "w"))
    print(f"wrote {len(rows)} rows to {OUT}")


if __name__ == "__main__":
    main()
