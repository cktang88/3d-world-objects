/**
 * People and traffic together (no renderer): 60 s of the spawn block at a fixed dt, the way NycLevel drives
 * them (traffic first, then pedestrians given the cars' boxes). Nobody may ever stand inside a car.
 */
import * as THREE from 'three';
import { test, expect, fmt } from './qa';
import { allowModels, setSearch, settle } from './env';
import { BX, BZ } from '../src/nyc/common';

async function simulate(seconds: number, seed = 1, people = 60) {
  allowModels(/assets\/people\//);
  setSearch(`people=${people}&pfar=0`);
  const { Pedestrians, loadPeopleAssets } = await import('../src/nyc/people');
  const { Traffic } = await import('../src/nyc/vehicles');
  await loadPeopleAssets();
  const tr = new Traffic(new THREE.Group(), seed);
  const P = new Pedestrians(new THREE.Group(), seed);
  await settle(0);
  const player = new THREE.Vector3(BX - 2.6, 1.7, BZ - 3.2);
  const D = 0.1;
  const hits: string[] = [];
  let frames = 0;
  const kinds = new Map<string, number>();
  for (let i = 0; i < seconds / D; i++) {
    const time = i * D;
    // QA_WALK: the player walks along the sidewalk (people and cars re-place around a moving player)
    if (process.env.QA_WALK) player.x += 1.6 * D;
    // wired as NycLevel does: cars yield to people in the road, people wait for cars
    tr.people = P.inRoad();
    tr.update(D, player, time);
    P.cars = tr.rects();
    P.update(D, player, time, []);
    let hit = false;
    for (const pd of P.peds as unknown as { pos: THREE.Vector3; state: string; axis: string }[]) {
      for (const c of tr.cars) {
        const r = c.rect;
        // a person (0.25 m radius) inside the car's footprint, shrunk 10 cm (mirrors, rounding)
        const dx = Math.max(r.minX - pd.pos.x, 0, pd.pos.x - r.maxX), dz = Math.max(r.minZ - pd.pos.z, 0, pd.pos.z - r.maxZ);
        if (Math.hypot(dx, dz) < 0.35 && process.env.QA_NEAR) {
          const k = `NEAR ${pd.state} along ${pd.axis} vs ${c.v > 0.3 ? 'moving' : 'stopped'} ${(c as unknown as { parked?: boolean }).parked ? 'parked ' : ''}${(c as unknown as { kind: string }).kind} ${c.axis}`;
          kinds.set(k, (kinds.get(k) ?? 0) + 1);
          if (hits.length < 8 && !hit) hits.push(`t=${fmt(time)} ${k} at ${fmt(pd.pos.x)},${fmt(pd.pos.z)} car ${fmt(r.minX)}..${fmt(r.maxX)}, ${fmt(r.minZ)}..${fmt(r.maxZ)}`);
        }
        if (pd.pos.x > r.minX + 0.1 && pd.pos.x < r.maxX - 0.1 && pd.pos.z > r.minZ + 0.1 && pd.pos.z < r.maxZ - 0.1) {
          hit = true;
          const k = `${pd.state} vs ${c.v > 0.3 ? 'moving' : 'stopped'} ${c.axis} car`;
          kinds.set(k, (kinds.get(k) ?? 0) + 1);
          if (hits.length < 6) hits.push(`t=${fmt(time)} person (${pd.state}, along ${pd.axis}) at ${fmt(pd.pos.x)},${fmt(pd.pos.z)} inside a ${k}`);
        }
      }
    }
    if (hit) frames++;
  }
  return { frames, hits, kinds, people: P.peds.length, cars: tr.cars.length };
}

test('nobody is ever inside a car (60 s of the spawn block, people and traffic together)', async () => {
  const seeds = (process.env.QA_SEEDS ?? '1').split(',').map(Number);
  const all = await Promise.all(seeds.map((s) => simulate(Number(process.env.QA_SECS ?? 60), s, Number(process.env.QA_PEOPLE ?? 60))));
  const r = { frames: all.reduce((n, x) => n + x.frames, 0), hits: all.flatMap((x) => x.hits), kinds: new Map(all.flatMap((x) => [...x.kinds])), people: all[0].people, cars: all[0].cars };
  console.log(`   ${r.people} people, ${r.cars} cars; frames with a person inside a car: ${r.frames} ${JSON.stringify(Object.fromEntries(r.kinds))}`);
  expect(r.frames === 0, `${r.frames} frames with a person inside a car:\n${r.hits.join('\n')}`);
});
