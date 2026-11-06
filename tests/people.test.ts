/**
 * Pedestrians (src/nyc/people.ts), simulated at a fixed dt with no renderer: they keep off
 * street furniture, ease up/down the kerb, are deterministic per seed, dress for the weather,
 * and the merged-mesh / far-crowd budgets hold. Sidewalk, crosswalk and WALK rules are in
 * crossing.test.ts (and vehicles in vehicles.test.ts).
 */
import * as THREE from 'three';
import { test, expect, none, fmt, between } from './qa';
import { allowModels, setSearch, settle } from './env';
import { BX, BZ, CURB, AX, SZ } from '../src/nyc/common';
import type { Rect } from '../src/level';

type PedView = { p: { root: THREE.Group; umbrellaOn: boolean; weatherSpeed: number; meshes: THREE.Mesh[]; hood: boolean }; pos: THREE.Vector3; state: string; lead?: unknown; axis: 'x' | 'z' };
const DT = 0.1;
const player = new THREE.Vector3(BX - 2.6, 1.7, BZ - 3.2);

/** tree pits / newsstands on the sidewalks around the player's block, as level colliders */
function furniture(): Rect[] {
  const out: Rect[] = [];
  for (let cx = -1; cx <= 1; cx++)
    for (let cz = -1; cz <= 1; cz++)
      for (const s of [-1, 1]) {
        for (let z = -BZ + 4; z < BZ - 4; z += 7) {
          const x = cx * AX + s * (BX - 0.9);
          out.push({ minX: x - 0.55, maxX: x + 0.55, minZ: cz * SZ + z - 0.55, maxZ: cz * SZ + z + 0.55 });
        }
        for (let x = -BX + 5; x < BX - 5; x += 9) {
          const z = cz * SZ + s * (BZ - 0.9);
          out.push({ minX: cx * AX + x - 0.55, maxX: cx * AX + x + 0.55, minZ: z - 0.55, maxZ: z + 0.55 });
        }
      }
  return out;
}

