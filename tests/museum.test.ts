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
import { frontOf } from '../src/museum/base';
import { Seamless, descKey, facing } from '../src/seamless';
import { ENTRY_Z } from '../src/museum/shell';
import type { LevelDesc } from '../src/level';

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

test('gallery plans: a clear 2.5 m sight-and-walk corridor from the room centre to every onward doorway', () => {
  const bad: string[] = [];
  for (const { sn, seed, plan } of plans()) {
    const fr = plan.floor.map(footRect);
    for (const d of plan.doors.slice(1)) {
      const h = 1.25;
      const zone = d.wall === 'N' ? { minX: d.at - h, maxX: d.at + h, minZ: -plan.D, maxZ: -plan.D / 2 }
        : d.wall === 'W' ? { minX: -plan.W / 2, maxX: 0, minZ: d.at - h, maxZ: d.at + h }
        : d.wall === 'E' ? { minX: 0, maxX: plan.W / 2, minZ: d.at - h, maxZ: d.at + h }
        : { minX: d.at - h, maxX: d.at + h, minZ: -plan.D / 2, maxZ: 0 };
      fr.forEach((r, i) => {
        const ix = Math.min(r.maxX, zone.maxX) - Math.max(r.minX, zone.minX), iz = Math.min(r.maxZ, zone.maxZ) - Math.max(r.minZ, zone.minZ);
        if (ix > 0.05 && iz > 0.05) bad.push(`${sn}#${seed} ${fmt(plan.W)}x${fmt(plan.D)}: ${plan.floor[i].u.type} at (${fmt(plan.floor[i].f.x)}, ${fmt(plan.floor[i].f.z)}) in the corridor to the ${d.wall} doorway at ${fmt(d.at)}`);
      });
    }
  }
  none(bad, 'doorway corridors blocked');
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

test('sand3d galleries are planned at once from the offline sizes (no measuring wait), halls capped', async () => {
  await loadMuseum();
  const bad: string[] = [];
  // a cabinet room, a furniture room, a motor hall and the colossal ships
  for (const theme of [811, 2453, 3766, 3855]) {
    const g = new GalleryLevel({ kind: 'gallery', theme, page: 0 });
    const t0 = Date.now();
    await Promise.race([(g as unknown as { built: Promise<void> }).built, settle(8000)]);
    const name = museum().themes[theme].name;
    if (!g.plan) bad.push(`${name}: not built within 8 s (${Date.now() - t0} ms)`);
    else {
      const big = Math.max(0, ...g.plan.floor.flatMap((p) => p.u.items.map((m) => Math.max(m.real.x, m.real.z))));
      if (big < 55 && (g.plan.W > 64 || g.plan.D > 125)) bad.push(`${name}: ${fmt(g.plan.W)} x ${fmt(g.plan.D)} m hall`);
    }
    g.dispose();
  }
  none(bad, 'gallery build problems');
});

test('see-through doorways: the next gallery is prebuilt, shown behind its doorway, and crossing builds nothing', async () => {
  await loadMuseum();
  let builds = 0;
  const camera = new THREE.PerspectiveCamera();
  const scene = new THREE.Scene();
  const seam = new Seamless({
    scene, camera, capacity: 3,
    renderer: { toneMappingExposure: 1, compileAsync: () => Promise.resolve() } as unknown as THREE.WebGLRenderer,
    build: (d) => { builds++; return new GalleryLevel(d as Extract<LevelDesc, { kind: 'gallery' }>); },
  });
  const here = seam.take({ kind: 'gallery', theme: 811, page: 0 });
  seam.setActive(here);
  const g = here.level as GalleryLevel;
  await Promise.race([g.built, settle(8000)]);
  expect(g.plan, 'the first gallery was not built');
  // stand 3 m inside the first exit doorway, facing it
  const exit = g.portals().find((p) => p.auto && typeof p.target === 'object' && p.door?.see)!;
  expect(exit, 'no see-through exit doorway');
  const door = exit.door!;
  const player = door.pos.clone().addScaledVector(facing(door.yaw), -4.5);
  camera.position.set(player.x, 1.6, player.z);
  camera.lookAt(door.pos.x, 1.6, door.pos.z);
  camera.updateMatrixWorld(true);
  let shown = false;
  exit.onPreview = ((prev) => (v: boolean) => { prev?.(v); shown = v; })(exit.onPreview);
  for (let i = 0; i < 400 && !shown; i++) {
    seam.update(1 / 60, g, player);
    await settle(10);
  }
  expect(seam.ready(exit.target as LevelDesc), 'the room behind the doorway was not prebuilt');
  expect(shown, 'the room behind the doorway is not shown through it');
  // its own entrance passage lands on the end of this one: their entrance wall at the passage end
  const s = seam.slots.get(descKey(exit.target as LevelDesc))!;
  const theirs = new THREE.Vector3(0, 0, 0).applyMatrix4(s.level.group.matrixWorld); // their entrance wall line, centre
  const want = door.pos.clone().addScaledVector(facing(door.yaw), ENTRY_Z);
  expect(theirs.distanceTo(want) < 0.01, `their entrance wall lands ${fmt(theirs.distanceTo(want))} m off the end of the passage`);
  // walk through: the switch reuses the prebuilt room
  const before = builds;
  const next = seam.take(exit.target as LevelDesc);
  seam.setActive(next);
  expect(builds === before, `crossing the doorway built ${builds - before} levels`);
  seam.clear();
});

test('atrium spawn: looking in from the entrance, the two north wings show through their doorways', async () => {
  await loadMuseum();
  const camera = new THREE.PerspectiveCamera();
  const seam = new Seamless({
    scene: new THREE.Scene(), camera, capacity: 4,
    renderer: { toneMappingExposure: 1, compileAsync: () => Promise.resolve() } as unknown as THREE.WebGLRenderer,
    build: (d) => (d.kind === 'atrium' ? new AtriumLevel() : new GalleryLevel(d as Extract<LevelDesc, { kind: 'gallery' }>)),
  });
  const here = seam.take({ kind: 'atrium' });
  seam.setActive(here);
  const a = here.level as AtriumLevel;
  // the real spawn pose
  const player = a.spawn.pos.clone();
  camera.position.set(player.x, 1.6, player.z);
  camera.lookAt(player.x - Math.sin(a.spawn.yaw) * 10, 1.6, player.z - Math.cos(a.spawn.yaw) * 10);
  camera.updateMatrixWorld(true);
  const north = a.portals().filter((p) => p.door?.see && p.door.pos.z < -30);
  expect(north.length === 2, `${north.length} see-through doors on the north wall`);
  const shown = () => north.filter((p) => seam.slots.get(descKey(p.target as LevelDesc))?.shown);
  for (let i = 0; i < 600 && shown().length < 2; i++) {
    seam.update(1 / 60, a, player);
    await settle(10);
  }
  expect(shown().length === 2, `only ${shown().length} of the north wings show through their doorways from the spawn (shown: ${[...seam.slots.values()].filter((s) => s.shown).map((s) => s.key.slice(0, 60)).join('; ')})`);
  seam.clear();
});

test('a gallery seen through a doorway: its shell glows and its stand-in light is the one nearest the door', async () => {
  await loadMuseum();
  const g = new GalleryLevel({ kind: 'gallery', theme: 2453, page: 0 });
  await Promise.race([g.built, settle(8000)]);
  const lights: THREE.Light[] = [];
  g.group.traverse((o) => { if ((o as THREE.Light).isLight) lights.push(o as THREE.Light); });
  const outside = new THREE.Vector3(0, 0, 4);
  const lit = lights.filter((l) => l.position.y > -100);
  const nearest = [...lit].sort((a, b) => a.position.distanceTo(outside) - b.position.distanceTo(outside))[0];
  expect(nearest && (nearest.userData.base ?? 0) > 0, 'the light nearest the entrance is not the preview stand-in (unused rig lights must be parked away)');
  // from outside the entrance the shell swaps to its glowing copy, and back inside it does not
  const shell = g.group.children.find((o) => (o as THREE.Mesh).isMesh && o.userData.owned && !o.userData.tex && !((o as THREE.Mesh).material as THREE.Material).transparent) as THREE.Mesh;
  const glow = () => { const e = (shell.material as THREE.MeshStandardMaterial).emissive; return e.r + e.g + e.b; };
  const before = glow();
  for (let i = 0; i < 31; i++) g.update(1 / 60, outside, i / 60);
  const out = glow();
  expect(out > before + 0.05, `the shell does not glow while seen from outside (${fmt(before)} -> ${fmt(out)})`);
  for (let i = 0; i < 31; i++) g.update(1 / 60, new THREE.Vector3(0, 0, -3), i / 60);
  expect(glow() === before, 'the shell still glows from inside');
  g.dispose();
});

test('exhibits face the visitor: the detailed side (piano keys) turns to the display front, a flat back away', () => {
  // an upright piano: a flat back panel at -z, a case, 88 keys along +z
  const piano = (keysAt: number) => {
    const g = new THREE.Group();
    const add = (w: number, h: number, d: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
      m.position.set(x, y, z);
      g.add(m);
    };
    add(1.5, 1.2, 0.04, 0, 0.6, -keysAt * 0.28);
    add(1.5, 1.2, 0.5, 0, 0.6, 0);
    for (let k = 0; k < 88; k++) add(0.015, 0.02, 0.12, -0.7 + k * 0.016, 0.75, keysAt * 0.3);
    return g;
  };
  // the display's front is +z of the model (rot 0): keys at +z stay, keys at -z turn round
  expect(frontOf(piano(1), new THREE.Vector3(0, 0, 1)) === 'keep', 'keys already towards the visitor, but it would turn');
  expect(frontOf(piano(-1), new THREE.Vector3(0, 0, 1)) === 'flip', 'the back panel faces the visitor and it does not turn');
  // a long side placed along x (rot pi/2): the wanted axis is -x
  const turned = piano(1);
  turned.rotation.y = Math.PI / 2; // keys now at +x
  const wrap = new THREE.Group();
  wrap.add(turned);
  expect(frontOf(wrap, new THREE.Vector3(-1, 0, 0)) === 'flip', 'keys at +x while the visitor is at -x');
  // a symmetric thing: left as modelled
  const box = new THREE.Group();
  box.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1, 8, 8, 8)));
  expect(frontOf(box, new THREE.Vector3(0, 0, 1)) === 'guess', 'a symmetric box was given a front');
});

