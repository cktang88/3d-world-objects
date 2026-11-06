/**
 * Tiny test harness for `npm run qa` (no vitest: esbuild + node start in ~0.3 s).
 *
 *   import { test, expect, between } from './qa';
 *   test('doors are 2.0-2.4 m', () => { between(h, 2.0, 2.4, 'door'); });
 *
 * Tests in a file run in order once the file has been imported. Each logs PASS/FAIL with its
 * time; the runner (scripts/qa.mjs) aggregates. `soft()` records a finding without failing.
 */
import * as THREE from 'three';
import type { Rect } from '../src/level';

type Fn = () => void | Promise<void>;
const tests: { name: string; fn: Fn; only?: boolean }[] = [];
const filter = process.env.QA_TEST ? new RegExp(process.env.QA_TEST, 'i') : null;

export function test(name: string, fn: Fn) { tests.push({ name, fn }); }

export class QAError extends Error {}
export function fail(msg: string): never { throw new QAError(msg); }
export function expect(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }
export function between(v: number, lo: number, hi: number, what: string) {
  if (!(v >= lo && v <= hi)) fail(`${what}: ${fmt(v)} not in [${lo}, ${hi}]`);
}
export function near(v: number, want: number, tol: number, what: string) {
  if (!(Math.abs(v - want) <= tol)) fail(`${what}: ${fmt(v)} not within ${tol} of ${want}`);
}
/** fail with the first few offenders of a list */
export function none<T>(list: T[], what: string, show: (t: T) => string = String, max = 6) {
  if (list.length) fail(`${list.length} ${what}: ${list.slice(0, max).map(show).join('; ')}${list.length > max ? ' …' : ''}`);
}
const findings: string[] = [];
/** a known issue to report, not fail on (shows as NOTE) */
export function soft(cond: unknown, msg: string) { if (!cond) findings.push(msg); }
export const fmt = (v: number) => (Number.isFinite(v) ? +v.toFixed(3) : String(v));

// ------------------------------------------------------------ scene-graph helpers

export function worldBox(o: THREE.Object3D) { o.updateWorldMatrix(true, true); return new THREE.Box3().setFromObject(o); }
export function boxRect(b: THREE.Box3): Rect { return { minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z }; }
export function rectOverlap(a: Rect, b: Rect, pad = 0) {
  return Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) - pad) * Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) - pad) > 0;
}
export function insideRect(r: Rect, x: number, z: number, pad = 0) { return x > r.minX - pad && x < r.maxX + pad && z > r.minZ - pad && z < r.maxZ + pad; }

export interface Stats { meshes: number; instanced: number; instances: number; tris: number; materials: number; geometries: number; drawables: number }
/** counts from the scene graph (what renderer.info would see if everything were in view) */
export function stats(root: THREE.Object3D): Stats {
  const mats = new Set<string>(), geos = new Set<string>();
  const s: Stats = { meshes: 0, instanced: 0, instances: 0, tris: 0, materials: 0, geometries: 0, drawables: 0 };
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !o.visible) return;
    const g = m.geometry as THREE.BufferGeometry;
    const t = (g.index ? g.index.count : g.getAttribute('position')?.count ?? 0) / 3;
    const n = (m as unknown as THREE.InstancedMesh).isInstancedMesh ? (m as unknown as THREE.InstancedMesh).count : 1;
    s.meshes++; s.drawables++;
    if (n !== 1 || (m as unknown as THREE.InstancedMesh).isInstancedMesh) { s.instanced++; s.instances += n; }
    s.tris += t * n;
    geos.add(g.uuid);
    for (const mm of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mm.uuid);
  });
  s.materials = mats.size; s.geometries = geos.size;
  return s;
}

/** order-independent hash of a scene graph: names, positions (mm), geometry sizes */
export function sceneHash(root: THREE.Object3D) {
  root.updateWorldMatrix(true, true);
  let h = 2166136261 >>> 0;
  const mix = (s: string) => { for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; };
  const e = new THREE.Vector3();
  root.traverse((o) => {
    e.setFromMatrixPosition(o.matrixWorld);
    const m = o as THREE.Mesh;
    const n = m.isMesh ? (m.geometry.getAttribute('position')?.count ?? 0) : -1;
    mix(`${o.type}|${o.name}|${Math.round(e.x * 1000)}|${Math.round(e.y * 1000)}|${Math.round(e.z * 1000)}|${n};`);
  });
  return h.toString(16);
}

