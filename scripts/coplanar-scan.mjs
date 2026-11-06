#!/usr/bin/env node
/**
 * Coplanar-overlap scan of GLB files (z-fighting: "two textures overlapping"): pairs of triangles that
 * lie in the same plane (normals within 2°, planes within 0.5 mm) and overlap by more than a sliver.
 * Twin triangles (same three corners) count too, unless they face opposite ways (a back face).
 *
 *   node scripts/coplanar-scan.mjs public/assets/vehicles/*.glb            report
 *   node scripts/coplanar-scan.mjs --fix public/assets/vehicles/*.glb      fix in place
 *
 * The fix: of twin triangles with the same material one is dropped; of every other overlapping pair the
 * smaller triangle (or, for twins in different materials, the later one: decals and trim come after the
 * body) is lifted 0.8 mm off the surface on its own vertex copies, so it is drawn in front consistently.
 *
 * Exports scanGlb(path) -> { file, tris, pairs, twins, examples } for tests/vehicles-zfight.test.ts.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';

let io = null;
async function getIO() {
  if (io) return io;
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder, 'draco3d.decoder': await draco3d.createDecoderModule() });
  return io;
}

/** world-space triangles of every mesh primitive: [ax, ay, az, bx, ...] with the material name */
function triangles(doc) {
  const out = [];
  const mul = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const idx = prim.getIndices();
      const n = idx ? idx.getCount() : pos.getCount();
      const mat = prim.getMaterial()?.getName() ?? '';
      const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
      for (let t = 0; t + 2 < n; t += 3) {
        const i0 = idx ? idx.getScalar(t) : t, i1 = idx ? idx.getScalar(t + 1) : t + 1, i2 = idx ? idx.getScalar(t + 2) : t + 2;
        out.push({ p: [mul(m, pos.getElement(i0, a)), mul(m, pos.getElement(i1, b)), mul(m, pos.getElement(i2, c))], mat, mesh: mesh.getName(), prim, t: t / 3, order: out.length });
      }
    }
  }
  return out;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** area of the overlap of two coplanar triangles (2D, in the plane), by clipping one against the other */
function overlapArea(t1, t2, n) {
  // project to the plane's dominant axes
  const ax = Math.abs(n[0]) > Math.abs(n[1]) ? (Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2) : Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2;
  const u = (ax + 1) % 3, v = (ax + 2) % 3;
  const P = (t) => t.map((p) => [p[u], p[v]]);
  let poly = P(t1);
  const clipTri = P(t2);
  // make clipTri counter-clockwise
  const area2 = (q) => q.reduce((s, p, i) => { const r = q[(i + 1) % q.length]; return s + p[0] * r[1] - r[0] * p[1]; }, 0);
  if (area2(clipTri) < 0) clipTri.reverse();
  for (let i = 0; i < 3 && poly.length; i++) {
    const A = clipTri[i], B = clipTri[(i + 1) % 3];
    const side = (p) => (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]);
    const next = [];
    for (let k = 0; k < poly.length; k++) {
      const P1 = poly[k], P2 = poly[(k + 1) % poly.length], s1 = side(P1), s2 = side(P2);
      if (s1 >= 0) next.push(P1);
      if ((s1 >= 0) !== (s2 >= 0)) {
        const t = s1 / (s1 - s2);
        next.push([P1[0] + (P2[0] - P1[0]) * t, P1[1] + (P2[1] - P1[1]) * t]);
      }
    }
    poly = next;
  }
  if (poly.length < 3) return 0;
  // the projected area, back to the plane: divide by |n[ax]|
  return Math.abs(area2(poly)) / 2 / Math.abs(n[ax]);
}

export async function scanGlb(file, { minArea = 1e-5, maxExamples = 5, fix = false, lift: liftBy = 0.0008, dropAll = false } = {}) {
  const doc = await (await getIO()).read(file);
  const drop = new Set(), lift = new Set();
  const tris = triangles(doc);
  // plane of each triangle; bucket by quantised plane so only near-coplanar candidates are compared
  const items = [];
  for (const t of tris) {
    const nn = cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0]));
    const len = Math.hypot(...nn);
    if (len < 1e-10) continue;
    const n = nn.map((x) => x / len);
    const d = dot(n, t.p[0]);
    items.push({ t, n, d, area: len / 2 });
  }
  const key = (n, d) => `${Math.round(n[0] * 30)},${Math.round(n[1] * 30)},${Math.round(n[2] * 30)},${Math.round(d / 0.002)}`;
  const buckets = new Map();
  for (const it of items) {
    // canonical orientation: a triangle and its back face share a bucket (and are told apart below)
    const s = it.n[0] > 1e-9 || (Math.abs(it.n[0]) <= 1e-9 && (it.n[1] > 1e-9 || (Math.abs(it.n[1]) <= 1e-9 && it.n[2] > 0))) ? 1 : -1;
    const k = key(it.n.map((x) => x * s), it.d * s);
    (buckets.get(k) ?? buckets.set(k, []).get(k)).push(it);
  }
  let pairs = 0, twins = 0;
  const examples = [];
  const cos2 = Math.cos((2 * Math.PI) / 180);
  for (const list of buckets.values()) {
    if (list.length < 2 || list.length > 4000) continue;
    for (let i = 0; i < list.length; i++) {
      const A = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const B = list[j];
        const c = dot(A.n, B.n);
        if (Math.abs(c) < cos2) continue;
        // opposite faces of a thin shell (a back face): not z-fighting with single-sided materials
        if (c < 0) continue;
        if (Math.abs(A.d - B.d) > 0.0005) continue;
        const ov = overlapArea(A.t.p, B.t.p, A.n);
        if (ov < minArea || ov < 0.02 * Math.min(A.area, B.area)) continue;
        pairs++;
        const same = ov > 0.98 * Math.max(A.area, B.area);
        if (same) twins++;
        const upper = same ? (B.t.order > A.t.order ? B.t : A.t) : A.area < B.area ? A.t : B.t;
        const lower = upper === A.t ? B.t : A.t;
        // one move per pair per pass: if either is already moving, the next pass sees them apart
        if (drop.has(A.t) || drop.has(B.t) || lift.has(A.t) || lift.has(B.t) || lift.has(lower)) continue;
        // twins in one material, or the smaller one mostly under the other in the same material: drop it
        const covered = ov > 0.5 * Math.min(A.area, B.area);
        if (dropAll || (A.t.mat === B.t.mat && (same || covered))) drop.add(upper);
        else lift.add(upper);
        if (examples.length < maxExamples) examples.push(`${A.t.mesh}/${A.t.mat} x ${B.t.mesh}/${B.t.mat}: ${(ov * 1e4).toFixed(1)} cm² overlap${same ? ' (twins)' : ''} at ${A.t.p[0].map((x) => x.toFixed(3)).join(',')}`);
      }
    }
  }
  if (fix && (drop.size || lift.size)) {
    applyFix(drop, lift, liftBy);
    await (await getIO()).write(file, doc);
  }
  return { file, tris: tris.length, pairs, twins, examples, dropped: drop.size, lifted: lift.size };
}

