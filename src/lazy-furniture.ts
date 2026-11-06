import * as THREE from 'three';

/**
 * Drawers for library (Poly Haven) furniture whose drawer fronts are baked into the model
 * (interior.ts libDrawerSet, lazy.ts containers):
 *
 *  - readFront: the model's front face rasterised into a depth grid in one pass over its triangles
 *  - detectDrawers: the drawer and door layout read off that grid (seams between fronts)
 *  - cutOpenings + compartment: the fronts cut out of (a clone of) the model's geometry and a real
 *    compartment behind each hole, so drawers slide out of an opening and doors open onto a cavity
 *  - frontMaterialAt: the paint of the front there (frontmost triangle's material and texel), so the
 *    drawer fronts and doors that replace the cut-out ones look as before when closed
 *  - slotMesh: before the model has loaded (or with no layout found), the dark slot drawn over the
 *    model's own closed front while an added drawer is out
 */

export interface Band {
  /** centre x, bottom y, width, height of one drawer front (holder-local, front at +d/2) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** a drawer (default) or a cupboard door, hinged on the side away from its knob */
  move?: 'drawer' | 'door';
  hinge?: 'left' | 'right';
  /** the front plane (holder-local z) the opening is cut at */
  z?: number;
}


// ---------------------------------------------------------------- the front depth grid

/**
 * The model's front face as a height field: every front-facing triangle rasterised (holder-local,
 * front towards +z) into a grid of max-z, remembering which triangle is frontmost in each cell
 * (for its material and texture colour). One pass over the triangles: a few ms on a library model.
 */
export interface Front {
  /** cell size (m) and grid origin/extent (holder-local x, y) */
  cell: number;
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  /** max z per cell (-Infinity: nothing in front there) */
  z: Float32Array;
  /** frontmost triangle per cell: mesh index << 21 | triangle (or -1) */
  tri: Int32Array;
  meshes: THREE.Mesh[];
  /** each mesh's holder-local vertex positions */
  local: Float32Array[];
  /** the front plane: where most of the front face is */
  zf: number;
  ms: number;
}

