import * as THREE from 'three';

/**
 * Drawers for library (Poly Haven) furniture whose drawer fronts are baked into the model
 * (interior.ts libDrawerSet, lazy.ts containers):
 *
 *  - detectDrawers: the drawer layout read from the model's front face: horizontal seams that run
 *    across most of the width separate the rows, and a vertical seam near the middle of a row splits
 *    it into two drawers side by side. Null when nothing convincing is found (even rows then).
 *  - frontMaterial: a plain material in the colour of the model's front (texture averaged), so the
 *    pulled-out drawer matches the paint.
 *  - slotMesh: the dark empty slot drawn over the model's own (closed) front while a drawer is out.
 */

export interface Band {
  /** centre x, bottom y, width, height of one drawer front (holder-local, front at +d/2) */
  x: number;
  y: number;
  w: number;
  h: number;
}

const v = new THREE.Vector3();

/** probes the depth of the model's front face along rays shot straight at it (holder-local) */
function depthProbe(model: THREE.Object3D, holder: THREE.Object3D, d: number) {
  holder.updateMatrixWorld(true);
  model.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  const o = new THREE.Vector3(), dir = new THREE.Vector3();
  const back = new THREE.Matrix4().copy(holder.matrixWorld).invert();
  dir.set(0, 0, -1).transformDirection(holder.matrixWorld);
  const hits: THREE.Intersection[] = [];
  /** z (holder-local) of the first surface hit at (x, y), or -Infinity */
  return (x: number, y: number) => {
    o.set(x, y, d / 2 + 0.3).applyMatrix4(holder.matrixWorld);
    rc.set(o, dir);
    rc.far = d + 0.6;
    hits.length = 0;
    rc.intersectObject(model, true, hits);
    if (!hits.length) return -Infinity;
    return v.copy(hits[0].point).applyMatrix4(back).z;
  };
}

/** runs of samples recessed behind the front plane (5 mm or more, or no hit), 6 cm or narrower: their centres */
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
 * The drawer fronts of a library dresser / nightstand (holder-local; size [w, h, d] with the front
 * at +d/2), read off the model by probing its front with rays: horizontal seams (a recess between
 * fronts) down two columns split it into rows, and a vertical seam near the middle of a row splits
 * that row into two drawers. Null when no convincing layout is found (even rows are used then).
 */
export function detectDrawers(model: THREE.Object3D, holder: THREE.Object3D, size: readonly number[], kind: 'dresser' | 'nightstand'): Band[] | null {
  const [w, h, d] = size;
  const depth = depthProbe(model, holder, d);
  const step = 0.008;
  const ny = Math.floor((h - 0.02) / step);
  const yAt = (i: number) => 0.01 + i * step;
  // two columns a quarter in from each side (clear of the knobs in the middle and the posts at the edges)
  const zs: number[] = [];
  for (let i = 0; i < ny; i++) zs.push(Math.min(depth(-w * 0.27, yAt(i)), depth(w * 0.27, yAt(i))));
  const sorted = zs.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length < ny * 0.5) return null;
  const zf = sorted[Math.floor(sorted.length * 0.75)];
  // the fronts' outer limits: first and last sample on the front plane
  // (a top board or moulding standing proud of the fronts is not a drawer either)
  const on = zs.map((z, i) => (Math.abs(z - zf) <= 0.005 ? i : -1)).filter((i) => i >= 0);
  if (!on.length) return null;
  const ys = seamRuns(zs, yAt, zf, step).filter((y) => y > yAt(on[0]) && y < yAt(on[on.length - 1]));
  const edges = [yAt(on[0]), ...ys, yAt(on[on.length - 1])];
  const bands: Band[] = [];
  const x0 = -w / 2 + 0.04, x1 = w / 2 - 0.04;
  for (let i = 0; i + 1 < edges.length; i++) {
    const y0 = edges[i] + 0.004, y1 = edges[i + 1] - 0.004, bh = y1 - y0;
    // (a plinth or a moulding band is not a drawer)
    if (bh < 0.11 || bh > 0.45) continue;
    // a vertical seam near the middle of this row (probed at two heights, both must be recessed)
    const nx = Math.floor((w * 0.6) / step), xAt = (k: number) => -w * 0.3 + k * step;
    const xz: number[] = [];
    for (let k = 0; k < nx; k++) xz.push(Math.max(depth(xAt(k), y0 + bh * 0.3), depth(xAt(k), y0 + bh * 0.7)));
    const split = seamRuns(xz, xAt, zf, step).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
    if (split !== undefined) {
      bands.push({ x: (x0 + split) / 2, y: y0, w: split - x0 - 0.006, h: bh });
      bands.push({ x: (split + x1) / 2, y: y0, w: x1 - split - 0.006, h: bh });
    } else bands.push({ x: 0, y: y0, w: x1 - x0, h: bh });
  }
  if (!bands.length) return null;
  // a dresser needs two drawers to be believed (two rows, or a row of two over cupboard doors)
  if (kind === 'dresser' && bands.length < 2) return null;
  return bands;
}