/** drop the twin triangles; lift the others 0.8 mm along their own normal, on copies of their vertices */
function applyFix(drop, lift, by) {
  const byPrim = new Map();
  for (const t of [...drop, ...lift]) (byPrim.get(t.prim) ?? byPrim.set(t.prim, []).get(t.prim)).push(t);
  for (const [prim, list] of byPrim) {
    const idx = prim.getIndices();
    const sem = prim.listSemantics();
    const attrs = sem.map((s) => prim.getAttribute(s));
    const count = attrs[0].getCount();
    const tri = (t, k) => (idx ? idx.getScalar(t * 3 + k) : t * 3 + k);
    const n = idx ? idx.getCount() / 3 : count / 3;
    const dropT = new Set(list.filter((t) => drop.has(t)).map((t) => t.t));
    const liftT = new Set(list.filter((t) => lift.has(t) && !drop.has(t)).map((t) => t.t));
    // new vertex arrays: the old ones, then copies for every lifted corner
    const extra = liftT.size * 3;
    const arrays = attrs.map((a) => {
      const k = a.getElementSize(), src = a.getArray();
      const out = new Float32Array((count + extra) * k);
      const el = [];
      for (let i = 0; i < count; i++) out.set(a.getElement(i, el), i * k);
      void src;
      return out;
    });
    const posI = sem.indexOf('POSITION');
    const index = [];
    let next = count;
    for (let t = 0; t < n; t++) {
      if (dropT.has(t)) continue;
      const v = [tri(t, 0), tri(t, 1), tri(t, 2)];
      if (!liftT.has(t)) {
        index.push(...v);
        continue;
      }
      const P = arrays[posI];
      const p = v.map((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
      const nn = cross(sub(p[1], p[0]), sub(p[2], p[0]));
      const len = Math.hypot(...nn) || 1;
      for (let c = 0; c < 3; c++) {
        arrays.forEach((arr, ai) => {
          const k = attrs[ai].getElementSize();
          for (let e = 0; e < k; e++) arr[next * k + e] = arr[v[c] * k + e];
        });
        for (let e = 0; e < 3; e++) P[next * 3 + e] += (nn[e] / len) * by;
        index.push(next++);
      }
    }
    attrs.forEach((a, ai) => {
      a.setArray(arrays[ai].slice(0, next * a.getElementSize()));
      a.setNormalized(false);
    });
    const I = next > 65535 ? new Uint32Array(index) : new Uint16Array(index);
    if (idx) idx.setArray(I);
    else {
      // an unindexed primitive: give it an index now
      const doc = prim.getAttribute('POSITION');
      void doc;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const fix = process.argv.includes('--fix');
  for (const f of files) {
    // depth precision falls with distance (near 0.05 m, 24-bit): the near LOD (< 12 m) is lifted 0.8 mm,
    // the mid LOD (12-40 m) 4 mm; at far LOD distances the upper layer (decal, trim) is simply dropped
    const opts = /_lod2\.glb$/.test(f) ? { dropAll: true } : /_lod1\.glb$/.test(f) ? { lift: 0.004 } : { lift: 0.0008 };
    let r = await scanGlb(f, { fix, ...opts });
    const first = r;
    // stacks of three or more layers: repeat until clean
    // (a stack lifting cannot separate: drop its upper layers)
    for (let pass = 0, prev = -1; fix && pass < 12 && r.pairs; pass++) {
      const stuck = r.pairs === prev;
      prev = r.pairs;
      r = await scanGlb(f, { fix, ...opts, ...(stuck ? { dropAll: true } : {}) });
    }
    if (fix) r = await scanGlb(f);
    console.log(`${f}: ${first.tris} triangles, ${first.pairs} coplanar overlapping pairs (${first.twins} twins)${fix ? ` -> ${r.pairs} after the fix (${r.tris} triangles)` : ''}`);
    for (const e of r.examples) console.log('   ', e);
  }
}