test('no z-fighting: coplanar overlapping faces of different meshes in the atrium and three room types are gone or tiny', async () => {
  await loadMuseum();
  const { scanZFight } = await import('../src/museum/zfight');
  const bad: string[] = [];
  const rooms: { n: string; g: THREE.Group; dispose: () => void }[] = [];
  const a = new AtriumLevel();
  rooms.push({ n: 'atrium', g: a.group, dispose: () => a.dispose() });
  for (const t of [3302, 2453, 811]) {
    const g = new GalleryLevel({ kind: 'gallery', theme: t, page: 0 });
    await Promise.race([g.built, settle(8000)]);
    rooms.push({ n: `theme ${t}`, g: g.group, dispose: () => g.dispose() });
  }
  await settle(400); // the fix runs in idle time
  for (const r of rooms) {
    const pairs = scanZFight(r.g);
    const area = pairs.reduce((s, p) => s + p.area, 0);
    // the shell is authored clean (no runtime room fix: it costs 20-160 ms a room)
    if (pairs.length > 20 || area > 0.2) bad.push(`${r.n}: ${pairs.length} pairs, ${fmt(area)} m2`);
    r.dispose();
  }
  none(bad, 'z-fighting faces');
});

test('shader programs: after the atrium and one gallery, four more room types add at most 2 program signatures', async () => {
  await loadMuseum();
  const { signatures } = await import('../src/museum/looks');
  const seen = new Set<string>();
  const log: string[] = [];
  const a = new AtriumLevel();
  await settle(300);
  signatures(a.group, seen);
  log.push(`atrium ${seen.size}`);
  a.dispose();
  let after2 = 0;
  const themes = [3302, 2453, 811, 3766, 2383];
  for (const [i, t] of themes.entries()) {
    const g = new GalleryLevel({ kind: 'gallery', theme: t, page: 0 });
    await Promise.race([g.built, settle(8000)]);
    const before = new Set(seen);
    signatures(g.group, seen);
    const fresh = [...seen].filter((k) => !before.has(k));
    log.push(`${t} +${fresh.length}${fresh.length ? ' ' + fresh.join(' ; ') : ''}`);
    if (i >= 1) after2 += fresh.length;
    g.dispose();
  }
  console.log('     ' + log.join('\n     '));
  expect(after2 <= 2, `rooms after the first two added ${after2} programs`);
});

