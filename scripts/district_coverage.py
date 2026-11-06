#!/usr/bin/env python3
"""
How much of each object family a player can meet in the NYC world (not the museum):

  - district showcases: public/districts/pools.json kinds that src/nyc/district-*.ts / districts.ts use
  - shops: the museum pools (public/museum/pools.json) each SHOPS type stocks (src/nyc/buildings-shop.ts)
  - street props and apartment interiors: the bundled manifest (public/models/manifest.json)

Counts distinct objects per family and compares with the library (scripts/.cache/catalog.json for the
22K bundled/remote catalogue, scripts/.cache/index.jsonl for the full ~100K).

    python3 scripts/district_coverage.py [--md]
"""
import collections
import glob
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
md = "--md" in sys.argv


def src(path_glob):
    return "".join(open(p).read() for p in glob.glob(os.path.join(ROOT, path_glob)))


# ---- district showcase kinds actually referenced by the district code
dpools = json.load(open(os.path.join(ROOT, "public/districts/pools.json")))
dsrc = src("src/nyc/district*.ts") + src("src/nyc/districts.ts")
used_kinds = {k for k in dpools if re.search(r"['\"]%s['\"]" % re.escape(k), dsrc)}
seen = collections.defaultdict(set)  # family -> ids
how = collections.defaultdict(collections.Counter)
for k in used_kinds:
    for r in dpools[k]:
        seen[r[4]].add(r[3])
        how[r[4]]["district"] += 1

# ---- shops
shop_src = open(os.path.join(ROOT, "src/nyc/buildings-shop.ts")).read()
shop_keys = set()
for m in re.finditer(r"pools: \[([^\]]*)\]", shop_src):
    shop_keys |= set(re.findall(r"'([^']+)'", m.group(1)))
mpools = json.load(open(os.path.join(ROOT, "public/museum/pools.json")))
for k in shop_keys:
    for r in mpools.get(k, []):
        fam = r[4] if r[0] == "objaverse" else f"{r[0]}:{r[4]}"
        seen[r[4]].add(r[3])
        how[r[4]]["shop"] += 1

# ---- bundled manifest (street props, interiors)
for e in json.load(open(os.path.join(ROOT, "public/models/manifest.json"))):
    seen[e["family"]].add(e["id"])
    how[e["family"]]["bundled"] += 1

# ---- library sizes
cat = collections.Counter(e["family"] for e in json.load(open(os.path.join(ROOT, "scripts/.cache/catalog.json"))))
full = collections.Counter()
with open(os.path.join(ROOT, "scripts/.cache/index.jsonl")) as fh:
    for line in fh:
        r = json.loads(line)
        if r[0] == "objaverse":
            full[r[4]] += 1

rows = []
for fam, n in cat.most_common():
    if not fam:
        continue
    s = len(seen.get(fam, ()))
    rows.append((fam, n, full.get(fam, 0), s, s / n if n else 0, dict(how.get(fam, {}))))
rows.sort(key=lambda r: r[4])
if md:
    print("| family | catalogue | full index | in the city | share | via |")
    print("|---|---:|---:|---:|---:|---|")
    for fam, n, f, s, sh, h in sorted(rows, key=lambda r: -r[1]):
        print(f"| {fam} | {n} | {f} | {s} | {sh:.0%} | {', '.join(f'{k} {v}' for k, v in sorted(h.items()))} |")
else:
    for fam, n, f, s, sh, h in rows:
        print(f"{fam:26s} catalogue {n:5d}  full {f:6d}  in city {s:4d}  ({sh:5.1%})  {h}")
    # under-shown: big families, small share (weight by size)
    print("\nbiggest gaps (catalogue objects not met):")
    for fam, n, f, s, sh, h in sorted(rows, key=lambda r: -(r[1] - r[3]))[:8]:
        print(f"  {fam:26s} {n - s:5d} of {n} unseen ({sh:.0%} shown)")
