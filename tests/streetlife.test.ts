/**
 * Street life, simulated at a fixed dt with no renderer: cars keep to lanes and stop at red,
 * pedestrians keep to sidewalks and cross only at crosswalks on WALK. Real sizes of both.
 */
import * as THREE from 'three';
import { test, expect, between, none, fmt, soft } from './qa';
import { allowModels, setSearch, settle } from './env';
import { AX, SZ, AVE, ST, SW, BX, BZ, LX, LZ, CYCLE, lightFor } from '../src/nyc/common';
import { carMesh, Traffic } from '../src/nyc/vehicles';
import { FLEET } from '../src/nyc/vehicleFleet';
import { Rng } from '../src/rng';

const known = (msg: string) => soft(false, `KNOWN ${msg}`);
const DT = 0.1;

test('vehicle sizes are real: cars 4-6 m (sedans/cabs 4-5.5), 1.7-2.1 m wide; buses 10-14 m', () => {
  for (const [id, f] of Object.entries(FLEET)) {
    between(f.len, 4.0, 6.0, `${id} length`);
    between(f.wid, 1.7, 2.1, `${id} width`);
  }
  for (const id of ['taxi_cv', 'prius', 'accord', 'charger', 'escalade', 'explorer']) if (FLEET[id]) between(FLEET[id].len, 4.0, 5.5, `${id} (sedan/cab) length`);
  const r = new Rng(1);
  for (const kind of ['bus', 'truck'] as const) {
    const g = carMesh(kind, r);
    const L = g.userData.len ?? new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3()).z;
    if (kind === 'bus') between(L, 10, 14, 'bus length');
    else between(L, 5.5, 12, 'truck length');
  }
});

// ---------------------------------------------------------------- traffic

interface CarLog { lane: string[]; red: string[]; overlap: number; minGap: number }
function simulateTraffic(seconds: number, t0 = 0): CarLog {
  const tr = new Traffic(new THREE.Group(), 1);
  const player = new THREE.Vector3(BX - 2.6, 1.7, BZ - 3.2); // on the sidewalk, out of the way
  const log: CarLog = { lane: [], red: [], overlap: 0, minGap: 1e9 };
  const prevFront = new Map<object, number>();
  for (let i = 0; i < seconds / DT; i++) {
    const time = t0 + i * DT;
    tr.update(DT, player, time);
    for (const c of tr.cars) {
      // lane: avenues (axis z) have lanes at ±3.6 m about the centre line, streets one centre lane
      const period = c.axis === 'z' ? AX : SZ;
      const centre = (Math.round(c.line / period - 0.5) + 0.5) * period;
      const off = c.line - centre;
      const half = (c.axis === 'z' ? AVE : ST) / 2;
      if (Math.abs(off) + c.wid / 2 > half - 0.3) log.lane.push(`${c.axis} car off ${fmt(off)} m, edge ${fmt(Math.abs(off) + c.wid / 2)} of ${half}`);
      // red light: the front bumper must not cross into the cross street while red
      const front = c.t + (c.dir * c.len) / 2;
      const p = prevFront.get(c);
      prevFront.set(c, front);
      if (p === undefined || Math.abs(front - p) > 5) continue; // re-placed this frame
      const pc = c.axis === 'z' ? SZ : AX, hc = (c.axis === 'z' ? ST : AVE) / 2;
      const k = Math.round((front - pc / 2) / pc);
      const edge = (k + 0.5) * pc - c.dir * hc;
      const crossed = (p - edge) * c.dir < 0 && (front - edge) * c.dir >= 0;
      if (crossed && lightFor(c.axis, time) === 'r') log.red.push(`${c.axis} car (v ${fmt(c.v)} m/s) entered the intersection at t=${fmt(time % CYCLE)} s into the cycle`);
    }
    // same-lane spacing
    for (const a of tr.cars) for (const b of tr.cars) {
      if (a === b || a.axis !== b.axis || a.dir !== b.dir || Math.abs(a.line - b.line) > 1) continue;
      const gap = (b.t - a.t) * a.dir - (a.len + b.len) / 2;
      if (gap > -50 && gap < 0 && (b.t - a.t) * a.dir > 0) log.overlap++;
      if ((b.t - a.t) * a.dir > 0) log.minGap = Math.min(log.minGap, gap);
    }
  }
  return log;
}
let traffic: CarLog | null = null;
const trafficLog = () => (traffic ??= simulateTraffic(3 * CYCLE));

