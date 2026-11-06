/** Pedestrians at crossings, simulated at a fixed dt with no renderer: heights, sidewalks/crosswalks only, stepping off on WALK, nobody in the road when cross traffic gets green. */
import * as THREE from 'three';
import { test, expect, between, none, fmt } from './qa';
import { allowModels, setSearch, settle } from './env';
import { AX, SZ, BX, BZ, LX, LZ, CYCLE, lightFor } from '../src/nyc/common';


interface PedLog { off: string[]; startRed: string[]; caught: number; crossings: number; heights: number[]; n: number }
async function simulatePeople(seconds: number): Promise<PedLog> {
  allowModels(/assets\/people\//);
  setSearch('people=36&pfar=0');
  const { Pedestrians, loadPeopleAssets } = await import('../src/nyc/people');
  await loadPeopleAssets();
  const P = new Pedestrians(new THREE.Group(), 1);
  await settle(0);
  const player = new THREE.Vector3(BX - 2.6, 1.7, BZ - 3.2);
  const log: PedLog = { off: [], startRed: [], caught: 0, crossings: 0, heights: [], n: 0 };
  const wasIn = new Map<object, boolean>();
  const D = 0.2;
  for (let i = 0; i < seconds / D; i++) {
    const time = i * D;
    P.update(D, player, time, []);
    for (const pd of P.peds as unknown as { axis: 'x' | 'z'; pos: THREE.Vector3; state: string; lead?: unknown }[]) {
      const lx = pd.pos.x - Math.round(pd.pos.x / AX) * AX, lz = pd.pos.z - Math.round(pd.pos.z / SZ) * SZ;
      const ax = Math.abs(lx), az = Math.abs(lz);
      const onWalk = ax <= BX + 0.05 && az <= BZ + 0.05 && (ax >= LX - 0.05 || az >= LZ - 0.05);
      // crosswalks: in the roadway, but in line with a sidewalk
      const crossAve = ax > BX && az >= LZ - 0.3 && az <= BZ + 0.3;
      const crossSt = az > BZ && ax >= LX - 0.3 && ax <= BX + 0.3;
      if (!onWalk && !crossAve && !crossSt) log.off.push(`(${fmt(lx)}, ${fmt(lz)}) in-block, walking along ${pd.axis}`);
      if (pd.lead) continue;
      // in the road on the road it crosses: walking along x crosses avenues
      const inRoad = pd.axis === 'x' ? ax > BX : az > BZ;
      const before = wasIn.get(pd);
      wasIn.set(pd, inRoad);
      if (before === false && inRoad) {
        log.crossings++;
        if (lightFor(pd.axis, time) !== 'g') log.startRed.push(`stepped off the kerb along ${pd.axis} at t=${fmt(time % CYCLE)} (light ${lightFor(pd.axis, time)})`);
      }
      // the cross traffic has green while someone is still in the road
      if (inRoad && lightFor(pd.axis === 'x' ? 'z' : 'x', time) === 'g') log.caught++;
    }
  }
  // the stature as drawn (the body's box with shoes and hair; base-mesh height constants under-read short people)
  for (const pd of P.peds as unknown as { p: { root: THREE.Object3D } }[]) {
    pd.p.root.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(pd.p.root);
    log.heights.push(b.max.y - b.min.y);
  }
  log.n = P.peds.length;
  return log;
}
let peds: Promise<PedLog> | null = null;
const pedLog = () => (peds ??= simulatePeople(2 * CYCLE));

test('people are 1.5-1.95 m tall', async () => {
  const l = await pedLog();
  expect(l.n >= 30, `only ${l.n} pedestrians spawned`);
  for (const h of l.heights) between(h, 1.5, 1.95, 'pedestrian height');
});

test('pedestrians stay on sidewalks and crosswalks (48 s at dt 0.2)', async () => {
  const l = await pedLog();
  none(l.off, 'pedestrian positions off the sidewalk/crosswalks');
});

test('pedestrians step off the kerb only on WALK', async () => {
  const l = await pedLog();
  expect(l.crossings > 3, `only ${l.crossings} crossings in 48 s`);
  none(l.startRed, `of ${l.crossings} crossings started against the light`);
});

test('nobody is still in the road when cross traffic gets green', async () => {
  const l = await pedLog();
  expect(l.caught === 0, `${l.caught} person-frames (0.2 s) in the roadway while cross traffic has green`);
});

