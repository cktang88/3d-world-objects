/** Museum: planning invariants on synthetic objects (pure, instant) and real Smithsonian galleries built in Node. */
import * as THREE from 'three';
import { test, expect, none, insideRect, Grid, fmt, soft } from './qa';
import { settle } from './env';
import { Rng } from '../src/rng';
import { assemble, classify, partitionRooms, planRoom, type Plan } from '../src/museum/plan';
import { along } from '../src/museum/displays';
import { STYLES } from '../src/museum/style';
import type { Measured } from '../src/museum/sizes';
import type { RemoteEntry } from '../src/remote';
import { loadMuseum, museum } from '../src/museumData';
import { GalleryLevel, AtriumLevel } from '../src/museum';
import { SI_BASE, SI_ROOMS } from '../src/museum/smithsonian';

const known = (msg: string) => soft(false, `KNOWN ${msg}`);

/** a deterministic mix of museum objects: coins to aircraft */
function objects(seed: number, n: number, family = 'misc'): Measured[] {
  const r = new Rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const L = Math.exp(r.range(Math.log(0.05), Math.log(i % 17 === 0 ? 30 : 3)));
    const real = new THREE.Vector3(L, L * r.range(0.2, 1.6), L * r.range(0.15, 1));
    const entry = { ds: 'objaverse', split: 'train', row: i, id: `qa-${seed}-${i}`, family, entry: '', title: `object ${i}`, author: '', url: '', license: 'CC0', path: '', bytes: 0, f: 0, joints: 0 } as RemoteEntry;
    return { entry, raw: real.clone(), k: 1, real };
  });
}
const STYLE_NAMES = Object.keys(STYLES) as (keyof typeof STYLES)[];

test('partitionRooms caps objects per room, floor area and colossal objects', () => {
  const items = objects(1, 400);
  const rooms = partitionRooms(items, (m) => m.real, 24);
  expect(rooms.flat().length === items.length, 'objects lost or duplicated');
  for (const rm of rooms) {
    expect(rm.length <= 24, `room with ${rm.length} objects`);
    expect(rm.filter((m) => Math.max(m.real.x, m.real.z) > 25).length <= 2, 'more than two colossal objects in one hall');
  }
});

test('every object is shown at full size: its display is at least as big as it is', () => {
  const bad: string[] = [];
  for (const sn of STYLE_NAMES) {
    const st = STYLES[sn];
    const items = objects(2, 40);
    const units = assemble(items, st, new Rng(5));
    const shown = units.flatMap((u) => u.items);
    if (shown.length !== items.length) bad.push(`${sn}: ${items.length - shown.length} objects not displayed`);
    for (const u of units) for (const m of u.items) {
      const a = along(m);
      // hung things fly above; everything else needs a footprint and height that holds it
      if (u.place === 'hang') continue;
      if (m.k < 1 - 1e-6) bad.push(`${sn}: ${m.entry.id} scaled down (k=${fmt(m.k)})`);
      if (u.place === 'floor' && (u.w + 1e-6 < Math.min(a.w, a.d) || u.h + 1e-6 < m.real.y)) bad.push(`${sn} ${u.type}: ${fmt(a.w)}x${fmt(a.d)}x${fmt(m.real.y)} object on a ${fmt(u.w)}x${fmt(u.d)}x${fmt(u.h)} display`);
    }
  }
  none(bad, 'display problems');
});

test("objects too big for a case stand on the floor (platforms with a barrier), never in a case", () => {
  const bad: string[] = [];
  for (const sn of STYLE_NAMES) {
    const st = STYLES[sn];
    const items = objects(3, 60);
    for (const u of assemble(items, st, new Rng(6))) for (const m of u.items) {
      const big = Math.max(m.real.x, m.real.z) > 1.9 || m.real.y > 2.0;
      if (big && u.place === 'wall') bad.push(`${sn}: ${fmt(m.real.x)}x${fmt(m.real.y)}x${fmt(m.real.z)} in a wall ${u.type}`);
      if (big && u.place === 'floor' && u.type !== 'platform') bad.push(`${sn}: ${fmt(m.real.x)}x${fmt(m.real.y)}x${fmt(m.real.z)} on a ${u.type}`);
    }
    // classify agrees
    for (const m of items) if (Math.max(m.real.x, m.real.z) > 1.9 && !['floor', 'hang'].includes(classify(m, st, new Rng(1)))) bad.push(`${sn}: classify(${fmt(m.real.x)}) = ${classify(m, st, new Rng(1))}`);
  }
  none(bad, 'big objects in cases');
});