export function readFront(model: THREE.Object3D, holder: THREE.Object3D, size: readonly number[], cell = 0.008): Front {
  const t0 = performance.now();
  const [w, h] = size;
  const x0 = -w / 2 - 0.02, y0 = 0, nx = Math.ceil((w + 0.04) / cell), ny = Math.ceil((h + 0.02) / cell);
  const z = new Float32Array(nx * ny).fill(-Infinity);
  const tri = new Int32Array(nx * ny).fill(-1);
  holder.updateMatrixWorld(true);
  model.updateMatrixWorld(true);
  const inv = holder.matrixWorld.clone().invert();
  const meshes: THREE.Mesh[] = [], local: Float32Array[] = [];
  const m4 = new THREE.Matrix4();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry?.getAttribute('position') || (o as THREE.InstancedMesh).isInstancedMesh) return;
    const pos = m.geometry.getAttribute('position');
    m4.multiplyMatrices(inv, m.matrixWorld);
    const e = m4.elements;
    const out = new Float32Array(pos.count * 3);
    // plain float positions are read straight from the array; others (quantised, interleaved) once through getX
    const raw = !(pos as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && !pos.normalized && pos.itemSize === 3 && pos.array instanceof Float32Array ? (pos.array as Float32Array) : null;
    for (let i = 0; i < pos.count; i++) {
      const px = raw ? raw[i * 3] : pos.getX(i), py = raw ? raw[i * 3 + 1] : pos.getY(i), pz = raw ? raw[i * 3 + 2] : pos.getZ(i);
      out[i * 3] = e[0] * px + e[4] * py + e[8] * pz + e[12];
      out[i * 3 + 1] = e[1] * px + e[5] * py + e[9] * pz + e[13];
      out[i * 3 + 2] = e[2] * px + e[6] * py + e[10] * pz + e[14];
    }
    meshes.push(m);
    local.push(out);
  });
  // only triangles reaching the front band can be frontmost there: the most forward point, less 12 cm
  let zmax = -Infinity;
  for (const p of local) for (let i = 2; i < p.length; i += 3) if (p[i] > zmax) zmax = p[i];
  const zmin = zmax - 0.12;
  meshes.forEach((m, mi) => {
    const p = local[mi];
    const idx = m.geometry.index;
    const ix = idx ? idx.array : null;
    const n = idx ? idx.count / 3 : p.length / 9;
    for (let t = 0; t < n; t++) {
      const a0 = ix ? ix[t * 3] : t * 3, b0 = ix ? ix[t * 3 + 1] : t * 3 + 1, c0 = ix ? ix[t * 3 + 2] : t * 3 + 2;
      if (p[a0 * 3 + 2] < zmin && p[b0 * 3 + 2] < zmin && p[c0 * 3 + 2] < zmin) continue;
      const a = a0, b = b0, c = c0;
      const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
      const bx = p[b * 3], by = p[b * 3 + 1], bz = p[b * 3 + 2];
      const cx = p[c * 3], cy = p[c * 3 + 1], cz = p[c * 3 + 2];
      // facing +z (counter-clockwise seen from the front), not edge-on: back and side faces can't be frontmost
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (area < 1e-9) continue;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / cell)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - y0) / cell)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - y0) / cell));
      if (i1 < i0 || j1 < j0) continue;
      const inva = 1 / area;
      for (let j = j0; j <= j1; j++) {
        const y = y0 + (j + 0.5) * cell;
        for (let i = i0; i <= i1; i++) {
          const x = x0 + (i + 0.5) * cell;
          // barycentric
          const l1 = ((cx - bx) * (y - by) - (cy - by) * (x - bx)) * inva;
          const l2 = ((ax - cx) * (y - cy) - (ay - cy) * (x - cx)) * inva;
          const l3 = 1 - l1 - l2;
          if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
          const zz = l1 * az + l2 * bz + l3 * cz;
          const k = j * nx + i;
          if (zz > z[k]) {
            z[k] = zz;
            tri[k] = (mi << 21) | t;
          }
        }
      }
    }
  });
  // the front plane: a high percentile of the cells (knobs and a top board stand out further)
  const all = Array.from(z).filter(Number.isFinite).sort((a, b) => a - b);
  const zf = all.length ? all[Math.floor(all.length * 0.75)] : 0;
  return { cell, x0, y0, nx, ny, z, tri, meshes, local, zf, ms: performance.now() - t0 };
}

/** max z of the front at (x, y) */
function zAt(f: Front, x: number, y: number) {
  const i = Math.floor((x - f.x0) / f.cell), j = Math.floor((y - f.y0) / f.cell);
  if (i < 0 || j < 0 || i >= f.nx || j >= f.ny) return -Infinity;
  return f.z[j * f.nx + i];
}

/** runs of samples recessed behind the front plane (5 mm or more, or nothing there), 6 cm or narrower: their centres */
function seamRuns(zs: number[], at: (i: number) => number, zf: number, step: number) {
  const out: number[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length && run.length * step <= 0.06) out.push((at(run[0]) + at(run[run.length - 1])) / 2);
    run = [];
  };
  zs.forEach((z, i) => (z < zf - 0.005 ? run.push(i) : flush()));
  flush();
  return out;
}

/**
 * The drawer and door fronts of a library dresser / nightstand (holder-local; size [w, h, d] with
 * the front at +d/2), read off its front depth grid: horizontal seams (a recess between fronts) down
 * two columns split it into rows, a vertical seam near the middle splits a row in two; rows taller
 * than 45 cm are cupboard doors, hinged away from their knob. Null when nothing convincing is found.
 */
