/**
 * Detail-preserving mesh simplification on plain arrays (no three.js, no DOM), shared by the
 * browser LOD builder (src/meshlod.ts, its worker) and the Node asset builders (scripts/*.mjs run it
 * directly through Node's type stripping). Wraps meshoptimizer 1.3's simplifier (vendored in
 * src/vendor, MIT): quadric-error edge collapse with attribute error (normals, UVs, colours),
 * UV-seam protection, component pruning, and LOD chains whose errors drive screen-space switching.
 * See .claude/skills/mesh-simplification/SKILL.md.
 */
import { MeshoptSimplifier } from './vendor/meshopt_simplifier.js';

export const simplifierReady: Promise<void> = MeshoptSimplifier.ready;

export interface MeshArrays {
  index: Uint32Array;
  /** xyz per vertex */
  position: Float32Array;
  /** xyz per vertex (unit) */
  normal?: Float32Array | null;
  /** uv per vertex (the base-colour / normal-map set) */
  uv?: Float32Array | null;
  /** rgb or rgba per vertex in 0..1 */
  color?: Float32Array | null;
  colorSize?: number;
}

export interface SimplifyOptions {
  /** target triangle count (default: as far as `error` allows) */
  targetTris?: number;
  /** error limit; relative to the mesh extent unless `absolute` (default 1e-2 relative) */
  error?: number;
  absolute?: boolean;
  /** attribute weights (0 = ignore); normals ~0.5-1, uv auto from texel density when undefined */
  normalWeight?: number;
  uvWeight?: number;
  colorWeight?: number;
  /** allow collapses across normal seams (hard edges) but keep UV seams fixed: needed for faceted meshes */
  permissive?: boolean;
  /** drop isolated components under the error (bolts, emblems far away). Default true */
  prune?: boolean;
  /** keep open borders in place (tiles that must stitch). Default false */
  lockBorder?: boolean;
}

export interface SimplifyResult {
  index: Uint32Array;
  /** absolute error (mesh units): the largest deviation the simplifier measured */
  error: number;
}

const tri = (a: Float32Array, s: number, i0: number, i1: number, i2: number) => {
  if (s === 2) {
    const x1 = a[i1 * 2] - a[i0 * 2], y1 = a[i1 * 2 + 1] - a[i0 * 2 + 1];
    const x2 = a[i2 * 2] - a[i0 * 2], y2 = a[i2 * 2 + 1] - a[i0 * 2 + 1];
    return Math.abs(x1 * y2 - x2 * y1) / 2;
  }
  const x1 = a[i1 * 3] - a[i0 * 3], y1 = a[i1 * 3 + 1] - a[i0 * 3 + 1], z1 = a[i1 * 3 + 2] - a[i0 * 3 + 2];
  const x2 = a[i2 * 3] - a[i0 * 3], y2 = a[i2 * 3 + 1] - a[i0 * 3 + 1], z2 = a[i2 * 3 + 2] - a[i0 * 3 + 2];
  const cx = y1 * z2 - z1 * y2, cy = z1 * x2 - x1 * z2, cz = x1 * y2 - y1 * x2;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
};

/** largest bbox side (the simplifier's relative-error unit) */
export function extent(position: Float32Array) {
  return MeshoptSimplifier.getScale(position, 3);
}

/**
 * UV weight from texel density: a UV error equal to the position error should cost about as much,
 * with positions normalised to the mesh extent (what the simplifier does internally); then x4 because
 * texture swimming shows before silhouette error does. Clamped to the 1..100 range meshoptimizer suggests.
 */
export function autoUvWeight(m: MeshArrays) {
  if (!m.uv) return 0;
  const ext = extent(m.position) || 1;
  let pa = 0, ua = 0;
  const ix = m.index;
  const step = Math.max(3, Math.floor(ix.length / 3 / 20000) * 3);
  for (let i = 0; i + 2 < ix.length; i += step) {
    pa += tri(m.position, 3, ix[i], ix[i + 1], ix[i + 2]);
    ua += tri(m.uv, 2, ix[i], ix[i + 1], ix[i + 2]);
  }
  if (ua <= 0) return 0;
  return Math.min(100, Math.max(1, 4 * Math.sqrt(pa / (ext * ext) / ua)));
}

/**
 * Vertex lock for permissive mode: 2 ("protect": may slide along the seam, never across it) on every
 * vertex whose position is shared by a vertex with a different UV, so textures and baked normal maps
 * stay glued; normal-only seams are left free so hard-edged (faceted) meshes can collapse.
 */
