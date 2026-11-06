import * as THREE from 'three';

/**
 * Z-fighting ("flickering textures"): faces of two different parts lying in the same plane, facing the same way
 * and overlapping (paint on a road, a sign flush on a facade, a sill flush with a wall, two boxes sharing a face).
 * The depth test can't pick one and the pixels flicker as the camera moves. Depth precision falls with the square
 * of distance (24-bit, near 0.1 m: ~0.6 mm at 25 m, ~6 mm at 100 m), so faces a millimetre apart also fight at range.
 *
 *   scanZFight(root)  find overlapping coplanar same-facing triangle pairs across meshes and instances (and
 *                     duplicated triangles inside one mesh). Fast: plane-bucketed (normal + offset hashed to a
 *                     number), sweep-and-prune per plane, exact 2D triangle overlap (separating axes).
 *   fixZFight(root)   lift the smaller face of every pair along its normal (step, default 4 mm), largest face
 *                     at the bottom and each overlapping face one step above the highest it covers, so stacks of
 *                     three or more parts all get distinct heights; repeats until nothing moves (max 4 passes).
 *                     Mesh: moves that triangle's vertices (geometry cloned if other meshes share it).
 *                     InstancedMesh: moves the instance (matrix) along the normal. BatchedMesh: scanned per
 *                     instance, fixed by moving the instance.
 * Materials with polygonOffset are treated as already resolved; colorWrite=false / invisible objects are skipped.
 * After the approach in cktang88/autobattler-2 (proto3d/zfix.ts), extended to merged, instanced and batched city meshes.
 */

export interface ZOptions {
  /** plane bucket size along the normal (m); faces within about 2 buckets count as coplanar. Default 0.0015 */
  res?: number;
  /** ignore triangles smaller than this (m^2). Default 1e-5 (3 mm square) */
  minArea?: number;
  /** overlap must exceed this in every separating direction (m), so shared edges don't count. Default 0.004 */
  minOverlap?: number;
  /** include pairs inside one mesh (duplicated triangles). Default true */
  sameMesh?: boolean;
  /** skip objects for which this returns true */
  skip?: (o: THREE.Object3D) => boolean;
  /** only meshes for which this returns true */
  filter?: (m: THREE.Mesh) => boolean;
  /** faces lying on the ground (y < 0.02) facing down are never seen: ignore them. Default true */
  ignoreFloorDown?: boolean;
  /** fixZFight: only these meshes may be moved (pairs with one of them lift it, whichever is smaller) */
  movable?: (m: THREE.Object3D) => boolean;
  /** skip pairs whose smaller face lies flush against the back of an opposite-facing surface (never seen). Default true */
  hiddenBacks?: boolean;
  /** scanZFight: also return every pair in `list` */
  keepPairs?: boolean;
  /** fixZFight: at most this many scan+lift passes. Default 4 */
  passes?: number;
  /** lift step for fixZFight (m). Default 0.004 */
  step?: number;
}

export interface ZPairInfo {
  a: string;
  b: string;
  objA: THREE.Object3D;
  objB: THREE.Object3D;
  /** normal of the shared plane */
  n: [number, number, number];
  at: [number, number, number];
  area: number;
}
export interface ZScan {
  /** overlapping coplanar same-facing pairs (counted per triangle pair) */
  pairs: number;
  /** summed overlap of each pair (projected bounding-box intersection capped by the smaller triangle, m^2):
   *  roughly how much surface flickers */
  area: number;
  tris: number;
  ms: number;
  /** pairs per "nameA | nameB" (object names, or material names when unnamed) */
  byName: Map<string, { pairs: number; area: number }>;
  samples: ZPairInfo[];
  /** every pair (only with keepPairs) */
  list: ZPairInfo[];
}

// ------------------------------------------------------------------ triangle soup

interface Owner {
  obj: THREE.Mesh;
  /** instance id for Instanced/BatchedMesh, -1 for a plain mesh */
  inst: number;
  name: string;
  world: THREE.Matrix4;
}

