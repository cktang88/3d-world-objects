/** Vertical circulation (src/rooms/vertical.ts): stair dimensions, walking up and down between floors with the real colliders and ground, roof, reachable doors, lifts, determinism, budgets. */
import * as THREE from 'three';
import { test, expect, soft } from './qa';
import './env';
import { FloorLevel, SPECS, dims, type BType } from '../src/rooms/vertical';
import type { Rect } from '../src/level';

let notes: string[] = [];
const check = (c: boolean, msg: string) => {
  expect(c, msg);
  notes.push(msg);
};
void soft;

// a copy of Player's motion (collision + ground), at a fixed dt, steering towards waypoints
function walk(get: () => FloorLevel, switchTo: (dir: number) => FloorLevel | null, start: THREE.Vector3, path: [number, number][], maxT = 60) {
  const pos = start.clone();
  const vel = new THREE.Vector3();
  let onGround = true;
  const R = 0.32, dt = 1 / 60;
  let wp = 0, t = 0;
  const trace: { f: number; y: number }[] = [];
  let maxStep = 0;
  while (wp < path.length && t < maxT) {
    const lv = get();
    const [tx, tz] = path[wp];
    const dx = tx - pos.x, dz = tz - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.15) { wp++; continue; }
    vel.x = (dx / d) * 3; vel.z = (dz / d) * 3;
    vel.y -= 14 * dt;
    pos.x += vel.x * dt; pos.z += vel.z * dt;
    for (let it = 0; it < 2; it++) for (const c of lv.colliders() as Rect[]) {
      const nx = Math.max(c.minX, Math.min(pos.x, c.maxX)), nz = Math.max(c.minZ, Math.min(pos.z, c.maxZ));
      const ex = pos.x - nx, ez = pos.z - nz, d2 = ex * ex + ez * ez;
      if (d2 >= R * R) continue;
      if (d2 > 1e-8) { const dd = Math.sqrt(d2); pos.x = nx + (ex / dd) * R; pos.z = nz + (ez / dd) * R; }
    }
    const y0 = pos.y;
    pos.y += vel.y * dt;
    const g = lv.ground(pos.x, pos.z, pos.y);
    if (pos.y <= g || (onGround && vel.y <= 0 && pos.y - g < 0.4)) { pos.y = g; vel.y = 0; onGround = true; } else if (pos.y - g >= 0.4) onGround = false;
    maxStep = Math.max(maxStep, Math.abs(pos.y - y0));
    const H = lv.d.H;
    const dir = pos.y > 0.55 * H ? 1 : pos.y < -0.55 * H ? -1 : 0;
    if (dir) {
      const n = switchTo(dir);
      if (n) pos.y -= dir * H;
    }
    trace.push({ f: get().floor, y: pos.y });
    t += dt;
  }
  return { done: wp >= path.length, pos, t, trace, maxStep };
}


