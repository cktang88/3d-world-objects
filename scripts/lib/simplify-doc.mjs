/**
 * Detail-preserving simplification of a whole glTF-Transform document to a triangle budget.
 *
 *   import { simplifyDocument } from './lib/simplify-doc.mjs';
 *   const r = await simplifyDocument(doc, { targetTris: 12000, normalWeight: 0.5, permissive: true });
 *
 * Unlike gltf-transform's simplify() (one ratio per primitive, position-only), this bisects ONE absolute
 * error (metres, in each primitive's world space) for every primitive, so triangles stay where the
 * detail is (wheels, grilles, mirrors) and flat panels lose the most: a uniform screen-space error.
 * Attribute-aware (normals, UVs weighted by texel density, vertex colours), UV seams protected in
 * permissive mode, tiny parts pruned when below the error. Uses src/meshlod-core.ts (meshoptimizer 1.3).
 * Run node scripts with plain `node` (>=22.18 strips the TypeScript types).
 */
import { weld } from '@gltf-transform/functions';
import { simplifierReady, simplifyMesh, compact, remapAttribute } from '../../src/meshlod-core.ts';

function worldScale(node) {
  const m = node.getWorldMatrix();
  return Math.cbrt(Math.abs(m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]))) || 1;
}

function floats(acc) {
  if (!acc) return null;
  const a = acc.getArray();
  if (a instanceof Float32Array && !acc.getNormalized()) return a;
  const n = acc.getCount(), s = acc.getElementSize();
  const out = new Float32Array(n * s);
  const el = [];
  for (let i = 0; i < n; i++) {
    acc.getElement(i, el);
    for (let k = 0; k < s; k++) out[i * s + k] = el[k];
  }
  return out;
}

/** every (primitive, world scale) of indexed triangle meshes in the document */
function prims(doc, opts) {
  const out = [];
  const seen = new Set();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const s = worldScale(node);
    for (const p of mesh.listPrimitives()) {
      if (p.getMode() !== 4 || seen.has(p)) continue;
      seen.add(p);
      if (!p.getIndices()) {
        const n = p.getAttribute('POSITION').getCount();
        p.setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from({ length: n }, (_, i) => i)));
      }
      const mat = p.getMaterial();
      const textured = !!(mat && (mat.getBaseColorTexture() || mat.getNormalTexture()));
      const color = p.getAttribute('COLOR_0');
      const k = opts.errorScale ? opts.errorScale(mat?.getName() ?? '', p) : 1;
      out.push({
        p,
        scale: s / k,
        arrays: {
          index: new Uint32Array(p.getIndices().getArray()),
          position: floats(p.getAttribute('POSITION')),
          normal: floats(p.getAttribute('NORMAL')),
          // untextured parts: uvs carry nothing visible, let them collapse freely
          uv: textured ? floats(p.getAttribute('TEXCOORD_0')) : null,
          color: floats(color),
          colorSize: color?.getElementSize() ?? 3,
        },
      });
    }
  }
  return out;
}

const count = (list, idx) => list.reduce((n, _, i) => n + idx[i].length / 3, 0);

/**
 * Simplify every primitive at one shared world-space error, bisected to land near `targetTris`.
 * opts: targetTris, normalWeight (0.5), errorScale(materialName, prim) -> factor on the shared error
 *       (e.g. 0.3 for wheels/rims/grilles: thin relief whose loss shows far more than its metric error), uvWeight (auto), colorWeight (1), permissive (false),
 *       normals: 'keep' (default) | 'rebuild' (drop normals+untextured uvs, weld, drop twin triangles,
 *       simplify, crease normals at creaseDeg=35 — the right mode for hard-edged exports), dropUv (rebuild:
 *       drop every uv, e.g. a vertex-coloured far LOD), prune (true), minError/maxError (metres, 1e-5 / 0.2), iterations (16), compact (true)
 * Returns { tris, before, error } (error in metres).
 */