test('exhibit sides: a closed box is front-sided, an open sheet stays double-sided', async () => {
  const { isOpen } = await import('../src/museum/looks');
  expect(!isOpen(new THREE.BoxGeometry(1, 1, 1, 2, 2, 2)), 'a closed box (split normals and UVs) counted as open');
  expect(isOpen(new THREE.PlaneGeometry(1, 1, 4, 4)), 'an open sheet counted as closed');
  expect(!isOpen(new THREE.SphereGeometry(1, 16, 12)), 'a sphere counted as open');
});

test('exhibit loads: a room built ahead (doorway prebuild) has its loads queued before you enter, behind the current room, nearest the door first; walking in moves them to the front', async () => {
  await loadMuseum();
  const { queuedPrio } = await import('../src/remote');
  // no workers in Node: a silent stand-in keeps the parses queued, so their order can be read
  const g0 = globalThis as unknown as { Worker?: unknown };
  const had = g0.Worker;
  if (!had) g0.Worker = class { onmessage = null; postMessage() {} terminate() {} };
  const g = new GalleryLevel({ kind: 'gallery', theme: 2453, page: 1 });
  await Promise.race([g.built, settle(8000)]);
  // (library and Smithsonian objects come through their own loaders)
  const all = (g as unknown as { slots: { m: { entry: { id: string } }; queued?: boolean; at: THREE.Vector3 }[] }).slots;
  const slots = all.filter((x, i) => x.queued && all.findIndex((y) => y.m.entry.id === x.m.entry.id) === i);
  const before = slots.map((x) => ({ d: Math.hypot(x.at.x, x.at.z), p: queuedPrio(x.m.entry.id) }));
  const queued = before.filter((x) => x.p !== undefined);
  expect(slots.length > 0, 'no exhibits');
  expect(queued.length === slots.length, `${slots.length - queued.length} of ${slots.length} exhibit loads not queued before entering`);
  expect(queued.every((x) => x.p! >= 1000), 'a room built ahead must queue behind the current room');
  const byPrio = [...queued].sort((a, b) => a.p! - b.p!);
  expect(byPrio.every((x, i) => i === 0 || x.d >= byPrio[i - 1].d - 1e-6), 'loads are not nearest-to-the-door first');
  g.update(0.016, new THREE.Vector3(0, 1.6, -2), 0);
  const after = slots.map((x) => queuedPrio(x.m.entry.id)).filter((x) => x !== undefined);
  expect(after.every((x) => x! < 1000), 'walking in did not move the room\'s loads to the front');
  console.log(`     ${queued.length} loads queued at build (prio ${Math.round(byPrio[0].p!)}..${Math.round(byPrio[byPrio.length - 1].p!)}), after entering ${Math.round(Math.min(...(after as number[])))}..`);
  g.dispose();
  if (!had) delete g0.Worker;
});
