/** Memory qa (see tests/memlib.ts): lift floors and drawers. */
import * as THREE from 'three';
import { test, expect, soft } from './qa';
import { settle } from './env';
import { cycles, refsOf, leaksOf, collect } from './memlib';
import { memTrack } from '../src/dispose';
import type { Level, LevelDesc } from '../src/level';


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

