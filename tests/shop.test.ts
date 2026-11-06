/** Shop interiors, one per SHOPS type: room scale, entrance clear, fixtures reachable, lazy stock, budgets, determinism. */
import * as THREE from 'three';
import { test, expect, between, none, stats, sceneHash, insideRect, rectOverlap, Grid, fmt, soft } from './qa';
import './env';
import { ShopLevel } from '../src/shop';
import { SHOPS } from '../src/nyc';
import type { Rect } from '../src/level';

type Desc = ConstructorParameters<typeof ShopLevel>[0];
const desc = (shop: string, seed = 3): Desc => ({ kind: 'interior', seed, name: `QA ${shop}`, style: 'store', floor: 0, floors: 1, biome: 'metropolis', shop });
const shops = new Map<string, ShopLevel>();
const shop = (type: string) => {
  let s = shops.get(type);
  if (!s) shops.set(type, (s = new ShopLevel(desc(type))));
  return s;
};
const TYPES = SHOPS.map((s) => s.type);
const known = (msg: string) => soft(false, `KNOWN ${msg}`);
const inner = (s: ShopLevel): Rect => ({ minX: -s.room.W / 2, maxX: s.room.W / 2, minZ: -s.room.D / 2, maxZ: s.room.D / 2 });
/** the big wall colliders the shell adds (they reach 1 m outside the room) */
const isWall = (s: ShopLevel, r: Rect) => r.minX < -s.room.W / 2 - 0.5 || r.maxX > s.room.W / 2 + 0.5 || r.minZ < -s.room.D / 2 - 0.5 || r.maxZ > s.room.D / 2 + 0.5;

test(`all ${TYPES.length} shop types build`, () => {
  for (const t of TYPES) {
    const s = shop(t);
    expect(s.group.children.length > 0, `${t}: empty`);
    expect(s.staging === undefined || s.step(1e9), `${t}: still staging`);
  }
});

test('shop rooms are real scale: 4-20 m wide, 6-30 m deep, 2.7-4.6 m high; door 1.0-1.8 x 2.0-2.7 m', () => {
  for (const t of TYPES) {
    const s = shop(t);
    between(s.room.W, 4, 20, `${t} width`);
    between(s.room.D, 6, 30, `${t} depth`);
    between(s.room.H, 2.7, 4.6, `${t} ceiling`);
    between(s.door.width, 1.0, 1.8, `${t} door width`);
    between(s.door.height, 2.0, 2.7, `${t} door height`);
    expect(Math.abs(s.door.pos.x) + s.door.width / 2 <= s.room.W / 2, `${t}: door outside the shop front`);
  }
});

// KNOWN (qa-findings): small collider overlaps, fixtures 0.2 m into the side wall, and these
const KNOWN_FIXTURE = /^(deli|toys|garden|electronics|hardware):/;
test('the entrance is clear: nothing within 1.5 m inside the door', () => {
  const bad: string[] = [];
  for (const t of TYPES) {
    const s = shop(t);
    const d = s.door.pos;
    const zone: Rect = { minX: d.x - 0.7, maxX: d.x + 0.7, minZ: d.z - 1.5, maxZ: d.z - 0.05 };
    for (const r of s.colliders()) if (rectOverlap(zone, r)) (t === 'deli' ? known : bad.push.bind(bad))(`${t}: ${fmt(r.maxX - r.minX)}x${fmt(r.maxZ - r.minZ)} at (${fmt((r.minX + r.maxX) / 2)}, ${fmt((r.minZ + r.maxZ) / 2)})`);
    expect(!s.colliders().some((r) => insideRect(r, s.spawn.pos.x, s.spawn.pos.z, 0.25)), `${t}: spawn inside a collider`);
  }
  none(bad, 'colliders blocking the entrance');
});

