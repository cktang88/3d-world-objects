import * as THREE from 'three';
import { AX, SZ, LX, LZ } from './common';
import { CityHlod } from './hlod';
import type { Hull } from './buildings';

/**
 * City chunk visibility (WP2 in docs/research/performance.md):
 *
 *  1. Ring: chunks kept resident beyond RX/RZ (unload hysteresis) are not drawn as real geometry.
 *  2. Street-canyon occlusion: a CPU occlusion horizon (Downs, Möller & Séquin 2001) over the
 *     Manhattan grid. Each block is an occluder box of its *lowest* street wall; chunks are
 *     processed front to back, each tested against the horizon of the blocks in front of it, then
 *     added to it. Conservative everywhere (farthest occluder corner, nearest occludee point,
 *     highest occludee top, spans padded by a bin), so it never hides something visible.
 *  3. HLOD (hlod.ts): chunks that are hidden this way show a cheap proxy instead — drawn when the
 *     chunk is merely far/outside the ring, shadow-only when it is occluded.
 *
 * Works for any RX/RZ (including 0 and 1). Cost: ~49 boxes × a few hundred bins, only when the
 * eye moves more than 0.5 m.
 */

const BINS = 720;
/** everything outside buildings (trees, lamps, signals, vehicles) stays below this (m) */
const TALL = 19;

/** greedy rectangles (chunk-local) over the cells that rise above TALL, each with its top */
function tallParts(g: { cell: number; nx: number; nz: number; hmax: Float32Array }) {
  const { cell, nx, nz, hmax } = g;
  const used = new Uint8Array(nx * nz);
  const out: { x0: number; x1: number; z0: number; z1: number; top: number }[] = [];
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++) {
      const k = iz * nx + ix;
      if (used[k] || hmax[k] <= TALL) continue;
      let w = 1;
      while (ix + w < nx && hmax[iz * nx + ix + w] > TALL && !used[iz * nx + ix + w]) w++;
      let d = 1;
      grow: while (iz + d < nz) {
        for (let j = 0; j < w; j++) if (hmax[(iz + d) * nx + ix + j] <= TALL || used[(iz + d) * nx + ix + j]) break grow;
        d++;
      }
      let top = 0;
      for (let a = 0; a < d; a++) for (let j = 0; j < w; j++) { used[(iz + a) * nx + ix + j] = 1; top = Math.max(top, hmax[(iz + a) * nx + ix + j]); }
      out.push({ x0: -LX + ix * cell, x1: -LX + (ix + w) * cell, z0: -LZ + iz * cell, z1: -LZ + (iz + d) * cell, top });
    }
  return out;
}
const TAU = Math.PI * 2;

interface ChunkVis {
  cx: number;
  cz: number;
  group: THREE.Object3D;
  /** lowest street wall around the block (m); 0 = gaps, never occludes */
  wall: number;
  /** highest thing in the chunk (m) */
  top: number;
  /** parts rising above TALL (chunk-local rects with their tops) */
  tall: { x0: number; x1: number; z0: number; z1: number; top: number }[];
  /** height grid for the HLOD proxy */
  hlodId: number;
  /** last decision */
  real: boolean;
  occluded: boolean;
}

/** max-height grid of a built chunk, in chunk-local coordinates over the building area */
export interface HeightGrid {
  cell: number;
  nx: number;
  nz: number;
  h: Float32Array;
}

/**
 * Scan the chunk's meshes for building heights (once per chunk, a few ms):
 *  - h:   roof heights. Every near-horizontal triangle (roofs, cornices, box tops) is rasterised
 *         over its footprint with its LOWEST vertex height, so the grid never overestimates a wall
 *         (conservative for occlusion) and fills whole footprints (for the HLOD boxes).
 *  - top: the highest vertex anywhere in the building area (for the occludee test).
 */