export function detectDrawers(model: THREE.Object3D, holder: THREE.Object3D, size: readonly number[], kind: 'dresser' | 'nightstand', front?: Front): Band[] | null {
  const f = front ?? readFront(model, holder, size);
  const [w, h] = size;
  const step = f.cell;
  const ny = Math.floor((h - 0.02) / step);
  const yAt = (i: number) => 0.01 + (i + 0.5) * step;
  // two columns a quarter in from each side (clear of the knobs in the middle and the posts at the edges)
  const zs: number[] = [];
  for (let i = 0; i < ny; i++) zs.push(Math.min(zAt(f, -w * 0.27, yAt(i)), zAt(f, w * 0.27, yAt(i))));
  const fin = zs.filter(Number.isFinite).sort((a, b) => a - b);
  if (fin.length < ny * 0.5) return null;
  // the front plane: where the fronts are down these columns (a top board or plinth may stand further out)
  const zf = fin[Math.floor(fin.length * 0.75)];
  // the fronts' outer limits: first and last sample on the front plane
  // (a top board or moulding standing proud of the fronts is not a drawer either)
  const on = zs.map((z, i) => (Math.abs(z - zf) <= 0.005 ? i : -1)).filter((i) => i >= 0);
  if (!on.length) return null;
  const ys = seamRuns(zs, yAt, zf, step).filter((y) => y > yAt(on[0]) && y < yAt(on[on.length - 1]));
  const edges = [yAt(on[0]) - step / 2, ...ys, yAt(on[on.length - 1]) + step / 2];
  const bands: Band[] = [];
  const x0 = -w / 2 + 0.04, x1 = w / 2 - 0.04;
  for (let i = 0; i + 1 < edges.length; i++) {
    const y0 = edges[i] + 0.004, y1 = edges[i + 1] - 0.004, bh = y1 - y0;
    // (a plinth or a moulding band is not a drawer; a tall one is a cupboard behind doors)
    if (bh < 0.11 || bh > 0.95) continue;
    const door = bh > 0.45;
    // a vertical seam near the middle of this row (two heights, both must be recessed)
    const nx = Math.floor((w * 0.6) / step), xAt = (k: number) => -w * 0.3 + (k + 0.5) * step;
    const xz: number[] = [];
    for (let k = 0; k < nx; k++) xz.push(Math.max(zAt(f, xAt(k), y0 + bh * 0.3), zAt(f, xAt(k), y0 + bh * 0.7)));
    const split = seamRuns(xz, xAt, zf, step).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
    const row: Band[] = split !== undefined
      ? [{ x: (x0 + split) / 2, y: y0, w: split - x0 - 0.006, h: bh }, { x: (split + x1) / 2, y: y0, w: x1 - split - 0.006, h: bh }]
      : [{ x: 0, y: y0, w: x1 - x0, h: bh }];
    if (door) {
      for (const b of row) {
        b.move = 'door';
        // the knob: what stands proud of the door; hinged on the other side (a pair: the outer sides)
        let sx = 0, n = 0;
        for (let x = b.x - b.w / 2 + 0.02; x < b.x + b.w / 2 - 0.02; x += step) {
          for (let y = y0 + bh * 0.2; y < y0 + bh * 0.8; y += step) if (zAt(f, x, y) > zf + 0.008) { sx += x; n++; }
        }
        b.hinge = n ? (sx / n > b.x ? 'left' : 'right') : row.length === 2 ? (b.x < 0 ? 'left' : 'right') : 'left';
      }
    }
    bands.push(...row);
  }
  if (!bands.length) return null;
  // a dresser needs two drawers to be believed (two rows, or a row of two over cupboard doors)
  if (kind === 'dresser' && bands.filter((b) => b.move !== 'door').length < 2) return null;
  for (const b of bands) b.z = zf;
  return bands;
}

/**
 * Cut the openings into the model: on a new copy of each touched geometry, the parts of the front
 * (within 3 cm of the front plane, or standing proud of it, like knobs) inside each opening are
 * dropped; triangles crossing an opening's edge are split along it first (big front panels too), so
 * a drawer slides out of a real hole and a door opens onto a real cavity. Returns the pieces dropped.
 */
