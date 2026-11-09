/** Apartment / house / office interiors: real scale, reachability, nothing blocking doors, containers, stairs, budgets. */
import * as THREE from 'three';
import { test, expect, between, none, stats, sceneHash, insideRect, rectOverlap, Grid, fmt, soft } from './qa';
import './env';
import { InteriorLevel } from '../src/interior';
import * as F from '../src/rooms/furniture';
import type { Rect } from '../src/level';

type Desc = ConstructorParameters<typeof InteriorLevel>[0];
const desc = (style: string, seed: number, floor = 0, floors = 3): Desc => ({ kind: 'interior', seed, name: `qa ${style}`, style, floor, floors, biome: 'town' });
const CASES = [desc('house', 3), desc('apartment', 5), desc('office', 7), desc('apartment', 11, 1)];
const built = new Map<Desc, InteriorLevel>();
const level = (d: Desc) => {
  let lv = built.get(d);
  if (!lv) built.set(d, (lv = new InteriorLevel(d)));
  return lv;
};
const tag = (d: Desc) => `${d.style}#${d.seed}/${d.floor}`;
const H = (lv: InteriorLevel) => (lv as unknown as { H: number }).H;
const outer = (lv: InteriorLevel): Rect => lv.rooms.reduce((a, r) => ({ minX: Math.min(a.minX, r.x0), minZ: Math.min(a.minZ, r.z0), maxX: Math.max(a.maxX, r.x1), maxZ: Math.max(a.maxZ, r.z1) }), { minX: 1e9, minZ: 1e9, maxX: -1e9, maxZ: -1e9 });

test('tight living rooms keep seating instead of falling back to barrels and warehouse crates', () => {
  const lv = new InteriorLevel(desc('apartment', 42));
  const room = lv.rooms.find((r) => r.type === 'living');
  expect(room, 'reproduction contains a living room');
  expect(lv.placed.some((p) => p.room === room && p.w >= 0.82 && p.d >= 0.84), 'living room contains a seat');
  for (const cell of lv.cells.filter((c) => c.room === room)) {
    const warehouse = cell.group.children.filter((o) => o.position.y < 0.05 && ['storage', 'container', 'machine'].includes(o.userData.entry?.role));
    expect(warehouse.length === 0, 'no warehouse furnishings in the living room');
  }
  lv.dispose();
});

test('doors are real size: 2.0-2.4 m tall, 0.8-1.2 m wide', () => {
  for (const d of CASES) {
    const lv = level(d);
    between(lv.entry.height, 2.0, 2.4, `${tag(d)} entry door height`);
    between(lv.entry.width, 0.8, 1.2, `${tag(d)} entry door width`);
    for (const c of lv.cells) for (const dr of c.doors) {
      between(dr.height, 2.0, 2.4, `${tag(d)} ${c.room.type} door height`);
      between(dr.width, 0.8, 1.2, `${tag(d)} ${c.room.type} door width`);
    }
  }
});

test('ceilings 2.4-3.8 m; rooms at least 1.5 m wide', () => {
  for (const d of CASES) {
    const lv = level(d);
    between(H(lv), 2.4, 3.8, `${tag(d)} ceiling height`);
    for (const r of lv.rooms) expect(Math.min(r.x1 - r.x0, r.z1 - r.z0) >= 1.5, `${tag(d)} ${r.type} only ${fmt(Math.min(r.x1 - r.x0, r.z1 - r.z0))} m wide`);
  }
});

test('stairs: rise 15-20 cm, run 25-30 cm (per ceiling height in use)', () => {
  // record the treads F.stair lays out (it is called with the level's ceiling height as the rise)
  const heights = new Set(CASES.map((d) => H(level(d))));
  const bad: string[] = [];
  for (const h of heights) {
    const treads: { x: number; w: number; y: number }[] = [];
    const rec = { box: (_m: unknown, w: number, hh: number, _d: number, x: number, y: number) => { if (Math.abs(hh - 0.03) < 1e-6) treads.push({ x, w, y }); }, boxM() {}, sphere() {} };
    // placeStairs sizes the flight to the storey: round(H / 0.185) treads of 27 cm
    const len = Math.round(h / 0.185) * 0.27;
    F.stair(rec as unknown as Parameters<typeof F.stair>[0], len, 1.05, h, null!, null!, null!);
    const rise = treads[1].y - treads[0].y, run = treads[1].x - treads[0].x;
    if (!(rise >= 0.15 && rise <= 0.2)) bad.push(`H=${h}: rise ${fmt(rise)} m`);
    if (!(run >= 0.25 && run <= 0.3)) bad.push(`H=${h}: run ${fmt(run)} m (${treads.length} steps in ${fmt(len)} m)`);
  }
  none(bad, 'stairs out of code');
});

