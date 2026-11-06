/**
 * Shared helpers of the memory qa tests (tests/memory*.test.ts).
 *
 * Memory: everything a lifecycle stops needing is freed (GPU resources disposed) and collectable
 * (JS objects garbage collected). Each scenario runs the real code path N cycles:
 *   city block build -> evict, museum room enter -> leave -> evict, shop enter -> exit,
 *   lift up 5 floors -> down, drawer open -> close -> evict the room.
 * After each cycle: live tracked geometries/materials/textures (src/dispose.ts memTrack: seen in the
 * scene graph and not yet disposed) must not grow, WeakRefs to the evicted roots must clear after
 * gc(), and heapUsed must not trend upward. Run with --expose-gc (scripts/qa.mjs passes it).
 */
import * as THREE from 'three';
import { expect } from './qa';
import { setSearch, settle } from './env';
import { enableMemTracker, memCounts, texturesOf, type MemCounts } from '../src/dispose';

setSearch('r=0&people=0&cars=0');
// streamed models are blocked in Node: keep their failures out of the log
for (const k of ['warn', 'info'] as const) { const f = console[k].bind(console); console[k] = (...a: unknown[]) => { if (!/library model failed|\[seamless\]|remote fetch blocked/.test(String(a[0]))) f(...a); }; }
enableMemTracker();
const gc = (globalThis as { gc?: () => void }).gc;

export async function collect() {
  // let pending promises/timeouts settle, then collect (twice: finalisation can free more)
  await settle(20);
  gc?.(); await settle(5); gc?.();
}
const heapMB = () => process.memoryUsage().heapUsed / 1048576;
const fmtC = (c: MemCounts) => `${c.geometry}g/${c.material}m/${c.texture}t`;

/** WeakRefs to an evicted root and a sample of its resources */
export function refsOf(root: THREE.Object3D, extra: object[] = []) {
  const out: WeakRef<object>[] = [new WeakRef(root), ...extra.map((o) => new WeakRef(o))];
  let n = 0;
  root.traverse((c) => {
    if (n++ % 25) return;
    out.push(new WeakRef(c));
    const g = (c as THREE.Mesh).geometry;
    if (g && c.userData.owned) out.push(new WeakRef(g)); // shared geometry lives on in its cache
  });
  return out;
}

/** resources under root (for naming what leaked) */
export function resourcesOf(root: THREE.Object3D) {
  const s = new Map<object, string>();
  const where = (o: THREE.Object3D) => { const p: string[] = []; for (let q: THREE.Object3D | null = o; q && p.length < 4; q = q.parent) p.push(q.name || q.type); return p.join('<'); };
  root.traverse((c) => {
    const g = (c as THREE.Mesh).geometry;
    if (g) s.set(g, `geometry ${g.type} @${where(c)}`);
    const ms = (c as THREE.Mesh).material;
    for (const m of ms ? [ms].flat() : []) {
      const col = (m as THREE.MeshBasicMaterial).color?.getHexString();
      const gb = g ? (g.computeBoundingBox(), g.boundingBox!.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(2)).join('x')) : '';
      s.set(m, `material ${m.type} ${m.name} #${col} map=${!!(m as THREE.MeshBasicMaterial).map} tr=${m.transparent} on ${g?.type} ${gb} "${c.name}" @${where(c)}`);
      for (const t of texturesOf(m)) s.set(t, `texture ${t.constructor.name} ${t.name} ${(t.image as { width?: number })?.width}x${(t.image as { height?: number })?.height} @${where(c)}`);
    }
  });
  return s;
}

interface Cycle { counts: MemCounts; heap: number; alive: number; refs: number; stale: number }
/**
 * Run `cycle` n times. It returns the WeakRefs that must be collectable once it is over.
 * Baseline: after the first cycle (session caches warm up there). Asserts no growth after it.
 */