export function cutOpenings(f: Front, bands: Band[]): number {
  let dropped = 0;
  const zcut = Math.min(...bands.map((q) => q.z ?? f.zf)) - 0.03;
  // the openings, with a 1 mm margin
  const rects = bands.map((b) => [b.x - b.w / 2 - 0.001, b.x + b.w / 2 + 0.001, b.y - 0.001, b.y + b.h + 0.001] as const);
  f.meshes.forEach((m, mi) => {
    const p = f.local[mi];
    const g = m.geometry;
    const idx = g.index;
    const n = idx ? idx.count / 3 : p.length / 9;
    const vi = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
    // which triangles are touched (in the front band and overlapping an opening)
    const touched: number[] = [];
    for (let t = 0; t < n; t++) {
      const a = vi(t, 0), b = vi(t, 1), c = vi(t, 2);
      if (Math.min(p[a * 3 + 2], p[b * 3 + 2], p[c * 3 + 2]) <= zcut) continue;
      const xmin = Math.min(p[a * 3], p[b * 3], p[c * 3]), xmax = Math.max(p[a * 3], p[b * 3], p[c * 3]);
      const ymin = Math.min(p[a * 3 + 1], p[b * 3 + 1], p[c * 3 + 1]), ymax = Math.max(p[a * 3 + 1], p[b * 3 + 1], p[c * 3 + 1]);
      if (rects.some(([x0, x1, y0, y1]) => xmax > x0 && xmin < x1 && ymax > y0 && ymin < y1)) touched.push(t);
    }
    if (!touched.length) return;
    // rebuild the geometry non-indexed: untouched triangles as they are, touched ones clipped
    // against each opening (split along its four edges, the pieces inside dropped)
    const names = Object.keys(g.attributes);
    const src = names.map((k) => g.getAttribute(k));
    const out: number[][] = names.map(() => []);
    /** a vertex: index weights over source vertices (for interpolating every attribute) and its local x, y */
    type V = { w: [number, number][]; x: number; y: number };
    const emit = (vs: V[]) => {
      for (let i = 1; i + 1 < vs.length; i++) for (const v of [vs[0], vs[i], vs[i + 1]]) {
        src.forEach((a, k) => {
          for (let c = 0; c < a.itemSize; c++) {
            let s = 0;
            for (const [j, wt] of v.w) s += wt * a.getComponent(j, c);
            out[k].push(s);
          }
        });
      }
    };
    const lerp = (a: V, b: V, t: number): V => {
      const w = new Map<number, number>();
      for (const [j, x] of a.w) w.set(j, (w.get(j) ?? 0) + x * (1 - t));
      for (const [j, x] of b.w) w.set(j, (w.get(j) ?? 0) + x * t);
      return { w: [...w.entries()], x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    };
    /** split a convex polygon by the line value(v) = 0 into the parts with value <= 0 and >= 0 */
    const split = (poly: V[], val: (v: V) => number): [V[], V[]] => {
      const neg: V[] = [], pos: V[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length], va = val(a), vb = val(b);
        if (va <= 0) neg.push(a);
        if (va >= 0) pos.push(a);
        if ((va < 0 && vb > 0) || (va > 0 && vb < 0)) {
          const x = lerp(a, b, va / (va - vb));
          neg.push(x);
          pos.push(x);
        }
      }
      return [neg, pos];
    };
    const isTouched = new Uint8Array(n);
    for (const t of touched) isTouched[t] = 1;
    const groups = g.groups.length ? g.groups : [{ start: 0, count: n * 3, materialIndex: 0 }];
    const newGroups: { start: number; count: number; materialIndex?: number }[] = [];
    let cut = 0;
    for (const gr of groups) {
      const start = out[0].length / src[0].itemSize;
      for (let t = gr.start / 3; t < (gr.start + gr.count) / 3 && t < n; t++) {
        const tri: V[] = [0, 1, 2].map((k) => { const j = vi(t, k); return { w: [[j, 1]], x: p[j * 3], y: p[j * 3 + 1] }; });
        if (!isTouched[t]) {
          emit(tri);
          continue;
        }
        // clip away every opening in turn
        let pieces: V[][] = [tri];
        for (const [x0, x1, y0, y1] of rects) {
          const next: V[][] = [];
          for (const poly of pieces) {
            // outside parts are kept as they come off; what is left at the end is inside the opening
            let rest = poly;
            for (const val of [(v: V) => x0 - v.x, (v: V) => v.x - x1, (v: V) => y0 - v.y, (v: V) => v.y - y1]) {
              if (rest.length < 3) break;
              const [inner, outer] = split(rest, val);
              if (outer.length >= 3) next.push(outer);
              rest = inner;
            }
            if (rest.length >= 3) cut++;
          }
          pieces = next;
        }
        for (const poly of pieces) emit(poly);
      }
      const end = out[0].length / src[0].itemSize;
      newGroups.push({ start, count: end - start, materialIndex: gr.materialIndex });
    }
    if (!cut) return;
    dropped += cut;
    // the loader shares geometry between copies of a model: this is a new one
    const ng = new THREE.BufferGeometry();
    names.forEach((k, i) => ng.setAttribute(k, new THREE.Float32BufferAttribute(out[i], src[i].itemSize)));
    if (g.groups.length) for (const q of newGroups) ng.addGroup(q.start, q.count, q.materialIndex);
    ng.computeBoundingSphere();
    ng.computeBoundingBox();
    m.geometry = ng;
    m.userData.owned = true;
  });
  return dropped;
}

