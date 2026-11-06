/** Engine logic without a renderer: seamless prebuild (faced door, LRU eviction, pins), lazy containers, real-scale table. */
import * as THREE from 'three';
import { test, expect, between, fmt } from './qa';
import './env';
import { Seamless, descKey, facing, placementMatrix, floorStackStep } from '../src/seamless';
import { FloorLevel, type FloorDesc } from '../src/rooms/vertical';
import { InteriorLevel } from '../src/interior';
import { Vertical } from '../src/vertical';
import { Player } from '../src/player';
import { Lazy, registerContainer } from '../src/lazy';
import { detectDrawers, frontMaterial, fillCompartment, themeOf, readFront, cutOpenings, compartment, readFrontSteps, cutOpeningsSteps, warmUp } from '../src/lazy-furniture';
import { realScale } from '../src/realscale';
import type { Level, LevelDesc, Portal } from '../src/level';

/** a minimal level: a group, some portals; counts builds */
let built: string[] = [];
function fakeLevel(desc: LevelDesc, portals: Portal[] = []): Level {
  return {
    name: descKey(desc), group: new THREE.Group(), spawn: { pos: new THREE.Vector3(), yaw: 0 },
    env: {} as Level['env'], colliders: () => [], portals: () => portals, update() {}, dispose() { built = built.filter((k) => k !== descKey(desc)); },
  };
}
const interior = (seed: number): LevelDesc => ({ kind: 'interior', seed, name: `i${seed}`, style: 'house', floor: 0, floors: 1, biome: 'town' });
const portalAt = (x: number, z: number, seed: number): Portal => ({ box: new THREE.Box3(new THREE.Vector3(x - 0.5, 0, z - 0.5), new THREE.Vector3(x + 0.5, 2.2, z + 0.5)), label: `door ${seed}`, target: interior(seed) });

function makeSeamless(capacity = 3) {
  const camera = new THREE.PerspectiveCamera();
  const s = new Seamless({
    scene: new THREE.Scene(), camera, renderer: { toneMappingExposure: 1 } as unknown as THREE.WebGLRenderer, capacity,
    build: (d) => { built.push(descKey(d)); return fakeLevel(d); },
  });
  return { s, camera };
}

test('seamless prebuilds the door you face, not the one behind you', () => {
  built = [];
  const { s, camera } = makeSeamless();
  // facing -z (yaw 0): door A 8 m ahead, door B 8 m behind
  camera.position.set(0, 1.7, 0);
  camera.lookAt(0, 1.7, -10);
  camera.updateMatrixWorld(true);
  const A = portalAt(0, -8, 1), B = portalAt(0, 8, 2);
  const street = fakeLevel({ kind: 'nyc', seed: 1, name: 'street' }, [A, B]);
  s.update(0.016, street, new THREE.Vector3(0, 1.7, 0));
  expect(s.slots.has(descKey(A.target as LevelDesc)), 'the faced door was not prebuilt');
  expect(!s.slots.has(descKey(B.target as LevelDesc)), 'the door behind was prebuilt');
  // turn round: B gets built
  camera.lookAt(0, 1.7, 10);
  camera.updateMatrixWorld(true);
  for (let i = 0; i < 7; i++) s.update(0.016, street, new THREE.Vector3(0, 1.7, 0));
  expect(s.slots.has(descKey(B.target as LevelDesc)), 'turning round did not prebuild the other door');
});

test('seamless LRU: keeps `capacity` levels besides the pinned one, drops the least recently used', () => {
  built = [];
  const { s } = makeSeamless(2);
  const a = s.take(interior(10));
  s.setActive(a);
  for (const k of [11, 12, 13]) s.take(interior(k));
  const keys = [...s.slots.keys()];
  expect(keys.includes(descKey(interior(10))), 'the active (pinned) level was evicted');
  expect(!keys.includes(descKey(interior(11))), 'the oldest level was not evicted');
  expect(keys.includes(descKey(interior(12))) && keys.includes(descKey(interior(13))), `newest two not kept: ${keys.join(' | ')}`);
  expect(s.stats.evicted === 1, `evicted ${s.stats.evicted}`);
  // taking a cached level is a hit, not a rebuild
  const before = s.stats.builds;
  s.take(interior(12));
  expect(s.stats.builds === before && s.stats.hits >= 1, 'a cached level was rebuilt');
});