/** a plain material in the average colour of the model's (largest) front material */
export function frontMaterial(model: THREE.Object3D, at?: { holder: THREE.Object3D; size: readonly number[]; x: number; y: number }): THREE.MeshStandardMaterial | null {
  let best: THREE.MeshStandardMaterial | undefined;
  /** where on its texture the front was hit (an atlas covers the whole piece: average only there) */
  let uv: THREE.Vector2 | undefined;
  if (at) {
    // the material actually on the drawer front: what a ray at its centre hits
    const [, , d] = at.size;
    at.holder.updateMatrixWorld(true);
    const o = new THREE.Vector3(at.x, at.y, d / 2 + 0.3).applyMatrix4(at.holder.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(at.holder.matrixWorld);
    const hit = new THREE.Raycaster(o, dir, 0, d + 0.6).intersectObject(model, true)[0];
    if (hit) {
      const m = (hit.object as THREE.Mesh).material;
      const mm = (Array.isArray(m) ? m[hit.face?.materialIndex ?? 0] : m) as THREE.MeshStandardMaterial;
      if (mm?.isMeshStandardMaterial) best = mm;
      uv = hit.uv?.clone();
    }
  }
  if (!best) {
    // else the material covering the most of the model
    const area = new Map<THREE.MeshStandardMaterial, number>();
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      const mat = m.isMesh ? (m.material as THREE.MeshStandardMaterial) : null;
      if (!mat || Array.isArray(mat) || !mat.isMeshStandardMaterial) return;
      const pos = m.geometry.getAttribute('position');
      area.set(mat, (area.get(mat) ?? 0) + (pos?.count ?? 0));
    });
    best = [...area.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  if (!best) return null;
  const c = best.color.clone();
  const img = best.map?.image as CanvasImageSource & { width?: number; height?: number } | undefined;
  if (img && typeof document !== 'undefined' && img.width) {
    try {
      const g = sampler(img);
      let d: Uint8ClampedArray;
      if (uv && best.map) {
        // a 9 x 9 texel patch round the hit (texture transform applied, flipY as three uploads it)
        const t = uv.clone();
        best.map.transformUv(t);
        const S = 256, x = Math.floor(t.x * S), y = Math.floor((best.map.flipY ? 1 - t.y : t.y) * S);
        d = g.getImageData(Math.max(0, Math.min(S - 9, x - 4)), Math.max(0, Math.min(S - 9, y - 4)), 9, 9).data;
      } else d = g.getImageData(0, 0, 256, 256).data;
      let r = 0, gg = 0, b = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
      const avg = new THREE.Color().setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace);
      c.multiply(avg);
    } catch {
      // a tainted or compressed texture: keep the plain colour
    }
  }
  return new THREE.MeshStandardMaterial({ color: c, roughness: best.roughness, metalness: best.metalness });
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
  g.visible = false;
  return g;
}