/** the material and colour of the front at (x, y): the frontmost triangle's material, its texel there */
export function frontMaterialAt(f: Front, x: number, y: number): THREE.MeshStandardMaterial | null {
  const s = frontSampleAt(f, x, y);
  return s ? colourOf(s.material, s.uv) : null;
}

/**
 * The model's own material at (x, y) of its front and the uv there: give a replacement front that
 * material with every uv set to this one and it shows exactly that paint, lit as the model is.
 */
export function frontSampleAt(f: Front, x: number, y: number): { material: THREE.MeshStandardMaterial; uv?: THREE.Vector2; lum: number } | null {
  const i = Math.floor((x - f.x0) / f.cell), j = Math.floor((y - f.y0) / f.cell);
  const k = i >= 0 && j >= 0 && i < f.nx && j < f.ny ? f.tri[j * f.nx + i] : -1;
  if (k < 0) return null;
  const mi = k >>> 21, t = k & 0x1fffff;
  const m = f.meshes[mi];
  const g = m.geometry;
  const idx = g.index;
  const a = idx ? idx.getX(t * 3) : t * 3, b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
  let mat = m.material as THREE.Material | THREE.Material[];
  if (Array.isArray(mat)) {
    const grp = g.groups.find((q) => t * 3 >= q.start && t * 3 < q.start + q.count);
    mat = mat[grp?.materialIndex ?? 0];
  }
  const best = mat as THREE.MeshStandardMaterial;
  if (!best?.isMeshStandardMaterial) return null;
  // barycentric of (x, y) in the triangle, for its uv
  const p = f.local[mi];
  const ax = p[a * 3], ay = p[a * 3 + 1], bx = p[b * 3], by = p[b * 3 + 1], cx = p[c * 3], cy = p[c * 3 + 1];
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const l1 = ((cx - bx) * (y - by) - (cy - by) * (x - bx)) / area, l2 = ((ax - cx) * (y - cy) - (ay - cy) * (x - cx)) / area, l3 = 1 - l1 - l2;
  const uvA = g.getAttribute('uv');
  const uv = uvA ? new THREE.Vector2(l1 * uvA.getX(a) + l2 * uvA.getX(b) + l3 * uvA.getX(c), l1 * uvA.getY(a) + l2 * uvA.getY(b) + l3 * uvA.getY(c)) : undefined;
  const col = colourOf(best, uv).color;
  return { material: best, uv, lum: col.r * 0.3 + col.g * 0.59 + col.b * 0.11 };
}