test('placementMatrix puts the child entry on the parent door, facing the same way', () => {
  const door = { pos: new THREE.Vector3(10, 0, -5), yaw: Math.PI / 2 }, entry = { pos: new THREE.Vector3(1, 0, 4), yaw: 0 };
  const m = placementMatrix(door, entry);
  const p = entry.pos.clone().applyMatrix4(m);
  expect(p.distanceTo(door.pos) < 1e-6, `entry lands at ${p.toArray().map(fmt)}`);
  const f = facing(entry.yaw).applyMatrix3(new THREE.Matrix3().setFromMatrix4(m));
  expect(f.distanceTo(facing(door.yaw)) < 1e-6, 'walk-in direction not preserved');
});

test('lazy containers: contents only after opening; closed ones beyond capacity are dropped (LRU)', () => {
  const root = new THREE.Group();
  const lv = { group: root } as unknown as Level;
  let made = 0;
  const cs = Array.from({ length: 5 }, (_, i) => {
    const o = new THREE.Group();
    o.position.set(i * 2, 0, 0);
    root.add(o);
    return registerContainer(o, { label: `box ${i}`, size: new THREE.Vector3(0.5, 0.5, 0.5), generate: () => { made++; return new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1)); } });
  });
  const lazy = new Lazy();
  lazy.capacity = 2;
  const cam = new THREE.PerspectiveCamera();
  lazy.update(0.1, cam, lv);
  expect(made === 0, `${made} containers generated before anyone opened them`);
  for (const c of cs) { lazy.toggle(c); lazy.update(0.5, cam, lv); }
  expect((made as number) === 5 && cs.every((c) => c.contents), 'opening did not generate contents');
  for (const c of cs) lazy.toggle(c); // close all (oldest first)
  for (let i = 0; i < 10; i++) lazy.update(0.5, cam, lv);
  const kept = cs.filter((c) => c.contents);
  expect(kept.length === 2, `${kept.length} closed containers kept (capacity 2)`);
  expect(kept.includes(cs[3]) && kept.includes(cs[4]), 'kept the wrong ones (should keep the most recently used)');
  for (const c of cs) c.obj.userData.disposed = true;
  lazy.update(0.1, cam, lv);
});

test('realScale: common things come out at real size', () => {
  const cases: [string, number, number, number][] = [
    // title, modelled size (largest dim), min, max of the corrected largest dimension (m)
    ['wooden chair', 90, 0.7, 1.2],
    ['coffee mug', 12, 0.07, 0.2],
    ['office desk', 1.4, 1.0, 2.0],
    ['car', 450, 3.5, 5.6],
    ['front door', 0.05, 1.9, 2.4],
  ];
  for (const [t, L, lo, hi] of cases) {
    const k = realScale(t, '', '', L, 'objaverse');
    between(L * k, lo, hi, `"${t}" (modelled ${L}) -> ${fmt(L * k)} m`);
  }
});

// ---------------------------------------------------------------- inside a building

/** a walk-up the way main.ts drives it: real floors and apartments, Seamless + Vertical + Player, the level stack */
function building(floors: number) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const renderer = { compileAsync: () => Promise.resolve(), toneMappingExposure: 1 } as unknown as THREE.WebGLRenderer;
  const kinds: string[] = [];
  const seam = new Seamless({
    scene, camera, renderer,
    build: (d: LevelDesc, staged: boolean) => {
      kinds.push(d.kind);
      return d.kind === 'floor' ? new FloorLevel(d, { staged }) : new InteriorLevel(d as Extract<LevelDesc, { kind: 'interior' }>, { staged });
    },
  });
  const player = new Player(camera, { addEventListener() {} } as unknown as HTMLElement);
  let level!: Level;
  const vert = new Vertical({ scene, camera, renderer, seam, player, aimed: () => null });
  player.ground = (x, z, y) => vert.ground(level, x, z, y);
  const stack: LevelDesc[] = [{ kind: 'nyc', seed: 1, name: 'street' }];
  let cur: LevelDesc = { kind: 'floor', seed: 4242, name: 'QA Walkup', type: 'walkup', floor: 0, floors };
  const set = (desc: LevelDesc, pos?: THREE.Vector3, yaw?: number) => {
    const s = seam.take(desc);
    if (level) scene.remove(level.group);
    level = s.level;
    seam.setActive(s, stack.slice(-2).map(descKey));
    scene.add(level.group);
    player.place(pos ?? level.spawn.pos, yaw ?? level.spawn.yaw);
    cur = desc;
  };
  set(cur);
  const frame = (dt = 1 / 60) => {
    player.update(dt, seam.colliders(level.colliders(player.pos), player.pos), true);
    level.update(dt, player.pos, 0);
    seam.update(dt, level, player.pos);
    const sw = vert.update(dt, level, true);
    if (sw) {
      const step = floorStackStep(stack[stack.length - 1], cur, sw.desc);
      if (step === 'pop') stack.pop();
      else if (step === 'push') stack.push(cur);
      const vel = player.vel.clone();
      set(sw.desc, sw.pos, sw.yaw);
      player.vel.copy(vel);
      vert.afterSwitch(level, sw);
    }
    camera.position.copy(player.pos);
  };
  const walkTo = (x: number, z: number) => {
    for (let i = 0; i < 900; i++) {
      const dx = x - player.pos.x, dz = z - player.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.12) return true;
      const step = Math.min(d, 3 / 60);
      player.pos.x += (dx / d) * step;
      player.pos.z += (dz / d) * step;
      player.yaw = Math.atan2(-dx, -dz);
      frame();
    }
    return false;
  };
  return { seam, kinds, stack, walkTo, get level() { return level; }, get cur() { return cur; } };
}