export function uvSeamLock(m: MeshArrays): Uint8Array | null {
  if (!m.uv) return null;
  const remap = MeshoptSimplifier.generatePositionRemap(m.position, 3);
  const n = m.position.length / 3;
  const lock = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = remap[i];
    if (r === i) continue;
    if (Math.abs(m.uv[i * 2] - m.uv[r * 2]) > 1e-6 || Math.abs(m.uv[i * 2 + 1] - m.uv[r * 2 + 1]) > 1e-6) lock[i] = lock[r] = 2;
  }
  return lock;
}

/** interleave weighted attributes for simplifyWithAttributes */
function attributes(m: MeshArrays, o: SimplifyOptions) {
  const n = m.position.length / 3;
  const nw = m.normal ? (o.normalWeight ?? 0.5) : 0;
  const uw = m.uv ? (o.uvWeight ?? autoUvWeight(m)) : 0;
  const cs = m.color ? (m.colorSize ?? 3) : 0;
  const cw = m.color ? (o.colorWeight ?? 1) : 0;
  const parts: { a: Float32Array; s: number; take: number; w: number }[] = [];
  if (nw > 0) parts.push({ a: m.normal!, s: 3, take: 3, w: nw });
  if (uw > 0) parts.push({ a: m.uv!, s: 2, take: 2, w: uw });
  if (cw > 0) parts.push({ a: m.color!, s: cs, take: Math.min(cs, 3), w: cw });
  const stride = parts.reduce((s, p) => s + p.take, 0);
  const out = new Float32Array(Math.max(1, stride) * n);
  const weights: number[] = [];
  let off = 0;
  for (const p of parts) {
    for (let i = 0; i < n; i++) for (let k = 0; k < p.take; k++) out[i * stride + off + k] = p.a[i * p.s + k];
    for (let k = 0; k < p.take; k++) weights.push(p.w);
    off += p.take;
  }
  return { attr: out, stride, weights };
}

/**
 * One simplification of an indexed mesh. Returns a new index buffer over the same vertices (render
 * it with the original vertex buffers, or compact it) and the absolute error reached.
 */
export function simplifyMesh(m: MeshArrays, o: SimplifyOptions = {}): SimplifyResult {
  const ext = extent(m.position) || 1;
  const flags: ('ErrorAbsolute' | 'Prune' | 'Permissive' | 'LockBorder' | 'ErrorClamped')[] = ['ErrorAbsolute', 'ErrorClamped'];
  if (o.prune !== false) flags.push('Prune');
  if (o.permissive) flags.push('Permissive');
  if (o.lockBorder) flags.push('LockBorder');
  const err = o.absolute ? (o.error ?? 1e-2 * ext) : (o.error ?? 1e-2) * ext;
  const target = Math.max(0, Math.min(m.index.length, Math.floor(o.targetTris ?? 0) * 3));
  const { attr, stride, weights } = attributes(m, o);
  const lock = o.permissive ? uvSeamLock(m) : null;
  const [index, e] = weights.length
    ? MeshoptSimplifier.simplifyWithAttributes(m.index, m.position, 3, attr, stride, weights, lock, target, err, flags)
    : MeshoptSimplifier.simplify(m.index, m.position, 3, target, err, flags);
  return { index, error: e };
}

/**
 * Topology-free simplification (vertex clustering-like): merges spatially close but disconnected parts and
 * ignores seams/borders. Worse quality than simplifyMesh; use as a fallback for far LODs of meshes built
 * from many open patches, where edge collapse saturates (accord19: stuck at ~24k from 0.01 to 0.2 m error).
 */
export function simplifySloppyMesh(m: MeshArrays, targetTris: number, errorAbs = Infinity): SimplifyResult {
  const ext = extent(m.position) || 1;
  const [index, e] = MeshoptSimplifier.simplifySloppy(m.index, m.position, 3, null, Math.max(0, Math.floor(targetTris)) * 3, Math.min(1, errorAbs / ext));
  return { index, error: e * ext };
}

export interface LodLevel {
  index: Uint32Array;
  /** accumulated absolute error (mesh units) of this level vs the original */
  error: number;
  tris: number;
}

/**
 * A LOD chain by triangle ratio, each level simplified from the previous one (faster, and transitions
 * stay consistent); errors accumulate. Level 0 is the input itself (error 0). Levels that do not get
 * below `minGain` x the previous level's triangles are dropped (seams or the error cap stopped them).
 */