/** a plain material in the colour of the model's (largest) material, or of `src` at uv */
export function frontMaterial(model: THREE.Object3D): THREE.MeshStandardMaterial | null {
  const area = new Map<THREE.MeshStandardMaterial, number>();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    const mat = m.isMesh ? (m.material as THREE.MeshStandardMaterial) : null;
    if (!mat || Array.isArray(mat) || !mat.isMeshStandardMaterial) return;
    const pos = m.geometry.getAttribute('position');
    area.set(mat, (area.get(mat) ?? 0) + (pos?.count ?? 0));
  });
  const best = [...area.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ? colourOf(best) : null;
}

function colourOf(best: THREE.MeshStandardMaterial, uv?: THREE.Vector2): THREE.MeshStandardMaterial {
  const c = best.color.clone();
  const img = best.map?.image as CanvasImageSource & { width?: number; height?: number } | undefined;
  if (img && typeof document !== 'undefined' && img.width) {
    try {
      const g = sampler(img);
      let d: Uint8ClampedArray;
      if (uv && best.map) {
        // a 9 x 9 texel patch round the point (texture transform applied, flipY as three uploads it)
        const t = uv.clone();
        best.map.transformUv(t);
        const S = 256, x = Math.floor(t.x * S), y = Math.floor((best.map.flipY ? 1 - t.y : t.y) * S);
        d = g.getImageData(Math.max(0, Math.min(S - 9, x - 4)), Math.max(0, Math.min(S - 9, y - 4)), 9, 9).data;
      } else d = g.getImageData(0, 0, 256, 256).data;
      let r = 0, gg = 0, b = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
      c.multiply(new THREE.Color().setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace));
    } catch {
      // a tainted or compressed texture: keep the plain colour
    }
  }
  return new THREE.MeshStandardMaterial({ color: c, roughness: best.roughness, metalness: best.metalness });
}

const innerMat = new THREE.MeshStandardMaterial({ color: '#6b5a48', roughness: 0.95 });
/**
 * The compartment behind an opening (in the container's frame: front-centre base, +z out): back,
 * sides, floor and top, so the opening shows a cavity and nothing of the model's insides or the wall.
 */
export function compartment(w: number, h: number, d: number, mat: THREE.Material = innerMat): THREE.Group {
  const g = new THREE.Group();
  const t = 0.012;
  const box = (bw: number, bh: number, bd: number, x: number, y: number, z: number) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
    b.position.set(x, y + bh / 2, z);
    b.userData.owned = true;
    b.receiveShadow = true;
    g.add(b);
  };
  box(w + 2 * t, h + 2 * t, t, 0, -t, -d - t / 2); // back
  box(t, h, d, -w / 2 - t / 2, 0, -d / 2); // sides
  box(t, h, d, w / 2 + t / 2, 0, -d / 2);
  box(w, t, d, 0, -t, -d / 2); // floor
  box(w, t, d, 0, h, -d / 2); // top
  g.name = 'compartment';
  return g;
}

const samplers = new WeakMap<object, CanvasRenderingContext2D>();
/** the texture's image drawn once at 256 x 256 into a readable canvas */
function sampler(img: CanvasImageSource) {
  let g = samplers.get(img);
  if (!g) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    g = cv.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, 256, 256);
    samplers.set(img, g);
  }
  return g;
}

const slotMats = { cavity: new THREE.MeshStandardMaterial({ color: '#1d1611', roughness: 1 }), edge: new THREE.MeshStandardMaterial({ color: '#3a2c20', roughness: 0.9 }) };
/**
 * The empty slot a pulled-out drawer leaves, drawn just proud of the model's own closed front (which
 * would otherwise still show behind the drawer): a dark cavity with lit inner sides along its rim.
 */