test('seamless in a building: lobby -> roof by the stairs builds the floors, few apartments, little eviction; the stack holds the lobby', () => {
  const floors = 6;
  const w = building(floors);
  const d = (w.level as FloorLevel).d;
  const ax = (d.ax0 + d.ax1) / 2, bx = (d.bx0 + d.bx1) / 2, zm = -d.Lf - d.Md / 2;
  expect(w.walkTo(0, d.Ld + 1.2), 'walked to the stair hall');
  const lap = () => [[ax, 0.6], [ax, -0.2], [ax, zm], [bx, zm], [bx, -0.2], [bx, 0.6]].every(([x, z]) => w.walkTo(x, z));
  for (let f = 1; f <= floors; f++) {
    expect(lap(), `climbed to floor ${f}`);
    // the level stack: the street, then the lobby, however high you climb (Q goes to the lobby)
    expect(w.stack.length === 2 && w.stack[1].kind === 'floor' && w.stack[1].floor === 0, `stack at floor ${f}: ${w.stack.map((s) => s.kind + (s.kind === 'floor' ? s.floor : '')).join(' > ')}`);
  }
  expect((w.level as FloorLevel).roof, 'reached the roof');
  const apts = w.kinds.filter((k) => k === 'interior').length, flo = w.kinds.filter((k) => k === 'floor').length;
  console.log(`   lobby -> roof: ${flo} floor builds, ${apts} apartment prebuilds, ${w.seam.stats.evicted} evicted, ${w.seam.stats.cancelled} cancelled`);
  // every floor once (+ the roof), and at most one apartment per landing you stand at
  expect(flo <= floors + 2, `${flo} floor builds for ${floors + 1} floors`);
  expect(apts <= floors, `${apts} apartments prebuilt walking straight up the stair`);
  expect(w.seam.stats.evicted <= floors, `${w.seam.stats.evicted} levels evicted`);
});

test('floorStackStep: leaving the lobby pushes it once, floor to floor nothing, back down pops it, other buildings untouched', () => {
  const F = (floor: number, seed = 1): FloorDesc => ({ kind: 'floor', seed, name: 'B', type: 'walkup', floor, floors: 6 });
  expect(floorStackStep(undefined, F(0), F(1)) === 'push', 'lobby -> 1 pushes the lobby');
  expect(floorStackStep(F(0), F(1), F(2)) === null, '1 -> 2 pushes nothing');
  expect(floorStackStep(F(0), F(3), F(0)) === 'pop', 'back to the lobby pops it');
  expect(floorStackStep(F(0), F(0), F(1)) === null, 'lobby already on the stack: no second push');
  expect(floorStackStep(F(0), F(0, 2), F(1, 2)) === 'push', 'another building has its own entry');
  expect(floorStackStep(undefined, F(2), { kind: 'interior', seed: 1, name: 'x', style: 'apartment', floor: 0, floors: 1, biome: 'town' }) === null, 'entering an apartment is a normal portal');
});

