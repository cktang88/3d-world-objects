/** NYC districts (districts-blocks): each special block builds within budgets; its showcase slots are sane. */
import { readFileSync } from 'fs';
import { test, expect, none, stats, sceneHash, fmt, rectOverlap } from './qa';
import { nycChunk } from './world';
import { AX, SZ, BX, BZ } from '../src/nyc/common';
import { districtAt, laneOpen, walkable, roadOpen, MAP_BOUNDS, type DKind } from '../src/nyc/districts';
import { slotsUnder } from '../src/nyc/district-showcase';
import type { Rect } from '../src/level';

/** one block of each special kind (and each variant of the open ones) */
const ALL: [string, number, number][] = [
  ['park fountain', 0, -4], ['park pond', 1, -4], ['park playground', -1, -4], ['park ballfield', 2, -4], ['park dogrun', -1, -5], ['park garden', 1, -5],
  ['auto row', 4, -4], ['construction', 4, -1], ['rail yard', 5, -1], ['greenmarket', -2, 2], ['museum', -2, -5],
  ['pier shed', 6, 0], ['pier aircraft', 6, 1], ['pier marina', 6, -1], ['carrier', 7, -1],
  ['airport stands', -3, -2], ['airport', -4, -3], ['bowery', 1, 2],
];
const SPECIAL = ALL.filter(([n]) => /^(auto|construction|rail|greenmarket|museum|bowery)/.test(n) && (!process.env.QA_BLOCK || new RegExp(process.env.QA_BLOCK).test(n)));

test('special blocks build in Node within budgets', () => {
  const bad: string[] = [];
  for (const [name, cx, cz] of SPECIAL) {
    const c = nycChunk(1, cx, cz);
    const s = stats(c.group);
    if (s.drawables > 300) bad.push(`${name}: ${s.drawables} draw calls`);
    if (s.tris > 900_000) bad.push(`${name}: ${s.tris} tris`);
    if (s.materials > 90) bad.push(`${name}: ${s.materials} materials`);
  }
  none(bad, 'blocks over budget');
});

test('showcase slots: inside the block, pools exist, not inside buildings', () => {
  const pools = JSON.parse(readFileSync('public/districts/pools.json', 'utf8')) as Record<string, unknown[]>;
  const bad: string[] = [];
  let total = 0;
  const kinds = new Set<string>();
  for (const [name, cx, cz] of SPECIAL) {
    const c = nycChunk(1, cx, cz);
    const specs = slotsUnder(c.group);
    total += specs.length;
    // buildings: the big colliders (not the slots' own, which are smaller than 30 m)
    const big = c.colliders.filter((r) => r.maxX - r.minX > 9 && r.maxZ - r.minZ > 9 && r.maxX - r.minX < 60);
    for (const s of specs) {
      for (const k of Array.isArray(s.kind) ? s.kind : [s.kind]) {
        kinds.add(k);
        if (!((pools[k]?.length ?? 0) >= 10)) bad.push(`${name}: pool '${k}' has ${pools[k]?.length ?? 0}`);
      }
      const carrierDeck = name === 'carrier';
      if (!carrierDeck && (Math.abs(s.x) > AX / 2 + 0.5 || Math.abs(s.z) > SZ / 2 + 0.5)) bad.push(`${name}: slot at ${fmt(s.x)},${fmt(s.z)} outside the block`);
      const fp: Rect = { minX: s.x - 0.3, maxX: s.x + 0.3, minZ: s.z - 0.3, maxZ: s.z + 0.3 };
      // colliders centred on the slot are its own (or its fountain basin / plinth)
      const other = big.filter((b) => Math.hypot((b.minX + b.maxX) / 2 - s.x, (b.minZ + b.maxZ) / 2 - s.z) > 0.5);
      if ((s.y ?? 0) < 3 && other.some((b) => rectOverlap(b, fp))) {
        const b = other.find((bb) => rectOverlap(bb, fp))!;
        // boats sit in the water rects, aircraft over the apron, all by design
        if (!['boat', 'pierprop'].some((k) => (Array.isArray(s.kind) ? s.kind : [s.kind]).includes(k))) bad.push(`${name}: ${String(s.kind)} at ${fmt(s.x)},${fmt(s.z)} inside a ${fmt(b.maxX - b.minX)}x${fmt(b.maxZ - b.minZ)} collider`);
      }
    }
  }
  expect(total >= 6 * SPECIAL.length, `only ${total} showcase slots in ${SPECIAL.length} special blocks`);
  expect(kinds.size >= (process.env.QA_BLOCK ? 1 : 10), `only ${kinds.size} showcase kinds used`);
  none(bad, 'slot problems');
});

test('districts change the street: shop mix differs by district', () => {
  const sig = (cx: number, cz: number) => sceneHash(nycChunk(1, cx, cz).group);
  expect(sig(0, 0) !== sig(1, 2), 'Midtown and Bowery blocks identical');
  void BZ;
});