export function slotMesh(w: number, h: number): THREE.Group {
  const g = new THREE.Group();
  const box = (bw: number, bh: number, bd: number, x: number, y: number, z: number, m: THREE.Material) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), m);
    b.position.set(x, y + bh / 2, z + bd / 2);
    b.userData.owned = true;
    g.add(b);
  };
  const t = 0.014;
  box(w, h, 0.003, 0, 0, 0.001, slotMats.cavity); // the dark inside
  // the slot's inner sides, seen in perspective: a rim, lighter at the bottom (the runner) than the top
  box(w, t, 0.004, 0, 0, 0.002, slotMats.edge);
  box(w, t * 0.6, 0.004, 0, h - t * 0.6, 0.002, slotMats.cavity);
  box(t * 0.8, h, 0.004, -w / 2 + t * 0.4, 0, 0.002, slotMats.edge);
  box(t * 0.8, h, 0.004, w / 2 - t * 0.4, 0, 0.002, slotMats.edge);
  g.traverse((o) => (o.renderOrder = 1));
  g.visible = false;
  return g;
}

// ---------------------------------------------------------------- contents

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
const mats = new Map<string, THREE.MeshStandardMaterial>();
const matOf = (c: string, rough = 0.9) => {
  let m = mats.get(c + rough);
  if (!m) mats.set(c + rough, (m = new THREE.MeshStandardMaterial({ color: c, roughness: rough })));
  return m;
};
const CLOTH = ['#2f3e5c', '#8a2f2f', '#d9d4c8', '#556b4a', '#c9a27a', '#3d3d42', '#b5c4d6', '#e6b8a8', '#6c5a8a', '#f2efe6'];
const LINEN = ['#f4f2ec', '#e9e4d8', '#dfe6ec', '#efe1d4', '#d8e2d4', '#c9d3de'];
const CERAMIC = ['#f6f4ee', '#eef1f4', '#2f4a6a', '#e9e2d0', '#c8d6d2'];
const CARD = ['#b48a5c', '#9c7a52', '#d8c8a8', '#e2dcd0', '#7a8a9a'];

export type Theme = 'clothes' | 'linens' | 'dishes' | 'boxes';
/** what is kept in a room's dressers and cupboards */
export function themeOf(roomType: string, door: boolean): Theme {
  if (/kitchen|dining|pantry/.test(roomType)) return door ? 'dishes' : 'boxes';
  if (/bed|kids/.test(roomType)) return door ? 'linens' : 'clothes';
  if (/living|study/.test(roomType)) return door ? 'boxes' : 'linens';
  return 'boxes';
}

/**
 * Contents for a library drawer or cupboard, in the container's frame (origin at the front-centre of
 * its base, +z out of the front): the compartment is x in [-w/2, w/2], y in [0, h], z in [-d, 0].
 * Folded clothes or linens in stacks, plates, bowls and cups, or boxes; a shelf halfway up a tall cupboard.
 */
