/** Memory qa (see tests/memlib.ts): shops, museum rooms, lift floors, drawers. City blocks: memory-city.test.ts. */
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
    await settle(60); // its queued model parses finish (they hold the shop until then)
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
  (seam as unknown as { drop(s: { level: Level }): void }).drop = (s) => { evicted.push(s.level); orig(s); };
  await cycles('lift', 6, async () => {
    for (const f of [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0]) {
      const s = seam.take(fd(f));
      seam.setActive(s, [descKey(fd(0))]);
      for (let k = 0; k < 4; k++) { s.level.update(1 / 30, s.level.spawn.pos, k / 30); seam.update(1 / 30, s.level, s.level.spawn.pos); }
      memTrack(s.level.group, 'floor');
    }
    const refs = evicted.flatMap((l) => refsOf(l.group, [l]));
    evicted.length = 0;
    return refs;
  });
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
