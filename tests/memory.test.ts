/**
 * Memory: everything a lifecycle stops needing is freed (GPU resources disposed) and collectable
 * (JS objects garbage collected). Each scenario runs the real code path N cycles:
 *   city block build -> evict, museum room enter -> leave -> evict, shop enter -> exit,
 *   lift up 5 floors -> down, drawer open -> close -> evict the room.
 * After each cycle: live tracked geometries/materials/textures (src/dispose.ts memTrack: seen in the
 * scene graph and not yet disposed) must not grow, WeakRefs to the evicted roots must clear after
 * gc(), and heapUsed must not trend upward. Run with --expose-gc (scripts/qa.mjs passes it).
 */
import * as THREE from 'three';
import { test, expect, soft } from './qa';
import { setSearch, settle } from './env';
import { enableMemTracker, memTrack, memCounts, texturesOf, type MemCounts } from '../src/dispose';
import type { Level, LevelDesc } from '../src/level';

setSearch('r=0&people=0&cars=0');
// streamed models are blocked in Node: keep their failures out of the log
for (const k of ['warn', 'info'] as const) { const f = console[k].bind(console); console[k] = (...a: unknown[]) => { if (!/library model failed|\[seamless\]|remote fetch blocked/.test(String(a[0]))) f(...a); }; }
enableMemTracker();
const gc = (globalThis as { gc?: () => void }).gc;

async function collect() {
  // let pending promises/timeouts settle, then collect (twice: finalisation can free more)
  await settle(20);
  gc?.(); await settle(5); gc?.();
}
const heapMB = () => process.memoryUsage().heapUsed / 1048576;
const fmtC = (c: MemCounts) => `${c.geometry}g/${c.material}m/${c.texture}t`;