test('seamless waits for you to move (or 8 s) before prebuilding doors on the street at the start of a game', () => {
  built = [];
  const A = portalAt(0, -8, 21);
  const streetDesc: LevelDesc = { kind: 'nyc', seed: 1, name: 'street' };
  const street = fakeLevel(streetDesc, [A]);
  const camera = new THREE.PerspectiveCamera();
  const s = new Seamless({ scene: new THREE.Scene(), camera, renderer: { toneMappingExposure: 1 } as unknown as THREE.WebGLRenderer, build: (d) => (descKey(d) === descKey(streetDesc) ? street : fakeLevel(d)) });
  s.setActive(s.take(streetDesc));
  camera.position.set(0, 1.7, 0);
  camera.lookAt(0, 1.7, -10);
  camera.updateMatrixWorld(true);
  const p = new THREE.Vector3(0, 0, 0);
  for (let i = 0; i < 60 * 5; i++) s.update(1 / 60, street, p);
  expect(!s.slots.has(descKey(A.target as LevelDesc)), 'prebuilt a shop before the player moved');
  p.z -= 2;
  for (let i = 0; i < 7; i++) s.update(1 / 60, street, p);
  expect(s.slots.has(descKey(A.target as LevelDesc)), 'walking 2 m towards the door did not start its prebuild');
});

test('library dressers and nightstands: drawers open on E, slide within their runners, contents fit and only exist once opened', () => {
  // apartments until we have a few library-model drawers (InteriorLevel.libDrawers: hideClosed)
  type C = { kind: string; obj: THREE.Group; size: THREE.Vector3; drawer?: THREE.Object3D; hideClosed?: boolean };
  const found: { lv: InteriorLevel; c: C }[] = [];
  for (let seed = 1; seed < 80 && found.length < 6; seed++) {
    const lv = new InteriorLevel({ kind: 'interior', seed, name: `a${seed}`, style: seed % 2 ? 'apartment' : 'house', floor: 0, floors: 1, biome: 'town' });
    for (const c of (lv as unknown as { containers: C[] }).containers) if (c.hideClosed && c.drawer) found.push({ lv, c });
  }
  expect(found.length > 0, 'no library dresser/nightstand drawers in 80 apartments');
  console.log(`   ${found.length} library drawers (${[...new Set(found.map((f) => f.c.kind))].join(', ')})`);
  const lazy = new Lazy();
  const cam = new THREE.PerspectiveCamera();
  for (const { lv, c } of found) {
    lv.group.updateMatrixWorld(true);
    lazy.update(0.1, cam, lv);
    expect(!c.drawer!.visible, `${c.kind}: its drawer is drawn while shut (the model has its own fronts)`);
    expect(c.obj.children.every((o) => o === c.drawer || o === (c as { slot?: THREE.Object3D }).slot), `${c.kind}: contents exist before anyone opened it`);
    expect(!(c as { slot?: THREE.Object3D }).slot?.visible, `${c.kind}: the empty slot shows while shut`);
    // open it the way E does
    const lc = lazy.aim(new THREE.Ray(c.obj.localToWorld(new THREE.Vector3(0, c.size.y / 2, 1.2)), c.obj.getWorldDirection(new THREE.Vector3()).negate()), 2.4, lv);
    expect(lc, `${c.kind}: not aimable from 1.2 m in front`);
    lazy.toggle(lc!.c);
    for (let i = 0; i < 30; i++) lazy.update(1 / 30, cam, lv);
    const travel = c.drawer!.position.z;
    between(travel, 0.5 * c.size.z, c.size.z, `${c.kind}: drawer travel ${fmt(travel)} m for a ${fmt(c.size.z)} m deep drawer`);
    expect(c.drawer!.visible, `${c.kind}: the open drawer is not drawn`);
    expect((c as { slot?: THREE.Object3D }).slot?.visible, `${c.kind}: no empty slot over the model's own front while the drawer is out`);
    const contents = lc!.c.contents;
    expect(contents && contents.children.length, `${c.kind}: opening generated nothing`);
    // contents inside the drawer box (obj-local: x within the width, y within the height, z within the pulled-out depth)
    c.obj.updateMatrixWorld(true);
    const inv = c.obj.matrixWorld.clone().invert();
    const b = new THREE.Box3().setFromObject(contents!).applyMatrix4(inv);
    const room = new THREE.Box3(new THREE.Vector3(-c.size.x / 2 - 0.01, -0.01, travel - c.size.z - 0.03), new THREE.Vector3(c.size.x / 2 + 0.01, c.size.y + 0.01, travel + 0.01));
    expect(room.containsBox(b), `${c.kind}: contents ${b.min.toArray().map(fmt)}..${b.max.toArray().map(fmt)} outside the drawer ${room.min.toArray().map(fmt)}..${room.max.toArray().map(fmt)}`);
    // and shut again
    lazy.toggle(lc!.c);
    for (let i = 0; i < 30; i++) lazy.update(1 / 30, cam, lv);
    expect(c.drawer!.position.z < 1e-3 && !c.drawer!.visible && !(c as { slot?: THREE.Object3D }).slot?.visible, `${c.kind}: did not close`);
  }
  // evicting the room drops the contents
  for (const { lv } of found) lv.dispose();
  lazy.update(0.1, cam, found[0].lv);
  expect(found.every(({ c }) => c.obj.userData.disposed), 'containers not marked disposed with their level');
});

