#!/usr/bin/env python3
"""
Real sizes for every museum object, so a gallery can be planned without measuring anything at runtime.

Streams each object's USDA from Hugging Face (never stored), reads only the prim hierarchy, the
xformOps and each mesh's `extent`, and unions the transformed extent boxes. The point arrays are
skipped. Output: public/museum/s/<shard>.json  {theme: [[x, y, z] or 0, ...]} in the order of t/<shard>.json, in Y-up axes (metres, raw
source size: the runtime still applies realScale).

    python3 scripts/build_sizes.py [--workers 16] [--minutes 14] [--cache /path/sizes.jsonl] [--limit N]

Resumable: finished ids are appended to the cache file and skipped on the next run.
"""
import argparse
import glob
import json
import math
import os
import re
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
NUM = re.compile(r'-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?')
DEF = re.compile(r'^\s*(def|over|class)\s+(\w+)?\s*"([^"]*)"')
OP = re.compile(r'^\s*(?:uniform\s+)?\w+\s+(xformOp:[\w:]+)\s*=\s*(.*)$')
ORDER = re.compile(r'xformOpOrder\s*=\s*\[(.*)\]')
EXTENT = re.compile(r'^\s*float3\[\]\s+extent\s*=\s*\[(.*)\]')


def ident():
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def mul(a, b):
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4)) for r in range(4) for c in range(4)]


def quat(w, x, y, z):
    return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
            2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
            2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0,
            0, 0, 0, 1]


def rot_axis(ax, deg):
    t = math.radians(deg)
    c, s = math.cos(t), math.sin(t)
    if ax == 'X':
        return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]
    if ax == 'Y':
        return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]
    return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def local(ops, order):
    m = ident()
    for op in order:
        if op.startswith('!invert!') or op not in ops:
            continue
        a = [float(v) for v in NUM.findall(ops[op])]
        base = op.split(':')[1] if ':' in op else op
        if base == 'translate':
            o = [1, 0, 0, a[0], 0, 1, 0, a[1], 0, 0, 1, a[2], 0, 0, 0, 1]
        elif base == 'orient':
            o = quat(*a[:4])
        elif base == 'scale':
            o = [a[0], 0, 0, 0, 0, a[1], 0, 0, 0, 0, a[2], 0, 0, 0, 0, 1]
        elif base == 'transform':
            o = [a[0], a[4], a[8], a[12], a[1], a[5], a[9], a[13], a[2], a[6], a[10], a[14], a[3], a[7], a[11], a[15]]
        elif re.match(r'^rotate[XYZ]{3}$', base):
            o = ident()
            for i in range(3):
                o = mul(rot_axis(base[6 + i], a[i]), o)
        elif re.match(r'^rotate[XYZ]$', base):
            o = rot_axis(base[6], a[0])
        else:
            continue
        m = mul(m, o)
    return m


class Frame:
    __slots__ = ('kind', 'ops', 'order', 'world', 'extent', 'parent', 'points')

    def __init__(self, kind, parent):
        self.kind, self.parent = kind, parent
        self.ops, self.order, self.world, self.extent, self.points = {}, [], None, None, None

    def w(self):
        if self.world is None:
            pw = self.parent.w() if self.parent else ident()
            self.world = mul(pw, local(self.ops, self.order))
        return self.world


def bbox_of(lines):
    """lines: an iterator of text lines of one USDA file. Returns (min, max) in Z-up source axes."""
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    stack = []  # frames, or None for dictionaries / non-prim braces
    pending = None  # a def seen, waiting for its '{'
    cur = None
    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        if s == '{':
            if pending is not None:
                stack.append(pending)
                cur = pending
                pending = None
            else:
                stack.append(None)
            continue
        if s == '}':
            if not stack:
                continue
            f = stack.pop()
            if f is not None:
                box = f.extent or f.points
                if box:
                    w = f.w()
                    for cx in (box[0], box[3]):
                        for cy in (box[1], box[4]):
                            for cz in (box[2], box[5]):
                                p = (w[0] * cx + w[1] * cy + w[2] * cz + w[3], w[4] * cx + w[5] * cy + w[6] * cz + w[7], w[8] * cx + w[9] * cy + w[10] * cz + w[11])
                                for a in range(3):
                                    lo[a] = min(lo[a], p[a])
                                    hi[a] = max(hi[a], p[a])
            cur = next((x for x in reversed(stack) if x is not None), None)
            continue
        m = DEF.match(s)
        if m:
            # its parent's transform is complete now
            pending = Frame(m.group(2) or '', cur)
            if s.endswith('{'):
                stack.append(pending)
                cur = pending
                pending = None
            continue
        if s.endswith('= {'):
            stack.append(None)
            continue
        if cur is None:
            continue
        if 'xformOp' in s[:80]:
            mo = ORDER.search(s)
            if mo:
                cur.order = re.findall(r'"([^"]+)"', mo.group(1))
                cur.world = None
                continue
            mo = OP.match(s)
            if mo:
                cur.ops[mo.group(1)] = mo.group(2)
                cur.world = None
                continue
        if cur.kind == 'Mesh':
            if s.startswith('float3[] extent'):
                v = [float(x) for x in NUM.findall(s.split('=', 1)[1])]
                if len(v) >= 6:
                    cur.extent = v[:6]
            elif cur.extent is None and s.startswith('point3f[] points'):
                v = [float(x) for x in NUM.findall(s.split('=', 1)[1])]
                if len(v) >= 3:
                    xs, ys, zs = v[0::3], v[1::3], v[2::3]
                    cur.points = [min(xs), min(ys), min(zs), max(xs), max(ys), max(zs)]
    if not math.isfinite(lo[0]):
        return None
    return lo, hi


