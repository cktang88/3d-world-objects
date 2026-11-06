/** Museum floor plan (src/museum/map.ts) on the minimap: built rooms in one frame, '?' stubs, clicks only into visited rooms. */
import * as THREE from 'three';
import { test, expect, near } from './qa';
import { settle } from './env';
import { setSurfaceFactory, type Ctx2D, type Surface } from '../src/minimap';
import { loadMuseum } from '../src/museumData';
import { AtriumLevel, GalleryLevel } from '../src/museum';
import { descKeyOf, doorwayOf, markVisited, museumSource, planRooms, resetPlan } from '../src/museum/map';
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
