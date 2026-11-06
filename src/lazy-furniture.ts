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
  /** a drawer (default) or a cupboard door, hinged on the side away from its knob */
  move?: 'drawer' | 'door';
  hinge?: 'left' | 'right';
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
  const it = detectDrawersSteps(model, holder, size, kind);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/**
 * detectDrawers in slices: yields after every couple of rays (a few hundred in all, ~0.3 ms each
 * on a library model), so it can run in idle time (runIdle) instead of one 100 ms block.
 */
export function* detectDrawersSteps(model: THREE.Object3D, holder: THREE.Object3D, size: readonly number[], kind: 'dresser' | 'nightstand'): Generator<void, Band[] | null> {
  const [w, h, d] = size;
  const depth = depthProbe(model, holder, d);
  const step = 0.008;
  const ny = Math.floor((h - 0.02) / step);
  const yAt = (i: number) => 0.01 + i * step;
  // two columns a quarter in from each side (clear of the knobs in the middle and the posts at the edges)
  const zs: number[] = [];
  for (let i = 0; i < ny; i++) {
    zs.push(Math.min(depth(-w * 0.27, yAt(i)), depth(w * 0.27, yAt(i))));
    yield;
  }
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
    // (a plinth or a moulding band is not a drawer; a tall one is a cupboard behind doors)
    if (bh < 0.11 || bh > 0.95) continue;
    const door = bh > 0.45;
    // a vertical seam near the middle of this row (probed at two heights, both must be recessed)
    const nx = Math.floor((w * 0.6) / step), xAt = (k: number) => -w * 0.3 + k * step;
    const xz: number[] = [];
    for (let k = 0; k < nx; k++) {
      xz.push(Math.max(depth(xAt(k), y0 + bh * 0.3), depth(xAt(k), y0 + bh * 0.7)));
      yield;
    }
    const split = seamRuns(xz, xAt, zf, step).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
    const row: Band[] = split !== undefined
      ? [{ x: (x0 + split) / 2, y: y0, w: split - x0 - 0.006, h: bh }, { x: (split + x1) / 2, y: y0, w: x1 - split - 0.006, h: bh }]
      : [{ x: 0, y: y0, w: x1 - x0, h: bh }];
    if (door) {
      for (const b of row) {
        b.move = 'door';
        // the knob: what stands proud of the door; hinged on the other side (a pair: the outer sides)
        let sx = 0, n = 0;
        for (let k = 0; k <= 20; k++) {
          const x = b.x - b.w / 2 + 0.02 + (k / 20) * (b.w - 0.04);
          for (const f of [0.35, 0.5, 0.65]) if (depth(x, y0 + bh * f) > zf + 0.008) { sx += x; n++; }
          yield;
        }
        b.hinge = n ? (sx / n > b.x ? 'left' : 'right') : row.length === 2 ? (b.x < 0 ? 'left' : 'right') : 'left';
      }
    }
    bands.push(...row);
  }
  if (!bands.length) return null;
  // a dresser needs two drawers to be believed (two rows, or a row of two over cupboard doors)
  if (kind === 'dresser' && bands.filter((b) => b.move !== 'door').length < 2) return null;
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

/**
 * Run a sliced job in idle time: at most `budget` ms per idle callback (setTimeout slices where
 * requestIdleCallback is missing). Resolves with the job's result; stats get the slice times.
 */
export function runIdle<T>(job: Generator<void, T>, budget = 2, stats?: { ms: number; slices: number; maxSlice: number }): Promise<T> {
  return new Promise((resolve) => {
    const step = (deadline?: { timeRemaining(): number }) => {
      const t0 = performance.now();
      const until = t0 + Math.min(budget, deadline ? Math.max(0.5, deadline.timeRemaining()) : budget);
      for (;;) {
        const r = job.next();
        if (r.done) {
          note(t0);
          return resolve(r.value);
        }
        if (performance.now() >= until) break;
      }
      note(t0);
      schedule();
    };
    const note = (t0: number) => {
      if (!stats) return;
      const ms = performance.now() - t0;
      stats.ms += ms;
      stats.slices++;
      stats.maxSlice = Math.max(stats.maxSlice, ms);
    };
    const schedule = () => (typeof requestIdleCallback === 'function' ? requestIdleCallback(step, { timeout: 50 }) : setTimeout(step, 0));
    schedule();
  });
}