export function lodChain(m: MeshArrays, ratios: number[], o: Omit<SimplifyOptions, 'targetTris'> & { maxError?: number; minGain?: number } = {}): LodLevel[] {
  const ext = extent(m.position) || 1;
  const levels: LodLevel[] = [{ index: m.index, error: 0, tris: m.index.length / 3 }];
  const full = m.index.length / 3;
  let acc = 0;
  for (const r of ratios) {
    if (r >= 1) continue;
    const prev = levels[levels.length - 1];
    let res = simplifyMesh({ ...m, index: prev.index }, { ...o, targetTris: full * r, error: o.maxError ?? 0.25, absolute: false });
    // stuck on normal seams (faceted export): allow collapses across them, uv seams stay protected
    if (res.index.length / 3 > prev.tris * (o.minGain ?? 0.7) && !o.permissive)
      res = simplifyMesh({ ...m, index: prev.index }, { ...o, permissive: true, targetTris: full * r, error: o.maxError ?? 0.25, absolute: false });
    const tris = res.index.length / 3;
    if (tris > prev.tris * (o.minGain ?? 0.7) || tris < 4) continue;
    acc += res.error;
    levels.push({ index: res.index, error: Math.max(acc, 1e-4 * ext), tris });
  }
  return levels;
}

/**
 * Screen-space LOD rule (meshoptimizer's): a level with absolute error e (world units) may be used
 * while e projects to at most `pixels` on screen. At distance d from the bounding sphere's surface,
 * one pixel spans d * 2 tan(fov/2) / screenHeight world units.
 */
export function pixelSize(distance: number, fovYDeg: number, screenHeight: number) {
  return (Math.max(0, distance) * 2 * Math.tan((fovYDeg * Math.PI) / 360)) / Math.max(1, screenHeight);
}
/** the distance (from the bounding sphere's surface) beyond which error `e` is under `pixels` */
export function switchDistance(e: number, fovYDeg: number, screenHeight: number, pixels = 1) {
  return (e * screenHeight) / (pixels * 2 * Math.tan((fovYDeg * Math.PI) / 360));
}

/** drop unused vertices: returns the remap (old -> new, 0xffffffff unused) and the new vertex count */
export function compact(index: Uint32Array): { index: Uint32Array; remap: Uint32Array; count: number } {
  const ix = index.slice();
  const [remap, count] = MeshoptSimplifier.compactMesh(ix);
  return { index: ix, remap, count };
}
export function remapAttribute(a: Float32Array | Uint16Array | Uint8Array | Int16Array | Int8Array | Uint32Array, size: number, remap: Uint32Array, count: number) {
  const out = new (a.constructor as Float32ArrayConstructor)(count * size);
  for (let i = 0; i < remap.length; i++) {
    const r = remap[i];
    if (r === 0xffffffff) continue;
    for (let k = 0; k < size; k++) out[r * size + k] = a[i * size + k];
  }
  return out;
}

// ------------------------------------------------------------------ quality metrics (Node qa, build logs)

/** bbox of the vertices an index references */
export function usedBox(position: Float32Array, index: Uint32Array) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < index.length; i++) {
    const v = index[i] * 3;
    for (let k = 0; k < 3; k++) {
      const x = position[v + k];
      if (x < b[k]) b[k] = x;
      if (x > b[k + 3]) b[k + 3] = x;
    }
  }
  return b;
}

/**
 * One-sided Hausdorff-style distance from points on mesh A to the surface of mesh B (both world/mesh
 * units): samples `samples` area-weighted points on A, finds the nearest triangle of B through a
 * uniform grid. Returns max and mean distance. Use A = original, B = LOD (detail lost) and the reverse
 * (spikes added).
 */