test('spawn is free and every portal is reachable from it (flood fill over colliders)', () => {
  const bad: string[] = [];
  for (const d of CASES) {
    const lv = level(d);
    const cols = lv.colliders();
    const p = lv.spawn.pos;
    const inside = cols.filter((r) => insideRect(r, p.x, p.z, 0.25));
    if (inside.length) bad.push(`${tag(d)}: spawn (${fmt(p.x)}, ${fmt(p.z)}) inside ${inside.length} colliders`);
    const grid = new Grid(outer(lv), cols, 0.1, 0.25);
    const reach = grid.flood(p.x, p.z);
    for (const pt of lv.portals()) {
      const c = pt.box.getCenter(new THREE.Vector3());
      // doors and stairs: walk into the box; objects and paintings: stand within arm's reach (1.5 m)
      const walk = pt.target === 'back' || (typeof pt.target === 'object' && pt.target.kind === 'interior');
      const r = Math.min(pt.box.max.x - pt.box.min.x, pt.box.max.z - pt.box.min.z) / 2 + (walk ? 0.2 : 1.5);
      if (!reach(c.x, c.z, r)) bad.push(`${tag(d)}: "${pt.label}" at (${fmt(c.x)}, ${fmt(c.z)})`);
    }
  }
  none(bad, 'unreachable');
});

test('every room is reachable from the entry', () => {
  const bad: string[] = [];
  for (const d of CASES) {
    const lv = level(d);
    const reach = new Grid(outer(lv), lv.colliders(), 0.1, 0.25).flood(lv.spawn.pos.x, lv.spawn.pos.z);
    for (const c of lv.cells) for (const dr of c.doors) {
      // a point just inside this room in front of each of its doors
      const cx = (c.bounds.minX + c.bounds.maxX) / 2, cz = (c.bounds.minZ + c.bounds.maxZ) / 2;
      const ix = dr.axis === 'x' ? dr.x + Math.sign(cx - dr.x) * 0.5 : dr.x, iz = dr.axis === 'z' ? dr.z + Math.sign(cz - dr.z) * 0.5 : dr.z;
      if (!reach(ix, iz, 0.35)) bad.push(`${tag(d)} ${c.room.type}: door at (${fmt(dr.x)}, ${fmt(dr.z)})`);
    }
  }
  none(bad, 'rooms cut off');
});

test('nothing stands in a doorway (0.8 m wide, 0.6 m each side)', () => {
  const bad: string[] = [];
  for (const d of CASES) {
    const lv = level(d);
    for (const c of lv.cells) for (const dr of c.doors) {
      const zone: Rect = dr.axis === 'x' ? { minX: dr.x - 0.6, maxX: dr.x + 0.6, minZ: dr.z - 0.4, maxZ: dr.z + 0.4 } : { minX: dr.x - 0.4, maxX: dr.x + 0.4, minZ: dr.z - 0.6, maxZ: dr.z + 0.6 };
      for (const r of lv.colliders()) if (rectOverlap(zone, r)) bad.push(`${tag(d)} ${c.room.type} door (${fmt(dr.x)}, ${fmt(dr.z)}): ${fmt(r.maxX - r.minX)}x${fmt(r.maxZ - r.minZ)} at (${fmt((r.minX + r.maxX) / 2)}, ${fmt((r.minZ + r.maxZ) / 2)})`);
    }
  }
  none(bad, 'doorways blocked');
});

test('furniture colliders do not overlap each other', () => {
  const bad: string[] = [];
  for (const d of CASES) {
    const lv = level(d);
    // walls are thin (<= 0.2 m) and long: leave them out; furniture is everything else
    const furn = lv.colliders().filter((r) => Math.min(r.maxX - r.minX, r.maxZ - r.minZ) > 0.2);
    for (let i = 0; i < furn.length; i++) for (let j = i + 1; j < furn.length; j++) {
      const a = furn[i], b = furn[j];
      if (JSON.stringify(a) === JSON.stringify(b)) { bad.push(`${tag(d)}: the same ${fmt(a.maxX - a.minX)}x${fmt(a.maxZ - a.minZ)} collider is registered twice at (${fmt((a.minX + a.maxX) / 2)}, ${fmt((a.minZ + a.maxZ) / 2)})`); continue; }
      const ix = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX), iz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
      if (ix > 0.05 && iz > 0.05) bad.push(`${tag(d)}: (${fmt((a.minX + a.maxX) / 2)}, ${fmt((a.minZ + a.maxZ) / 2)}) ${fmt(a.maxX - a.minX)}x${fmt(a.maxZ - a.minZ)} / (${fmt((b.minX + b.maxX) / 2)}, ${fmt((b.minZ + b.maxZ) / 2)}) ${fmt(b.maxX - b.minX)}x${fmt(b.maxZ - b.minZ)} overlap ${fmt(ix)}x${fmt(iz)}`);
    }
  }
  none(bad, 'overlapping furniture');
});