for (const type of Object.keys(SPECS) as BType[]) {
  test(`vertical ${type}: real stair dims, walk up/down/roof, doors reachable, determinism, budget`, () => {
    notes = [];

  const s = SPECS[type], d = dims(s);
  check(d.rise >= 0.165 && d.rise <= 0.195, `${type}: rise ${d.rise.toFixed(3)} m`);
  check(d.run >= 0.235 && d.run <= 0.3, `${type}: run ${d.run} m, 2R+G ${(2 * d.rise + d.run).toFixed(3)}`);
  check(d.fw >= 0.9, `${type}: flight width ${d.fw}`);
  const floors = type === 'office' ? 8 : 6;
  const t0 = performance.now();
  const lv: Record<number, FloorLevel> = {};
  const mk = (f: number) => (lv[f] ??= new FloorLevel({ kind: 'floor', seed: 99, name: 'Test', type, floor: f, floors }));
  for (const f of [0, 1, floors - 1, floors]) mk(f);
  check(true, `${type}: built 4 floors in ${(performance.now() - t0).toFixed(0)} ms`);
  {
    // time slices of a staged build (seamless.ts runs them in a 4 ms per-frame budget)
    const st = new FloorLevel({ kind: 'floor', seed: 7, name: 'Slices', type, floor: 3, floors }, { staged: true });
    while (st.staging && !st.staging.next().done);
    const mx = Math.max(...st.slices);
    check(mx < 60, `${type}: staged build in ${st.slices.length} slices, longest ${mx} ms (${st.slices.join(' ')})`);
  }
  // determinism
  const a = new FloorLevel({ kind: 'floor', seed: 99, name: 'Test', type, floor: 2, floors });
  const b = new FloorLevel({ kind: 'floor', seed: 99, name: 'Test', type, floor: 2, floors });
  check(JSON.stringify(a.colliders()) === JSON.stringify(b.colliders()) && a.units.join() === b.units.join(), `${type}: deterministic (units ${a.units.join(' ')})`);
  check(lv[1].units.length >= 2, `${type}: ${lv[1].units.length} units on floor 2`);
  // walk from the lobby spawn to the stair and up two floors, then down again
  let cur = 0;
  const sw = (dir: number) => { const n = cur + dir; if (n < 0 || n > floors) return null; cur = n; return mk(n); };
  const ax = (d.ax0 + d.ax1) / 2, bx = (d.bx0 + d.bx1) / 2, zm = -d.Lf - d.Md / 2;
  const lap: [number, number][] = [[ax, 0.6], [ax, -0.2], [ax, zm], [bx, zm], [bx, -0.2], [bx, 0.6], [ax, 0.6]];
  const spawn = lv[0].spawn.pos.clone();
  const up = walk(() => mk(cur), sw, spawn, [[0, d.Ld + 0.8], [ax, 0.6], ...lap.slice(1), ...lap.slice(1)]);
  check(up.done && cur === 2 && Math.abs(up.pos.y) < 0.05, `${type}: walked from the street door up two floors (now floor ${cur + 1}, y ${up.pos.y.toFixed(2)}, ${up.t.toFixed(1)} s, max dy/frame ${up.maxStep.toFixed(3)})`);
  // continuity: no jumps of y besides the H switches
  let jumps = 0;
  for (let i = 1; i < up.trace.length; i++) if (up.trace[i].f === up.trace[i - 1].f && Math.abs(up.trace[i].y - up.trace[i - 1].y) > 0.2) jumps++;
  check(jumps === 0, `${type}: no height jumps on the stair`);
  // down again: the lap reversed
  const rev: [number, number][] = [[bx, 0.6], [bx, -0.2], [bx, zm], [ax, zm], [ax, -0.2], [ax, 0.6]];
  const down = walk(() => mk(cur), sw, up.pos, [...rev, ...rev, [0, d.Ld + 1.0]]);
  check(down.done && cur === 0 && Math.abs(down.pos.y) < 0.05, `${type}: walked back down to the lobby (floor ${cur}, y ${down.pos.y.toFixed(2)})`);
  // lobby: no way down
  cur = 0;
  const cellar = walk(() => mk(cur), sw, new THREE.Vector3(bx, 0, 0.6), [[bx, -0.2], [bx, zm]], 6);
  check(!cellar.done && cur === 0 && cellar.pos.y > -0.1, `${type}: lobby has no flight down (stopped at z ${cellar.pos.z.toFixed(2)}, y ${cellar.pos.y.toFixed(2)})`);
  // top floor up to the roof and out of the bulkhead door
  cur = floors - 1;
  const roof = walk(() => mk(cur), sw, new THREE.Vector3(0, 0, d.Ld + 0.6), [...lap, [d.SW / 2 - 0.55, 0.6], [d.SW / 2 - 0.55, d.Ld + 2]]);
  check(roof.done && cur === floors && Math.abs(roof.pos.y) < 0.05, `${type}: up to the roof and out onto it (floor ${cur}, at z ${roof.pos.z.toFixed(2)})`);
  // roof: no flight further up
  const upr = walk(() => mk(cur), sw, new THREE.Vector3(ax, 0, 0.6), [[ax, -0.2], [ax, zm]], 6);
  check(!upr.done && cur === floors && upr.pos.y < 0.1, `${type}: no flight up from the roof`);
  // every unit door portal is reachable: stand at its return position
  const f1 = mk(1);
  const targets = f1.portals().filter((p) => typeof p.target === 'object');
  let reach = 0;
  for (const p of targets) {
    cur = 1;
    const rp = p.returnPos!;
    const r = walk(() => mk(cur), sw, new THREE.Vector3(0, 0, d.Ld + 0.5), [[0, rp.z], [rp.x, rp.z]], 12);
    if (r.done && cur === 1) reach++;
  }
  check(reach === targets.length, `${type}: ${reach}/${targets.length} doors on floor 2 reachable`);
  // lift fronts
  check(lv[1].lifts.length === s.lifts.length, `${type}: ${lv[1].lifts.length} lifts`);
  let tris = 0, meshes = 0;
  lv[1].group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    const n = (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
    tris += n * ((o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1);
  });
  check(meshes < 150, `${type}: floor 2 has ${meshes} meshes, ${(tris / 1000).toFixed(0)}k triangles (all storeys of stair included)`);

    console.log('   ' + notes.join('\n   '));
  });
}