export function heightGrid(group: THREE.Object3D, cell = 2): HeightGrid & { top: number; hmax: Float32Array } {
  const nx = Math.ceil((LX * 2) / cell), nz = Math.ceil((LZ * 2) / cell);
  const h = new Float32Array(nx * nz);
  /** highest point over each cell (every triangle's bbox with its top vertex: overestimates, for occludees) */
  const hmax = new Float32Array(nx * nz);
  let top = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  group.updateMatrix();
  const inv = new THREE.Matrix4().copy(group.matrix).invert();
  group.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4();
  const I = new THREE.Matrix4();
  const M = 0.6; // slack past the building line (cornices, storefront depth)
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (o as THREE.InstancedMesh).isInstancedMesh || (o as THREE.BatchedMesh).isBatchedMesh) return;
    const pos = m.geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    toLocal.multiplyMatrices(inv, m.matrixWorld);
    const ident = toLocal.equals(I);
    const index = m.geometry.index;
    const n = index ? index.count : pos.count;
    const get = (i: number, v: THREE.Vector3) => {
      v.fromBufferAttribute(pos, index ? index.getX(i) : i);
      if (!ident) v.applyMatrix4(toLocal);
      return v;
    };
    for (let i = 0; i + 2 < n; i += 3) {
      get(i, a); get(i + 1, b); get(i + 2, c);
      const minX = Math.min(a.x, b.x, c.x), maxX = Math.max(a.x, b.x, c.x), minZ = Math.min(a.z, b.z, c.z), maxZ = Math.max(a.z, b.z, c.z);
      if (maxX < -LX - M || minX > LX + M || maxZ < -LZ - M || minZ > LZ + M) continue;
      const yMax = Math.max(a.y, b.y, c.y);
      if (yMax > top && minX > -LX - M && maxX < LX + M && minZ > -LZ - M && maxZ < LZ + M) top = yMax;
      if (yMax > TALL) {
        const jx0 = Math.max(0, Math.floor((minX + LX) / cell)), jx1 = Math.min(nx - 1, Math.floor((maxX + LX) / cell));
        const jz0 = Math.max(0, Math.floor((minZ + LZ) / cell)), jz1 = Math.min(nz - 1, Math.floor((maxZ + LZ) / cell));
        for (let iz = jz0; iz <= jz1; iz++) for (let ix = jx0; ix <= jx1; ix++) if (yMax > hmax[iz * nx + ix]) hmax[iz * nx + ix] = yMax;
      }
      // near-horizontal only
      e1.subVectors(b, a); e2.subVectors(c, a);
      const cx = e1.y * e2.z - e1.z * e2.y, cy = e1.z * e2.x - e1.x * e2.z, cz = e1.x * e2.y - e1.y * e2.x;
      const len = Math.hypot(cx, cy, cz);
      if (len < 1e-6 || Math.abs(cy) / len < 0.9) continue;
      const y = Math.min(a.y, b.y, c.y);
      if (y < 3) continue;
      const ix0 = Math.max(0, Math.floor((minX + LX) / cell + 0.25)), ix1 = Math.min(nx - 1, Math.ceil((maxX + LX) / cell - 0.25) - 1);
      const iz0 = Math.max(0, Math.floor((minZ + LZ) / cell + 0.25)), iz1 = Math.min(nz - 1, Math.ceil((maxZ + LZ) / cell - 0.25) - 1);
      for (let iz = iz0; iz <= iz1; iz++)
        for (let ix = ix0; ix <= ix1; ix++) {
          const k = iz * nx + ix;
          if (y > h[k]) h[k] = y;
        }
    }
  });
  return { cell, nx, nz, h, top, hmax };
}

/** lowest street-wall height around the block: per side, the max over a 4 m frontage band, min along the side */
function wallHeight(g: HeightGrid) {
  const { nx, nz, h } = g;
  const band = 2;
  let wall = Infinity;
  const side = (cols: number, at: (i: number, b: number) => number) => {
    let m = Infinity;
    for (let i = 0; i < cols; i++) {
      let best = 0;
      for (let b = 0; b < band; b++) best = Math.max(best, at(i, b));
      m = Math.min(m, best);
    }
    return m;
  };
  wall = Math.min(wall, side(nx, (i, b) => h[b * nx + i]));
  wall = Math.min(wall, side(nx, (i, b) => h[(nz - 1 - b) * nx + i]));
  wall = Math.min(wall, side(nz, (i, b) => h[i * nx + b]));
  wall = Math.min(wall, side(nz, (i, b) => h[i * nx + (nx - 1 - b)]));
  return Number.isFinite(wall) ? wall : 0;
}

const binOf = (a: number) => ((Math.floor(((a % TAU) + TAU) % TAU / TAU * BINS)) % BINS + BINS) % BINS;