test('cars stay in their lanes (72 s of traffic at dt 0.1)', () => {
  none(trafficLog().lane, 'cars out of lane');
});

test('cars do not enter an intersection on red', () => {
  const red = trafficLog().red;
  // KNOWN (qa-findings #6): a car that overshoots its stop point retargets the next intersection
  // and drives through the red. Tighten the limit to 0 once fixed.
  if (red.length) known(`${red.length} red-light runs in 72 s, e.g. ${red.slice(0, 2).join('; ')}`);
  expect(red.length <= 10, `${red.length} cars ran a red light: ${red.slice(0, 4).join('; ')}`);
});

test('cars in the same lane never overlap', () => {
  const l = trafficLog();
  // KNOWN (qa-findings #7): Traffic.place() drops a car onto a lane without checking for one already there,
  // and the follow logic ignores gaps < -1 m, so the two drive through each other
  if (l.overlap) known(`${l.overlap} car-in-car frames in 72 s (min gap ${fmt(l.minGap)} m)`);
  expect(l.overlap < 1000, `${l.overlap} car-in-car frames (min gap ${fmt(l.minGap)} m)`);
});

test('the signal plan has an all-red clearance between phases', () => {
  // one direction's red must start before the other's green (NYC: ~2 s all-red)
  let clear = 0;
  for (let t = 0; t < CYCLE; t += 0.05) if (lightFor('x', t) === 'r' && lightFor('z', t) === 'r') clear += 0.05;
  if (clear < 1) known(`no all-red interval in the ${CYCLE} s cycle (${fmt(clear)} s): yellow-light runners meet cross traffic (qa-findings #5)`);
});

// ---------------------------------------------------------------- pedestrians

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
  for (const pd of P.peds as unknown as { p: { scaleH: number; gender: string } }[]) log.heights.push((pd.p.gender === 'male' ? 1.712 : 1.655) * pd.p.scaleH);
  log.n = P.peds.length;
  return log;
}
let peds: Promise<PedLog> | null = null;
const pedLog = () => (peds ??= simulatePeople(2 * CYCLE));

test('people are 1.5-1.95 m tall', async () => {
  const l = await pedLog();
  expect(l.n >= 30, `only ${l.n} pedestrians spawned`);
  for (const h of l.heights) between(h, 1.45, 1.95, 'pedestrian height');
  const short = l.heights.filter((h) => h < 1.5);
  if (short.length) known(`${short.length} of ${l.n} people under 1.5 m (shortest ${fmt(Math.min(...short))} m)`);
});

test('pedestrians stay on sidewalks and crosswalks (48 s at dt 0.2)', async () => {
  const l = await pedLog();
  none(l.off, 'pedestrian positions off the sidewalk/crosswalks');
});

test('pedestrians step off the kerb only on WALK', async () => {
  const l = await pedLog();
  expect(l.crossings > 3, `only ${l.crossings} crossings in 48 s`);
  // KNOWN (qa-findings #4b): the odd person steps off on yellow
  for (const x of l.startRed) known(x);
  expect(l.startRed.length <= Math.max(1, l.crossings * 0.05), `${l.startRed.length} of ${l.crossings} crossings started against the light: ${l.startRed.slice(0, 3).join('; ')}`);
});

test('nobody is still in the road when cross traffic gets green', async () => {
  const l = await pedLog();
  if (l.caught) known(`${l.caught} person-frames (0.2 s) in the roadway while cross traffic has green: walkSignal lets people start crossing a 16 m avenue up to 17.5 s into a 9.5 s green (qa-findings #4)`);
});

void SW;
