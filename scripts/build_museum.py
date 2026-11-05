"""Build the museum's similarity graph from scripts/.cache/index.jsonl.

Each object becomes a TF-IDF vector over words from its title, family and its
sand3d program (function and part names). Objects are clustered into themes
(rooms) with spherical k-means inside each collection; each theme links to its
most similar themes (centroid cosine), mostly within its collection and
sometimes across. Output: public/museum/themes.json, public/museum/t/<shard>.json,
public/museum/pools.json (shop stock for the world mode).

Usage: python3 scripts/build_museum.py
"""
import collections
import json
import math
import os
import zlib

import re

import numpy as np

EXTRA_STOP = set("""spacing distance dist half margin extra rows cols start end all overall overlap central boolean extrusion
cutter wall rib cut feature features shape shapes solid solids generic thing object item model misc set low poly lowpoly
free game ready asset assets version test new final mesh simple untitled scene export the and with for""".split())
TITLE_WORD = re.compile(r"[a-z]{3,}")


def title_words(title, fam):
    fw = set(fam.lower().replace("_", " ").split())
    out = []
    for w in TITLE_WORD.findall((title or "").lower()):
        if w in EXTRA_STOP or w in fw or w in ("and", "the", "for", "with", "from"):
            continue
        out.append(w)
    return out

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "public", "museum")
D = 1024
PER_THEME = 20
SHARD = 100
rng = np.random.default_rng(7)

COLLECTION = {
    "cad": "CAD Parts",
    "articraft": "Articulated Mechanisms",
    "simready": "SimReady Assets",
    "automate": "Mechanical Assemblies",
}

WINGS = [
    ("Vehicles", "objaverse", "vehicle", "cars, trucks, trains, carts — anything with wheels"),
    ("Musical Instruments", "objaverse", "musical instrument", "strings, keys, drums and horns"),
    ("Food & Drink", "objaverse", "food and drink", "fruit, cakes, bottles and burgers"),
    ("Moving Mechanisms", "articraft", None, "articulated objects whose joints really move"),
    ("Machine Parts", "cad", None, "brackets, flanges, gears: precise CAD parts"),
    ("Aircraft & Spacecraft", "objaverse", "aircraft or spacecraft", "planes, rockets, satellites"),
]


def h(tok):
    v = zlib.crc32(tok.encode())
    return v % D, 1.0 if (v >> 20) & 1 else -1.0


def compact(r):
    ds, split, row, oid, fam, entry, title, author, url, lic, path, nbytes, f, joints = r[:14]
    return [ds, split, row, oid, fam, entry, title, author, url, lic, path, nbytes, f, joints]


def nice(fam):
    return fam.title().replace(" And ", " & ").replace(" Or ", " & ")


def collection_of(r):
    ds, fam = r[0], r[4]
    if ds == "objaverse":
        return nice(fam or "misc")
    return COLLECTION.get(ds, ds)


def kmeans(X, k, iters=14):
    n = X.shape[0]
    if k <= 1 or n <= 2:
        return np.zeros(n, dtype=np.int32), X.mean(0, keepdims=True)
    C = X[rng.choice(n, size=k, replace=False)].copy()
    lab = np.zeros(n, dtype=np.int32)
    for _ in range(iters):
        for s in range(0, n, 8192):
            lab[s:s + 8192] = np.argmax(X[s:s + 8192] @ C.T, axis=1)
        newC = np.zeros_like(C)
        np.add.at(newC, lab, X)
        counts = np.bincount(lab, minlength=k)
        empty = np.where(counts == 0)[0]
        if len(empty):
            newC[empty] = X[rng.choice(n, size=len(empty), replace=False)]
        norms = np.linalg.norm(newC, axis=1, keepdims=True)
        C = newC / np.maximum(norms, 1e-9)
    return lab, C


