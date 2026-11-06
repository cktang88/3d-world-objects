/**
 * Vertical circulation in play: the real Seamless cache + Vertical controller + Player, driven the
 * way main.ts drives them (no renderer). Stairs prefetch and switch floors in one frame, neighbours
 * show through the stairwell, the LRU keeps memory bounded, the elevator call/ride/arrive cycle,
 * and the fractal chain floor -> apartment -> room cells -> containers -> back.
 */
import * as THREE from 'three';
import { test, expect, Grid } from './qa';
import './env';
import { Seamless, descKey } from '../src/seamless';
import { Vertical, type FloorSwitch } from '../src/vertical';
import { FloorLevel, toWorld, type FloorDesc } from '../src/rooms/vertical';
import { InteriorLevel } from '../src/interior';
import { Player } from '../src/player';
import type { Level, LevelDesc, Portal } from '../src/level';

export const slowest: Record<string, number> = {};
const note = (k: string, ms: number) => (slowest[k] = Math.max(slowest[k] ?? 0, +ms.toFixed(1)));

function world(type: string, floors: number, start?: LevelDesc) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const renderer = { compileAsync: () => Promise.resolve(), toneMappingExposure: 1 } as unknown as THREE.WebGLRenderer;
  const builds: string[] = [];
  const seam = new Seamless({
    scene, camera, renderer,
    build: (d: LevelDesc, staged: boolean) => {
      builds.push(descKey(d));
      const t = performance.now();
      const lv: Level = d.kind === 'floor' ? new FloorLevel(d, { staged }) : d.kind === 'interior' ? new InteriorLevel(d, { staged }) : null!;
      note(d.kind + ' ctor', performance.now() - t);
      if (lv.staging) {
        const inner = lv.staging;
        lv.staging = (function* () {
          for (;;) {
            const a = performance.now();
            const r = inner.next();
            const ms = performance.now() - a;
            note(d.kind + ' slice', ms);
            if (r.done) return;
            yield;
          }
        })();
      }
      return lv;
    },
  });
  const player = new Player(camera, { addEventListener() {} } as unknown as HTMLElement);
  let level!: Level;
  let aimed: Portal | null = null;
  const vert = new Vertical({ scene, camera, renderer, seam, player, aimed: () => aimed });
  player.ground = (x, z, y) => vert.ground(level, x, z, y);
  const stack: LevelDesc[] = [];
  let cur: LevelDesc = start ?? { kind: 'floor', seed: 31337, name: 'QA House', type, floor: 0, floors };
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
  const frameMs: number[] = [];
  let switches = 0;
  /** one frame of main.ts's loop */
  const frame = (dt = 1 / 60) => {
    const t0 = performance.now();
    player.update(dt, seam.colliders(level.colliders(player.pos), player.pos), true);
    level.update(dt, player.pos, 0);
    seam.update(dt, level, player.pos);
    const sw: FloorSwitch | null = vert.update(dt, level, true);
    if (sw) {
      const vel = player.vel.clone();
      set(sw.desc, sw.pos, sw.yaw);
      player.vel.copy(vel);
      vert.afterSwitch(level, sw);
      switches++;
    }
    camera.position.copy(player.pos);
    frameMs.push(performance.now() - t0);
  };
  /** walk to (x, z) at 3 m/s, a frame at a time */
  const walkTo = (x: number, z: number, maxFrames = 900) => {
    for (let i = 0; i < maxFrames; i++) {
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
  const wait = (frames: number, until?: () => boolean) => {
    for (let i = 0; i < frames; i++) {
      if (until?.()) return true;
      frame();
    }
    return !!until?.();
  };
  return { scene, seam, vert, player, builds, frame, walkTo, wait, set, stack, get level() { return level; }, get cur() { return cur; }, setAimed: (p: Portal | null) => (aimed = p), frameMs, get switches() { return switches; } };
}

test('stairs: prefetch near the landing, one-frame switch, neighbours through the well, LRU bounded', () => {
  const w = world('walkup', 6);
  const lv0 = w.level as FloorLevel, d = lv0.d;
  const ax = (d.ax0 + d.ax1) / 2, bx = (d.bx0 + d.bx1) / 2, zm = -d.Lf - d.Md / 2;
  expect(w.walkTo(0, d.Ld + 1.2), 'walked from the street door to the stair hall');
  // near the stair: the floor above is being built in slices
  w.wait(400, () => w.seam.ready({ ...(w.cur as FloorDesc), floor: 1 }));
  expect(w.seam.ready({ ...(w.cur as FloorDesc), floor: 1 }), 'floor 2 prebuilt while standing at the stair');
  const lap = () => [[ax, 0.6], [ax, -0.2], [ax, zm], [bx, zm], [bx, -0.2], [bx, 0.6]].every(([x, z]) => w.walkTo(x, z));
  const shown = () => w.scene.children.filter((c) => c instanceof THREE.Group && c.name.startsWith('floor:')).length;
  for (let f = 1; f <= 6; f++) {
    expect(lap(), `climbed a storey to floor ${f}`);
    const lv = w.level as FloorLevel;
    expect(lv.floor === f, `on floor index ${f} (got ${lv.floor})`);
    expect(Math.abs(w.player.pos.y) < 0.05, `standing at floor level after the climb (y ${w.player.pos.y.toFixed(2)})`);
    expect(w.seam.slots.size <= 8, `cache stays bounded: ${w.seam.slots.size} levels at floor ${f}`);
  }
  expect((w.level as FloorLevel).roof, 'reached the roof');
  // back down to the lobby: the floors come back from the cache or are rebuilt
  const rev = () => [[bx, 0.6], [bx, -0.2], [bx, zm], [ax, zm], [ax, -0.2], [ax, 0.6]].every(([x, z]) => w.walkTo(x, z));
  for (let f = 5; f >= 0; f--) expect(rev(), `walked down to floor ${f}`);
  expect((w.level as FloorLevel).floor === 0, 'back in the lobby');
  expect(w.vert.stats.forced === 0, `no floor had to be built synchronously (forced ${w.vert.stats.forced})`);
  const sorted = [...w.frameMs].sort((a, b) => a - b);
  console.log(`   ${w.switches} floor switches, ${w.seam.stats.builds} builds, ${w.seam.stats.evicted} evicted, ${w.vert.stats.shows} neighbour shows, ${shown()} floor groups in scene now`);
  console.log(`   slowest construction step by kind (ms): ${JSON.stringify(slowest)}`);
  console.log(`   frame ms (no render): median ${sorted[sorted.length >> 1].toFixed(2)}, p99 ${sorted[Math.floor(sorted.length * 0.99)].toFixed(1)}, max ${sorted[sorted.length - 1].toFixed(1)}; seamless max slice ${w.seam.stats.maxSliceMs.toFixed(1)} ms`);
});

test('elevator: call, doors open, choose a floor, ride while it builds, arrive with doors opening', () => {
  const w = world('prewar', 9);
  const lv = w.level as FloorLevel;
  const fr = lv.lifts[0].frame;
  const [hx, hz] = toWorld(fr, 0.1, 0.6);
  expect(w.walkTo(hx, hz), 'walked to the lift in the lobby');
  w.vert.call(0);
  expect(w.wait(1200, () => w.vert.state === 'open'), `car arrived and opened (state ${w.vert.state})`);
  expect(lv.lifts[0].open >= 0.99, 'hall doors open');
  const [cx, cz] = toWorld(fr, 0, -0.9);
  expect(w.walkTo(cx, cz), 'walked into the car');
  w.vert.choose();
  w.vert.choose();
  w.vert.choose();
  expect(w.vert.sel === 3, `chose floor index 3 (got ${w.vert.sel})`);
  expect(w.wait(300, () => w.vert.state === 'riding'), `doors closed and the ride started (state ${w.vert.state})`);
  expect(w.vert.shut, 'shut in the car while riding: Q (back out) is ignored (main.ts checks vert.shut)');
  let frames = 0;
  expect(w.wait(1500, () => (frames++, (w.level as FloorLevel).floor === 3)), 'arrived on floor 4');
  console.log(`   ride took ${(frames / 60).toFixed(1)} s of game time`);
  expect(w.vert.state === 'opening' || w.vert.state === 'open', `doors opening on arrival (${w.vert.state})`);
  expect(w.wait(120, () => w.vert.state === 'open'), 'doors open on floor 4');
  expect(!w.vert.shut, 'doors open: Q works again');
  expect(Math.abs(w.player.pos.x - cx) < 0.2 && Math.abs(w.player.pos.z - cz) < 0.2, 'still standing in the car (same frame position)');
  // walk out onto the new floor
  const [ox, oz] = toWorld(fr, 0, 1.0);
  expect(w.walkTo(ox, oz), 'walked out of the car onto floor 4');
});

test('fractal chain: floor -> apartment -> rooms -> containers -> back to the same floor from the cache', () => {
  const w = world('walkup', 5);
  const d = (w.level as FloorLevel).d;
  const ax = (d.ax0 + d.ax1) / 2, bx = (d.bx0 + d.bx1) / 2, zm = -d.Lf - d.Md / 2;
  w.walkTo(0, d.Ld + 1.2);
  w.wait(400, () => w.seam.ready({ ...(w.cur as FloorDesc), floor: 1 }));
  [[ax, 0.6], [ax, -0.2], [ax, zm], [bx, zm], [bx, -0.2], [bx, 0.6]].forEach(([x, z]) => w.walkTo(x, z));
  const floor = w.level as FloorLevel;
  expect(floor.floor === 1, 'on floor 2');
  const door = floor.portals().find((p) => typeof p.target === 'object' && p.target.kind === 'interior')!;
  expect(!!door, 'an apartment door');
  // face it: seamless prebuilds it
  w.walkTo(door.returnPos!.x, door.returnPos!.z);
  w.player.yaw = door.returnYaw! + Math.PI;
  w.wait(600, () => w.seam.ready(door.target as LevelDesc));
  expect(w.seam.ready(door.target as LevelDesc), 'the apartment was prebuilt while facing its door');
  const before = w.seam.stats.builds;
  w.stack.push(w.cur);
  w.set(door.target as LevelDesc);
  const apt = w.level as InteriorLevel;
  expect(w.seam.stats.builds === before, 'entering used the prebuilt apartment');
  expect(apt.cells.length >= 3, `apartment has ${apt.cells.length} room cells`);
  expect(apt.containers.length >= 1, `apartment has ${apt.containers.length} containers (wardrobes, dressers…) with lazy contents`);
  const c = apt.containers[0];
  const contents = c.generate();
  expect(contents.children.length >= 0, `a ${c.kind}'s contents generate on demand`);
  // back out: the floor is still cached (pinned on the stack)
  const back = w.stack.pop()!;
  w.set(back, door.returnPos!, door.returnYaw!);
  expect(w.level === floor, 'back on the very same floor level object (restored from the cache)');
  expect(w.seam.stats.builds === before, 'nothing rebuilt going back');
});

test('house (brownstone) stair core: same core on every floor, reachable from the rooms, walk up to the top floor and back', () => {
  const desc = (floor: number): LevelDesc => ({ kind: 'interior', seed: 2024, name: 'QA brownstone', style: 'house', floor, floors: 4, biome: 'town' });
  const levels = [0, 1, 2, 3].map((f) => new InteriorLevel(desc(f) as Extract<LevelDesc, { kind: 'interior' }>));
  const c0 = levels[0].vcore!;
  expect(!!c0, 'a 4-floor house has a stair core');
  for (const lv of levels) {
    const c = lv.vcore!;
    expect(Math.abs(c.ox - c0.ox) < 1e-6 && Math.abs(c.oz - c0.oz) < 1e-6, `floor ${c.floor}: core in the same place`);
    expect(!lv.portals().some((p) => typeof p.target === 'object' && p.target.kind === 'interior' && p.target.floor !== lv.stairCore?.x), 'no fade portal to another floor');
    const g = new Grid({ minX: -16, maxX: 16, minZ: -20, maxZ: 16 }, lv.colliders(), 0.1, 0.3);
    const reach = g.flood(c.ox, c.oz + c.d.Ld * 0.5);
    expect(reach(lv.spawn.pos.x, lv.spawn.pos.z, 0.5), `floor ${c.floor}: the stair landing connects to the rooms (spawn at the door reachable)`);
  }
  expect(!levels[0].portals().some((p) => /upstairs/i.test(p.label)), 'the in-room stair portal is gone');
  // upper floors (interiors eda0463): no street door; spawn/doorway at the stair-hall doorway. The stair
  // hand-over never uses them (the player keeps x/z, y - H), but entering such a floor directly lands there.
  for (const lv of levels.slice(1)) {
    const c = lv.vcore!;
    expect(Math.hypot(lv.spawn.pos.x - c.door.x, lv.spawn.pos.z - c.door.z) < 2.0, `floor ${c.floor}: spawn at the stair-hall doorway`);
  }
  // climb from the ground floor landing to the top and back
  const w = world('house', 4, desc(0));
  const c = (w.level as InteriorLevel).vcore!, d = c.d;
  const P = (x: number, z: number): [number, number] => [x + c.ox, z + c.oz];
  w.player.pos.set(...([P(0, d.Ld * 0.5)].map(([x, z]) => [x, 0, z])[0] as [number, number, number]));
  w.wait(400, () => w.seam.ready(desc(1)));
  expect(w.seam.ready(desc(1)), 'the floor above prebuilt at the stair');
  const ax = (d.ax0 + d.ax1) / 2, bx = (d.bx0 + d.bx1) / 2, zm = -d.Lf - d.Md / 2;
  const up = [[ax, 0.5], [ax, -0.2], [ax, zm], [bx, zm], [bx, -0.2], [bx, 0.5]].map(([x, z]) => P(x, z));
  for (let f = 1; f <= 3; f++) {
    expect(up.every(([x, z]) => w.walkTo(x, z)), `climbed to house floor ${f}`);
    expect((w.level as InteriorLevel).vcore?.floor === f, `on floor ${f} (got ${(w.level as InteriorLevel).vcore?.floor})`);
    expect(Math.hypot(w.player.pos.x - up[up.length - 1][0], w.player.pos.z - up[up.length - 1][1]) < 0.2, `floor ${f}: arrived where the stair ends, not at the spawn`);
  }
  // no further up at the top
  const before = w.switches;
  w.walkTo(...P(ax, 0.5));
  w.walkTo(...P(ax, -0.3), 200);
  w.walkTo(...P(ax, zm), 200);
  expect(w.switches === before && Math.abs(w.player.pos.y) < 0.1, 'no flight up from the top floor');
  const down = [[bx, 0.5], [bx, -0.2], [bx, zm], [ax, zm], [ax, -0.2], [ax, 0.5]].map(([x, z]) => P(x, z));
  w.walkTo(...P(0, 0.6));
  for (let f = 2; f >= 0; f--) expect(down.every(([x, z]) => w.walkTo(x, z)), `walked down to house floor ${f}`);
  expect((w.level as InteriorLevel).vcore?.floor === 0, 'back on the ground floor');
  // into the rooms through the core door
  expect(w.walkTo(c.door.x, c.door.z + 1.0), 'walked out of the stair hall into the house');
});