export function surfaceDistance(aPos: Float32Array, aIdx: Uint32Array, bPos: Float32Array, bIdx: Uint32Array, samples = 4000, outlier?: number) {
  // grid over B's triangles
  const box = usedBox(bPos, bIdx);
  const ab = usedBox(aPos, aIdx);
  for (let k = 0; k < 3; k++) {
    box[k] = Math.min(box[k], ab[k]);
    box[k + 3] = Math.max(box[k + 3], ab[k + 3]);
  }
  const ext = Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2], 1e-9);
  const ntri = bIdx.length / 3;
  const res = Math.max(4, Math.min(96, Math.round(Math.cbrt(ntri) * 1.5)));
  const cell = ext / res;
  const dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((box[k + 3] - box[k]) / cell)));
  const cells = new Map<number, number[]>();
  const key = (x: number, y: number, z: number) => (x * dims[1] + y) * dims[2] + z;
  const cl = (v: number, k: number) => Math.min(dims[k] - 1, Math.max(0, Math.floor((v - box[k]) / cell)));
  for (let t = 0; t < ntri; t++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let c = 0; c < 3; c++) {
      const v = bIdx[t * 3 + c] * 3;
      x0 = Math.min(x0, bPos[v]); x1 = Math.max(x1, bPos[v]);
      y0 = Math.min(y0, bPos[v + 1]); y1 = Math.max(y1, bPos[v + 1]);
      z0 = Math.min(z0, bPos[v + 2]); z1 = Math.max(z1, bPos[v + 2]);
    }
    for (let x = cl(x0, 0); x <= cl(x1, 0); x++)
      for (let y = cl(y0, 1); y <= cl(y1, 1); y++)
        for (let z = cl(z0, 2); z <= cl(z1, 2); z++) {
          const k = key(x, y, z);
          let l = cells.get(k);
          if (!l) cells.set(k, (l = []));
          l.push(t);
        }
  }
  // area-weighted samples on A (deterministic)
  const na = aIdx.length / 3;
  const cum = new Float64Array(na);
  let total = 0;
  for (let t = 0; t < na; t++) cum[t] = total += tri(aPos, 3, aIdx[t * 3], aIdx[t * 3 + 1], aIdx[t * 3 + 2]);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  let max = 0, sum = 0;
  const p = [0, 0, 0];
  let at = [0, 0, 0];
  let over = 0;
  for (let s = 0; s < samples; s++) {
    const r = rnd() * total;
    let lo = 0, hi = na - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    let u = rnd(), v = rnd();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const i0 = aIdx[lo * 3] * 3, i1 = aIdx[lo * 3 + 1] * 3, i2 = aIdx[lo * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) p[k] = aPos[i0 + k] + u * (aPos[i1 + k] - aPos[i0 + k]) + v * (aPos[i2 + k] - aPos[i0 + k]);
    // expanding ring search
    const cx = cl(p[0], 0), cy = cl(p[1], 1), cz = cl(p[2], 2);
    let best = Infinity;
    const seen = new Set<number>();
    for (let ring = 0; ring < Math.max(...dims); ring++) {
      for (let x = cx - ring; x <= cx + ring; x++)
        for (let y = cy - ring; y <= cy + ring; y++)
          for (let z = cz - ring; z <= cz + ring; z++) {
            if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== ring) continue;
            if (x < 0 || y < 0 || z < 0 || x >= dims[0] || y >= dims[1] || z >= dims[2]) continue;
            const l = cells.get(key(x, y, z));
            if (!l) continue;
            for (const t of l) {
              if (seen.has(t)) continue;
              seen.add(t);
              const d = pointTri(p, bPos, bIdx[t * 3] * 3, bIdx[t * 3 + 1] * 3, bIdx[t * 3 + 2] * 3);
              if (d < best) best = d;
            }
          }
      if (best <= ring * cell) break; // nothing in a farther ring can be nearer
    }
    if (best > max) {
      max = best;
      at = p.slice();
    }
    if (best > (outlier ?? Infinity)) over++;
    sum += best;
  }
  /** at: where the max is; over: fraction of samples farther than `outlier` */
  return { max, mean: sum / samples, at, over: over / samples };
}

/**
 * What a viewer sees, compared: both meshes are z-buffered (software, orthographic) from 14 directions
 * (6 axes + 8 diagonals) at `res` px across the shared bounding box. Hidden inner surfaces (trunk
 * floors, double shells, interiors) cannot count, unlike surfaceDistance. Returns
 *   silhouette: pixels covered by exactly one mesh / pixels covered by either (0 = identical outline)
 *   depthMean / depthP95 / depthMax: |depth difference| over pixels both cover (mesh units)
 *   pixel: one pixel's size (mesh units), the resolution of the test
 */
