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
