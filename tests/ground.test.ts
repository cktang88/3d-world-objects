/** NYC ground (src/nyc/ground.ts): curb, flags, ADA ramps, paint dimensions, props off the ramps, draw calls. */
import * as THREE from 'three';
import { test, expect, between, none, soft, fmt } from './qa';
import { nycChunk } from './world';
import { BX, BZ, AX, SZ, SW, CURB } from '../src/nyc/common';
import { GROUND, markingsPlan, curbPositions, GM } from '../src/nyc/ground';
import { districtAt } from '../src/nyc/districts';

const G = GROUND;
const BLOCKS: [number, number][] = [[0, 0], [1, 0], [0, 1], [-1, -1]].filter(([x, z]) => !districtAt(x, z).open) as [number, number][];

test('curb: 6-7 in reveal, drops to a lip at the ramps', () => {
  between(CURB, 0.15, 0.18, 'curb height (m)');
  between(G.CW, 0.15, 0.2, 'curb top width (m)');
  const p = curbPositions();
  let hi = -1, lo = 9;
  for (let i = 0; i < p.count; i++) { hi = Math.max(hi, p.getY(i)); if (Math.abs(p.getX(i)) > BX - 0.3 || Math.abs(p.getZ(i)) > BZ - 0.3) if (p.getY(i) > 0.005) lo = Math.min(lo, p.getY(i)); }
  between(hi, CURB - 0.001, CURB + 0.01, 'curb top (m)');
  between(lo, 0.0, 0.03, 'curb lip at the ramps (m)');
});

test('sidewalk flags are 5 ft and fit the sidewalk', () => {
  between(G.FLAG, 1.45, 1.6, 'flag size (m)');
  const n = SW / G.FLAG;
  expect(Math.abs(n - Math.round(n)) < 1e-6, `sidewalk ${SW} m is not a whole number of ${G.FLAG} m flags`);
});

test('ADA ramps: 1:12 run, 4 ft clear, lined up with the crosswalks', () => {
  const slope = (CURB - G.RLIP) / (G.RL - G.CW);
  expect(slope <= 1 / 12 + 1e-6, `ramp running slope 1:${fmt(1 / slope)} steeper than 1:12`);
  between(G.RW, 1.22, 2.5, 'ramp clear width (m)');
  between(G.RLIP, 0, 0.025, 'ramp lip above the road (m)');
  // the ramp (and its flares at the kerb) sit on the straight kerb, inside the crosswalk band
  expect(G.RO - G.RW / 2 - G.RF >= G.CR - 0.05, 'ramp flare runs into the corner radius');
  expect(G.RO - G.RW / 2 >= G.XW_OUT && G.RO + G.RW / 2 <= G.XW_IN, `ramp ${fmt(G.RO - G.RW / 2)}..${fmt(G.RO + G.RW / 2)} m not within the crosswalk ${G.XW_OUT}..${G.XW_IN} m`);
  // ADA flares are 1:10 parallel to the kerb; ours are steeper to keep corners compact
  const flare = (CURB - G.RLIP) / G.RF;
  soft(flare <= 0.1, `KNOWN: ramp side flares 1:${fmt(1 / flare)} (ADA 1:10) to fit the 1 m corner radius`);
});