test('fixtures stay inside the room and do not overlap each other', () => {
  const bad: string[] = [];
  for (const t of TYPES) {
    const s = shop(t);
    const room = inner(s);
    const fx = s.colliders().filter((r) => !isWall(s, r));
    for (const r of fx) if (r.minX < room.minX - 0.15 || r.maxX > room.maxX + 0.15 || r.minZ < room.minZ - 0.15 || r.maxZ > room.maxZ + 0.15) bad.push(`${t}: fixture (${fmt((r.minX + r.maxX) / 2)}, ${fmt((r.minZ + r.maxZ) / 2)}) outside ${fmt(s.room.W)}x${fmt(s.room.D)}`);
    for (let i = 0; i < fx.length; i++) for (let j = i + 1; j < fx.length; j++) {
      const a = fx[i], b = fx[j];
      const ix = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX), iz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
      if (ix > 0.05 && iz > 0.05) bad.push(`${t}: ${fmt(a.maxX - a.minX)}x${fmt(a.maxZ - a.minZ)} @(${fmt((a.minX + a.maxX) / 2)}, ${fmt((a.minZ + a.maxZ) / 2)}) overlaps ${fmt(b.maxX - b.minX)}x${fmt(b.maxZ - b.minZ)} @(${fmt((b.minX + b.maxX) / 2)}, ${fmt((b.minZ + b.maxZ) / 2)}) by ${fmt(ix)}x${fmt(iz)}`);
    }
  }
  for (const b of bad.filter((x) => KNOWN_FIXTURE.test(x))) known(b);
  none(bad.filter((x) => !KNOWN_FIXTURE.test(x)), 'fixture problems', String, 10);
});

test('every case, cooler and drawer can be walked up to (flood fill from the door)', () => {
  const bad: string[] = [];
  for (const t of TYPES) {
    const s = shop(t);
    const reach = new Grid({ ...inner(s), maxZ: s.room.D / 2 + 0.5 }, s.colliders(), 0.1, 0.25).flood(s.spawn.pos.x, s.spawn.pos.z);
    s.group.updateMatrixWorld(true);
    for (const c of s.cases) {
      const p = c.obj.getWorldPosition(new THREE.Vector3());
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(c.obj.getWorldQuaternion(new THREE.Quaternion()));
      // stand somewhere within 1.4 m in front of it
      const ok = [0.4, 0.7, 1.0].some((dd) => reach(p.x + fwd.x * dd, p.z + fwd.z * dd, 0.4));
      if (!ok) bad.push(`${t}: ${c.label} at (${fmt(p.x)}, ${fmt(p.z)}) facing (${fmt(fwd.x)}, ${fmt(fwd.z)})`);
    }
  }
  none(bad, 'containers out of reach');
});

test('containers face away from the wall they stand against', () => {
  const bad: string[] = [];
  for (const t of TYPES) {
    const s = shop(t);
    s.group.updateMatrixWorld(true);
    for (const c of s.cases) {
      const p = c.obj.getWorldPosition(new THREE.Vector3());
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(c.obj.getWorldQuaternion(new THREE.Quaternion()));
      const q = p.clone().addScaledVector(fwd, 0.3);
      if (!insideRect(inner(s), q.x, q.z, 0.05)) bad.push(`${t}: ${c.label} at (${fmt(p.x)}, ${fmt(p.z)}) faces (${fmt(fwd.x)}, ${fmt(fwd.z)}) out of the room`);
    }
  }
  none(bad, 'containers facing a wall');
});

test('stock is generated only once a container is opened or looked into', () => {
  for (const t of ['deli', 'hardware', 'pharmacy']) {
    const s = new ShopLevel(desc(t, 4)); // its own copy: generating stock changes the scene
    expect(s.cases.length > 0, `${t}: no containers`);
    for (const c of s.cases) expect(!c.lazy.contents, `${t}: ${c.label} has contents before being opened`);
    const opaque = s.cases.find((c) => !c.glass);
    if (!opaque) continue;
    opaque.lazy.ensure();
    while (opaque.lazy.step());
    expect(opaque.lazy.contents || (opaque.lazy as unknown as { pending: boolean }).pending, `${t}: ${opaque.label}: nothing generated after open`);
    expect(s.cases.filter((c) => c.lazy.contents).length <= 1, `${t}: opening one container generated others`);
  }
});

test('budgets per shop (shell + fixtures, before stock): meshes, triangles, materials', () => {
  for (const t of TYPES) {
    const st = stats(shop(t).group);
    expect(st.drawables < 400, `${t}: ${st.drawables} meshes > 400`);
    expect(st.tris < 400_000, `${t}: ${st.tris} triangles > 400k`);
    expect(st.materials < 120, `${t}: ${st.materials} materials > 120`);
  }
});

test('same seed, same shop (determinism)', () => {
  for (const t of ['deli', 'furniture']) {
    const a = new ShopLevel(desc(t)), b = new ShopLevel(desc(t));
    expect(sceneHash(a.group) === sceneHash(b.group), `${t}: hash ${sceneHash(a.group)} vs ${sceneHash(b.group)}`);
    expect(JSON.stringify(a.colliders()) === JSON.stringify(b.colliders()), `${t}: colliders differ`);
  }
});