export class CityVis {
  private chunks = new Map<string, ChunkVis>();
  private horizonE = new Float32Array(BINS);
  private horizonD = new Float32Array(BINS);
  private lastEye = new THREE.Vector3(1e9, 0, 0);
  private lastKey = '';
  hlod = new CityHlod();
  /** counters for tools (viscount) */
  stats = { real: 0, hlod: 0, shadowOnly: 0, ring: 0, occluded: 0 };
  /** beyond this distance (m, nearest point of the chunk) a visible chunk shows its HLOD instead */
  hlodDist = 175;
  enabled = true;

  /** 'real' | 'hlod' (far / outside the ring) | 'occluded' (shadow proxy only) */
  modeOf(cx: number, cz: number) {
    const c = this.chunks.get(`${cx},${cz}`);
    return !c ? null : c.real ? 'real' : c.occluded ? 'occluded' : 'hlod';
  }

  /** per-chunk summary for tools */
  debug() {
    return [...this.chunks.values()].map((c) => `${c.cx},${c.cz}:w${c.wall.toFixed(0)}/t${c.top.toFixed(0)}/${c.real ? 'R' : 'h'}`).join(' ');
  }

  private root: THREE.Object3D | null = null;
  private lights: THREE.DirectionalLight[] = [];
  private lightScan = 0;

  attach(root: THREE.Object3D) {
    this.root = root;
    this.hlod.attach(root);
  }

  /** the far shadow cascade casts proxies instead of real chunks (refreshes the light list every ~2 s) */
  private shadowLayers() {
    if (!this.root) return;
    if (--this.lightScan <= 0) {
      this.lightScan = 120;
      let scene: THREE.Object3D = this.root;
      while (scene.parent) scene = scene.parent;
      const ls: THREE.DirectionalLight[] = [];
      scene.traverse((o) => { const l = o as THREE.DirectionalLight; if (l.isDirectionalLight && l.castShadow) ls.push(l); });
      this.lights = ls;
    }
    this.hlod.shadowLayers(this.lights);
  }

  add(cx: number, cz: number, group: THREE.Object3D, hulls?: Hull[], hullsLocal = false) {
    const grid = heightGrid(group);
    const top = Math.max(16, grid.top);
    group.userData.chunk = true;
    const hlodId = this.hlod.add(cx, cz, grid, hulls, hullsLocal);
    this.chunks.set(`${cx},${cz}`, { cx, cz, group, wall: wallHeight(grid), top, tall: tallParts(grid), hlodId, real: true, occluded: false });
    this.lastKey = '';
  }

  remove(cx: number, cz: number) {
    const c = this.chunks.get(`${cx},${cz}`);
    if (!c) return;
    this.hlod.remove(c.hlodId);
    this.chunks.delete(`${cx},${cz}`);
    this.lastKey = '';
  }

  /**
   * Decide every chunk's representation for an eye position. ccx/ccz: the eye's chunk,
   * rx/rz: the resident ring radius (chunks beyond are unload hysteresis).
   */
  update(eye: THREE.Vector3, ccx: number, ccz: number, rx: number, rz: number) {
    this.shadowLayers();
    const key = `${ccx},${ccz},${this.chunks.size},${this.enabled},${rx},${rz},${this.hlodDist}`;
    if (key === this.lastKey && eye.distanceToSquared(this.lastEye) < 0.25) return;
    this.lastKey = key;
    this.lastEye.copy(eye);
    this.horizonE.fill(-Math.PI / 2);
    this.horizonD.fill(0);
    const s = this.stats;
    s.real = s.hlod = s.shadowOnly = s.ring = s.occluded = 0;
    // front to back by the distance of each chunk's block
    const list = [...this.chunks.values()].map((c) => {
      const ox = c.cx * AX, oz = c.cz * SZ;
      return { c, ox, oz, d: rectDist(eye, ox - LX, ox + LX, oz - LZ, oz + LZ) };
    });
    list.sort((a, b) => a.d - b.d);
    for (const { c, ox, oz } of list) {
      const inRing = Math.abs(c.cx - ccx) <= rx && Math.abs(c.cz - ccz) <= rz;
      // occludee: the whole chunk cell (block + its half of the roads) up to its top
      const own = c.cx === ccx && c.cz === ccz;
      // hidden if the low cell (streets, sidewalks, low buildings up to TALL) is behind the horizon
      // and so is every part that rises above it
      const occluded = this.enabled && !own && this.hidden(eye, ox - AX / 2, ox + AX / 2, oz - SZ / 2, oz + SZ / 2, TALL) && c.tall.every((t) => this.hidden(eye, ox + t.x0, ox + t.x1, oz + t.z0, oz + t.z1, t.top + 2));
      const dNear = rectDist(eye, ox - AX / 2, ox + AX / 2, oz - SZ / 2, oz + SZ / 2);
      const real = !this.enabled || own || (inRing && !occluded && dNear < this.hlodDist);
      c.group.visible = real;
      c.real = real;
      c.occluded = occluded;
      // proxy: drawn for far / out-of-ring visible chunks, shadow-only for occluded ones
      const mode = real ? 'off' : occluded ? 'shadow' : 'draw';
      this.hlod.set(c.hlodId, mode);
      if (real) s.real++;
      else if (occluded) { s.occluded++; s.shadowOnly++; }
      else { s.hlod++; if (!inRing) s.ring++; }
      // then this block occludes what lies behind it
      // (inset by the 4 m frontage band the wall height was measured in: the wall is somewhere inside it)
      if (c.wall > eye.y + 0.5) this.addOccluder(eye, ox - LX + 4, ox + LX - 4, oz - LZ + 4, oz + LZ - 4, c.wall);
    }
  }