/** footprint of a placed floor unit in room coordinates (x in [-W/2, W/2], z in [-D, 0]) */
const footRect = (p: Plan['floor'][number]) => {
  const q = Math.round(p.f.rot / (Math.PI / 2)) & 1;
  const w = q ? p.u.d : p.u.w, d = q ? p.u.w : p.u.d;
  return { minX: p.f.x - w / 2, maxX: p.f.x + w / 2, minZ: p.f.z - d / 2, maxZ: p.f.z + d / 2 };
};
const plans = () => STYLE_NAMES.flatMap((sn) => [7, 8, 9].map((seed) => {
  const st = STYLES[sn];
  const units = assemble(objects(seed, 30), st, new Rng(seed));
  return { sn, seed, plan: planRoom(units, st, new Rng(seed + 1), 3) };
}));

test('gallery plans: floor displays inside the room and not overlapping; room capped at ~60 x 120 m', () => {
  const bad: string[] = [];
  for (const { sn, seed, plan } of plans()) {
    const tag = `${sn}#${seed} ${fmt(plan.W)}x${fmt(plan.D)}`;
    if (plan.W > 62 || plan.D > 125) bad.push(`${tag}: room too big`);
    const fr = plan.floor.filter((p) => p.u.items.length).map(footRect);
    fr.forEach((r, i) => {
      if (r.minX < -plan.W / 2 - 0.01 || r.maxX > plan.W / 2 + 0.01 || r.minZ < -plan.D - 0.01 || r.maxZ > 0.01) bad.push(`${tag}: ${plan.floor[i].u.type} outside the room`);
      for (let j = i + 1; j < fr.length; j++) {
        const o = fr[j];
        const ix = Math.min(r.maxX, o.maxX) - Math.max(r.minX, o.minX), iz = Math.min(r.maxZ, o.maxZ) - Math.max(r.minZ, o.minZ);
        if (ix > 0.05 && iz > 0.05) bad.push(`${tag}: floor displays overlap by ${fmt(ix)}x${fmt(iz)}`);
      }
    });
  }
  none(bad, 'plan problems');
});

test('gallery plans: a 1.2 m apron inside every doorway is free of displays', () => {
  const bad: string[] = [];
  for (const { sn, seed, plan } of plans()) {
    const fr = plan.floor.map(footRect);
    for (const d of plan.doors) {
      const c = d.wall === 'N' ? [d.at, -plan.D + 0.6] : d.wall === 'S' ? [d.at, -0.6] : d.wall === 'W' ? [-plan.W / 2 + 0.6, d.at] : [plan.W / 2 - 0.6, d.at];
      const along = d.wall === 'N' || d.wall === 'S';
      const zone = { minX: c[0] - (along ? d.w / 2 : 0.6), maxX: c[0] + (along ? d.w / 2 : 0.6), minZ: c[1] - (along ? 0.6 : d.w / 2), maxZ: c[1] + (along ? 0.6 : d.w / 2) };
      fr.forEach((r, i) => {
        const ix = Math.min(r.maxX, zone.maxX) - Math.max(r.minX, zone.minX), iz = Math.min(r.maxZ, zone.maxZ) - Math.max(r.minZ, zone.minZ);
        if (ix > 0.05 && iz > 0.05) bad.push(`${sn}#${seed} ${fmt(plan.W)}x${fmt(plan.D)}: ${plan.floor[i].u.type} ${fmt(plan.floor[i].u.w)}x${fmt(plan.floor[i].u.d)} at (${fmt(plan.floor[i].f.x)}, ${fmt(plan.floor[i].f.z)}) in the ${d.wall} doorway at ${fmt(d.at)} by ${fmt(ix)}x${fmt(iz)}`);
      });
    }
  }
  none(bad, 'doorways blocked');
});

