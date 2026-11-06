/** Engine logic without a renderer: seamless prebuild (faced door, LRU eviction, pins), lazy containers, real-scale table. */
import * as THREE from 'three';
import { test, expect, between, fmt } from './qa';
import './env';
import { Seamless, descKey, facing, placementMatrix } from '../src/seamless';
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
