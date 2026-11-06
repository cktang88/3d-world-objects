/** Memory qa (see tests/memlib.ts): shops, museum rooms, caches, lighting hooks, aborted loads. City blocks: memory-city.test.ts; lift floors and drawers: memory-rooms.test.ts. */
import * as THREE from 'three';
import { test, expect, soft } from './qa';
import { settle } from './env';
import { cycles, refsOf, leaksOf, collect } from './memlib';
import { memTrack } from '../src/dispose';
import type { Level, LevelDesc } from '../src/level';

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
  // remote fetches (scanned products, originals) hang like a slow network: the evicted shop must
  // still be collected at once (ShopLevel.loads aborts them)
  const gf = globalThis as { fetch: typeof fetch };
  const realFetch = gf.fetch;
  gf.fetch = ((u: RequestInfo | URL, o?: RequestInit) => (/^https?:\/\/(?!localhost)/.test(String(u)) ? new Promise<Response>(() => {}) : realFetch(u, o))) as typeof fetch;
  try {
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
    const leaks = leaksOf(lv.group, () => { seam.setActive(other); seam.clear(); });
    if (i >= 2 && leaks.size) first = leaks;
    // (no wait: its in-flight stock loads are aborted with it, ShopLevel.loads)
    lazy.update(0, cam, other.level); // main.ts runs it every frame: forgets evicted shops' containers
    return refs;
  }, undefined as never, { strict: true });
  } finally {
    gf.fetch = realFetch;
  }
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

// ---------------------------------------------------------------- model caches (remote.ts rebuilt GLBs)

test('memory: a model cache frees only models with no live copy, oldest first, beyond its cap', async () => {
  const { CopyTracker } = await import('../src/dispose');
  const t = new CopyTracker();
  const keep: THREE.Object3D[] = [];
  ((): void => {
    for (let i = 0; i < 6; i++) {
      const copy = new THREE.Group();
      t.add(`m${i}`, copy);
      if (i % 2 === 0) keep.push(copy); // m0, m2, m4 stay in a live scene; the others are dropped
    }
  })();
  keep[1].userData.disposed = true; // m2's room was disposed
  await collect();
  const keys = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'];
  const ex = t.excess(keys, 2);
  // unused: m1, m3, m5 (collected) and m2 (disposed): oldest beyond 2 are m1 and m2
  expect(JSON.stringify(ex) === JSON.stringify(['m1', 'm2']), `freed ${ex.join(' ')}`);
  expect(!ex.includes('m0') && !ex.includes('m4'), 'a model with a live copy was freed');
});

// ---------------------------------------------------------------- lighting's scene hooks (lighting.ts [perf] add queue)

test('memory: lighting keeps no evicted objects (add queue idle without a rig; weak material registries)', async () => {
  const { pendingAddCount } = await import('../src/lighting');
  const { WeakList } = await import('../src/dispose');
  // Object3D.add is patched by lighting.ts: with no rig draining it, nothing may be queued (held)
  const g = new THREE.Group();
  for (let i = 0; i < 100; i++) g.add(new THREE.Mesh());
  expect(pendingAddCount() === 0, `${pendingAddCount()} added objects queued with no lighting rig to drain them`);
  // its material registries (csmMats, emissives) are WeakLists: a dropped level's materials are collected
  const list = new WeakList<THREE.Material>();
  const kept = new THREE.MeshStandardMaterial();
  list.add(kept);
  const refs = ((): WeakRef<object>[] => {
    const out: WeakRef<object>[] = [];
    for (let i = 0; i < 50; i++) { const m = new THREE.MeshStandardMaterial(); list.add(m); out.push(new WeakRef(m)); }
    return out;
  })();
  await collect();
  const alive = refs.filter((r) => r.deref()).length;
  expect(alive === 0, `${alive} of 50 dropped materials kept alive by a WeakList`);
  expect(list.size === 1 && [...list][0] === kept, `WeakList holds ${list.size} live members`);
});

// ---------------------------------------------------------------- loads that outlive their level (AbortSignal)

test('memory: a disposed level is collected at once even while its originals / library loads are pending', async () => {
  const { loadOriginal } = await import('../src/detail');
  const { loadLibraryModel } = await import('../src/libraries');
  // remote fetches hang (a slow network) instead of failing fast as the shim makes them
  const g = globalThis as { fetch: typeof fetch };
  const real = g.fetch;
  g.fetch = ((u: RequestInfo | URL, i?: RequestInit) => (/^https?:\/\/(?!localhost)/.test(String(u)) ? new Promise<Response>(() => {}) : real(u, i))) as typeof fetch;
  try {
    const run = (withSignal: boolean) => {
      // an owner (a stand-in for a ShopLevel) whose continuations hold it, as shop.ts' do
      const owner = { group: new THREE.Group(), big: new Float64Array(1 << 16), got: 0 };
      const ac = new AbortController();
      const signal = withSignal ? ac.signal : undefined;
      const lib = { source: 'polyhaven', id: `qa_hang_${withSignal}`, url: `https://api.polyhaven.com/files/qa_hang_${withSignal}`, title: 'qa', category: 'qa', tags: [], licence: 'CC0' };
      loadOriginal(`objaverse-qa${withSignal}`, 1, new THREE.Vector3(1, 1, 1), { signal }).then((o) => { if (o) owner.got++; });
      loadLibraryModel(lib as never, { quality: 'low', signal }).then(() => owner.got++, () => owner.got--);
      const ref = new WeakRef(owner);
      ac.abort(); // the level is disposed
      return ref;
    };
    const kept = run(false), freed = run(true);
    await collect();
    expect(!freed.deref(), 'an aborted owner is still held by its pending loads');
    // control: without a signal the pending loads do hold it (so the test sees the leak it guards against)
    expect(!!kept.deref(), 'control: pending loads without a signal did not hold their owner (the test is not measuring)');
  } finally {
    g.fetch = real;
  }
});