  /** azimuth span [a0, a1] (a1 ≥ a0, may exceed 2π) of a rectangle seen from the eye; null if the eye is inside */
  private span(eye: THREE.Vector3, x0: number, x1: number, z0: number, z1: number): [number, number] | null {
    if (eye.x > x0 && eye.x < x1 && eye.z > z0 && eye.z < z1) return null;
    const cxr = (x0 + x1) / 2, czr = (z0 + z1) / 2;
    const ac = Math.atan2(czr - eye.z, cxr - eye.x);
    let lo = 0, hi = 0;
    for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      let d = Math.atan2(z - eye.z, x - eye.x) - ac;
      d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    return [ac + lo, ac + hi];
  }

  private addOccluder(eye: THREE.Vector3, x0: number, x1: number, z0: number, z1: number, h: number) {
    const sp = this.span(eye, x0, x1, z0, z1);
    if (!sp) return;
    // per bin: the farthest entry point of rays across the bin (bin edges bound it for a convex
    // box seen from outside), so the wall-top elevation is never overestimated
    const entry = (th: number) => {
      const dx = Math.cos(th), dz = Math.sin(th);
      let t0 = 0, t1 = Infinity;
      for (const [o, d, lo, hi] of [[eye.x, dx, x0, x1], [eye.z, dz, z0, z1]]) {
        if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return Infinity; continue; }
        let a = (lo - o) / d, b = (hi - o) / d;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
      }
      return t0 <= t1 ? t0 : Infinity;
    };
    // only bins fully inside the span (shrink by one bin each side)
    const b0 = Math.ceil(((sp[0] + TAU * 4) / TAU) * BINS) + 1, b1 = Math.floor(((sp[1] + TAU * 4) / TAU) * BINS) - 1;
    let prev = entry((b0 / BINS) * TAU);
    for (let b = b0; b <= b1; b++) {
      const next = entry(((b + 1) / BINS) * TAU);
      const d = Math.max(prev, next);
      prev = next;
      if (!Number.isFinite(d)) continue;
      const e = Math.atan2(h - eye.y, Math.max(d, 0.01));
      const k = b % BINS;
      if (e > this.horizonE[k]) {
        this.horizonE[k] = e;
        this.horizonD[k] = Math.max(this.horizonD[k], d);
      }
    }
  }

  private hidden(eye: THREE.Vector3, x0: number, x1: number, z0: number, z1: number, top: number) {
    const sp = this.span(eye, x0, x1, z0, z1);
    if (!sp) return false;
    const dMin = rectDist(eye, x0, x1, z0, z1);
    if (dMin < 1) return false;
    const e = Math.atan2(top - eye.y, dMin);
    const b0 = Math.floor(((sp[0] + TAU * 4) / TAU) * BINS) - 1, b1 = Math.ceil(((sp[1] + TAU * 4) / TAU) * BINS) + 1;
    for (let b = b0; b <= b1; b++) {
      const k = b % BINS;
      if (!(this.horizonE[k] > e && this.horizonD[k] <= dMin)) return false;
    }
    return true;
  }
}
void binOf;

function rectDist(p: THREE.Vector3, x0: number, x1: number, z0: number, z1: number) {
  const dx = Math.max(x0 - p.x, 0, p.x - x1), dz = Math.max(z0 - p.z, 0, p.z - z1);
  return Math.hypot(dx, dz);
}