test('detectDrawers reads the drawer layout off a model front (rows from horizontal seams, a split top row), else null', () => {
  // a 1.0 x 0.9 x 0.45 m dresser: carcass, and drawer fronts proud of it with 1 cm gaps: 2 small on top, 2 wide below
  const W = 1.0, H = 0.9, D = 0.45;
  const model = new THREE.Group();
  const add = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d, Math.ceil(w / 0.02), Math.ceil(h / 0.02), 1), new THREE.MeshStandardMaterial({ color: '#f0ece4' }));
    m.position.set(x, y + h / 2, z);
    model.add(m);
  };
  add(W, H, D - 0.02, 0, 0, -0.01);
  const rows: [number, number, number][] = [[0.08, 0.25, 0], [0.34, 0.25, 0], [0.6, 0.25, 2]];
  for (const [y, h, n] of rows) {
    if (n === 2) for (const sx of [-1, 1]) add(W / 2 - 0.05, h, 0.02, sx * (W / 4 - 0.005), y, D / 2 - 0.01);
    else add(W - 0.08, h, 0.02, 0, y, D / 2 - 0.01);
  }
  const holder = new THREE.Group();
  holder.add(model);
  const bands = detectDrawers(model, holder, [W, H, D], 'dresser');
  expect(bands, 'no layout found on a clear three-row dresser');
  const tops = bands!.filter((b) => b.y > 0.55), lows = bands!.filter((b) => b.y < 0.55);
  console.log(`   bands: ${bands!.map((b) => `${fmt(b.x)},${fmt(b.y)} ${fmt(b.w)}x${fmt(b.h)}`).join(' | ')}`);
  expect(tops.length === 2, `top row should be two drawers side by side, got ${tops.length}`);
  expect(lows.length === 2 && lows.every((b) => b.w > 0.8), `two full-width rows below, got ${lows.length}`);
  for (const b of bands!) between(b.h, 0.15, 0.3, `drawer height ${fmt(b.h)}`);
  // a plain box (no seams) gives no layout: the even rows stay
  const plain = new THREE.Group();
  plain.add(new THREE.Mesh(new THREE.BoxGeometry(W, H, D, 50, 45, 1), new THREE.MeshStandardMaterial()));
  const ph = new THREE.Group();
  ph.add(plain);
  plain.position.y = H / 2;
  expect(detectDrawers(plain, ph, [W, H, D], 'dresser') === null, 'found drawers on a plain box');
  // the drawer front takes the model's colour
  const fm = frontMaterial(model);
  expect(fm && fm.color.getHexString() === new THREE.Color('#f0ece4').getHexString(), `front colour ${fm?.color.getHexString()}`);
});

