/** NYC districts: the map, roads ending at open spaces, walkability, each special block's build, showcase slots. */
import { readFileSync } from 'fs';
import { test, expect, none, stats, sceneHash, fmt, rectOverlap } from './qa';
import { nycChunk } from './world';
import { AX, SZ, BX, BZ, avenueName } from '../src/nyc/common';
import { districtAt, laneOpen, walkable, roadOpen, MAP_BOUNDS, type DKind } from '../src/nyc/districts';
import { slotsUnder } from '../src/nyc/district-showcase';
import type { Rect } from '../src/level';

/** (blocks: districts-blocks*.test.ts) (and each variant of the open ones) */
const SPECIAL: [string, number, number][] = [
  ['park fountain', 0, -4], ['park pond', 1, -4], ['park playground', -1, -4], ['park ballfield', 2, -4], ['park dogrun', -1, -5], ['park garden', 1, -5],
  ['auto row', 4, -4], ['construction', 4, -1], ['rail yard', 5, -1], ['greenmarket', -2, 2], ['museum', -2, -5],
  ['pier shed', 6, 0], ['pier aircraft', 6, 1], ['pier marina', 6, -1], ['carrier', 7, -1],
  ['airport stands', -3, -2], ['airport', -4, -3], ['bowery', 1, 2],
];

test('map: spawn on a Midtown avenue, every district a short walk away', () => {
  expect(districtAt(0, 0).kind === 'midtown', `spawn block is ${districtAt(0, 0).kind}`);
  const want: DKind[] = ['timesq', 'music', 'garment', 'bowery', 'canal', 'market', 'brownstone', 'industrial', 'construction', 'museum', 'autorow', 'park', 'airport', 'pier', 'river'];
  const far: string[] = [];
  for (const k of want) {
    let best = Infinity;
    for (let cz = MAP_BOUNDS.z0; cz < MAP_BOUNDS.z0 + MAP_BOUNDS.h; cz++)
      for (let cx = MAP_BOUNDS.x0; cx < MAP_BOUNDS.x0 + MAP_BOUNDS.w; cx++)
        if (districtAt(cx, cz).kind === k) best = Math.min(best, Math.abs(cx * AX) + Math.abs(cz * SZ));
    // walking distance from the spawn corner (Manhattan metric), 5 m/s
    if (!(best < 750)) far.push(`${k} ${fmt(best)} m`);
  }
  none(far, 'districts more than ~2.5 min walk (1 min running) from the spawn');
});

test('roads: the spawn avenue runs north to the park and ends there; none between open chunks', () => {
  expect(laneOpen('z', AX / 2, 0), 'spawn avenue (5 Av) closed at the spawn');
  expect(laneOpen('z', AX / 2, -3 * SZ), '5 Av closed south of the park');
  expect(!laneOpen('z', AX / 2, -5 * SZ), '5 Av still runs through the park');
  expect(roadOpen(0, -4, '+z'), 'no street along the park edge');
  const bad: string[] = [];
  for (let cz = -8; cz < 5; cz++) for (let cx = -5; cx < 9; cx++) {
    const a = districtAt(cx, cz), b = districtAt(cx + 1, cz);
    if (a.open && b.open && roadOpen(cx, cz, '+x')) bad.push(`${cx},${cz} ${a.kind}|${b.kind}`);
    if (!a.open && roadOpen(cx, cz, '+x') !== true) bad.push(`${cx},${cz} built block lost its avenue`);
  }
  none(bad, 'road edges inconsistent');
});

test('walkable: city and park yes, river and apron no, promenade yes', () => {
  expect(walkable(BX - 2, BZ - 2), 'spawn sidewalk');
  expect(walkable(0 * AX, -5 * SZ), 'park interior');
  expect(!walkable(7 * AX, 2 * SZ), 'the river');
  expect(!walkable(-4 * AX, -3 * SZ), 'middle of the apron');
  expect(walkable(6 * AX - 30, 0), 'Hudson River Park promenade');
  expect(!walkable(6 * AX + 40, 25), 'the water beside a pier');
});

test('sign names follow the district map: auto row is on 11 Av, the piers on 12 Av', () => {
  expect(avenueName(4) === '11 Av', `avenue between the auto row blocks is ${avenueName(4)}`);
  expect(districtAt(4, -4).kind === 'autorow' && districtAt(5, -4).kind === 'autorow', 'auto row blocks moved');
  expect(avenueName(5) === '12 Av' && districtAt(6, -4).kind === 'pier', 'the piers are not on 12 Av');
  expect(avenueName(0) === '5 Av', `spawn avenue is ${avenueName(0)}`);
});