test('containers face into their room and their contents fit inside them', () => {
  const bad: string[] = [];
  let n = 0;
  for (const d of CASES) {
    const lv = level(d);
    lv.group.updateMatrixWorld(true);
    for (const c of lv.containers) {
      n++;
      const o = c.obj;
      const p = o.getWorldPosition(new THREE.Vector3());
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
      const front = p.clone().addScaledVector(fwd, 0.5);
      const rm = c.room;
      if (!(front.x > rm.x0 && front.x < rm.x1 && front.z > rm.z0 && front.z < rm.z1)) bad.push(`${tag(d)} ${c.kind} in ${rm.type} faces out of the room (${fmt(fwd.x)}, ${fmt(fwd.z)})`);
      // generated on demand: nothing inside until opened, then it fits the carcass
      const before = o.children.length;
      const g = c.generate();
      o.add(g);
      o.updateMatrixWorld(true);
      const inv = o.matrixWorld.clone().invert();
      const bb = new THREE.Box3();
      g.traverse((m) => { if ((m as THREE.Mesh).isMesh) bb.union(new THREE.Box3().setFromObject(m).applyMatrix4(inv)); });
      o.remove(g);
      expect(o.children.length === before, 'generate() changed the container itself');
      if (bb.isEmpty()) continue;
      const s = c.size, tol = 0.08;
      if (bb.min.x < -s.x / 2 - tol || bb.max.x > s.x / 2 + tol || bb.min.y < -tol || bb.max.y > s.y + tol || bb.min.z < -s.z - tol || bb.max.z > tol)
        bad.push(`${tag(d)} ${c.kind} ${fmt(s.x)}x${fmt(s.y)}x${fmt(s.z)}: contents x[${fmt(bb.min.x)},${fmt(bb.max.x)}] y[${fmt(bb.min.y)},${fmt(bb.max.y)}] z[${fmt(bb.min.z)},${fmt(bb.max.z)}]`);
    }
  }
  expect(n > 5, `only ${n} containers`);
  none(bad, 'container problems');
});

test('budgets per interior: meshes, triangles, materials', () => {
  for (const d of CASES) {
    const s = stats(level(d).group);
    expect(s.drawables < 450, `${tag(d)}: ${s.drawables} meshes > 450`);
    expect(s.tris < 400_000, `${tag(d)}: ${s.tris} triangles > 400k`);
    expect(s.materials < 150, `${tag(d)}: ${s.materials} materials > 150`);
  }
});

test('same seed, same interior (determinism)', () => {
  const d = CASES[1];
  const a = level(d), b = new InteriorLevel({ ...d });
  expect(sceneHash(a.group) === sceneHash(b.group), `hash ${sceneHash(a.group)} vs ${sceneHash(b.group)}`);
  expect(JSON.stringify(a.colliders()) === JSON.stringify(b.colliders()), 'colliders differ');
});

test('the entry door is within 1.5 m of the spawn, facing in', () => {
  for (const d of CASES) {
    const lv = level(d);
    const e = lv.entry, p = lv.spawn.pos;
    const dist = Math.hypot(p.x - e.x, p.z - e.z);
    expect(dist <= 1.5, `${tag(d)}: spawn ${fmt(dist)} m from the entry door`);
  }
});

test('pieces against walls face into their room and stay inside it', () => {
  const bad: string[] = [];
  for (const d of CASES) {
    const lv = level(d);
    for (const p of lv.placed) {
      const r = p.room;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      const fx = Math.sin(p.rot), fz = Math.cos(p.rot);
      // the front points away from the wall it backs onto: toward the room's middle
      if (fx * (cx - p.x) + fz * (cz - p.z) <= 0) bad.push(`${tag(d)} ${r.type}: ${fmt(p.w)}x${fmt(p.d)} at (${fmt(p.x)}, ${fmt(p.z)}) faces the wall`);
      if (p.x < r.x0 || p.x > r.x1 || p.z < r.z0 || p.z > r.z1) bad.push(`${tag(d)} ${r.type}: piece outside its room`);
    }
  }
  none(bad, 'misplaced pieces');
});

test('upper floors of a house with a stair core: no street door, you arrive by the stair hall', () => {
  for (const seed of [3, 8, 21]) {
    const lv = new InteriorLevel(desc('house', seed, 1, 3));
    if (!lv.vcore) continue;
    expect(!lv.portals().some((p) => p.target === 'back'), `house#${seed}/1 still has a street exit`);
    const dist = Math.hypot(lv.spawn.pos.x - lv.entry.x, lv.spawn.pos.z - lv.entry.z);
    expect(dist <= 1.5, `house#${seed}/1 spawn ${fmt(dist)} m from the stair-hall door`);
    expect(!lv.stairCore, `house#${seed}/1 has an in-room stair as well as the core`);
    lv.dispose();
  }
});