export async function simplifyDocument(doc, opts) {
  await simplifierReady;
  const rebuild = opts.normals === 'rebuild';
  if (rebuild) {
    // hard-edged (faceted) exports split every vertex by normal: the simplifier then cannot move along any
    // edge. Drop normals (and uvs of untextured parts), weld by what is left, simplify the connected
    // surface, and rebuild crease-angle normals afterwards (detail comes back from the baked normal map).
    for (const mesh of doc.getRoot().listMeshes())
      for (const p of mesh.listPrimitives()) {
        p.setAttribute('NORMAL', null).setAttribute('TANGENT', null);
        const mat = p.getMaterial();
        if (opts.dropUv || !(mat && (mat.getBaseColorTexture() || mat.getNormalTexture()))) for (const sem of p.listSemantics()) if (sem.startsWith('TEXCOORD')) p.setAttribute(sem, null);
      }
    await doc.transform(weld());
    const twin = dropTwinTriangles(doc);
    if (twin) console.log('simplifyDocument: dropped', twin, 'back-to-back twin triangles (materials made double-sided)');
  }
  const list = prims(doc, opts);
  const before = list.reduce((n, x) => n + x.arrays.index.length / 3, 0);
  const run = (e) =>
    list.map((x) =>
      simplifyMesh(x.arrays, {
        error: e / x.scale,
        absolute: true,
        normalWeight: opts.normalWeight ?? 0.5,
        uvWeight: opts.uvWeight,
        colorWeight: opts.colorWeight ?? 1,
        permissive: opts.permissive ?? false,
        prune: opts.prune ?? true,
      }).index,
    );
  let lo = opts.minError ?? 1e-5, hi = opts.maxError ?? 0.2;
  let best = null, bestE = 0;
  for (let it = 0; it < (opts.iterations ?? 16); it++) {
    const e = Math.sqrt(lo * hi);
    const idx = run(e);
    const n = count(list, idx);
    if (n > opts.targetTris) lo = e;
    else {
      hi = e;
      best = idx;
      bestE = e;
    }
    if (Math.abs(n - opts.targetTris) < opts.targetTris * 0.03) break;
  }
  if (!best) {
    best = run(hi);
    bestE = hi;
  }
  list.forEach((x, i) => apply(doc, x.p, best[i], opts.compact !== false));
  for (const m of doc.getRoot().listMeshes()) if (!m.listPrimitives().length) m.dispose();
  if (rebuild) for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) creaseNormals(doc, p, opts.creaseDeg ?? 35);
  return { before, tris: count(list, best), error: bestE };
}

/** write a new index (and compacted vertex attributes) into a primitive */
export function apply(doc, p, index, doCompact = true) {
  if (!index.length) {
    p.dispose(); // pruned away entirely
    return;
  }
  if (!doCompact) {
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(index));
    return;
  }
  const c = compact(index);
  for (const sem of p.listSemantics()) {
    const a = p.getAttribute(sem);
    const out = remapAttribute(a.getArray(), a.getElementSize(), c.remap, c.count);
    p.setAttribute(sem, doc.createAccessor().setType(a.getType()).setArray(out).setNormalized(a.getNormalized()));
  }
  p.setIndices(doc.createAccessor().setType('SCALAR').setArray(c.index));
}

/**
 * Flip vertex normals that disagree with their triangles' area-weighted face normals (inside-out
 * exports). Do this BEFORE baking a tangent-space normal map: the bake's cage extrudes along the
 * normals, and a runtime flip afterwards would invert the baked map. Returns the count flipped.
 */
export function fixInvertedNormals(doc) {
  let flipped = 0;
  for (const mesh of doc.getRoot().listMeshes())
    for (const p of mesh.listPrimitives()) {
      const nor = p.getAttribute('NORMAL'), pos = p.getAttribute('POSITION'), ix = p.getIndices();
      if (!nor || !ix || p.getMode() !== 4) continue;
      const P = floats(pos), N = floats(nor).slice(), I = ix.getArray();
      const acc = new Float32Array(P.length);
      for (let i = 0; i < I.length; i += 3) {
        const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const v of [a, b, c]) {
          acc[v] += nx;
          acc[v + 1] += ny;
          acc[v + 2] += nz;
        }
      }
      let n = 0;
      for (let v = 0; v < N.length; v += 3)
        if (N[v] * acc[v] + N[v + 1] * acc[v + 1] + N[v + 2] * acc[v + 2] < 0) {
          N[v] = -N[v];
          N[v + 1] = -N[v + 1];
          N[v + 2] = -N[v + 2];
          n++;
        }
      if (n) {
        p.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(N));
        flipped += n;
      }
    }
  return flipped;
}

/**
 * Crease-angle vertex normals for an indexed primitive (in place): each corner averages the
 * area-weighted normals of the faces around its position whose direction is within `deg` of its own
 * face (smooth across UV seams, hard across creases); vertices are split where normals differ.
 */