def main():
    rows = {}
    for line in open(os.path.join(HERE, ".cache", "index.jsonl")):
        r = json.loads(line)
        if r[11] <= 0 or r[11] > 2_500_000 or r[12] < 0.75:
            continue
        r[14] = " ".join(w for w in r[14].split() if w not in EXTRA_STOP)
        if not r[14].strip():
            continue
        rows[r[3]] = r
    rows = list(rows.values())
    print(len(rows), "objects")

    by_col = collections.defaultdict(list)
    for r in rows:
        by_col[collection_of(r)].append(r)

    themes = []  # dicts
    centroids = []
    for col, items in sorted(by_col.items()):
        toks = [r[14].split() for r in items]
        df = collections.Counter()
        for t in toks:
            df.update(set(t))
        N = len(items)
        tdf_all = collections.Counter()
        for r in items:
            tdf_all.update(set(title_words(r[6], r[4])))
        X = np.zeros((N, D), dtype=np.float32)
        for i, t in enumerate(toks):
            tf = collections.Counter(t)
            for w, c in tf.items():
                if df[w] < 2 and N > 50:
                    continue
                j, sgn = h(w)
                X[i, j] += sgn * (1 + math.log(c)) * math.log(N / df[w] + 1)
        X /= np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-9)
        k = max(1, round(N / PER_THEME))
        lab, C = kmeans(X, k)
        print(f"{col}: {N} objects -> {k} themes")
        for c in range(C.shape[0]):
            idx = np.where(lab == c)[0]
            if not len(idx):
                continue
            sims = X[idx] @ C[c]
            # order: hero first, then greedy groups of 3 similar objects
            rest = list(idx[np.argsort(-sims)])
            order = [rest.pop(0)]
            while rest:
                seed = rest.pop(0)
                if rest:
                    s2 = X[rest] @ X[seed]
                    take = [rest[i] for i in np.argsort(-s2)[:2]]
                    rest = [x for x in rest if x not in take]
                else:
                    take = []
                order += [seed] + take
            members = [items[i] for i in order]
            # name from the most distinctive words
            cdf = collections.Counter()
            for i in idx:
                cdf.update(set(toks[i]))
            score = {w: (cnt / len(idx)) * math.log(N / df[w] + 1) for w, cnt in cdf.items() if cnt >= max(2, len(idx) * 0.25) or len(idx) < 4}
            top = [w for w, _ in sorted(score.items(), key=lambda kv: -kv[1])][:8]
            # names read best from the objects' titles when the titles agree
            tdf = collections.Counter()
            for i in idx:
                tdf.update(set(title_words(items[i][6], items[i][4])))
            tscore = {w: (cnt / len(idx)) * math.log(N / max(1, tdf_all[w]) + 1) for w, cnt in tdf.items() if cnt >= max(2, len(idx) * 0.15)}
            tnames = [w for w, _ in sorted(tscore.items(), key=lambda kv: -kv[1])]
            name_words = []
            for w in tnames + top:
                if all(not (w.startswith(x) or x.startswith(w)) for x in name_words):
                    name_words.append(w)
                if len(name_words) == 2:
                    break
            name = " & ".join(w.title() for w in name_words) or col
            themes.append({"name": name, "col": col, "members": members, "words": top[:6]})
            centroids.append(C[c])

    C = np.stack(centroids)
    C /= np.maximum(np.linalg.norm(C, axis=1, keepdims=True), 1e-9)
    cols = [t["col"] for t in themes]
    col_ids = sorted(set(cols))
    col_arr = np.array([col_ids.index(c) for c in cols])
    T = len(themes)
    print(T, "themes")
    for s in range(0, T, 1024):
        S = C[s:s + 1024] @ C.T
        for i in range(S.shape[0]):
            ti = s + i
            S[i, ti] = -9
            same = np.where(col_arr == col_arr[ti], S[i], -9)
            other = np.where(col_arr != col_arr[ti], S[i], -9)
            a = list(np.argsort(-same)[:4])
            b = list(np.argsort(-other)[:2])
            nb = [a[0], b[0], a[1], a[2], b[1], a[3]]
            themes[ti]["nb"] = [int(x) for x in nb if S[i, x] > -9]

    # wings: the biggest theme in each chosen collection
    wings = []
    for name, ds, fam, blurb in WINGS:
        col = nice(fam or "") if ds == "objaverse" else COLLECTION[ds]
        cands = [i for i, t in enumerate(themes) if t["col"] == col]
        if not cands:
            continue
        best = max(cands, key=lambda i: len(themes[i]["members"]))
        prev = [compact(r) for r in themes[best]["members"] if r[11] < 900_000][:2]
        wings.append({"name": name, "blurb": blurb, "theme": best, "preview": prev})

    os.makedirs(os.path.join(OUT, "t"), exist_ok=True)
    for f in os.listdir(os.path.join(OUT, "t")):
        os.remove(os.path.join(OUT, "t", f))
    shards = collections.defaultdict(dict)
    for i, t in enumerate(themes):
        shards[i // SHARD][str(i)] = [compact(r) for r in t["members"]]
    for s, d in shards.items():
        with open(os.path.join(OUT, "t", f"{s}.json"), "w") as f:
            json.dump(d, f, separators=(",", ":"), ensure_ascii=False)
    out = {
        "total": len(rows),
        "collections": col_ids,
        "themes": [[t["name"], col_ids.index(t["col"]), len(t["members"]), t["nb"], i // SHARD, " ".join(t["words"])] for i, t in enumerate(themes)],
        "wings": wings,
        "shardSize": SHARD,
    }
    with open(os.path.join(OUT, "themes.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)

    # shop stock for the world mode
    pools = collections.defaultdict(list)
    for r in sorted(rows, key=lambda r: -r[12]):
        if r[11] > 500_000 or r[12] < 0.85:
            continue
        key = r[4] if r[0] == "objaverse" else f"{r[0]}:{r[4]}" if r[0] == "simready" else r[0]
        if len(pools[key]) < 220:
            pools[key].append(compact(r))
    with open(os.path.join(OUT, "pools.json"), "w") as f:
        json.dump(pools, f, separators=(",", ":"), ensure_ascii=False)
    sizes = sum(os.path.getsize(os.path.join(OUT, "t", x)) for x in os.listdir(os.path.join(OUT, "t")))
    print(f"themes.json {os.path.getsize(os.path.join(OUT, 'themes.json')) / 1e6:.1f} MB, shards {sizes / 1e6:.1f} MB, pools {os.path.getsize(os.path.join(OUT, 'pools.json')) / 1e6:.1f} MB")
    print("wings:", [(w["name"], themes[w["theme"]]["name"], len(themes[w["theme"]]["members"])) for w in wings])
    print("pool keys:", sorted(pools))


if __name__ == "__main__":
    main()