export function fillCompartment(seed: number, w: number, h: number, d: number, theme: Theme): THREE.Group {
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const g = new THREE.Group();
  const box = (bw: number, bh: number, bd: number, x: number, y: number, z: number, m: THREE.Material, ry = 0) => {
    const o = new THREE.Mesh(unitBox, m);
    o.scale.set(bw, bh, bd);
    o.position.set(x, y + bh / 2, z);
    o.rotation.y = ry;
    g.add(o);
  };
  const cyl = (r: number, ch: number, x: number, y: number, z: number, m: THREE.Material) => {
    const o = new THREE.Mesh(unitCyl, m);
    o.scale.set(r * 2, ch, r * 2);
    o.position.set(x, y + ch / 2, z);
    g.add(o);
  };
  // levels: the floor, and a shelf halfway up anything taller than 45 cm
  const levels = h > 0.45 ? [0.02, h / 2 + 0.01] : [0.015];
  if (h > 0.45) box(w - 0.02, 0.018, d - 0.04, 0, h / 2 - 0.008, -d / 2, matOf('#e8e2d6', 0.8));
  for (const y0 of levels) {
    const room = Math.min(h > 0.45 ? h / 2 - 0.06 : h - 0.04, 0.3);
    const zc = -d / 2 - 0.01, dd = Math.min(d - 0.06, 0.34);
    if (theme === 'clothes' || theme === 'linens') {
      const n = Math.max(2, Math.floor((w - 0.04) / (theme === 'linens' ? 0.32 : 0.26)));
      const sw = (w - 0.04) / n;
      for (let i = 0; i < n; i++) {
        const x = -w / 2 + 0.02 + (i + 0.5) * sw;
        let y = y0;
        const top = y0 + room * (0.55 + rnd() * 0.4);
        while (y < top - 0.02) {
          const th = theme === 'linens' ? 0.03 + rnd() * 0.03 : 0.025 + rnd() * 0.02;
          box(sw - 0.03 - rnd() * 0.02, th, dd * (0.8 + rnd() * 0.15), x + (rnd() - 0.5) * 0.015, y, zc, matOf(pick(theme === 'linens' ? LINEN : CLOTH)), (rnd() - 0.5) * 0.05);
          y += th + 0.002;
        }
      }
    } else if (theme === 'dishes') {
      let x = -w / 2 + 0.03;
      while (x < w / 2 - 0.08) {
        const kind = rnd();
        const m = matOf(pick(CERAMIC), 0.35);
        if (kind < 0.45) {
          // a stack of plates
          const r = 0.1 + rnd() * 0.03, n = 3 + Math.floor(rnd() * 6);
          if (x + 2 * r > w / 2 - 0.02) break;
          for (let k = 0; k < n; k++) cyl(r, 0.012, x + r, y0 + k * 0.014, zc, m);
          x += 2 * r + 0.02;
        } else if (kind < 0.75) {
          // bowls, nested
          const r = 0.07;
          if (x + 2 * r > w / 2 - 0.02) break;
          for (let k = 0; k < 2 + Math.floor(rnd() * 3); k++) cyl(r - k * 0.004, 0.05, x + r, y0 + k * 0.02, zc + 0.04, m);
          x += 2 * r + 0.02;
        } else {
          // cups in a row, front to back
          if (x + 0.08 > w / 2 - 0.02) break;
          for (let k = 0; k < 2; k++) cyl(0.04, 0.09, x + 0.04, y0, zc + 0.08 - k * 0.11, m);
          x += 0.1;
        }
      }
    } else {
      let x = -w / 2 + 0.02;
      while (x < w / 2 - 0.08) {
        const bw = Math.min(w / 2 - 0.02 - x, 0.12 + rnd() * 0.2), bh = Math.min(room, 0.06 + rnd() * 0.18);
        box(bw - 0.01, bh, dd * (0.6 + rnd() * 0.35), x + bw / 2, y0, zc, matOf(pick(CARD), 0.95));
        if (rnd() < 0.4 && bh < room - 0.08) box(bw * 0.8, 0.05, dd * 0.5, x + bw / 2, y0 + bh, zc, matOf(pick(CARD), 0.95));
        x += bw + 0.005;
      }
    }
  }
  return g;
}

/** paint a replacement front with the model's own material at one uv (every vertex there) */
export function paintWith(o: THREE.Object3D, from: THREE.Material, sample: { material: THREE.Material; uv?: THREE.Vector2 }) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh || m.material !== from) return;
    const n = m.geometry.getAttribute('position').count;
    if (sample.uv) {
      const uv = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { uv[i * 2] = sample.uv.x; uv[i * 2 + 1] = sample.uv.y; }
      m.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    m.material = sample.material;
  });
}