/** WeakRefs to an evicted root and a sample of its resources */
function refsOf(root: THREE.Object3D, extra: object[] = []) {
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
function resourcesOf(root: THREE.Object3D) {
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
async function cycles(name: string, n: number, cycle: (i: number) => Promise<WeakRef<object>[]> | WeakRef<object>[], tol = { res: 2, heapMB: 6 }) {
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
function leaksOf(root: THREE.Object3D, evict: () => void) {
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

// ---------------------------------------------------------------- city blocks

test('memory: city block build -> evict 10x (NycLevel streaming) frees its GPU resources and is collected', async () => {
  const { NycLevel } = await import('../src/nyc');
  const lv = new NycLevel({ kind: 'nyc', seed: 1, name: 'qa' });
  const p = new THREE.Vector3();
  const AX = 120;
  // walk two blocks east and back: each leg builds a block and unloads the one left behind
  const walk = (to: number) => {
    const from = p.x;
    for (let k = 1; k <= 30; k++) {
      p.x = from + ((to - from) * k) / 30;
      for (let f = 0; f < 3; f++) lv.update(1 / 30, p, 0);
    }
    for (let f = 0; f < 60 && lv.streaming; f++) lv.update(1 / 30, p, 0);
    for (let f = 0; f < 4; f++) lv.update(1 / 30, p, 0); // unloads (one per frame)
  };
  memTrack(lv.group, 'nyc');
  await cycles('city', 10, async (i) => {
    const before = new Set(lv.group.children);
    walk(i % 2 ? 0 : 3 * AX);
    memTrack(lv.group, 'nyc');
    // the chunks that were unloaded on this leg
    const gone = [...before].filter((c) => c.parent !== lv.group && c.type === 'Group');
    return gone.flatMap((g) => refsOf(g));
  });
  lv.dispose();
});

// ---------------------------------------------------------------- shops

test('memory: shop enter -> exit 10x through the seamless cache frees the shop', async () => {
  const { ShopLevel } = await import('../src/shop');
  const { Seamless } = await import('../src/seamless');
  const seam = new Seamless({
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), capacity: 1,
    renderer: { compileAsync: () => Promise.resolve(), toneMappingExposure: 1 } as unknown as THREE.WebGLRenderer,
    build: (d) => new ShopLevel(d as Extract<LevelDesc, { kind: 'interior' }>, { staged: false }),
  });
  const desc = (seed: number): LevelDesc => ({ kind: 'interior', seed, name: `QA shop ${seed}`, style: 'store', floor: 0, floors: 1, biome: 'metropolis', shop: ['grocery', 'hardware', 'books'][seed % 3] } as LevelDesc);
  let first: Map<string, number> | null = null;
  const { Lazy } = await import('../src/lazy');
  const lazy = new Lazy(), cam = new THREE.PerspectiveCamera();
  await cycles('shop', 10, async (i) => {
    const s = seam.take(desc(1 + (i % 2)));
    seam.setActive(s);
    const lv = s.level;
    for (let f = 0; f < 10; f++) { lv.update(1 / 30, lv.spawn.pos, f / 30); lazy.update(1 / 30, cam, lv); }
    await settle(5);
    memTrack(lv.group, 'shop');
    const refs = refsOf(lv.group, [lv]);
    // exit: the street becomes active, the shop is evicted (capacity 1 and a fresh one next time)
    const other = seam.take(desc(100 + i));
    const leaks = leaksOf(lv.group, () => seam.setActive(other));
    if (i === 1) first = leaks;
    seam.clear();
    lazy.update(0, cam, other.level); // main.ts runs it every frame: forgets evicted shops' containers
    return refs;
  });
  if (first && (first as Map<string, number>).size) console.log(`   shop: not disposed (shared/pinned or leak): ${JSON.stringify([...(first as Map<string, number>)].slice(0, 8))}`);
});

// ---------------------------------------------------------------- museum

test('memory: museum room enter -> leave -> evict 10x', async () => {
  const { loadMuseum, museum } = await import('../src/museumData');
  const { GalleryLevel } = await import('../src/museum');
  await loadMuseum();
  const themes = museum().themes.filter((t) => t.size > 4 && t.size < 30).slice(0, 2).map((t) => t.id);
  await cycles('museum', 10, async (i) => {
    const g: Level = new GalleryLevel({ kind: 'gallery', theme: themes[i % themes.length], page: 0 });
    for (let f = 0; f < 10; f++) g.update(1 / 30, g.spawn.pos, f / 30);
    await settle(5);
    memTrack(g.group, 'museum');
    const refs = refsOf(g.group, [g]);
    const leaks = leaksOf(g.group, () => g.dispose());
    if (i >= 2 && leaks.size) console.log(`   museum: not disposed (shared/pinned or leak): ${JSON.stringify([...leaks].slice(0, 8))}`);
    return refs;
  });
});

// ---------------------------------------------------------------- lift floors

test('memory: lift up 5 floors -> down (lazily built floors) keeps memory bounded', async () => {
  const { Seamless, descKey } = await import('../src/seamless');
  const { FloorLevel } = await import('../src/rooms/vertical');
  const seam = new Seamless({
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), capacity: 3,
    renderer: { compileAsync: () => Promise.resolve(), toneMappingExposure: 1 } as unknown as THREE.WebGLRenderer,
    build: (d, staged) => new FloorLevel(d as never, { staged }),
  });
  const fd = (floor: number): LevelDesc => ({ kind: 'floor', seed: 31337, name: 'QA lift', type: 'prewar', floor, floors: 9 } as LevelDesc);
  const evicted: Level[] = [];
  const orig = (seam as unknown as { drop(s: { level: Level }): void }).drop.bind(seam);
  const liftLeaks = new Map<string, number>();
  const allLift = new Map<any, string>();
  let cyc = 0;
  (seam as unknown as { drop(s: { level: Level }): void }).drop = (s) => {
    evicted.push(s.level);
    const l = leaksOf(s.level.group, () => orig(s));
    if (cyc >= 1) for (const [k, v] of l) liftLeaks.set(k, (liftLeaks.get(k) ?? 0) + v);
  };
  await cycles('lift', 6, async () => {
    for (const f of [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0]) {
      const s = seam.take(fd(f));
      seam.setActive(s, [descKey(fd(0))]);
      for (let k = 0; k < 4; k++) { s.level.update(1 / 30, s.level.spawn.pos, k / 30); seam.update(1 / 30, s.level, s.level.spawn.pos); }
      memTrack(s.level.group, 'floor');
      for (const [r, d] of resourcesOf(s.level.group)) if (!allLift.has(r)) { allLift.set(r, d); r.addEventListener?.('dispose', () => allLift.delete(r)); }
    }
    const refs = evicted.flatMap((l) => refsOf(l.group, [l]));
    evicted.length = 0;
    if (cyc === 3) {
    const live = new Set<object>();
    for (const sl of seam.slots.values()) for (const r of resourcesOf(sl.level.group).keys()) live.add(r);
    const orphan = new Map<string, number>();
    for (const [r, d] of allLift) if (!live.has(r)) orphan.set(d, (orphan.get(d) ?? 0) + 1);
    console.log(`   lift: undisposed and in no cached floor: ${JSON.stringify([...orphan].sort((a, b) => b[1] - a[1]).slice(0, 8))}`);
    }
    cyc++;
    return refs;
  });
  if (liftLeaks.size) console.log(`   lift: new and not disposed: ${JSON.stringify([...liftLeaks].slice(0, 10))}`);
  expect(seam.slots.size <= 5, `the floor cache stays bounded (${seam.slots.size})`);
});

// ---------------------------------------------------------------- drawers

test('memory: drawer open -> close -> evict room 10x', async () => {
  const { InteriorLevel } = await import('../src/interior');
  const { Lazy } = await import('../src/lazy');
  const lazy = new Lazy();
  const cam = new THREE.PerspectiveCamera();
  let opened = 0;
  await cycles('drawers', 10, async (i) => {
    const lv = new InteriorLevel({ kind: 'interior', seed: 7 + (i % 2), name: 'QA apt', style: 'apartment', floor: 0, floors: 1, biome: 'town' } as Extract<LevelDesc, { kind: 'interior' }>);
    lv.group.updateMatrixWorld(true);
    lazy.update(0, cam, lv);
    // open every container, let the contents generate, close them
    const reg = (lv as unknown as { containers: { obj: THREE.Object3D }[] }).containers;
    const { LazyContainer } = await import('../src/lazy');
    void LazyContainer;
    const all: import('../src/lazy').LazyContainer[] = [];
    for (const c of reg) {
      cam.position.copy(c.obj.getWorldPosition(new THREE.Vector3())).add(new THREE.Vector3(0, 1.2, 0.8));
      cam.lookAt(c.obj.getWorldPosition(new THREE.Vector3()));
      cam.updateMatrixWorld(true);
      const hit = lazy.aim(new THREE.Ray(cam.position.clone(), cam.getWorldDirection(new THREE.Vector3())), 3, lv);
      if (hit && !all.includes(hit.c)) all.push(hit.c);
    }
    for (const c of all) lazy.toggle(c);
    for (let f = 0; f < 60; f++) lazy.update(1 / 30, cam, lv);
    await settle(5);
    opened += all.filter((c) => c.contents).length;
    memTrack(lv.group, 'drawers');
    for (const c of all) lazy.toggle(c);
    for (let f = 0; f < 30; f++) lazy.update(1 / 30, cam, lv);
    const refs = refsOf(lv.group, [lv, ...all.map((c) => c.contents).filter((x): x is THREE.Object3D => !!x)]);
    const leaks = leaksOf(lv.group, () => lv.dispose());
    if (i >= 2 && leaks.size) console.log(`   drawers: not disposed (shared/pinned or leak): ${JSON.stringify([...leaks].slice(0, 8))}`);
    lazy.update(0, cam, lv); // forgets the disposed level's containers
    return refs;
  });
  soft(opened > 0, 'KNOWN no container contents generated in Node (models do not load)');
  console.log(`   drawers: ${opened} containers opened with contents over the cycles`);
});