/**
 * Walkability grid over colliders: cells of `cell` metres inside `bounds`, blocked where a
 * collider (grown by `radius`, the player radius) covers the cell centre. flood() from a start
 * point returns a reach test.
 */
export class Grid {
  w: number; h: number; blocked: Uint8Array;
  constructor(public bounds: Rect, colliders: Rect[], public cell = 0.1, radius = 0.25) {
    this.w = Math.ceil((bounds.maxX - bounds.minX) / cell);
    this.h = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
    this.blocked = new Uint8Array(this.w * this.h);
    for (const c of colliders) {
      const x0 = Math.max(0, Math.floor((c.minX - radius - bounds.minX) / cell)), x1 = Math.min(this.w - 1, Math.ceil((c.maxX + radius - bounds.minX) / cell));
      const z0 = Math.max(0, Math.floor((c.minZ - radius - bounds.minZ) / cell)), z1 = Math.min(this.h - 1, Math.ceil((c.maxZ + radius - bounds.minZ) / cell));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const cx = bounds.minX + (x + 0.5) * cell, cz = bounds.minZ + (z + 0.5) * cell;
        if (cx > c.minX - radius && cx < c.maxX + radius && cz > c.minZ - radius && cz < c.maxZ + radius) this.blocked[z * this.w + x] = 1;
      }
    }
  }
  idx(x: number, z: number) {
    const i = Math.floor((x - this.bounds.minX) / this.cell), j = Math.floor((z - this.bounds.minZ) / this.cell);
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? -1 : j * this.w + i;
  }
  isBlocked(x: number, z: number) { const i = this.idx(x, z); return i < 0 || this.blocked[i] === 1; }
  flood(x: number, z: number) {
    const seen = new Uint8Array(this.w * this.h);
    const s = this.idx(x, z);
    if (s >= 0 && !this.blocked[s]) {
      const q = [s]; seen[s] = 1;
      while (q.length) {
        const i = q.pop()!, cx = i % this.w, cz = (i / this.w) | 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.h) continue;
          const j = nz * this.w + nx;
          if (!seen[j] && !this.blocked[j]) { seen[j] = 1; q.push(j); }
        }
      }
    }
    /** reachable: any free reached cell within `r` metres of (x, z) */
    return (px: number, pz: number, r = 0.4) => {
      const n = Math.ceil(r / this.cell);
      const ci = Math.floor((px - this.bounds.minX) / this.cell), cj = Math.floor((pz - this.bounds.minZ) / this.cell);
      for (let j = cj - n; j <= cj + n; j++) for (let i = ci - n; i <= ci + n; i++) {
        if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
        if (seen[j * this.w + i]) return true;
      }
      return false;
    };
  }
}

// ------------------------------------------------------------ run

const TIMEOUT = Number(process.env.QA_TEST_TIMEOUT ?? 20000);
const t0 = performance.now();
setTimeout(async () => {
  let pass = 0, failn = 0, skip = 0;
  for (const t of tests) {
    if (filter && !filter.test(t.name)) { skip++; continue; }
    const s = performance.now();
    try {
      // hard per-test limit (QA_TEST_TIMEOUT ms, default 20 s): nothing may hang
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([t.fn(), new Promise((_, rej) => (timer = setTimeout(() => rej(new QAError(`timed out after ${TIMEOUT} ms`)), TIMEOUT)))]);
      clearTimeout(timer);
      pass++;
      console.log(`  PASS ${t.name} (${Math.round(performance.now() - s)} ms)`);
    } catch (e) {
      failn++;
      const msg = e instanceof QAError ? e.message : (e as Error)?.stack ?? String(e);
      console.log(`  FAIL ${t.name} (${Math.round(performance.now() - s)} ms)\n       ${msg.split('\n').slice(0, 8).join('\n       ')}`);
    }
    for (const f of findings.splice(0)) console.log(`  NOTE ${t.name}: ${f}`);
  }
  console.log(`@@QA ${JSON.stringify({ pass, fail: failn, skip, ms: Math.round(performance.now() - t0) })}`);
  process.exit(failn ? 1 : 0);
}, 0);