async function load() {
  allowModels(/assets\/people\//);
  setSearch('people=30&pfar=0');
  const m = await import('../src/nyc/people');
  await m.loadPeopleAssets();
  return m;
}

async function run(seed: number, seconds: number, cols: Rect[], each?: (peds: PedView[], time: number) => void) {
  const { Pedestrians } = await load();
  const P = new Pedestrians(new THREE.Group(), seed);
  await settle(0);
  for (let i = 0; i < seconds / DT; i++) {
    P.update(DT, player, i * DT, cols);
    each?.(P.peds as unknown as PedView[], i * DT);
  }
  return P;
}

test('pedestrians keep out of street furniture (60 s, tree pits every 7-9 m)', async () => {
  const cols = furniture();
  const hits: string[] = [];
  let checked = 0;
  await run(3, 60, cols, (peds, time) => {
    if (time < 3) return; // allow the spawn frames to settle
    for (const pd of peds) {
      if (pd.lead) continue; // companions are placed beside their leader
      checked++;
      for (const r of cols) if (pd.pos.x > r.minX + 0.1 && pd.pos.x < r.maxX - 0.1 && pd.pos.z > r.minZ + 0.1 && pd.pos.z < r.maxZ - 0.1) hits.push(`t=${fmt(time)} (${fmt(pd.pos.x)}, ${fmt(pd.pos.z)}) inside a tree pit`);
    }
  });
  expect(checked > 1000, `only ${checked} person-frames checked`);
  // a person can be pushed into a pit for a moment by the player / oncoming people: allow 0.5 %
  expect(hits.length <= checked * 0.005, `${hits.length} of ${checked} person-frames inside furniture: ${hits.slice(0, 3).join('; ')}`);
});

test('feet ease down the kerb (no 15 cm snaps between 0.1 s frames)', async () => {
  const last = new Map<object, number>();
  const jumps: string[] = [];
  let between_ = 0;
  await run(5, 50, [], (peds) => {
    for (const pd of peds) {
      const y = pd.pos.y;
      if (y > 0.005 && y < CURB - 0.005) between_++;
      const prev = last.get(pd);
      if (prev !== undefined && Math.abs(y - prev) > 0.11 && pd.state === 'walk') jumps.push(`${fmt(prev)} -> ${fmt(y)}`);
      last.set(pd, y);
    }
  });
  none(jumps, 'kerb snaps');
  expect(between_ > 0, 'nobody was ever part-way down a kerb (no crossings?)');
});

test('the same seed gives the same crowd (positions after 20 s)', async () => {
  const hash = (P: { peds: unknown[] }) =>
    (P.peds as PedView[]).map((pd) => `${pd.pos.x.toFixed(3)},${pd.pos.z.toFixed(3)}`).join('|');
  const a = hash(await run(7, 20, []));
  const b = hash(await run(7, 20, []));
  expect(a === b, 'two runs with seed 7 diverged');
  const c = hash(await run(8, 20, []));
  expect(a !== c, 'seeds 7 and 8 gave the same crowd');
});

test('rain: most people with a free hand open an umbrella and walk faster; snow slows them', async () => {
  const m = await load();
  const P = await run(9, 2, []);
  m.setPeopleWeather({ rain: 1, snow: 0 });
  P.update(DT, player, 2, []);
  const peds = P.peds as unknown as PedView[];
  const share = peds.filter((pd) => pd.p.umbrellaOn).length / peds.length;
  between(share, 0.35, 0.8, 'share of people with umbrellas in rain');
  expect(peds.every((pd) => pd.p.weatherSpeed > 1), 'rain should hurry everyone');
  m.setPeopleWeather({ rain: 0, snow: 1 });
  P.update(DT, player, 2.1, []);
  expect(peds.every((pd) => !pd.p.umbrellaOn && pd.p.weatherSpeed < 1), 'snow: no umbrellas, slower');
  m.setPeopleWeather({ rain: 0, snow: 0 });
});

test('a near person is at most 8 drawables (merged props; a dog on a leash not counted)', async () => {
  const P = await run(11, 1, []);
  const bad: string[] = [];
  for (const pd of P.peds as unknown as PedView[]) {
    let n = 0;
    pd.p.root.traverse((o) => {
      const m = o as THREE.Mesh;
      let dog = false;
      for (let q: THREE.Object3D | null = o; q; q = q.parent) if (q.name === 'dog') dog = true;
      if (m.isMesh && m.visible && !/Body_LOD/.test(m.name) && !dog) n++;
    });
    if (n > 8) bad.push(`${n} drawables`);
  }
  none(bad, 'people over the draw-call budget');
});

test('on a real NYC block: nobody walks into stoops, shopfronts, trees or kiosks (60 s)', async () => {
  const { nycChunk } = await import('./world');
  const cols = nycChunk(1, 0, 0).colliders; // block 0 sits at the origin: block-local = world
  const hits: string[] = [];
  let checked = 0;
  await run(4, 60, cols, (peds, time) => {
    if (time < 3) return;
    for (const pd of peds) {
      if (pd.lead || Math.abs(pd.pos.x) > BX || Math.abs(pd.pos.z) > BZ) continue;
      checked++;
      for (const r of cols)
        if (pd.pos.x > r.minX + 0.12 && pd.pos.x < r.maxX - 0.12 && pd.pos.z > r.minZ + 0.12 && pd.pos.z < r.maxZ - 0.12) {
          hits.push(`t=${fmt(time)} (${fmt(pd.pos.x)}, ${fmt(pd.pos.z)}) in a ${fmt(r.maxX - r.minX)}x${fmt(r.maxZ - r.minZ)} m collider`);
          break;
        }
    }
  });
  expect(checked > 300, `only ${checked} person-frames on block 0`);
  expect(hits.length <= checked * 0.005, `${hits.length} of ${checked} person-frames inside colliders: ${hits.slice(0, 4).join('; ')}`);
});

test('nobody spawns within 6 m of the player at load', async () => {
  const P = await run(13, 0.5, []);
  const near = (P.peds as unknown as PedView[]).filter((pd) => !pd.lead && Math.hypot(pd.pos.x - player.x, pd.pos.z - player.z) < 5.5);
  none(near.map((pd) => `(${fmt(pd.pos.x)}, ${fmt(pd.pos.z)})`), 'people spawned next to the player');
});

test("the first view is populated: people on the player's sidewalk 8-82 m along it", async () => {
  const P = await run(17, 3, []);
  const all = P.peds as unknown as PedView[];
  const own = all.filter((pd) => Math.abs(pd.pos.x - (BX - 2)) < 3 && Math.abs(pd.pos.z - player.z) > 8 && Math.abs(pd.pos.z - player.z) < 82);
  expect(own.length >= all.length * 0.3, `only ${own.length} people on the spawn sidewalk 8-82 m away (of ${all.length})`);
});