def iter_lines(resp):
    buf = b''
    while True:
        chunk = resp.read(1 << 18)
        if not chunk:
            break
        buf += chunk
        *ls, buf = buf.split(b'\n')
        for l in ls:
            # skip the huge arrays without decoding them (except points, needed only if a mesh has no extent)
            if len(l) > 4096 and b'point3f[] points' not in l[:200]:
                yield l[:200].decode('utf-8', 'replace')
            else:
                yield l.decode('utf-8', 'replace')
    if buf:
        yield buf.decode('utf-8', 'replace')


def size_of(entry):
    ds, path = entry[0], entry[10]
    url = f'https://huggingface.co/datasets/Sandflow/sand3d-{ds}/resolve/main/{path}'
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'sand3d-museum-sizes'}), timeout=120) as r:
                b = bbox_of(iter_lines(r))
            if not b:
                return None
            lo, hi = b
            # Z-up source -> the app's Y-up: (x, z, y)
            return [round(hi[0] - lo[0], 4), round(hi[2] - lo[2], 4), round(hi[1] - lo[1], 4)]
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                print('fail', entry[3], e, file=sys.stderr)
                return None
            time.sleep(2 + attempt * 3)


def compact(v):
    return [float(f'{x:.3g}') for x in v]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=16)
    ap.add_argument('--cache', default=os.path.join(ROOT, '.sizes-cache.jsonl'))
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--write-only', action='store_true')
    ap.add_argument('--minutes', type=float, default=14, help='stop after this long; run again to resume')
    args = ap.parse_args()

    shards = {}
    themes = {}  # shard -> {theme: members in order}
    for f in sorted(glob.glob(os.path.join(ROOT, 'public/museum/t/*.json'))):
        sh = os.path.basename(f)[:-5]
        themes[sh] = json.load(open(f))
        for _, v in themes[sh].items():
            shards.setdefault(sh, []).extend(v)
    done = {}
    if os.path.exists(args.cache):
        for ln in open(args.cache):
            try:
                k, v = json.loads(ln)
                done[k] = v
            except ValueError:
                pass
    todo = [e for es in shards.values() for e in es if e[3] not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(time.strftime('%H:%M:%S'), f'{len(done)} known, {len(todo)} to measure', flush=True)
    lock = threading.Lock()
    out = open(args.cache, 'a')
    t0 = time.time()
    n = [0]

    def work(e):
        v = size_of(e)
        with lock:
            done[e[3]] = v
            out.write(json.dumps([e[3], v]) + '\n')
            n[0] += 1
            if n[0] % 100 == 0:
                out.flush()
                dt = time.time() - t0
                if n[0] % 500 == 0:
                    print(time.strftime('%H:%M:%S'), f'{n[0]}/{len(todo)}  {n[0] / dt:.1f}/s  eta {(len(todo) - n[0]) / max(1e-6, n[0] / dt) / 60:.0f} min', flush=True)

    if not args.write_only:
        # chunks of at most --minutes, resumable from the cache (house rule: no long jobs)
        with ThreadPoolExecutor(args.workers) as ex:
            for i in range(0, len(todo), 200):
                if time.time() - t0 > args.minutes * 60:
                    print(time.strftime('%H:%M:%S'), f'stopping after {args.minutes} min; run again to resume', flush=True)
                    break
                list(ex.map(work, todo[i:i + 200]))
    out.close()

    os.makedirs(os.path.join(ROOT, 'public/museum/s'), exist_ok=True)
    total = 0
    # compact: per theme, the sizes in the same order as its members in t/<shard>.json (0 = unknown)
    for sh, ts in themes.items():
        m = {}
        for tid, es in ts.items():
            m[tid] = [compact(done[e[3]]) if done.get(e[3]) else 0 for e in es]
            total += sum(1 for v in m[tid] if v)
        with open(os.path.join(ROOT, f'public/museum/s/{sh}.json'), 'w') as f:
            json.dump(m, f, separators=(',', ':'))
    print(f'wrote sizes for {total} objects', flush=True)


if __name__ == '__main__':
    main()