class Soup {
  owners: Owner[] = [];
  /** per triangle: a b c (9), n (3), d, area -> 14 floats */
  f: number[] = [];
  owner: number[] = [];
  face: number[] = [];
  floorDown = true;
  push(o: number, fi: number, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, minArea: number) {
    _u.subVectors(b, a);
    _v.subVectors(c, a);
    _n.crossVectors(_u, _v);
    const l = _n.length();
    if (l / 2 < minArea) return;
    _n.divideScalar(l);
    if (this.floorDown && _n.y < -0.99 && Math.max(a.y, b.y, c.y) < 0.02) return;
    this.f.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, _n.x, _n.y, _n.z, _n.dot(a), l / 2);
    this.owner.push(o);
    this.face.push(fi);
  }
  get count() {
    return this.owner.length;
  }
}
const _u = new THREE.Vector3(), _v = new THREE.Vector3(), _n = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _m = new THREE.Matrix4();

function nameOf(o: THREE.Object3D) {
  const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  const mt = (Array.isArray(m) ? m[0] : m) as THREE.MeshStandardMaterial | undefined;
  const mn = mt ? mt.name || `${mt.type.replace('Material', '')}#${mt.color?.getHexString() ?? ''}${mt.map ? '+map' : ''}` : '';
  const on = o.name || (o.parent?.name ? o.parent.name + '/' : '') + o.type;
  return `${on}:${mn}`;
}

function drawable(o: THREE.Object3D, opts: ZOptions) {
  const m = o as THREE.Mesh;
  if (!m.isMesh || !m.geometry?.getAttribute('position')) return false;
  if (opts.skip?.(o) || (opts.filter && !opts.filter(m))) return false;
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  if (mats.every((x) => !x || x.colorWrite === false || x.visible === false)) return false;
  return true;
}

function offsetResolved(o: THREE.Object3D) {
  const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[];
  // decals with polygonOffset and additive glows are drawn on top on purpose
  return (Array.isArray(m) ? m : [m]).some((x) => x?.polygonOffset || x?.blending === THREE.AdditiveBlending);
}

function addGeometry(soup: Soup, oi: number, g: THREE.BufferGeometry, W: THREE.Matrix4, minArea: number, start = 0, count = Infinity) {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const ix = g.index;
  const n = Math.min(ix ? ix.count : p.count, start + count);
  for (let f = start; f + 2 < n; f += 3) {
    const i0 = ix ? ix.getX(f) : f, i1 = ix ? ix.getX(f + 1) : f + 1, i2 = ix ? ix.getX(f + 2) : f + 2;
    _a.fromBufferAttribute(p, i0).applyMatrix4(W);
    _b.fromBufferAttribute(p, i1).applyMatrix4(W);
    _c.fromBufferAttribute(p, i2).applyMatrix4(W);
    soup.push(oi, f, _a, _b, _c, minArea);
  }
}

/** BatchedMesh internals (three r170): per instance its geometry id; per geometry its draw range */
interface BatchedInternals {
  _instanceInfo?: { visible: boolean; active: boolean; geometryIndex: number }[];
  _geometryInfo?: { start: number; count: number; active?: boolean }[];
  _drawInfo?: { visible: boolean; active: boolean; geometryIndex: number }[];
  _drawRanges?: { start: number; count: number }[];
}