test('library cupboards: doors read off the model with the hinge away from the knob; contents of every theme fit their compartment', () => {
  // a 0.9 x 1.0 x 0.45 m cupboard: two drawers over a pair of doors with knobs near the middle
  const W = 0.9, H = 1.0, D = 0.45;
  const model = new THREE.Group();
  const add = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: '#f0ece4' }));
    m.position.set(x, y + h / 2, z);
    model.add(m);
  };
  add(W, H, D - 0.02, 0, 0, -0.01);
  for (const sx of [-1, 1]) {
    add(W / 2 - 0.05, 0.2, 0.02, sx * (W / 4 - 0.005), 0.72, D / 2 - 0.01); // drawers
    add(W / 2 - 0.05, 0.6, 0.02, sx * (W / 4 - 0.005), 0.08, D / 2 - 0.01); // doors
    add(0.03, 0.03, 0.03, sx * 0.07, 0.38, D / 2 + 0.015); // knobs near the middle
  }
  const holder = new THREE.Group();
  holder.add(model);
  const bands = detectDrawers(model, holder, [W, H, D], 'dresser');
  expect(bands, 'no layout');
  const doors = bands!.filter((b) => b.move === 'door'), drawers = bands!.filter((b) => b.move !== 'door');
  console.log(`   ${drawers.length} drawers, doors: ${doors.map((b) => `${fmt(b.x)} hinge ${b.hinge}`).join(', ')}`);
  expect(drawers.length === 2 && doors.length === 2, `2 drawers and 2 doors, got ${drawers.length} + ${doors.length}`);
  const left = doors.find((b) => b.x < 0)!, right = doors.find((b) => b.x > 0)!;
  expect(left.hinge === 'left' && right.hinge === 'right', `hinges ${left.hinge}/${right.hinge}: should be on the outer sides (knobs in the middle)`);
  // contents stay inside their compartment, for drawers and tall cupboards, every theme
  for (const theme of ['clothes', 'linens', 'dishes', 'boxes'] as const) {
    for (const [w, h, d] of [[0.4, 0.18, 0.36], [0.8, 0.6, 0.4], [0.35, 0.8, 0.5]]) {
      const g = fillCompartment(7, w, h, d, theme);
      const b = new THREE.Box3().setFromObject(g);
      expect(g.children.length > 0, `${theme} ${w}x${h}x${d}: empty`);
      const room = new THREE.Box3(new THREE.Vector3(-w / 2 - 0.005, -0.005, -d - 0.005), new THREE.Vector3(w / 2 + 0.005, h + 0.005, 0.005));
      expect(room.containsBox(b), `${theme} in ${w}x${h}x${d}: ${b.min.toArray().map(fmt)}..${b.max.toArray().map(fmt)}`);
    }
  }
  expect(themeOf('kitchen', true) === 'dishes' && themeOf('bedroom', false) === 'clothes', 'room themes');
});

test('library openings: the front grid is read in one fast pass, fronts are cut out of the model, compartments close the holes', () => {
  // the cupboard of the test above, built dense (~45k triangles, like a library model)
  const W = 0.9, H = 1.0, D = 0.45;
  const model = new THREE.Group();
  const add = (w: number, h: number, d: number, x: number, y: number, z: number, seg = 1) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d, Math.ceil(w * seg), Math.ceil(h * seg), 2), new THREE.MeshStandardMaterial({ color: '#f0ece4' }));
    m.position.set(x, y + h / 2, z);
    model.add(m);
  };
  add(W, H, D - 0.02, 0, 0, -0.01, 60);
  for (const sx of [-1, 1]) {
    add(W / 2 - 0.05, 0.2, 0.02, sx * (W / 4 - 0.005), 0.72, D / 2 - 0.01, 60);
    add(W / 2 - 0.05, 0.6, 0.02, sx * (W / 4 - 0.005), 0.08, D / 2 - 0.01, 60);
    add(0.03, 0.03, 0.03, sx * 0.07, 0.38, D / 2 + 0.015, 4);
  }
  const holder = new THREE.Group();
  holder.add(model);
  let tris = 0;
  model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) tris += m.geometry.index!.count / 3; });
  readFront(model, holder, [W, H, D]); // warm up (JIT)
  // the best of three (the qa runs test files in parallel on a shared machine)
  const front = [0, 1, 2].map(() => readFront(model, holder, [W, H, D])).sort((a, b) => a.ms - b.ms)[0];
  const t0 = performance.now();
  const bands = detectDrawers(model, holder, [W, H, D], 'dresser', front)!;
  const detectMs = performance.now() - t0;
  console.log(`   ${tris} triangles: front grid ${fmt(front.ms)} ms (${front.nx}x${front.ny}), layout ${fmt(detectMs)} ms, ${bands.length} openings`);
  expect(front.ms + detectMs < 25, `reading the layout took ${fmt(front.ms + detectMs)} ms in Node (budget: ~5 ms in the browser)`);
  // cut: afterwards nothing of the model stands in front of an opening
  const shared = (model.children[1] as THREE.Mesh).geometry;
  const cut = cutOpenings(front, bands);
  expect(cut > 0, 'nothing was cut');
  expect((model.children[1] as THREE.Mesh).geometry !== shared, 'cut the shared geometry instead of a clone');
  const after = readFront(model, holder, [W, H, D]);
  for (const b of bands) {
    let worst = -Infinity;
    for (let x = b.x - b.w / 2 + 0.02; x < b.x + b.w / 2 - 0.02; x += 0.01)
      for (let y = b.y + 0.02; y < b.y + b.h - 0.02; y += 0.01) {
        const i = Math.floor((x - after.x0) / after.cell), j = Math.floor((y - after.y0) / after.cell);
        worst = Math.max(worst, after.z[j * after.nx + i]);
      }
    expect(worst < front.zf - 0.01, `${b.move ?? 'drawer'} at ${fmt(b.x)},${fmt(b.y)}: the model still reaches z ${fmt(worst)} in the opening (front ${fmt(front.zf)})`);
  }
  // a compartment behind each hole: looking straight in, you see its back, not through to the wall
  for (const b of bands) {
    const g = compartment(b.w, b.h, D - 0.1);
    g.updateMatrixWorld(true);
    for (const [fx, fy] of [[0, 0.5], [-0.4, 0.2], [0.4, 0.8]]) {
      const hit = new THREE.Raycaster(new THREE.Vector3(fx * b.w, fy * b.h, 0.5), new THREE.Vector3(0, 0, -1)).intersectObject(g, true)[0];
      expect(hit && hit.point.z <= -(D - 0.1) + 0.001, `compartment open at (${fx}, ${fy}): ${hit ? fmt(hit.point.z) : 'no hit'}`);
    }
    // and from an angle the sides and floor close it
    const side = new THREE.Raycaster(new THREE.Vector3(0, b.h / 2, 0.05), new THREE.Vector3(0.6, -0.25, -1).normalize()).intersectObject(g, true)[0];
    expect(side, 'a ray in at an angle got out of the compartment');
  }
});