test('doorways lead to similar themes (theme neighbours share a collection or words)', async () => {
  await loadMuseum();
  const m = museum();
  const r = new Rng(4);
  let pairs = 0, similar = 0;
  for (let i = 0; i < 300; i++) {
    const t = m.themes[r.int(0, m.themes.length - 1)];
    for (const n of t.neighbors.slice(0, 3)) {
      const o = m.themes[n];
      if (!o) continue;
      pairs++;
      if (o.collection === t.collection || o.words.some((w) => t.words.includes(w))) similar++;
    }
  }
  expect(pairs > 100, `only ${pairs} neighbour pairs`);
  expect(similar / pairs > 0.8, `only ${Math.round((100 * similar) / pairs)}% of doorway neighbours are similar`);
  // and the gallery uses them for its exits
  const t = m.themes.find((x) => x.neighbors.length >= 3 && x.size < 20)!;
  const g = new GalleryLevel({ kind: 'gallery', theme: t.id, page: 0 });
  const exits = (g as unknown as { exits(p: number): { top: string; target: { theme: number } }[] }).exits(1);
  g.dispose();
  for (const e of exits.filter((x) => x.top.startsWith('similar'))) expect(t.neighbors.includes(e.target.theme), `exit to ${e.target.theme} is not a neighbour of ${t.id}`);
  expect(exits.filter((x) => x.top.startsWith('similar')).length >= 2, 'fewer than two similar-theme doorways');
});

// ---------------------------------------------------------------- real galleries (Smithsonian rooms: sizes come with the catalog)

async function siGallery(k: number) {
  await loadMuseum();
  const g = new GalleryLevel({ kind: 'gallery', theme: SI_BASE + k, page: 0 });
  await Promise.race([(g as unknown as { ready: Promise<void> }).ready, settle(20000)]);
  return g;
}
const SI_SAMPLE = [1, 4]; // Sculpture Court (period), Shells and Corals (study)

test('Smithsonian galleries: spawn free, every doorway reachable, exhibits inside and apart', async () => {
  const bad: string[] = [];
  for (const k of SI_SAMPLE) {
    const g = await siGallery(k);
    const plan = g.plan;
    expect(plan, `${SI_ROOMS[k].name}: no plan after 20 s`);
    const tag = SI_ROOMS[k].name;
    const room = { minX: -plan.W / 2, maxX: plan.W / 2, minZ: -plan.D, maxZ: 0 };
    const cols = g.colliders();
    if (cols.some((r) => insideRect(r, g.spawn.pos.x, g.spawn.pos.z, 0.25))) bad.push(`${tag}: spawn inside a collider`);
    const reach = new Grid({ ...room, minX: room.minX - 2, maxX: room.maxX + 2, minZ: room.minZ - 2, maxZ: 2 }, cols, 0.15, 0.25).flood(g.spawn.pos.x, g.spawn.pos.z);
    const ports = g.portals();
    for (const p of ports.filter((q) => q.target !== 'inspect')) {
      const c = p.box.getCenter(new THREE.Vector3());
      if (!reach(c.x, c.z, Math.min(p.box.max.x - p.box.min.x, p.box.max.z - p.box.min.z) / 2 + 0.3)) bad.push(`${tag}: doorway "${p.label}" unreachable`);
    }
    const ex = ports.filter((q) => q.target === 'inspect').map((q) => q.box);
    expect(ex.length > 3, `${tag}: only ${ex.length} exhibits`);
    for (const b of ex) {
      if (b.min.x < room.minX - 0.05 || b.max.x > room.maxX + 0.05 || b.min.z < room.minZ - 0.05 || b.max.z > 0.05) bad.push(`${tag}: exhibit at (${fmt((b.min.x + b.max.x) / 2)}, ${fmt((b.min.z + b.max.z) / 2)}) outside the walls`);
      // every exhibit can be walked up to (within 2 m)
      const c = b.getCenter(new THREE.Vector3());
      if (!reach(c.x, c.z, Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2 + 2)) bad.push(`${tag}: exhibit at (${fmt(c.x)}, ${fmt(c.z)}) out of reach`);
    }
    let overl = 0;
    for (let i = 0; i < ex.length; i++) for (let j = i + 1; j < ex.length; j++) if (ex[i].clone().expandByScalar(-0.02).intersectsBox(ex[j].clone().expandByScalar(-0.02))) overl++;
    if (overl) known(`${tag}: ${overl} pairs of exhibits whose real bounds intersect`);
    g.dispose();
  }
  none(bad, 'gallery problems');
});

