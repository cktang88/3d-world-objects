/** Vehicles, simulated at a fixed dt with no renderer: real sizes, lanes, red lights, spacing, signal plan. */
import * as THREE from 'three';
import { test, expect, between, none, fmt, soft } from './qa';
import './env';
import { AX, SZ, AVE, ST, BX, BZ, CYCLE, lightFor } from '../src/nyc/common';
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
  none(red, 'red-light runs');
});

test('cars in the same lane never overlap', () => {
  const l = trafficLog();
  expect(l.overlap === 0, `${l.overlap} car-in-car frames (min gap ${fmt(l.minGap)} m)`);
});

test('the signal plan has an all-red clearance between phases', () => {
  // one direction's red must start before the other's green (NYC: ~2 s all-red)
  let clear = 0;
  for (let t = 0; t < CYCLE; t += 0.05) if (lightFor('x', t) === 'r' && lightFor('z', t) === 'r') clear += 0.05;
  expect(clear >= 1.5, `only ${fmt(clear)} s of all-red in the ${CYCLE} s cycle`);
});