export function viewError(aPos: Float32Array, aIdx: Uint32Array, bPos: Float32Array, bIdx: Uint32Array, res = 160) {
  const ba = usedBox(aPos, aIdx), bb = usedBox(bPos, bIdx);
  const lo = [0, 1, 2].map((k) => Math.min(ba[k], bb[k])), hi = [0, 1, 2].map((k) => Math.max(ba[k + 3], bb[k + 3]));
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  const r = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 1;
  const dirs: number[][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) dirs.push([x, y, z].map((v) => v / Math.sqrt(3)));
  let either = 0, xor = 0;
  const diffs: number[] = [];
  for (const d of dirs) {
    // orthonormal basis (u, v) perpendicular to d
    const up = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(up, d)), v = cross(d, u);
    const za = raster(aPos, aIdx, c, r, u, v, d, res), zb = raster(bPos, bIdx, c, r, u, v, d, res);
    for (let i = 0; i < za.length; i++) {
      const ia = za[i] < Infinity, ib = zb[i] < Infinity;
      if (ia || ib) either++;
      if (ia !== ib) xor++;
      else if (ia) diffs.push(Math.abs(za[i] - zb[i]));
    }
  }
  diffs.sort((x, y) => x - y);
  const mean = diffs.reduce((s, x) => s + x, 0) / Math.max(1, diffs.length);
  return { silhouette: xor / Math.max(1, either), depthMean: mean, depthP95: diffs[Math.floor(diffs.length * 0.95)] ?? 0, depthMax: diffs[diffs.length - 1] ?? 0, pixel: (2 * r) / res };
}
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: number[]) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** orthographic z-buffer (depth along d, nearest = smallest) of a triangle soup, both faces */
function raster(pos: Float32Array, idx: Uint32Array, c: number[], r: number, u: number[], v: number[], d: number[], res: number) {
  const z = new Float32Array(res * res).fill(Infinity);
  const n = pos.length / 3;
  const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n);
  const s = res / (2 * r);
  for (let i = 0; i < n; i++) {
    const px = pos[i * 3] - c[0], py = pos[i * 3 + 1] - c[1], pz = pos[i * 3 + 2] - c[2];
    X[i] = (px * u[0] + py * u[1] + pz * u[2]) * s + res / 2;
    Y[i] = (px * v[0] + py * v[1] + pz * v[2]) * s + res / 2;
    Z[i] = px * d[0] + py * d[1] + pz * d[2];
  }
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], e = idx[t + 2];
    const x0 = Math.max(0, Math.floor(Math.min(X[a], X[b], X[e]))), x1 = Math.min(res - 1, Math.ceil(Math.max(X[a], X[b], X[e])));
    const y0 = Math.max(0, Math.floor(Math.min(Y[a], Y[b], Y[e]))), y1 = Math.min(res - 1, Math.ceil(Math.max(Y[a], Y[b], Y[e])));
    const area = (X[b] - X[a]) * (Y[e] - Y[a]) - (X[e] - X[a]) * (Y[b] - Y[a]);
    if (Math.abs(area) < 1e-12) continue;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((X[b] - px) * (Y[e] - py) - (X[e] - px) * (Y[b] - py)) / area;
        const w1 = ((X[e] - px) * (Y[a] - py) - (X[a] - px) * (Y[e] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const zz = w0 * Z[a] + w1 * Z[b] + w2 * Z[e];
        const k = y * res + x;
        if (zz < z[k]) z[k] = zz;
      }
  }
  return z;
}

/** squared-free distance from point p to triangle (a,b,c) given as offsets into pos */
function pointTri(p: number[], pos: Float32Array, a: number, b: number, c: number) {
  const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
  const abx = pos[b] - ax, aby = pos[b + 1] - ay, abz = pos[b + 2] - az;
  const acx = pos[c] - ax, acy = pos[c + 1] - ay, acz = pos[c + 2] - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const q = (x: number, y: number, z: number) => Math.sqrt((p[0] - x) ** 2 + (p[1] - y) ** 2 + (p[2] - z) ** 2);
  if (d1 <= 0 && d2 <= 0) return q(ax, ay, az);
  const bpx = p[0] - pos[b], bpy = p[1] - pos[b + 1], bpz = p[2] - pos[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return q(pos[b], pos[b + 1], pos[b + 2]);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return q(ax + v * abx, ay + v * aby, az + v * abz); }
  const cpx = p[0] - pos[c], cpy = p[1] - pos[c + 1], cpz = p[2] - pos[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return q(pos[c], pos[c + 1], pos[c + 2]);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return q(ax + w * acx, ay + w * acy, az + w * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return q(pos[b] + w * (pos[c] - pos[b]), pos[b + 1] + w * (pos[c + 1] - pos[b + 1]), pos[b + 2] + w * (pos[c + 2] - pos[b + 2]));
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  return q(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}