test('atrium: spawn free and all eight wing doorways reachable', async () => {
  await loadMuseum();
  const a = new AtriumLevel();
  const cols = a.colliders();
  expect(!cols.some((r) => insideRect(r, a.spawn.pos.x, a.spawn.pos.z, 0.25)), 'spawn inside a collider');
  const reach = new Grid({ minX: -20, maxX: 20, minZ: -36, maxZ: 6 }, cols, 0.15, 0.25).flood(a.spawn.pos.x, a.spawn.pos.z);
  const doors = a.portals().filter((p) => typeof p.target === 'object' || p.target === 'back');
  expect(doors.length >= 8, `only ${doors.length} doorways`);
  none(doors.filter((p) => { const c = p.box.getCenter(new THREE.Vector3()); return !reach(c.x, c.z, 1.6); }), 'unreachable atrium doorways', (p) => p.label);
  a.dispose();
});

/** objects of one size band, for the display-choice tests */
function band(seed: number, n: number, lo: number, hi: number, yk: [number, number]): Measured[] {
  const r = new Rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const L = r.range(lo, hi);
    const real = new THREE.Vector3(L, L * r.range(yk[0], yk[1]), L * r.range(0.4, 1));
    const entry = { ds: 'objaverse', split: 'train', row: i, id: `qb-${seed}-${i}`, family: 'misc', entry: '', title: `thing ${i}`, author: '', url: '', license: 'CC0', path: '', bytes: 0, f: 0, joints: 0 } as RemoteEntry;
    return { entry, raw: real.clone(), k: 1, real };
  });
}

test('period galleries dress furniture as a room set; study rooms put the tiniest things in drawers', () => {
  const rooms = [1, 2, 3, 4, 5, 6].flatMap((s) => assemble(band(s, 8, 0.8, 1.6, [0.6, 1.1]), STYLES.period, new Rng(s)).filter((u) => u.type === 'room'));
  expect(rooms.length >= 2, `only ${rooms.length} period room sets in 6 period galleries`);
  for (const u of rooms) expect(u.items.length >= 3, `a room set with ${u.items.length} pieces`);
  const units = assemble(band(9, 30, 0.02, 0.09, [0.2, 0.6]), STYLES.study, new Rng(9));
  const dr = units.filter((u) => u.type === 'drawers');
  expect(dr.length >= 1, 'no specimen drawers for 30 tiny objects in a study room');
  for (const u of dr) for (const m of u.items) expect(m.real.y <= 0.07, `${fmt(m.real.y)} m tall object in a drawer`);
});

test('rooms of small things only are intimate (low ceiling, small doors)', () => {
  for (const s of [1, 2, 3]) {
    const units = assemble(band(s, 20, 0.05, 0.3, [0.4, 1.2]), STYLES.study, new Rng(s));
    const plan = planRoom(units, STYLES.study, new Rng(s), 3);
    expect(plan.H <= 4.4, `ceiling ${fmt(plan.H)} m in a cabinet room`);
    expect(plan.doors.every((d) => d.h <= 2.8), 'big doors in a cabinet room');
  }
});

test('every gallery carries the same light rig (no shader recompiles between rooms)', async () => {
  const counts: number[] = [];
  for (const k of SI_SAMPLE) {
    const g = await siGallery(k);
    let n = 0;
    g.group.traverse((o) => { if ((o as THREE.Light).isLight) n++; });
    counts.push(n);
    g.dispose();
  }
  expect(new Set(counts).size === 1, `light counts differ between rooms: ${counts.join(', ')}`);
});