export function creaseNormals(doc, p, deg = 35) {
  const P = floats(p.getAttribute('POSITION'));
  const I = p.getIndices().getArray();
  const nf = I.length / 3;
  const fn = new Float32Array(nf * 3), fu = new Float32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z) || 1;
    fn.set([x, y, z], f * 3);
    fu.set([x / l, y / l, z / l], f * 3);
  }
  // faces around each position
  const key = (v) => `${P[v * 3]},${P[v * 3 + 1]},${P[v * 3 + 2]}`;
  const around = new Map();
  for (let i = 0; i < I.length; i++) {
    const k = key(I[i]);
    let l = around.get(k);
    if (!l) around.set(k, (l = []));
    l.push((i / 3) | 0);
  }
  const cos = Math.cos((deg * Math.PI) / 180);
  const sems = p.listSemantics().filter((s) => s !== 'NORMAL');
  const src = sems.map((s) => ({ s, a: p.getAttribute(s), arr: p.getAttribute(s).getArray(), k: p.getAttribute(s).getElementSize() }));
  const out = sems.map(() => []);
  const N = [];
  const seen = new Map();
  const idx = new Uint32Array(I.length);
  for (let i = 0; i < I.length; i++) {
    const f = (i / 3) | 0, v = I[i];
    let x = 0, y = 0, z = 0;
    for (const g of around.get(key(v))) {
      if (fu[f * 3] * fu[g * 3] + fu[f * 3 + 1] * fu[g * 3 + 1] + fu[f * 3 + 2] * fu[g * 3 + 2] < cos) continue;
      x += fn[g * 3];
      y += fn[g * 3 + 1];
      z += fn[g * 3 + 2];
    }
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    const k = `${v}|${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
    let j = seen.get(k);
    if (j === undefined) {
      j = N.length / 3;
      seen.set(k, j);
      N.push(x, y, z);
      src.forEach((t, si) => {
        for (let c = 0; c < t.k; c++) out[si].push(t.arr[v * t.k + c]);
      });
    }
    idx[i] = j;
  }
  src.forEach((t, si) => p.setAttribute(t.s, doc.createAccessor().setType(t.a.getType()).setArray(new t.arr.constructor(out[si])).setNormalized(t.a.getNormalized())));
  p.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(N)));
  p.setIndices(doc.createAccessor().setType('SCALAR').setArray(idx));
}

/**
 * "Double-sided by duplication": exporters often emit every glass/thin-panel triangle twice with opposite
 * winding. Once welded by position the pair shares vertices, every edge gets 4 faces and the simplifier
 * tears the panel apart (windscreens vanish). Keep one of each pair and make the material double-sided.
 */
export function dropTwinTriangles(doc, byPosition = false) {
  let dropped = 0;
  for (const mesh of doc.getRoot().listMeshes())
    for (const p of mesh.listPrimitives()) {
      const ix = p.getIndices();
      if (!ix || p.getMode() !== 4) continue;
      const I = ix.getArray();
      const P = floats(p.getAttribute('POSITION'));
      // byPosition: unwelded twins (opposite normals keep their vertices apart), e.g. a bake's high mesh
      const vk = (v) => (byPosition ? `${P[v * 3].toFixed(5)},${P[v * 3 + 1].toFixed(5)},${P[v * 3 + 2].toFixed(5)}` : String(v));
      // of each pair keep the one facing away from the part's centre, so a bake's high and low agree on
      // which side is out (an arbitrary pick leaves half the panels inside-out: inverted, "olive" texels)
      const c = [0, 1, 2].map((k) => {
        let lo = Infinity, hi = -Infinity;
        for (let v = k; v < P.length; v += 3) {
          lo = Math.min(lo, P[v]);
          hi = Math.max(hi, P[v]);
        }
        return (lo + hi) / 2;
      });
      const out = (i) => {
        const a = I[i] * 3, b = I[i + 1] * 3, d = I[i + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        return nx * ((P[a] + P[b] + P[d]) / 3 - c[0]) + ny * ((P[a + 1] + P[b + 1] + P[d + 1]) / 3 - c[1]) + nz * ((P[a + 2] + P[b + 2] + P[d + 2]) / 3 - c[2]);
      };
      const first = new Map();
      const keepTri = [];
      for (let i = 0; i < I.length; i += 3) {
        const k = [vk(I[i]), vk(I[i + 1]), vk(I[i + 2])].sort().join('|');
        const j = first.get(k);
        if (j === undefined) {
          first.set(k, keepTri.length);
          keepTri.push(i);
        } else if (keepTri[j] >= 0 && out(i) > out(keepTri[j])) keepTri[j] = i;
      }
      const keep = [];
      for (const i of keepTri) keep.push(I[i], I[i + 1], I[i + 2]);
      if (keep.length === I.length) continue;
      dropped += (I.length - keep.length) / 3;
      p.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(keep)));
      p.getMaterial()?.setDoubleSided(true);
    }
  return dropped;
}