test('markings: real dimensions, never on the sidewalk', () => {
  const bad: string[] = [];
  for (const [cx, cz] of BLOCKS) {
    const m = markingsPlan(cx, cz);
    const xwAve = m.filter((r) => r.kind === 'solid' && Math.abs(r.x1 - r.x0 - 0.6) < 1e-3 && Math.abs(r.z1 - r.z0) > 2);
    const xwSt = m.filter((r) => r.kind === 'solid' && Math.abs(r.z1 - r.z0 - 0.6) < 1e-3 && Math.abs(r.x1 - r.x0) > 2);
    expect(xwAve.length >= 20 && xwSt.length >= 12, `chunk ${cx},${cz}: ${xwAve.length} avenue / ${xwSt.length} street crosswalk bars`);
    for (const r of [...xwAve, ...xwSt]) between(Math.max(r.x1 - r.x0, r.z1 - r.z0), 3.0, 4.6, 'crosswalk length (m)');
    // gaps between bars 0.6 m (bars on a 1.2 m pitch)
    const xs = [...new Set(xwAve.filter((r) => r.x0 > 0 && r.z0 > 0).map((r) => +r.x0.toFixed(3)))].sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) between(xs[i] - xs[i - 1], 1.15, 1.25, 'crosswalk bar pitch (m)');
    const stops = m.filter((r) => r.kind === 'solid' && Math.min(r.x1 - r.x0, r.z1 - r.z0) > 0.2 && Math.min(r.x1 - r.x0, r.z1 - r.z0) < 0.59);
    expect(stops.length >= 2, `chunk ${cx},${cz}: ${stops.length} stop bars`);
    for (const r of stops) between(Math.min(r.x1 - r.x0, r.z1 - r.z0), 0.3, 0.61, 'stop bar width (m)');
    const lines = m.filter((r) => r.kind === 'solid' && Math.min(r.x1 - r.x0, r.z1 - r.z0) < 0.2);
    expect(lines.length > 4, `chunk ${cx},${cz}: ${lines.length} lane-line dashes`);
    for (const r of lines) {
      between(Math.min(r.x1 - r.x0, r.z1 - r.z0), 0.1, 0.15, 'lane line width (m)');
      expect(Math.max(r.x1 - r.x0, r.z1 - r.z0) <= 3.0 + 1e-6, 'lane dash longer than 10 ft');
    }
    for (const r of m) {
      const inSw = r.x1 > -BX + 0.01 && r.x0 < BX - 0.01 && r.z1 > -BZ + 0.01 && r.z0 < BZ - 0.01;
      const outChunk = r.x0 < -AX / 2 - 0.5 || r.x1 > AX / 2 + 0.5 || r.z0 < -SZ / 2 - 0.5 || r.z1 > SZ / 2 + 0.5;
      if (inSw || outChunk) bad.push(`${cx},${cz} ${r.kind} ${fmt(r.x0)}..${fmt(r.x1)} x ${fmt(r.z0)}..${fmt(r.z1)}`);
    }
  }
  none(bad, 'paint on the sidewalk or outside the chunk');
});

test('street audit: worn mid-grey asphalt, wet rain, 6 in lane lines, red bus lanes on the Midtown bus avenues', async () => {
  const { ROAD_ALB, WET_DARK, LANE_W, busAve, BUS_AVENUES } = await import('../src/nyc/ground');
  const { avenueName } = await import('../src/nyc/common');
  // dry asphalt photographs at roughly 85-115 sRGB (it was ~80: near black under the grade)
  const srgb = new THREE.Color(ROAD_ALB, ROAD_ALB, ROAD_ALB).getStyle().match(/\d+/)![0];
  between(+srgb, 85, 115, 'dry road base (sRGB)');
  // wet asphalt is roughly half as bright as dry
  between(WET_DARK, 0.45, 0.6, 'rain darkening of the ground');
  between(LANE_W, 0.1, 0.152, 'lane line width (m)');
  // 5 Av past the spawn has its offset bus lane and BUS / ONLY legends
  expect(avenueName(0) === '5 Av' && busAve(0), `avenue 0 is ${avenueName(0)}, bus lane ${busAve(0)}`);
  const m = markingsPlan(0, 0);
  expect(m.some((r) => r.kind === 'BUS') && m.some((r) => r.kind === 'ONLY'), 'no BUS ONLY legend on the spawn block');
  const named = [...BUS_AVENUES];
  for (let k = -8; k < 8; k++) if (named.includes(avenueName(k))) expect(busAve(k), `${avenueName(k)} has no bus lane`);
});

test('no street furniture on the corner ramps', () => {
  const bad: string[] = [];
  for (const [cx, cz] of BLOCKS) {
    for (const r of nycChunk(1, cx, cz).colliders) {
      const w = r.maxX - r.minX, d = r.maxZ - r.minZ;
      if (Math.max(w, d) > 3.5) continue;
      const x = (r.minX + r.maxX) / 2, z = (r.minZ + r.maxZ) / 2;
      const dx = BX - Math.abs(x), dz = BZ - Math.abs(z);
      // the ramp surface proper (between the flares), with the object's half size
      const onAve = dx - w / 2 < G.RL && dx > -0.1 && Math.abs(dz - G.RO) < G.RW / 2 + d / 2;
      const onSt = dz - d / 2 < G.RL && dz > -0.1 && Math.abs(dx - G.RO) < G.RW / 2 + w / 2;
      if (onAve || onSt) bad.push(`${cx},${cz}: ${fmt(w)}x${fmt(d)} at (${fmt(x)}, ${fmt(z)})`);
    }
  }
  none(bad, 'colliders on a kerb ramp');
});

test('ground is at most 3 draw calls per block', () => {
  const mats = new Set<THREE.Material>([GM.road(), GM.cobbleRoad(), GM.sidewalk(), GM.fixtures()]);
  for (const [cx, cz] of BLOCKS) {
    let n = 0;
    nycChunk(1, cx, cz).group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && mats.has(m.material as THREE.Material)) n++;
    });
    expect(n >= 2 && n <= 3, `chunk ${cx},${cz}: ${n} ground draw calls (want 2-3: road, sidewalk+curb, paint+hardware)`);
  }
});