export async function cycles(name: string, n: number, cycle: (i: number) => Promise<WeakRef<object>[]> | WeakRef<object>[], tol = { res: 2, heapMB: 6 }) {
  const rows: Cycle[] = [];
  let prev: WeakRef<object>[] = [];
  let shownPath = false;
  const every: WeakRef<object>[] = [];
  for (let i = 0; i < n; i++) {
    const refs = await cycle(i);
    await collect();
    const alive = refs.filter((r) => r.deref()).length;
    // an async load still finishing can hold an evicted room for a moment; one cycle later it must be gone
    const stale = prev.filter((r) => r.deref()).length;
    prev = refs;
    every.push(...refs);
    if (process.env.QA_LEAKPATH && i >= 1 && alive && !shownPath) {
      shownPath = true;
      // why: retainer paths of the first few survivors (tests/heap.ts)
      const { tagLeak, retainers } = await import('./heap');
      for (const r of refs.filter((x) => x.deref()).slice(0, 3)) tagLeak(r.deref()!);
      for (const p of retainers(3)) console.log(`   ${name} retained by: ${p}`);
    }
    rows.push({ counts: memCounts(), heap: heapMB(), alive, refs: refs.length, stale });
  }
  // baseline: the first two cycles (session caches warm up there; scenarios alternate two places)
  const total = (c: MemCounts) => c.geometry + c.material + c.texture;
  const tot = rows.map((r) => total(r.counts));
  console.log(`   ${name}: live after each cycle ${rows.map((r) => fmtC(r.counts)).join(' ')}`);
  console.log(`   ${name}: heap MB ${rows.map((r) => r.heap.toFixed(1)).join(' ')}; evicted refs still alive ${rows.map((r) => `${r.alive}/${r.refs}`).join(' ')}`);
  const base = Math.max(tot[0], tot[1]), end = Math.max(...tot.slice(-2));
  const last = rows[rows.length - 1].counts;
  const owners = Object.entries(last.byOwner).map(([k, v]) => `${k}:${v.geometry}g/${v.material}m/${v.texture}t`).join(' ');
  expect(end - base <= tol.res, `${name}: ${end - base} more live GPU resources after ${n} cycles than after the first two (${tot.join(' ')}; ${owners})`);
  // everything evicted is collectable once in-flight loads are over (an evicted shop waits for its
  // queued model parses: seamless keeps the load queue running while it evicts in the background)
  await settle(300); await collect();
  const survivors = every.filter((r) => r.deref()).length;
  console.log(`   ${name}: of ${every.length} sampled evicted objects ${survivors} survive the end; late by a cycle in ${rows.filter((r) => r.stale).length} of ${n} cycles`);
  expect(survivors === 0, `${name}: ${survivors} evicted objects are never collected`);
  const late = rows.filter((r) => r.stale).length;
  expect(late <= n / 3, `${name}: evicted objects outlive the next cycle in ${late} of ${n} cycles`);
  // heap: median of the last three vs the second cycle (gc noise allowed)
  const tail = rows.slice(-3).map((r) => r.heap).sort((a, c) => a - c)[1];
  expect(tail - rows[1].heap <= tol.heapMB, `${name}: heap grows ${rows[1].heap.toFixed(1)} -> ${tail.toFixed(1)} MB over ${n} cycles`);
  return rows;
}

const seenEver = new WeakSet<object>();
/** names of resources first seen this cycle that were not disposed by `evict` */
export function leaksOf(root: THREE.Object3D, evict: () => void) {
  const res = resourcesOf(root);
  const disposed = new Set<object>();
  const hooks: [THREE.EventDispatcher<object>, () => void][] = [];
  for (const r of res.keys()) {
    const f = () => disposed.add(r);
    (r as THREE.EventDispatcher<{ dispose: object }>).addEventListener('dispose', f);
    hooks.push([r as THREE.EventDispatcher<object>, f]);
  }
  evict();
  for (const [r, f] of hooks) (r as THREE.EventDispatcher<{ dispose: object }>).removeEventListener('dispose', f);
  const out = new Map<string, number>();
  for (const [r, d] of res) if (!disposed.has(r) && !seenEver.has(r)) out.set(d, (out.get(d) ?? 0) + 1);
  for (const r of res.keys()) seenEver.add(r);
  return out;
}