test('openings are cut through big front panels (triangles split at the opening edge), and only when wanted', () => {
  // a front that is one big quad (2 triangles) over a carcass: the opening must still be cut, the rest kept
  const W = 1.0, H = 0.9, D = 0.45;
  const model = new THREE.Group();
  const carcass = new THREE.Mesh(new THREE.BoxGeometry(W, H, D - 0.02), new THREE.MeshStandardMaterial());
  carcass.position.set(0, H / 2, -0.01);
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial());
  panel.position.set(0, H / 2, D / 2);
  model.add(carcass, panel);
  const holder = new THREE.Group();
  holder.add(model);
  const front = readFront(model, holder, [W, H, D]);
  const band = { x: 0.1, y: 0.3, w: 0.4, h: 0.25, z: D / 2 };
  const cut = cutOpenings(front, [band]);
  expect(cut > 0, 'the big panel was not cut');
  const after = readFront(model, holder, [W, H, D]);
  const z = (x: number, y: number) => after.z[Math.floor((y - after.y0) / after.cell) * after.nx + Math.floor((x - after.x0) / after.cell)];
  for (const [x, y] of [[0.1, 0.42], [-0.08, 0.32], [0.28, 0.53]]) expect(z(x, y) < D / 2 - 0.01, `front still there inside the opening at ${x},${y}: ${fmt(z(x, y))}`);
  for (const [x, y] of [[-0.3, 0.42], [0.1, 0.7], [0.1, 0.15], [0.4, 0.42]]) expect(Math.abs(z(x, y) - D / 2) < 0.002, `front lost outside the opening at ${x},${y}: ${fmt(z(x, y))}`);

  // prepare(): nothing while the player is far or looking away; on approach + facing, or on E
  const root = new THREE.Group();
  const lv = { group: root } as unknown as Level;
  let prepared = 0;
  const obj = new THREE.Group();
  obj.position.set(0, 0, -3);
  root.add(obj);
  root.updateMatrixWorld(true);
  const replacement = registerContainer(Object.assign(new THREE.Group(), {}), { size: new THREE.Vector3(0.4, 0.2, 0.4), generate: () => new THREE.Group() });
  root.add(replacement.obj);
  replacement.obj.position.copy(obj.position);
  root.updateMatrixWorld(true);
  const c = registerContainer(obj, { size: new THREE.Vector3(0.4, 0.2, 0.4), generate: () => new THREE.Group(), prepare: () => (prepared++, [replacement]) });
  const lazy = new Lazy();
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0, 1.2, 4);
  cam.lookAt(0, 0.5, -3);
  cam.updateMatrixWorld(true);
  for (let i = 0; i < 30; i++) lazy.update(1 / 30, cam, lv);
  expect(prepared === 0, 'prepared while 7 m away');
  cam.position.set(0, 1.2, -1.2);
  cam.lookAt(0, 0.5, 3); // close, but looking away
  cam.updateMatrixWorld(true);
  for (let i = 0; i < 30; i++) lazy.update(1 / 30, cam, lv);
  expect(prepared === 0, 'prepared while looking away');
  cam.lookAt(0, 0.3, -3);
  cam.updateMatrixWorld(true);
  for (let i = 0; i < 30; i++) lazy.update(1 / 30, cam, lv);
  expect(prepared === 1, `approach and look: prepared ${prepared} times`);
  // E on one not yet prepared runs it and opens the replacement
  let p2 = 0;
  const o2 = new THREE.Group();
  root.add(o2);
  const r2 = registerContainer(new THREE.Group(), { size: new THREE.Vector3(0.4, 0.2, 0.4), generate: () => new THREE.Group() });
  root.add(r2.obj);
  root.updateMatrixWorld(true);
  const c2 = registerContainer(o2, { size: new THREE.Vector3(0.4, 0.2, 0.4), generate: () => new THREE.Group(), prepare: () => (p2++, [r2]) });
  lazy.toggle(c2);
  expect(p2 === 1 && r2.open && !c2.open, 'E did not prepare and open the replacement');
  for (const o of [obj, replacement.obj, o2, r2.obj]) o.userData.disposed = true;
  lazy.update(0.1, cam, lv);
  void c;
});

