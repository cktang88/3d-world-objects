"""Fetch metadata for every object in all five sand3d datasets (~105K rows).

For each row keeps: dataset, split, row offset, id, family, entry, title, author,
source url, licences, usda path/bytes, f_score, joints, plus a bag of words from
the title, family and the program's own identifiers (function names, part names,
named constants). Those words drive the museum's similarity graph.

Writes scripts/.cache/index.jsonl (one JSON list per row). Resumable.
Usage: python3 scripts/fetch_index.py
"""
import concurrent.futures as cf
import json
import os
import re
import sys
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, ".cache", "index.jsonl")
DONE = os.path.join(HERE, ".cache", "index.done")
DATASETS = ["objaverse", "cad", "articraft", "simready", "automate"]
SPLITS = ["train", "validation"]
PAGE = 100

STOP = set("""s3d sand3d import def return none true false self math range len float int str list dict
the and for with from into this that are was via top bottom left right front back side inner outer
part parts body base main assembly group object obj make build new old get set mid center centre
min max total size width height depth length radius thick thickness count offset pos rot angle num
dia diameter pitch gap clearance edge edges face faces frame local move join cut hole holes fillet chamfer
extrude revolve sweep loft shell box cylinder sphere rect circle poly polygon arc spline profile path
at grid ring along snap material plastic metal default value values scale unit units mm deg rad
x y z w h d r t a b c n i j k p q v u l m s e f g o pt pts dims dim spec specs config params param
model file version modified rewritten program sample record sketchfab cc by license licence
ok left_ right_ lower upper inner_ outer_ one two three four first second""".split())

TITLE_RE = re.compile(r'^"(.*?)" by (.*?), (https://\S+), ([\w.-]+)')
WORD_RE = re.compile(r"[A-Za-z][a-z]+|[A-Z]+(?![a-z])")


def words(s):
    out = []
    for w in WORD_RE.findall(s or ""):
        w = w.lower()
        if len(w) >= 3 and w not in STOP and w.isascii():
            out.append(w)
    return out


def program_words(prog):
    ws = []
    for name in re.findall(r"def\s+(\w+)", prog or ""):
        ws += words(name.replace("_", " "))
    for lit in re.findall(r"['\"]([a-z][a-z0-9_]{2,40})['\"]", prog or ""):
        ws += words(lit.replace("_", " "))
    for const in re.findall(r"^([A-Z][A-Z0-9_]{2,})\s*=", prog or "", re.M):
        ws += words(const.replace("_", " ").lower())
    return ws


def get(url):
    for i in range(6):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            print("retry", url[-60:], e, file=sys.stderr)
            time.sleep(2 ** i)
    return None


def size(ds, split):
    d = get(f"https://datasets-server.huggingface.co/size?dataset=Sandflow/sand3d-{ds}")
    for s in d["size"]["splits"]:
        if s["config"] == "default" and s["split"] == split:
            return s["num_rows"]
    return 0


lock = threading.Lock()


def page(ds, split, off, fout):
    url = (f"https://datasets-server.huggingface.co/rows?dataset=Sandflow/sand3d-{ds}"
           f"&config=default&split={split}&offset={off}&length={PAGE}")
    d = get(url)
    if not d or "rows" not in d:
        return False
    lines = []
    for r in d["rows"]:
        row = r["row"]
        if row.get("license_status") not in (None, "ok"):
            continue
        attr = row.get("attribution") or ""
        m = TITLE_RE.match(attr)
        title = m.group(1) if m else ""
        author = m.group(2) if m else ""
        src_url = m.group(3) if m else ""
        fam = str(row.get("family") or "")
        if fam in ("None", "none"):
            fam = ""
        entry = row.get("entry") or ""
        if entry == "None":
            entry = ""
        tw = words(title) * 3 + words(fam.replace("_", " ")) * 3 + words(entry.replace("_", " ")) * 2 + program_words(row.get("program"))
        if not title:
            title = (entry or fam or row["id"]).replace("_", " ")
        lines.append(json.dumps([
            ds, split, r["row_idx"], row["id"], fam, entry, title[:120], author[:80], src_url,
            row.get("source_license") or "", row["usda_path"], int(row.get("usda_bytes") or 0),
            round(float(row.get("f_score") or 0), 3), int(row.get("n_joints") or 0), " ".join(tw[:200]),
            attr[:300],
        ], ensure_ascii=False))
    with lock:
        fout.write("\n".join(lines) + "\n")
        fout.flush()
    return True


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    done = set(open(DONE).read().split()) if os.path.exists(DONE) else set()
    jobs = []
    for ds in DATASETS:
        for split in SPLITS:
            n = size(ds, split)
            print(ds, split, n, file=sys.stderr)
            for off in range(0, n, PAGE):
                key = f"{ds}:{split}:{off}"
                if key not in done:
                    jobs.append((ds, split, off, key))
    print(len(jobs), "pages to fetch", file=sys.stderr)
    with open(OUT, "a") as fout, open(DONE, "a") as fdone, cf.ThreadPoolExecutor(8) as ex:
        futs = {ex.submit(page, ds, sp, off, fout): key for ds, sp, off, key in jobs}
        n = 0
        for f in cf.as_completed(futs):
            n += 1
            if f.result():
                with lock:
                    fdone.write(futs[f] + "\n")
                    fdone.flush()
            if n % 50 == 0:
                print(f"{n}/{len(jobs)}", file=sys.stderr)
    print("done")


if __name__ == "__main__":
    main()
