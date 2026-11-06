/** Museum floor plan (src/museum/map.ts) on the minimap: built rooms in one frame, '?' stubs, clicks only into visited rooms. */
import * as THREE from 'three';
import { test, expect, near } from './qa';
import { settle } from './env';
import { Minimap, registerMinimapSource, setSurfaceFactory, type Ctx2D, type Surface } from '../src/minimap';
import { loadMuseum } from '../src/museumData';
import { AtriumLevel, GalleryLevel } from '../src/museum';
import { descKeyOf, doorwayOf, markVisited, museumSource, planRooms, registerRoom, resetPlan } from '../src/museum/map';
import { ENTRY_Z } from '../src/museum/shell';
import type { LevelDesc } from '../src/level';

function recorder(log: string[]): Ctx2D {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get: (_t, k: string) => (k in target ? target[k] : (...a: unknown[]) => void log.push(`${k}(${a.map((v) => (typeof v === 'number' ? v.toFixed(2) : String(v))).join(',')})`)),
    set: (_t, k: string, v) => ((target[k] = v), log.push(`${k}=${v}`), true),
  }) as unknown as Ctx2D;
}
setSurfaceFactory((w: number, h: number): Surface => ({ width: w, height: h, getContext: () => recorder([]) }));

test('museum plan: the atrium and a wing room in one frame, ? for unexplored doorways, clicks only into visited rooms', async () => {
  resetPlan();
  await loadMuseum();
  const atrium = new AtriumLevel();
  const wingDesc = atrium.portals().find((p) => p.auto && typeof p.target === 'object' && p.door?.see)!.target as Extract<LevelDesc, { kind: 'gallery' }>;
  const room = new GalleryLevel(wingDesc);
  await Promise.race([room.built, settle(8000)]);
  const rooms = planRooms();
  const a = rooms.get(descKeyOf({ kind: 'atrium' }))!, r = rooms.get(descKeyOf(wingDesc))!;
  expect(a && r, 'atrium or wing room missing from the plan');
  // the wing room's entrance lands on the atrium doorway that leads to it
  const di = a.exits.findIndex((e) => e && descKeyOf(e) === descKeyOf(wingDesc));
  const door = doorwayOf(a.doors[di], a.W, a.D).pos.applyMatrix4(a.world);
  const entry = new THREE.Vector3(0, 0, ENTRY_Z).applyMatrix4(r.world);
  near(entry.distanceTo(door), 0, 0.01, 'room entry vs atrium doorway (m)');

  // the room's map, seen from inside it (now the visited one)
  markVisited(r.key);
  let entered: LevelDesc | null = null;
  const src = museumSource(r.key, (d) => (entered = d));
  const log: string[] = [];
  src.drawTile(recorder(log), 0, -1, 256);
  expect(log.filter((l) => l.startsWith('lineTo')).length > 10, 'the plan paints no walls');
  const labels = src.labels!(-200, -200, 200, 200);
  expect(labels.some((l) => l.text === 'Atrium'), 'the atrium is not named');
  expect(labels.some((l) => l.text === r.name), 'the room is not named');
  expect(labels.some((l) => l.text === '?'), 'no ? stubs for the doorways into rooms not built yet');

  // clicks: inside this room -> a spot in it; on the atrium (visited) -> through the room entry; nowhere -> nothing
  const here = src.snap!(0, -r.D / 2);
  expect(here && here.z < 0 && here.z > -r.D, 'a click inside the room does not teleport inside it');
  const atriumMid = new THREE.Vector3(0, 0, -15).applyMatrix4(a.world).applyMatrix4(r.world.clone().invert());
  expect(src.snap!(atriumMid.x, atriumMid.z) === null && entered !== null && descKeyOf(entered) === a.key, 'a click on the visited atrium does not walk there through the room entry');
  entered = null;
  expect(src.snap!(5000, 5000) === null && entered === null, 'a click on empty space did something');
  // a room that is built but never visited cannot be teleported to
  const other = r.exits.find((e) => e)!;
  const g2 = new GalleryLevel(other as Extract<LevelDesc, { kind: 'gallery' }>);
  await Promise.race([g2.built, settle(8000)]);
  const o = planRooms().get(descKeyOf(other))!;
  const oMid = new THREE.Vector3(0, 0, -o.D / 2).applyMatrix4(o.world).applyMatrix4(r.world.clone().invert());
  expect(src.snap!(oMid.x, oMid.z) === null && entered === null, 'a click on a built but unvisited room teleported');
  atrium.dispose(); room.dispose(); g2.dispose();
});

test('museum map: empty tiles paint nothing, a new room repaints only its own tiles, the large map opens fitted to the explored rooms', async () => {
  resetPlan();
  await loadMuseum();
  const atrium = new AtriumLevel();
  const src = museumSource(descKeyOf({ kind: 'atrium' }));
  const T = src.tileSize;
  // empty space: no drawing at all
  const far: string[] = [];
  src.drawTile(recorder(far), 40, 40, 256);
  expect(far.length === 0, `an empty tile painted ${far.length} calls`);
  // tile versions over a grid before and after a new room far to the east
  const grid: [number, number][] = [];
  for (let tx = -3; tx <= 6; tx++) for (let tz = -4; tz <= 2; tz++) grid.push([tx, tz]);
  const before = grid.map(([x, z]) => src.version!(x, z));
  registerRoom({ key: 'qa-east', desc: { kind: 'gallery', theme: 1, page: 0 }, name: 'East', color: '#336699', W: 20, D: 30, doors: [{ wall: 'S', at: 0, w: 2.4, h: 3 }], exits: [null], dots: [] });
  // place it by hand 400 m east (as if reached through rooms in between)
  planRooms().get('qa-east')!.world.makeTranslation(400, 0, 0);
  registerRoom({ ...planRooms().get('qa-east')!, key: 'qa-east' });
  const after = grid.map(([x, z]) => src.version!(x, z));
  const changed = grid.filter((_, i) => after[i] !== before[i]).map(([x, z]) => `${x},${z}`);
  const touching = grid.filter(([x, z]) => (x + 1) * T > 400 - 15 && x * T < 400 + 15).map(([x, z]) => `${x},${z}`);
  expect(changed.every((k) => touching.includes(k)), `tiles away from the new room repainted: ${changed.filter((k) => !touching.includes(k)).join(' ')}`);
  expect(changed.length > 0, 'the new room repainted no tile');
  // the large map opens fitted to the explored rooms
  const m = new Minimap();
  m.headless = { width: 1000, height: 600, getContext: () => recorder([]) };
  registerMinimapSource((l) => (l === atrium ? src : null));
  m.update(atrium, { x: 0, z: -3 }, 0, 0);
  m.cycle(); // hud -> large
  const view = (m as unknown as { view: { x: number; z: number; ppm: number } }).view;
  const e = src.extent!()!;
  expect(view.x > e.minX && view.x < e.maxX && view.z > e.minZ && view.z < e.maxZ, 'the large map is not centred on the explored rooms');
  expect(view.ppm * (e.maxX - e.minX) <= 1000 && view.ppm * (e.maxZ - e.minZ) <= 600, 'the explored rooms do not fit the large map');
  expect(view.ppm * (e.maxX - e.minX) > 1000 * 0.6 || view.ppm * (e.maxZ - e.minZ) > 600 * 0.6, `the explored rooms fill only ${Math.round(view.ppm * (e.maxX - e.minX))} px of 1000`);
  atrium.dispose();
});