function collect(roots: THREE.Object3D | THREE.Object3D[], opts: ZOptions): Soup {
  const soup = new Soup();
  soup.floorDown = opts.ignoreFloorDown ?? true;
  const minArea = opts.minArea ?? 1e-5;
  const list = Array.isArray(roots) ? roots : [roots];
  for (const r of list) r.updateMatrixWorld(true);
  for (const root of list) root.traverse((o) => {
    if (!drawable(o, opts) || offsetResolved(o)) return;
    const m = o as THREE.Mesh;
    const im = o as THREE.InstancedMesh, bm = o as unknown as THREE.BatchedMesh & BatchedInternals;
    if ((bm as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) {
      const inst = bm._instanceInfo ?? bm._drawInfo ?? [];
      const ranges = bm._geometryInfo ?? bm._drawRanges ?? [];
      inst.forEach((ii, k) => {
        if (!ii.active || !ii.visible) return;
        const r = ranges[ii.geometryIndex];
        if (!r) return;
        bm.getMatrixAt(k, _m);
        const W = new THREE.Matrix4().multiplyMatrices(m.matrixWorld, _m);
        const oi = soup.owners.push({ obj: m, inst: k, name: nameOf(o), world: W }) - 1;
        addGeometry(soup, oi, m.geometry, W, minArea, r.start, r.count);
      });
    } else if (im.isInstancedMesh) {
      for (let k = 0; k < im.count; k++) {
        im.getMatrixAt(k, _m);
        const W = new THREE.Matrix4().multiplyMatrices(m.matrixWorld, _m);
        const oi = soup.owners.push({ obj: m, inst: k, name: nameOf(o), world: W }) - 1;
        addGeometry(soup, oi, m.geometry, W, minArea);
      }
    } else {
      const oi = soup.owners.push({ obj: m, inst: -1, name: nameOf(o), world: m.matrixWorld.clone() }) - 1;
      addGeometry(soup, oi, m.geometry, m.matrixWorld, minArea);
    }
  });
  return soup;
}

// ------------------------------------------------------------------ pair finding

/** visit every overlapping coplanar same-facing pair (i, j: triangle ids; j's area <= i's when sorted) */
function findPairs(soup: Soup, opts: ZOptions, visit: (i: number, j: number, overlap: number) => void) {
  const res = opts.res ?? 0.0015;
  const minOv = opts.minOverlap ?? 0.004;
  const same = opts.sameMesh ?? true;
  const F = soup.f;
  // bucket key: quantised normal (1/64) and plane offset (res)
  const buckets = new Map<number, number[]>();
  const nq = (x: number) => Math.round(x * 64) + 64;
  for (let t = 0; t < soup.count; t++) {
    const o = t * 14;
    const nk = (nq(F[o + 9]) * 129 + nq(F[o + 10])) * 129 + nq(F[o + 11]);
    const dk = Math.floor(F[o + 12] / res);
    const key = nk * 2 ** 26 + (dk + 2 ** 25);
    let l = buckets.get(key);
    if (!l) buckets.set(key, (l = []));
    l.push(t);
  }
  const proj = (t: number, axis: number, out: Float64Array, off: number) => {
    const o = t * 14;
    const i0 = axis === 0 ? 1 : 0, i1 = axis === 2 ? 1 : 2;
    out[off] = F[o + i0]; out[off + 1] = F[o + i1];
    out[off + 2] = F[o + 3 + i0]; out[off + 3] = F[o + 3 + i1];
    out[off + 4] = F[o + 6 + i0]; out[off + 5] = F[o + 6 + i1];
  };
  const A = new Float64Array(6), B = new Float64Array(6);
  // separating-axis test on two 2D triangles: overlap > minOv along all 6 edge normals
  const sepAxes = (X: Float64Array, Y: Float64Array) => {
    for (const T of [X, Y])
      for (let e = 0; e < 3; e++) {
        const x0 = T[e * 2], y0 = T[e * 2 + 1], x1 = T[((e + 1) % 3) * 2], y1 = T[((e + 1) % 3) * 2 + 1];
        let nx = y0 - y1, ny = x1 - x0;
        const l = Math.hypot(nx, ny);
        if (l < 1e-12) return false;
        nx /= l; ny /= l;
        let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
        for (let k = 0; k < 3; k++) {
          const pa = X[k * 2] * nx + X[k * 2 + 1] * ny, pb = Y[k * 2] * nx + Y[k * 2 + 1] * ny;
          if (pa < amin) amin = pa; if (pa > amax) amax = pa;
          if (pb < bmin) bmin = pb; if (pb > bmax) bmax = pb;
        }
        if (Math.min(amax, bmax) - Math.max(amin, bmin) < minOv) return false;
      }
    return true;
  };
  // a face lying flush against the back of an opposite-facing surface (a band's back on the wall it is fixed
  // to, a sign's back on the facade) is never seen: pairs of such faces don't flicker
  const backed = (t: number) => {
    if (opts.hiddenBacks === false) return false;
    const o = t * 14;
    const nk = (nq(-F[o + 9]) * 129 + nq(-F[o + 10])) * 129 + nq(-F[o + 11]);
    const cx = (F[o] + F[o + 3] + F[o + 6]) / 3, cy = (F[o + 1] + F[o + 4] + F[o + 7]) / 3, cz = (F[o + 2] + F[o + 5] + F[o + 8]) / 3;
    const dk0 = Math.floor(-F[o + 12] / res);
    for (let dk = dk0 - 1; dk <= dk0 + 1; dk++) {
      const l = buckets.get(nk * 2 ** 26 + (dk + 2 ** 25));
      if (!l) continue;
      for (let i = 0; i < l.length && i < 4000; i++) {
        const q = l[i] * 14;
        // centroid inside triangle q (same-side test with q's normal)
        let inside = true;
        for (let e = 0; e < 3 && inside; e++) {
          const a = q + e * 3, b = q + ((e + 1) % 3) * 3;
          const ux = F[b] - F[a], uy = F[b + 1] - F[a + 1], uz = F[b + 2] - F[a + 2];
          const vx = cx - F[a], vy = cy - F[a + 1], vz = cz - F[a + 2];
          const c = (uy * vz - uz * vy) * F[q + 9] + (uz * vx - ux * vz) * F[q + 10] + (ux * vy - uy * vx) * F[q + 11];
          inside = c > -1e-9;
        }
        if (inside) return true;
      }
    }
    return false;
  };
  for (const [key, l0] of buckets) {
    // this bucket plus the next one along the normal (faces straddling a bucket boundary)
    const l1 = buckets.get(key + 1);
    const list = l1 ? l0.concat(l1) : l0;
    if (list.length < 2) continue;
    const o0 = list[0] * 14;
    const ax = Math.abs(F[o0 + 9]) > Math.abs(F[o0 + 10]) ? (Math.abs(F[o0 + 9]) > Math.abs(F[o0 + 11]) ? 0 : 2) : Math.abs(F[o0 + 10]) > Math.abs(F[o0 + 11]) ? 1 : 2;
    // sweep and prune on the first projected axis
    const iu = ax === 0 ? 1 : 0;
    const lo = (t: number) => Math.min(F[t * 14 + iu], F[t * 14 + 3 + iu], F[t * 14 + 6 + iu]);
    const hi = (t: number) => Math.max(F[t * 14 + iu], F[t * 14 + 3 + iu], F[t * 14 + 6 + iu]);
    const order = list.slice().sort((p, q) => lo(p) - lo(q));
    const fromL0 = new Set(l1 ? l0 : []);
    const active: number[] = [];
    for (const t of order) {
      const tl = lo(t);
      for (let k = active.length - 1; k >= 0; k--) if (hi(active[k]) < tl + minOv) active.splice(k, 1);
      for (const s of active) {
        // across the two buckets only pairs with one face in each (same-bucket pairs come from their own bucket)
        if (l1 && fromL0.has(s) === fromL0.has(t)) continue;
        const os = soup.owner[s], ot = soup.owner[t];
        if (os === ot && !same) continue;
        if (os === ot && soup.face[s] === soup.face[t]) continue;
        // really the same plane: near-parallel normals and t's corners within ~2 res of s's plane
        const so = s * 14, to = t * 14;
        if (F[so + 9] * F[to + 9] + F[so + 10] * F[to + 10] + F[so + 11] * F[to + 11] < 0.9995) continue;
        let far = false;
        for (let k = 0; k < 9 && !far; k += 3) far = Math.abs(F[so + 9] * F[to + k] + F[so + 10] * F[to + k + 1] + F[so + 11] * F[to + k + 2] - F[so + 12]) > 2 * res;
        if (far) continue;
        proj(s, ax, A, 0);
        proj(t, ax, B, 0);
        if (!sepAxes(A, B)) continue;
        if (backed(F[s * 14 + 13] >= F[t * 14 + 13] ? t : s)) continue;
        // overlap estimate: the projected bounding boxes' intersection, capped by the smaller triangle
        let ov = 1;
        for (let k = 0; k < 2; k++) {
          const a0 = Math.min(A[k], A[k + 2], A[k + 4]), a1 = Math.max(A[k], A[k + 2], A[k + 4]);
          const b0 = Math.min(B[k], B[k + 2], B[k + 4]), b1 = Math.max(B[k], B[k + 2], B[k + 4]);
          ov *= Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
        }
        const nz = Math.abs([F[so + 9], F[so + 10], F[so + 11]][ax]) || 1; // projection shrinks areas by |n.axis|
        ov = Math.min(ov / nz, F[so + 13], F[to + 13]);
        if (F[so + 13] >= F[to + 13]) visit(s, t, ov);
        else visit(t, s, ov);
      }
      active.push(t);
    }
  }
}

/** Count z-fighting pairs under `root` (world space, after matrices update). */
export function scanZFight(root: THREE.Object3D | THREE.Object3D[], opts: ZOptions = {}): ZScan {
  const t0 = performance.now();
  const soup = collect(root, opts);
  const byName = new Map<string, { pairs: number; area: number }>();
  const samples: ZPairInfo[] = [];
  let pairs = 0, area = 0;
  const F = soup.f;
  findPairs(soup, opts, (i, j, ov) => {
    pairs++;
    const ar = ov;
    area += ar;
    const na = soup.owners[soup.owner[i]].name, nb = soup.owners[soup.owner[j]].name;
    const k = na < nb ? `${na} | ${nb}` : `${nb} | ${na}`;
    const e = byName.get(k) ?? { pairs: 0, area: 0 };
    e.pairs++;
    e.area += ar;
    byName.set(k, e);
    const info: ZPairInfo = { a: na, b: nb, objA: soup.owners[soup.owner[i]].obj, objB: soup.owners[soup.owner[j]].obj, n: [F[j * 14 + 9], F[j * 14 + 10], F[j * 14 + 11]], at: [F[j * 14], F[j * 14 + 1], F[j * 14 + 2]], area: ar };
    samples.push(info);
  });
  const list = opts.keepPairs ? samples.slice() : [];
  samples.sort((a, b) => b.area - a.area);
  samples.length = Math.min(samples.length, 60);
  return { pairs, area, tris: soup.count, ms: performance.now() - t0, byName, samples, list };
}

/** Lift faces apart (see the header). Returns triangles moved, passes and ms. */
export function fixZFight(root: THREE.Object3D | THREE.Object3D[], opts: ZOptions = {}): { moved: number; passes: number; ms: number } {
  const t0 = performance.now();
  let moved = 0, passes = 0;
  for (let n = 1; passes < (opts.passes ?? 4) && n; passes++) moved += n = fixPass(root, opts);
  return { moved, passes, ms: performance.now() - t0 };
}

function fixPass(root: THREE.Object3D | THREE.Object3D[], opts: ZOptions): number {
  const step = opts.step ?? 0.004;
  const soup = collect(root, opts);
  const F = soup.f;
  // per plane chain: lift level of each triangle = 1 + max level of the bigger faces it overlaps
  const level = new Map<number, number>();
  const pairs: [number, number][] = [];
  findPairs(soup, opts, (i, j) => pairs.push([i, j]));
  if (!pairs.length) return 0;
  // bigger first so chains resolve in one pass
  pairs.sort((p, q) => F[q[0] * 14 + 13] - F[p[0] * 14 + 13]);
  // only `movable` meshes may move (the rest are still seen): then the movable one of a pair goes up
  const mov = (t: number) => !opts.movable || opts.movable(soup.owners[soup.owner[t]].obj);
  for (const [i0, j0] of pairs) {
    let i = i0, j = j0;
    if (!mov(j)) {
      if (!mov(i)) continue;
      [i, j] = [j, i];
    }
    level.set(j, Math.max(level.get(j) ?? 0, (level.get(i) ?? 0) + 1));
  }
  if (!level.size) return 0;
  // group lifts per owner: plain meshes move vertices, instances move as a whole
  const users = new Map<THREE.BufferGeometry, number>();
  for (const r of Array.isArray(root) ? root : [root])
    r.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g) users.set(g, (users.get(g) ?? 0) + 1);
    });
  const perOwner = new Map<number, number[]>();
  for (const t of level.keys()) {
    const o = soup.owner[t];
    let l = perOwner.get(o);
    if (!l) perOwner.set(o, (l = []));
    l.push(t);
  }
  const dir = new THREE.Vector3();
  for (const [oi, tris] of perOwner) {
    const ow = soup.owners[oi];
    const obj = ow.obj;
    if (ow.inst >= 0) {
      // instance: move it along the (area-weighted) normal of its lifted faces by its highest level
      let k = 0;
      dir.set(0, 0, 0);
      for (const t of tris) {
        k = Math.max(k, level.get(t)!);
        dir.x += F[t * 14 + 9] * F[t * 14 + 13]; dir.y += F[t * 14 + 10] * F[t * 14 + 13]; dir.z += F[t * 14 + 11] * F[t * 14 + 13];
      }
      dir.normalize().multiplyScalar(step * Math.min(k, 4));
      const holder = obj as unknown as { getMatrixAt(i: number, m: THREE.Matrix4): void; setMatrixAt(i: number, m: THREE.Matrix4): void; instanceMatrix?: THREE.BufferAttribute };
      holder.getMatrixAt(ow.inst, _m);
      // world delta -> the mesh's local frame (instance matrices live there)
      const ld = worldToLocalDelta(obj.matrixWorld, dir);
      _m.elements[12] += ld.x;
      _m.elements[13] += ld.y;
      _m.elements[14] += ld.z;
      holder.setMatrixAt(ow.inst, _m);
      if (holder.instanceMatrix) holder.instanceMatrix.needsUpdate = true;
      continue;
    }
    // plain mesh: own the geometry, then move the lifted triangles' vertices (shared vertices take the larger lift)
    // geometry may be shared beyond this tree (unit boxes, instanced kits): edit a private copy, once
    let g = obj.geometry;
    if (!g.userData.zfixOwned || (users.get(g) ?? 1) > 1) {
      g = obj.geometry = g.clone();
      g.userData.zfixOwned = true;
    }
    const ix = g.index;
    // indexed: lifted triangles get their own copies of their corners (one per vertex and lift level), so
    // neighbouring faces of the same merged mesh keep theirs and are not tilted. Growable live buffers
    // (userData.capV) are only nudged in place.
    const split = !!ix && !obj.userData.capV;
    const want = new Map<number, number>(); // (vertex * 8 + level) -> new vertex
    const lifts: [number, number, number, number, number][] = []; // vertex, nx, ny, nz, level
    const newIdx = split ? new Uint32Array(ix!.array as ArrayLike<number>) : null;
    const base = (g.getAttribute('position') as THREE.BufferAttribute).count;
    const sharedLift = new Map<number, number>();
    for (const t of tris) {
      const k = Math.min(level.get(t)!, 4);
      const f = soup.face[t];
      for (let v = 0; v < 3; v++) {
        const vi = ix ? ix.getX(f + v) : f + v;
        if (split) {
          const key = vi * 8 + k;
          let nv = want.get(key);
          if (nv === undefined) {
            nv = base + want.size;
            want.set(key, nv);
            lifts.push([vi, F[t * 14 + 9], F[t * 14 + 10], F[t * 14 + 11], k]);
          }
          newIdx![f + v] = nv;
        } else {
          const cur = sharedLift.get(vi);
          if (cur === undefined || lifts[cur][4] < k) {
            if (cur === undefined) sharedLift.set(vi, lifts.push([vi, F[t * 14 + 9], F[t * 14 + 10], F[t * 14 + 11], k]) - 1);
            else lifts[cur] = [vi, F[t * 14 + 9], F[t * 14 + 10], F[t * 14 + 11], k];
          }
        }
      }
    }
    if (split) {
      // grow every attribute by the copied corners
      for (const name of Object.keys(g.attributes)) {
        const at = g.getAttribute(name) as THREE.BufferAttribute;
        if ((at as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) continue;
        const sz = at.itemSize;
        const arr = new (at.array.constructor as Float32ArrayConstructor)((base + lifts.length) * sz);
        arr.set(at.array as ArrayLike<number>);
        lifts.forEach(([vi], j) => {
          for (let c = 0; c < sz; c++) arr[(base + j) * sz + c] = (at.array as ArrayLike<number>)[vi * sz + c];
        });
        g.setAttribute(name, new THREE.BufferAttribute(arr, sz, at.normalized));
      }
      g.setIndex(new THREE.BufferAttribute(base + lifts.length > 65535 ? newIdx! : new Uint16Array(newIdx!), 1));
    }
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    lifts.forEach(([vi, nx, ny, nz, k], j) => {
      const at = split ? base + j : vi;
      dir.set(nx, ny, nz).multiplyScalar(step * k);
      const ld = worldToLocalDelta(obj.matrixWorld, dir);
      p.setXYZ(at, p.getX(at) + ld.x, p.getY(at) + ld.y, p.getZ(at) + ld.z);
    });
    p.needsUpdate = true;
    g.computeBoundingSphere();
    g.computeBoundingBox();
  }
  return level.size;
}

const _d = new THREE.Vector3(), _i = new THREE.Matrix4();
/** a world-space displacement expressed in an object's local frame (inverse of the linear part) */
function worldToLocalDelta(world: THREE.Matrix4, d: THREE.Vector3) {
  _i.copy(world).setPosition(0, 0, 0).invert();
  return _d.copy(d).applyMatrix4(_i);
}

/** A table row for logs/tests: the worst name pairs. */
export function topPairs(s: ZScan, n = 8) {
  return [...s.byName.entries()].sort((a, b) => b[1].area - a[1].area).slice(0, n).map(([k, v]) => `${k}: ${v.pairs} (${(v.area * 1e4).toFixed(0)} cm²)`);
}