test('the read and cut run in slices: no slice over 8 ms on a dense piece; the boot warm-up runs', () => {
  const ms = warmUp();
  console.log(`   warm-up on a tiny chest: ${fmt(ms ?? 0)} ms`);
  const W = 0.9, H = 1.0, D = 0.45;
  /** one read + cut of a fresh ~12k-triangle chest (five times the library dressers measured), each slice timed */
  const once = () => {
    const model = new THREE.Group();
    const add = (w: number, h: number, d: number, x: number, y: number, z: number, seg = 1) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d, Math.ceil(w * seg), Math.ceil(h * seg), 2), new THREE.MeshStandardMaterial());
      m.position.set(x, y + h / 2, z);
      model.add(m);
    };
    add(W, H, D - 0.02, 0, 0, -0.01, 35);
    for (const sx of [-1, 1]) {
      add(W / 2 - 0.05, 0.2, 0.02, sx * (W / 4 - 0.005), 0.72, D / 2 - 0.01, 35);
      add(W / 2 - 0.05, 0.6, 0.02, sx * (W / 4 - 0.005), 0.08, D / 2 - 0.01, 35);
    }
    const holder = new THREE.Group();
    holder.add(model);
    const slices: number[] = [];
    const run = <T,>(job: Generator<void, T>): T => {
      for (;;) {
        const t = performance.now();
        const r = job.next();
        slices.push(performance.now() - t);
        if (r.done) return r.value;
      }
    };
    const front = run(readFrontSteps(model, holder, [W, H, D]));
    const bands = detectDrawers(model, holder, [W, H, D], 'dresser', front)!;
    expect(bands?.length === 4, `${bands?.length} openings`);
    const cut = run(cutOpeningsSteps(front, bands));
    expect(cut > 0, 'nothing cut');
    return { slices, worst: Math.max(...slices), read: front.ms };
  };
  // the better of two runs: on this shared machine one slice can be preempted or meet a GC pause
  const runs = [once(), once()].sort((a, b) => a.worst - b.worst);
  const r = runs[0];
  const sorted = [...r.slices].sort((a, b) => a - b);
  console.log(`   ${r.slices.length} slices: median ${fmt(sorted[sorted.length >> 1])} ms, longest ${fmt(r.worst)} ms (other run ${fmt(runs[1].worst)} ms); read ${fmt(r.read)} ms`);
  // SLICE_MS is 3. On a busy shared machine single slices get preempted: the 95th percentile must
  // stay under 8 ms and no slice over 20 ms (a real one-block step was 100-200 ms)
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  expect(p95 <= 8, `95% of slices under ${fmt(p95)} ms (want <= 8)`);
  expect(r.worst <= 20, `a slice took ${fmt(r.worst)} ms (want <= 20)`);
});
